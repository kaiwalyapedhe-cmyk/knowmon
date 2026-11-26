"""Knowledge Governance — lifecycle, versioning, approval, review dates, access control, audit and feedback."""
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import QA, STAFF, db, new_id, now, require_role

kb_gov_router = APIRouter(prefix="/api/kb", tags=["knowledge-governance"])

ARTICLE_STATUSES = ("draft", "in_review", "approved", "published", "archived")
SNAPSHOT_FIELDS = ("title", "category", "summary", "content", "steps", "tags", "self_service", "allowed_roles")


def article_defaults(member: dict) -> dict:
    return {"status": "draft", "version": 1, "owner_id": member["user_id"], "owner_name": member.get("name", ""),
            "reviewer_id": "", "reviewer_name": "", "approver_id": "", "approver_name": "",
            "review_date": "", "expires_at": "", "allowed_roles": [], "published_at": "",
            "helpful_count": 0, "not_helpful_count": 0, "archived_at": ""}


def visible_to(article: dict, member: dict) -> bool:
    if member["role"] in STAFF:
        return True
    if article.get("status", "published") != "published":
        return False
    roles = article.get("allowed_roles") or []
    return not roles or member["role"] in roles


async def article_audit(aid: str, action: str, member: dict, note: str = "", **extra):
    await db.kb_audit.insert_one({"id": new_id(), "article_id": aid, "action": action, "note": note[:2000],
                                  "by": member["user_id"], "by_name": member.get("name", ""), "at": now(), **extra})


async def snapshot_article(article: dict, member: dict, note: str = "") -> dict:
    doc = {"id": new_id(), "article_id": article["id"], "version": int(article.get("version") or 1),
           **{k: article.get(k) for k in SNAPSHOT_FIELDS}, "note": note, "by": member["user_id"],
           "by_name": member.get("name", ""), "at": now()}
    await db.article_versions.insert_one(dict(doc))
    return doc


async def _get(aid: str) -> dict:
    doc = await db.articles.find_one({"id": aid}, {"_id": 0})
    if doc is None:
        raise HTTPException(status_code=404, detail="Article not found")
    return doc


class NoteIn(BaseModel):
    note: str = Field("", max_length=2000)


class ReviewerIn(BaseModel):
    reviewer_id: str = ""
    note: str = Field("", max_length=2000)


@kb_gov_router.get("/governance")
async def governance(m: dict = Depends(require_role(*STAFF))):
    arts = await db.articles.find({}, {"_id": 0, "content": 0, "steps": 0}).to_list(5000)
    today = datetime.now(timezone.utc).date()
    soon = (today + timedelta(days=30)).isoformat()
    for a in arts:
        a["status"] = a.get("status", "published")
    counts = {s: sum(1 for a in arts if a["status"] == s) for s in ARTICLE_STATUSES}
    expiring = [a for a in arts if a.get("expires_at") and today.isoformat() <= a["expires_at"][:10] <= soon]
    overdue_review = [a for a in arts if a.get("review_date") and a["review_date"][:10] < today.isoformat()
                      and a["status"] != "archived"]
    published = [a for a in arts if a["status"] == "published"]
    rated = [a for a in arts if (a.get("helpful_count") or 0) + (a.get("not_helpful_count") or 0) > 0]
    for a in rated:
        votes = a["helpful_count"] + a["not_helpful_count"]
        a["helpful_rate"] = round(100 * a["helpful_count"] / votes, 1)
    feedback = [{"id": a["id"], "title": a["title"], "helpful_count": a.get("helpful_count", 0),
                 "not_helpful_count": a.get("not_helpful_count", 0), "helpful_rate": a.get("helpful_rate", 0)}
                for a in sorted(rated, key=lambda a: a.get("helpful_count", 0) + a.get("not_helpful_count", 0),
                                reverse=True)[:20]]
    stale = [{"id": a["id"], "title": a["title"], "views": a.get("views", 0), "status": a["status"]}
             for a in sorted(published, key=lambda a: a.get("views", 0))[:10]]
    return {
        "counts": counts,
        "awaiting_approval": sorted([a for a in arts if a["status"] == "in_review"], key=lambda a: a.get("updated_at", "")),
        "ready_to_publish": sorted([a for a in arts if a["status"] == "approved"], key=lambda a: a.get("updated_at", "")),
        "expiring": sorted(expiring, key=lambda a: a.get("expires_at", "")),
        "overdue_review": sorted(overdue_review, key=lambda a: a.get("review_date", "")),
        "feedback": feedback,
        "stale": stale,
        "totals": {"articles": len(arts), "published": len(published), "drafts": counts["draft"],
                   "feedback_votes": sum((a.get("helpful_count") or 0) + (a.get("not_helpful_count") or 0) for a in arts)},
        "recent_audit": await db.kb_audit.find({}, {"_id": 0}).sort("at", -1).to_list(20),
    }


@kb_gov_router.get("/articles/{aid}/versions")
async def list_versions(aid: str, m: dict = Depends(require_role(*STAFF))):
    await _get(aid)
    return await db.article_versions.find({"article_id": aid}, {"_id": 0}).sort("version", -1).to_list(200)


@kb_gov_router.get("/articles/{aid}/versions/{vid}")
async def get_version(aid: str, vid: str, m: dict = Depends(require_role(*STAFF))):
    doc = await db.article_versions.find_one({"id": vid, "article_id": aid}, {"_id": 0})
    if doc is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return doc


@kb_gov_router.post("/articles/{aid}/versions/{vid}/restore")
async def restore_version(aid: str, vid: str, body: NoteIn | None = None, m: dict = Depends(require_role(*STAFF))):
    version = await db.article_versions.find_one({"id": vid, "article_id": aid}, {"_id": 0})
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    article = await _get(aid)
    await snapshot_article(article, m, f"Before restoring v{version['version']}")
    await db.articles.update_one({"id": aid}, {"$set": {
        **{k: version.get(k) for k in SNAPSHOT_FIELDS}, "version": int(article.get("version") or 1) + 1,
        "updated_at": now()}})
    await article_audit(aid, "restored", m, (body.note if body else "") or f"Restored version {version['version']}",
                        version=version["version"])
    return await _get(aid)


@kb_gov_router.post("/articles/{aid}/submit")
async def submit_for_review(aid: str, body: ReviewerIn | None = None, m: dict = Depends(require_role(*STAFF))):
    article = await _get(aid)
    if article.get("status", "published") not in ("draft", "archived"):
        raise HTTPException(status_code=409, detail="Only drafts or archived articles can be submitted")
    note = body.note if body else ""
    reviewer = {}
    if body and body.reviewer_id:
        reviewer = await db.users.find_one({"user_id": body.reviewer_id}, {"_id": 0}) or {}
        if not reviewer:
            raise HTTPException(status_code=400, detail="Unknown reviewer")
    await snapshot_article(article, m, note or "Submitted for review")
    await db.articles.update_one({"id": aid}, {"$set": {
        "status": "in_review", "submitted_at": now(), "updated_at": now(), "archived_at": "",
        "reviewer_id": reviewer.get("user_id", ""), "reviewer_name": reviewer.get("name", "")}})
    await article_audit(aid, "submitted", m, note, reviewer=reviewer.get("name", ""))
    return await _get(aid)


@kb_gov_router.post("/articles/{aid}/approve")
async def approve(aid: str, body: NoteIn | None = None, m: dict = Depends(require_role(*QA))):
    article = await _get(aid)
    if article.get("status") != "in_review":
        raise HTTPException(status_code=409, detail="Only articles in review can be approved")
    await db.articles.update_one({"id": aid}, {"$set": {
        "status": "approved", "approver_id": m["user_id"], "approver_name": m.get("name", ""), "updated_at": now()}})
    await article_audit(aid, "approved", m, body.note if body else "")
    return await _get(aid)


@kb_gov_router.post("/articles/{aid}/publish")
async def publish(aid: str, body: NoteIn | None = None, m: dict = Depends(require_role(*QA))):
    article = await _get(aid)
    if article.get("status") not in ("approved", "published"):
        raise HTTPException(status_code=409, detail="Approve the article before publishing it")
    await db.articles.update_one({"id": aid}, {"$set": {
        "status": "published", "published_at": article.get("published_at") or now(), "updated_at": now()}})
    await article_audit(aid, "published", m, body.note if body else "")
    return await _get(aid)


@kb_gov_router.post("/articles/{aid}/archive")
async def archive(aid: str, body: NoteIn | None = None, m: dict = Depends(require_role(*STAFF))):
    article = await _get(aid)
    if article.get("status") == "archived":
        raise HTTPException(status_code=409, detail="Already archived")
    note = body.note if body else ""
    await snapshot_article(article, m, note or "Archived")
    await db.articles.update_one({"id": aid}, {"$set": {
        "status": "archived", "archived_at": now(), "updated_at": now()}})
    await article_audit(aid, "archived", m, note)
    return await _get(aid)


@kb_gov_router.post("/articles/{aid}/reopen")
async def reopen(aid: str, body: NoteIn | None = None, m: dict = Depends(require_role(*STAFF))):
    article = await _get(aid)
    if article.get("status") != "archived":
        raise HTTPException(status_code=409, detail="Only archived articles can be reopened")
    await db.articles.update_one({"id": aid}, {"$set": {
        "status": "draft", "archived_at": "", "updated_at": now()}})
    await article_audit(aid, "reopened", m, body.note if body else "")
    return await _get(aid)


class FeedbackIn(BaseModel):
    helpful: bool
    comment: str = Field("", max_length=2000)


@kb_gov_router.post("/articles/{aid}/feedback")
async def feedback(aid: str, body: FeedbackIn, m: dict = Depends(require_role("admin", "qa_auditor", "team_lead", "agent"))):
    await _get(aid)
    doc = {"article_id": aid, "helpful": body.helpful, "comment": body.comment.strip(), "user_id": m["user_id"],
           "user_name": m.get("name", ""), "at": now()}
    existing = await db.kb_feedback.find_one({"article_id": aid, "user_id": m["user_id"]}, {"_id": 0, "id": 1})
    if existing:
        await db.kb_feedback.update_one({"id": existing["id"]}, {"$set": doc})
    else:
        await db.kb_feedback.insert_one({**doc, "id": new_id()})
    helpful = await db.kb_feedback.count_documents({"article_id": aid, "helpful": True})
    unhelpful = await db.kb_feedback.count_documents({"article_id": aid, "helpful": False})
    await db.articles.update_one({"id": aid}, {"$set": {"helpful_count": helpful, "not_helpful_count": unhelpful}})
    return {"helpful_count": helpful, "not_helpful_count": unhelpful, "my_feedback": body.helpful}


@kb_gov_router.get("/articles/{aid}/feedback")
async def list_feedback(aid: str, m: dict = Depends(require_role(*STAFF))):
    await _get(aid)
    return await db.kb_feedback.find({"article_id": aid}, {"_id": 0}).sort("at", -1).to_list(500)


@kb_gov_router.get("/articles/{aid}/audit")
async def article_audit_log(aid: str, m: dict = Depends(require_role(*STAFF))):
    await _get(aid)
    return await db.kb_audit.find({"article_id": aid}, {"_id": 0}).sort("at", -1).to_list(200)
