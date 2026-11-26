//! AutoQA interactions (upload, transcripts, disputes, self-review) and calibration sessions.

use crate::ai;
use crate::auth::{agent_scope, is_staff, role_of, Member, Qa, Staff};
use crate::db::{self, Query as DbQuery};
use crate::error::{ApiResult, AppError};
use crate::models::*;
use crate::state::AppState;
use crate::storage;
use crate::util::*;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query as QueryParams, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Cursor;
use crate::util::{Document, as_doc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/interactions", get(list_interactions).post(create_interaction))
        .route("/interactions/bulk-audio", post(bulk_audio))
        .route("/interactions/bulk-sheet", post(bulk_sheet))
        .route("/interactions/:iid", get(get_interaction).delete(delete_interaction))
        .route("/interactions/:iid/audio", get(interaction_audio))
        .route("/interactions/:iid/dispute", post(raise_dispute))
        .route("/interactions/:iid/dispute/resolve", post(resolve_dispute))
        .route("/interactions/:iid/rescore", post(rescore))
        .route("/interactions/:iid/self-review", put(save_self_review))
        .route("/disputes", get(list_disputes))
        .route("/calibrations", get(list_calibrations).post(create_calibration))
        .route("/calibrations/:cid", get(get_calibration))
        .route("/calibrations/:cid/score", post(score_calibration))
        .route("/calibrations/:cid/close", post(close_calibration))
}

const AUDIO_TYPES: [(&str, &str); 7] = [
    (".mp3", "audio/mpeg"),
    (".mp4", "audio/mp4"),
    (".mpeg", "audio/mpeg"),
    (".mpga", "audio/mpeg"),
    (".m4a", "audio/mp4"),
    (".wav", "audio/wav"),
    (".webm", "audio/webm"),
];

fn audio_type(filename: &str) -> Option<&'static str> {
    let lower = filename.to_lowercase();
    let ext = lower.rfind('.').map(|i| &lower[i..])?;
    AUDIO_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, t)| *t)
}

fn no_transcript_error() -> AppError {
    AppError::bad("Upload audio or paste a transcript")
}

async fn resolve_agent(db: &crate::db::Db, env: &str, m: &Document, agent_id: &str, agent_name: &str) -> ApiResult<(String, String)> {
    if !is_staff(m) {
        return Ok((doc_str(m, "user_id"), doc_str(m, "name")));
    }
    if !agent_id.is_empty() {
        let person = db::find_one(
            db,
            "users",
            as_doc(json!( { "user_id": agent_id, "env": { "$in": [env, Value::Null] } })),
        )
        .await?
        .ok_or_else(|| AppError::bad("Unknown agent account"))?;
        let name = {
            let n = doc_str(&person, "name");
            if n.is_empty() {
                agent_name.to_string()
            } else {
                n
            }
        };
        return Ok((agent_id.to_string(), name));
    }
    Ok((String::new(), agent_name.to_string()))
}

#[allow(clippy::too_many_arguments)]
async fn create_interaction_record(
    state: &AppState,
    m: &Document,
    channel: &str,
    form: &Document,
    agent_id: &str,
    agent_name: &str,
    customer_name: &str,
    transcript: &str,
    filename: &str,
    data: &[u8],
    batch_id: &str,
) -> ApiResult<Document> {
    if !CHANNELS.contains(&channel) {
        return Err(AppError::bad("Unknown channel"));
    }
    if agent_name.trim().is_empty() {
        return Err(AppError::bad("Choose or enter an agent"));
    }
    let iid = new_id();
    let mut audio_path = String::new();
    let mut content_type = String::new();
    let mut temp_path: Option<String> = None;
    if !filename.is_empty() {
        let ctype = audio_type(filename)
            .ok_or_else(|| AppError::bad(format!("Unsupported audio format: {filename}")))?;
        if data.len() > 25 * 1024 * 1024 {
            return Err(AppError::bad(format!("Audio must be under 25 MB: {filename}")));
        }
        content_type = ctype.to_string();
        let ext = filename
            .rfind('.')
            .map(|i| filename[i..].to_lowercase())
            .unwrap_or_default();
        match storage::put_object(state, &format!("recordings/{iid}{ext}"), data.to_vec(), ctype).await {
            Ok(meta) => audio_path = doc_str(&meta, "path"),
            Err(err) => tracing::error!("recording upload failed; continuing without playback: {:?}", err.detail),
        }
        let path = std::env::temp_dir().join(format!("{iid}{ext}"));
        tokio::fs::write(&path, data).await?;
        temp_path = Some(path.to_string_lossy().to_string());
    } else if transcript.trim().is_empty() {
        return Err(no_transcript_error());
    }
    let entry = as_doc(json!( {
        "id": &iid,
        "channel": channel,
        "agent_id": agent_id,
        "agent_name": agent_name.trim(),
        "customer_name": customer_name.trim(),
        "form_id": doc_str(form, "id"),
        "form_name": doc_str(form, "name"),
        "source": if temp_path.is_some() { "audio" } else { "text" },
        "audio_name": if temp_path.is_some() { filename } else { "" },
        "audio_path": &audio_path,
        "audio_type": &content_type,
        "batch_id": batch_id,
        "transcript": transcript,
        "status": if temp_path.is_some() { "transcribing" } else { "scoring" },
        "created_by": doc_str(m, "user_id"),
        "created_at": now(),
    }));
    db::insert(&state.db, "interactions", entry.clone()).await?;
    let state_clone = state.clone();
    let iid_clone = iid.clone();
    let filename = filename.to_string();
    tokio::spawn(async move {
        process_interaction(state_clone, iid_clone, temp_path, filename).await;
    });
    Ok(entry)
}

async fn process_interaction(state: AppState, iid: String, path: Option<String>, filename: String) {
    let doc = match db::find_one(&state.db, "interactions", as_doc(json!( { "id": &iid }))).await {
        Ok(Some(d)) => d,
        _ => return,
    };
    let mut transcript = doc_str(&doc, "transcript");
    if let Some(p) = path.as_deref() {
        match ai::transcribe(&state, p, &filename).await {
            Ok((text, segments)) => {
                transcript = text;
                let _ = db::set_fields(
                    &state.db,
                    "interactions",
                    as_doc(json!( { "id": &iid })),
                    as_doc(json!( { "transcript": &transcript, "segments": segments, "status": "scoring" })),
                )
                .await;
            }
            Err(err) => {
                let _ = db::set_fields(
                    &state.db,
                    "interactions",
                    as_doc(json!( { "id": &iid })),
                    as_doc(json!( { "status": "failed", "error": err.detail.chars().take(300).collect::<String>() })),
                )
                .await;
                let _ = std::fs::remove_file(p);
                return;
            }
        }
    }
    let result = run_scoring(&state, &doc, &transcript).await;
    match result {
        Ok(scored) => {
            let _ = db::set_fields(
                &state.db,
                "interactions",
                as_doc(json!( { "id": &iid })),
                {
                    let mut set = scored;
                    set.insert("status".to_string(), "scored");
                    set.insert("scored_at".to_string(), now());
                    set
                },
            )
            .await;
        }
        Err(err) => {
            tracing::error!("interaction {iid} failed: {}", err.detail);
            let _ = db::set_fields(
                &state.db,
                "interactions",
                as_doc(json!( { "id": &iid })),
                as_doc(json!( { "status": "failed", "error": err.detail.chars().take(300).collect::<String>() })),
            )
            .await;
        }
    }
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

async fn run_scoring(state: &AppState, doc: &Document, transcript: &str) -> ApiResult<Document> {
    if transcript.trim().is_empty() {
        return Err(AppError::bad("Transcript is empty"));
    }
    let form_id = doc_str(doc, "form_id");
    let form = db::find_one(&state.db, "qa_forms", as_doc(json!( { "id": &form_id })))
        .await?
        .ok_or_else(|| AppError::bad("The QA form for this interaction no longer exists"))?;
    let articles = db::find(
        &state.db,
        "articles",
        DbQuery::new(Document::new())
            .project(as_doc(json!( { "id": 1, "title": 1, "category": 1 })))
            .limit(300),
    )
    .await?;
    let channel = doc_str(doc, "channel");
    ai::score_interaction(state, &form, transcript, &channel, &articles).await
}

async fn create_interaction(
    State(st): State<AppState>,
    Member(m): Member,
    mut multipart: Multipart,
) -> ApiResult<Json<Document>> {
    let mut channel = String::from("voice");
    let mut form_id = String::new();
    let mut agent_id = String::new();
    let mut agent_name = String::new();
    let mut customer_name = String::new();
    let mut transcript = String::new();
    let mut filename = String::new();
    let mut data: Vec<u8> = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                filename = field.file_name().unwrap_or("").to_string();
                data = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?.to_vec();
            }
            "channel" => channel = field.text().await.unwrap_or_default(),
            "form_id" => form_id = field.text().await.unwrap_or_default(),
            "agent_id" => agent_id = field.text().await.unwrap_or_default(),
            "agent_name" => agent_name = field.text().await.unwrap_or_default(),
            "customer_name" => customer_name = field.text().await.unwrap_or_default(),
            "transcript" => transcript = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    if form_id.is_empty() {
        return Err(AppError::bad("Choose a QA form"));
    }
    let form = db::get_or_404(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await?;
    let (agent_id, agent_name) = resolve_agent(&st.db, st.env_name(), &m, &agent_id, &agent_name).await?;
    let doc = create_interaction_record(
        &st,
        &m,
        &channel,
        &form,
        &agent_id,
        &agent_name,
        &customer_name,
        &transcript,
        &filename,
        &data,
        "",
    )
    .await?;
    Ok(Json(doc))
}

async fn bulk_audio(State(st): State<AppState>, Staff(m): Staff, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    let mut channel = String::from("voice");
    let mut form_id = String::new();
    let mut agent_id = String::new();
    let mut agent_name = String::new();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "files" => {
                let fname = field.file_name().unwrap_or("").to_string();
                let bytes = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?.to_vec();
                files.push((fname, bytes));
            }
            "channel" => channel = field.text().await.unwrap_or_default(),
            "form_id" => form_id = field.text().await.unwrap_or_default(),
            "agent_id" => agent_id = field.text().await.unwrap_or_default(),
            "agent_name" => agent_name = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    if files.len() > 50 {
        return Err(AppError::bad("Up to 50 recordings per batch"));
    }
    if form_id.is_empty() {
        return Err(AppError::bad("Choose a QA form"));
    }
    let form = db::get_or_404(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await?;
    let (agent_id, agent_name) = resolve_agent(&st.db, st.env_name(), &m, &agent_id, &agent_name).await?;
    let batch_id = new_id();
    let mut created = 0;
    let mut errors: Vec<Document> = Vec::new();
    for (fname, data) in files {
        match create_interaction_record(
            &st, &m, &channel, &form, &agent_id, &agent_name, "", "", &fname, &data, &batch_id,
        )
        .await
        {
            Ok(_) => created += 1,
            Err(err) => errors.push(as_doc(json!({ "row": fname, "error": err.detail }))),
        }
    }
    Ok(Json(json!({ "batch_id": batch_id, "created": created, "errors": errors })))
}

fn read_sheet(filename: &str, data: &[u8]) -> ApiResult<Vec<HashMap<String, String>>> {
    let name = filename.to_lowercase();
    if name.ends_with(".csv") {
        let text = String::from_utf8_lossy(data);
        let text = text.trim_start_matches('\u{feff}');
        let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
        let headers = reader.headers().map_err(|_| AppError::bad("Could not read the spreadsheet"))?.clone();
        let mut rows = Vec::new();
        for record in reader.records() {
            let record = record.map_err(|_| AppError::bad("Could not read the spreadsheet"))?;
            let mut row = HashMap::new();
            for (i, header) in headers.iter().enumerate() {
                row.insert(header.trim().to_lowercase(), record.get(i).unwrap_or("").trim().to_string());
            }
            rows.push(row);
        }
        return Ok(rows);
    }
    if name.ends_with(".xlsx") {
        let mut workbook: Xlsx<_> = open_workbook_from_rs(Cursor::new(data.to_vec()))
            .map_err(|_| AppError::bad("Could not read the spreadsheet"))?;
        let range = workbook
            .worksheet_range_at(0)
            .ok_or_else(|| AppError::bad("Could not read the spreadsheet"))?
            .map_err(|_| AppError::bad("Could not read the spreadsheet"))?;
        let mut iter = range.rows();
        let Some(head) = iter.next() else {
            return Ok(Vec::new());
        };
        let headers: Vec<String> = head
            .iter()
            .map(|c| match c {
                Data::Empty => String::new(),
                other => other.to_string().trim().to_string(),
            })
            .collect();
        let mut rows = Vec::new();
        for row in iter {
            let mut map = HashMap::new();
            for (i, cell) in row.iter().enumerate() {
                if i >= headers.len() || headers[i].is_empty() {
                    continue;
                }
                let value = match cell {
                    Data::Empty => String::new(),
                    Data::Float(f) => {
                        if f.fract() == 0.0 {
                            format!("{}", *f as i64)
                        } else {
                            f.to_string()
                        }
                    }
                    other => other.to_string(),
                };
                map.insert(headers[i].to_lowercase(), value.trim().to_string());
            }
            rows.push(map);
        }
        return Ok(rows);
    }
    Err(AppError::bad("Upload a .csv or .xlsx file"))
}

async fn bulk_sheet(State(st): State<AppState>, Staff(m): Staff, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    let mut form_id = String::new();
    let mut filename = String::new();
    let mut data: Vec<u8> = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::bad(e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => {
                filename = field.file_name().unwrap_or("").to_string();
                data = field.bytes().await.map_err(|e| AppError::bad(e.to_string()))?.to_vec();
            }
            "form_id" => form_id = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    if data.len() > 10 * 1024 * 1024 {
        return Err(AppError::bad("Spreadsheet must be under 10 MB"));
    }
    let rows = read_sheet(&filename, &data)?;
    if rows.is_empty() {
        return Err(AppError::bad("The spreadsheet has no rows"));
    }
    if rows.len() > 200 {
        return Err(AppError::bad("Up to 200 rows per import"));
    }
    let forms = db::find(&st.db, "qa_forms", DbQuery::new(Document::new()).limit(200)).await?;
    if forms.is_empty() {
        return Err(AppError::bad("Create a QA form first"));
    }
    let people = db::find(
        &st.db,
        "users",
        DbQuery::new(as_doc(json!( { "env": { "$in": [st.env_name(), Value::Null] }, "email": { "$nin": [Value::Null, ""] } }))),
    )
    .await?;
    let by_email: HashMap<String, Document> = people
        .into_iter()
        .map(|p| (doc_str(&p, "email").to_lowercase(), p))
        .collect();
    let batch_id = new_id();
    let mut created = 0;
    let mut errors: Vec<Document> = Vec::new();
    for (n, raw) in rows.iter().enumerate() {
        let row: HashMap<String, String> = raw
            .iter()
            .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
            .collect();
        let channel = row
            .get("channel")
            .map(|c| c.to_lowercase().replace('-', "_").replace(' ', "_"))
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "voice".to_string());
        let key = row.get("form").cloned().filter(|k| !k.is_empty()).unwrap_or_else(|| form_id.clone());
        let form = forms
            .iter()
            .find(|f| doc_str(f, "id") == key || doc_str(f, "name").to_lowercase() == key.to_lowercase())
            .or_else(|| {
                forms.iter().find(|f| {
                    let c = doc_str(f, "channel");
                    c == channel || c == "all"
                })
            })
            .or_else(|| forms.first())
            .cloned()
            .ok_or_else(|| AppError::bad("Create a QA form first"))?;
        let person = row
            .get("agent_email")
            .and_then(|e| by_email.get(&e.to_lowercase()))
            .cloned();
        let (agent_id, agent_name) = match person {
            Some(p) => (doc_str(&p, "user_id"), doc_str(&p, "name")),
            None => (
                String::new(),
                row.get("agent_name").cloned().unwrap_or_default(),
            ),
        };
        match create_interaction_record(
            &st,
            &m,
            &channel,
            &form,
            &agent_id,
            &agent_name,
            row.get("customer_name").map(|s| s.as_str()).unwrap_or(""),
            row.get("transcript").map(|s| s.as_str()).unwrap_or(""),
            "",
            &[],
            &batch_id,
        )
        .await
        {
            Ok(_) => created += 1,
            Err(err) => errors.push(as_doc(json!({ "row": n + 2, "error": err.detail }))),
        }
    }
    Ok(Json(json!({ "batch_id": batch_id, "created": created, "errors": errors })))
}

async fn interaction_audio(
    State(st): State<AppState>,
    Member(m): Member,
    Path(iid): Path<String>,
) -> ApiResult<Response> {
    let doc = db::get_or_404(&st.db, "interactions", {
        let mut f = as_doc(json!( { "id": &iid }));
        for (k, v) in agent_scope(&m) {
            f.insert(k, v);
        }
        f
    })
    .await?;
    let path = doc_str(&doc, "audio_path");
    if path.is_empty() {
        return Err(AppError::not_found("No recording stored"));
    }
    let (data, ctype) = storage::get_object(&st, &path).await?;
    let media = {
        let stored = doc_str(&doc, "audio_type");
        if stored.is_empty() {
            ctype
        } else {
            stored
        }
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media)
        .body(Body::from(data))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn list_interactions(State(st): State<AppState>, Member(m): Member) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "interactions",
            DbQuery::new(agent_scope(&m))
                .project(as_doc(json!( { "transcript": 0, "criteria_results": 0, "segments": 0 })))
                .sort(as_doc(json!( { "created_at": -1 })))
                .limit(500),
        )
        .await?,
    ))
}

async fn get_interaction(
    State(st): State<AppState>,
    Member(m): Member,
    Path(iid): Path<String>,
) -> ApiResult<Json<Document>> {
    let mut filter = as_doc(json!( { "id": &iid }));
    for (k, v) in agent_scope(&m) {
        filter.insert(k, v);
    }
    Ok(Json(db::get_or_404(&st.db, "interactions", filter).await?))
}

async fn rescore(State(st): State<AppState>, Staff(_m): Staff, Path(iid): Path<String>) -> ApiResult<Json<Value>> {
    db::get_or_404(&st.db, "interactions", as_doc(json!( { "id": &iid }))).await?;
    db::update(
        &st.db,
        "interactions",
        as_doc(json!( { "id": &iid })),
        as_doc(json!( { "$set": { "status": "scoring", "error": "" }, "$unset": { "original_score": "" } })),
    )
    .await?;
    let state_clone = st.clone();
    let iid_clone = iid.clone();
    tokio::spawn(async move {
        process_interaction(state_clone, iid_clone, None, String::new()).await;
    });
    Ok(Json(json!({ "ok": true })))
}

async fn delete_interaction(State(st): State<AppState>, Qa(_m): Qa, Path(iid): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "interactions", as_doc(json!( { "id": &iid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn raise_dispute(
    State(st): State<AppState>,
    Member(m): Member,
    Path(iid): Path<String>,
    Json(body): Json<DisputeIn>,
) -> ApiResult<Json<Document>> {
    if body.reason.trim().len() < 5 {
        return Err(AppError::bad("Tell us what should be reviewed"));
    }
    let doc = db::get_or_404(
        &st.db,
        "interactions",
        as_doc(json!( { "id": &iid, "agent_id": doc_str(&m, "user_id") })),
    )
    .await?;
    if doc_str(&doc, "status") != "scored" {
        return Err(AppError::bad("Only scored interactions can be disputed"));
    }
    let previous = doc.get("dispute").and_then(|d| d.as_object()).cloned();
    if let Some(p) = &previous {
        if doc_str(p, "status") == "open" {
            return Err(AppError::conflict("A dispute is already open"));
        }
    }
    if doc_array(&doc, "dispute_history").len() >= 2 {
        return Err(AppError::conflict("This score has already been reviewed twice"));
    }
    let valid: Vec<String> = doc_array(&doc, "criteria_results")
        .iter()
        .filter_map(|c| c.as_object().map(|d| doc_str(d, "id")))
        .collect();
    let criterion_ids: Vec<Value> = body
        .criterion_ids
        .iter()
        .filter(|c| valid.contains(c))
        .map(|c| Value::String(c.clone()))
        .collect();
    let dispute = as_doc(json!( {
        "status": "open",
        "reason": body.reason.trim(),
        "criterion_ids": criterion_ids,
        "raised_by": doc_str(&m, "user_id"),
        "raised_by_name": doc_str(&m, "name"),
        "raised_at": now(),
        "score_at_dispute": doc.get("overall_score").cloned().unwrap_or(Value::from(0.0)),
    }));
    let mut update = as_doc(json!( { "$set": { "dispute": dispute.clone() } }));
    if previous.is_some() {
        update.insert("$push".to_string(), as_doc(json!( { "dispute_history": previous })));
    }
    db::update(&st.db, "interactions", as_doc(json!( { "id": &iid })), update).await?;
    Ok(Json(dispute))
}

async fn resolve_dispute(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(iid): Path<String>,
    Json(body): Json<ResolveIn>,
) -> ApiResult<Json<Document>> {
    let doc = db::get_or_404(&st.db, "interactions", as_doc(json!( { "id": &iid }))).await?;
    let dispute = doc.get("dispute").and_then(|d| d.as_object()).cloned().unwrap_or_default();
    if doc_str(&dispute, "status") != "open" {
        return Err(AppError::conflict("No open dispute"));
    }
    if body.decision != "accepted" && body.decision != "rejected" {
        return Err(AppError::bad("Decision must be accepted or rejected"));
    }
    let mut set = as_doc(json!( {
        "dispute.status": "resolved",
        "dispute.decision": &body.decision,
        "dispute.note": body.note.trim(),
        "dispute.resolved_by": doc_str(&m, "user_id"),
        "dispute.resolved_by_name": doc_str(&m, "name"),
        "dispute.resolved_at": now(),
    }));
    let old_score = doc_f64(&doc, "overall_score");
    let mut new_score = None;
    if body.decision == "accepted" {
        let Some(score) = body.new_score else {
            return Err(AppError::bad("Enter the corrected score"));
        };
        let score = round1(score.clamp(0.0, 100.0));
        new_score = Some(score);
        set.insert("overall_score".to_string(), score);
        set.insert("auto_failed".to_string(), false);
        set.insert("dispute.new_score".to_string(), score);
        set.insert("original_score".to_string(), doc.get("original_score").cloned().unwrap_or(Value::from(old_score)));
    }
    db::set_fields(&st.db, "interactions", as_doc(json!( { "id": &iid })), set).await?;
    if let Some(score) = new_score {
        super::qa::record_score_change(&st.db, &iid, old_score, score, "dispute", &m, body.note.trim()).await?;
    }
    Ok(Json(
        db::get_or_404(&st.db, "interactions", as_doc(json!( { "id": &iid }))).await?,
    ))
}

#[derive(Debug, Deserialize)]
struct DisputeQuery {
    #[serde(default)]
    status: String,
}

async fn list_disputes(
    State(st): State<AppState>,
    Member(m): Member,
    QueryParams(q): QueryParams<DisputeQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    let mut filter = as_doc(json!( { "dispute": { "$exists": true } }));
    for (k, v) in agent_scope(&m) {
        filter.insert(k, v);
    }
    if !q.status.is_empty() {
        filter.insert("dispute.status".to_string(), q.status);
    }
    Ok(Json(
        db::find(
            &st.db,
            "interactions",
            DbQuery::new(filter)
                .project(as_doc(json!( { "transcript": 0, "segments": 0, "criteria_results": 0 })))
                .sort(as_doc(json!( { "dispute.raised_at": -1 })))
                .limit(500),
        )
        .await?,
    ))
}

async fn save_self_review(
    State(st): State<AppState>,
    Member(m): Member,
    Path(iid): Path<String>,
    Json(body): Json<SelfReviewIn>,
) -> ApiResult<Json<Document>> {
    let doc = db::get_or_404(
        &st.db,
        "interactions",
        as_doc(json!( { "id": &iid, "agent_id": doc_str(&m, "user_id") })),
    )
    .await?;
    if doc_str(&doc, "status") != "scored" {
        return Err(AppError::bad("You can review a call once it is scored"));
    }
    let mut notes = body.notes.clone();
    notes.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    notes.truncate(100);
    let review = as_doc(json!( {
        "reflection": body.reflection.trim(),
        "notes": notes.iter().map(|n| Value::from(as_doc(json!( { "t": n.t, "text": &n.text })))).collect::<Vec<_>>(),
        "updated_at": now(),
    }));
    db::set_fields(&st.db, "interactions", as_doc(json!( { "id": &iid })), as_doc(json!( { "self_review": &review }))).await?;
    Ok(Json(review))
}

// ---------- calibration ----------

fn weighted(form_criteria: &[Value], scores: &HashMap<String, f64>) -> f64 {
    let total_w: f64 = form_criteria
        .iter()
        .filter_map(|c| c.as_object())
        .map(|c| doc_f64(c, "weight"))
        .sum();
    if total_w == 0.0 {
        return 0.0;
    }
    let total: f64 = form_criteria
        .iter()
        .filter_map(|c| c.as_object())
        .map(|c| scores.get(&doc_str(c, "id")).copied().unwrap_or(0.0) * doc_f64(c, "weight"))
        .sum();
    round1(total / total_w)
}

fn check_criteria(cal: &Document, items: &[CritScore]) -> ApiResult<HashMap<String, CritScore>> {
    let criteria = doc_array(cal, "criteria");
    let ids: Vec<String> = criteria
        .iter()
        .filter_map(|c| c.as_object().map(|d| doc_str(d, "id")))
        .collect();
    let got: HashMap<String, CritScore> = items.iter().map(|c| (c.id.clone(), c.clone())).collect();
    if ids.len() != got.len() || !ids.iter().all(|id| got.contains_key(id)) {
        return Err(AppError::bad("Score every criterion"));
    }
    for c in criteria.iter().filter_map(|c| c.as_object()) {
        if doc_str(c, "type") == "binary" {
            let id = doc_str(c, "id");
            let score = got.get(&id).map(|s| s.score).unwrap_or(-1.0);
            if score != 0.0 && score != 100.0 {
                return Err(AppError::bad(format!(
                    "'{}' is pass/fail: use 0 or 100",
                    doc_str(c, "name")
                )));
            }
        }
    }
    Ok(got)
}

fn cal_view(cal: &Document, m: &Document) -> Document {
    let uid = doc_str(m, "user_id");
    let scores = doc_array(cal, "scores");
    let mine = scores
        .iter()
        .filter_map(|s| s.as_object())
        .find(|s| doc_str(s, "user_id") == uid)
        .cloned();
    let participant = doc_array(cal, "participant_ids")
        .iter()
        .any(|p| p.as_str() == Some(uid.as_str()));
    let reveal = doc_str(cal, "status") == "closed"
        || mine.is_some()
        || (!participant && (uid == doc_str(cal, "created_by") || role_of(m) == "admin"));
    let mut out = cal.clone();
    out.insert(
        "scores",
        if reveal { Value::from(scores.clone()) } else { Value::Array(Vec::new()) },
    );
    out.insert("revealed".to_string(), reveal);
    out.insert("submitted".to_string(), mine.is_some());
    out.insert("submitted_count".to_string(), scores.len() as i64);
    let mut spread = Document::new();
    if reveal && !scores.is_empty() {
        for c in doc_array(cal, "criteria").iter().filter_map(|c| c.as_object()) {
            let id = doc_str(c, "id");
            let mut values: Vec<f64> = vec![doc_f64(c, "ai_score")];
            for s in scores.iter().filter_map(|s| s.as_object()) {
                for item in doc_array(s, "criteria").iter().filter_map(|x| x.as_object()) {
                    if doc_str(item, "id") == id {
                        values.push(doc_f64(item, "score"));
                    }
                }
            }
            let max = values.iter().cloned().fold(f64::MIN, f64::max);
            let min = values.iter().cloned().fold(f64::MAX, f64::min);
            spread.insert(id, round1(max - min));
        }
    }
    out.insert("spread".to_string(), spread);
    out
}

async fn list_calibrations(
    State(st): State<AppState>,
    Staff(m): Staff,
) -> ApiResult<Json<Vec<Document>>> {
    let uid = doc_str(&m, "user_id");
    let filter = if role_of(&m) == "admin" {
        Document::new()
    } else {
        as_doc(json!( { "$or": [ { "created_by": &uid }, { "participant_ids": &uid } ] }))
    };
    let cals = db::find(
        &st.db,
        "calibrations",
        DbQuery::new(filter).sort(as_doc(json!( { "created_at": -1 }))).limit(300),
    )
    .await?;
    Ok(Json(cals.iter().map(|c| cal_view(c, &m)).collect()))
}

async fn create_calibration(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<CalibrationIn>,
) -> ApiResult<Json<Document>> {
    let it = db::get_or_404(&st.db, "interactions", as_doc(json!( { "id": &body.interaction_id }))).await?;
    if doc_str(&it, "status") != "scored" {
        return Err(AppError::bad("Pick a scored interaction"));
    }
    if body.participant_ids.is_empty() {
        return Err(AppError::bad("Add at least one participant"));
    }
    let people = db::find(
        &st.db,
        "users",
        DbQuery::new(as_doc(json!( { "user_id": { "$in": body.participant_ids.clone() }, "env": { "$in": [st.env_name(), Value::Null] } }))),
    )
    .await?;
    let staff_people: Vec<Document> = people
        .into_iter()
        .filter(|p| STAFF.contains(&effective_role(p.get("role")).as_str()))
        .collect();
    let unique: std::collections::HashSet<&String> = body.participant_ids.iter().collect();
    if staff_people.len() != unique.len() {
        return Err(AppError::bad(
            "Participants must be team leads, QA auditors or admins",
        ));
    }
    let title = if body.title.trim().is_empty() {
        format!("Calibrate {} · {}", doc_str(&it, "agent_name"), doc_str(&it, "form_name"))
    } else {
        body.title.trim().to_string()
    };
    let criteria: Vec<Value> = doc_array(&it, "criteria_results")
        .iter()
        .filter_map(|c| c.as_object())
        .map(|c| {
            Value::from(as_doc(json!( {
                "id": doc_str(c, "id"),
                "name": doc_str(c, "name"),
                "weight": doc_f64(c, "weight"),
                "type": c.get("type").cloned().unwrap_or_else(|| Value::String("scale".into())),
                "auto_fail": doc_bool(c, "auto_fail"),
                "ai_score": c.get("score").cloned().unwrap_or(Value::from(0.0)),
                "ai_reason": doc_str(c, "reason"),
            })))
        })
        .collect();
    let cal = as_doc(json!( {
        "id": new_id(),
        "interaction_id": doc_str(&it, "id"),
        "agent_name": doc_str(&it, "agent_name"),
        "channel": doc_str(&it, "channel"),
        "title": title,
        "due": &body.due,
        "participant_ids": staff_people.iter().map(|p| Value::String(doc_str(p, "user_id"))).collect::<Vec<_>>(),
        "participant_names": staff_people.iter().map(|p| Value::String(doc_str(p, "name"))).collect::<Vec<_>>(),
        "criteria": criteria,
        "ai_overall": it.get("overall_score").cloned().unwrap_or(Value::from(0.0)),
        "status": "open",
        "scores": Vec::<Value>::new(),
        "final": Value::Null,
        "created_by": doc_str(&m, "user_id"),
        "created_by_name": doc_str(&m, "name"),
        "created_at": now(),
    }));
    db::insert(&st.db, "calibrations", cal.clone()).await?;
    Ok(Json(cal_view(&cal, &m)))
}

async fn get_cal(db: &crate::db::Db, cid: &str, m: &Document) -> ApiResult<Document> {
    let cal = db::get_or_404(db, "calibrations", as_doc(json!( { "id": cid }))).await?;
    let uid = doc_str(m, "user_id");
    let participant = doc_array(&cal, "participant_ids").iter().any(|p| p.as_str() == Some(uid.as_str()));
    if role_of(m) != "admin" && uid != doc_str(&cal, "created_by") && !participant {
        return Err(crate::error::not_found());
    }
    Ok(cal)
}

async fn get_calibration(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(cid): Path<String>,
) -> ApiResult<Json<Document>> {
    let cal = get_cal(&st.db, &cid, &m).await?;
    Ok(Json(cal_view(&cal, &m)))
}

async fn score_calibration(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(cid): Path<String>,
    Json(body): Json<CalScoreIn>,
) -> ApiResult<Json<Document>> {
    let cal = get_cal(&st.db, &cid, &m).await?;
    if doc_str(&cal, "status") != "open" {
        return Err(AppError::conflict("This session is closed"));
    }
    let uid = doc_str(&m, "user_id");
    if !doc_array(&cal, "participant_ids").iter().any(|p| p.as_str() == Some(uid.as_str())) {
        return Err(AppError::forbidden("You are not a participant"));
    }
    let got = check_criteria(&cal, &body.criteria)?;
    let scores_map: HashMap<String, f64> = got.iter().map(|(k, v)| (k.clone(), v.score)).collect();
    let criteria = doc_array(&cal, "criteria");
    let entry = as_doc(json!( {
        "user_id": &uid,
        "name": doc_str(&m, "name"),
        "submitted_at": now(),
        "criteria": criteria.iter().filter_map(|c| c.as_object()).map(|c| {
            let id = doc_str(c, "id");
            let score = got.get(&id).map(|s| s.score).unwrap_or(0.0);
            let note = got.get(&id).map(|s| s.note.clone()).unwrap_or_default();
            Value::from(as_doc(json!( { "id": &id, "score": score, "note": note })))
        }).collect::<Vec<_>>(),
        "overall": weighted(&criteria, &scores_map),
    }));
    db::update(
        &st.db,
        "calibrations",
        as_doc(json!( { "id": &cid })),
        as_doc(json!( { "$pull": { "scores": { "user_id": &uid } } })),
    )
    .await?;
    db::update(
        &st.db,
        "calibrations",
        as_doc(json!( { "id": &cid })),
        as_doc(json!( { "$push": { "scores": entry } })),
    )
    .await?;
    let cal = get_cal(&st.db, &cid, &m).await?;
    Ok(Json(cal_view(&cal, &m)))
}

async fn close_calibration(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(cid): Path<String>,
    Json(body): Json<CalCloseIn>,
) -> ApiResult<Json<Document>> {
    let cal = get_cal(&st.db, &cid, &m).await?;
    if doc_str(&cal, "status") != "open" {
        return Err(AppError::conflict("Already closed"));
    }
    let uid = doc_str(&m, "user_id");
    if uid != doc_str(&cal, "created_by") && role_of(&m) != "admin" {
        return Err(AppError::forbidden("Only the session owner can close it"));
    }
    let got = check_criteria(&cal, &body.criteria)?;
    let criteria = doc_array(&cal, "criteria");
    let scores_map: HashMap<String, f64> = got.iter().map(|(k, v)| (k.clone(), v.score)).collect();
    let overall = weighted(&criteria, &scores_map);
    let final_doc = as_doc(json!( {
        "criteria": criteria.iter().filter_map(|c| c.as_object()).map(|c| {
            let id = doc_str(c, "id");
            Value::from(as_doc(json!( {
                "id": &id,
                "score": got.get(&id).map(|s| s.score).unwrap_or(0.0),
                "note": got.get(&id).map(|s| s.note.clone()).unwrap_or_default(),
            })))
        }).collect::<Vec<_>>(),
        "overall": overall,
        "note": body.note.trim(),
        "by": &uid,
        "by_name": doc_str(&m, "name"),
        "at": now(),
        "applied": body.apply_to_interaction,
    }));
    let it = if body.apply_to_interaction {
        Some(db::get_or_404(&st.db, "interactions", as_doc(json!( { "id": doc_str(&cal, "interaction_id") }))).await?)
    } else {
        None
    };
    let res = db::set_fields(
        &st.db,
        "calibrations",
        as_doc(json!( { "id": &cid, "status": "open" })),
        as_doc(json!( { "status": "closed", "final": &final_doc })),
    )
    .await?;
    if res.modified_count == 0 {
        return Err(AppError::conflict("Already closed"));
    }
    if let Some(it) = it {
        let mut auto_failed = false;
        for c in criteria.iter().filter_map(|c| c.as_object()) {
            let id = doc_str(c, "id");
            let score = got.get(&id).map(|s| s.score).unwrap_or(0.0);
            if doc_bool(c, "auto_fail") && score < 60.0 {
                auto_failed = true;
            }
        }
        let results: Vec<Value> = doc_array(&it, "criteria_results")
            .iter()
            .filter_map(|c| c.as_object())
            .map(|c| {
                let id = doc_str(c, "id");
                let mut out = Document::from(c.clone());
                if let Some(score) = got.get(&id) {
                    out.insert("score".to_string(), score.score);
                    out.insert("passed".to_string(), score.score >= 60.0);
                    let reason = if score.note.is_empty() {
                        doc_str(c, "reason")
                    } else {
                        score.note.clone()
                    };
                    out.insert("reason".to_string(), reason);
                }
                Value::from(out)
            })
            .collect();
        let final_score = if auto_failed { 0.0 } else { overall };
        let old_score = doc_f64(&it, "overall_score");
        db::set_fields(
            &st.db,
            "interactions",
            as_doc(json!( { "id": doc_str(&it, "id") })),
            as_doc(json!( {
                "criteria_results": results,
                "overall_score": final_score,
                "auto_failed": auto_failed,
                "calibrated_by": &cid,
                "original_score": it.get("original_score").cloned().unwrap_or(Value::from(old_score)),
            })),
        )
        .await?;
        super::qa::record_score_change(
            &st.db,
            &doc_str(&it, "id"),
            old_score,
            final_score,
            "calibration",
            &m,
            &body.note,
        )
        .await?;
    }
    let cal = get_cal(&st.db, &cid, &m).await?;
    Ok(Json(cal_view(&cal, &m)))
}
