import hmac
import html
import os
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import logging

from core import IN_ENV, STAFF, db, effective_role, new_id, now, require_role, spawn
from ldap_auth import ldap_enabled, ldap_team_lead_emails
from mailer import send_email, smtp_configured

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
digest_router = APIRouter(prefix="/api")


def _base_url(request: Request) -> str:
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host", "")).split(",")[0].strip()
    proto = (request.headers.get("x-forwarded-proto") or "https").split(",")[0].strip()
    return f"{proto}://{host}"


async def recipients() -> list:
    docs = await db.users.find({**IN_ENV, "email": {"$nin": [None, ""]}}, {"_id": 0, "email": 1, "role": 1}).to_list(2000)
    emails = {d["email"].lower() for d in docs if effective_role(d.get("role")) == "team_lead"}
    try:
        emails |= set(await run_in_threadpool(ldap_team_lead_emails))
    except Exception:
        logger.exception("LDAP team lead lookup failed")
    return sorted(emails)


async def build_digest(base_url: str) -> dict:
    day = datetime.now(IST).date()
    start = datetime.combine(day, time.min, IST)
    q = {"status": "scored", "created_at": {"$gte": start.isoformat(), "$lt": (start + timedelta(days=1)).isoformat()}}
    items = await db.interactions.find(q, {"_id": 0, "transcript": 0, "segments": 0}).to_list(5000)
    n = len(items)
    avg = round(sum(i["overall_score"] for i in items) / n, 1) if n else 0
    lowest = sorted(items, key=lambda i: i["overall_score"])[:5]
    flags = [{"agent": i["agent_name"], "id": i["id"], **f} for i in items for f in i.get("compliance_flags", [])]
    auto_fails = sum(1 for i in items if i.get("auto_failed"))
    open_disputes = await db.interactions.count_documents({"dispute.status": "open"})
    stats = {"date": day.isoformat(), "evaluated": n, "avg_score": avg, "auto_fails": auto_fails,
             "flags": len(flags), "open_disputes": open_disputes}
    e = html.escape
    link = lambda i: f"{base_url}/interactions/{i}"  # noqa: E731
    low_rows = "".join(
        f"<tr><td style='padding:8px;border-bottom:1px solid #E2E8F0'><a href='{link(i['id'])}' style='color:#1B3F94'>{e(i['agent_name'])}</a></td>"
        f"<td style='padding:8px;border-bottom:1px solid #E2E8F0'>{e(i['channel'])}</td>"
        f"<td style='padding:8px;border-bottom:1px solid #E2E8F0;color:#E31E24;font-weight:700'>{'AUTO-FAIL' if i.get('auto_failed') else i['overall_score']}</td></tr>"
        for i in lowest) or "<tr><td style='padding:8px'>No interactions scored today.</td></tr>"
    flag_rows = "".join(
        f"<li style='margin-bottom:6px'><b style='color:#E31E24'>{e(f.get('severity', '').upper())}</b> · {e(f['agent'])}: {e(f.get('issue', ''))} "
        f"<a href='{link(f['id'])}' style='color:#1B3F94'>review</a></li>" for f in flags[:20]) or "<li>No compliance flags today.</li>"
    kpi = lambda label, val: f"<td style='padding:12px;background:#F4F6FB;border-radius:8px'><div style='font-size:11px;color:#E31E24;font-weight:700;letter-spacing:2px;text-transform:uppercase'>{label}</div><div style='font-size:22px;color:#16357F;font-weight:800'>{val}</div></td>"  # noqa: E731
    body = f"""<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1E293B">
<div style="background:#1B3F94;padding:20px 24px;border-bottom:5px solid #E31E24"><span style="color:#fff;font-size:22px;font-weight:800">Cadence</span><span style="color:#FF5A5F;font-size:22px;font-weight:800">CX</span>
<div style="color:#C7D2FE;font-size:12px;margin-top:4px">Daily QA digest · {day.strftime('%d %B %Y')}</div></div>
<div style="padding:24px"><table cellspacing="8" style="width:100%"><tr>{kpi('Evaluated', n)}{kpi('Avg score', f'{avg}%')}{kpi('Auto-fails', auto_fails)}{kpi('Open disputes', open_disputes)}</tr></table>
<h3 style="color:#16357F">Lowest scores today</h3><table style="width:100%;border-collapse:collapse;font-size:14px">{low_rows}</table>
<h3 style="color:#16357F">Compliance flags ({len(flags)})</h3><ul style="font-size:14px;padding-left:18px">{flag_rows}</ul>
<p style="margin-top:24px"><a href="{base_url}/dashboard" style="background:#E31E24;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:700">Open dashboard</a></p></div></div>"""
    text = (f"Cadence CX daily QA digest {day}\nEvaluated: {n} · Avg: {avg}% · Auto-fails: {auto_fails} · Open disputes: {open_disputes}\n\nLowest scores:\n" +
            "\n".join(f"- {i['agent_name']}: {i['overall_score']} {link(i['id'])}" for i in lowest) +
            "\n\nCompliance flags:\n" + "\n".join(f"- [{f.get('severity')}] {f['agent']}: {f.get('issue')}" for f in flags[:20]))
    return {"stats": stats, "html": body, "text": text, "subject": f"Cadence CX QA digest · {day.strftime('%d %b')} · avg {avg}% · {len(flags)} flags"}


async def send_digest(base_url: str, trigger: str, run_id: str = "") -> dict:
    log = {"id": new_id(), "trigger": trigger, "run_id": run_id, "at": now(), "status": "sent", "error": "", "recipients": []}
    try:
        if not smtp_configured():
            raise RuntimeError("SMTP is not configured")
        to = await recipients()
        log["recipients"] = to
        if not to:
            raise RuntimeError("No team lead email addresses found")
        d = await build_digest(base_url)
        log["stats"] = d["stats"]
        await run_in_threadpool(send_email, to, d["subject"], d["html"], d["text"])
    except Exception as exc:
        logger.exception("digest failed")
        log.update(status="failed", error=str(exc)[:300])
    await db.digest_logs.insert_one(dict(log))
    return log


@digest_router.post("/cron/digest")
async def cron_digest(request: Request):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    secret = os.environ.get("WEBHOOK_CRON_SECRET", "")
    auth = request.headers.get("authorization", "")
    if not secret or not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:].encode(), secret.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid body")
    run_id = request.headers.get("x-webhook-id") or (body or {}).get("run_id")
    if not run_id:
        raise HTTPException(status_code=400, detail="Missing run id")
    res = await db.cron_runs.update_one({"run_id": run_id}, {"$setOnInsert": {"run_id": run_id, "job": "digest", "at": now()}}, upsert=True)
    if res.upserted_id is None:
        return {"status": "duplicate"}
    spawn(send_digest(_base_url(request), "schedule", run_id))
    return {"status": "accepted"}


@digest_router.get("/digest/preview")
async def digest_preview(request: Request, m: dict = Depends(require_role(*STAFF))):
    d = await build_digest(_base_url(request))
    return {**d, "recipients": await recipients(), "smtp_configured": smtp_configured(), "ldap_enabled": ldap_enabled(),
            "schedule": "Daily at 8:00 pm India time"}


@digest_router.post("/digest/send")
async def digest_send(request: Request, m: dict = Depends(require_role("admin"))):
    return await send_digest(_base_url(request), "manual")


@digest_router.get("/digest/logs")
async def digest_logs(m: dict = Depends(require_role(*STAFF))):
    return await db.digest_logs.find({}, {"_id": 0}).sort("at", -1).limit(20).to_list(20)
