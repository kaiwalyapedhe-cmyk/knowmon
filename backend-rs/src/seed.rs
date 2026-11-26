use crate::db;
use crate::util::*;
use crate::util::{Document, Value, json, as_doc};

fn voice_form() -> Document {
    as_doc(json!( {
        "id": "form-voice", "name": "Standard Voice QA", "description": "Default rubric for inbound support calls",
        "channel": "voice",
        "criteria": [
            { "id": "c-greet", "name": "Greeting & Opening", "description": "Greets, introduces self and company", "weight": 1.0, "type": "scale", "auto_fail": false },
            { "id": "c-verify", "name": "Identity Verification", "description": "Verifies customer identity before account details", "weight": 1.5, "type": "binary", "auto_fail": true },
            { "id": "c-empathy", "name": "Empathy & Tone", "description": "Acknowledges feelings, polite and calm tone", "weight": 1.0, "type": "scale", "auto_fail": false },
            { "id": "c-sop", "name": "SOP Adherence & Resolution", "description": "Follows the correct process and resolves the issue", "weight": 2.0, "type": "scale", "auto_fail": false },
            { "id": "c-disclose", "name": "Mandatory Disclosure", "description": "States call recording / terms disclosure", "weight": 1.0, "type": "binary", "auto_fail": true },
            { "id": "c-close", "name": "Closing", "description": "Summarises, checks for anything else, thanks customer", "weight": 1.0, "type": "scale", "auto_fail": false }
        ]
    }))
}

fn chat_form() -> Document {
    as_doc(json!( {
        "id": "form-chat", "name": "Chat, Email & WhatsApp QA", "description": "Rubric for written channels",
        "channel": "chat",
        "criteria": [
            { "id": "w-resp", "name": "Response Quality", "description": "Clear, correct, well-structured", "weight": 2.0, "type": "scale", "auto_fail": false },
            { "id": "w-tone", "name": "Tone & Personalisation", "description": "Friendly, uses customer's name", "weight": 1.0, "type": "scale", "auto_fail": false },
            { "id": "w-kb", "name": "Knowledge Accuracy", "description": "Information matches the knowledge base", "weight": 2.0, "type": "scale", "auto_fail": false },
            { "id": "w-pii", "name": "Data Privacy", "description": "No sensitive data requested or exposed in writing", "weight": 1.0, "type": "binary", "auto_fail": true }
        ]
    }))
}

fn articles(review_date: &str, expires_at: &str) -> Vec<Document> {
    let base = |id: &str, title: &str, category: &str, tags: Vec<&str>, summary: &str, content: &str, steps: Vec<Document>| {
        as_doc(json!( {
            "id": id, "title": title, "category": category,
            "tags": tags.iter().map(|t| Value::String(t.to_string())).collect::<Vec<_>>(),
            "summary": summary, "content": content, "steps": steps,
            "self_service": id != "kb-disclosure", "views": 0i32, "created_by": "system",
            "created_at": now(), "updated_at": now(), "status": "published", "version": 1i32,
            "owner_id": "system", "owner_name": "System", "reviewer_id": "", "reviewer_name": "",
            "approver_id": "system", "approver_name": "System",
            "review_date": review_date, "expires_at": expires_at, "allowed_roles": Vec::<Value>::new(),
            "published_at": now(), "archived_at": "", "helpful_count": 0i32, "not_helpful_count": 0i32,
        }))
    };
    vec![
        base(
            "kb-refund",
            "Refund Policy & Processing",
            "Refunds",
            vec!["refund", "return", "money back"],
            "Eligibility windows and how to raise a refund.",
            "Customers can request a full refund within 30 days of purchase if the product is unused. Between 31-60 days a 15% restocking fee applies. After 60 days, offer store credit only. Refunds are returned to the original payment method within 5-7 business days.",
            vec![
                as_doc(json!( { "title": "Verify the customer", "body": "Confirm full name, registered phone and order ID.", "image_url": "" })),
                as_doc(json!( { "title": "Check purchase date", "body": "Open the order in CRM and check days since delivery.", "image_url": "" })),
                as_doc(json!( { "title": "Raise refund", "body": "Orders > Actions > Raise Refund. Choose reason code and confirm.", "image_url": "" })),
                as_doc(json!( { "title": "Confirm timeline", "body": "Tell the customer the 5-7 business day timeline and share the ticket ID.", "image_url": "" })),
            ],
        ),
        base(
            "kb-password",
            "Reset a Customer Account Password",
            "Technical Troubleshooting",
            vec!["password", "login", "locked"],
            "Visual guide to unlock and reset accounts.",
            "Never ask the customer for their current password. Accounts lock after 5 failed attempts for 30 minutes. Agents can trigger a reset link which expires in 15 minutes.",
            vec![
                as_doc(json!( { "title": "Verify identity", "body": "Ask for registered email and last 4 digits of phone.", "image_url": "https://images.unsplash.com/photo-1555421689-491a97ff2040?w=800" })),
                as_doc(json!( { "title": "Unlock the account", "body": "Admin console > Users > search email > Unlock.", "image_url": "" })),
                as_doc(json!( { "title": "Send reset link", "body": "Click 'Send reset link'. Ask the customer to check spam folder.", "image_url": "" })),
            ],
        ),
        base(
            "kb-billing",
            "Billing Dispute SOP",
            "Billing",
            vec!["billing", "charge", "dispute", "invoice"],
            "Handle double charges and incorrect invoices.",
            "For duplicate charges, verify both transactions in the payment gateway. If confirmed duplicate, reverse the second charge immediately. For disputed amounts over $200, escalate to the billing team lead with ticket category 'BILL-ESC'.",
            vec![
                as_doc(json!( { "title": "Locate transactions", "body": "Payments > Search by order ID; compare timestamps.", "image_url": "" })),
                as_doc(json!( { "title": "Reverse or escalate", "body": "Reverse duplicates under $200; escalate higher amounts.", "image_url": "" })),
            ],
        ),
        base(
            "kb-disclosure",
            "Call Recording & Compliance Disclosure",
            "Compliance SOPs",
            vec!["compliance", "disclosure", "recording", "gdpr"],
            "Mandatory statements on every call.",
            "Every inbound and outbound call must include: 'This call may be recorded for quality and training purposes.' within the first 30 seconds. Never read full card numbers aloud. Missing the disclosure is an automatic QA fail.",
            vec![],
        ),
    ]
}

fn refund_tree() -> Document {
    as_doc(json!( {
        "id": "tree-refund", "title": "Refund Request Handling", "description": "Guided flow for refund calls and chats",
        "category": "Refunds", "start_node": "n1", "runs": 0i32, "created_by": "system",
        "created_at": now(),
        "nodes": [
            { "id": "n1", "title": "Verify customer", "text": "Has the customer passed identity verification?",
              "script": "Before I look into this, may I confirm your full name and order ID?",
              "options": [ { "label": "Verified", "next": "n2" }, { "label": "Cannot verify", "next": "n6" } ] },
            { "id": "n2", "title": "Check purchase age", "text": "How many days since delivery?", "script": "",
              "options": [ { "label": "0-30 days", "next": "n3" }, { "label": "31-60 days", "next": "n4" }, { "label": "Over 60 days", "next": "n5" } ] },
            { "id": "n3", "title": "Full refund", "text": "Raise a full refund to the original payment method.",
              "script": "I've raised a full refund; you'll see it in 5-7 business days.", "options": [] },
            { "id": "n4", "title": "Refund with restocking fee", "text": "Explain the 15% restocking fee and raise the refund if accepted.",
              "script": "Since it's past 30 days, a 15% restocking fee applies. Shall I proceed?", "options": [] },
            { "id": "n5", "title": "Offer store credit", "text": "Refund window has passed; offer store credit.",
              "script": "I can offer you store credit for the full value instead.", "options": [] },
            { "id": "n6", "title": "Stop - security", "text": "Do not discuss account details. Ask the customer to call back with order details.",
              "script": "For your security I can't access the order without verification.", "options": [] }
        ]
    }))
}

fn onboarding_course() -> Document {
    as_doc(json!( {
        "id": "course-onboarding", "title": "New Hire Onboarding: Refunds & Compliance", "category": "Onboarding",
        "description": "Core policies every new agent must know in week one.", "pass_mark": 70i32, "created_by": "system",
        "created_at": now(),
        "lessons": [
            { "title": "Refund windows", "content": "0-30 days: full refund. 31-60 days: 15% restocking fee. Over 60 days: store credit only. Refunds take 5-7 business days.", "article_id": "kb-refund" },
            { "title": "Compliance essentials", "content": "Say the recording disclosure within 30 seconds. Always verify identity before discussing an account. Never read card numbers aloud.", "article_id": "kb-disclosure" }
        ],
        "quiz": [
            { "question": "A customer bought an item 45 days ago. What applies?", "options": ["Full refund", "15% restocking fee", "Store credit only", "No refund"], "answer_index": 1i64, "explanation": "31-60 days carries a 15% restocking fee." },
            { "question": "When must the recording disclosure be said?", "options": ["At the end", "Within the first 30 seconds", "Only if asked", "Never on outbound"], "answer_index": 1i64, "explanation": "It is mandatory within the first 30 seconds." },
            { "question": "What must happen before discussing account details?", "options": ["Identity verification", "Supervisor approval", "Email confirmation", "Nothing"], "answer_index": 0i64, "explanation": "Verification is an auto-fail criterion." },
            { "question": "How long do refunds take to arrive?", "options": ["Same day", "24 hours", "5-7 business days", "30 days"], "answer_index": 2i64, "explanation": "Refunds return to the original method in 5-7 business days." }
        ]
    }))
}

#[allow(clippy::too_many_arguments)]
fn sample(
    idx: i32,
    agent: &str,
    channel: &str,
    form: &Document,
    score: f64,
    sentiment: &str,
    csat: i32,
    flags: Vec<Document>,
    summary: &str,
    days_ago: i64,
    auto_failed: bool,
) -> Document {
    let criteria = doc_array(form, "criteria");
    let mut crit_results = Vec::new();
    for (i, c) in criteria.iter().enumerate() {
        let c = c.as_object().cloned().unwrap_or_default();
        let is_auto = doc_bool(&c, "auto_fail");
        let weight = doc_f64(&c, "weight");
        let failed_here = auto_failed && is_auto && i == 1;
        crit_results.push(as_doc(json!( {
            "id": doc_str(&c, "id"),
            "name": doc_str(&c, "name"),
            "weight": weight,
            "type": c.get("type").cloned().unwrap_or_else(|| Value::String("scale".into())),
            "auto_fail": is_auto,
            "score": if failed_here { 0.0 } else { (score + (i as f64 % 3.0) * 4.0 - 4.0).min(100.0) },
            "passed": !failed_here,
            "reason": "Sample evaluation",
        })));
    }
    let created = (chrono::Utc::now() - chrono::Duration::days(days_ago))
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, false);
    as_doc(json!( {
        "id": format!("sample-{idx}"), "channel": channel, "agent_id": "", "agent_name": agent,
        "customer_name": format!("Customer {idx}"), "form_id": doc_str(form, "id"),
        "form_name": doc_str(form, "name"), "form_version": 1i32, "source": "sample", "status": "scored",
        "transcript": "Agent: Thank you for calling, this call may be recorded. How can I help?\nCustomer: I want a refund for my order.\nAgent: Sure, let me verify your details first...",
        "criteria_results": crit_results,
        "overall_score": if auto_failed { 0.0 } else { score },
        "auto_failed": auto_failed,
        "sentiment": sentiment,
        "sentiment_score": match sentiment { "positive" => 0.6, "negative" => -0.5, _ => 0.0 },
        "csat_predicted": csat,
        "customer_intent": "Refund request",
        "summary": summary,
        "compliance_flags": flags,
        "strengths": ["Polite tone"],
        "improvements": ["Confirm the refund timeline before closing"],
        "recommended_article_ids": ["kb-refund"],
        "created_by": "system", "created_at": created, "scored_at": now(),
    }))
}

fn samples() -> Vec<Document> {
    let v = voice_form();
    let c = chat_form();
    vec![
        sample(1, "Priya Sharma", "voice", &v, 92.0, "positive", 5, vec![], "Smooth refund call, fully compliant.", 6, false),
        sample(2, "Rahul Verma", "voice", &v, 64.0, "negative", 2,
               vec![as_doc(json!( { "issue": "Skipped identity verification", "severity": "high", "quote": "Okay, I see your order here" }))],
               "Agent accessed order before verification.", 4, true),
        sample(3, "Priya Sharma", "chat", &c, 85.0, "neutral", 4, vec![], "Password reset handled via chat.", 3, false),
        sample(4, "Anita Desai", "whatsapp", &c, 78.0, "positive", 4, vec![], "Billing query resolved on WhatsApp.", 2, false),
        sample(5, "Rahul Verma", "email", &c, 71.0, "neutral", 3,
               vec![as_doc(json!( { "issue": "Requested card number by email", "severity": "medium", "quote": "please share your card details" }))],
               "Billing dispute email, privacy risk.", 1, false),
    ]
}

pub async fn seed(db: &crate::db::Db) -> crate::error::ApiResult<()> {
    let review_date = date_in_days(90);
    let expires_at = date_in_days(365);

    if db::count(db, "qa_forms", Document::new()).await? == 0 {
        let mut forms = vec![voice_form(), chat_form()];
        for f in forms.iter_mut() {
            f.insert("version".to_string(), 1i32);
            f.insert("created_by".to_string(), "system");
            f.insert("created_at".to_string(), now());
            f.insert("updated_at".to_string(), now());
        }
        db::insert_many(db, "qa_forms", forms).await?;
    }
    db::update_many(
        db,
        "qa_forms",
        as_doc(json!( { "version": { "$exists": false } })),
        as_doc(json!( { "$set": { "version": 1i32, "updated_at": now() } })),
    )
    .await?;

    if db::count(db, "qa_sampling_policies", Document::new()).await? == 0 {
        db::insert(
            db,
            "qa_sampling_policies",
            as_doc(json!( {
                "id": "policy-monthly-coverage", "name": "Monthly agent coverage", "channel": "all", "form_id": "",
                "period": "monthly", "target_per_agent": 4i64, "sample_percent": 20.0, "sla_days": 3i64,
                "include_flagged": true, "include_auto_fail": true, "active": true,
                "created_by": "system", "created_by_name": "System", "created_at": now()
            })),
        )
        .await?;
    }

    if db::count(db, "articles", Document::new()).await? == 0 {
        db::insert_many(db, "articles", articles(&review_date, &expires_at)).await?;
    }
    db::update_many(
        db,
        "articles",
        as_doc(json!( { "status": { "$exists": false } })),
        as_doc(json!( { "$set": {
            "status": "published", "version": 1i32, "owner_id": "system", "owner_name": "System",
            "reviewer_id": "", "reviewer_name": "", "approver_id": "system", "approver_name": "System",
            "allowed_roles": Vec::<Value>::new(), "published_at": now(), "archived_at": "",
            "helpful_count": 0i32, "not_helpful_count": 0i32,
            "review_date": &review_date, "expires_at": &expires_at
        } })),
    )
    .await?;

    if db::count(db, "trees", Document::new()).await? == 0 {
        db::insert(db, "trees", refund_tree()).await?;
    }
    if db::count(db, "courses", Document::new()).await? == 0 {
        db::insert(db, "courses", onboarding_course()).await?;
    }
    if db::count(db, "interactions", Document::new()).await? == 0 {
        db::insert_many(db, "interactions", samples()).await?;
    }
    Ok(())
}
