//! Admin integrations screen: LDAP directory and SMTP settings (+ connection tests).

use crate::auth::Admin;
use crate::config::update_env_file;
use crate::error::{ApiResult, AppError};
use crate::ldap;
use crate::mailer;
use crate::models::{LdapConfigIn, LdapTestIn, SmtpConfigIn, SmtpTestIn};
use crate::state::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};


pub fn router() -> Router<AppState> {
    Router::new()
        .route("/integrations", get(get_integrations))
        .route("/integrations/ldap", post(save_ldap))
        .route("/integrations/ldap/test", post(test_ldap))
        .route("/integrations/smtp", post(save_smtp))
        .route("/integrations/smtp/test", post(test_smtp))
}

async fn get_integrations(State(st): State<AppState>, Admin(_m): Admin) -> ApiResult<Json<Value>> {
    let integrations = st.integrations.read().await.clone();
    Ok(Json(json!({
        "ldap": {
            "enabled": integrations.ldap_enabled(),
            "url": integrations.ldap.url,
            "base_dn": integrations.ldap.base_dn,
            "bind_dn": integrations.ldap.bind_dn,
            "user_filter": integrations.ldap.user_filter,
            "team_lead_group_dn": integrations.ldap.team_lead_group_dn,
            "has_password": !integrations.ldap.bind_password.is_empty(),
        },
        "smtp": {
            "configured": integrations.smtp.configured(),
            "host": integrations.smtp.host,
            "port": integrations.smtp.port,
            "security": integrations.smtp.security,
            "username": integrations.smtp.username,
            "from_address": integrations.smtp.from,
            "has_password": !integrations.smtp.password.is_empty(),
        },
        "ai": {
            "has_key": !st.cfg.llm_key.is_empty(),
            "provider": if st.cfg.llm_base_url.is_empty() { "Local deterministic" } else { "OpenAI-compatible" },
            "model": st.cfg.llm_model,
        }
    })))
}

async fn save_ldap(
    State(st): State<AppState>,
    Admin(_m): Admin,
    Json(body): Json<LdapConfigIn>,
) -> ApiResult<Json<Value>> {
    let mut updates: Vec<(String, Option<String>)> = vec![
        ("LDAP_URL".into(), Some(body.url.trim().to_string())),
        ("LDAP_BASE_DN".into(), Some(body.base_dn.trim().to_string())),
        ("LDAP_BIND_DN".into(), Some(body.bind_dn.trim().to_string())),
        ("LDAP_USER_FILTER".into(), Some(body.user_filter.trim().to_string())),
        ("LDAP_TEAM_LEAD_GROUP_DN".into(), Some(body.team_lead_group_dn.trim().to_string())),
    ];
    if let Some(pw) = body.bind_password.as_deref().filter(|p| !p.is_empty()) {
        updates.push(("LDAP_BIND_PASSWORD".into(), Some(pw.to_string())));
    }
    update_env_file(&st.cfg.env_file, &updates)
        .map_err(|e| AppError::internal(format!("Could not save settings: {e}")))?;
    {
        let mut integrations = st.integrations.write().await;
        integrations.ldap.url = body.url.trim().to_string();
        integrations.ldap.base_dn = body.base_dn.trim().to_string();
        integrations.ldap.bind_dn = body.bind_dn.trim().to_string();
        integrations.ldap.user_filter = body.user_filter.trim().to_string();
        integrations.ldap.team_lead_group_dn = body.team_lead_group_dn.trim().to_string();
        if let Some(pw) = body.bind_password.filter(|p| !p.is_empty()) {
            integrations.ldap.bind_password = pw;
        }
    }
    Ok(Json(json!({ "status": "success", "message": "LDAP configuration saved" })))
}

async fn test_ldap(
    State(st): State<AppState>,
    Admin(_m): Admin,
    Json(body): Json<LdapTestIn>,
) -> ApiResult<Json<Value>> {
    let mut cfg = st.integrations.read().await.ldap.clone();
    cfg.url = body.url.trim().to_string();
    cfg.base_dn = body.base_dn.trim().to_string();
    cfg.bind_dn = body.bind_dn.trim().to_string();
    cfg.user_filter = body.user_filter.trim().to_string();
    if let Some(pw) = body.bind_password.filter(|p| !p.is_empty()) {
        cfg.bind_password = pw;
    }
    match ldap::test_connection(&cfg).await {
        Ok(count) => Ok(Json(json!({
            "ok": true,
            "message": format!("Successfully connected! Discovered {count} test entry/entries in directory."),
        }))),
        Err(err) => Err(AppError::bad(err)),
    }
}

async fn save_smtp(
    State(st): State<AppState>,
    Admin(_m): Admin,
    Json(body): Json<SmtpConfigIn>,
) -> ApiResult<Json<Value>> {
    let mut updates: Vec<(String, Option<String>)> = vec![
        ("SMTP_HOST".into(), Some(body.host.trim().to_string())),
        ("SMTP_PORT".into(), Some(body.port.to_string())),
        ("SMTP_SECURITY".into(), Some(body.security.trim().to_lowercase())),
        ("SMTP_USERNAME".into(), Some(body.username.trim().to_string())),
        ("SMTP_FROM".into(), Some(body.from_address.trim().to_string())),
    ];
    if let Some(pw) = body.password.as_deref().filter(|p| !p.is_empty()) {
        updates.push(("SMTP_PASSWORD".into(), Some(pw.to_string())));
    }
    update_env_file(&st.cfg.env_file, &updates)
        .map_err(|e| AppError::internal(format!("Could not save settings: {e}")))?;
    {
        let mut integrations = st.integrations.write().await;
        integrations.smtp.host = body.host.trim().to_string();
        integrations.smtp.port = body.port;
        integrations.smtp.security = body.security.trim().to_lowercase();
        integrations.smtp.username = body.username.trim().to_string();
        integrations.smtp.from = body.from_address.trim().to_string();
        if let Some(pw) = body.password.filter(|p| !p.is_empty()) {
            integrations.smtp.password = pw;
        }
    }
    Ok(Json(json!({ "status": "success", "message": "SMTP configuration saved" })))
}

async fn test_smtp(
    State(st): State<AppState>,
    Admin(_m): Admin,
    Json(body): Json<SmtpTestIn>,
) -> ApiResult<Json<Value>> {
    let mut cfg = st.integrations.read().await.smtp.clone();
    cfg.host = body.host.trim().to_string();
    cfg.port = body.port;
    cfg.security = body.security.trim().to_lowercase();
    cfg.username = body.username.trim().to_string();
    cfg.from = body.from_address.trim().to_string();
    if let Some(pw) = body.password.filter(|p| !p.is_empty()) {
        cfg.password = pw;
    }
    let recipient = body.recipient.trim().to_string();
    mailer::send_email(
        &cfg,
        &[recipient.clone()],
        "Cadence CX — SMTP Test Email",
        "<p>This is a test email sent from Cadence CX to verify your SMTP configuration.</p>",
        "This is a test email sent from Cadence CX to verify your SMTP configuration.",
    )
    .await
    .map_err(AppError::bad)?;
    Ok(Json(json!({
        "ok": true,
        "message": format!("Test email sent successfully to {recipient}!"),
    })))
}
