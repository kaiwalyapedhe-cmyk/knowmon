//! PostgreSQL access layer.
//!
//! Every entity lives in its own table as a JSON payload (`data jsonb`) plus an
//! extracted `id` column, which keeps the document-shaped API of this service
//! while all reads, filters, sorts and partial updates are real SQL. Nested
//! structures (rubric criteria, tree nodes, quiz questions, audit trails) stay
//! inside the payload; top-level fields are exposed to SQL through `data -> 'f'`
//! and covered by GIN / expression indexes.

use crate::error::{ApiResult, AppError};
use crate::util::{Document, Value};
use serde_json::Map;
use sqlx::postgres::PgPool;
use sqlx::Row;

pub type Db = PgPool;

pub const TABLES: [&str; 20] = [
    "users",
    "interactions",
    "qa_forms",
    "qa_form_versions",
    "qa_sampling_policies",
    "qa_assignments",
    "score_audit",
    "calibrations",
    "articles",
    "article_versions",
    "kb_feedback",
    "kb_audit",
    "kb_searches",
    "trees",
    "courses",
    "attempts",
    "coaching",
    "digest_logs",
    "cron_runs",
    "ldap_failures",
];

fn table(name: &str) -> String {
    format!("\"{}\"", name.replace('"', ""))
}

/// `'{a,b}'` — a JSONB path literal for `#>` / `#>>`.
fn path_lit(path: &str) -> String {
    let joined = path
        .split('.')
        .map(|p| p.replace('\'', "''"))
        .collect::<Vec<_>>()
        .join(",");
    format!("'{{{joined}}}'")
}

fn field_key(path: &str) -> String {
    path.replace('\'', "''")
}

fn json_at(path: &str) -> String {
    format!("data #> {}", path_lit(path))
}

fn text_at(path: &str) -> String {
    format!("data #>> {}", path_lit(path))
}

#[derive(Default)]
pub struct Query {
    pub filter: Document,
    pub sort: Option<Document>,
    pub limit: Option<i64>,
    pub projection: Option<Document>,
}

impl Query {
    pub fn new(filter: impl Into<Document>) -> Self {
        Self {
            filter: filter.into(),
            ..Default::default()
        }
    }
    pub fn sort(mut self, sort: Document) -> Self {
        self.sort = Some(sort);
        self
    }
    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }
    pub fn project(mut self, projection: Document) -> Self {
        self.projection = Some(projection);
        self
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct UpdateResult {
    pub modified_count: u64,
    pub matched_count: u64,
}

// ---------------------------------------------------------------- filters

fn push(params: &mut Vec<Value>, v: Value) -> usize {
    params.push(v);
    params.len()
}

fn array_membership(field_expr: &str, param: usize, negate: bool) -> String {
    let hit = format!(
        "(EXISTS (SELECT 1 FROM jsonb_array_elements(${param}) AS x WHERE x = {field_expr}) \
         OR (jsonb_typeof({field_expr}) = 'array' AND EXISTS (\
             SELECT 1 FROM jsonb_array_elements(${param}) AS x, jsonb_array_elements({field_expr}) AS y WHERE y = x)) \
         OR ({field_expr} IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(${param}) AS x WHERE jsonb_typeof(x) = 'null')))"
    );
    if negate {
        format!("({field_expr} IS NULL OR NOT {hit})")
    } else {
        hit
    }
}

fn operator_sql(path: &str, ops: &Map<String, Value>, params: &mut Vec<Value>) -> String {
    let at = json_at(path);
    let text = text_at(path);
    let mut preds: Vec<String> = Vec::new();
    let mut case_insensitive = false;
    let mut regex: Option<String> = None;

    for (op, arg) in ops {
        match op.as_str() {
            "$in" => {
                let n = push(params, arg.clone());
                preds.push(array_membership(&at, n, false));
            }
            "$nin" => {
                let n = push(params, arg.clone());
                preds.push(array_membership(&at, n, true));
            }
            "$ne" => {
                let n = push(params, arg.clone());
                preds.push(format!("({at} IS NULL OR {at} <> ${n})"));
            }
            "$exists" => {
                let desired = arg.as_bool().unwrap_or(true);
                let exists = if path.contains('.') {
                    format!("({at} IS NOT NULL)")
                } else {
                    format!("(data ? '{}')", field_key(path))
                };
                preds.push(if desired { exists } else { format!("(NOT {exists})") });
            }
            "$gte" => {
                let n = push(params, arg.clone());
                preds.push(format!("({at} >= ${n})"));
            }
            "$gt" => {
                let n = push(params, arg.clone());
                preds.push(format!("({at} > ${n})"));
            }
            "$lte" => {
                let n = push(params, arg.clone());
                preds.push(format!("({at} <= ${n})"));
            }
            "$lt" => {
                let n = push(params, arg.clone());
                preds.push(format!("({at} < ${n})"));
            }
            "$regex" => {
                if let Some(pattern) = arg.as_str() {
                    regex = Some(pattern.to_string());
                }
            }
            "$options" => {
                case_insensitive = arg.as_str().map(|s| s.contains('i')).unwrap_or(false);
            }
            other => {
                tracing::warn!("unsupported query operator {other} on {path}");
            }
        }
    }

    if let Some(pattern) = regex {
        let n = push(params, Value::String(pattern));
        preds.push(format!(
            "(coalesce({text}, '') {} (${n} #>> '{{}}'))",
            if case_insensitive { "~*" } else { "~" }
        ));
    }

    if preds.is_empty() {
        "TRUE".to_string()
    } else {
        preds.join(" AND ")
    }
}

pub fn filter_sql(filter: &Map<String, Value>, params: &mut Vec<Value>) -> String {
    if filter.is_empty() {
        return "TRUE".to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    for (key, value) in filter {
        match key.as_str() {
            "$or" | "$and" => {
                let joiner = if key == "$or" { " OR " } else { " AND " };
                let subs: Vec<String> = value
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|v| v.as_object())
                    .map(|d| filter_sql(d, params))
                    .collect();
                if !subs.is_empty() {
                    parts.push(format!("({})", subs.join(joiner)));
                }
            }
            other => {
                if other.starts_with('$') {
                    tracing::warn!("unsupported top-level query operator {other}");
                    continue;
                }
                if let Some(ops) = value.as_object() {
                    if ops.keys().any(|k| k.starts_with('$')) {
                        parts.push(operator_sql(other, ops, params));
                        continue;
                    }
                }
                let n = push(params, value.clone());
                parts.push(format!("({} = ${n})", json_at(other)));
            }
        }
    }
    if parts.is_empty() {
        "TRUE".to_string()
    } else {
        parts.join(" AND ")
    }
}

// ---------------------------------------------------------------- reads

fn row_to_doc(row: &sqlx::postgres::PgRow) -> ApiResult<Document> {
    let data: Value = row.try_get("data")?;
    Ok(Document::from_value(data))
}

pub async fn find_one(
    db: &Db,
    name: &str,
    filter: impl Into<Document>,
) -> ApiResult<Option<Document>> {
    let filter = filter.into();
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!("SELECT data FROM {} WHERE {where_sql} ORDER BY seq LIMIT 1", table(name));
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    let row = query.fetch_optional(db).await?;
    Ok(row.map(|r| row_to_doc(&r)).transpose()?.map(crate::util::clean))
}

pub async fn get_or_404(db: &Db, name: &str, filter: impl Into<Document>) -> ApiResult<Document> {
    find_one(db, name, filter)
        .await?
        .ok_or_else(crate::error::not_found)
}

pub async fn find(db: &Db, name: &str, q: Query) -> ApiResult<Vec<Document>> {
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&q.filter, &mut params);
    let mut sql = format!("SELECT data FROM {} WHERE {where_sql}", table(name));

    if let Some(sort) = &q.sort {
        let mut clauses: Vec<String> = Vec::new();
        for (field, dir) in sort {
            let dir_sql = if dir.as_i64().unwrap_or(1) < 0 { "DESC" } else { "ASC" };
            clauses.push(format!("{} {dir_sql}", json_at(field)));
        }
        if !clauses.is_empty() {
            sql.push_str(&format!(" ORDER BY {}, seq", clauses.join(", ")));
        } else {
            sql.push_str(" ORDER BY seq");
        }
    } else {
        sql.push_str(" ORDER BY seq");
    }
    if let Some(limit) = q.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }

    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    let rows = query.fetch_all(db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut doc = row_to_doc(&row)?;
        if let Some(projection) = &q.projection {
            if !projection.contains_key("_id") {
                doc.remove("_id");
            }
            let keep: Vec<String> = projection
                .iter()
                .filter(|(k, v)| *k != "_id" && v.as_i64().map(|i| i != 0).unwrap_or(true))
                .map(|(k, _)| k.clone())
                .collect();
            if !keep.is_empty() {
                doc.retain(|k, _| keep.iter().any(|p| p == k));
            }
        }
        out.push(doc);
    }
    Ok(out)
}

pub async fn find_all(db: &Db, name: &str, filter: impl Into<Document>) -> ApiResult<Vec<Document>> {
    find(db, name, Query::new(filter)).await
}

// ---------------------------------------------------------------- writes

fn doc_id(doc: &Document) -> Option<String> {
    doc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub async fn insert(db: &Db, name: &str, d: impl Into<Document>) -> ApiResult<()> {
    let d = d.into();
    let sql = format!("INSERT INTO {} (id, data) VALUES ($1, $2)", table(name));
    sqlx::query(&sql)
        .bind(doc_id(&d))
        .bind(d.into_value())
        .execute(db)
        .await?;
    Ok(())
}

pub async fn insert_many(db: &Db, name: &str, docs: Vec<Document>) -> ApiResult<()> {
    for doc in docs {
        insert(db, name, doc).await?;
    }
    Ok(())
}

/// SQL expression that applies an operator-style update document to `data`.
fn update_expr(update: &Document, params: &mut Vec<Value>) -> String {
    let mut expr = "data".to_string();
    let mut plain: Map<String, Value> = Map::new();

    for (op, value) in update {
        match op.as_str() {
            "$set" => {
                if let Some(fields) = value.as_object() {
                    let mut flat: Map<String, Value> = Map::new();
                    for (key, val) in fields {
                        if key.contains('.') {
                            // dotted keys address nested paths
                            let n = push(params, val.clone());
                            expr = format!(
                                "jsonb_set({expr}, {}, ${n}, true)",
                                path_lit(key)
                            );
                        } else {
                            flat.insert(key.clone(), val.clone());
                        }
                    }
                    if !flat.is_empty() {
                        let n = push(params, Value::Object(flat));
                        expr = format!("({expr} || ${n})");
                    }
                }
            }
            "$unset" => {
                let keys: Vec<String> = value
                    .as_object()
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                for key in keys {
                    if key.contains('.') {
                        expr = format!("jsonb_set({expr}, {}, 'null'::jsonb, false)", path_lit(&key));
                    } else {
                        expr = format!("({expr} - '{}')", field_key(&key));
                    }
                }
            }
            "$push" => {
                for (key, val) in value.as_object().cloned().unwrap_or_default() {
                    let n = push(params, val);
                    let path = path_lit(&key);
                    expr = format!(
                        "jsonb_set({expr}, {path}, coalesce({expr} #> {path}, '[]'::jsonb) || ${n})"
                    );
                }
            }
            "$pull" => {
                for (key, val) in value.as_object().cloned().unwrap_or_default() {
                    let n = push(params, val);
                    let path = path_lit(&key);
                    expr = format!(
                        "jsonb_set({expr}, {path}, coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce({expr} #> {path}, '[]'::jsonb)) AS e WHERE NOT (e @> ${n})), '[]'::jsonb))"
                    );
                }
            }
            "$inc" => {
                for (key, val) in value.as_object().cloned().unwrap_or_default() {
                    let delta = match &val {
                        Value::Number(n) => n.to_string(),
                        _ => "0".to_string(),
                    };
                    let path = path_lit(&key);
                    expr = format!(
                        "jsonb_set({expr}, {path}, to_jsonb(coalesce(({expr} #>> {path})::numeric, 0) + ({delta})))"
                    );
                }
            }
            "$setOnInsert" | "$options" => {}
            other if other.starts_with('$') => {
                tracing::warn!("unsupported update operator {other}");
            }
            _ => {
                plain.insert(op.clone(), value.clone());
            }
        }
    }

    if !plain.is_empty() {
        let n = push(params, Value::Object(plain));
        expr = format!("({expr} || ${n})");
    }
    expr
}

async fn run_update(
    db: &Db,
    name: &str,
    filter: Document,
    update: Document,
) -> ApiResult<UpdateResult> {
    let mut params: Vec<Value> = Vec::new();
    let expr = update_expr(&update, &mut params);
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!(
        "UPDATE {} SET data = {expr} WHERE {where_sql} RETURNING id",
        table(name)
    );
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    let rows = query.fetch_all(db).await?;
    Ok(UpdateResult {
        modified_count: rows.len() as u64,
        matched_count: rows.len() as u64,
    })
}

pub async fn update(
    db: &Db,
    name: &str,
    filter: impl Into<Document>,
    update: impl Into<Document>,
) -> ApiResult<UpdateResult> {
    run_update(db, name, filter.into(), update.into()).await
}

pub async fn update_many(
    db: &Db,
    name: &str,
    filter: impl Into<Document>,
    update: impl Into<Document>,
) -> ApiResult<UpdateResult> {
    run_update(db, name, filter.into(), update.into()).await
}

pub async fn set_fields(
    db: &Db,
    name: &str,
    filter: impl Into<Document>,
    set: impl Into<Document>,
) -> ApiResult<UpdateResult> {
    update(
        db,
        name,
        filter,
        crate::util::as_doc(crate::util::json!({ "$set": set.into() })),
    )
    .await
}

/// Insert the document when nothing matches, otherwise apply `$set` (upsert).
pub async fn upsert_set(
    db: &Db,
    name: &str,
    filter: impl Into<Document>,
    set: impl Into<Document>,
    on_insert: impl Into<Document>,
) -> ApiResult<bool> {
    let filter = filter.into();
    let set = set.into();
    let on_insert = on_insert.into();
    if let Some(_existing) = find_one(db, name, filter.clone()).await? {
        set_fields(db, name, filter, set).await?;
        Ok(false)
    } else {
        let mut doc = filter;
        for (k, v) in set {
            doc.insert(k, v);
        }
        for (k, v) in on_insert {
            doc.entry(k).or_insert(v);
        }
        insert(db, name, doc).await?;
        Ok(true)
    }
}

pub async fn delete_one(db: &Db, name: &str, filter: impl Into<Document>) -> ApiResult<u64> {
    let filter = filter.into();
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!(
        "DELETE FROM {} WHERE ctid IN (SELECT ctid FROM {} WHERE {where_sql} ORDER BY seq LIMIT 1)",
        table(name),
        table(name)
    );
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    Ok(query.execute(db).await?.rows_affected())
}

pub async fn delete_many(db: &Db, name: &str, filter: impl Into<Document>) -> ApiResult<u64> {
    let filter = filter.into();
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!("DELETE FROM {} WHERE {where_sql}", table(name));
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    Ok(query.execute(db).await?.rows_affected())
}

pub async fn count(db: &Db, name: &str, filter: impl Into<Document>) -> ApiResult<u64> {
    let filter = filter.into();
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!("SELECT count(*) AS n FROM {} WHERE {where_sql}", table(name));
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    let row = query.fetch_one(db).await?;
    let n: i64 = row.try_get("n")?;
    Ok(n.max(0) as u64)
}

pub async fn distinct(
    db: &Db,
    name: &str,
    field: &str,
    filter: impl Into<Document>,
) -> ApiResult<Vec<Value>> {
    let filter = filter.into();
    let mut params: Vec<Value> = Vec::new();
    let where_sql = filter_sql(&filter, &mut params);
    let sql = format!(
        "SELECT DISTINCT {} AS v FROM {} WHERE {where_sql}",
        json_at(field),
        table(name)
    );
    let mut query = sqlx::query(&sql);
    for p in params {
        query = query.bind(p);
    }
    let rows = query.fetch_all(db).await?;
    let mut out = Vec::new();
    for row in rows {
        let v: Option<Value> = row.try_get("v")?;
        if let Some(v) = v {
            if !v.is_null() {
                out.push(v);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- schema

/// Create every table and index the service needs. Idempotent.
pub async fn ensure_indexes(db: &Db) {
    for name in TABLES {
        let ddl = format!(
            "CREATE TABLE IF NOT EXISTS {} (\
                seq bigserial PRIMARY KEY,\
                id text,\
                data jsonb NOT NULL)",
            table(name)
        );
        if let Err(err) = sqlx::query(&ddl).execute(db).await {
            tracing::error!("create table {name}: {err}");
            continue;
        }
        let indexes = [
            format!(
                "CREATE UNIQUE INDEX IF NOT EXISTS \"{name}_id_key\" ON {} (id) WHERE id IS NOT NULL",
                table(name)
            ),
            format!(
                "CREATE INDEX IF NOT EXISTS \"{name}_data_gin\" ON {} USING gin (data jsonb_path_ops)",
                table(name)
            ),
        ];
        for sql in indexes {
            if let Err(err) = sqlx::query(&sql).execute(db).await {
                tracing::error!("index on {name}: {err}");
            }
        }
    }

    // Expression indexes for the hottest filters and sorts (ISO-8601 text sorts chronologically).
    let extra = [
        "CREATE INDEX IF NOT EXISTS interactions_created_idx ON interactions ((data ->> 'created_at') DESC)",
        "CREATE INDEX IF NOT EXISTS interactions_agent_idx ON interactions ((data ->> 'agent_id'))",
        "CREATE INDEX IF NOT EXISTS assignments_assigned_idx ON qa_assignments ((data ->> 'assigned_at') DESC)",
        "CREATE INDEX IF NOT EXISTS assignments_evaluator_idx ON qa_assignments ((data ->> 'evaluator_id'), (data ->> 'status'))",
        "CREATE INDEX IF NOT EXISTS coaching_agent_idx ON coaching ((data ->> 'agent_id'))",
        "CREATE INDEX IF NOT EXISTS kb_audit_article_idx ON kb_audit ((data ->> 'article_id'), (data ->> 'at') DESC)",
        "CREATE INDEX IF NOT EXISTS score_audit_interaction_idx ON score_audit ((data ->> 'interaction_id'), (data ->> 'at'))",
        "CREATE INDEX IF NOT EXISTS digest_logs_at_idx ON digest_logs ((data ->> 'at') DESC)",
        "CREATE INDEX IF NOT EXISTS article_versions_article_idx ON article_versions ((data ->> 'article_id'), (data ->> 'version') DESC)",
        "CREATE INDEX IF NOT EXISTS qa_form_versions_form_idx ON qa_form_versions ((data ->> 'form_id'), (data ->> 'version') DESC)",
        "CREATE INDEX IF NOT EXISTS kb_feedback_article_idx ON kb_feedback ((data ->> 'article_id'), (data ->> 'user_id'))",
        "CREATE INDEX IF NOT EXISTS users_env_idx ON users ((data ->> 'env'), (data ->> 'user_id'))",
    ];
    for sql in extra {
        if let Err(err) = sqlx::query(sql).execute(db).await {
            tracing::error!("secondary index: {err}");
        }
    }
}

/// Verify the connection is usable and the schema exists.
pub async fn init(db: &Db) -> ApiResult<()> {
    sqlx::query("SELECT 1")
        .execute(db)
        .await
        .map_err(|err| AppError::internal(format!("database unreachable: {err}")))?;
    ensure_indexes(db).await;
    Ok(())
}
