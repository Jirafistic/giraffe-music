//! La cuenta de YouTube: iniciar sesión con la cookie que deja el inicio de sesión de
//! Google (ventana de login del APK) y lo que se hace con ella, todo con las funciones
//! de ytm-rs (`ytm::saved_playlists`, `ytm::set_like`, …).
//!
//! La sesión se guarda en la carpeta privada de la app (`vault`): no hay que volver a
//! iniciar sesión cada vez que se abre.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;

use crate::api::{card, track};
use std::sync::atomic::Ordering::Relaxed;

use crate::{App, demo, ytm};

type S = State<Arc<App>>;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/account", get(account))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me/library", get(library))
        .route("/api/me/liked", get(liked))
        .route("/api/me/history", get(history))
        .route("/api/me/like/{id}", post(like))
        .route("/api/me/save", post(save))
        .route("/api/me/playlist/{id}/add", post(add_to_playlist))
        .route("/api/me/playlists", post(create_playlist))
        .route("/api/me/forget", post(forget))
        .route("/api/me/playlist/{id}/edit", post(edit_playlist))
        .route("/api/me/playlist/{id}/remove", post(remove_from_playlist))
        .route("/api/me/playlist/{id}", axum::routing::delete(delete_playlist))
}

fn err(e: anyhow::Error) -> Response {
    log::warn!("cuenta: {e:#}");
    (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{e:#}")}))).into_response()
}

fn need_auth(app: &App) -> Option<Response> {
    (!app.signed_in()).then(|| (StatusCode::UNAUTHORIZED, Json(json!({"error": "not signed in"}))).into_response())
}

async fn account(State(app): S) -> Response {
    if app.demo && app.signed_in() {
        return Json(demo::account()).into_response();
    }
    if !app.auth() {
        return Json(json!({"signedIn": false})).into_response();
    }
    // El @ del canal, para el menú de la cuenta ("Your channel").
    let (acc, chans) = tokio::join!(ytm::account(&app.api), ytm::channels(&app.api));
    let (name, photo) = acc.unwrap_or((None, None));
    let chans = chans.unwrap_or_default();
    let ch = chans.iter().find(|c| Some(&c.name) == name.as_ref()).or(chans.first());
    Json(json!({"signedIn": true, "name": name, "photo": photo, "handle": ch.and_then(|c| c.handle.clone())})).into_response()
}

#[derive(Deserialize)]
struct LoginBody {
    cookie: String,
}

async fn login(State(app): S, Json(b): Json<LoginBody>) -> Response {
    if app.demo {
        app.demo_auth.store(true, Relaxed);
        return Json(demo::account()).into_response();
    }
    if !b.cookie.contains("SAPISID=") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "the sign-in didn't finish"}))).into_response();
    }
    match app.api.session_from_cookie(b.cookie.trim()).await {
        Ok(s) => {
            app.api.sign_in(s);
            // Las URLs de audio ya resueltas eran de la sesión anónima.
            app.streams.clear();
            log::info!("sesión iniciada");
            account(State(app)).await
        }
        Err(e) => err(e),
    }
}

async fn logout(State(app): S) -> Response {
    app.demo_auth.store(false, Relaxed);
    app.api.sign_out();
    app.streams.clear();
    Json(json!({"ok": true})).into_response()
}

/// Las playlists y los álbumes guardados en la cuenta.
async fn library(State(app): S) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(demo::library()).into_response();
    }
    let (pl, al) = tokio::join!(ytm::saved_playlists(&app.api), ytm::saved_albums(&app.api));
    match (pl, al) {
        (Err(e), Err(_)) => err(e),
        (pl, al) => Json(json!({
            "playlists": pl.unwrap_or_default().iter().map(card).collect::<Vec<_>>(),
            "albums": al.unwrap_or_default().iter().map(card).collect::<Vec<_>>(),
        }))
        .into_response(),
    }
}

/// "Liked Music" de la cuenta (la playlist LM).
async fn liked(State(app): S) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(demo::liked()).into_response();
    }
    match ytm::playlist_start(&app.api, "LM", true, None).await {
        Ok((c, token, limit)) => Json(json!({
            "tracks": c.tracks.iter().map(track).collect::<Vec<_>>(),
            "count": c.count,
            "continuation": token.filter(|_| c.tracks.len() < limit),
            "limit": limit,
        }))
        .into_response(),
        Err(e) => err(e),
    }
}

async fn history(State(app): S) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(demo::history()).into_response();
    }
    match ytm::history(&app.api).await {
        Ok(t) => Json(json!(t.iter().map(track).collect::<Vec<_>>())).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct LikeBody {
    /// "like", "dislike" o "none".
    rating: String,
}

async fn like(State(app): S, Path(id): Path<String>, Json(b): Json<LikeBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true, "id": "pl9"})).into_response();
    }
    let r = match b.rating.as_str() {
        "like" => ytm::set_like(&app.api, &id, true).await,
        "dislike" => ytm::dislike(&app.api, &id).await,
        _ => ytm::set_like(&app.api, &id, false).await,
    };
    match r {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct SaveBody {
    /// La playlist (o la playlist del álbum, `OLAK5uy_…`) a guardar o sacar de la biblioteca.
    id: String,
    save: bool,
}

async fn save(State(app): S, Json(b): Json<SaveBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true, "id": "pl9"})).into_response();
    }
    match ytm::save_collection(&app.api, &b.id, b.save).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct IdsBody {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    title: String,
    /// PUBLIC, UNLISTED o PRIVATE (la de YouTube Music al crear es PRIVATE).
    #[serde(default)]
    privacy: String,
}

fn privacy(p: &str) -> Option<&'static str> {
    match p {
        "PUBLIC" => Some("PUBLIC"),
        "UNLISTED" => Some("UNLISTED"),
        "PRIVATE" => Some("PRIVATE"),
        _ => None,
    }
}

async fn add_to_playlist(State(app): S, Path(id): Path<String>, Json(b): Json<IdsBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true, "id": "pl9"})).into_response();
    }
    match ytm::add_videos(&app.api, &id, &b.ids).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

async fn create_playlist(State(app): S, Json(b): Json<IdsBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true, "id": "pl9"})).into_response();
    }
    let title = if b.title.trim().is_empty() { "Giraffe Music".to_string() } else { b.title.trim().to_string() };
    match ytm::create_playlist_with(&app.api, &title, &b.ids).await {
        Ok(id) => {
            // Se crea privada; si eligió otra visibilidad, se cambia enseguida.
            if let Some(p) = privacy(&b.privacy).filter(|p| *p != "PRIVATE") {
                if let Err(e) = ytm::edit_playlist(&app.api, &id, &title, "", Some(p)).await {
                    log::warn!("visibilidad de la playlist nueva: {e:#}");
                }
            }
            Json(json!({"ok": true, "id": id})).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct ForgetBody {
    token: String,
}

/// Saca una búsqueda del historial de búsquedas de la cuenta.
async fn forget(State(app): S, Json(b): Json<ForgetBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true})).into_response();
    }
    match ytm::forget_search(&app.api, &b.token).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct EditBody {
    title: String,
    #[serde(default)]
    description: String,
    /// Vacío: la visibilidad no se toca.
    #[serde(default)]
    privacy: String,
}

/// Nombre, descripción y visibilidad de una playlist tuya, en tu cuenta de YouTube.
async fn edit_playlist(State(app): S, Path(id): Path<String>, Json(b): Json<EditBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true})).into_response();
    }
    let title: String = b.title.chars().filter(|c| !matches!(c, '<' | '>')).take(150).collect();
    let description: String = b.description.chars().filter(|c| !matches!(c, '<' | '>')).take(5000).collect();
    if title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "The title can't be empty"}))).into_response();
    }
    match ytm::edit_playlist(&app.api, &id, title.trim(), &description, privacy(&b.privacy)).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

/// Borra una playlist tuya (también en YouTube).
async fn delete_playlist(State(app): S, Path(id): Path<String>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true})).into_response();
    }
    match ytm::delete_playlist(&app.api, &id).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct RemoveBody {
    #[serde(rename = "videoId")]
    video_id: String,
    #[serde(rename = "setId")]
    set_id: String,
}

/// Saca una canción de una playlist tuya (en tu cuenta). "Deshacer" la vuelve a agregar.
async fn remove_from_playlist(State(app): S, Path(id): Path<String>, Json(b): Json<RemoveBody>) -> Response {
    if let Some(r) = need_auth(&app) {
        return r;
    }
    if app.demo {
        return Json(json!({"ok": true})).into_response();
    }
    match ytm::remove_videos(&app.api, &id, &[(b.video_id, b.set_id)]).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}
