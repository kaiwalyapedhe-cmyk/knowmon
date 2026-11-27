import logging
import os
from datetime import datetime, timedelta, timezone

from core import db, now

logger = logging.getLogger(__name__)

VOICE_FORM = {
    "id": "form-voice", "name": "Standard Voice QA", "description": "Default rubric for inbound support calls", "channel": "voice",
    "criteria": [
        {"id": "c-greet", "name": "Greeting & Opening", "description": "Greets, introduces self and company", "weight": 1, "type": "scale", "auto_fail": False},
        {"id": "c-verify", "name": "Identity Verification", "description": "Verifies customer identity before account details", "weight": 1.5, "type": "binary", "auto_fail": True},
        {"id": "c-empathy", "name": "Empathy & Tone", "description": "Acknowledges feelings, polite and calm tone", "weight": 1, "type": "scale", "auto_fail": False},
        {"id": "c-sop", "name": "SOP Adherence & Resolution", "description": "Follows the correct process and resolves the issue", "weight": 2, "type": "scale", "auto_fail": False},
        {"id": "c-disclose", "name": "Mandatory Disclosure", "description": "States call recording / terms disclosure", "weight": 1, "type": "binary", "auto_fail": True},
        {"id": "c-close", "name": "Closing", "description": "Summarises, checks for anything else, thanks customer", "weight": 1, "type": "scale", "auto_fail": False},
    ],
}
CHAT_FORM = {
    "id": "form-chat", "name": "Chat, Email & WhatsApp QA", "description": "Rubric for written channels", "channel": "chat",
    "criteria": [
        {"id": "w-resp", "name": "Response Quality", "description": "Clear, correct, well-structured", "weight": 2, "type": "scale", "auto_fail": False},
        {"id": "w-tone", "name": "Tone & Personalisation", "description": "Friendly, uses customer's name", "weight": 1, "type": "scale", "auto_fail": False},
        {"id": "w-kb", "name": "Knowledge Accuracy", "description": "Information matches the knowledge base", "weight": 2, "type": "scale", "auto_fail": False},
        {"id": "w-pii", "name": "Data Privacy", "description": "No sensitive data requested or exposed in writing", "weight": 1, "type": "binary", "auto_fail": True},
    ],
}
SM_FORM = {
    "id": "PID0053_001",
    "form_id": "PID0053_001",
    "name": "SM FORM",
    "process_name": "SM FORM",
    "description": "Transmon WyzMindz rubric for order-related disputes, delivery feedback and escalation management",
    "channel": "all",
    "criteria": [
        {"id": "q1-sop", "name": "Q1: SOP & Order Verification", "description": "Verification of order details, customer identity, ticket category and delivery timestamps", "weight": 2.0, "type": "scale", "auto_fail": False},
        {"id": "q2-res", "name": "Q2: Resolution & Policy Adherence", "description": "Accurate refund/replacement processing as per SOP with valid claim checks", "weight": 2.5, "type": "scale", "auto_fail": False},
        {"id": "q3-comm", "name": "Q3: Agent Empathy & Communication", "description": "Professional customer interactions, proper disposition, and clear timeline disclosures", "weight": 1.5, "type": "scale", "auto_fail": False},
        {"id": "c-ztp", "name": "Zero Tolerance Policy (ZTP)", "description": "Zero tolerance for unverified refunds, fraudulent claims or intentional policy breaches", "weight": 3.0, "type": "binary", "auto_fail": True},
        {"id": "c-fatal", "name": "Fatal Compliance Checklist", "description": "Mandatory security standards, PII protection and zero unauthorized actions", "weight": 3.0, "type": "binary", "auto_fail": True},
    ],
}

ARTICLES = [
    {"id": "kb-refund", "title": "Refund Policy & Processing", "category": "Refunds", "tags": ["refund", "return", "money back"],
     "summary": "Eligibility windows and how to raise a refund.",
     "content": "Customers can request a full refund within 30 days of purchase if the product is unused. Between 31-60 days a 15% restocking fee applies. After 60 days, offer store credit only. Refunds are returned to the original payment method within 5-7 business days.",
     "steps": [{"title": "Verify the customer", "body": "Confirm full name, registered phone and order ID.", "image_url": ""},
               {"title": "Check purchase date", "body": "Open the order in CRM and check days since delivery.", "image_url": ""},
               {"title": "Raise refund", "body": "Orders > Actions > Raise Refund. Choose reason code and confirm.", "image_url": ""},
               {"title": "Confirm timeline", "body": "Tell the customer the 5-7 business day timeline and share the ticket ID.", "image_url": ""}]},
    {"id": "kb-password", "title": "Reset a Customer Account Password", "category": "Technical Troubleshooting", "tags": ["password", "login", "locked"],
     "summary": "Visual guide to unlock and reset accounts.",
     "content": "Never ask the customer for their current password. Accounts lock after 5 failed attempts for 30 minutes. Agents can trigger a reset link which expires in 15 minutes.",
     "steps": [{"title": "Verify identity", "body": "Ask for registered email and last 4 digits of phone.", "image_url": "https://images.unsplash.com/photo-1555421689-491a97ff2040?w=800"},
               {"title": "Unlock the account", "body": "Admin console > Users > search email > Unlock.", "image_url": ""},
               {"title": "Send reset link", "body": "Click 'Send reset link'. Ask the customer to check spam folder.", "image_url": ""}]},
    {"id": "kb-billing", "title": "Billing Dispute SOP", "category": "Billing", "tags": ["billing", "charge", "dispute", "invoice"],
     "summary": "Handle double charges and incorrect invoices.",
     "content": "For duplicate charges, verify both transactions in the payment gateway. If confirmed duplicate, reverse the second charge immediately. For disputed amounts over $200, escalate to the billing team lead with ticket category 'BILL-ESC'.",
     "steps": [{"title": "Locate transactions", "body": "Payments > Search by order ID; compare timestamps.", "image_url": ""},
               {"title": "Reverse or escalate", "body": "Reverse duplicates under $200; escalate higher amounts.", "image_url": ""}]},
    {"id": "kb-disclosure", "title": "Call Recording & Compliance Disclosure", "category": "Compliance SOPs", "tags": ["compliance", "disclosure", "recording", "gdpr"],
     "summary": "Mandatory statements on every call.",
     "content": "Every inbound and outbound call must include: 'This call may be recorded for quality and training purposes.' within the first 30 seconds. Never read full card numbers aloud. Missing the disclosure is an automatic QA fail.",
     "steps": []},
]
_today = datetime.now(timezone.utc)
for a in ARTICLES:
    a.update({"self_service": a["id"] != "kb-disclosure", "views": 0, "created_by": "system", "created_at": now(),
              "updated_at": now(), "status": "published", "version": 1, "owner_id": "system", "owner_name": "System",
              "reviewer_id": "", "reviewer_name": "", "approver_id": "system", "approver_name": "System",
              "review_date": (_today + timedelta(days=90)).date().isoformat(),
              "expires_at": (_today + timedelta(days=365)).date().isoformat(), "allowed_roles": [],
              "published_at": now(), "archived_at": "", "helpful_count": 0, "not_helpful_count": 0})

TREE = {
    "id": "tree-refund", "title": "Refund Request Handling", "description": "Guided flow for refund calls and chats", "category": "Refunds",
    "start_node": "n1", "runs": 0, "created_by": "system",
    "nodes": [
        {"id": "n1", "title": "Verify customer", "text": "Has the customer passed identity verification?", "script": "Before I look into this, may I confirm your full name and order ID?",
         "options": [{"label": "Verified", "next": "n2"}, {"label": "Cannot verify", "next": "n6"}]},
        {"id": "n2", "title": "Check purchase age", "text": "How many days since delivery?", "script": "",
         "options": [{"label": "0-30 days", "next": "n3"}, {"label": "31-60 days", "next": "n4"}, {"label": "Over 60 days", "next": "n5"}]},
        {"id": "n3", "title": "Full refund", "text": "Raise a full refund to the original payment method.", "script": "I've raised a full refund; you'll see it in 5-7 business days.", "options": []},
        {"id": "n4", "title": "Refund with restocking fee", "text": "Explain the 15% restocking fee and raise the refund if accepted.", "script": "Since it's past 30 days, a 15% restocking fee applies. Shall I proceed?", "options": []},
        {"id": "n5", "title": "Offer store credit", "text": "Refund window has passed; offer store credit.", "script": "I can offer you store credit for the full value instead.", "options": []},
        {"id": "n6", "title": "Stop - security", "text": "Do not discuss account details. Ask the customer to call back with order details.", "script": "For your security I can't access the order without verification.", "options": []},
    ],
}

COURSE = {
    "id": "course-onboarding", "title": "New Hire Onboarding: Refunds & Compliance", "category": "Onboarding",
    "description": "Core policies every new agent must know in week one.", "pass_mark": 70, "created_by": "system",
    "lessons": [
        {"title": "Refund windows", "content": "0-30 days: full refund. 31-60 days: 15% restocking fee. Over 60 days: store credit only. Refunds take 5-7 business days.", "article_id": "kb-refund"},
        {"title": "Compliance essentials", "content": "Say the recording disclosure within 30 seconds. Always verify identity before discussing an account. Never read card numbers aloud.", "article_id": "kb-disclosure"},
    ],
    "quiz": [
        {"question": "A customer bought an item 45 days ago. What applies?", "options": ["Full refund", "15% restocking fee", "Store credit only", "No refund"], "answer_index": 1, "explanation": "31-60 days carries a 15% restocking fee."},
        {"question": "When must the recording disclosure be said?", "options": ["At the end", "Within the first 30 seconds", "Only if asked", "Never on outbound"], "answer_index": 1, "explanation": "It is mandatory within the first 30 seconds."},
        {"question": "What must happen before discussing account details?", "options": ["Identity verification", "Supervisor approval", "Email confirmation", "Nothing"], "answer_index": 0, "explanation": "Verification is an auto-fail criterion."},
        {"question": "How long do refunds take to arrive?", "options": ["Same day", "24 hours", "5-7 business days", "30 days"], "answer_index": 2, "explanation": "Refunds return to the original method in 5-7 business days."},
    ],
}


def _sample(idx, agent, channel, form, score, sentiment, csat, flags, summary, days_ago, auto_failed=False):
    form_doc = VOICE_FORM if form == "form-voice" else CHAT_FORM
    crit = [{"id": c["id"], "name": c["name"], "weight": c["weight"], "type": c["type"], "auto_fail": c["auto_fail"],
             "score": (0 if auto_failed and c["auto_fail"] and i == 1 else min(100, score + (i % 3) * 4 - 4)),
             "passed": not (auto_failed and c["auto_fail"] and i == 1), "reason": "Sample evaluation"} for i, c in enumerate(form_doc["criteria"])]
    return {"id": f"sample-{idx}", "channel": channel, "agent_id": "", "agent_name": agent, "customer_name": f"Customer {idx}",
            "form_id": form, "form_name": form_doc["name"], "form_version": 1, "source": "sample", "status": "scored",
            "transcript": "Agent: Thank you for calling, this call may be recorded. How can I help?\nCustomer: I want a refund for my order.\nAgent: Sure, let me verify your details first...",
            "criteria_results": crit, "overall_score": 0 if auto_failed else score, "auto_failed": auto_failed, "sentiment": sentiment,
            "sentiment_score": {"positive": 0.6, "neutral": 0, "negative": -0.5}[sentiment], "csat_predicted": csat,
            "customer_intent": "Refund request", "summary": summary, "compliance_flags": flags,
            "strengths": ["Polite tone"], "improvements": ["Confirm the refund timeline before closing"], "recommended_article_ids": ["kb-refund"],
            "created_by": "system", "created_at": (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat(), "scored_at": now()}


SAMPLES = [
    _sample(1, "Priya Sharma", "voice", "form-voice", 92, "positive", 5, [], "Smooth refund call, fully compliant.", 6),
    _sample(2, "Rahul Verma", "voice", "form-voice", 64, "negative", 2, [{"issue": "Skipped identity verification", "severity": "high", "quote": "Okay, I see your order here"}], "Agent accessed order before verification.", 4, True),
    _sample(3, "Priya Sharma", "chat", "form-chat", 85, "neutral", 4, [], "Password reset handled via chat.", 3),
    _sample(4, "Anita Desai", "whatsapp", "form-chat", 78, "positive", 4, [], "Billing query resolved on WhatsApp.", 2),
    _sample(5, "Rahul Verma", "email", "form-chat", 71, "neutral", 3, [{"issue": "Requested card number by email", "severity": "medium", "quote": "please share your card details"}], "Billing dispute email, privacy risk.", 1),
]


async def seed():
    if await db.qa_forms.count_documents({}) == 0:
        await db.qa_forms.insert_many([{**f, "version": 1, "created_by": "system", "created_at": now(), "updated_at": now()}
                                      for f in (VOICE_FORM, CHAT_FORM, SM_FORM)])
    else:
        sm_exists = await db.qa_forms.find_one({"$or": [{"id": "PID0053_001"}, {"name": "SM FORM"}]})
        if not sm_exists:
            await db.qa_forms.insert_one({
                **SM_FORM,
                "version": 1,
                "created_by": "system",
                "created_at": now(),
                "updated_at": now()
            })
    await db.qa_forms.update_many({"version": {"$exists": False}},
                                  {"$set": {"version": 1, "updated_at": now()}})
    if await db.qa_sampling_policies.count_documents({}) == 0:
        await db.qa_sampling_policies.insert_one({
            "id": "policy-monthly-coverage", "name": "Monthly agent coverage", "channel": "all", "form_id": "",
            "period": "monthly", "target_per_agent": 4, "sample_percent": 20.0, "sla_days": 3,
            "include_flagged": True, "include_auto_fail": True, "active": True,
            "created_by": "system", "created_by_name": "System", "created_at": now()})
    if await db.articles.count_documents({}) == 0:
        await db.articles.insert_many([dict(a) for a in ARTICLES])
    await db.articles.update_many({"status": {"$exists": False}}, {"$set": {
        "status": "published", "version": 1, "owner_id": "system", "owner_name": "System", "reviewer_id": "",
        "reviewer_name": "", "approver_id": "system", "approver_name": "System", "allowed_roles": [],
        "published_at": now(), "archived_at": "", "helpful_count": 0, "not_helpful_count": 0,
        "review_date": (_today + timedelta(days=90)).date().isoformat(),
        "expires_at": (_today + timedelta(days=365)).date().isoformat()}})
    if await db.trees.count_documents({}) == 0:
        await db.trees.insert_one({**TREE, "created_at": now()})
    if await db.courses.count_documents({}) == 0:
        await db.courses.insert_one({**COURSE, "created_at": now()})
    if await db.interactions.count_documents({}) == 0:
        await db.interactions.insert_many([dict(s) for s in SAMPLES])

    try:
        from auth_utils import hash_password
    except ModuleNotFoundError:
        from backend.auth_utils import hash_password

    admin_emails = ["admin@jsw.in", "admin@jswshakti.in", "jsf0015@jswshakti.in", "kaiwalya.pedhe@jswshakti.in"]
    default_pw_hash = hash_password("Lotus1@34")

    for email in admin_emails:
        u = await db.users.find_one({"email": email})
        if not u:
            await db.users.insert_one({
                "user_id": f"u_{email.split('@')[0]}",
                "name": email.split("@")[0].replace(".", " ").title(),
                "email": email,
                "role": "admin",
                "password_hash": default_pw_hash,
                "created_at": now(),
            })
        elif not u.get("password_hash"):
            await db.users.update_one({"email": email}, {"$set": {"password_hash": default_pw_hash}})

    # Seed Transmon audit records
    if await db.transmon_audits.count_documents({}) == 0:
        csv_path = os.path.join(os.path.dirname(__file__), "transmon_sample.csv")
        if os.path.exists(csv_path):
            import csv
            try:
                from transmon_router import _parse_row
            except ImportError:
                from backend.transmon_router import _parse_row
            with open(csv_path, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                transmon_docs = [_parse_row(row) for row in reader if any(v.strip() for v in row.values() if v)]
                if transmon_docs:
                    await db.transmon_audits.insert_many(transmon_docs)
                    logger.info("Seeded %d Transmon audit records into col_transmon_audits.", len(transmon_docs))

    # Seed initial sampling process matching AutoSampling.aspx
    if await db.transmon_sampling.count_documents({}) == 0:
        await db.transmon_sampling.insert_one({
            "id": "samp-seed001",
            "process_name": "SM FORM",
            "sample_count": 10,
            "actual_generated": 10,
            "from_date": "2026-11-01",
            "to_date": "2026-11-26",
            "previous_sampling": True,
            "audit_type": "Normal",
            "year": "2026",
            "month": "November",
            "week": "Week 4",
            "sampling_to": "cd-himanshu.pathak@zepto.com",
            "status": "Saved",
            "sample_ids": [
                "PID0053_001-17033", "PID0053_001-17035", "PID0053_001-17038", "PID0053_001-17061",
                "PID0053_001-17062", "PID0053_001-17063", "PID0053_001-17078", "PID0053_001-17068",
                "PID0053_001-17069", "PID0053_001-17070"
            ],
            "created_by": "system",
            "created_by_name": "System",
            "saved_by": "system",
            "saved_by_name": "System",
            "saved_at": now(),
            "created_at": now()
        })
