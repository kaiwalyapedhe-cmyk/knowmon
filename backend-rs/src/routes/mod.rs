pub mod auth_ldap;
pub mod clerk;
pub mod digest;
pub mod integrations;
pub mod interactions;
pub mod kb;
pub mod misc;
pub mod qa;
pub mod users;

use crate::state::AppState;
use axum::Router;

pub fn api_router() -> Router<AppState> {
    Router::new()
        .merge(users::router())
        .merge(qa::forms_router())
        .merge(qa::qa_ops_router())
        .merge(interactions::router())
        .merge(kb::router())
        .merge(misc::router())
        .merge(digest::router())
        .merge(integrations::router())
        .merge(auth_ldap::router())
        .merge(clerk::router())
}
