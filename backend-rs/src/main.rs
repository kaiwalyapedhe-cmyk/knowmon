mod ai;
mod auth;
mod config;
mod db;
mod error;
mod ldap;
mod mailer;
mod models;
mod routes;
mod seed;
mod state;
mod storage;
mod util;

use axum::http::{header, HeaderValue, Method};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::from_filename("../backend/.env");
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let cfg = Arc::new(config::Config::from_env());
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(cfg.db_pool_max)
        .connect(&cfg.database_url)
        .await?;
    db::ensure_indexes(&db).await;
    let state = state::AppState::new(db.clone(), cfg.clone());

    if let Err(err) = seed::seed(&db).await {
        tracing::error!("seed failed: {}", err.detail);
    }

    let cors = if cfg.cors_origins.iter().any(|o| o == "*") {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<HeaderValue> = cfg
            .cors_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
            .allow_credentials(true)
    };
    let static_dir = cfg.static_dir.clone();
    let index = static_dir.join("index.html");
    let spa = ServeDir::new(&static_dir).fallback(ServeFile::new(&index));

    let app = axum::Router::new()
        .nest("/api", routes::api_router())
        .fallback_service(spa)
        .layer(cors)
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(tower_http::set_header::SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Cadence CX (Rust) listening on http://{addr} (api at /api, spa from {})", static_dir.display());
    axum::serve(listener, app).await?;
    let _ = Method::GET;
    Ok(())
}
