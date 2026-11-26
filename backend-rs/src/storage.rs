//! Object storage for call recordings (same proxy API the Python backend used).

use crate::error::ApiResult;
use crate::state::AppState;
use serde_json::json;
use crate::util::{as_doc, Document};

async fn storage_key(state: &AppState, force: bool) -> String {
    if !force {
        if let Some(key) = state.storage_key.read().await.clone() {
            return key;
        }
    }
    let url = format!("{}/init", state.cfg.storage_base);
    let body = as_doc(json!({ "emergent_key": state.cfg.llm_key }));
    match state.http.post(url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                if let Some(key) = v.get("storage_key").and_then(|k| k.as_str()) {
                    *state.storage_key.write().await = Some(key.to_string());
                    return key.to_string();
                }
            }
            tracing::error!("storage init returned no key; using local_dev_storage_key");
            "local_dev_storage_key".to_string()
        }
        Ok(resp) => {
            tracing::error!("storage init failed ({}); using local_dev_storage_key", resp.status());
            "local_dev_storage_key".to_string()
        }
        Err(err) => {
            tracing::error!("storage init failed ({err}); using local_dev_storage_key");
            "local_dev_storage_key".to_string()
        }
    }
}

pub async fn put_object(
    state: &AppState,
    path: &str,
    data: Vec<u8>,
    content_type: &str,
) -> ApiResult<Document> {
    let full = format!("{}/{}", state.cfg.app_name, path);
    let url = format!("{}/objects/{}", state.cfg.storage_base, full);
    let key = storage_key(state, false).await;
    let resp = state
        .http
        .put(url)
        .header("X-Storage-Key", key)
        .header("Content-Type", content_type)
        .body(data)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(crate::error::AppError::upstream("Recording upload failed"));
    }
    let v: serde_json::Value = resp.json().await.unwrap_or_default();
    Ok(Document::from_value(v))
}

pub async fn get_object(state: &AppState, full_path: &str) -> ApiResult<(Vec<u8>, String)> {
    let url = format!("{}/objects/{}", state.cfg.storage_base, full_path);
    for attempt in [false, true] {
        let key = storage_key(state, attempt).await;
        let resp = state
            .http
            .get(&url)
            .header("X-Storage-Key", key)
            .send()
            .await?;
        if resp.status().as_u16() == 404 && !attempt {
            continue;
        }
        if !resp.status().is_success() {
            return Err(crate::error::AppError::upstream(
                "Recording is temporarily unavailable",
            ));
        }
        let ctype = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp.bytes().await?.to_vec();
        return Ok((bytes, ctype));
    }
    Err(crate::error::AppError::upstream("Recording is temporarily unavailable"))
}
