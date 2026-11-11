//! La API JSON que usa la app del celular, y el audio.
//!
//! Todo lo que manda es chico y ya listo para dibujar: una sola miniatura por item, del
//! tamaño justo (`model::sized`), así el teléfono no baja ni escala imágenes enormes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::model::{self, Card, Shelf, ShelfKind, Target, Track};
use crate::{App, demo, innertube, proxy, sponsorblock, ytm};

type AppState = State<Arc<App>>;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/home", get(home))
        .route("/api/home/more", get(home_more))
        .route("/api/explore", get(explore))
        .route("/api/search", get(search))
        .route("/api/suggest", get(suggest))
        .route("/api/album/{id}", get(album))
        .route("/api/playlist/{id}", get(playlist))
        .route("/api/playlist-more", get(playlist_more))
        .route("/api/artist/{id}", get(artist))
        .route("/api/radio/{id}", get(radio))
        .route("/api/lyrics", get(lyrics))
        .route("/api/skip/{id}", get(skip))
        .route("/api/stream/{id}", get(stream))
        .route("/api/vstream/{id}", get(vstream))
        .route("/api/video/{id}", get(video_pair))
        .route("/api/loudness/{id}", get(loudness))
        .route("/api/img", get(img))
        .route("/api/status", get(status))
        .route("/api/plays", axum::routing::post(log_play))
        .route("/api/capsule", get(capsule))
}

// ------------------------------------------------------------------ JSON helpers

/// Tamaños pedidos al CDN de imágenes: filas de canciones, tarjetas, reproductor.
const ROW_PX: u32 = 120;
const CARD_PX: u32 = 320;
const ART_PX: u32 = 720;

fn thumb(thumbs: &[model::Thumb], px: u32) -> Option<String> {
    model::pick(thumbs, px).map(|u| model::sized(u, px))
}

pub fn track(t: &Track) -> Value {
    // Miniaturas de video (i.ytimg.com): las 4:3 traen franjas negras arriba y abajo.
    // mqdefault es 16:9 sin franjas (se recorta bien a cuadrado) y hq720 la grande.
    let ytimg = model::pick(&t.thumbs, ROW_PX).is_some_and(|u| u.contains("i.ytimg.com/vi"));
    let (row, art) = if ytimg {
        (Some(format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", t.id)), Some(format!("https://i.ytimg.com/vi/{}/hq720.jpg", t.id)))
    } else {
        (thumb(&t.thumbs, ROW_PX), thumb(&t.thumbs, ART_PX))
    };
    json!({
        "id": t.id,
        "title": t.title,
        "artists": t.artists,
        "album": t.album,
        "duration": t.duration,
        "thumb": row,
        "art": art,
        "wide": ytimg,
        "explicit": t.explicit,
        "plays": t.plays,
        "video": t.music_video,
    })
}

pub fn card(c: &Card) -> Value {
    let (kind, id, tr) = match &c.target {
        Target::Song(t) => ("song", t.id.clone(), Some(track(t))),
        Target::Album(id) => ("album", id.clone(), None),
        Target::Playlist(id) => ("playlist", id.clone(), None),
        Target::Artist(id) => ("artist", id.clone(), None),
    };
    json!({
        "title": c.title,
        "subtitle": c.subtitle,
        "thumb": thumb(&c.thumbs, CARD_PX),
        "round": c.round,
        "kind": kind,
        "id": id,
        "track": tr,
    })
}

fn shelf(s: &Shelf) -> Value {
    match &s.kind {
        ShelfKind::Cards(cards) => json!({
            "title": s.title, "strapline": s.strapline, "strapThumb": s.strap_thumb,
            "kind": "cards", "items": cards.iter().map(card).collect::<Vec<_>>(),
        }),
        ShelfKind::Songs { tracks, rows } => json!({
            "title": s.title, "strapline": s.strapline, "strapThumb": s.strap_thumb,
            "kind": "songs", "rows": rows, "items": tracks.iter().map(track).collect::<Vec<_>>(),
        }),
    }
}

/// Sin anuncios: fuera los estantes de promoción (Premium, "patrocinado", ofertas) y
/// los vacíos. El audio ya no trae anuncios: es el archivo de la canción, no el video.
fn is_promo(s: &Shelf) -> bool {
    let t = format!("{} {}", s.title, s.strapline.as_deref().unwrap_or_default()).to_lowercase();
    let empty = match &s.kind {
        ShelfKind::Cards(c) => c.is_empty(),
        ShelfKind::Songs { tracks, .. } => tracks.is_empty(),
    };
    empty || ["premium", "sponsored", "patrocinado", "promoted", "ad ·", "advertisement", "try it free", "offer"].iter().any(|w| t.contains(w))
}

fn home_json(h: &ytm::HomePage) -> Value {
    json!({
        "chips": h.chips.iter().map(|c| json!({"title": c.title, "params": c.params, "selected": c.selected})).collect::<Vec<_>>(),
        "shelves": h.shelves.iter().filter(|s| !is_promo(s)).map(shelf).collect::<Vec<_>>(),
        "continuation": h.continuation,
    })
}

/// Un error de YouTube como 502 con el mensaje, para que la app muestre "reintentar".
struct ApiErr(anyhow::Error);

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        log::warn!("{:#}", self.0);
        (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("{:#}", self.0)}))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiErr {
    fn from(e: E) -> Self {
        ApiErr(e.into())
    }
}

type R = Result<Response, ApiErr>;

/// JSON que el teléfono puede guardar un ratito sin volver a pedirlo.
fn cached(v: Value, secs: u32) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_str(&format!("private, max-age={secs}")).unwrap());
    r
}

// ------------------------------------------------------------------ pages

#[derive(Deserialize)]
struct HomeQ {
    params: Option<String>,
}

async fn home(State(app): AppState, Query(q): Query<HomeQ>) -> R {
    if app.demo {
        return Ok(cached(demo::home(q.params.as_deref()), 60));
    }
    let h = ytm::home(&app.api, q.params.as_deref(), app.auth()).await?;
    Ok(cached(home_json(&h), 120))
}

#[derive(Deserialize)]
struct TokenQ {
    token: String,
}

async fn home_more(State(app): AppState, Query(q): Query<TokenQ>) -> R {
    if app.demo {
        return Ok(cached(json!({"chips": [], "shelves": [], "continuation": null}), 60));
    }
    let h = ytm::home_more(&app.api, &q.token, app.auth()).await?;
    Ok(cached(home_json(&h), 300))
}

async fn explore(State(app): AppState) -> R {
    if app.demo {
        return Ok(cached(demo::explore(), 300));
    }
    let auth = app.auth();
    let (albums, charts) = tokio::join!(ytm::new_albums(&app.api, auth), ytm::charts(&app.api));
    let albums = albums.unwrap_or_default();
    let charts = charts.ok();
    Ok(cached(
        json!({
            "newReleases": albums.iter().take(20).map(card).collect::<Vec<_>>(),
            "topSongs": charts.as_ref().map(|c| c.top.iter().take(40).map(track).collect::<Vec<_>>()).unwrap_or_default(),
            "charts": charts.as_ref().map(|c| c.playlists.iter().map(card).collect::<Vec<_>>()).unwrap_or_default(),
        }),
        900,
    ))
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    #[serde(default)]
    filter: String,
}

async fn search(State(app): AppState, Query(q): Query<SearchQ>) -> R {
    if app.demo {
        return Ok(cached(demo::search(&q.q, &q.filter), 60));
    }
    let (api, auth, query) = (&app.api, app.auth(), q.q.trim());
    let cards = |f| async move { ytm::search_cards(api, query, f, auth).await.unwrap_or_default().iter().map(card).collect::<Vec<_>>() };
    let v = match q.filter.as_str() {
        "songs" => json!({"songs": ytm::search_songs(api, query, auth).await?.iter().map(track).collect::<Vec<_>>()}),
        "videos" => json!({"videos": ytm::search_videos(api, query, auth).await?.iter().map(track).collect::<Vec<_>>()}),
        "albums" => json!({"albums": cards(ytm::Filter::Albums).await}),
        "artists" => json!({"artists": cards(ytm::Filter::Artists).await}),
        "playlists" => json!({"playlists": cards(ytm::Filter::Playlists).await}),
        _ => {
            // La pestaña "Todo": varias búsquedas a la vez, como las secciones de la app.
            let (songs, artists, albums, playlists, videos, by_lyrics) = tokio::join!(
                ytm::search_songs(api, query, auth),
                cards(ytm::Filter::Artists),
                cards(ytm::Filter::Albums),
                cards(ytm::Filter::Playlists),
                ytm::search_videos(api, query, auth),
                search_by_lyrics(&app, query),
            );
            let songs = songs?;
            json!({
                "lyrics": by_lyrics,
                "songs": songs.iter().take(6).map(track).collect::<Vec<_>>(),
                "artists": artists.into_iter().take(4).collect::<Vec<_>>(),
                "albums": albums.into_iter().take(6).collect::<Vec<_>>(),
                "playlists": playlists.into_iter().take(6).collect::<Vec<_>>(),
                "videos": videos.unwrap_or_default().iter().take(4).map(track).collect::<Vec<_>>(),
            })
        }
    };
    Ok(cached(v, 300))
}

#[derive(Deserialize)]
struct SuggestQ {
    q: String,
}

/// Sugerencias; con sesión, primero las búsquedas pasadas de la cuenta (sincronizadas
/// con YouTube Music) y, con el campo vacío, solo esas.
async fn suggest(State(app): AppState, Query(q): Query<SuggestQ>) -> R {
    if app.demo {
        return Ok(cached(demo::suggest(&q.q, app.signed_in()), 60));
    }
    if q.q.trim().is_empty() && !app.auth() {
        return Ok(cached(json!([]), 60));
    }
    let s = ytm::suggestions(&app.api, &q.q, app.auth()).await?;
    let mut r = Json(json!(s.iter().map(|s| json!({"text": s.text, "history": s.forget.is_some(), "forget": s.forget})).collect::<Vec<_>>())).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(r)
}

fn collection(c: &crate::backend::Collection) -> Value {
    json!({
        "id": c.id,
        "isAlbum": c.is_album,
        "saveId": c.save_id.clone().unwrap_or_else(|| c.id.clone()),
        "owned": c.owned,
        "title": c.title,
        "subtitle": c.subtitle,
        "byline": c.byline(),
        "artists": c.artists,
        "description": c.description,
        "thumb": thumb(&c.thumbs, ART_PX),
        "tracks": c.tracks.iter().zip(c.set_ids.iter().map(Some).chain(std::iter::repeat(None))).map(|(t, s)| {
            let mut v = track(t);
            if let Some(Some(s)) = s {
                v["setId"] = json!(s);
            }
            v
        }).collect::<Vec<_>>(),
        "duration": c.tracks.iter().filter_map(|t| t.duration).map(u64::from).sum::<u64>(),
    })
}

async fn album(State(app): AppState, Path(id): Path<String>) -> R {
    if app.demo {
        return Ok(cached(demo::collection(&id, true), 3600));
    }
    Ok(cached(collection(&ytm::album(&app.api, &id).await?), 3600))
}

async fn playlist(State(app): AppState, Path(id): Path<String>) -> R {
    if app.demo {
        return Ok(cached(demo::collection(&id, false), 3600));
    }
    // La primera página (~100 canciones) enseguida; el resto lo pide la app de a páginas
    // mientras se ve la lista (`/api/playlist-more`), sin límite.
    let (c, token, limit) = ytm::playlist_start(&app.api, &id, app.auth(), None).await?;
    let mut v = collection(&c);
    v["continuation"] = json!(token.filter(|_| c.tracks.len() < limit));
    v["limit"] = json!(limit);
    Ok(cached(v, 600))
}

/// La página siguiente de una playlist.
async fn playlist_more(State(app): AppState, Query(q): Query<TokenQ>) -> R {
    if app.demo {
        return Ok(cached(demo::playlist_more(&q.token), 600));
    }
    let (tracks, set_ids, next) = ytm::playlist_more(&app.api, &q.token, app.auth()).await?;
    let tracks: Vec<Value> = tracks
        .iter()
        .zip(set_ids.iter().map(Some).chain(std::iter::repeat(None)))
        .map(|(t, s)| {
            let mut v = track(t);
            if let Some(Some(s)) = s {
                v["setId"] = json!(s);
            }
            v
        })
        .collect();
    Ok(cached(json!({"tracks": tracks, "continuation": next}), 600))
}

async fn artist(State(app): AppState, Path(id): Path<String>) -> R {
    if app.demo {
        return Ok(cached(demo::artist(&id), 3600));
    }
    let a = ytm::artist(&app.api, &id).await?;
    Ok(cached(
        json!({
            "id": a.id,
            "name": a.name,
            "banner": model::pick(&a.banner, 1080).map(str::to_owned),
            "subscribers": a.subscribers,
            "description": a.description,
            "top": a.top.iter().map(track).collect::<Vec<_>>(),
            "topPlaylist": a.top_playlist,
            "albums": a.albums.iter().map(card).collect::<Vec<_>>(),
            "playlists": a.playlists.iter().map(card).collect::<Vec<_>>(),
            "similar": a.similar.iter().map(card).collect::<Vec<_>>(),
        }),
        3600,
    ))
}

async fn radio(State(app): AppState, Path(id): Path<String>) -> R {
    if app.demo {
        return Ok(cached(demo::radio(&id), 600));
    }
    let tracks = ytm::radio(&app.api, &id, app.auth(), 30).await?;
    Ok(cached(json!(tracks.iter().map(track).collect::<Vec<_>>()), 600))
}

async fn status(State(app): AppState) -> Response {
    Json(json!({"demo": app.demo, "signedIn": app.signed_in(), "version": env!("CARGO_PKG_VERSION")})).into_response()
}

/// Partes que no son música (intros habladas, patrocinios) para saltar, de
/// SponsorBlock, igual que en ytm-rs. Las canciones de álbum casi nunca tienen.
async fn skip(State(app): AppState, Path(id): Path<String>) -> R {
    if app.demo {
        return Ok(cached(json!([]), 86400));
    }
    let segs = sponsorblock::segments(&proxy::http(), &id).await.unwrap_or_default();
    Ok(cached(json!(segs.iter().map(|s| json!({"start": s.start, "end": s.end, "length": s.video_duration})).collect::<Vec<_>>()), 86400))
}

// ------------------------------------------------------------------ lyrics

#[derive(Deserialize)]
pub struct LyricsQ {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    pub duration: Option<u32>,
}

/// Letras: las guardadas con la descarga si las hay (sin internet), si no LRCLIB.
async fn lyrics(State(app): AppState, Query(q): Query<LyricsQ>) -> R {
    if let Some(v) = app.downloads.lyrics(&q.id) {
        return Ok(cached(v, 86400));
    }
    Ok(cached(lyrics_lookup(&app, &q).await?, 86400))
}

/// Letras de LRCLIB (la misma fuente libre que usa ytm-rs), sincronizadas si las hay.
pub(crate) async fn lyrics_lookup(app: &App, q: &LyricsQ) -> anyhow::Result<Value> {
    if app.demo {
        return Ok(demo::lyrics(&q.title));
    }
    let http = proxy::http();
    let ua = concat!("giraffe-music/", env!("CARGO_PKG_VERSION"), " (https://github.com/grapedjuice/ytm-rs)");
    let mut params = vec![("track_name", q.title.clone()), ("artist_name", q.artist.clone())];
    if !q.album.is_empty() {
        params.push(("album_name", q.album.clone()));
    }
    if let Some(d) = q.duration {
        params.push(("duration", d.to_string()));
    }
    let exact = http.get("https://lrclib.net/api/get").query(&params).header("User-Agent", ua).timeout(Duration::from_secs(8)).send().await;
    let mut found: Option<Value> = match exact {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        _ => None,
    };
    if found.is_none() {
        let list: Vec<Value> = http
            .get("https://lrclib.net/api/search")
            .query(&[("track_name", &q.title), ("artist_name", &q.artist)])
            .header("User-Agent", ua)
            .timeout(Duration::from_secs(8))
            .send()
            .await?
            .json()
            .await
            .unwrap_or_default();
        found = list.into_iter().find(|v| v["syncedLyrics"].is_string() || v["plainLyrics"].is_string());
    }
    let v = found.unwrap_or(Value::Null);
    Ok(json!({"synced": v["syncedLyrics"], "plain": v["plainLyrics"]}))
}

// ------------------------------------------------------------------ buscar por la letra

/// Minúsculas, sin acentos ni signos: "¡Corazón!" → "corazon".
fn fold(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfd().filter(|c| c.is_alphanumeric() || c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// Distancia de edición (para tolerar errores de tipeo: "deneg" ≈ "denegó").
fn edits(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for j in 0..b.len() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != b[j])).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// El verso donde aparece la frase (sus palabras seguidas, cada una exacta, como comienzo de
/// una palabra o con un error de tipeo). None si la letra no la tiene.
pub(crate) fn lyric_match(lyrics: &str, query: &str) -> Option<String> {
    let q: Vec<String> = fold(query).split_whitespace().map(str::to_owned).collect();
    if q.len() < 2 {
        return None;
    }
    let word_ok = |w: &str, t: &str| w == t || w.starts_with(t) || (t.len() >= 4 && edits(w, t) <= 1) || (t.len() >= 3 && w.len() > t.len() && edits(&w[..w.char_indices().nth(t.chars().count()).map_or(w.len(), |(i, _)| i)], t) <= 1);
    let lines: Vec<&str> = lyrics.lines().map(|l| l.trim_start_matches(|c: char| c == '[' || c.is_ascii_digit() || c == ':' || c == '.' || c == ']').trim()).filter(|l| !l.is_empty()).collect();
    // Se busca en cada verso unido al siguiente (la frase puede cruzar de línea).
    for (i, line) in lines.iter().enumerate() {
        let joined = format!("{} {}", line, lines.get(i + 1).copied().unwrap_or(""));
        let words: Vec<String> = fold(&joined).split_whitespace().map(str::to_owned).collect();
        let first_len = fold(line).split_whitespace().count();
        for start in 0..first_len.min(words.len()) {
            if start + q.len() <= words.len() && q.iter().enumerate().all(|(k, t)| word_ok(&words[start + k], t)) {
                return Some((*line).to_owned());
            }
        }
    }
    None
}

/// Canciones cuya letra tiene la frase buscada (LRCLIB), ya encontradas en YouTube Music.
async fn search_by_lyrics(app: &App, query: &str) -> Vec<Value> {
    if fold(query).split_whitespace().count() < 2 {
        return vec![];
    }
    let ua = concat!("giraffe-music/", env!("CARGO_PKG_VERSION"), " (https://github.com/grapedjuice/ytm-rs)");
    let list: Vec<Value> = match proxy::http().get("https://lrclib.net/api/search").query(&[("q", query)]).header("User-Agent", ua).timeout(Duration::from_secs(4)).send().await {
        Ok(r) => r.json().await.unwrap_or_default(),
        Err(_) => return vec![],
    };
    let mut hits = vec![];
    for v in list.iter().take(30) {
        let text = v["plainLyrics"].as_str().or(v["syncedLyrics"].as_str()).unwrap_or_default();
        if let Some(line) = lyric_match(text, query) {
            let (t, a) = (v["trackName"].as_str().unwrap_or_default(), v["artistName"].as_str().unwrap_or_default());
            if !hits.iter().any(|(t2, a2, _): &(String, String, String)| fold(t2) == fold(t) && fold(a2) == fold(a)) {
                hits.push((t.to_owned(), a.to_owned(), line));
            }
        }
        if hits.len() >= 2 {
            break;
        }
    }
    let auth = app.auth();
    let found = futures_util::future::join_all(hits.iter().map(|(t, a, _)| {
        let q = format!("{t} {a}");
        async move { ytm::search_songs(&app.api, &q, auth).await.ok().and_then(|v| v.first().map(track)) }
    }))
    .await;
    found.into_iter().zip(hits).filter_map(|(f, (_, _, line))| f.map(|mut j| { j["lyricLine"] = json!(line); j })).collect()
}

// ------------------------------------------------------------------ volumen

/// Cuánto más fuerte que el objetivo está una canción (para "Normalize volume"). Sale
/// de la misma respuesta que da su audio, así que casi nunca cuesta un pedido extra.
async fn loudness(State(app): AppState, Path(id): Path<String>) -> R {
    if let Some(db) = app.downloads.loudness(&id) {
        return Ok(cached(json!({"db": db}), 86400));
    }
    if app.demo {
        let db = (id.bytes().map(|b| b as u32).sum::<u32>() % 9) as f32 - 2.0;
        return Ok(cached(json!({"db": db}), 86400));
    }
    let r = resolve(&app, &id, false).await?;
    Ok(cached(json!({"db": r.loudness}), 86400))
}

// ------------------------------------------------------------------ video

#[derive(Deserialize)]
struct PairQ {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    duration: Option<u32>,
    #[serde(default)]
    video: bool,
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// El videoclip de una canción, para el botón Video. Un videoclip es su propio video;
/// para una canción se busca su videoclip (mismo título y artista, duración parecida).
async fn video_pair(State(app): AppState, Path(id): Path<String>, Query(q): Query<PairQ>) -> R {
    if q.video || app.demo {
        return Ok(cached(json!({"id": id, "same": true}), 86400));
    }
    let hits = ytm::search_videos(&app.api, &format!("{} {}", q.title, q.artist), false).await?;
    let (title, artist) = (norm(&q.title), norm(&q.artist));
    let best = hits.iter().take(6).find(|v| {
        let t = norm(&v.title);
        let by = norm(&v.artist_line());
        let close = match (q.duration, v.duration) {
            (Some(a), Some(b)) => a.abs_diff(b) <= 45,
            _ => true,
        };
        t.contains(&title) && (by.contains(&artist) || t.contains(&artist) || artist.contains(&by)) && close
    });
    match best {
        Some(v) => Ok(cached(json!({"id": v.id, "same": false, "track": track(v)}), 86400)),
        None => Ok(cached(json!({"id": null}), 3600)),
    }
}

// ------------------------------------------------------------------ audio

/// Las URLs de googlevideo duran unas 6 horas; se guardan 4 para no pedirlas de nuevo
/// en cada salto o al volver a una canción.
const STREAM_TTL: Duration = Duration::from_secs(4 * 3600);
/// Cuánto se pide a googlevideo por vez (como los bloques de `stream.rs`).
pub(crate) const CHUNK: u64 = 512 * 1024;

#[derive(Clone)]
pub struct Resolved {
    pub url: String,
    pub size: u64,
    pub mime: &'static str,
    /// dB sobre el objetivo de -14 LUFS de YouTube (para normalizar el volumen).
    pub loudness: Option<f32>,
}

#[derive(Default)]
pub struct StreamCache(Mutex<HashMap<String, (Resolved, Instant)>>);

impl StreamCache {
    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

pub(crate) async fn resolve(app: &App, id: &str, fresh: bool) -> anyhow::Result<Resolved> {
    if !fresh && let Some((r, at)) = app.streams.0.lock().unwrap().get(id) && at.elapsed() < STREAM_TTL {
        return Ok(r.clone());
    }
    let visitor = app.api.visitor_data(fresh).await?;
    let r = if let Some(vid) = id.strip_prefix("v:") {
        // Video: H.264 hasta 720p, que todos los teléfonos decodifican por hardware.
        let v = innertube::video_stream(&proxy::http(), vid, &visitor, 720).await?;
        let size = url::Url::parse(&v.url)?.query_pairs().find(|(k, _)| k == "clen").and_then(|(_, v)| v.parse().ok());
        Resolved { size: size.ok_or_else(|| anyhow::anyhow!("video sin tamaño"))?, url: v.url, mime: "video/mp4", loudness: None }
    } else {
        // Calidad ("ID@low" / "ID@high"; sin sufijo, normal). Normal es AAC 128k (itag 140),
        // que el teléfono decodifica por hardware; baja, HE-AAC 48k (139); alta, Opus (251).
        let (vid, itags): (&str, &[u64]) = match id.split_once('@') {
            Some((v, "low")) => (v, &[139, 140]),
            Some((v, "high")) => (v, &[251, 140, 139]),
            _ => (id.split('@').next().unwrap_or(id), &[140, 139]),
        };
        let s = innertube::audio_stream_itags(&proxy::http(), vid, &visitor, itags).await?;
        Resolved { url: s.url, size: s.size, mime: if s.opus { "audio/webm" } else { "audio/mp4" }, loudness: s.loudness_db }
    };
    let mut map = app.streams.0.lock().unwrap();
    map.retain(|_, (_, at)| at.elapsed() < STREAM_TTL);
    map.insert(id.to_owned(), (r.clone(), Instant::now()));
    Ok(r)
}

/// `bytes=a-b` / `bytes=a-` → (a, b) dentro de `size`.
pub(crate) fn parse_range(h: &HeaderMap, size: u64) -> Option<(u64, u64)> {
    let v = h.get(header::RANGE)?.to_str().ok()?.strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    let (a, b) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        (a.parse().ok()?, if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) })
    };
    (a <= b && b < size).then_some((a, b))
}

pub(crate) fn audio_response(h: &HeaderMap, size: u64, mime: &str, body: impl FnOnce(u64, u64) -> Body) -> Response {
    let range = parse_range(h, size);
    let (a, b) = range.unwrap_or((0, size.saturating_sub(1)));
    let mut r = Response::new(body(a, b));
    *r.status_mut() = if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let hd = r.headers_mut();
    hd.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
    hd.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    hd.insert(header::CONTENT_LENGTH, HeaderValue::from(b - a + 1));
    hd.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    if range.is_some() {
        hd.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {a}-{b}/{size}")).unwrap());
    }
    r
}

/// El audio de una canción, con soporte de rangos (adelantar, retomar). Se pide a
/// googlevideo de a pedazos y solo a medida que el teléfono lo lee: si el reproductor
/// tiene suficiente en el buffer y deja de leer, esto también se frena.
#[derive(Deserialize)]
struct QualityQ {
    #[serde(default)]
    q: String,
}

async fn stream(State(app): AppState, Path(id): Path<String>, Query(qq): Query<QualityQ>, h: HeaderMap) -> R {
    // Descargada: desde el teléfono, sin red.
    if let Some(r) = app.downloads.serve(&id, &h).await {
        return Ok(r);
    }
    if app.demo {
        let wav = demo::audio(&id);
        return Ok(audio_response(&h, wav.len() as u64, "audio/wav", |a, b| Body::from(wav.slice(a as usize..=b as usize))));
    }
    let key = match qq.q.as_str() {
        "low" | "high" => format!("{id}@{}", qq.q),
        _ => id,
    };
    proxied(app, key, &h).await
}

/// El video (sin sonido: el audio sigue saliendo del reproductor) de un videoclip.
async fn vstream(State(app): AppState, Path(id): Path<String>, h: HeaderMap) -> R {
    if app.demo {
        let clip = demo::video();
        if clip.is_empty() {
            return Err(ApiErr(anyhow::anyhow!("sin video de demo")));
        }
        return Ok(audio_response(&h, clip.len() as u64, "video/mp4", |a, b| Body::from(clip.slice(a as usize..=b as usize))));
    }
    proxied(app, format!("v:{id}"), &h).await
}

/// Pasa audio o video de googlevideo al teléfono, con rangos, de a pedazos y solo a
/// medida que el reproductor lee.
async fn proxied(app: Arc<App>, id: String, h: &HeaderMap) -> R {
    let r = resolve(&app, &id, false).await?;
    let (app2, id2) = (app.clone(), id.clone());
    Ok(audio_response(h, r.size, r.mime, move |a, b| {
        let state = (a, b, r.url, false);
        let s = futures_util::stream::unfold(Some(state), move |st| {
            let (app, id) = (app2.clone(), id2.clone());
            async move {
                let (pos, end, mut url, mut renewed) = st?;
                if pos > end {
                    return None;
                }
                let to = (pos + CHUNK - 1).min(end);
                let mut tries = 0;
                loop {
                    match fetch(&format!("{url}&range={pos}-{to}")).await {
                        Ok(data) if data.is_empty() => return Some((Err(std::io::Error::other("vacío")), None)),
                        Ok(data) => {
                            let next = pos + data.len() as u64;
                            return Some((Ok::<Bytes, std::io::Error>(data), Some((next, end, url, renewed))));
                        }
                        // La URL venció o es de otra IP: se resuelve otra vez, una sola vez.
                        Err(e) if e.to_string().contains("403") && !renewed => {
                            renewed = true;
                            match resolve(&app, &id, true).await {
                                Ok(r) => url = r.url,
                                Err(e) => return Some((Err(std::io::Error::other(e.to_string())), None)),
                            }
                        }
                        Err(_) if tries < 3 => {
                            tries += 1;
                            tokio::time::sleep(Duration::from_millis(300 * tries)).await;
                        }
                        Err(e) => return Some((Err(std::io::Error::other(e.to_string())), None)),
                    }
                }
            }
        });
        Body::from_stream(s)
    }))
}

pub(crate) async fn fetch(url: &str) -> anyhow::Result<Bytes> {
    let r = proxy::http().get(url).header("User-Agent", innertube::UA).timeout(Duration::from_secs(20)).send().await?;
    anyhow::ensure!(r.status().is_success(), "googlevideo {}", r.status().as_u16());
    Ok(r.bytes().await?)
}

// ------------------------------------------------------------------ images

#[derive(Deserialize)]
struct ImgQ {
    u: String,
}

/// Carátulas a través del servidor: para guardarlas con las descargas y para sacar
/// el color del reproductor (el navegador no deja leer imágenes de otro dominio).
async fn img(State(app): AppState, Query(q): Query<ImgQ>) -> R {
    if app.demo || q.u.starts_with("/demo/") {
        return Ok((StatusCode::OK, [(header::CONTENT_TYPE, "image/svg+xml"), (header::CACHE_CONTROL, "public, max-age=604800")], demo::cover_svg(&q.u)).into_response());
    }
    let url = url::Url::parse(&q.u)?;
    let host = url.host_str().unwrap_or_default();
    if !["googleusercontent.com", "ggpht.com", "ytimg.com"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
        return Err(ApiErr(anyhow::anyhow!("solo carátulas de YouTube")));
    }
    let r = proxy::http().get(url).timeout(Duration::from_secs(15)).send().await?.error_for_status()?;
    let ct = r.headers().get(header::CONTENT_TYPE).cloned().unwrap_or(HeaderValue::from_static("image/jpeg"));
    let bytes = r.bytes().await?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=604800, immutable"))], bytes).into_response())
}

// ------------------------------------------------------------------ cápsula del tiempo

/// Cada canción escuchada, con fecha, en un archivo que solo crece al final (una línea
/// chica por canción). Es la base de "Hace un año escuchabas esto".
async fn log_play(State(app): AppState, Json(t): Json<Value>) -> Response {
    use tokio::io::AsyncWriteExt;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = json!({"at": now, "t": {"id": t["id"], "title": t["title"], "artists": t["artists"], "album": t["album"], "duration": t["duration"], "thumb": t["thumb"], "art": t["art"], "wide": t["wide"]}});
    if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(app.data_dir.join("plays.jsonl")).await {
        let _ = f.write_all(format!("{line}\n").as_bytes()).await;
    }
    Json(json!({"ok": true})).into_response()
}

/// Lo que escuchabas hace un año, un mes o una semana (lo más lejano con datos).
async fn capsule(State(app): AppState) -> Response {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let text = tokio::fs::read_to_string(app.data_dir.join("plays.jsonl")).await.unwrap_or_default();
    let plays: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    const DAY: u64 = 86_400;
    for (label, ago, window) in [("One year ago", 365 * DAY, 7 * DAY), ("One month ago", 30 * DAY, 4 * DAY), ("One week ago", 7 * DAY, 2 * DAY)] {
        let (from, to) = (now.saturating_sub(ago + window), now.saturating_sub(ago.saturating_sub(window)));
        let mut count: HashMap<String, (u32, Value)> = HashMap::new();
        for p in &plays {
            let at = p["at"].as_u64().unwrap_or(0);
            if at >= from && at <= to && let Some(id) = p["t"]["id"].as_str() {
                count.entry(id.to_owned()).or_insert((0, p["t"].clone())).0 += 1;
            }
        }
        if count.len() >= 3 {
            let mut v: Vec<(u32, Value)> = count.into_values().collect();
            v.sort_by(|a, b| b.0.cmp(&a.0));
            return Json(json!({"label": label, "tracks": v.into_iter().take(20).map(|(_, t)| t).collect::<Vec<_>>()})).into_response();
        }
    }
    Json(json!({"label": null, "tracks": []})).into_response()
}

#[cfg(test)]
mod lyric_tests {
    use super::lyric_match;
    #[test]
    fn finds_phrases_with_typos() {
        let l = "[00:01.00] Y el corazón se me denegó\n[00:05.00] net de la noche\nOtra línea";
        assert!(lyric_match(l, "corazon se me").is_some());
        assert!(lyric_match(l, "deneg net").is_some());
        assert!(lyric_match(l, "corazn se").is_some());
        assert!(lyric_match(l, "otra cosa").is_none());
        assert!(lyric_match(l, "corazon").is_none());
    }
}
