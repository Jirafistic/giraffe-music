//! Portadas propias de las playlists (elegidas desde la galería y recortadas en la app).
//! Se guardan en el teléfono y se ven en Giraffe; en YouTube la portada no cambia.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::App;

/// Una portada ya recortada a 720×720 pesa ~100 KB; más de 3 MB no es una portada.
const MAX: usize = 3 * 1024 * 1024;

fn safe(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn path(app: &App, id: &str) -> std::path::PathBuf {
    app.data_dir.join("covers").join(format!("{id}.jpg"))
}

pub fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/cover/{id}", get(read).post(write).delete(remove))
}

async fn read(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if !safe(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(path(&app, &id)).await {
        // La dirección lleva la versión (?v=…): se puede guardar para siempre.
        Ok(b) => ([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], b).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn write(State(app): State<Arc<App>>, Path(id): Path<String>, h: HeaderMap, body: Bytes) -> Response {
    let jpeg = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) == Some("image/jpeg") && body.starts_with(&[0xFF, 0xD8]);
    if !safe(&id) || !jpeg || body.len() > MAX {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let p = path(&app, &id);
    let _ = tokio::fs::create_dir_all(p.parent().unwrap()).await;
    match tokio::fs::write(&p, &body).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))).into_response(),
    }
}

async fn remove(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if safe(&id) {
        let _ = tokio::fs::remove_file(path(&app, &id)).await;
    }
    Json(json!({"ok": true})).into_response()
}
