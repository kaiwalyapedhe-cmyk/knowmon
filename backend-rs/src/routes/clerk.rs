//! Clerk frontend config and the same-origin relay for Clerk's Frontend API.

use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::{json, Value};


const CLERK_FRONTEND_API: &str = "https://frontend-api.clerk.dev";
const PROXY_PATH: &str = "/api/__clerk";

const HOP_HEADERS: [&str; 10] = [
    "host",
    "connection",
    "keep-alive",
    "content-length",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/clerk/config", get(clerk_config))
        .route("/__clerk/*path", any(clerk_proxy))
}

async fn clerk_config(State(st): State<AppState>) -> Json<Value> {
    Json(json!({
        "enabled": st.cfg.clerk_enabled(),
        "publishable_key": st.cfg.clerk_publishable_key,
        "proxy_url": if st.cfg.clerk_is_production() { PROXY_PATH } else { "" },
    }))
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_default()
}

async fn clerk_proxy(State(st): State<AppState>, Path(path): Path<String>, req: Request) -> Response {
    if !st.cfg.clerk_is_production() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{CLERK_FRONTEND_API}/{path}{query}");
    let host = req
        .headers()
        .get("x-forwarded-host")
        .or_else(|| req.headers().get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let ip = client_ip(req.headers());
    let mut builder = st
        .http
        .request(method, url)
        .header("Clerk-Proxy-Url", format!("https://{host}{PROXY_PATH}"))
        .header("Clerk-Secret-Key", &st.cfg.clerk_secret_key);
    if !ip.is_empty() {
        builder = builder.header("X-Forwarded-For", ip);
    }
    for (name, value) in req.headers().iter() {
        let name_lower = name.as_str().to_lowercase();
        if HOP_HEADERS.contains(&name_lower.as_str()) || name_lower == "accept-encoding" {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_bytes());
    }
    let body_bytes = match axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }
    let upstream = match builder.send().await {
        Ok(resp) => resp,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    for (name, value) in upstream.headers().iter() {
        let name_lower = name.as_str().to_lowercase();
        if HOP_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        if let (Ok(header_name), Ok(header_value)) = (
            header::HeaderName::from_bytes(name.as_str().as_bytes()),
            header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.append(header_name, header_value);
        }
    }
    match upstream.bytes().await {
        Ok(bytes) => *response.body_mut() = Body::from(bytes),
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    }
    response
}
