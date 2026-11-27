"""Transmon QA Operations Router — Audit Reports, Ingestion, and Auto-Sampling.
Replicates WyzMindz / Transmon Zepto FinalReport.aspx and AutoSampling.aspx.
"""
import csv
import io
import logging
import random
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
import openpyxl
from pydantic import BaseModel, Field

from core import IN_ENV, QA, STAFF, db, new_id, now, require_role

logger = logging.getLogger(__name__)

transmon_router = APIRouter(prefix="/api/qa-ops/transmon", tags=["transmon-ops"])

TRANSMON_COLUMNS = [
    "Audit Id", "Form Id", "Audit Score", "Scorable Value", "Scoring Value", "Emp Code",
    "Transmon Id", "Agentid", "Agentname", "Escalation Date", "Escalation Time", "City Name",
    "Order Id", "Ews Flagged On Onesupport", "Customer Karma", "Scope", "Issue Category",
    "Issue Sub Category", "Issue Sub Sub Category", "Acpt", "L1 Reason", "L2 Reason",
    "Reason Categorisation", "Agent Opportunity", "Cpt Opportunity", "Observations",
    "Konnect Id", "Chat Ticket Id", "Escalation Type", "Rca Level", "Ldap Id", "Ldap Name",
    "Ldap Email Id", "Ldap Location", "Ztp", "Queue", "NA1", "Q1-Reason", "Q1-Remarks",
    "NA2", "Q2-Reason", "Q2-Remarks", "NA3", "Q3-Reason", "Q3-Remarks", "Fatal Count",
    "Fatal Status", "Agent Comments", "Agent Disposition", "Teamleader", "Sample To",
    "Created By", "Agent Disposition Date", "Agent Disposition Time", "Audit Start Date",
    "Audit Started Time", "Createdon Date", "Createdon Time", "Rebuttal Comments",
    "Rebuttal Reasons", "Disagree", "Rebuttal Raised Date", "Rebuttal Closed Date",
    "File Id", "Tl Disposition By", "Tl Disposition On", "Rebuttal Status", "Na",
    "Tenurity", "Joining Week", "Joining Month", "Audit Evaluation Duration",
    "Voice FeedBack Status", "File Upload Status"
]


def _clean_str(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    return "" if s == "None" else s


def _parse_row(row_dict: Dict[str, Any]) -> Dict[str, Any]:
    cleaned = {k.strip(): _clean_str(v) for k, v in row_dict.items() if k}
    audit_id = cleaned.get("Audit Id") or cleaned.get("audit_id") or new_id()
    cleaned["id"] = audit_id
    cleaned["audit_id"] = audit_id
    cleaned["form_id"] = cleaned.get("Form Id") or cleaned.get("form_id") or "SM FORM"
    cleaned["process_name"] = cleaned.get("process_name") or ("SM FORM" if "0053" in cleaned["form_id"] else cleaned["form_id"])
    cleaned["agent_name"] = cleaned.get("Agentname") or cleaned.get("agent_name") or ""
    cleaned["agent_id"] = cleaned.get("Agentid") or cleaned.get("agent_id") or ""
    cleaned["order_id"] = cleaned.get("Order Id") or cleaned.get("order_id") or ""
    cleaned["city_name"] = cleaned.get("City Name") or cleaned.get("city_name") or ""
    cleaned["escalation_date"] = cleaned.get("Escalation Date") or cleaned.get("escalation_date") or ""
    cleaned["created_date"] = cleaned.get("Createdon Date") or cleaned.get("created_date") or ""

    cadence_id = cleaned.get("CadenceCX Id") or cleaned.get("Transmon Id") or cleaned.get("cadencecx_id") or ""
    cleaned["CadenceCX Id"] = cadence_id
    cleaned["Transmon Id"] = cadence_id
    cleaned["cadencecx_id"] = cadence_id

    try:
        cleaned["audit_score"] = float(cleaned.get("Audit Score") or cleaned.get("audit_score") or 0.0)
    except (ValueError, TypeError):
        cleaned["audit_score"] = 0.0

    try:
        cleaned["fatal_count"] = int(float(cleaned.get("Fatal Count") or cleaned.get("fatal_count") or 0))
    except (ValueError, TypeError):
        cleaned["fatal_count"] = 0

    cleaned["fatal_status"] = cleaned.get("Fatal Status") or ("Yes" if cleaned["fatal_count"] > 0 else "No")
    cleaned["ztp"] = cleaned.get("Ztp") or cleaned.get("ztp") or "No"

    if "imported_at" not in cleaned:
        cleaned["imported_at"] = now()
    return cleaned


# ---------- AUDITS & REPORTS ----------

@transmon_router.get("/metadata")
async def get_metadata(m: dict = Depends(require_role(*STAFF))):
    """Return available processes, evaluators, years, months, and weeks."""
    distinct_forms = await db.transmon_audits.distinct("Form Id")
    distinct_processes = await db.transmon_audits.distinct("process_name")
    all_processes = sorted(list({p for p in distinct_processes + distinct_forms if p} | {"SM FORM"}))

    # Evaluators from users collection + distinct Transmon sample_to / created_by
    users = await db.users.find({**IN_ENV, "disabled": {"$ne": True}}, {"_id": 0, "user_id": 1, "name": 1, "email": 1, "role": 1}).to_list(100)
    sample_tos = await db.transmon_audits.distinct("Sample To")
    created_bys = await db.transmon_audits.distinct("Created By")

    evaluator_options = []
    seen = set()
    for u in users:
        val = u.get("email") or u.get("name")
        if val and val not in seen:
            seen.add(val)
            evaluator_options.append({"value": val, "label": f"{u.get('name', val)} ({val})"})
    for s in sample_tos + created_bys:
        if s and s not in seen and s != "-":
            seen.add(s)
            evaluator_options.append({"value": s, "label": s})

    return {
        "processes": all_processes,
        "evaluators": evaluator_options,
        "years": ["2026", "2025", "2024"],
        "months": [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ],
        "weeks": ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5"],
        "audit_types": ["Normal", "Targeted", "High Value Orders", "Fatal Re-audit"]
    }


@transmon_router.get("/audits")
async def list_transmon_audits(
    process_name: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    search_field: Optional[str] = Query(None),
    search_query: Optional[str] = Query(None),
    calc_type: str = Query("New"),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=200),
    m: dict = Depends(require_role(*STAFF)),
):
    """Query Transmon audits with filters matching FinalReport.aspx."""
    flt: Dict[str, Any] = {}

    if process_name and process_name != "All" and process_name.strip():
        # Match either Form Id or process_name
        flt["$or"] = [
            {"Form Id": {"$regex": process_name, "$options": "i"}},
            {"process_name": {"$regex": process_name, "$options": "i"}}
        ]

    # Handle search field
    if search_query and search_query.strip():
        sq = search_query.strip()
        field_map = {
            "id": ["Audit Id", "id"],
            "Audit Id": ["Audit Id"],
            "CadenceCX Id": ["CadenceCX Id", "Transmon Id"],
            "Transmon Id": ["CadenceCX Id", "Transmon Id"],
            "Agentid": ["Agentid"],
            "Agentname": ["Agentname"],
            "Order Id": ["Order Id"],
            "City Name": ["City Name"],
            "Issue Category": ["Issue Category"],
            "Teamleader": ["Teamleader"],
            "Created By": ["Created By"]
        }
        target_fields = field_map.get(search_field, [search_field]) if search_field and search_field != "all" else [
            "Audit Id", "Agentid", "Agentname", "Order Id", "City Name", "Issue Category", "Teamleader"
        ]
        or_conditions = [{f: {"$regex": sq, "$options": "i"}} for f in target_fields]
        if "$or" in flt:
            flt = {"$and": [{"$or": flt["$or"]}, {"$or": or_conditions}]}
        else:
            flt["$or"] = or_conditions

    total = await db.transmon_audits.count_documents(flt)
    skip = (page - 1) * page_size
    items = await db.transmon_audits.find(flt, {"_id": 0}).skip(skip).limit(page_size).to_list(page_size)

    # Compute high-level KPI summaries
    all_matching = await db.transmon_audits.find(flt, {"_id": 0, "audit_score": 1, "fatal_count": 1, "ztp": 1}).to_list(10000)
    scores = [it.get("audit_score", 0.0) for it in all_matching if isinstance(it.get("audit_score"), (int, float))]
    avg_score = round(sum(scores) / len(scores), 2) if scores else 0.0
    fatal_count = sum(1 for it in all_matching if (it.get("fatal_count") or 0) > 0 or it.get("Fatal Status") == "Yes")
    ztp_count = sum(1 for it in all_matching if str(it.get("ztp") or it.get("Ztp", "")).lower() == "yes")

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size if page_size else 1,
        "calc_type": calc_type,
        "summary": {
            "total_records": total,
            "avg_score": avg_score,
            "fatal_count": fatal_count,
            "ztp_count": ztp_count
        }
    }


@transmon_router.get("/audits/{audit_id}")
async def get_audit_detail(audit_id: str, m: dict = Depends(require_role(*STAFF))):
    """Retrieve full 74-column details for a single Transmon audit."""
    doc = await db.transmon_audits.find_one({"$or": [{"Audit Id": audit_id}, {"id": audit_id}]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Audit record not found")
    return doc


@transmon_router.post("/import")
async def import_transmon_records(file: UploadFile = File(...), m: dict = Depends(require_role(*QA))):
    """Import CSV, XLS, or XLSX file of Transmon audits."""
    contents = await file.read()
    filename = file.filename or "import.csv"
    records: List[Dict[str, Any]] = []

    if filename.endswith(".csv"):
        text = contents.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            if any(v.strip() for v in row.values() if v):
                records.append(_parse_row(row))
    else:
        # Excel (.xlsx or .xls opened as openpyxl zip buffer)
        try:
            buf = io.BytesIO(contents)
            wb = openpyxl.load_workbook(buf, data_only=True)
            sheet = wb.active
            rows = list(sheet.iter_rows(values_only=True))
            if not rows or len(rows) < 2:
                raise HTTPException(status_code=400, detail="Excel file contains no data rows")
            headers = [str(c).strip() if c is not None else f"Col_{i}" for i, c in enumerate(rows[0])]
            for r in rows[1:]:
                if any(c is not None and str(c).strip() != "" for c in r):
                    row_dict = {headers[i]: r[i] for i in range(min(len(headers), len(r)))}
                    records.append(_parse_row(row_dict))
        except Exception as e:
            logger.error("Failed to parse Excel file: %s", e)
            raise HTTPException(status_code=400, detail=f"Failed to parse Excel file: {str(e)}")

    if not records:
        raise HTTPException(status_code=400, detail="No valid records found in the uploaded file")

    inserted = 0
    updated = 0
    for r in records:
        audit_id = r["Audit Id"]
        res = await db.transmon_audits.update_one({"Audit Id": audit_id}, {"$set": r}, upsert=True)
        if res.upserted_id or res.matched_count == 0:
            inserted += 1
        else:
            updated += 1

    return {
        "ok": True,
        "total_parsed": len(records),
        "inserted": inserted,
        "updated": updated,
        "message": f"Successfully processed {len(records)} Transmon audit records ({inserted} new, {updated} updated)."
    }


@transmon_router.get("/export")
async def export_transmon_records(
    process_name: Optional[str] = Query(None),
    search_query: Optional[str] = Query(None),
    m: dict = Depends(require_role(*STAFF)),
):
    """Export filtered Transmon records as a CSV download."""
    flt: Dict[str, Any] = {}
    if process_name and process_name != "All":
        flt["$or"] = [
            {"Form Id": {"$regex": process_name, "$options": "i"}},
            {"process_name": {"$regex": process_name, "$options": "i"}}
        ]
    if search_query and search_query.strip():
        sq = search_query.strip()
        flt["$or"] = [
            {"Audit Id": {"$regex": sq, "$options": "i"}},
            {"Agentname": {"$regex": sq, "$options": "i"}},
            {"Order Id": {"$regex": sq, "$options": "i"}},
        ]

    docs = await db.transmon_audits.find(flt, {"_id": 0}).limit(10000).to_list(10000)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=TRANSMON_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for d in docs:
        row = {col: d.get(col, "") for col in TRANSMON_COLUMNS}
        writer.writerow(row)

    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="FinalReport.csv"'}
    )


# ---------- AUTO SAMPLING ----------

class SamplingPlanIn(BaseModel):
    process_name: str = "SM FORM"
    sample_count: int = Field(10, ge=1, le=500)
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    previous_sampling: bool = True
    audit_type: str = "Normal"
    year: Optional[str] = "2026"
    month: Optional[str] = "November"
    week: Optional[str] = "Week 4"
    sampling_to: str = Field(..., description="Auditor username or email")


@transmon_router.post("/generate-sampling")
async def generate_sampling(body: SamplingPlanIn, m: dict = Depends(require_role(*QA))):
    """Generate candidate sample batch matching AutoSampling.aspx."""
    flt: Dict[str, Any] = {}
    if body.process_name and body.process_name != "All":
        flt["$or"] = [
            {"Form Id": {"$regex": body.process_name, "$options": "i"}},
            {"process_name": {"$regex": body.process_name, "$options": "i"}}
        ]

    candidates = await db.transmon_audits.find(flt, {"_id": 0}).to_list(5000)
    if not candidates:
        # Fallback to all audits if specific process has 0 records
        candidates = await db.transmon_audits.find({}, {"_id": 0}).to_list(5000)

    # Exclude already sampled if previous_sampling is False
    if not body.previous_sampling:
        previously_sampled = set(await db.transmon_sampling.distinct("sample_ids"))
        candidates = [c for c in candidates if c.get("Audit Id") not in previously_sampled]

    # Pick samples based on audit_type
    target_k = min(body.sample_count, len(candidates))
    if body.audit_type == "Targeted":
        # Prioritize low score or fatal audits
        targeted = [c for c in candidates if c.get("fatal_status") == "Yes" or (c.get("audit_score") or 100) < 70]
        rest = [c for c in candidates if c not in targeted]
        sampled = targeted[:target_k]
        if len(sampled) < target_k:
            sampled.extend(random.sample(rest, min(target_k - len(sampled), len(rest))))
    else:
        sampled = random.sample(candidates, target_k) if candidates else []

    sample_ids = [s.get("Audit Id") for s in sampled if s.get("Audit Id")]

    plan_preview = {
        "id": f"samp-{new_id()[:8]}",
        "process_name": body.process_name,
        "sample_count": body.sample_count,
        "actual_generated": len(sampled),
        "from_date": body.from_date or "2026-11-01",
        "to_date": body.to_date or "2026-11-26",
        "previous_sampling": body.previous_sampling,
        "audit_type": body.audit_type,
        "year": body.year,
        "month": body.month,
        "week": body.week,
        "sampling_to": body.sampling_to,
        "sample_ids": sample_ids,
        "samples": sampled[:20],
        "created_by": m["user_id"],
        "created_by_name": m.get("name", ""),
        "created_at": now()
    }

    return {
        "ok": True,
        "count_generated": len(sampled),
        "plan": plan_preview
    }


@transmon_router.post("/save-sampling")
async def save_sampling(plan: Dict[str, Any], m: dict = Depends(require_role(*QA))):
    """Save generated sampling plan to the database and schedule tasks."""
    plan_id = plan.get("id") or f"samp-{new_id()[:8]}"
    doc = {
        **plan,
        "id": plan_id,
        "status": "Saved",
        "saved_at": now(),
        "saved_by": m["user_id"],
        "saved_by_name": m.get("name", "")
    }

    await db.transmon_sampling.update_one({"id": plan_id}, {"$set": doc}, upsert=True)

    # Also register QA assignments for the assigned auditor
    sample_ids = plan.get("sample_ids") or []
    assigned_count = 0
    for sid in sample_ids:
        audit = await db.transmon_audits.find_one({"Audit Id": sid}, {"_id": 0})
        if audit:
            # Check if assignment already exists
            exists = await db.qa_assignments.find_one({"interaction_id": sid, "status": {"$in": ["pending", "in_progress"]}})
            if not exists:
                assignment = {
                    "id": new_id(),
                    "interaction_id": sid,
                    "agent_id": audit.get("Agentid", ""),
                    "agent_name": audit.get("Agentname", ""),
                    "channel": "audit",
                    "form_id": audit.get("Form Id", "SM FORM"),
                    "form_name": audit.get("Form Id", "SM FORM"),
                    "score_at_assignment": audit.get("audit_score", 0),
                    "evaluator_id": plan.get("sampling_to", m["user_id"]),
                    "evaluator_name": plan.get("sampling_to", m.get("name", "")),
                    "status": "pending",
                    "source": f"transmon-sampling-{plan.get('audit_type', 'normal')}",
                    "due_at": (datetime.now(timezone.utc)).isoformat(),
                    "assigned_by": m["user_id"],
                    "assigned_by_name": m.get("name", ""),
                    "assigned_at": now(),
                    "note": f"Auto-sampled from {plan.get('process_name')} ({plan.get('week')}, {plan.get('month')} {plan.get('year')})",
                    "completed_at": "",
                    "outcome": "",
                    "review_note": ""
                }
                await db.qa_assignments.insert_one(assignment)
                assigned_count += 1

    return {
        "ok": True,
        "plan_id": plan_id,
        "status": "Saved",
        "assigned_evaluations": assigned_count,
        "message": f"Successfully saved sampling plan {plan_id} with {len(sample_ids)} sample records assigned to {plan.get('sampling_to')}."
    }


@transmon_router.get("/sampling-processes")
async def list_sampling_processes(m: dict = Depends(require_role(*STAFF))):
    """Retrieve history of auto-sampling batches."""
    plans = await db.transmon_sampling.find({}, {"_id": 0}).sort("saved_at", -1).to_list(100)
    return plans


@transmon_router.delete("/sampling-processes/{process_id}")
async def delete_sampling_process(process_id: str, m: dict = Depends(require_role(*QA))):
    """Delete a sampling process record."""
    res = await db.transmon_sampling.delete_one({"id": process_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Sampling process not found")
    return {"ok": True, "message": "Sampling process deleted"}
