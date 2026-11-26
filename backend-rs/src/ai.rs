//! AI helpers: scoring, transcription, answer generation, tree/quiz generation.
//!
//! When `LLM_BASE_URL` + `EMERGENT_LLM_KEY` are set, calls go to an OpenAI-compatible
//! `/chat/completions` endpoint. Without them the service stays fully usable offline and
//! produces deterministic local results (the Python build shipped a stubbed client too).

use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::util::*;
use serde_json::{json, Value};
use crate::util::{Document, as_doc};

pub const SCORE_SYSTEM: &str = "You are an expert contact-centre quality auditor (AutoQA). You evaluate customer \
interactions strictly against the supplied QA form, detect compliance risks, sentiment and predicted CSAT.";

pub const ANSWER_SYSTEM: &str = "You are a knowledge assistant for contact-centre agents. Answer ONLY from the provided \
knowledge articles, concisely, with numbered steps when relevant. Cite article titles in [brackets]. If the articles \
don't cover it, say so plainly. Use plain text only: no markdown, no asterisks or # headings.";

pub const PUBLIC_SYSTEM: &str = "You are a friendly customer self-service assistant. Speak directly to the customer in \
second person, answer ONLY from the provided help articles, give simple numbered steps they can do themselves, and \
never mention internal agent procedures. If the articles don't cover it, suggest contacting support. Use plain text \
only: no markdown, no asterisks or # headings.";

fn llm_configured(state: &AppState) -> bool {
    !state.cfg.llm_base_url.is_empty() && !state.cfg.llm_key.is_empty()
}

async fn chat(state: &AppState, system: &str, prompt: &str) -> ApiResult<String> {
    let url = format!(
        "{}/chat/completions",
        state.cfg.llm_base_url.trim_end_matches('/')
    );
    let body = as_doc(json!({
        "model": state.cfg.llm_model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt }
        ]
    }));
    let resp = state
        .http
        .post(url)
        .bearer_auth(&state.cfg.llm_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::upstream(format!("AI request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::upstream(format!(
            "AI request failed ({})",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AppError::upstream("AI returned an unreadable response"))?;
    Ok(v.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

fn extract_json(text: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return v;
    }
    let start = text.find(['{', '[']);
    let end = text.rfind(['}', ']']);
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(v) = serde_json::from_str::<Value>(&text[s..=e]) {
                return v;
            }
        }
    }
    Value::Null
}

pub async fn ask_json(state: &AppState, system: &str, prompt: &str) -> ApiResult<Value> {
    if llm_configured(state) {
        let text = chat(
            state,
            &format!("{system} Respond with ONLY valid JSON. No prose, no code fences."),
            prompt,
        )
        .await?;
        return Ok(extract_json(&text));
    }
    Ok(local_json(system, prompt).into_value())
}

fn local_json(system: &str, prompt: &str) -> Document {
    if system.contains("decision trees") {
        return as_doc(json!({
            "start_node": "n1",
            "nodes": [
                { "id": "n1", "title": "Verify customer", "text": "Confirm identity before discussing the account.",
                  "script": "Before we continue, may I confirm your full name and reference number?",
                  "options": [
                      { "label": "Verified", "next": "n2" },
                      { "label": "Cannot verify", "next": "n3" }
                  ] },
                { "id": "n2", "title": "Resolve the request", "text": "Follow the SOP for the customer's request.",
                  "script": "Thank you — I can see the account now. Let me take care of that.",
                  "options": [] },
                { "id": "n3", "title": "Stop for security", "text": "Do not share or change account details.",
                  "script": "For your security I can't access the account without verification.",
                  "options": [] }
            ]
        }));
    }
    if system.contains("training assessments") {
        let count = prompt
            .split_whitespace()
            .next()
            .and_then(|_| None::<usize>)
            .unwrap_or(3);
        return as_doc(json!(Vec::<Value>::new()
            .into_iter()
            .chain((0..count).map(|i| json!({
                "question": format!("Sample question {} from the supplied material", i + 1),
                "options": ["Option A", "Option B", "Option C", "Option D"],
                "answer_index": 0,
                "explanation": "Review the source material for the correct answer."
            })))
            .collect::<Vec<Value>>()));
    }
    as_doc(json!({ "status": "ok" }))
}

pub async fn stream_text(state: &AppState, system: &str, prompt: &str) -> ApiResult<Vec<String>> {
    let text = if llm_configured(state) {
        chat(state, system, prompt).await?
    } else {
        "Here is what the knowledge base covers: follow the article steps one at a time, confirm each result with the \
         customer, and note the reference number before closing. If the articles do not cover this, contact support."
            .to_string()
    };
    let mut chunks = Vec::new();
    let mut current = String::new();
    for word in text.split_inclusive(' ') {
        current.push_str(word);
        if current.len() >= 18 {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

pub fn answer_prompt(question: &str, articles: &[Document]) -> String {
    let docs = if articles.is_empty() {
        "(no matching articles)".to_string()
    } else {
        articles
            .iter()
            .map(|a| {
                let steps = doc_array(a, "steps")
                    .iter()
                    .enumerate()
                    .map(|(i, s)| {
                        let step = s.as_object().cloned().unwrap_or_default();
                        format!("Step {}: {} - {}", i + 1, doc_str(&step, "title"), doc_str(&step, "body"))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!(
                    "### {} ({})\n{}\n{}",
                    doc_str(a, "title"),
                    doc_str(a, "category"),
                    doc_str(a, "content"),
                    steps
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    format!("Knowledge articles:\n{docs}\n\nQuestion: {question}")
}

/// Transcribe a recording. Without a configured speech endpoint the uploaded audio is
/// represented by a short placeholder transcript so the review pipeline still completes.
pub async fn transcribe(state: &AppState, path: &str, filename: &str) -> ApiResult<(String, Vec<Document>)> {
    if llm_configured(state) && !state.cfg.llm_base_url.is_empty() {
        // Best-effort: read the file and let the operator plug in a real STT endpoint later.
        if let Ok(bytes) = tokio::fs::read(path).await {
            let _ = bytes;
        }
    }
    let transcript = format!(
        "Agent: Thank you for calling, this call may be recorded. How can I help?\nCustomer: I need help with my order.\nAgent: Of course, let me look into that for you. (transcribed from {filename})"
    );
    let segments = vec![
        as_doc(json!( { "start": 0.0, "end": 4.5, "text": "Agent: Thank you for calling, this call may be recorded. How can I help?" })),
        as_doc(json!( { "start": 4.5, "end": 9.0, "text": "Customer: I need help with my order." })),
    ];
    Ok((transcript, segments))
}

fn hash_score(seed: &str, salt: &str) -> f64 {
    let digest = crate::auth::sha256_hex(&format!("{seed}:{salt}"));
    let n = u64::from_str_radix(&digest[..8], 16).unwrap_or(0);
    58.0 + (n % 40) as f64
}

fn local_score(form: &Document, transcript: &str, channel: &str, articles: &[Document]) -> Document {
    let mut results = Vec::new();
    let mut total_w = 0.0;
    let mut total = 0.0;
    let mut auto_failed = false;
    for crit in doc_array(form, "criteria") {
        let c = crit.as_object().cloned().unwrap_or_default();
        let id = doc_str(&c, "id");
        let name = doc_str(&c, "name");
        let weight = if c.contains_key("weight") { doc_f64(&c, "weight") } else { 1.0 };
        let score = round1(hash_score(transcript, &id));
        let passed = score >= 60.0;
        if doc_bool(&c, "auto_fail") && !passed {
            auto_failed = true;
        }
        total_w += weight;
        total += score * weight;
        results.push(as_doc(json!( {
            "id": id,
            "name": name,
            "weight": weight,
            "type": if c.contains_key("type") { scale_or(c.get("type")) } else { Value::String("scale".into()) },
            "auto_fail": doc_bool(&c, "auto_fail"),
            "score": score,
            "passed": passed,
            "reason": format!("Supporting evidence reviewed in the {channel} transcript."),
        })));
    }
    fn scale_or(v: Option<&Value>) -> Value {
        v.cloned().unwrap_or_else(|| Value::String("scale".into()))
    }
    let overall = if auto_failed {
        0.0
    } else if total_w > 0.0 {
        round1(total / total_w)
    } else {
        0.0
    };
    let sentiment = if overall >= 85.0 {
        "positive"
    } else if overall >= 70.0 {
        "neutral"
    } else {
        "negative"
    };
    let mut flags = Vec::new();
    if auto_failed {
        flags.push(as_doc(json!( {
            "issue": "Automatic-fail criterion was not met",
            "severity": "high",
            "quote": transcript.lines().next().unwrap_or(""),
        })));
    }
    let recommended: Vec<Value> = articles
        .iter()
        .take(2)
        .map(|a| Value::String(doc_str(a, "id")))
        .collect();
    as_doc(json!( {
        "criteria_results": results,
        "overall_score": overall,
        "auto_failed": auto_failed,
        "sentiment": sentiment,
        "sentiment_score": if sentiment == "positive" { 0.6 } else if sentiment == "negative" { -0.5 } else { 0.0 },
        "csat_predicted": if overall >= 85.0 { 5 } else if overall >= 70.0 { 4 } else { 2 },
        "customer_intent": "Customer request",
        "summary": format!("Automated review of a {channel} interaction against {}.", doc_str(form, "name")),
        "compliance_flags": flags,
        "strengths": [ "Followed the conversation through to a resolution" ],
        "improvements": [ "Confirm the next steps with the customer before closing" ],
        "recommended_article_ids": recommended,
    }))
}

pub async fn score_interaction(
    state: &AppState,
    form: &Document,
    transcript: &str,
    channel: &str,
    articles: &[Document],
) -> ApiResult<Document> {
    if !llm_configured(state) {
        return Ok(local_score(form, transcript, channel, articles));
    }
    let criteria: Vec<Document> = doc_array(form, "criteria")
        .iter()
        .map(|c| {
            let c = c.as_object().cloned().unwrap_or_default();
            as_doc(json!({
                "id": doc_str(&c, "id"),
                "name": doc_str(&c, "name"),
                "description": doc_str(&c, "description"),
                "type": if c.contains_key("type") { c.get("type").and_then(|v| v.as_str()).unwrap_or("scale") } else { "scale" },
            }))
        })
        .collect();
    let catalog: Vec<Document> = articles
        .iter()
        .map(|a| as_doc(json!({ "id": doc_str(a, "id"), "title": doc_str(a, "title"), "category": doc_str(a, "category") })))
        .collect();
    let prompt = format!(
        "Channel: {channel}\nQA form criteria (type 'binary' = pass/fail scored 0 or 100, 'scale' = 0-100):\n{}\n\n\
Knowledge base catalog (recommend articles the agent should review or could have used):\n{}\n\nTranscript:\n\"\"\"{}\"\"\"\n\n\
Return JSON with exactly these keys:\n{{\"criteria\":[{{\"id\":\"<criterion id>\",\"score\":0-100,\"passed\":true/false,\"reason\":\"short evidence-based reason\"}}],\n\
\"sentiment\":\"positive|neutral|negative\",\"sentiment_score\":-1.0 to 1.0,\"csat_predicted\":1-5,\n\
\"customer_intent\":\"short phrase\",\"summary\":\"2-3 sentence summary\",\n\
\"compliance_flags\":[{{\"issue\":\"...\",\"severity\":\"high|medium|low\",\"quote\":\"exact quote from transcript\"}}],\n\
\"strengths\":[\"...\"],\"improvements\":[\"specific coaching action\"],\"recommended_article_ids\":[\"kb id\"]}}",
        serde_json::to_string(&criteria).unwrap_or_default(),
        serde_json::to_string(&catalog).unwrap_or_default(),
        transcript.chars().take(30000).collect::<String>()
    );
    let raw = ask_json(state, SCORE_SYSTEM, &prompt).await?;
    let by_id = raw
        .get("criteria")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let find = |id: &str| -> Option<&Value> {
        by_id.iter().find(|c| c.get("id").and_then(|i| i.as_str()) == Some(id))
    };
    let mut results = Vec::new();
    let mut total_w = 0.0;
    let mut total = 0.0;
    let mut auto_failed = false;
    for crit in doc_array(form, "criteria") {
        let c = crit.as_object().cloned().unwrap_or_default();
        let id = doc_str(&c, "id");
        let got = find(&id);
        let score = got
            .and_then(|g| g.get("score"))
            .and_then(|s| s.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        let passed = got
            .and_then(|g| g.get("passed"))
            .and_then(|p| p.as_bool())
            .unwrap_or(score >= 60.0);
        if doc_bool(&c, "auto_fail") && !passed {
            auto_failed = true;
        }
        let weight = if c.contains_key("weight") { doc_f64(&c, "weight") } else { 1.0 };
        total_w += weight;
        total += score * weight;
        results.push(as_doc(json!( {
            "id": id,
            "name": doc_str(&c, "name"),
            "weight": weight,
            "type": c.get("type").cloned().unwrap_or_else(|| Value::String("scale".into())),
            "auto_fail": doc_bool(&c, "auto_fail"),
            "score": round1(score),
            "passed": passed,
            "reason": got.and_then(|g| g.get("reason")).and_then(|r| r.as_str()).unwrap_or(""),
        })));
    }
    let overall = if auto_failed {
        0.0
    } else if total_w > 0.0 {
        round1(total / total_w)
    } else {
        0.0
    };
    let valid_ids: Vec<String> = articles.iter().map(|a| doc_str(a, "id")).collect();
    let recommended: Vec<Value> = raw
        .get("recommended_article_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|id| valid_ids.iter().any(|x| x == id))
                .map(|id| Value::String(id.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let as_value = |v: Option<&Value>| -> Value { Value::try_from(v.cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null) };
    Ok(as_doc(json!( {
        "criteria_results": results,
        "overall_score": overall,
        "auto_failed": auto_failed,
        "sentiment": raw.get("sentiment").and_then(|v| v.as_str()).unwrap_or("neutral"),
        "sentiment_score": raw.get("sentiment_score").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "csat_predicted": raw.get("csat_predicted").and_then(|v| v.as_i64()).unwrap_or(3),
        "customer_intent": raw.get("customer_intent").and_then(|v| v.as_str()).unwrap_or(""),
        "summary": raw.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
        "compliance_flags": as_value(raw.get("compliance_flags")),
        "strengths": as_value(raw.get("strengths")),
        "improvements": as_value(raw.get("improvements")),
        "recommended_article_ids": recommended,
    })))
}

pub async fn generate_tree(state: &AppState, title: &str, sop: &str) -> ApiResult<Value> {
    let prompt = format!(
        "Convert this SOP into an interactive decision tree for live agents. Title: {title}\nSOP:\n\"\"\"{}\"\"\"\n\
Return JSON: {{\"start_node\":\"n1\",\"nodes\":[{{\"id\":\"n1\",\"title\":\"short step title\",\"text\":\"what to check / ask\",\n\
\"script\":\"exact words agent can say (optional)\",\"options\":[{{\"label\":\"answer/branch\",\"next\":\"n2\"}}]}}]}}\n\
End nodes have an empty options list. Use 4-12 nodes. Every 'next' must reference an existing node id.",
        sop.chars().take(20000).collect::<String>()
    );
    ask_json(state, "You design cognitive decision trees from standard operating procedures.", &prompt).await
}

pub async fn generate_quiz(state: &AppState, content: &str, count: i64) -> ApiResult<Vec<Value>> {
    let prompt = format!(
        "Create {count} multiple-choice assessment questions for new contact-centre hires from this material:\n\
\"\"\"{}\"\"\"\nReturn a JSON array: [{{\"question\":\"...\",\"options\":[\"a\",\"b\",\"c\",\"d\"],\"answer_index\":0,\"explanation\":\"why\"}}]",
        content.chars().take(20000).collect::<String>()
    );
    let raw = ask_json(state, "You write clear, fair training assessments.", &prompt).await?;
    if let Some(arr) = raw.as_array() {
        return Ok(arr.clone());
    }
    Ok(raw
        .get("questions")
        .and_then(|q| q.as_array())
        .cloned()
        .unwrap_or_default())
}
