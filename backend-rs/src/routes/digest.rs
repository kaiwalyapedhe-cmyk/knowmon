//! Daily QA digest: preview, manual send, delivery log and the scheduled cron hook.

use crate::auth::{Admin, Staff};
use crate::db::{self, Query as DbQuery};
use crate::error::{ApiResult, AppError};
use crate::ldap;
use crate::mailer;
use crate::state::AppState;
use crate::util::*;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use crate::util::{Document, as_doc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/cron/digest", post(cron_digest))
        .route("/digest/preview", get(digest_preview))
        .route("/digest/send", post(digest_send))
        .route("/digest/logs", get(digest_logs))
}

fn base_url(headers: &HeaderMap) -> String {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("https")
        .split(',')
        .next()
        .unwrap_or("https")
        .trim()
        .to_string();
    format!("{proto}://{host}")
}

async fn recipients(state: &AppState) -> Vec<String> {
    let mut emails: Vec<String> = Vec::new();
    if let Ok(docs) = db::find(
        &state.db,
        "users",
        DbQuery::new(as_doc(json!( { "env": { "$in": [state.env_name(), Value::Null] },
                             "email": { "$nin": [Value::Null, ""] } }))),
    )
    .await
    {
        for d in docs {
            if effective_role(d.get("role")) == "team_lead" {
                let email = doc_str(&d, "email").to_lowercase();
                if !email.is_empty() {
                    emails.push(email);
                }
            }
        }
    }
    let integrations = state.integrations.read().await.clone();
    for email in ldap::team_lead_emails(&integrations.ldap).await {
        emails.push(email);
    }
    emails.sort();
    emails.dedup();
    emails
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub async fn build_digest(state: &AppState, base: &str) -> ApiResult<Document> {
    let now_ist = chrono::Utc::now() + chrono::Duration::minutes(330);
    let day = now_ist.date_naive();
    let day_start_ist = day
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(chrono::Utc).single())
        .unwrap_or_else(chrono::Utc::now);
    let start = day_start_ist - chrono::Duration::minutes(330);
    let end = start + chrono::Duration::days(1);
    let items = db::find(
        &state.db,
        "interactions",
        DbQuery::new(as_doc(json!( {
            "status": "scored",
            "created_at": {
                "$gte": start.to_rfc3339_opts(chrono::SecondsFormat::Micros, false),
                "$lt": end.to_rfc3339_opts(chrono::SecondsFormat::Micros, false),
            }
        })))
        .project(as_doc(json!( { "transcript": 0, "segments": 0 })))
        .limit(5000),
    )
    .await?;
    let n = items.len();
    let scores: Vec<f64> = items.iter().map(|i| doc_f64(i, "overall_score")).collect();
    let avg = avg(&scores);
    let mut lowest: Vec<Document> = items.clone();
    lowest.sort_by(|a, b| {
        doc_f64(a, "overall_score")
            .partial_cmp(&doc_f64(b, "overall_score"))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    lowest.truncate(5);
    let mut flags: Vec<Document> = Vec::new();
    for i in items.iter() {
        for f in doc_array(i, "compliance_flags").iter().filter_map(|f| f.as_object()) {
            flags.push(as_doc(json!({
                "agent": doc_str(i, "agent_name"),
                "id": doc_str(i, "id"),
                "severity": doc_str(f, "severity"),
                "issue": doc_str(f, "issue"),
            })));
        }
    }
    let auto_fails = items.iter().filter(|i| doc_bool(*i, "auto_failed")).count();
    let open_disputes = db::count(&state.db, "interactions", as_doc(json!( { "dispute.status": "open" }))).await?;

    let link = |id: &str| format!("{base}/interactions/{id}");
    let low_rows = if lowest.is_empty() {
        "<tr><td style='padding:8px'>No interactions scored today.</td></tr>".to_string()
    } else {
        lowest
            .iter()
            .map(|i| {
                format!(
                    "<tr><td style='padding:8px;border-bottom:1px solid #E2E8F0'><a href='{}' style='color:#1B3F94'>{}</a></td>\
<td style='padding:8px;border-bottom:1px solid #E2E8F0'>{}</td>\
<td style='padding:8px;border-bottom:1px solid #E2E8F0;color:#E31E24;font-weight:700'>{}</td></tr>",
                    link(&doc_str(i, "id")),
                    escape_html(&doc_str(i, "agent_name")),
                    escape_html(&doc_str(i, "channel")),
                    if doc_bool(i, "auto_failed") {
                        "AUTO-FAIL".to_string()
                    } else {
                        doc_f64(i, "overall_score").to_string()
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let flag_rows = if flags.is_empty() {
        "<li>No compliance flags today.</li>".to_string()
    } else {
        flags
            .iter()
            .take(20)
            .map(|f| {
                format!(
                    "<li style='margin-bottom:6px'><b style='color:#E31E24'>{}</b> · {}: {} <a href='{}' style='color:#1B3F94'>review</a></li>",
                    escape_html(f.get("severity").and_then(|v| v.as_str()).unwrap_or("").to_uppercase().as_str()),
                    escape_html(f.get("agent").and_then(|v| v.as_str()).unwrap_or("")),
                    escape_html(f.get("issue").and_then(|v| v.as_str()).unwrap_or("")),
                    link(f.get("id").and_then(|v| v.as_str()).unwrap_or("")),
                )
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let kpi = |label: &str, value: String| {
        format!(
            "<td style='padding:12px;background:#F4F6FB;border-radius:8px'><div style='font-size:11px;color:#E31E24;font-weight:700;letter-spacing:2px;text-transform:uppercase'>{label}</div><div style='font-size:22px;color:#16357F;font-weight:800'>{value}</div></td>"
        )
    };
    let body = format!(
        "<base target=\"_blank\"><div style=\"font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1E293B\">\
<div style=\"background:#1B3F94;padding:20px 24px;border-bottom:5px solid #E31E24\"><span style=\"color:#fff;font-size:22px;font-weight:800\">Cadence</span><span style=\"color:#FF5A5F;font-size:22px;font-weight:800\">CX</span>\
<div style=\"color:#C7D2FE;font-size:12px;margin-top:4px\">Daily QA digest · {date}</div></div>\
<div style=\"padding:24px\"><table cellspacing=\"8\" style=\"width:100%\"><tr>{evaluated}{avg}{fails}{disputes}</tr></table>\
<h3 style=\"color:#16357F\">Lowest scores today</h3><table style=\"width:100%;border-collapse:collapse;font-size:14px\">{low}</table>\
<h3 style=\"color:#16357F\">Compliance flags ({flag_count})</h3><ul style=\"font-size:14px;padding-left:18px\">{flags}</ul>\
<p style=\"margin-top:24px\"><a href=\"{base}/dashboard\" style=\"background:#E31E24;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:700\">Open dashboard</a></p></div></div>",
        date = day.format("%d %B %Y"),
        evaluated = kpi("Evaluated", n.to_string()),
        avg = kpi("Avg score", format!("{avg}%")),
        fails = kpi("Auto-fails", auto_fails.to_string()),
        disputes = kpi("Open disputes", open_disputes.to_string()),
        low = low_rows,
        flag_count = flags.len(),
        flags = flag_rows,
        base = base,
    );
    let text = format!(
        "Cadence CX daily QA digest {day}\nEvaluated: {n} · Avg: {avg}% · Auto-fails: {auto_fails} · Open disputes: {open_disputes}\n\nLowest scores:\n{}\n\nCompliance flags:\n{}",
        lowest
            .iter()
            .map(|i| format!(
                "- {}: {} {}",
                doc_str(i, "agent_name"),
                doc_f64(i, "overall_score"),
                link(&doc_str(i, "id"))
            ))
            .collect::<Vec<_>>()
            .join("\n"),
        flags
            .iter()
            .take(20)
            .map(|f| format!(
                "- [{}] {}: {}",
                f.get("severity").and_then(|v| v.as_str()).unwrap_or(""),
                f.get("agent").and_then(|v| v.as_str()).unwrap_or(""),
                f.get("issue").and_then(|v| v.as_str()).unwrap_or("")
            ))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    Ok(as_doc(json!({
        "stats": {
            "date": day.format("%Y-%m-%d").to_string(),
            "evaluated": n,
            "avg_score": avg,
            "auto_fails": auto_fails,
            "flags": flags.len(),
            "open_disputes": open_disputes,
        },
        "html": body,
        "text": text,
        "subject": format!("Cadence CX QA digest · {} · avg {avg}% · {} flags", day.format("%d %b"), flags.len()),
    })))
}

pub async fn send_digest(state: &AppState, base: &str, trigger: &str, run_id: &str) -> Document {
    let mut log = as_doc(json!( {
        "id": new_id(),
        "trigger": trigger,
        "run_id": run_id,
        "at": now(),
        "status": "sent",
        "error": "",
        "recipients": Vec::<Value>::new(),
    }));
    let integrations = state.integrations.read().await.clone();
    let outcome: Result<(), String> = async {
        if !integrations.smtp.configured() {
            return Err("SMTP is not configured".to_string());
        }
        let to = recipients(state).await;
        log.insert(
            "recipients",
            to.iter().map(|e| Value::String(e.clone())).collect::<Vec<_>>(),
        );
        if to.is_empty() {
            return Err("No team lead email addresses found".to_string());
        }
        let digest = build_digest(state, base).await.map_err(|e| e.detail)?;
        if let Some(stats) = digest.get("stats") {
            log.insert("stats".to_string(), Value::try_from(stats.clone()).unwrap_or(Value::Null));
        }
        let subject = digest.get("subject").and_then(|s| s.as_str()).unwrap_or("Cadence CX QA digest");
        let html = digest.get("html").and_then(|s| s.as_str()).unwrap_or("");
        let text = digest.get("text").and_then(|s| s.as_str()).unwrap_or("");
        mailer::send_email(&integrations.smtp, &to, subject, html, text).await
    }
    .await;
    if let Err(err) = outcome {
        tracing::error!("digest failed: {err}");
        log.insert("status".to_string(), "failed");
        log.insert("error".to_string(), err.chars().take(300).collect::<String>());
    }
    let _ = db::insert(&state.db, "digest_logs", log.clone()).await;
    log
}

async fn cron_digest(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> ApiResult<Json<Value>> {
    let secret = st.cfg.webhook_cron_secret.clone();
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if secret.is_empty() || !auth.starts_with("Bearer ") || auth[7..] != secret {
        return Err(AppError::unauthorized("Unauthorized"));
    }
    if !payload.is_object() {
        return Err(AppError::bad("Invalid body"));
    }
    let run_id = headers
        .get("x-webhook-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| payload.get("run_id").and_then(|v| v.as_str()).map(|s| s.to_string()));
    let Some(run_id) = run_id.filter(|r| !r.is_empty()) else {
        return Err(AppError::bad("Missing run id"));
    };
    let inserted = db::upsert_set(
        &st.db,
        "cron_runs",
        as_doc(json!({ "run_id": &run_id })),
        as_doc(json!({})),
        as_doc(json!({ "run_id": &run_id, "job": "digest", "at": now() })),
    )
    .await?;
    if !inserted {
        return Ok(Json(json!({ "status": "duplicate" })));
    }
    let base = base_url(&headers);
    let state_clone = st.clone();
    let run = run_id.clone();
    tokio::spawn(async move {
        send_digest(&state_clone, &base, "schedule", &run).await;
    });
    Ok(Json(json!({ "status": "accepted" })))
}

async fn digest_preview(State(st): State<AppState>, Staff(_m): Staff, headers: HeaderMap) -> ApiResult<Json<Document>> {
    let mut out = build_digest(&st, &base_url(&headers)).await?;
    let integrations = st.integrations.read().await.clone();
    out.insert("recipients", json!(recipients(&st).await));
    out.insert("smtp_configured", integrations.smtp.configured());
    out.insert("ldap_enabled", integrations.ldap_enabled());
    out.insert("schedule", "Daily at 8:00 pm India time");
    Ok(Json(out))
}

async fn digest_send(State(st): State<AppState>, Admin(_m): Admin) -> ApiResult<Json<Document>> {
    let log = send_digest(&st, "http://localhost", "manual", "").await;
    Ok(Json(log))
}

async fn digest_logs(State(st): State<AppState>, Staff(_m): Staff) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "digest_logs",
            DbQuery::new(Document::new()).sort(as_doc(json!( { "at": -1 }))).limit(20),
        )
        .await?,
    ))
}
