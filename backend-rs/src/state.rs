use crate::config::{Config, Integrations};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub db: crate::db::Db,
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
    pub integrations: Arc<RwLock<Integrations>>,
    pub storage_key: Arc<RwLock<Option<String>>>,
}

impl AppState {
    pub fn new(db: crate::db::Db, cfg: Arc<Config>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self {
            db,
            integrations: Arc::new(RwLock::new(cfg.integrations.as_ref().clone())),
            cfg,
            http,
            storage_key: Arc::new(RwLock::new(None)),
        }
    }

    pub fn env_name(&self) -> &str {
        &self.cfg.env
    }
}
