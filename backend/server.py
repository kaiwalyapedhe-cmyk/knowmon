import asyncio
import json
import logging
import os
import re
import tempfile
from collections import Counter, defaultdict
from contextlib import suppress
from typing import List

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel
from starlette.middleware.cors import CORSMiddleware

try:  # launched as `backend.server` (the default)
    from backend.clerk_auth import clerk_router
except ModuleNotFoundError:  # launched from inside backend/ as `server`
    from clerk_auth import clerk_router

import ai
from core import (IN_ENV, QA, RANK, RETIRED_ROLES, ROLES, STAFF, agent_scope, client, current_member, db,
                  effective_role, new_id, now, require_role)
from seed import seed

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

INDEXES = {
    "users": [IndexModel([("user_id", ASCENDING)], name="user_id", unique=True)],
    "interactions": [IndexModel([("id", ASCENDING)], name="id", unique=True),
                     IndexModel([("created_at", DESCENDING)], name="created_desc"),
                     IndexModel([("agent_id", ASCENDING)], name="agent_id")],
    "qa_forms": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "articles": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "trees": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "courses": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "attempts": [IndexModel([("user_id", ASCENDING)], name="user_id")],
    "coaching": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("agent_id", ASCENDING)], name="agent_id")],
}

app = FastAPI()
api = APIRouter(prefix="/api")
_tasks = set()
CHANNELS = {"voice", "email", "chat", "whatsapp", "in_store"}


async def ensure_indexes():
    for coll, models in INDEXES.items():
        for m in models:
            try:
                await db[coll].create_indexes([m])
            except Exception as exc:
                logger.error("ensure_indexes(%s.%s): %s", coll, m.document["name"], exc)


async def get_or_404(coll: str, item_id: str, scope: dict | None = None, projection: dict | None = None):
    doc = await db[coll].find_one({"id": item_id, **(scope or {})}, {"_id": 0, **(projection or {})})
    if doc is None:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


# ---------- Users & roles ----------
@api.get("/me")
async def me(member: dict = Depends(current_member)):
    return member


@api.get("/users")
async def list_users(admin: dict = Depends(require_role("admin"))):
    people = await db.users.find(IN_ENV, {"_id": 0}).to_list(1000)
    return {"roles": [r for r in ROLES if RANK[r] <= RANK[admin["role"]]],
            "users": [{**p, "role": effective_role(p.get("role"))} for p in people]}


class RoleIn(BaseModel):
    role: str


@api.patch("/users/{user_id}/role")
async def set_role(user_id: str, body: RoleIn, admin: dict = Depends(require_role("admin"))):
    if body.role not in ROLES or RANK[body.role] > RANK[admin["role"]]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target = await db.users.find_one({"user_id": user_id, **IN_ENV}, {"_id": 0})
    if target is None:
        raise HTTPException(status_code=404, detail="Not found")
    if (effective_role(target.get("role")) == "admin" and body.role != "admin"
            and await db.users.count_documents({"role": "admin", **IN_ENV}) <= 1):
        raise HTTPException(status_code=409, detail="Keep at least one admin")
    await db.users.update_one({"user_id": user_id}, {"$set": {"role": body.role}})
    return {"user_id": user_id, "role": body.role}


@api.get("/people")
async def people(m: dict = Depends(require_role(*STAFF))):
    docs = await db.users.find(IN_ENV, {"_id": 0, "user_id": 1, "name": 1, "email": 1, "role": 1}).to_list(1000)
    return [{**d, "role": effective_role(d.get("role"))} for d in docs]


# ---------- QA forms ----------
class Criterion(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    description: str = ""
    weight: float = 1
    type: str = "scale"
    auto_fail: bool = False


class FormIn(BaseModel):
    name: str
    description: str = ""
    channel: str = "all"
    criteria: List[Criterion]


@api.get("/qa-forms")
async def list_forms(m: dict = Depends(current_member)):
    return await db.qa_forms.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)


@api.post("/qa-forms")
async def create_form(body: FormIn, m: dict = Depends(require_role(*QA))):
    if not body.criteria:
        raise HTTPException(status_code=400, detail="Add at least one criterion")
    doc = {**body.model_dump(), "id": new_id(), "created_by": m["user_id"], "created_at": now()}
    await db.qa_forms.insert_one(dict(doc))
    return doc


@api.put("/qa-forms/{form_id}")
async def update_form(form_id: str, body: FormIn, m: dict = Depends(require_role(*QA))):
    await get_or_404("qa_forms", form_id)
    await db.qa_forms.update_one({"id": form_id}, {"$set": body.model_dump()})
    return await get_or_404("qa_forms", form_id)


@api.delete("/qa-forms/{form_id}")
async def delete_form(form_id: str, m: dict = Depends(require_role(*QA))):
    if (await db.qa_forms.delete_one({"id": form_id})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ---------- Interactions (AutoQA) ----------
async def process_interaction(iid: str, path: str | None):
    try:
        doc = await db.interactions.find_one({"id": iid}, {"_id": 0})
        transcript = doc.get("transcript", "")
        if path:
            transcript = await ai.transcribe(path)
            await db.interactions.update_one({"id": iid}, {"$set": {"transcript": transcript, "status": "scoring"}})
        if not transcript.strip():
            raise ValueError("Transcript is empty")
        form = await db.qa_forms.find_one({"id": doc["form_id"]}, {"_id": 0})
        arts = await db.articles.find({}, {"_id": 0, "id": 1, "title": 1, "category": 1}).to_list(300)
        result = await ai.score_interaction(form, transcript, doc["channel"], arts)
        await db.interactions.update_one({"id": iid}, {"$set": {**result, "status": "scored", "scored_at": now()}})
    except Exception as exc:
        logger.exception("interaction %s failed", iid)
        await db.interactions.update_one({"id": iid}, {"$set": {"status": "failed", "error": str(exc)[:300]}})
    finally:
        if path:
            with suppress(OSError):
                os.remove(path)


def _spawn(coro):
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


@api.post("/interactions")
async def create_interaction(
    channel: str = Form(...), form_id: str = Form(...), agent_id: str = Form(""), agent_name: str = Form(""),
    customer_name: str = Form(""), transcript: str = Form(""), file: UploadFile | None = File(None),
    m: dict = Depends(current_member),
):
    if channel not in CHANNELS:
        raise HTTPException(status_code=400, detail="Unknown channel")
    form = await get_or_404("qa_forms", form_id)
    if m["role"] not in STAFF:  # agents can only submit their own interactions
        agent_id, agent_name = m["user_id"], m.get("name", "")
    elif agent_id:
        person = await db.users.find_one({"user_id": agent_id}, {"_id": 0})
        agent_name = (person or {}).get("name") or agent_name
    if not agent_name.strip():
        raise HTTPException(status_code=400, detail="Choose or enter an agent")
    path = None
    if file is not None and file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in {".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"}:
            raise HTTPException(status_code=400, detail="Unsupported audio format")
        data = await file.read()
        if len(data) > 25 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Audio must be under 25 MB")
        fd, path = tempfile.mkstemp(suffix=ext)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    elif not transcript.strip():
        raise HTTPException(status_code=400, detail="Upload audio or paste a transcript")
    doc = {"id": new_id(), "channel": channel, "agent_id": agent_id, "agent_name": agent_name.strip(),
           "customer_name": customer_name.strip(), "form_id": form_id, "form_name": form["name"],
           "source": "audio" if path else "text", "audio_name": file.filename if path else "",
           "transcript": transcript, "status": "transcribing" if path else "scoring",
           "created_by": m["user_id"], "created_at": now()}
    await db.interactions.insert_one(dict(doc))
    _spawn(process_interaction(doc["id"], path))
    return doc


@api.get("/interactions")
async def list_interactions(m: dict = Depends(current_member)):
    return await db.interactions.find(agent_scope(m), {"_id": 0, "transcript": 0, "criteria_results": 0}) \
        .sort("created_at", -1).to_list(500)


@api.get("/interactions/{iid}")
async def get_interaction(iid: str, m: dict = Depends(current_member)):
    return await get_or_404("interactions", iid, agent_scope(m))


@api.post("/interactions/{iid}/rescore")
async def rescore(iid: str, m: dict = Depends(require_role(*STAFF))):
    await get_or_404("interactions", iid)
    await db.interactions.update_one({"id": iid}, {"$set": {"status": "scoring", "error": ""}})
    _spawn(process_interaction(iid, None))
    return {"ok": True}


@api.delete("/interactions/{iid}")
async def delete_interaction(iid: str, m: dict = Depends(require_role(*QA))):
    if (await db.interactions.delete_one({"id": iid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ---------- Dashboard ----------
@api.get("/dashboard")
async def dashboard(m: dict = Depends(current_member)):
    scope = agent_scope(m)
    items = await db.interactions.find({"status": "scored", **scope}, {"_id": 0, "transcript": 0}).to_list(5000)
    n = len(items)
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else 0  # noqa: E731
    trend = defaultdict(list)
    board = defaultdict(lambda: {"count": 0, "scores": [], "flags": 0, "auto_fails": 0})
    crit = defaultdict(list)
    for i in items:
        trend[i["created_at"][:10]].append(i["overall_score"])
        b = board[i["agent_name"]]
        b["count"] += 1
        b["scores"].append(i["overall_score"])
        b["flags"] += len(i.get("compliance_flags", []))
        b["auto_fails"] += 1 if i.get("auto_failed") else 0
        for c in i.get("criteria_results", []):
            crit[c["name"]].append(c["score"])
    leaderboard = sorted(({"agent_name": k, "count": v["count"], "avg_score": avg(v["scores"]), "flags": v["flags"],
                           "auto_fails": v["auto_fails"]} for k, v in board.items()), key=lambda x: -x["avg_score"])
    att_scope = {} if m["role"] in STAFF else {"user_id": m["user_id"]}
    attempts = await db.attempts.find(att_scope, {"_id": 0}).to_list(5000)
    top_searches = []
    if m["role"] in STAFF:
        top_searches = await db.kb_searches.aggregate([
            {"$group": {"_id": "$q", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}, {"$limit": 6}]).to_list(6)
    top_articles = await db.articles.find({}, {"_id": 0, "id": 1, "title": 1, "views": 1}).sort("views", -1).limit(5).to_list(5)
    coaching_scope = {} if m["role"] in STAFF else {"agent_id": m["user_id"]}
    return {
        "kpis": {
            "avg_score": avg([i["overall_score"] for i in items]), "evaluated": n,
            "flag_rate": round(100 * sum(1 for i in items if i.get("compliance_flags") or i.get("auto_failed")) / n, 1) if n else 0,
            "csat": round(sum(float(i.get("csat_predicted", 0)) for i in items) / n, 2) if n else 0,
            "pending": await db.interactions.count_documents({"status": {"$in": ["transcribing", "scoring"]}, **scope}),
            "open_coaching": await db.coaching.count_documents({"status": {"$ne": "completed"}, **coaching_scope}),
            "quiz_attempts": len(attempts), "quiz_avg": avg([a["score"] for a in attempts]),
            "quiz_pass_rate": round(100 * sum(1 for a in attempts if a["passed"]) / len(attempts), 1) if attempts else 0,
            "articles": await db.articles.count_documents({}),
        },
        "sentiment": [{"name": k, "value": v} for k, v in Counter(i.get("sentiment", "neutral") for i in items).items()],
        "channels": [{"name": k, "value": v} for k, v in Counter(i["channel"] for i in items).items()],
        "trend": [{"date": d, "score": avg(s)} for d, s in sorted(trend.items())][-14:],
        "criteria": [{"name": k, "score": avg(v)} for k, v in crit.items()],
        "leaderboard": leaderboard,
        "top_searches": [{"q": s["_id"], "count": s["count"]} for s in top_searches],
        "top_articles": top_articles,
    }


# ---------- Knowledge base ----------
class Step(BaseModel):
    title: str
    body: str = ""
    image_url: str = ""


class ArticleIn(BaseModel):
    title: str
    category: str
    summary: str = ""
    content: str = ""
    steps: List[Step] = []
    tags: List[str] = []
    self_service: bool = True


def _rank(q: str, arts: list, k: int = 4) -> list:
    words = {w for w in re.findall(r"\w+", q.lower()) if len(w) > 2}

    def score(a):
        title, body = a["title"].lower(), (a.get("content", "") + " " + " ".join(a.get("tags", [])) + " " +
                                           " ".join(s["title"] + " " + s.get("body", "") for s in a.get("steps", []))).lower()
        return sum(3 * title.count(w) + body.count(w) for w in words)
    scored = [(score(a), a) for a in arts]
    return [a for s, a in sorted(scored, key=lambda x: -x[0]) if s > 0][:k]


def _sse(question: str, arts: list):
    async def gen():
        yield f"data: {json.dumps({'type': 'sources', 'sources': [{'id': a['id'], 'title': a['title']} for a in arts]})}\n\n"
        try:
            async for chunk in ai.stream_text(ai.ANSWER_SYSTEM, ai.answer_prompt(question, arts)):
                yield f"data: {json.dumps({'type': 'delta', 'text': chunk})}\n\n"
        except Exception as exc:
            logger.exception("ask failed")
            yield f"data: {json.dumps({'type': 'error', 'text': str(exc)[:200]})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _article_query(q: str, category: str, extra: dict | None = None) -> dict:
    query = dict(extra or {})
    if category:
        query["category"] = category
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"title": rx}, {"content": rx}, {"tags": rx}, {"summary": rx}, {"steps.body": rx}]
    return query


@api.get("/kb/articles")
async def list_articles(q: str = "", category: str = "", m: dict = Depends(current_member)):
    if q.strip():
        await db.kb_searches.insert_one({"q": q.strip().lower()[:100], "user_id": m["user_id"], "at": now()})
    return await db.articles.find(_article_query(q.strip(), category), {"_id": 0}).sort("updated_at", -1).to_list(500)


@api.get("/kb/categories")
async def categories(m: dict = Depends(current_member)):
    return sorted(await db.articles.distinct("category"))


@api.get("/kb/articles/{aid}")
async def get_article(aid: str, m: dict = Depends(current_member)):
    doc = await get_or_404("articles", aid)
    await db.articles.update_one({"id": aid}, {"$inc": {"views": 1}})
    return doc


@api.post("/kb/articles")
async def create_article(body: ArticleIn, m: dict = Depends(require_role(*STAFF))):
    doc = {**body.model_dump(), "id": new_id(), "views": 0, "created_by": m["user_id"], "created_at": now(), "updated_at": now()}
    await db.articles.insert_one(dict(doc))
    return doc


@api.put("/kb/articles/{aid}")
async def update_article(aid: str, body: ArticleIn, m: dict = Depends(require_role(*STAFF))):
    await get_or_404("articles", aid)
    await db.articles.update_one({"id": aid}, {"$set": {**body.model_dump(), "updated_at": now()}})
    return await get_or_404("articles", aid)


@api.delete("/kb/articles/{aid}")
async def delete_article(aid: str, m: dict = Depends(require_role(*STAFF))):
    if (await db.articles.delete_one({"id": aid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=2000)


@api.post("/kb/ask")
async def ask(body: AskIn, m: dict = Depends(current_member)):
    await db.kb_searches.insert_one({"q": body.question.strip().lower()[:100], "user_id": m["user_id"], "at": now(), "ai": True})
    arts = await db.articles.find({}, {"_id": 0}).to_list(500)
    return _sse(body.question, _rank(body.question, arts))


# Public self-service (website / chatbot / app widget)
@api.get("/public/kb")
async def public_articles(q: str = "", category: str = ""):
    return await db.articles.find(_article_query(q.strip(), category, {"self_service": True}),
                                  {"_id": 0, "created_by": 0}).to_list(200)


@api.get("/public/kb/{aid}")
async def public_article(aid: str):
    doc = await get_or_404("articles", aid, {"self_service": True}, {"created_by": 0})
    await db.articles.update_one({"id": aid}, {"$inc": {"views": 1}})
    return doc


@api.post("/public/ask")
async def public_ask(body: AskIn):
    arts = await db.articles.find({"self_service": True}, {"_id": 0}).to_list(500)
    return _sse(body.question, _rank(body.question, arts))


# ---------- Decision trees ----------
class TreeOption(BaseModel):
    label: str
    next: str = ""


class TreeNode(BaseModel):
    id: str
    title: str
    text: str = ""
    script: str = ""
    options: List[TreeOption] = []


class TreeIn(BaseModel):
    title: str
    description: str = ""
    category: str = ""
    start_node: str
    nodes: List[TreeNode]


class GenTreeIn(BaseModel):
    title: str
    sop: str = Field(min_length=20)


def _validate_tree(body: TreeIn):
    ids = {n.id for n in body.nodes}
    if body.start_node not in ids:
        raise HTTPException(status_code=400, detail="Start step must be one of the steps")
    for n in body.nodes:
        for o in n.options:
            if o.next not in ids:
                raise HTTPException(status_code=400, detail=f"Option '{o.label}' in '{n.title}' points to a missing step")


@api.get("/trees")
async def list_trees(m: dict = Depends(current_member)):
    return await db.trees.find({}, {"_id": 0}).sort("created_at", -1).to_list(300)


@api.get("/trees/{tid}")
async def get_tree(tid: str, m: dict = Depends(current_member)):
    return await get_or_404("trees", tid)


@api.post("/trees")
async def create_tree(body: TreeIn, m: dict = Depends(require_role(*STAFF))):
    _validate_tree(body)
    doc = {**body.model_dump(), "id": new_id(), "runs": 0, "created_by": m["user_id"], "created_at": now()}
    await db.trees.insert_one(dict(doc))
    return doc


@api.put("/trees/{tid}")
async def update_tree(tid: str, body: TreeIn, m: dict = Depends(require_role(*STAFF))):
    await get_or_404("trees", tid)
    _validate_tree(body)
    await db.trees.update_one({"id": tid}, {"$set": body.model_dump()})
    return await get_or_404("trees", tid)


@api.delete("/trees/{tid}")
async def delete_tree(tid: str, m: dict = Depends(require_role(*STAFF))):
    if (await db.trees.delete_one({"id": tid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


@api.post("/trees/{tid}/run")
async def run_tree(tid: str, m: dict = Depends(current_member)):
    await get_or_404("trees", tid)
    await db.trees.update_one({"id": tid}, {"$inc": {"runs": 1}})
    return {"ok": True}


@api.post("/trees/generate")
async def generate_tree(body: GenTreeIn, m: dict = Depends(require_role(*STAFF))):
    try:
        r = await ai.generate_tree(body.title, body.sop)
        tree = TreeIn(title=body.title, description="Generated from SOP", start_node=r["start_node"], nodes=r["nodes"])
        _validate_tree(tree)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("tree generation failed")
        raise HTTPException(status_code=502, detail=f"AI could not build the tree: {str(exc)[:120]}")
    doc = {**tree.model_dump(), "id": new_id(), "runs": 0, "created_by": m["user_id"], "created_at": now()}
    await db.trees.insert_one(dict(doc))
    return doc


# ---------- Training (LMS) ----------
class Lesson(BaseModel):
    title: str
    content: str = ""
    article_id: str = ""


class QuizQ(BaseModel):
    question: str
    options: List[str]
    answer_index: int
    explanation: str = ""


class CourseIn(BaseModel):
    title: str
    description: str = ""
    category: str = ""
    pass_mark: int = 70
    lessons: List[Lesson] = []
    quiz: List[QuizQ] = []


class GenQuizIn(BaseModel):
    content: str = Field(min_length=20)
    count: int = Field(5, ge=1, le=15)


class AttemptIn(BaseModel):
    answers: List[int]


def _hide_answers(course: dict, m: dict) -> dict:
    if m["role"] in STAFF:
        return course
    return {**course, "quiz": [{"question": q["question"], "options": q["options"]} for q in course.get("quiz", [])]}


@api.get("/courses")
async def list_courses(m: dict = Depends(current_member)):
    courses = await db.courses.find({}, {"_id": 0}).sort("created_at", -1).to_list(300)
    mine = await db.attempts.find({"user_id": m["user_id"]}, {"_id": 0}).to_list(5000)
    best = defaultdict(int)
    for a in mine:
        best[a["course_id"]] = max(best[a["course_id"]], a["score"])
    return [{**_hide_answers(c, m), "my_best": best.get(c["id"])} for c in courses]


@api.get("/courses/{cid}")
async def get_course(cid: str, m: dict = Depends(current_member)):
    return _hide_answers(await get_or_404("courses", cid), m)


@api.post("/courses")
async def create_course(body: CourseIn, m: dict = Depends(require_role(*STAFF))):
    doc = {**body.model_dump(), "id": new_id(), "created_by": m["user_id"], "created_at": now()}
    await db.courses.insert_one(dict(doc))
    return doc


@api.put("/courses/{cid}")
async def update_course(cid: str, body: CourseIn, m: dict = Depends(require_role(*STAFF))):
    await get_or_404("courses", cid)
    await db.courses.update_one({"id": cid}, {"$set": body.model_dump()})
    return await get_or_404("courses", cid)


@api.delete("/courses/{cid}")
async def delete_course(cid: str, m: dict = Depends(require_role(*STAFF))):
    if (await db.courses.delete_one({"id": cid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


@api.post("/courses/generate-quiz")
async def gen_quiz(body: GenQuizIn, m: dict = Depends(require_role(*STAFF))):
    try:
        qs = [QuizQ(**q).model_dump() for q in await ai.generate_quiz(body.content, body.count)]
    except Exception as exc:
        logger.exception("quiz generation failed")
        raise HTTPException(status_code=502, detail=f"AI could not create the quiz: {str(exc)[:120]}")
    return qs


@api.post("/courses/{cid}/attempt")
async def attempt(cid: str, body: AttemptIn, m: dict = Depends(current_member)):
    course = await get_or_404("courses", cid)
    quiz = course.get("quiz", [])
    if not quiz or len(body.answers) != len(quiz):
        raise HTTPException(status_code=400, detail="Answer every question")
    correct = sum(1 for q, a in zip(quiz, body.answers) if q["answer_index"] == a)
    score = round(100 * correct / len(quiz))
    doc = {"id": new_id(), "course_id": cid, "course_title": course["title"], "user_id": m["user_id"],
           "user_name": m.get("name", ""), "score": score, "correct": correct, "total": len(quiz),
           "passed": score >= course.get("pass_mark", 70), "at": now()}
    await db.attempts.insert_one(dict(doc))
    return {**doc, "review": [{"answer_index": q["answer_index"], "explanation": q.get("explanation", ""),
                               "chosen": a} for q, a in zip(quiz, body.answers)]}


@api.get("/attempts")
async def attempts(m: dict = Depends(current_member)):
    scope = {} if m["role"] in STAFF else {"user_id": m["user_id"]}
    return await db.attempts.find(scope, {"_id": 0}).sort("at", -1).to_list(1000)


# ---------- Coaching ----------
class ActionItem(BaseModel):
    text: str
    done: bool = False


class CoachingIn(BaseModel):
    agent_id: str = ""
    agent_name: str
    interaction_id: str = ""
    scheduled_for: str = ""
    focus: str
    notes: str = ""
    status: str = "scheduled"
    action_items: List[ActionItem] = []
    article_ids: List[str] = []
    course_ids: List[str] = []


class ItemToggle(BaseModel):
    done: bool


@api.get("/coaching")
async def list_coaching(m: dict = Depends(current_member)):
    return await db.coaching.find(agent_scope(m), {"_id": 0}).sort("created_at", -1).to_list(500)


@api.post("/coaching")
async def create_coaching(body: CoachingIn, m: dict = Depends(require_role(*STAFF))):
    doc = {**body.model_dump(), "id": new_id(), "coach_id": m["user_id"], "coach_name": m.get("name", ""), "created_at": now()}
    await db.coaching.insert_one(dict(doc))
    return doc


@api.put("/coaching/{cid}")
async def update_coaching(cid: str, body: CoachingIn, m: dict = Depends(require_role(*STAFF))):
    await get_or_404("coaching", cid)
    await db.coaching.update_one({"id": cid}, {"$set": body.model_dump()})
    return await get_or_404("coaching", cid)


@api.patch("/coaching/{cid}/items/{idx}")
async def toggle_item(cid: str, idx: int, body: ItemToggle, m: dict = Depends(current_member)):
    doc = await get_or_404("coaching", cid, agent_scope(m))
    if not 0 <= idx < len(doc["action_items"]):
        raise HTTPException(status_code=404, detail="Not found")
    await db.coaching.update_one({"id": cid}, {"$set": {f"action_items.{idx}.done": body.done}})
    return await get_or_404("coaching", cid)


@api.delete("/coaching/{cid}")
async def delete_coaching(cid: str, m: dict = Depends(require_role(*STAFF))):
    if (await db.coaching.delete_one({"id": cid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


app.include_router(api)
app.include_router(clerk_router)  # /api/clerk/config and /api/__clerk/*

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    for old, new in RETIRED_ROLES.items():
        await db.users.update_many({"role": old}, {"$set": {"role": new}})
    await seed()
    app.state.index_task = asyncio.create_task(ensure_indexes())


@app.on_event("shutdown")
async def shutdown():
    app.state.index_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.index_task
    client.close()
