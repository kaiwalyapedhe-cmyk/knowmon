//! Knowledge base: articles, search, AI answers and governance (lifecycle, versions,
//! feedback, audit trail).

use crate::ai;
use crate::auth::{is_staff, role_of, Member, Qa, Staff};
use crate::db::{self, Query as DbQuery};
use crate::error::{ApiResult, AppError};
use crate::models::{AskIn, ArticleIn, FeedbackIn, NoteIn, ReviewerIn};
use crate::state::AppState;
use crate::util::*;
use axum::extract::{Path, Query as QueryParams, State};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use crate::util::{Document, as_doc};

const ARTICLE_STATUSES: [&str; 5] = ["draft", "in_review", "approved", "published", "archived"];
const SNAPSHOT_FIELDS: [&str; 8] = [
    "title",
    "category",
    "summary",
    "content",
    "steps",
    "tags",
    "self_service",
    "allowed_roles",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/kb/articles", get(list_articles).post(create_article))
        .route("/kb/articles/:aid", get(get_article).put(update_article).delete(delete_article))
        .route("/kb/categories", get(categories))
        .route("/kb/ask", post(ask))
        .route("/kb/governance", get(governance))
        .route("/kb/articles/:aid/versions", get(list_versions))
        .route("/kb/articles/:aid/versions/:vid", get(get_version))
        .route("/kb/articles/:aid/versions/:vid/restore", post(restore_version))
        .route("/kb/articles/:aid/submit", post(submit_for_review))
        .route("/kb/articles/:aid/approve", post(approve))
        .route("/kb/articles/:aid/publish", post(publish))
        .route("/kb/articles/:aid/archive", post(archive))
        .route("/kb/articles/:aid/reopen", post(reopen))
        .route("/kb/articles/:aid/feedback", get(list_feedback).post(feedback))
        .route("/kb/articles/:aid/audit", get(article_audit_log))
        .route("/public/kb", get(public_articles))
        .route("/public/kb/:aid", get(public_article))
        .route("/public/ask", post(public_ask))
}

fn article_defaults(member: &Document) -> Document {
    as_doc(json!( {
        "status": "draft",
        "version": 1i32,
        "owner_id": doc_str(member, "user_id"),
        "owner_name": doc_str(member, "name"),
        "reviewer_id": "",
        "reviewer_name": "",
        "approver_id": "",
        "approver_name": "",
        "review_date": "",
        "expires_at": "",
        "allowed_roles": Vec::<Value>::new(),
        "published_at": "",
        "helpful_count": 0i32,
        "not_helpful_count": 0i32,
        "archived_at": "",
    }))
}

fn visible_to(article: &Document, member: &Document) -> bool {
    if is_staff(member) {
        return true;
    }
    let status = {
        let s = doc_str(article, "status");
        if s.is_empty() {
            "published".to_string()
        } else {
            s
        }
    };
    if status != "published" {
        return false;
    }
    let roles = doc_array(article, "allowed_roles");
    roles.is_empty() || roles.iter().any(|r| r.as_str() == Some(role_of(member).as_str()))
}

async fn article_audit(
    db: &crate::db::Db,
    aid: &str,
    action: &str,
    member: &Document,
    note: &str,
    extra: Option<Document>,
) -> ApiResult<()> {
    let mut entry = as_doc(json!( {
        "id": new_id(),
        "article_id": aid,
        "action": action,
        "note": note.chars().take(2000).collect::<String>(),
        "by": doc_str(member, "user_id"),
        "by_name": doc_str(member, "name"),
        "at": now(),
    }));
    if let Some(extra) = extra {
        for (k, v) in extra {
            entry.insert(k, v);
        }
    }
    db::insert(db, "kb_audit", entry).await
}

async fn snapshot_article(
    db: &crate::db::Db,
    article: &Document,
    member: &Document,
    note: &str,
) -> ApiResult<Document> {
    let mut snapshot = as_doc(json!( {
        "id": new_id(),
        "article_id": doc_str(article, "id"),
        "version": doc_i64(article, "version").max(1),
    }));
    for field in SNAPSHOT_FIELDS {
        snapshot.insert(field, article.get(field).cloned().unwrap_or(Value::Null));
    }
    snapshot.insert("note".to_string(), note);
    snapshot.insert("by".to_string(), doc_str(member, "user_id"));
    snapshot.insert("by_name".to_string(), doc_str(member, "name"));
    snapshot.insert("at".to_string(), now());
    db::insert(db, "article_versions", snapshot.clone()).await?;
    Ok(snapshot)
}

fn article_doc(body: &ArticleIn, defaults: Document) -> Document {
    let mut article = defaults;
    article.insert("title".to_string(), body.title.trim());
    article.insert("category".to_string(), body.category.trim());
    article.insert("summary".to_string(), &body.summary);
    article.insert("content".to_string(), &body.content);
    article.insert(
        "steps",
        body.steps
            .iter()
            .map(|s| {
                Value::from(as_doc(json!( { "title": &s.title, "body": &s.body, "image_url": &s.image_url })))
            })
            .collect::<Vec<_>>(),
    );
    article.insert(
        "tags",
        body.tags.iter().map(|t| Value::String(t.clone())).collect::<Vec<_>>(),
    );
    article.insert("self_service".to_string(), body.self_service);
    article.insert("review_date".to_string(), &body.review_date);
    article.insert("expires_at".to_string(), &body.expires_at);
    article.insert(
        "allowed_roles",
        body.allowed_roles.iter().map(|r| Value::String(r.clone())).collect::<Vec<_>>(),
    );
    article
}

fn escape_regex(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn article_query(q: &str, category: &str, extra: Document) -> Document {
    let mut query = extra;
    if !category.is_empty() {
        query.insert("category".to_string(), category);
    }
    if !q.is_empty() {
        let rx = Value::from(as_doc(json!( { "$regex": escape_regex(q), "$options": "i" })));
        query.insert(
            "$or",
            vec![
                as_doc(json!( { "title": rx.clone() })),
                as_doc(json!( { "content": rx.clone() })),
                as_doc(json!( { "tags": rx.clone() })),
                as_doc(json!( { "summary": rx.clone() })),
                as_doc(json!( { "steps.body": rx })),
            ],
        );
    }
    query
}

fn rank_articles(q: &str, arts: &[Document], k: usize) -> Vec<Document> {
    let words: Vec<String> = q
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| w.len() > 2)
        .map(|w| w.to_string())
        .collect();
    let mut scored: Vec<(usize, &Document)> = arts
        .iter()
        .map(|a| {
            let title = doc_str(a, "title").to_lowercase();
            let mut body = doc_str(a, "content");
            for tag in doc_array(a, "tags") {
                if let Some(t) = tag.as_str() {
                    body.push(' ');
                    body.push_str(t);
                }
            }
            for step in doc_array(a, "steps").iter().filter_map(|s| s.as_object()) {
                body.push(' ');
                body.push_str(&doc_str(step, "title"));
                body.push(' ');
                body.push_str(&doc_str(step, "body"));
            }
            let body = body.to_lowercase();
            let score: usize = words
                .iter()
                .map(|w| 3 * title.matches(w.as_str()).count() + body.matches(w.as_str()).count())
                .sum();
            (score, a)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .filter(|(s, _)| *s > 0)
        .take(k)
        .map(|(_, a)| a.clone())
        .collect()
}

#[derive(Debug, Deserialize)]
struct ArticleQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    status: String,
}

async fn list_articles(
    State(st): State<AppState>,
    Member(m): Member,
    QueryParams(q): QueryParams<ArticleQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    let search = q.q.trim().to_string();
    if !search.is_empty() {
        db::insert(
            &st.db,
            "kb_searches",
            as_doc(json!( {
                "q": search.to_lowercase().chars().take(100).collect::<String>(),
                "user_id": doc_str(&m, "user_id"),
                "at": now(),
            })),
        )
        .await?;
    }
    let mut query = article_query(&search, &q.category, Document::new());
    if is_staff(&m) {
        if !q.status.is_empty() {
            query.insert("status".to_string(), &q.status);
        }
    } else {
        query.insert("status".to_string(), "published");
    }
    let docs = db::find(
        &st.db,
        "articles",
        DbQuery::new(query).sort(as_doc(json!( { "updated_at": -1 }))).limit(500),
    )
    .await?;
    Ok(Json(docs.into_iter().filter(|d| visible_to(d, &m)).collect()))
}

async fn categories(State(st): State<AppState>) -> ApiResult<Json<Vec<String>>> {
    let mut values: Vec<String> = db::distinct(&st.db, "articles", "category", Document::new())
        .await?
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    values.sort();
    Ok(Json(values))
}

async fn get_article(
    State(st): State<AppState>,
    Member(m): Member,
    Path(aid): Path<String>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    if !visible_to(&article, &m) {
        return Err(crate::error::not_found());
    }
    db::update(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "$inc": { "views": 1i32 } })),
    )
    .await?;
    let mut out = article;
    out.insert("views".to_string(), doc_i64(&out, "views") + 1);
    Ok(Json(out))
}

async fn create_article(
    State(st): State<AppState>,
    Staff(m): Staff,
    Json(body): Json<ArticleIn>,
) -> ApiResult<Json<Document>> {
    let note = body.review_note.trim().to_string();
    let mut article = article_doc(&body, article_defaults(&m));
    article.insert("id".to_string(), new_id());
    article.insert("views".to_string(), 0i32);
    article.insert("created_by".to_string(), doc_str(&m, "user_id"));
    article.insert("created_at".to_string(), now());
    article.insert("updated_at".to_string(), now());
    db::insert(&st.db, "articles", article.clone()).await?;
    snapshot_article(
        &st.db,
        &article,
        &m,
        if note.is_empty() { "Created" } else { &note },
    )
    .await?;
    article_audit(&st.db, &doc_str(&article, "id"), "created", &m, &note, None).await?;
    Ok(Json(article))
}

async fn update_article(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(aid): Path<String>,
    Json(body): Json<ArticleIn>,
) -> ApiResult<Json<Document>> {
    let current = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    let note = body.review_note.trim().to_string();
    let version = doc_i64(&current, "version").max(1) + 1;
    snapshot_article(
        &st.db,
        &current,
        &m,
        if note.is_empty() { "Before edit" } else { &note },
    )
    .await?;
    let mut set = article_doc(&body, Document::new());
    set.insert("version".to_string(), version);
    set.insert("updated_at".to_string(), now());
    db::set_fields(&st.db, "articles", as_doc(json!( { "id": &aid })), set).await?;
    article_audit(
        &st.db,
        &aid,
        "edited",
        &m,
        &note,
        Some(as_doc(json!( { "version": version }))),
    )
    .await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn delete_article(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(aid): Path<String>,
) -> ApiResult<Json<Value>> {
    if db::delete_one(&st.db, "articles", as_doc(json!( { "id": &aid }))).await? == 0 {
        return Err(crate::error::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

fn sse_response(events: Vec<Document>) -> Response {
    let stream_events: Vec<Result<Event, Infallible>> = events
        .into_iter()
        .map(|e| Ok(Event::default().data(e.into_value().to_string())))
        .collect();
    Sse::new(stream::iter(stream_events)).into_response()
}

async fn describe_answer(
    st: &AppState,
    question: &str,
    arts: Vec<Document>,
    system: &str,
) -> ApiResult<Response> {
    let sources: Vec<Document> = arts
        .iter()
        .map(|a| as_doc(json!({ "id": doc_str(a, "id"), "title": doc_str(a, "title") })))
        .collect();
    let mut events = vec![as_doc(json!({ "type": "sources", "sources": sources }))];
    let prompt = ai::answer_prompt(question, &arts);
    match ai::stream_text(st, system, &prompt).await {
        Ok(chunks) => {
            for chunk in chunks {
                events.push(as_doc(json!({ "type": "delta", "text": chunk })));
            }
        }
        Err(err) => events.push(as_doc(json!({ "type": "error", "text": err.detail.chars().take(200).collect::<String>() }))),
    }
    events.push(as_doc(json!({ "type": "done" })));
    Ok(sse_response(events))
}

async fn ask(State(st): State<AppState>, Member(m): Member, Json(body): Json<AskIn>) -> ApiResult<Response> {
    if body.question.trim().len() < 2 {
        return Err(AppError::bad("Ask a question"));
    }
    db::insert(
        &st.db,
        "kb_searches",
        as_doc(json!( {
            "q": body.question.trim().to_lowercase().chars().take(100).collect::<String>(),
            "user_id": doc_str(&m, "user_id"),
            "at": now(),
            "ai": true,
        })),
    )
    .await?;
    let arts = db::find(&st.db, "articles", DbQuery::new(Document::new()).limit(500)).await?;
    let ranked = rank_articles(&body.question, &arts, 4);
    describe_answer(&st, &body.question, ranked, ai::ANSWER_SYSTEM).await
}

async fn public_articles(
    State(st): State<AppState>,
    QueryParams(q): QueryParams<ArticleQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    let query = article_query(
        q.q.trim(),
        &q.category,
        as_doc(json!( { "self_service": true, "status": "published" })),
    );
    Ok(Json(
        db::find(
            &st.db,
            "articles",
            DbQuery::new(query).project(as_doc(json!( { "created_by": 0 }))).limit(200),
        )
        .await?,
    ))
}

async fn public_article(State(st): State<AppState>, Path(aid): Path<String>) -> ApiResult<Json<Document>> {
    let doc = db::find_one(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid, "self_service": true, "status": "published" })),
    )
    .await?
    .ok_or_else(crate::error::not_found)?;
    db::update(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "$inc": { "views": 1i32 } })),
    )
    .await?;
    Ok(Json(doc))
}

async fn public_ask(State(st): State<AppState>, Json(body): Json<AskIn>) -> ApiResult<Response> {
    if body.question.trim().len() < 2 {
        return Err(AppError::bad("Ask a question"));
    }
    let arts = db::find(
        &st.db,
        "articles",
        DbQuery::new(as_doc(json!( { "self_service": true }))).limit(500),
    )
    .await?;
    let ranked = rank_articles(&body.question, &arts, 4);
    describe_answer(&st, &body.question, ranked, ai::PUBLIC_SYSTEM).await
}

// ---------- governance ----------

async fn governance(State(st): State<AppState>, Staff(_m): Staff) -> ApiResult<Json<Value>> {
    let arts = db::find(
        &st.db,
        "articles",
        DbQuery::new(Document::new()).project(as_doc(json!( { "content": 0, "steps": 0 }))).limit(5000),
    )
    .await?;
    let today = today_iso();
    let soon = date_in_days(30);
    let normalized: Vec<Document> = arts
        .into_iter()
        .map(|mut a| {
            if doc_str(&a, "status").is_empty() {
                a.insert("status".to_string(), "published");
            }
            a
        })
        .collect();
    let mut counts = serde_json::Map::new();
    for status in ARTICLE_STATUSES {
        counts.insert(
            status.to_string(),
            json!(normalized.iter().filter(|a| doc_str(a, "status") == status).count()),
        );
    }
    let expiring: Vec<&Document> = normalized
        .iter()
        .filter(|a| {
            let e = doc_str(a, "expires_at");
            !e.is_empty() && today.as_str() <= short_date(&e).as_str() && short_date(&e).as_str() <= soon.as_str()
        })
        .collect();
    let overdue_review: Vec<&Document> = normalized
        .iter()
        .filter(|a| {
            let r = doc_str(a, "review_date");
            !r.is_empty() && short_date(&r).as_str() < today.as_str() && doc_str(a, "status") != "archived"
        })
        .collect();
    let published: Vec<&Document> = normalized.iter().filter(|a| doc_str(a, "status") == "published").collect();
    let rated: Vec<&Document> = normalized
        .iter()
        .filter(|a| doc_i64(a, "helpful_count") + doc_i64(a, "not_helpful_count") > 0)
        .collect();
    let feedback: Vec<Document> = {
        let mut sorted = rated.clone();
        sorted.sort_by(|a, b| {
            (doc_i64(b, "helpful_count") + doc_i64(b, "not_helpful_count"))
                .cmp(&(doc_i64(a, "helpful_count") + doc_i64(a, "not_helpful_count")))
        });
        sorted
            .iter()
            .take(20)
            .map(|a| {
                let votes = doc_i64(a, "helpful_count") + doc_i64(a, "not_helpful_count");
                as_doc(json!({
                    "id": doc_str(a, "id"),
                    "title": doc_str(a, "title"),
                    "helpful_count": doc_i64(a, "helpful_count"),
                    "not_helpful_count": doc_i64(a, "not_helpful_count"),
                    "helpful_rate": if votes > 0 { round1(100.0 * doc_i64(a, "helpful_count") as f64 / votes as f64) } else { 0.0 },
                }))
            })
            .collect()
    };
    let mut stale_sorted = published.clone();
    stale_sorted.sort_by_key(|a| doc_i64(a, "views"));
    let stale: Vec<Document> = stale_sorted
        .iter()
        .take(10)
        .map(|a| {
            as_doc(json!({
                "id": doc_str(a, "id"),
                "title": doc_str(a, "title"),
                "views": doc_i64(a, "views"),
                "status": doc_str(a, "status"),
            }))
        })
        .collect();
    let mut awaiting: Vec<&Document> = normalized.iter().filter(|a| doc_str(a, "status") == "in_review").collect();
    awaiting.sort_by_key(|a| doc_str(a, "updated_at"));
    let mut ready: Vec<&Document> = normalized.iter().filter(|a| doc_str(a, "status") == "approved").collect();
    ready.sort_by_key(|a| doc_str(a, "updated_at"));
    let mut expiring_sorted = expiring;
    expiring_sorted.sort_by_key(|a| doc_str(a, "expires_at"));
    let mut overdue_sorted = overdue_review;
    overdue_sorted.sort_by_key(|a| doc_str(a, "review_date"));

    Ok(Json(json!({
        "counts": counts,
        "awaiting_approval": awaiting.iter().map(|a| to_json(a)).collect::<Vec<_>>(),
        "ready_to_publish": ready.iter().map(|a| to_json(a)).collect::<Vec<_>>(),
        "expiring": expiring_sorted.iter().map(|a| to_json(a)).collect::<Vec<_>>(),
        "overdue_review": overdue_sorted.iter().map(|a| to_json(a)).collect::<Vec<_>>(),
        "feedback": feedback,
        "stale": stale,
        "totals": {
            "articles": normalized.len(),
            "published": published.len(),
            "drafts": normalized.iter().filter(|a| doc_str(a, "status") == "draft").count(),
            "feedback_votes": normalized.iter().map(|a| doc_i64(a, "helpful_count") + doc_i64(a, "not_helpful_count")).sum::<i64>(),
        },
        "recent_audit": db::find(&st.db, "kb_audit", DbQuery::new(Document::new()).sort(as_doc(json!( { "at": -1 }))).limit(20)).await?,
    })))
}

async fn list_versions(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(aid): Path<String>,
) -> ApiResult<Json<Vec<Document>>> {
    db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    Ok(Json(
        db::find(
            &st.db,
            "article_versions",
            DbQuery::new(as_doc(json!( { "article_id": &aid }))).sort(as_doc(json!( { "version": -1 }))).limit(200),
        )
        .await?,
    ))
}

async fn get_version(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path((aid, vid)): Path<(String, String)>,
) -> ApiResult<Json<Document>> {
    db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    Ok(Json(
        db::find_one(&st.db, "article_versions", as_doc(json!( { "id": &vid, "article_id": &aid })))
            .await?
            .ok_or_else(|| AppError::not_found("Version not found"))?,
    ))
}

async fn restore_version(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path((aid, vid)): Path<(String, String)>,
    Json(body): Json<NoteIn>,
) -> ApiResult<Json<Document>> {
    let version = db::find_one(&st.db, "article_versions", as_doc(json!( { "id": &vid, "article_id": &aid })))
        .await?
        .ok_or_else(|| AppError::not_found("Version not found"))?;
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    let version_no = doc_i64(&version, "version");
    snapshot_article(&st.db, &article, &m, &format!("Before restoring v{version_no}")).await?;
    let mut set = Document::new();
    for field in SNAPSHOT_FIELDS {
        set.insert(field, version.get(field).cloned().unwrap_or(Value::Null));
    }
    set.insert("version".to_string(), doc_i64(&article, "version").max(1) + 1);
    set.insert("updated_at".to_string(), now());
    db::set_fields(&st.db, "articles", as_doc(json!( { "id": &aid })), set).await?;
    let note = if body.note.is_empty() {
        format!("Restored version {version_no}")
    } else {
        body.note
    };
    article_audit(&st.db, &aid, "restored", &m, &note, Some(as_doc(json!( { "version": version_no })))).await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn submit_for_review(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(aid): Path<String>,
    Json(body): Json<ReviewerIn>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    let status = {
        let s = doc_str(&article, "status");
        if s.is_empty() { "published".to_string() } else { s }
    };
    if status != "draft" && status != "archived" {
        return Err(AppError::conflict("Only drafts or archived articles can be submitted"));
    }
    let note = body.note.clone();
    let mut reviewer = Document::new();
    if !body.reviewer_id.is_empty() {
        reviewer = db::find_one(&st.db, "users", as_doc(json!( { "user_id": &body.reviewer_id })))
            .await?
            .ok_or_else(|| AppError::bad("Unknown reviewer"))?;
    }
    snapshot_article(
        &st.db,
        &article,
        &m,
        if note.is_empty() { "Submitted for review" } else { &note },
    )
    .await?;
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( {
            "status": "in_review",
            "submitted_at": now(),
            "updated_at": now(),
            "archived_at": "",
            "reviewer_id": doc_str(&reviewer, "user_id"),
            "reviewer_name": doc_str(&reviewer, "name"),
        })),
    )
    .await?;
    article_audit(
        &st.db,
        &aid,
        "submitted",
        &m,
        &note,
        Some(as_doc(json!( { "reviewer": doc_str(&reviewer, "name") }))),
    )
    .await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn approve(
    State(st): State<AppState>,
    Qa(m): Qa,
    Path(aid): Path<String>,
    Json(body): Json<NoteIn>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    if doc_str(&article, "status") != "in_review" {
        return Err(AppError::conflict("Only articles in review can be approved"));
    }
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( {
            "status": "approved",
            "approver_id": doc_str(&m, "user_id"),
            "approver_name": doc_str(&m, "name"),
            "updated_at": now(),
        })),
    )
    .await?;
    article_audit(&st.db, &aid, "approved", &m, &body.note, None).await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn publish(
    State(st): State<AppState>,
    Qa(m): Qa,
    Path(aid): Path<String>,
    Json(body): Json<NoteIn>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    let status = doc_str(&article, "status");
    if status != "approved" && status != "published" {
        return Err(AppError::conflict("Approve the article before publishing it"));
    }
    let published_at = {
        let existing = doc_str(&article, "published_at");
        if existing.is_empty() { now() } else { existing }
    };
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "status": "published", "published_at": published_at, "updated_at": now() })),
    )
    .await?;
    article_audit(&st.db, &aid, "published", &m, &body.note, None).await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn archive(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(aid): Path<String>,
    Json(body): Json<NoteIn>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    if doc_str(&article, "status") == "archived" {
        return Err(AppError::conflict("Already archived"));
    }
    let note = body.note.clone();
    snapshot_article(&st.db, &article, &m, if note.is_empty() { "Archived" } else { &note }).await?;
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "status": "archived", "archived_at": now(), "updated_at": now() })),
    )
    .await?;
    article_audit(&st.db, &aid, "archived", &m, &note, None).await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn reopen(
    State(st): State<AppState>,
    Staff(m): Staff,
    Path(aid): Path<String>,
    Json(body): Json<NoteIn>,
) -> ApiResult<Json<Document>> {
    let article = db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    if doc_str(&article, "status") != "archived" {
        return Err(AppError::conflict("Only archived articles can be reopened"));
    }
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "status": "draft", "archived_at": "", "updated_at": now() })),
    )
    .await?;
    article_audit(&st.db, &aid, "reopened", &m, &body.note, None).await?;
    Ok(Json(
        db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?,
    ))
}

async fn feedback(
    State(st): State<AppState>,
    Member(m): Member,
    Path(aid): Path<String>,
    Json(body): Json<FeedbackIn>,
) -> ApiResult<Json<Value>> {
    db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    let entry = as_doc(json!( {
        "article_id": &aid,
        "helpful": body.helpful,
        "comment": body.comment.trim(),
        "user_id": doc_str(&m, "user_id"),
        "user_name": doc_str(&m, "name"),
        "at": now(),
    }));
    let existing = db::find_one(
        &st.db,
        "kb_feedback",
        as_doc(json!( { "article_id": &aid, "user_id": doc_str(&m, "user_id") })),
    )
    .await?;
    match existing {
        Some(found) => {
            db::set_fields(
                &st.db,
                "kb_feedback",
                as_doc(json!( { "id": doc_str(&found, "id") })),
                entry,
            )
            .await?;
        }
        None => {
            let mut new_entry = entry;
            new_entry.insert("id".to_string(), new_id());
            db::insert(&st.db, "kb_feedback", new_entry).await?;
        }
    }
    let helpful = db::count(&st.db, "kb_feedback", as_doc(json!( { "article_id": &aid, "helpful": true }))).await?;
    let unhelpful = db::count(&st.db, "kb_feedback", as_doc(json!( { "article_id": &aid, "helpful": false }))).await?;
    db::set_fields(
        &st.db,
        "articles",
        as_doc(json!( { "id": &aid })),
        as_doc(json!( { "helpful_count": helpful as i64, "not_helpful_count": unhelpful as i64 })),
    )
    .await?;
    Ok(Json(json!({
        "helpful_count": helpful,
        "not_helpful_count": unhelpful,
        "my_feedback": body.helpful,
    })))
}

async fn list_feedback(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(aid): Path<String>,
) -> ApiResult<Json<Vec<Document>>> {
    db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    Ok(Json(
        db::find(
            &st.db,
            "kb_feedback",
            DbQuery::new(as_doc(json!( { "article_id": &aid }))).sort(as_doc(json!( { "at": -1 }))).limit(500),
        )
        .await?,
    ))
}

async fn article_audit_log(
    State(st): State<AppState>,
    Staff(_m): Staff,
    Path(aid): Path<String>,
) -> ApiResult<Json<Vec<Document>>> {
    db::get_or_404(&st.db, "articles", as_doc(json!( { "id": &aid }))).await?;
    Ok(Json(
        db::find(
            &st.db,
            "kb_audit",
            DbQuery::new(as_doc(json!( { "article_id": &aid }))).sort(as_doc(json!( { "at": -1 }))).limit(200),
        )
        .await?,
    ))
}
