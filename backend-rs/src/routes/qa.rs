//! QA forms (+ rubric versioning) and the QA Operations engine: sampling policies,
//! reviewer assignments, coverage and SLA reporting, score audit trail.

use crate::auth::{Staff, Qa};
use crate::db::{self, Query as DbQuery};
use crate::error::{ApiResult, AppError};
use crate::models::*;
use crate::state::AppState;
use crate::util::*;
use axum::extract::{Path, Query as QueryParams, State};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use rand::seq::SliceRandom;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use crate::util::{Document, as_doc};

const PERIOD_DAYS: [(&str, i64); 3] = [("daily", 1), ("weekly", 7), ("monthly", 30)];
const EVALUATOR_ROLES: [&str; 3] = ["admin", "qa_auditor", "team_lead"];
const OPEN_STATES: [&str; 2] = ["pending", "in_progress"];

pub fn forms_router() -> Router<AppState> {
    Router::new()
        .route("/qa-forms", get(list_forms).post(create_form))
        .route("/qa-forms/:form_id", put(update_form).delete(delete_form))
        .route("/qa-forms/:form_id/versions", get(list_form_versions))
        .route("/qa-forms/:form_id/versions/:vid", get(get_form_version))
        .route("/qa-forms/:form_id/versions/:vid/restore", post(restore_form_version))
}

pub fn qa_ops_router() -> Router<AppState> {
    Router::new()
        .route("/qa-ops/policies", get(list_policies).post(create_policy))
        .route("/qa-ops/policies/:pid", put(update_policy).delete(delete_policy))
        .route("/qa-ops/sample", post(run_sampling))
        .route("/qa-ops/assignments", get(list_assignments).post(create_assignment))
        .route("/qa-ops/assignments/:aid", patch(update_assignment))
        .route("/qa-ops/overview", get(overview))
        .route("/qa-ops/score-history/:interaction_id", get(score_history))
}

// ---------- rubric helpers ----------

fn criteria_values(criteria: &[Criterion]) -> Vec<Value> {
    criteria
        .iter()
        .map(|c| {
            Value::from(as_doc(json!( {
                "id": &c.id,
                "name": &c.name,
                "description": &c.description,
                "weight": c.weight,
                "type": &c.kind,
                "auto_fail": c.auto_fail,
            })))
        })
        .collect()
}

fn crit_key(c: &Map<String, Value>) -> (String, String, String, f64, String, bool) {
    (
        doc_str(c, "id"),
        doc_str(c, "name"),
        doc_str(c, "description"),
        doc_f64(c, "weight"),
        {
            let t = doc_str(c, "type");
            if t.is_empty() {
                "scale".to_string()
            } else {
                t
            }
        },
        doc_bool(c, "auto_fail"),
    )
}

fn form_changed(old: &Document, body: &FormIn) -> bool {
    if doc_str(old, "name") != body.name
        || doc_str(old, "description") != body.description
        || doc_str(old, "channel") != body.channel
    {
        return true;
    }
    let old_keys: Vec<_> = doc_array(old, "criteria")
        .iter()
        .filter_map(|c| c.as_object())
        .map(crit_key)
        .collect();
    let new_keys: Vec<_> = body
        .criteria
        .iter()
        .map(|c| {
            (
                c.id.clone(),
                c.name.clone(),
                c.description.clone(),
                c.weight,
                if c.kind.is_empty() { "scale".to_string() } else { c.kind.clone() },
                c.auto_fail,
            )
        })
        .collect();
    old_keys != new_keys
}

pub async fn snapshot_form(
    db: &crate::db::Db,
    form: &Document,
    member: &Document,
    change_note: &str,
) -> ApiResult<Document> {
    let criteria: Vec<Value> = doc_array(form, "criteria")
        .iter()
        .filter_map(|c| c.as_object())
        .map(|c| {
            Value::from(as_doc(json!( {
                "id": c.get("id").cloned().unwrap_or(Value::Null),
                "name": c.get("name").cloned().unwrap_or(Value::Null),
                "description": c.get("description").cloned().unwrap_or(Value::Null),
                "weight": c.get("weight").cloned().unwrap_or(Value::from(1.0)),
                "type": c.get("type").cloned().unwrap_or_else(|| Value::String("scale".into())),
                "auto_fail": c.get("auto_fail").cloned().unwrap_or(Value::Bool(false)),
            })))
        })
        .collect();
    let snapshot = as_doc(json!( {
        "id": new_id(),
        "form_id": doc_str(form, "id"),
        "version": doc_i64(form, "version").max(1),
        "name": doc_str(form, "name"),
        "description": doc_str(form, "description"),
        "channel": doc_str(form, "channel"),
        "criteria": criteria,
        "change_note": change_note,
        "created_by": doc_str(member, "user_id"),
        "created_by_name": doc_str(member, "name"),
        "created_at": now(),
    }));
    db::insert(db, "qa_form_versions", snapshot.clone()).await?;
    Ok(snapshot)
}

// ---------- QA forms ----------

async fn list_forms(State(st): State<AppState>) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "qa_forms",
            DbQuery::new(Document::new()).sort(as_doc(json!( { "created_at": 1 }))).limit(200),
        )
        .await?,
    ))
}

async fn create_form(
    State(st): State<AppState>,
    Qa(m): Qa,
    Json(body): Json<FormIn>,
) -> ApiResult<Json<Document>> {
    if body.criteria.is_empty() {
        return Err(AppError::bad("Add at least one criterion"));
    }
    let form = as_doc(json!( {
        "name": &body.name,
        "description": &body.description,
        "channel": &body.channel,
        "criteria": criteria_values(&body.criteria),
        "id": new_id(),
        "version": 1i32,
        "created_by": doc_str(&m, "user_id"),
        "created_at": now(),
        "updated_at": now(),
    }));
    db::insert(&st.db, "qa_forms", form.clone()).await?;
    snapshot_form(&st.db, &form, &m, "Initial version").await?;
    Ok(Json(form))
}

async fn update_form(
    State(st): State<AppState>,
    Qa(m): Qa,
    Path(form_id): Path<String>,
    Json(body): Json<FormIn>,
) -> ApiResult<Json<Document>> {
    let current = db::get_or_404(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await?;
    if body.criteria.is_empty() {
        return Err(AppError::bad("Add at least one criterion"));
    }
    let mut version = doc_i64(&current, "version").max(1);
    if form_changed(&current, &body) {
        snapshot_form(&st.db, &current, &m, "Before edit").await?;
        version += 1;
    }
    db::set_fields(
        &st.db,
        "qa_forms",
        as_doc(json!( { "id": &form_id })),
        as_doc(json!( {
            "name": &body.name,
            "description": &body.description,
            "channel": &body.channel,
            "criteria": criteria_values(&body.criteria),
            "version": version,
            "updated_at": now(),
        })),
    )
    .await?;
    Ok(Json(
        db::get_or_404(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await?,
    ))
}

async fn delete_form(State(st): State<AppState>, Qa(_m): Qa, Path(form_id): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn list_form_versions(
    State(st): State<AppState>,
    Qa(_m): Qa,
    Path(form_id): Path<String>,
) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "qa_form_versions",
            DbQuery::new(as_doc(json!( { "form_id": &form_id }))).sort(as_doc(json!( { "version": -1 }))).limit(200),
        )
        .await?,
    ))
}

async fn get_form_version(
    State(st): State<AppState>,
    Qa(_m): Qa,
    Path((form_id, vid)): Path<(String, String)>,
) -> ApiResult<Json<Document>> {
    Ok(Json(
        db::find_one(&st.db, "qa_form_versions", as_doc(json!( { "id": &vid, "form_id": &form_id })))
            .await?
            .ok_or_else(|| AppError::not_found("Version not found"))?,
    ))
}

async fn restore_form_version(
    State(st): State<AppState>,
    Qa(m): Qa,
    Path((form_id, vid)): Path<(String, String)>,
) -> ApiResult<Json<Document>> {
    let version = db::find_one(&st.db, "qa_form_versions", as_doc(json!( { "id": &vid, "form_id": &form_id })))
        .await?
        .ok_or_else(|| AppError::not_found("Version not found"))?;
    let form = db::find_one(&st.db, "qa_forms", as_doc(json!( { "id": &form_id })))
        .await?
        .ok_or_else(|| AppError::not_found("Form not found"))?;
    snapshot_form(&st.db, &form, &m, &format!("Before restoring v{}", doc_i64(&version, "version"))).await?;
    let next = doc_i64(&form, "version").max(1) + 1;
    db::set_fields(
        &st.db,
        "qa_forms",
        as_doc(json!( { "id": &form_id })),
        as_doc(json!( {
            "name": version.get("name").cloned().unwrap_or(Value::Null),
            "description": version.get("description").cloned().unwrap_or(Value::Null),
            "channel": version.get("channel").cloned().unwrap_or(Value::Null),
            "criteria": version.get("criteria").cloned().unwrap_or(Value::Array(vec![])),
            "version": next,
            "updated_at": now(),
        })),
    )
    .await?;
    Ok(Json(
        db::get_or_404(&st.db, "qa_forms", as_doc(json!( { "id": &form_id }))).await?,
    ))
}

// ---------- sampling policies ----------

fn period_start(period: &str) -> String {
    let days = PERIOD_DAYS
        .iter()
        .find(|(name, _)| *name == period)
        .map(|(_, d)| *d)
        .unwrap_or(30);
    (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}

fn sla_state(a: &Document) -> &'static str {
    let status = doc_str(a, "status");
    let due = doc_str(a, "due_at");
    if status == "cancelled" {
        return "n/a";
    }
    if status == "completed" {
        if due.is_empty() {
            return "met";
        }
        return if doc_str(a, "completed_at") <= due { "met" } else { "missed" };
    }
    if due.is_empty() {
        return "unscheduled";
    }
    let Some(due_at) = parse_iso(&due) else {
        return "unscheduled";
    };
    let left = (due_at - chrono::Utc::now()).num_seconds();
    if left < 0 {
        "overdue"
    } else if left < 24 * 3600 {
        "due_soon"
    } else {
        "on_track"
    }
}

fn assigned_view(a: &Document) -> Document {
    let mut out = a.clone();
    out.insert("sla".to_string(), sla_state(a));
    out
}

fn validate_policy(body: &PolicyIn) -> ApiResult<()> {
    if !PERIOD_DAYS.iter().any(|(p, _)| *p == body.period) {
        return Err(AppError::bad("Period must be daily, weekly or monthly"));
    }
    if body.channel != "all" && !CHANNELS.contains(&body.channel.as_str()) {
        return Err(AppError::bad("Unknown channel"));
    }
    if body.target_per_agent < 0 || body.target_per_agent > 200 {
        return Err(AppError::bad("Target per agent must be between 0 and 200"));
    }
    if body.sla_days < 1 || body.sla_days > 60 {
        return Err(AppError::bad("SLA must be between 1 and 60 days"));
    }
    Ok(())
}

async fn list_policies(State(st): State<AppState>, Staff(_m): Staff) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "qa_sampling_policies",
            DbQuery::new(Document::new()).sort(as_doc(json!( { "created_at": 1 }))).limit(200),
        )
        .await?,
    ))
}

async fn create_policy(
    State(st): State<AppState>,
    Qa(m): Qa,
    Json(body): Json<PolicyIn>,
) -> ApiResult<Json<Document>> {
    validate_policy(&body)?;
    let policy = as_doc(json!( {
        "name": &body.name,
        "channel": &body.channel,
        "form_id": &body.form_id,
        "period": &body.period,
        "target_per_agent": body.target_per_agent,
        "sample_percent": body.sample_percent,
        "sla_days": body.sla_days,
        "include_flagged": body.include_flagged,
        "include_auto_fail": body.include_auto_fail,
        "active": body.active,
        "id": new_id(),
        "created_by": doc_str(&m, "user_id"),
        "created_by_name": doc_str(&m, "name"),
        "created_at": now(),
    }));
    db::insert(&st.db, "qa_sampling_policies", policy.clone()).await?;
    Ok(Json(policy))
}

async fn update_policy(
    State(st): State<AppState>,
    Qa(_m): Qa,
    Path(pid): Path<String>,
    Json(body): Json<PolicyIn>,
) -> ApiResult<Json<Document>> {
    validate_policy(&body)?;
    let res = db::set_fields(
        &st.db,
        "qa_sampling_policies",
        as_doc(json!( { "id": &pid })),
        as_doc(json!( {
            "name": &body.name,
            "channel": &body.channel,
            "form_id": &body.form_id,
            "period": &body.period,
            "target_per_agent": body.target_per_agent,
            "sample_percent": body.sample_percent,
            "sla_days": body.sla_days,
            "include_flagged": body.include_flagged,
            "include_auto_fail": body.include_auto_fail,
            "active": body.active,
            "updated_at": now(),
        })),
    )
    .await?;
    if res.matched_count == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(
        db::get_or_404(&st.db, "qa_sampling_policies", as_doc(json!( { "id": &pid }))).await?,
    ))
}

async fn delete_policy(State(st): State<AppState>, Qa(_m): Qa, Path(pid): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "qa_sampling_policies", as_doc(json!( { "id": &pid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- assignments ----------

fn as_value_list(values: &[&str]) -> Vec<Value> {
    values.iter().map(|s| Value::String(s.to_string())).collect()
}

async fn evaluators(db: &crate::db::Db, env: &str) -> ApiResult<Vec<Document>> {
    Ok(db::find(
        db,
        "users",
        DbQuery::new(as_doc(json!( {
            "env": { "$in": [env, Value::Null] },
            "disabled": { "$ne": true },
            "role": { "$in": as_value_list(&EVALUATOR_ROLES) },
        })))
        .project(as_doc(json!( { "user_id": 1, "name": 1, "role": 1 })))
        .limit(200),
    )
    .await?)
}

async fn evaluator_load(db: &crate::db::Db) -> ApiResult<HashMap<String, i64>> {
    let docs = db::find(
        db,
        "qa_assignments",
        DbQuery::new(as_doc(json!( { "status": { "$in": as_value_list(&OPEN_STATES) } })))
            .project(as_doc(json!( { "evaluator_id": 1 }))),
    )
    .await?;
    let mut load: HashMap<String, i64> = HashMap::new();
    for d in docs {
        *load.entry(doc_str(&d, "evaluator_id")).or_insert(0) += 1;
    }
    Ok(load)
}

fn due_in(days: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(days.max(1)))
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}

async fn new_assignment(
    db: &crate::db::Db,
    member: &Document,
    it: &Document,
    evaluator: &Document,
    source: &str,
    sla_days: i64,
    note: &str,
) -> ApiResult<Document> {
    let score = it.get("overall_score").cloned().unwrap_or(Value::Null);
    let entry = as_doc(json!( {
        "id": new_id(),
        "interaction_id": doc_str(it, "id"),
        "agent_id": doc_str(it, "agent_id"),
        "agent_name": doc_str(it, "agent_name"),
        "channel": doc_str(it, "channel"),
        "form_id": doc_str(it, "form_id"),
        "form_name": doc_str(it, "form_name"),
        "score_at_assignment": score,
        "evaluator_id": doc_str(evaluator, "user_id"),
        "evaluator_name": doc_str(evaluator, "name"),
        "status": "pending",
        "source": source,
        "due_at": due_in(sla_days),
        "assigned_by": doc_str(member, "user_id"),
        "assigned_by_name": doc_str(member, "name"),
        "assigned_at": now(),
        "note": note,
        "completed_at": "",
        "outcome": "",
        "review_note": "",
    }));
    db::insert(db, "qa_assignments", entry.clone()).await?;
    Ok(entry)
}

async fn run_sampling(
    State(st): State<AppState>,
    Qa(member): Qa,
    Json(body): Json<RunPolicyIn>,
) -> ApiResult<Json<Value>> {
    let policy = db::find_one(&st.db, "qa_sampling_policies", as_doc(json!( { "id": &body.policy_id })))
        .await?
        .ok_or_else(|| AppError::not_found("Sampling policy not found"))?;
    let evaluators = evaluators(&st.db, st.env_name()).await?;
    if evaluators.is_empty() {
        return Err(AppError::bad("Add a QA auditor, team lead or admin before sampling"));
    }
    let start = period_start(&doc_str(&policy, "period"));
    let mut filter = as_doc(json!( { "status": "scored", "created_at": { "$gte": &start } }));
    let channel = doc_str(&policy, "channel");
    if channel != "all" {
        filter.insert("channel".to_string(), channel);
    }
    let form_id = doc_str(&policy, "form_id");
    if !form_id.is_empty() {
        filter.insert("form_id".to_string(), form_id);
    }
    let items = db::find(
        &st.db,
        "interactions",
        DbQuery::new(filter)
            .project(as_doc(json!( { "transcript": 0, "segments": 0, "criteria_results": 0 })))
            .limit(5000),
    )
    .await?;

    let assigned: HashSet<String> = db::distinct(
        &st.db,
        "qa_assignments",
        "interaction_id",
        as_doc(json!( { "assigned_at": { "$gte": &start }, "status": { "$ne": "cancelled" } })),
    )
    .await?
    .iter()
    .filter_map(|b| b.as_str().map(|s| s.to_string()))
    .collect();

    let mut per_agent: HashMap<String, i64> = HashMap::new();
    for a in db::find(
        &st.db,
        "qa_assignments",
        DbQuery::new(as_doc(json!( { "assigned_at": { "$gte": &start }, "status": { "$ne": "cancelled" } })))
            .project(as_doc(json!( { "agent_id": 1 }))),
    )
    .await?
    {
        *per_agent.entry(doc_str(&a, "agent_id")).or_insert(0) += 1;
    }

    let fresh: Vec<Document> = items
        .into_iter()
        .filter(|i| !assigned.contains(&doc_str(i, "id")))
        .collect();

    let include_flagged = doc_bool(&policy, "include_flagged");
    let include_auto_fail = doc_bool(&policy, "include_auto_fail");
    let mut targeted: Vec<Document> = Vec::new();
    let mut rest: Vec<Document> = Vec::new();
    for i in fresh.iter() {
        let flagged = !doc_array(i, "compliance_flags").is_empty() && include_flagged;
        let failed = doc_bool(i, "auto_failed") && include_auto_fail;
        let low = i
            .get("overall_score")
            .and_then(|v| v.as_f64())
            .map(|v| v < 70.0)
            .unwrap_or(true);
        if flagged || failed || low {
            targeted.push(i.clone());
        } else {
            rest.push(i.clone());
        }
    }
    let pct = if policy.contains_key("sample_percent") { doc_f64(&policy, "sample_percent") } else { 10.0 };
    let cut = ((fresh.len() as f64) * pct / 100.0).round().max(0.0) as usize;
    let mut picks: Vec<Document> = targeted.clone();
    if cut > 0 && !rest.is_empty() {
        let mut rng = rand::thread_rng();
        picks.extend(rest.choose_multiple(&mut rng, cut.min(rest.len())).cloned());
    }
    let targeted_ids: HashSet<String> = targeted.iter().map(|i| doc_str(i, "id")).collect();

    let mut load = evaluator_load(&st.db).await?;
    let cap = if policy.contains_key("target_per_agent") { doc_i64(&policy, "target_per_agent") } else { 4 };
    let sla_days = if policy.contains_key("sla_days") { doc_i64(&policy, "sla_days") } else { 3 };
    let mut created: Vec<Document> = Vec::new();
    for it in picks.iter() {
        let is_targeted = targeted_ids.contains(&doc_str(it, "id"));
        let agent_key = {
            let id = doc_str(it, "agent_id");
            if id.is_empty() {
                doc_str(it, "agent_name")
            } else {
                id
            }
        };
        if cap > 0 && !is_targeted && per_agent.get(&agent_key).copied().unwrap_or(0) >= cap {
            continue;
        }
        let mut best = &evaluators[0];
        let mut best_load = load.get(&doc_str(best, "user_id")).copied().unwrap_or(0);
        for e in evaluators.iter().skip(1) {
            let l = load.get(&doc_str(e, "user_id")).copied().unwrap_or(0);
            if l < best_load {
                best = e;
                best_load = l;
            }
        }
        *load.entry(doc_str(best, "user_id")).or_insert(0) += 1;
        *per_agent.entry(agent_key).or_insert(0) += 1;
        let source = if is_targeted { "targeted" } else { "random" };
        created.push(new_assignment(&st.db, &member, it, best, source, sla_days, "").await?);
    }

    Ok(Json(json!({
        "created": created.len(),
        "considered": fresh.len(),
        "targeted": targeted.len(),
        "assignments": created.iter().map(assigned_view).collect::<Vec<_>>(),
    })))
}

async fn create_assignment(
    State(st): State<AppState>,
    Staff(member): Staff,
    Json(body): Json<AssignmentIn>,
) -> ApiResult<Json<Document>> {
    let it = db::find_one(&st.db, "interactions", as_doc(json!( { "id": &body.interaction_id })))
        .await?
        .ok_or_else(|| AppError::not_found("Interaction not found"))?;
    let evaluator = if !body.evaluator_id.is_empty() {
        let e = db::find_one(
            &st.db,
            "users",
            as_doc(json!( { "user_id": &body.evaluator_id, "env": { "$in": [st.env_name(), Value::Null] } })),
        )
        .await?
        .ok_or_else(|| AppError::bad("Evaluate must be a QA auditor, team lead or admin"))?;
        if !EVALUATOR_ROLES.contains(&effective_role(e.get("role")).as_str()) {
            return Err(AppError::bad(
                "Evaluate must be a QA auditor, team lead or admin",
            ));
        }
        e
    } else {
        let candidates = evaluators(&st.db, st.env_name()).await?;
        if candidates.is_empty() {
            return Err(AppError::bad("Add an evaluator first"));
        }
        let load = evaluator_load(&st.db).await?;
        let mut best = candidates[0].clone();
        let mut best_load = load.get(&doc_str(&best, "user_id")).copied().unwrap_or(0);
        for e in candidates.iter().skip(1) {
            let l = load.get(&doc_str(e, "user_id")).copied().unwrap_or(0);
            if l < best_load {
                best = e.clone();
                best_load = l;
            }
        }
        best
    };
    let exists = db::find_one(
        &st.db,
        "qa_assignments",
        as_doc(json!( { "interaction_id": doc_str(&it, "id"), "status": { "$in": as_value_list(&OPEN_STATES) } })),
    )
    .await?;
    if exists.is_some() {
        return Err(AppError::conflict("This interaction is already in the review queue"));
    }
    let a = new_assignment(
        &st.db,
        &member,
        &it,
        &evaluator,
        "manual",
        body.sla_days,
        body.note.trim(),
    )
    .await?;
    Ok(Json(assigned_view(&a)))
}

#[derive(Debug, Deserialize)]
struct AssignmentQuery {
    #[serde(default)]
    status: String,
    #[serde(default)]
    mine: bool,
}

async fn list_assignments(
    State(st): State<AppState>,
    Staff(m): Staff,
    QueryParams(q): QueryParams<AssignmentQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    let mut filter = Document::new();
    if !q.status.is_empty() {
        filter.insert("status".to_string(), q.status);
    }
    if q.mine {
        filter.insert("evaluator_id".to_string(), doc_str(&m, "user_id"));
    }
    let docs = db::find(
        &st.db,
        "qa_assignments",
        DbQuery::new(filter).sort(as_doc(json!( { "due_at": 1 }))).limit(1000),
    )
    .await?;
    Ok(Json(docs.iter().map(assigned_view).collect()))
}

async fn update_assignment(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(aid): Path<String>,
    Json(body): Json<CompleteIn>,
) -> ApiResult<Json<Document>> {
    let a = db::find_one(&st.db, "qa_assignments", as_doc(json!( { "id": &aid })))
        .await?
        .ok_or_else(|| AppError::not_found("Not found"))?;
    let me = doc_str(&m, "user_id");
    if me != doc_str(&a, "evaluator_id") && me != doc_str(&a, "assigned_by") && role_of_staff(&m) != "admin" {
        return Err(AppError::forbidden(
            "Only the evaluator or an admin can update this task",
        ));
    }
    if !["pending", "in_progress", "completed", "cancelled"].contains(&body.status.as_str()) {
        return Err(AppError::bad("Unknown status"));
    }
    if !body.outcome.is_empty() && !["confirmed", "flagged", "coached"].contains(&body.outcome.as_str()) {
        return Err(AppError::bad("Unknown outcome"));
    }
    let mut set = as_doc(json!( {
        "status": &body.status,
        "review_note": body.note.trim(),
        "outcome": &body.outcome,
    }));
    if body.status == "completed" {
        set.insert("completed_at".to_string(), now());
    }
    db::set_fields(&st.db, "qa_assignments", as_doc(json!( { "id": &aid })), set).await?;
    let updated = db::get_or_404(&st.db, "qa_assignments", as_doc(json!( { "id": &aid }))).await?;
    Ok(Json(assigned_view(&updated)))
}

fn role_of_staff(m: &Document) -> String {
    effective_role(m.get("role"))
}

#[derive(Debug, Deserialize)]
struct PeriodQuery {
    #[serde(default = "default_monthly")]
    period: String,
}

fn default_monthly() -> String {
    "monthly".to_string()
}

async fn overview(
    State(st): State<AppState>,
    Staff(_m): Staff,
    QueryParams(q): QueryParams<PeriodQuery>,
) -> ApiResult<Json<Value>> {
    let start = period_start(&q.period);
    let total = db::count(
        &st.db,
        "interactions",
        as_doc(json!( { "status": "scored", "created_at": { "$gte": &start } })),
    )
    .await?;
    let assigns = db::find(
        &st.db,
        "qa_assignments",
        DbQuery::new(as_doc(json!( { "assigned_at": { "$gte": &start } }))).limit(20000),
    )
    .await?;
    let live: Vec<Document> = assigns
        .into_iter()
        .filter(|a| doc_str(a, "status") != "cancelled")
        .collect();
    let covered: HashSet<String> = live.iter().map(|a| doc_str(a, "interaction_id")).collect();
    let policy = db::find(
        &st.db,
        "qa_sampling_policies",
        DbQuery::new(as_doc(json!( { "active": true }))).sort(as_doc(json!( { "created_at": 1 }))).limit(1),
    )
    .await?
    .into_iter()
    .next();
    let target = policy
        .as_ref()
        .map(|p| doc_i64(p, "target_per_agent"))
        .unwrap_or(0);

    let mut agents: Vec<Document> = Vec::new();
    for u in db::find(
        &st.db,
        "users",
        DbQuery::new(as_doc(json!( {
            "env": { "$in": [st.env_name(), Value::Null] },
            "role": "agent",
            "disabled": { "$ne": true },
        })))
        .project(as_doc(json!( { "user_id": 1, "name": 1 })))
        .limit(2000),
    )
    .await?
    {
        agents.push(as_doc(json!( {
            "agent_name": doc_str(&u, "name"),
            "agent_id": doc_str(&u, "user_id"),
            "assigned": 0i64,
            "completed": 0i64,
        })));
    }
    let find_agent = |rows: &mut Vec<Document>, key: &str, id: &str| -> usize {
        if let Some(i) = rows.iter().position(|r| doc_str(r, "agent_name") == key) {
            return i;
        }
        rows.push(as_doc(json!( {
            "agent_name": if key.is_empty() { "—" } else { key },
            "agent_id": id,
            "assigned": 0i64,
            "completed": 0i64,
        })));
        rows.len() - 1
    };
    for a in live.iter() {
        let key = doc_str(a, "agent_name");
        let idx = find_agent(&mut agents, &key, &doc_str(a, "agent_id"));
        let assigned = doc_i64(&agents[idx], "assigned") + 1;
        let completed = doc_i64(&agents[idx], "completed")
            + if doc_str(a, "status") == "completed" { 1 } else { 0 };
        agents[idx].insert("assigned".to_string(), assigned);
        agents[idx].insert("completed".to_string(), completed);
    }
    for row in agents.iter_mut() {
        let completed = doc_i64(row, "completed");
        row.insert("target".to_string(), target);
        row.insert(
            "coverage",
            if target > 0 {
                round1(100.0 * completed as f64 / target as f64)
            } else {
                0.0
            },
        );
    }
    agents.sort_by(|a, b| {
        doc_f64(a, "coverage")
            .partial_cmp(&doc_f64(b, "coverage"))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| doc_str(a, "agent_name").cmp(&doc_str(b, "agent_name")))
    });
    agents.truncate(200);

    let mut workload: Vec<Document> = Vec::new();
    for a in live.iter() {
        let key = doc_str(a, "evaluator_id");
        let idx = match workload.iter().position(|r| doc_str(r, "evaluator_id") == key) {
            Some(i) => i,
            None => {
                workload.push(as_doc(json!( {
                    "evaluator_id": &key, "name": doc_str(a, "evaluator_name"),
                    "pending": 0i64, "in_progress": 0i64, "completed": 0i64, "overdue": 0i64,
                })));
                workload.len() - 1
            }
        };
        let row = &mut workload[idx];
        let status = doc_str(a, "status");
        let field = match status.as_str() {
            "pending" => "pending",
            "in_progress" => "in_progress",
            "completed" => "completed",
            _ => "",
        };
        if !field.is_empty() {
            let v = doc_i64(row, field) + 1;
            row.insert(field, v);
        }
        if ["overdue", "missed"].contains(&sla_state(a)) {
            let v = doc_i64(row, "overdue") + 1;
            row.insert("overdue".to_string(), v);
        }
        row.insert("name".to_string(), doc_str(a, "evaluator_name"));
    }
    let workload_out: Vec<Value> = workload
        .iter()
        .map(|w| {
            let mut copy = w.clone();
            copy.insert(
                "open",
                doc_i64(w, "pending") + doc_i64(w, "in_progress"),
            );
            to_json(&copy)
        })
        .collect();

    let done: Vec<&Document> = live
        .iter()
        .filter(|a| doc_str(a, "status") == "completed")
        .collect();
    let met = done.iter().filter(|a| sla_state(*a) == "met").count();
    let statuses = as_doc(json!({
        "pending": live.iter().filter(|a| doc_str(a, "status") == "pending").count(),
        "in_progress": live.iter().filter(|a| doc_str(a, "status") == "in_progress").count(),
        "completed": live.iter().filter(|a| doc_str(a, "status") == "completed").count(),
    }));

    Ok(Json(json!({
        "period": q.period,
        "period_start": start,
        "target_per_agent": target,
        "policy": policy.as_ref().map(to_json),
        "kpis": {
            "evaluated": total,
            "assigned": live.len(),
            "coverage": if total > 0 { round1(100.0 * covered.len() as f64 / total as f64) } else { 0.0 },
            "pending": live.iter().filter(|a| OPEN_STATES.contains(&doc_str(a, "status").as_str())).count(),
            "overdue": live.iter().filter(|a| ["overdue", "missed"].contains(&sla_state(*a))).count(),
            "sla_met": if done.is_empty() { 0.0 } else { round1(100.0 * met as f64 / done.len() as f64) },
            "completed": done.len(),
        },
        "statuses": statuses,
        "by_agent": agents.iter().map(to_json).collect::<Vec<_>>(),
        "workload": workload_out,
    })))
}

async fn score_history(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(interaction_id): Path<String>,
) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "score_audit",
            DbQuery::new(as_doc(json!( { "interaction_id": &interaction_id })))
                .sort(as_doc(json!( { "at": 1 })))
                .limit(200),
        )
        .await?,
    ))
}

pub async fn record_score_change(
    db: &crate::db::Db,
    interaction_id: &str,
    old: f64,
    new: f64,
    source: &str,
    member: &Document,
    note: &str,
) -> ApiResult<Document> {
    let note: String = note.chars().take(2000).collect();
    let entry = as_doc(json!( {
        "id": new_id(),
        "interaction_id": interaction_id,
        "old_score": old,
        "new_score": new,
        "source": source,
        "note": &note,
        "by": doc_str(member, "user_id"),
        "by_name": doc_str(member, "name"),
        "at": now(),
    }));
    db::insert(db, "score_audit", entry.clone()).await?;
    db::update(
        db,
        "interactions",
        as_doc(json!( { "id": interaction_id })),
        as_doc(json!( { "$push": { "score_history": entry.clone() } })),
    )
    .await?;
    Ok(entry)
}
