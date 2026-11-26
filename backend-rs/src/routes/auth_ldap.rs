//! Company login: local passwords first, then the directory, with a dev fallback.

use crate::auth::{issue_session, sha256_hex, verify_password};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::ldap;
use crate::models::LdapLogin;
use crate::state::AppState;
use crate::util::*;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use crate::util::as_doc;

const MAX_FAILURES: u64 = 5;
const LOCK_MINUTES: i64 = 15;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/ldap/config", get(config))
        .route("/auth/ldap/login", post(login))
}

async fn config(State(st): State<AppState>) -> Json<Value> {
    let integrations = st.integrations.read().await.clone();
    Json(json!({ "enabled": integrations.ldap_enabled() }))
}

async fn login(State(st): State<AppState>, Json(body): Json<LdapLogin>) -> ApiResult<Json<Value>> {
    let integrations = st.integrations.read().await.clone();
    if !integrations.ldap_enabled() {
        return Err(AppError::not_found("Company login is not configured"));
    }
    if body.username.trim().is_empty() || body.password.is_empty() {
        return Err(AppError::bad("Enter your username and password"));
    }
    let key = body.username.trim().to_lowercase();

    // 1. Local account with a password set
    let local = db::find_one(
        &st.db,
        "users",
        as_doc(json!( { "$or": [ { "email": &key }, { "username": &key }, { "user_id": &key } ] })),
    )
    .await?;
    if let Some(user) = local.clone() {
        if user.contains_key("password_hash") {
            if doc_bool(&user, "disabled") {
                return Err(AppError::forbidden(
                    "This account has been deactivated. Please contact an administrator.",
                ));
            }
            if !verify_password(&body.password, &doc_str(&user, "password_hash")) {
                return Err(AppError::unauthorized("Invalid username or password"));
            }
            let (token, expires_at) = issue_session(&st.cfg.ldap_jwt_secret, &doc_str(&user, "user_id"))?;
            let display_name = {
                let n = doc_str(&user, "name");
                if n.is_empty() {
                    key.clone()
                } else {
                    n
                }
            };
            return Ok(Json(json!({
                "token": token,
                "expires_at": expires_at,
                "role": effective_role(user.get("role")),
                "name": display_name,
            })));
        }
    }

    let info = if !integrations.ldap.url.is_empty() && !integrations.ldap.base_dn.is_empty() {
        let since = (chrono::Utc::now() - chrono::Duration::minutes(LOCK_MINUTES))
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, false);
        let failures = db::count(
            &st.db,
            "ldap_failures",
            as_doc(json!( { "username": &key, "at": { "$gte": since } })),
        )
        .await?;
        if failures >= MAX_FAILURES {
            return Err(AppError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                format!("Too many attempts. Try again in {LOCK_MINUTES} minutes."),
            ));
        }
        match ldap::authenticate(&integrations.ldap, body.username.trim(), &body.password).await {
            Err(err) => return Err(AppError::upstream(format!("Company directory is unreachable: {err}"))),
            Ok(None) => {
                db::insert(
                    &st.db,
                    "ldap_failures",
                    as_doc(json!( { "username": &key, "at": now() })),
                )
                .await?;
                return Err(AppError::unauthorized("Invalid username or password"));
            }
            Ok(Some(user)) => {
                db::delete_many(&st.db, "ldap_failures", as_doc(json!( { "username": &key }))).await?;
                user
            }
        }
    } else {
        // Development mode login fallback (DEV_LOGIN=true with no directory configured)
        let local_part = key.split('@').next().unwrap_or("").to_string();
        let name = local_part
            .replace('.', " ")
            .split_whitespace()
            .map(|w| {
                let mut chars = w.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        ldap::LdapUser {
            dn: format!("uid={key},ou=users,dc=local"),
            email: if key.contains('@') {
                key.clone()
            } else {
                format!("{key}@jswshakti.in")
            },
            name: if name.is_empty() { "Local User".to_string() } else { name },
            member_of: Vec::new(),
        }
    };

    let uid = format!("ldap_{}", &sha256_hex(&info.dn.to_lowercase())[..24]);
    let lead_group = integrations.ldap.team_lead_group_dn.to_lowercase();
    let is_admin = st.cfg.admin_emails.contains(&info.email.to_lowercase());
    let role = if is_admin {
        "admin"
    } else if !lead_group.is_empty() && info.member_of.iter().any(|g| g.contains(&lead_group)) {
        "team_lead"
    } else {
        DEFAULT_ROLE
    };

    let existing = db::find_one(&st.db, "users", as_doc(json!( { "user_id": &uid }))).await?;
    if existing.is_none() {
        db::insert(
            &st.db,
            "users",
            as_doc(json!( {
                "user_id": &uid,
                "email": info.email.to_lowercase(),
                "name": &info.name,
                "auth": "ldap",
                "env": st.env_name(),
                "role": role,
                "disabled": false,
                "created_at": now(),
            })),
        )
        .await?;
    } else {
        db::set_fields(
            &st.db,
            "users",
            as_doc(json!( { "user_id": &uid })),
            as_doc(json!( {
                "email": info.email.to_lowercase(),
                "name": &info.name,
                "auth": "ldap",
                "env": st.env_name(),
                "role": role,
            })),
        )
        .await?;
    }

    let (token, expires_at) = issue_session(&st.cfg.ldap_jwt_secret, &uid)?;
    Ok(Json(json!({
        "token": token,
        "expires_at": expires_at,
        "role": role,
        "name": info.name,
    })))
}
