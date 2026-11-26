//! Decision trees, training (LMS), coaching and the analytics dashboard.

use crate::ai;
use crate::auth::{agent_scope, is_staff, Member, Staff};
use crate::db::{self, Query as DbQuery};
use crate::error::{ApiResult, AppError};
use crate::models::*;
use crate::state::AppState;
use crate::util::*;
use axum::extract::{Path, State};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use crate::util::{Document, as_doc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/trees", get(list_trees).post(create_tree))
        .route("/trees/generate", post(generate_tree))
        .route("/trees/:tid", get(get_tree).put(update_tree).delete(delete_tree))
        .route("/trees/:tid/run", post(run_tree))
        .route("/courses", get(list_courses).post(create_course))
        .route("/courses/generate-quiz", post(gen_quiz))
        .route("/courses/:cid", get(get_course).put(update_course).delete(delete_course))
        .route("/courses/:cid/attempt", post(attempt))
        .route("/attempts", get(attempts))
        .route("/coaching", get(list_coaching).post(create_coaching))
        .route("/coaching/:cid", put(update_coaching).delete(delete_coaching))
        .route("/coaching/:cid/items/:idx", patch(toggle_item))
        .route("/dashboard", get(dashboard))
}

// ---------- decision trees ----------

fn tree_doc(body: &TreeIn) -> Document {
    as_doc(json!( {
        "title": body.title.trim(),
        "description": &body.description,
        "category": &body.category,
        "start_node": &body.start_node,
        "nodes": body.nodes.iter().map(|n| Value::from(as_doc(json!( {
            "id": &n.id,
            "title": &n.title,
            "text": &n.text,
            "script": &n.script,
            "options": n.options.iter().map(|o| Value::from(as_doc(json!( {
                "label": &o.label,
                "next": &o.next,
            })))).collect::<Vec<_>>(),
        })))).collect::<Vec<_>>(),
    }))
}

fn validate_tree(body: &TreeIn) -> ApiResult<()> {
    let ids: Vec<&str> = body.nodes.iter().map(|n| n.id.as_str()).collect();
    if !ids.contains(&body.start_node.as_str()) {
        return Err(AppError::bad("Start step must be one of the steps"));
    }
    for node in &body.nodes {
        for option in &node.options {
            if !ids.contains(&option.next.as_str()) {
                return Err(AppError::bad(format!(
                    "Option '{}' in '{}' points to a missing step",
                    option.label, node.title
                )));
            }
        }
    }
    Ok(())
}

async fn list_trees(State(st): State<AppState>) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "trees",
            DbQuery::new(Document::new()).sort(as_doc(json!( { "created_at": -1 }))).limit(300),
        )
        .await?,
    ))
}

async fn get_tree(State(st): State<AppState>, Path(tid): Path<String>) -> ApiResult<Json<Document>> {
    Ok(Json(db::get_or_404(&st.db, "trees", as_doc(json!( { "id": &tid }))).await?))
}

async fn create_tree(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<TreeIn>,
) -> ApiResult<Json<Document>> {
    validate_tree(&body)?;
    let mut entry = tree_doc(&body);
    entry.insert("id".to_string(), new_id());
    entry.insert("runs".to_string(), 0i32);
    entry.insert("created_by".to_string(), doc_str(&m, "user_id"));
    entry.insert("created_at".to_string(), now());
    db::insert(&st.db, "trees", entry.clone()).await?;
    Ok(Json(entry))
}

async fn update_tree(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(tid): Path<String>,
    Json(body): Json<TreeIn>,
) -> ApiResult<Json<Document>> {
    db::get_or_404(&st.db, "trees", as_doc(json!( { "id": &tid }))).await?;
    validate_tree(&body)?;
    db::set_fields(&st.db, "trees", as_doc(json!( { "id": &tid })), tree_doc(&body)).await?;
    Ok(Json(db::get_or_404(&st.db, "trees", as_doc(json!( { "id": &tid }))).await?))
}

async fn delete_tree(State(st): State<AppState>, Staff(_m): Staff, Path(tid): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "trees", as_doc(json!( { "id": &tid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn run_tree(State(st): State<AppState>, Path(tid): Path<String>) -> ApiResult<Json<Value>> {
    db::get_or_404(&st.db, "trees", as_doc(json!( { "id": &tid }))).await?;
    db::update(
        &st.db,
        "trees",
        as_doc(json!( { "id": &tid })),
        as_doc(json!( { "$inc": { "runs": 1i32 } })),
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn generate_tree(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<GenTreeIn>,
) -> ApiResult<Json<Document>> {
    if body.sop.trim().len() < 20 {
        return Err(AppError::bad("Paste at least 20 characters of SOP"));
    }
    let generated = ai::generate_tree(&st, &body.title, &body.sop)
        .await
        .map_err(|e| AppError::upstream(format!("AI could not build the tree: {}", e.detail.chars().take(120).collect::<String>())))?;
    let tree: TreeIn = serde_json::from_value(Value::from(as_doc(json!({
        "title": body.title,
        "description": "Generated from SOP",
        "category": "",
        "start_node": generated.get("start_node").cloned().unwrap_or(Value::String("n1".into())),
        "nodes": generated.get("nodes").cloned().unwrap_or(Value::Array(vec![])),
    }))))
    .map_err(|_| AppError::upstream("AI returned an unusable tree"))?;
    validate_tree(&tree)?;
    let mut entry = tree_doc(&tree);
    entry.insert("id".to_string(), new_id());
    entry.insert("runs".to_string(), 0i32);
    entry.insert("created_by".to_string(), doc_str(&m, "user_id"));
    entry.insert("created_at".to_string(), now());
    db::insert(&st.db, "trees", entry.clone()).await?;
    Ok(Json(entry))
}

// ---------- training ----------

fn course_doc(body: &CourseIn) -> Document {
    as_doc(json!( {
        "title": body.title.trim(),
        "description": &body.description,
        "category": &body.category,
        "pass_mark": body.pass_mark,
        "lessons": body.lessons.iter().map(|l| Value::from(as_doc(json!( {
            "title": &l.title, "content": &l.content, "article_id": &l.article_id,
        })))).collect::<Vec<_>>(),
        "quiz": body.quiz.iter().map(|q| Value::from(as_doc(json!( {
            "question": &q.question,
            "options": q.options.iter().map(|o| Value::String(o.clone())).collect::<Vec<_>>(),
            "answer_index": q.answer_index,
            "explanation": &q.explanation,
        })))).collect::<Vec<_>>(),
    }))
}

fn hide_answers(course: &Document, member: &Document) -> Document {
    if is_staff(member) {
        return course.clone();
    }
    let quiz: Vec<Value> = doc_array(course, "quiz")
        .iter()
        .filter_map(|q| q.as_object())
        .map(|q| {
            Value::from(as_doc(json!( {
                "question": doc_str(q, "question"),
                "options": q.get("options").cloned().unwrap_or(Value::Array(vec![])),
            })))
        })
        .collect();
    let mut out = course.clone();
    out.insert("quiz".to_string(), quiz);
    out
}

async fn list_courses(State(st): State<AppState>, Member(m): Member) -> ApiResult<Json<Vec<Value>>> {
    let courses = db::find(
        &st.db,
        "courses",
        DbQuery::new(Document::new()).sort(as_doc(json!( { "created_at": -1 }))).limit(300),
    )
    .await?;
    let mine = db::find(&st.db, "attempts", DbQuery::new(as_doc(json!( { "user_id": doc_str(&m, "user_id") }))).limit(5000)).await?;
    let mut best: HashMap<String, i64> = HashMap::new();
    for a in mine {
        let course_id = doc_str(&a, "course_id");
        let score = doc_i64(&a, "score");
        let entry = best.entry(course_id).or_insert(0);
        if score > *entry {
            *entry = score;
        }
    }
    Ok(Json(
        courses
            .iter()
            .map(|c| {
                let mut view = hide_answers(c, &m);
                if let Some(b) = best.get(&doc_str(c, "id")) {
                    view.insert("my_best".to_string(), *b);
                }
                to_json(&view)
            })
            .collect(),
    ))
}

async fn get_course(State(st): State<AppState>, Member(m): Member, Path(cid): Path<String>) -> ApiResult<Json<Document>> {
    let course = db::get_or_404(&st.db, "courses", as_doc(json!( { "id": &cid }))).await?;
    Ok(Json(hide_answers(&course, &m)))
}

async fn create_course(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<CourseIn>,
) -> ApiResult<Json<Document>> {
    validate_quiz(&body.quiz)?;
    let mut entry = course_doc(&body);
    entry.insert("id".to_string(), new_id());
    entry.insert("created_by".to_string(), doc_str(&m, "user_id"));
    entry.insert("created_at".to_string(), now());
    db::insert(&st.db, "courses", entry.clone()).await?;
    Ok(Json(entry))
}

fn validate_quiz(quiz: &[QuizQ]) -> ApiResult<()> {
    for q in quiz {
        if q.options.len() < 2 {
            return Err(AppError::bad("Every question needs at least two options"));
        }
        if q.answer_index < 0 || q.answer_index as usize >= q.options.len() {
            return Err(AppError::bad("answer_index must point to one of the options"));
        }
    }
    Ok(())
}

async fn update_course(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(cid): Path<String>,
    Json(body): Json<CourseIn>,
) -> ApiResult<Json<Document>> {
    db::get_or_404(&st.db, "courses", as_doc(json!( { "id": &cid }))).await?;
    validate_quiz(&body.quiz)?;
    db::set_fields(&st.db, "courses", as_doc(json!( { "id": &cid })), course_doc(&body)).await?;
    Ok(Json(db::get_or_404(&st.db, "courses", as_doc(json!( { "id": &cid }))).await?))
}

async fn delete_course(State(st): State<AppState>, Staff(_m): Staff, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "courses", as_doc(json!( { "id": &cid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn gen_quiz(State(st): State<AppState>, Staff(_m): Staff, Json(body): Json<GenQuizIn>) -> ApiResult<Json<Vec<Value>>> {
    if body.content.trim().len() < 20 {
        return Err(AppError::bad("Paste at least 20 characters of material"));
    }
    if !(1..=15).contains(&body.count) {
        return Err(AppError::bad("Ask for between 1 and 15 questions"));
    }
    let questions = ai::generate_quiz(&st, &body.content, body.count)
        .await
        .map_err(|e| AppError::upstream(format!("AI could not create the quiz: {}", e.detail.chars().take(120).collect::<String>())))?;
    Ok(Json(questions))
}

async fn attempt(
    State(st): State<AppState>,
    Member(m): Member,
    Path(cid): Path<String>,
    Json(body): Json<AttemptIn>,
) -> ApiResult<Json<Value>> {
    let course = db::get_or_404(&st.db, "courses", as_doc(json!( { "id": &cid }))).await?;
    let quiz = doc_array(&course, "quiz");
    if quiz.is_empty() || body.answers.len() != quiz.len() {
        return Err(AppError::bad("Answer every question"));
    }
    let mut correct = 0;
    let mut review = Vec::new();
    for (i, q) in quiz.iter().enumerate() {
        let q = q.as_object().cloned().unwrap_or_default();
        let answer_index = doc_i64(&q, "answer_index");
        let chosen = body.answers[i];
        if answer_index == chosen {
            correct += 1;
        }
        review.push(as_doc(json!({
            "answer_index": answer_index,
            "explanation": doc_str(&q, "explanation"),
            "chosen": chosen,
        })));
    }
    let total = quiz.len() as i64;
    let score = ((100.0 * correct as f64 / total as f64).round()) as i64;
    let pass_mark = if course.contains_key("pass_mark") { doc_i64(&course, "pass_mark") } else { 70 };
    let entry = as_doc(json!( {
        "id": new_id(),
        "course_id": &cid,
        "course_title": doc_str(&course, "title"),
        "user_id": doc_str(&m, "user_id"),
        "user_name": doc_str(&m, "name"),
        "score": score,
        "correct": correct,
        "total": total,
        "passed": score >= pass_mark,
        "at": now(),
    }));
    db::insert(&st.db, "attempts", entry.clone()).await?;
    let mut out = to_json(&entry);
    if let Some(obj) = out.as_object_mut() {
        obj.insert(
            "review".into(),
            Value::Array(review.into_iter().map(|d| d.into_value()).collect()),
        );
    }
    Ok(Json(out))
}

async fn attempts(State(st): State<AppState>, Member(m): Member) -> ApiResult<Json<Vec<Document>>> {
    let scope = if is_staff(&m) {
        Document::new()
    } else {
        as_doc(json!( { "user_id": doc_str(&m, "user_id") }))
    };
    Ok(Json(
        db::find(
            &st.db,
            "attempts",
            DbQuery::new(scope).sort(as_doc(json!( { "at": -1 }))).limit(1000),
        )
        .await?,
    ))
}

// ---------- coaching ----------

async fn check_agent(st: &AppState, agent_id: &str) -> ApiResult<()> {
    if agent_id.is_empty() {
        return Ok(());
    }
    let found = db::find_one(
        &st.db,
        "users",
        as_doc(json!( { "user_id": agent_id, "env": { "$in": [st.env_name(), Value::Null] } })),
    )
    .await?;
    if found.is_none() {
        return Err(AppError::bad("Unknown agent account"));
    }
    Ok(())
}

fn coaching_doc(body: &CoachingIn) -> Document {
    as_doc(json!( {
        "agent_id": &body.agent_id,
        "agent_name": body.agent_name.trim(),
        "interaction_id": &body.interaction_id,
        "scheduled_for": &body.scheduled_for,
        "focus": body.focus.trim(),
        "notes": &body.notes,
        "status": &body.status,
        "action_items": body.action_items.iter().map(|a| Value::from(as_doc(json!( {
            "text": &a.text, "done": a.done,
        })))).collect::<Vec<_>>(),
        "article_ids": body.article_ids.iter().map(|i| Value::String(i.clone())).collect::<Vec<_>>(),
        "course_ids": body.course_ids.iter().map(|i| Value::String(i.clone())).collect::<Vec<_>>(),
    }))
}

async fn list_coaching(State(st): State<AppState>, Member(m): Member) -> ApiResult<Json<Vec<Document>>> {
    Ok(Json(
        db::find(
            &st.db,
            "coaching",
            DbQuery::new(agent_scope(&m)).sort(as_doc(json!( { "created_at": -1 }))).limit(500),
        )
        .await?,
    ))
}

async fn create_coaching(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<CoachingIn>,
) -> ApiResult<Json<Document>> {
    check_agent(&st, &body.agent_id).await?;
    let mut entry = coaching_doc(&body);
    entry.insert("id".to_string(), new_id());
    entry.insert("coach_id".to_string(), doc_str(&m, "user_id"));
    entry.insert("coach_name".to_string(), doc_str(&m, "name"));
    entry.insert("created_at".to_string(), now());
    db::insert(&st.db, "coaching", entry.clone()).await?;
    Ok(Json(entry))
}

async fn update_coaching(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(cid): Path<String>,
    Json(body): Json<CoachingIn>,
) -> ApiResult<Json<Document>> {
    db::get_or_404(&st.db, "coaching", as_doc(json!( { "id": &cid }))).await?;
    check_agent(&st, &body.agent_id).await?;
    db::set_fields(&st.db, "coaching", as_doc(json!( { "id": &cid })), coaching_doc(&body)).await?;
    Ok(Json(db::get_or_404(&st.db, "coaching", as_doc(json!( { "id": &cid }))).await?))
}

async fn toggle_item(
    State(st): State<AppState>,
    Member(m): Member,
    Path((cid, idx)): Path<(String, usize)>,
    Json(body): Json<ItemToggle>,
) -> ApiResult<Json<Document>> {
    let mut filter = as_doc(json!( { "id": &cid }));
    for (k, v) in agent_scope(&m) {
        filter.insert(k, v);
    }
    let doc_found = db::get_or_404(&st.db, "coaching", filter).await?;
    if idx >= doc_array(&doc_found, "action_items").len() {
        return Err(crate::error::not_found());
    }
    let mut set = Document::new();
    set.insert(format!("action_items.{idx}.done"), body.done);
    db::set_fields(&st.db, "coaching", as_doc(json!( { "id": &cid })), set).await?;
    Ok(Json(db::get_or_404(&st.db, "coaching", as_doc(json!( { "id": &cid }))).await?))
}

async fn delete_coaching(State(st): State<AppState>, Staff(_m): Staff, Path(cid): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "coaching", as_doc(json!( { "id": &cid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- dashboard ----------

async fn dashboard(State(st): State<AppState>, Member(m): Member) -> ApiResult<Json<Value>> {
    let scope = agent_scope(&m);
    let mut filter = as_doc(json!( { "status": "scored" }));
    for (k, v) in scope.clone() {
        filter.insert(k, v);
    }
    let items = db::find(
        &st.db,
        "interactions",
        DbQuery::new(filter).project(as_doc(json!( { "transcript": 0 }))).limit(5000),
    )
    .await?;
    let n = items.len();
    let mut trend: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut board: HashMap<String, (i64, Vec<f64>, i64, i64)> = HashMap::new();
    let mut crit: Vec<(String, Vec<f64>)> = Vec::new();
    for i in items.iter() {
        let created = doc_str(i, "created_at");
        trend
            .entry(short_date(&created))
            .or_default()
            .push(doc_f64(i, "overall_score"));
        let name = doc_str(i, "agent_name");
        let entry = board.entry(name).or_insert((0, Vec::new(), 0, 0));
        entry.0 += 1;
        entry.1.push(doc_f64(i, "overall_score"));
        entry.2 += doc_array(i, "compliance_flags").len() as i64;
        entry.3 += if doc_bool(i, "auto_failed") { 1 } else { 0 };
        for c in doc_array(i, "criteria_results").iter().filter_map(|c| c.as_object()) {
            let name = doc_str(c, "name");
            match crit.iter_mut().find(|(k, _)| *k == name) {
                Some((_, v)) => v.push(doc_f64(c, "score")),
                None => crit.push((name, vec![doc_f64(c, "score")])),
            }
        }
    }
    let mut leaderboard: Vec<Document> = board
        .iter()
        .map(|(name, (count, scores, flags, fails))| {
            as_doc(json!({
                "agent_name": name,
                "count": count,
                "avg_score": avg(scores),
                "flags": flags,
                "auto_fails": fails,
            }))
        })
        .collect();
    leaderboard.sort_by(|a, b| {
        b.get("avg_score")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .partial_cmp(&a.get("avg_score").and_then(|v| v.as_f64()).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let att_scope = if is_staff(&m) {
        Document::new()
    } else {
        as_doc(json!( { "user_id": doc_str(&m, "user_id") }))
    };
    let attempts = db::find(&st.db, "attempts", DbQuery::new(att_scope).limit(5000)).await?;

    let mut top_searches: Vec<Document> = Vec::new();
    if is_staff(&m) {
        let rows = db::find(&st.db, "kb_searches", DbQuery::new(Document::new())).await?;
        let mut tally: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for row in rows.iter() {
            let q = doc_str(row, "q");
            if !q.is_empty() {
                *tally.entry(q).or_insert(0) += 1;
            }
        }
        let mut pairs: Vec<(String, i64)> = tally.into_iter().collect();
        pairs.sort_by(|a, b| b.1.cmp(&a.1));
        top_searches = pairs
            .into_iter()
            .take(6)
            .map(|(q, count)| as_doc(json!({ "q": q, "count": count })))
            .collect();
    }
    let top_articles = db::find(
        &st.db,
        "articles",
        DbQuery::new(Document::new())
            .project(as_doc(json!( { "id": 1, "title": 1, "views": 1 })))
            .sort(as_doc(json!( { "views": -1 })))
            .limit(5),
    )
    .await?;

    let mut coaching_scope = as_doc(json!( { "status": { "$ne": "completed" } }));
    if !is_staff(&m) {
        coaching_scope.insert("agent_id".to_string(), doc_str(&m, "user_id"));
    }
    let mut counts = as_doc(json!( { "status": { "$in": ["transcribing", "scoring"] } }));
    for (k, v) in scope.clone() {
        counts.insert(k, v);
    }
    let mut open_disputes_filter = as_doc(json!( { "dispute.status": "open" }));
    for (k, v) in scope.clone() {
        open_disputes_filter.insert(k, v);
    }

    let mut sentiment_counts: Vec<(String, i64)> = Vec::new();
    for i in items.iter() {
        let s = {
            let v = doc_str(i, "sentiment");
            if v.is_empty() { "neutral".to_string() } else { v }
        };
        match sentiment_counts.iter_mut().find(|(k, _)| *k == s) {
            Some((_, c)) => *c += 1,
            None => sentiment_counts.push((s, 1)),
        }
    }
    let mut channel_counts: Vec<(String, i64)> = Vec::new();
    for i in items.iter() {
        let c = doc_str(i, "channel");
        match channel_counts.iter_mut().find(|(k, _)| *k == c) {
            Some((_, n)) => *n += 1,
            None => channel_counts.push((c, 1)),
        }
    }

    let attempts_n = attempts.len();
    let attempt_scores: Vec<f64> = attempts.iter().map(|a| doc_f64(a, "score")).collect();
    let passed = attempts.iter().filter(|a| doc_bool(*a, "passed")).count();
    let mut trend_rows: Vec<Document> = trend
        .iter()
        .map(|(d, s)| as_doc(json!({ "date": d, "score": avg(s) })))
        .collect();
    if trend_rows.len() > 14 {
        trend_rows = trend_rows.split_off(trend_rows.len() - 14);
    }
    let flag_rate = if n > 0 {
        round1(
            100.0
                * items
                    .iter()
                    .filter(|i| !doc_array(*i, "compliance_flags").is_empty() || doc_bool(*i, "auto_failed"))
                    .count() as f64
                / n as f64,
        )
    } else {
        0.0
    };

    Ok(Json(json!({
        "kpis": {
            "avg_score": avg(&items.iter().map(|i| doc_f64(i, "overall_score")).collect::<Vec<_>>()),
            "evaluated": n,
            "flag_rate": flag_rate,
            "csat": if n > 0 {
                round2(items.iter().map(|i| doc_f64(i, "csat_predicted")).sum::<f64>() / n as f64)
            } else { 0.0 },
            "pending": db::count(&st.db, "interactions", counts).await?,
            "open_coaching": db::count(&st.db, "coaching", coaching_scope).await?,
            "quiz_attempts": attempts_n,
            "quiz_avg": avg(&attempt_scores),
            "quiz_pass_rate": if attempts_n > 0 { round1(100.0 * passed as f64 / attempts_n as f64) } else { 0.0 },
            "articles": db::count(&st.db, "articles", Document::new()).await?,
            "open_disputes": db::count(&st.db, "interactions", open_disputes_filter).await?,
        },
        "sentiment": sentiment_counts.iter().map(|(k, v)| as_doc(json!({ "name": k, "value": v }))).collect::<Vec<_>>(),
        "channels": channel_counts.iter().map(|(k, v)| as_doc(json!({ "name": k, "value": v }))).collect::<Vec<_>>(),
        "trend": trend_rows,
        "criteria": crit.iter().map(|(k, v)| as_doc(json!({ "name": k, "score": avg(v) }))).collect::<Vec<_>>(),
        "leaderboard": leaderboard,
        "top_searches": top_searches,
        "top_articles": top_articles.iter().map(to_json).collect::<Vec<_>>(),
    })))
}
