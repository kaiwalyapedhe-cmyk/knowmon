"""QA Operations Engine — sampling policies, evaluator assignment, coverage, SLA and QA form versions."""
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core import ENV, IN_ENV, QA, STAFF, db, new_id, now, require_role

qa_ops_router = APIRouter(prefix="/api/qa-ops", tags=["qa-ops"])
form_versions_router = APIRouter(prefix="/api/qa-forms", tags=["qa-forms"])

PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}
EVALUATOR_ROLES = ["admin", "qa_auditor", "team_lead"]
OPEN_STATES = ("pending", "in_progress")
FORM_FIELDS = ("id", "name", "description", "weight", "type", "auto_fail")


def period_start(period: str) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=PERIOD_DAYS.get(period, 30))).isoformat()


def sla_state(a: dict) -> str:
    status = a.get("status")
    if status == "cancelled":
        return "n/a"
    if status == "completed":
        return "met" if not a.get("due_at") or (a.get("completed_at") or "") <= a["due_at"] else "missed"
    if not a.get("due_at"):
        return "unscheduled"
    try:
        due = datetime.fromisoformat(a["due_at"])
    except ValueError:
        return "unscheduled"
    left = (due - datetime.now(timezone.utc)).total_seconds()
    if left < 0:
        return "overdue"
    return "due_soon" if left < 24 * 3600 else "on_track"


def _assigned_view(a: dict) -> dict:
    return {**a, "sla": sla_state(a)}


# ---------- Sampling policies ----------
class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    channel: str = "all"
    form_id: str = ""
    period: str = "monthly"
    target_per_agent: int = Field(4, ge=0, le=200)
    sample_percent: float = Field(10, ge=0, le=100)
    sla_days: int = Field(3, ge=1, le=60)
    include_flagged: bool = True
    include_auto_fail: bool = True
    active: bool = True

    def checked(self) -> "PolicyIn":
        if self.period not in PERIOD_DAYS:
            raise HTTPException(status_code=400, detail="Period must be daily, weekly or monthly")
        if self.channel not in ("all", "voice", "email", "chat", "whatsapp", "in_store"):
            raise HTTPException(status_code=400, detail="Unknown channel")
        return self


@qa_ops_router.get("/policies")
async def list_policies(m: dict = Depends(require_role(*STAFF))):
    return await db.qa_sampling_policies.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)


@qa_ops_router.post("/policies")
async def create_policy(body: PolicyIn, m: dict = Depends(require_role(*QA))):
    body = body.checked()
    doc = {**body.model_dump(), "id": new_id(), "created_by": m["user_id"], "created_by_name": m.get("name", ""),
           "created_at": now()}
    await db.qa_sampling_policies.insert_one(dict(doc))
    return doc


@qa_ops_router.put("/policies/{pid}")
async def update_policy(pid: str, body: PolicyIn, m: dict = Depends(require_role(*QA))):
    body = body.checked()
    res = await db.qa_sampling_policies.update_one({"id": pid}, {"$set": {**body.model_dump(), "updated_at": now()}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return await db.qa_sampling_policies.find_one({"id": pid}, {"_id": 0})


@qa_ops_router.delete("/policies/{pid}")
async def delete_policy(pid: str, m: dict = Depends(require_role(*QA))):
    if (await db.qa_sampling_policies.delete_one({"id": pid})).deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ---------- Assignment queue ----------
async def _evaluators() -> List[dict]:
    return await db.users.find({**IN_ENV, "disabled": {"$ne": True}, "role": {"$in": EVALUATOR_ROLES}},
                               {"_id": 0, "user_id": 1, "name": 1, "role": 1}).to_list(200)


async def _evaluator_load() -> dict:
    load = defaultdict(int)
    async for a in db.qa_assignments.find({"status": {"$in": list(OPEN_STATES)}}, {"_id": 0, "evaluator_id": 1}):
        load[a.get("evaluator_id")] += 1
    return load


def _due(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=max(1, days))).isoformat()


async def _new_assignment(member: dict, it: dict, evaluator: dict, source: str, sla_days: int, note: str = "") -> dict:
    doc = {"id": new_id(), "interaction_id": it["id"], "agent_id": it.get("agent_id") or "",
           "agent_name": it.get("agent_name") or "", "channel": it.get("channel", ""),
           "form_id": it.get("form_id", ""), "form_name": it.get("form_name", ""),
           "score_at_assignment": it.get("overall_score"), "evaluator_id": evaluator["user_id"],
           "evaluator_name": evaluator.get("name", ""), "status": "pending", "source": source,
           "due_at": _due(sla_days), "assigned_by": member["user_id"], "assigned_by_name": member.get("name", ""),
           "assigned_at": now(), "note": note, "completed_at": "", "outcome": "", "review_note": ""}
    await db.qa_assignments.insert_one(dict(doc))
    return doc


class RunPolicyIn(BaseModel):
    policy_id: str


@qa_ops_router.post("/sample")
async def run_sampling(body: RunPolicyIn, m: dict = Depends(require_role(*QA))):
    """Pick random and targeted interactions for review and spread them over the evaluators."""
    policy = await db.qa_sampling_policies.find_one({"id": body.policy_id}, {"_id": 0})
    if policy is None:
        raise HTTPException(status_code=404, detail="Sampling policy not found")
    evaluators = await _evaluators()
    if not evaluators:
        raise HTTPException(status_code=400, detail="Add a QA auditor, team lead or admin before sampling")
    start = period_start(policy["period"])
    q = {"status": "scored", "created_at": {"$gte": start}}
    if policy["channel"] != "all":
        q["channel"] = policy["channel"]
    if policy.get("form_id"):
        q["form_id"] = policy["form_id"]
    items = await db.interactions.find(q, {"_id": 0, "id": 1, "agent_id": 1, "agent_name": 1, "channel": 1, "form_id": 1,
                                           "form_name": 1, "overall_score": 1, "auto_failed": 1,
                                           "compliance_flags": 1}).to_list(5000)
    assigned = set(await db.qa_assignments.distinct("interaction_id", {"assigned_at": {"$gte": start},
                                                                     "status": {"$ne": "cancelled"}}))
    per_agent = defaultdict(int)
    async for a in db.qa_assignments.find({"assigned_at": {"$gte": start}, "status": {"$ne": "cancelled"}},
                                          {"_id": 0, "agent_id": 1}):
        per_agent[a.get("agent_id") or ""] += 1

    fresh = [i for i in items if i["id"] not in assigned]
    targeted, rest = [], []
    for i in fresh:
        flagged = bool(i.get("compliance_flags")) and policy["include_flagged"]
        failed = bool(i.get("auto_failed")) and policy["include_auto_fail"]
        low = (i.get("overall_score") or 100) < 70
        (targeted if flagged or failed or low else rest).append(i)
    cut = int(round(len(fresh) * policy["sample_percent"] / 100))
    picks = list(targeted)
    if cut > 0:
        picks += random.sample(rest, min(cut, len(rest)))
    picks.sort(key=lambda i: 0 if i in targeted else 1)

    load = await _evaluator_load()
    created = []
    for it in picks:
        agent_key = it.get("agent_id") or it.get("agent_name") or ""
        cap = policy["target_per_agent"]
        if cap and it not in targeted and per_agent[agent_key] >= cap:
            continue
        evaluator = min(evaluators, key=lambda e: load[e["user_id"]])
        load[evaluator["user_id"]] += 1
        per_agent[agent_key] += 1
        created.append(await _new_assignment(m, it, evaluator, "targeted" if it in targeted else "random", policy["sla_days"]))
    return {"created": len(created), "considered": len(fresh), "targeted": len(targeted),
            "assignments": [_assigned_view(a) for a in created]}


class AssignmentIn(BaseModel):
    interaction_id: str
    evaluator_id: str = ""
    sla_days: int = Field(3, ge=1, le=60)
    note: str = Field("", max_length=2000)


@qa_ops_router.post("/assignments")
async def create_assignment(body: AssignmentIn, m: dict = Depends(require_role(*STAFF))):
    it = await db.interactions.find_one({"id": body.interaction_id}, {"_id": 0})
    if it is None:
        raise HTTPException(status_code=404, detail="Interaction not found")
    if body.evaluator_id:
        evaluator = await db.users.find_one({"user_id": body.evaluator_id, **IN_ENV}, {"_id": 0})
        if evaluator is None or evaluator.get("role") not in EVALUATOR_ROLES:
            raise HTTPException(status_code=400, detail="Evaluate must be a QA auditor, team lead or admin")
    else:
        candidates = await _evaluators()
        if not candidates:
            raise HTTPException(status_code=400, detail="Add an evaluator first")
        load = await _evaluator_load()
        evaluator = min(candidates, key=lambda e: load[e["user_id"]])
    exists = await db.qa_assignments.find_one({"interaction_id": it["id"], "status": {"$in": list(OPEN_STATES)}})
    if exists:
        raise HTTPException(status_code=409, detail="This interaction is already in the review queue")
    return _assigned_view(await _new_assignment(m, it, evaluator, "manual", body.sla_days, body.note.strip()))


@qa_ops_router.get("/assignments")
async def list_assignments(status: str = "", mine: bool = False, m: dict = Depends(require_role(*STAFF))):
    q = {}
    if status:
        q["status"] = status
    if mine:
        q["evaluator_id"] = m["user_id"]
    return [_assigned_view(a) for a in await db.qa_assignments.find(q, {"_id": 0}).sort("due_at", 1).to_list(1000)]


class CompleteIn(BaseModel):
    status: str = "completed"
    outcome: str = ""
    note: str = Field("", max_length=2000)


@qa_ops_router.patch("/assignments/{aid}")
async def update_assignment(aid: str, body: CompleteIn, m: dict = Depends(require_role(*STAFF))):
    a = await db.qa_assignments.find_one({"id": aid}, {"_id": 0})
    if a is None:
        raise HTTPException(status_code=404, detail="Not found")
    if m["user_id"] not in (a["evaluator_id"], a["assigned_by"]) and m["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only the evaluator or an admin can update this task")
    if body.status not in ("pending", "in_progress", "completed", "cancelled"):
        raise HTTPException(status_code=400, detail="Unknown status")
    if body.outcome and body.outcome not in ("confirmed", "flagged", "coached"):
        raise HTTPException(status_code=400, detail="Unknown outcome")
    update = {"status": body.status, "review_note": body.note.strip(), "outcome": body.outcome}
    if body.status == "completed":
        update["completed_at"] = now()
    await db.qa_assignments.update_one({"id": aid}, {"$set": update})
    return _assigned_view(await db.qa_assignments.find_one({"id": aid}, {"_id": 0}))


@qa_ops_router.get("/overview")
async def overview(period: str = "monthly", m: dict = Depends(require_role(*STAFF))):
    start = period_start(period)
    total = await db.interactions.count_documents({"status": "scored", "created_at": {"$gte": start}})
    assigns = await db.qa_assignments.find({"assigned_at": {"$gte": start}}, {"_id": 0}).to_list(20000)
    live = [a for a in assigns if a["status"] != "cancelled"]
    covered = len({a["interaction_id"] for a in live})
    policy = await db.qa_sampling_policies.find_one({"active": True}, sort=[("created_at", 1)])
    target = policy["target_per_agent"] if policy else 0

    agents = {u["name"]: {"agent_name": u["name"], "agent_id": u["user_id"], "assigned": 0, "completed": 0}
              for u in await db.users.find({**IN_ENV, "role": "agent", "disabled": {"$ne": True}},
                                           {"_id": 0, "user_id": 1, "name": 1}).to_list(2000)}
    for a in live:
        row = agents.setdefault(a.get("agent_name") or "—",
                                {"agent_name": a.get("agent_name") or "—", "agent_id": a.get("agent_id") or "",
                                 "assigned": 0, "completed": 0})
        row["assigned"] += 1
        row["completed"] += 1 if a["status"] == "completed" else 0
    for row in agents.values():
        row["target"] = target
        row["coverage"] = round(100 * row["completed"] / target, 1) if target else 0

    workload = defaultdict(lambda: {"pending": 0, "in_progress": 0, "completed": 0, "overdue": 0, "name": ""})
    for a in live:
        eval_id = a.get("evaluator_id") or "unassigned"
        w = workload[eval_id]
        w["name"] = a.get("evaluator_name") or eval_id
        st = a.get("status") or "pending"
        w[st] = w.get(st, 0) + 1
        w["overdue"] += 1 if sla_state(a) in ("overdue", "missed") else 0
    done = [a for a in live if a["status"] == "completed"]
    met = sum(1 for a in done if sla_state(a) == "met")
    return {
        "period": period, "period_start": start, "target_per_agent": target, "policy": policy,
        "kpis": {
            "evaluated": total, "assigned": len(live), "coverage": round(100 * covered / total, 1) if total else 0,
            "pending": sum(1 for a in live if a["status"] in OPEN_STATES),
            "overdue": sum(1 for a in live if sla_state(a) in ("overdue", "missed")),
            "sla_met": round(100 * met / len(done), 1) if done else 0, "completed": len(done),
        },
        "statuses": {s: sum(1 for a in live if a["status"] == s) for s in ("pending", "in_progress", "completed")},
        "by_agent": sorted(agents.values(), key=lambda r: (r["coverage"], r["agent_name"]))[:200],
        "workload": [{"evaluator_id": k, **v, "open": v["pending"] + v["in_progress"]} for k, v in workload.items()],
    }


# ---------- QA form versions ----------
async def snapshot_form(form: dict, member: dict, change_note: str = "") -> dict:
    version = int(form.get("version") or 1)
    doc = {"id": new_id(), "form_id": form["id"], "version": version, "name": form.get("name", ""),
           "description": form.get("description", ""), "channel": form.get("channel", "all"),
           "criteria": [{k: c.get(k) for k in FORM_FIELDS} for c in form.get("criteria", [])],
           "change_note": change_note, "created_by": member["user_id"], "created_by_name": member.get("name", ""),
           "created_at": now()}
    await db.qa_form_versions.insert_one(dict(doc))
    return doc


def form_changed(old: dict, new: dict) -> bool:
    return any(old.get(k) != new.get(k) for k in ("name", "description", "channel", "criteria"))


@form_versions_router.get("/{form_id}/versions")
async def list_form_versions(form_id: str, m: dict = Depends(require_role(*QA))):
    return await db.qa_form_versions.find({"form_id": form_id}, {"_id": 0}).sort("version", -1).to_list(200)


@form_versions_router.get("/{form_id}/versions/{vid}")
async def get_form_version(form_id: str, vid: str, m: dict = Depends(require_role(*QA))):
    doc = await db.qa_form_versions.find_one({"id": vid, "form_id": form_id}, {"_id": 0})
    if doc is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return doc


@form_versions_router.post("/{form_id}/versions/{vid}/restore")
async def restore_form_version(form_id: str, vid: str, m: dict = Depends(require_role(*QA))):
    version = await db.qa_form_versions.find_one({"id": vid, "form_id": form_id}, {"_id": 0})
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    form = await db.qa_forms.find_one({"id": form_id}, {"_id": 0})
    if form is None:
        raise HTTPException(status_code=404, detail="Form not found")
    await snapshot_form(form, m, f"Before restoring v{version['version']}")
    next_version = int(form.get("version") or 1) + 1
    await db.qa_forms.update_one({"id": form_id}, {"$set": {
        "name": version["name"], "description": version["description"], "channel": version["channel"],
        "criteria": version["criteria"], "version": next_version, "updated_at": now()}})
    return await db.qa_forms.find_one({"id": form_id}, {"_id": 0})


# ---------- Score change audit trail ----------
async def record_score_change(interaction_id: str, old: float, new: float, source: str, member: dict, note: str = ""):
    entry = {"id": new_id(), "interaction_id": interaction_id, "old_score": old, "new_score": new,
             "source": source, "note": note[:2000], "by": member["user_id"], "by_name": member.get("name", ""),
             "at": now()}
    await db.score_audit.insert_one(dict(entry))
    await db.interactions.update_one({"id": interaction_id}, {"$push": {"score_history": entry}})
    return entry


@qa_ops_router.get("/score-history/{interaction_id}")
async def score_history(interaction_id: str, m: dict = Depends(require_role(*STAFF))):
    return await db.score_audit.find({"interaction_id": interaction_id}, {"_id": 0}).sort("at", 1).to_list(200)
