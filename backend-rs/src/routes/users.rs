use crate::auth::{hash_password, role_of, verify_password, Admin, Member, Staff};
use crate::db::{self, Query as DbQuery};
use crate::error::{AppError, ApiResult};
use crate::ldap::password_ok as ldap_password_ok;
use crate::models::{ChangePasswordIn, CreateUserIn, ResetPasswordIn, RoleIn, StatusIn};
use crate::state::AppState;
use crate::util::*;
use axum::extract::{Path, State};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use crate::util::{Document, as_doc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/me", get(me))
        .route("/users", get(list_users).post(create_user))
        .route("/users/me/password", post(change_my_password))
        .route("/users/:user_id", delete(delete_user))
        .route("/users/:user_id/reset-password", post(reset_password))
        .route("/users/:user_id/status", patch(set_user_status))
        .route("/users/:user_id/role", patch(set_role))
        .route("/people", get(people))
}

async fn me(Member(m): Member) -> Json<Document> {
    Json(m)
}

async fn list_users(State(st): State<AppState>, Admin(admin): Admin) -> ApiResult<Json<Value>> {
    let people = db::find(
        &st.db,
        "users",
        DbQuery::new(in_env(st.env_name())).project(as_doc(json!( { "password_hash": 0 }))),
    )
    .await?;
    let admin_rank = rank(&role_of(&admin));
    let roles: Vec<&str> = ROLES
        .iter()
        .copied()
        .filter(|r| rank(r) <= admin_rank)
        .collect();
    let users: Vec<Value> = people
        .iter()
        .map(|p| {
            let mut copy = p.clone();
            copy.insert("role".to_string(), effective_role(p.get("role")));
            let has_pw = doc_bool(p, "has_password") || p.contains_key("password_hash");
            copy.insert("has_password".to_string(), has_pw);
            copy.insert("disabled".to_string(), doc_bool(p, "disabled"));
            to_json(&copy)
        })
        .collect();
    Ok(Json(json!({ "roles": roles, "users": users })))
}

async fn create_user(
    State(st): State<AppState>,
    Admin(admin): Admin,
    Json(body): Json<CreateUserIn>,
) -> ApiResult<Json<Document>> {
    let role = body.role.trim().to_string();
    if !ROLES.contains(&role.as_str()) || rank(&role) > rank(&role_of(&admin)) {
        return Err(AppError::forbidden("Invalid role specified"));
    }
    if body.name.trim().is_empty() || body.email.trim().len() < 3 {
        return Err(AppError::bad("Enter a name and email"));
    }
    let email = body.email.trim().to_lowercase();
    let username = body
        .username
        .clone()
        .unwrap_or_else(|| email.split('@').next().unwrap_or("").to_string())
        .trim()
        .to_lowercase();
    let existing = db::find_one(
        &st.db,
        "users",
        as_doc(json!( { "$or": [ { "email": &email }, { "username": &username } ] })),
    )
    .await?;
    if existing.is_some() {
        return Err(AppError::conflict(
            "A user with this email or username already exists",
        ));
    }
    let user_id = format!("u_{}", new_id());
    let mut doc = as_doc(json!( {
        "user_id": &user_id,
        "name": body.name.trim(),
        "email": &email,
        "username": &username,
        "role": &role,
        "auth": "local",
        "disabled": false,
        "has_password": body.password.as_deref().map(|p| !p.is_empty()).unwrap_or(false),
        "env": st.env_name(),
        "created_at": now(),
    }));
    if let Some(pw) = body.password.as_deref().filter(|p| !p.is_empty()) {
        doc.insert("password_hash".to_string(), hash_password(pw));
    }
    db::insert(&st.db, "users", doc.clone()).await?;
    doc.remove("password_hash");
    Ok(Json(doc))
}

async fn reset_password(
    State(st): State<AppState>,
    Admin(_admin): Admin,
    Path(user_id): Path<String>,
    Json(body): Json<ResetPasswordIn>,
) -> ApiResult<Json<Value>> {
    if body.new_password.len() < 4 {
        return Err(AppError::bad("Password must be at least 4 characters"));
    }
    let target = db::find_one(&st.db, "users", as_doc(json!( { "user_id": &user_id, "env": { "$in": [st.env_name(), Value::Null] } })))
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;
    let auth_mode = if doc_str(&target, "auth").is_empty() {
        "local".to_string()
    } else {
        doc_str(&target, "auth")
    };
    db::set_fields(
        &st.db,
        "users",
        as_doc(json!( { "user_id": &user_id, "env": { "$in": [st.env_name(), Value::Null] } })),
        as_doc(json!( { "password_hash": hash_password(&body.new_password), "has_password": true, "auth": auth_mode })),
    )
    .await?;
    let username = doc_str(&target, "username").to_lowercase();
    let email = doc_str(&target, "email").to_lowercase();
    for key in [username, email].into_iter().filter(|k| !k.is_empty()) {
        db::delete_many(&st.db, "ldap_failures", as_doc(json!( { "username": key }))).await?;
    }
    Ok(Json(json!({
        "ok": true,
        "message": format!("Password for {} has been updated successfully.", doc_str(&target, "name")),
    })))
}

async fn set_user_status(
    State(st): State<AppState>,
    Admin(admin): Admin,
    Path(user_id): Path<String>,
    Json(body): Json<StatusIn>,
) -> ApiResult<Json<Value>> {
    if user_id == doc_str(&admin, "user_id") {
        return Err(AppError::bad(
            "You cannot disable your own administrator account.",
        ));
    }
    let scoped = as_doc(json!( { "user_id": &user_id, "env": { "$in": [st.env_name(), Value::Null] } }));
    let target = db::find_one(&st.db, "users", scoped.clone())
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;
    if doc_str(&target, "role") == "admin" && body.disabled {
        let admins = db::count(
            &st.db,
            "users",
            as_doc(json!( { "role": "admin", "disabled": { "$ne": true }, "env": { "$in": [st.env_name(), Value::Null] } })),
        )
        .await?;
        if admins <= 1 {
            return Err(AppError::conflict("Cannot disable the last active administrator."));
        }
    }
    db::set_fields(&st.db, "users", scoped, as_doc(json!( { "disabled": body.disabled }))).await?;
    Ok(Json(json!({ "user_id": user_id, "disabled": body.disabled })))
}

async fn delete_user(
    State(st): State<AppState>,
    Admin(admin): Admin,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if user_id == doc_str(&admin, "user_id") {
        return Err(AppError::bad("You cannot delete your own account."));
    }
    let scoped = as_doc(json!( { "user_id": &user_id, "env": { "$in": [st.env_name(), Value::Null] } }));
    let target = db::find_one(&st.db, "users", scoped.clone())
        .await?
        .ok_or_else(|| AppError::not_found("User not found"))?;
    if doc_str(&target, "role") == "admin" {
        let admins = db::count(
            &st.db,
            "users",
            as_doc(json!( { "role": "admin", "env": { "$in": [st.env_name(), Value::Null] } })),
        )
        .await?;
        if admins <= 1 {
            return Err(AppError::conflict("Cannot delete the last remaining administrator."));
        }
    }
    db::delete_one(&st.db, "users", scoped).await?;
    Ok(Json(json!({
        "ok": true,
        "message": format!("User {} deleted successfully.", doc_str(&target, "name")),
    })))
}

async fn change_my_password(
    State(st): State<AppState>,
    Member(member): Member,
    Json(body): Json<ChangePasswordIn>,
) -> ApiResult<Json<Value>> {
    if body.new_password.len() < 4 {
        return Err(AppError::bad("Password must be at least 4 characters"));
    }
    let user_id = doc_str(&member, "user_id");
    let target = db::find_one(&st.db, "users", as_doc(json!( { "user_id": &user_id })))
        .await?
        .ok_or_else(|| AppError::not_found("User record not found"))?;
    let current = body.current_password.clone().unwrap_or_default();
    if target.contains_key("password_hash") {
        if current.is_empty() || !verify_password(&current, &doc_str(&target, "password_hash")) {
            return Err(AppError::unauthorized("Current password is incorrect"));
        }
    } else if doc_str(&target, "auth") == "ldap" {
        let integrations = st.integrations.read().await.clone();
        if !integrations.ldap.url.is_empty() && !integrations.ldap.base_dn.is_empty() {
            if current.is_empty() {
                return Err(AppError::unauthorized("Current password is required"));
            }
            let login = if doc_str(&target, "username").is_empty() {
                doc_str(&target, "email")
            } else {
                doc_str(&target, "username")
            };
            let ok = ldap_password_ok(&integrations.ldap, &login, &current).await;
            if !ok {
                return Err(AppError::unauthorized("Current password is incorrect"));
            }
        }
    }
    db::set_fields(
        &st.db,
        "users",
        as_doc(json!( { "user_id": &user_id })),
        as_doc(json!( { "password_hash": hash_password(&body.new_password), "has_password": true })),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "message": "Password changed successfully." })))
}

async fn set_role(
    State(st): State<AppState>,
    Admin(admin): Admin,
    Path(user_id): Path<String>,
    Json(body): Json<RoleIn>,
) -> ApiResult<Json<Value>> {
    if !ROLES.contains(&body.role.as_str()) || rank(&body.role) > rank(&role_of(&admin)) {
        return Err(AppError::forbidden("Not allowed"));
    }
    let scoped = as_doc(json!( { "user_id": &user_id, "env": { "$in": [st.env_name(), Value::Null] } }));
    let target = db::find_one(&st.db, "users", scoped.clone())
        .await?
        .ok_or_else(|| AppError::not_found("Not found"))?;
    if effective_role(target.get("role")) == "admin" && body.role != "admin" {
        let admins = db::count(
            &st.db,
            "users",
            as_doc(json!( { "role": "admin", "env": { "$in": [st.env_name(), Value::Null] } })),
        )
        .await?;
        if admins <= 1 {
            return Err(AppError::conflict("Keep at least one admin"));
        }
    }
    db::set_fields(&st.db, "users", scoped, as_doc(json!( { "role": &body.role }))).await?;
    Ok(Json(json!({ "user_id": user_id, "role": body.role })))
}

async fn people(State(st): State<AppState>, Staff(_m): Staff) -> ApiResult<Json<Vec<Value>>> {
    let docs = db::find(
        &st.db,
        "users",
        DbQuery::new(in_env(st.env_name()))
            .project(as_doc(json!( { "user_id": 1, "name": 1, "email": 1, "role": 1 }))),
    )
    .await?;
    Ok(Json(
        docs.iter()
            .map(|d| {
                let mut copy = d.clone();
                copy.insert("role".to_string(), effective_role(d.get("role")));
                to_json(&copy)
            })
            .collect(),
    ))
}
