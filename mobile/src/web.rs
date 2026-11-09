//! La app del celular (`web/`), metida dentro del binario: un solo archivo para copiar
//! al servidor. Con `--web carpeta` se lee del disco para desarrollar.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::App;

macro_rules! files {
    ($($name:literal),* $(,)?) => {
        &[$(($name, include_bytes!(concat!("../web/", $name)) as &[u8])),*]
    };
}

static FILES: &[(&str, &[u8])] = files![
    "index.html",
    "app.css",
    "app.js",
    "sw.js",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/maskable-512.png",
];

pub fn routes() -> Router<Arc<App>> {
    Router::new().route("/", get(|s| serve(s, Path("index.html".to_string())))).route("/{*path}", get(serve))
}

fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

async fn serve(State(app): State<Arc<App>>, Path(path): Path<String>) -> Response {
    let name = path.trim_start_matches('/');
    let body: Option<Vec<u8>> = match &app.web_dir {
        Some(dir) if !name.contains("..") => std::fs::read(dir.join(name)).ok(),
        _ => FILES.iter().find(|(n, _)| *n == name).map(|(_, b)| b.to_vec()),
    };
    match body {
        // El service worker guarda la app en el teléfono; acá solo se revalida.
        Some(b) => ([(header::CONTENT_TYPE, mime(name)), (header::CACHE_CONTROL, "no-cache")], b).into_response(),
        // Rutas de la app (/album/…): la misma página, que se arma sola.
        None if !name.contains('.') => match &app.web_dir {
            Some(dir) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], std::fs::read(dir.join("index.html")).unwrap_or_default()).into_response(),
            None => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], FILES[0].1).into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
