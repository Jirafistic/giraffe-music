//! "Transfer from Spotify": pega el link de una playlist pública de Spotify y Giraffe
//! crea una playlist privada en tu cuenta de YouTube Music con las mismas canciones.
//!
//! Spotify se lee con `src/transfer/spotify.rs` de ytm-rs (sin cambios). Las reglas para
//! decidir qué resultado de YouTube Music es la misma canción (título, artista,
//! duración) son las de `src/transfer/mod.rs`, copiadas acá abajo porque ese archivo
//! está atado a la app de escritorio.
//!
//! Corre solo mientras dura la importación, de a 3 búsquedas a la vez.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::model::Track as YtTrack;
use crate::spotify::{self, Source, Track};
use crate::ytmapi::Api;
use crate::{App, ytm};

#[derive(Clone, Default, Serialize)]
pub struct State {
    /// "idle", "reading", "matching", "creating", "done", "error"
    pub phase: String,
    pub name: String,
    pub total: usize,
    pub done: usize,
    pub found: usize,
    pub missing: Vec<String>,
    pub playlist: Option<String>,
    pub error: Option<String>,
}

pub fn routes() -> Router<Arc<App>> {
    Router::new().route("/api/transfer", get(status).post(start))
}

async fn status(axum::extract::State(app): axum::extract::State<Arc<App>>) -> Response {
    let mut s = app.transfer.lock().unwrap().clone();
    if s.phase.is_empty() {
        s.phase = "idle".into();
    }
    Json(s).into_response()
}

#[derive(Deserialize)]
struct Start {
    link: String,
}

async fn start(axum::extract::State(app): axum::extract::State<Arc<App>>, Json(b): Json<Start>) -> Response {
    if !app.signed_in() {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign in to YouTube Music first"}))).into_response();
    }
    let source = match Source::parse(&b.link) {
        Ok(Source::Playlist(id)) => id,
        Ok(Source::Liked) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "Liked Songs needs a Spotify sign-in; paste a playlist link"}))).into_response(),
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response(),
    };
    {
        let mut s = app.transfer.lock().unwrap();
        if matches!(s.phase.as_str(), "reading" | "matching" | "creating") {
            return (StatusCode::CONFLICT, Json(json!({"error": "A transfer is already running"}))).into_response();
        }
        *s = State { phase: "reading".into(), ..Default::default() };
    }
    let a = app.clone();
    tokio::spawn(async move {
        if let Err(e) = run(&a, &source).await {
            log::warn!("transfer: {e:#}");
            let mut s = a.transfer.lock().unwrap();
            s.phase = "error".into();
            s.error = Some(format!("{e:#}"));
        }
    });
    Json(json!({"ok": true})).into_response()
}

fn set(app: &App, f: impl FnOnce(&mut State)) {
    f(&mut app.transfer.lock().unwrap());
}

async fn run(app: &Arc<App>, id: &str) -> anyhow::Result<()> {
    if app.demo {
        return demo(app).await;
    }
    let client = spotify::Client::connect(None, &app.data_dir).await?;
    let pl = client.playlist(id, |_, _| {}).await?;
    set(app, |s| {
        s.name = pl.name.clone();
        s.total = pl.tracks.len();
        s.phase = "matching".into();
    });
    // De a 3: rápido sin que YouTube Music empiece a rechazar búsquedas.
    let results: Vec<(usize, Option<String>)> = futures_util::stream::iter(pl.tracks.clone().into_iter().enumerate())
        .map(|(i, t)| {
            let app = app.clone();
            async move {
            let hit = search_song(&app.api, &t).await.ok().flatten().filter(|(_, sure)| *sure).map(|(h, _)| h.id);
            set(&app, |s| {
                s.done += 1;
                if hit.is_some() {
                    s.found += 1;
                } else {
                    s.missing.push(format!("{} – {}", t.name, t.artist_line()));
                }
            });
            (i, hit)
            }
        })
        .buffer_unordered(3)
        .collect()
        .await;
    let mut ordered = results;
    ordered.sort_by_key(|(i, _)| *i);
    let ids: Vec<String> = ordered.into_iter().filter_map(|(_, h)| h).collect();
    anyhow::ensure!(!ids.is_empty(), "No songs from that playlist were found on YouTube Music");
    set(app, |s| s.phase = "creating".into());
    let pid = ytm::create_playlist_with(&app.api, &pl.name, &ids).await?;
    set(app, |s| {
        s.playlist = Some(pid);
        s.phase = "done".into();
    });
    Ok(())
}

/// Modo demo: una importación de mentira, para mostrar la pantalla.
async fn demo(app: &Arc<App>) -> anyhow::Result<()> {
    set(app, |s| {
        s.name = "Spotify Favoritos".into();
        s.total = 24;
        s.phase = "matching".into();
    });
    for i in 0..24 {
        tokio::time::sleep(Duration::from_millis(120)).await;
        set(app, |s| {
            s.done += 1;
            if i % 9 == 4 {
                s.missing.push(format!("Canción rara {i} – Artista desconocido"));
            } else {
                s.found += 1;
            }
        });
    }
    set(app, |s| {
        s.playlist = Some("pl1".into());
        s.phase = "done".into();
    });
    Ok(())
}

// ------------------------------------------------------------------------------------
// Desde aquí: copiado de ytm-rs `src/transfer/mod.rs` (búsqueda y puntaje de coincidencias).

fn queries(t: &Track) -> Vec<String> {
    let title = plain_title(&t.name);
    let first = t.artists.first().map(String::as_str).unwrap_or_default();
    let mut out = vec![format!("{title} {first}").trim().to_owned()];
    let full = format!("{} {}", t.name, t.artists.join(" ")).trim().to_owned();
    if !out.contains(&full) {
        out.push(full);
    }
    out
}

fn plain_title(s: &str) -> &str {
    let cut = s.find(['(', '[']).into_iter().chain(s.find(" - ")).min().unwrap_or(s.len());
    match s[..cut].trim() {
        "" => s.trim(),
        t => t,
    }
}

async fn search_song(api: &Api, t: &Track) -> anyhow::Result<Option<(YtTrack, bool)>> {
    let mut hits: Vec<YtTrack> = Vec::new();
    let add = |hits: &mut Vec<YtTrack>, found: Vec<YtTrack>| {
        let new: Vec<YtTrack> = found.into_iter().take(5).filter(|h| !hits.iter().any(|x| x.id == h.id)).collect();
        hits.extend(new);
    };
    let queries = queries(t);
    for q in &queries {
        let found = match ytm::search_songs(api, q, false).await {
            Ok(found) => found,
            Err(_) => ytm::search_tracks_signed_in(api, q, ytm::Filter::Songs).await?,
        };
        add(&mut hits, found);
        if let Some(b) = best(&hits, t).filter(|(_, sure)| *sure) {
            return Ok(Some(b));
        }
    }
    if api.account().is_some() {
        if let Ok(found) = ytm::search_tracks_signed_in(api, &queries[0], ytm::Filter::Songs).await {
            add(&mut hits, found);
        }
    }
    Ok(best(&hits, t))
}

fn best(hits: &[YtTrack], t: &Track) -> Option<(YtTrack, bool)> {
    let hit = hits.iter().rev().max_by_key(|h| score(h, t))?;
    Some((hit.clone(), matches(hit, t)))
}

fn matches(hit: &YtTrack, t: &Track) -> bool {
    let same_length = gap(hit, t).is_some_and(|g| g <= 3);
    title_score(hit, t) > 0 && !too_long_or_short(hit, t) && (t.artists.iter().any(|a| same_artist(hit, a)) || (same_length && other_script(hit, t)))
}

fn title_score(hit: &YtTrack, t: &Track) -> i32 {
    let want = base_title(&t.name);
    let parts = std::iter::once(hit.title.as_str()).chain(hit.title.split(" - "));
    parts
        .map(base_title)
        .map(|got| match () {
            _ if want.is_empty() || got.is_empty() => 0,
            _ if want == got => 4,
            _ if similar(&want, &got) => 3,
            _ if want.contains(&got) || got.contains(&want) => 2,
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

fn similar(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let longest = a.len().max(b.len());
    if a.len().min(b.len()) < 6 || a.len().abs_diff(b.len()) * 7 > longest {
        return false;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diag = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (diag + (ca != cb) as usize).min(row[j] + 1).min(row[j + 1] + 1);
            diag = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()] * 7 <= longest
}

fn same_artist(hit: &YtTrack, artist: &str) -> bool {
    let name = |s: &str| {
        let s = s.trim();
        norm(s.get(..4).filter(|p| p.eq_ignore_ascii_case("the ")).map_or(s, |_| &s[4..]))
    };
    let (want, line) = (name(artist), norm(&hit.artist_line()));
    let members: Vec<String> = artist.split(" & ").flat_map(|p| p.split(" and ")).flat_map(|p| p.split(", ")).map(name).collect();
    !want.is_empty()
        && (line.contains(&want) || hit.artists.iter().map(|a| name(&a.name)).any(|got| similar(&want, &got) || (members.len() > 1 && members.contains(&got))))
}

fn other_script(hit: &YtTrack, t: &Track) -> bool {
    let latin = |s: &str| s.chars().any(|c| c.is_ascii_alphabetic());
    latin(&t.artist_line()) != latin(&hit.artist_line())
}

fn gap(hit: &YtTrack, t: &Track) -> Option<u32> {
    Some(hit.duration?.abs_diff(t.duration?))
}

fn too_long_or_short(hit: &YtTrack, t: &Track) -> bool {
    gap(hit, t).is_some_and(|g| g > 30.max(t.duration.unwrap_or(0) / 5))
}

fn base_title(s: &str) -> String {
    let s = s.trim();
    let from = if s.starts_with(['(', '[']) { s.find([')', ']']).map_or(s.len(), |i| i + 1) } else { 0 };
    let rest = &s[from..];
    let cut = rest.find(['(', '[']).into_iter().chain(rest.find(" - ")).min().map_or(s.len(), |i| from + i);
    norm(&s[..cut])
}

fn norm(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.replace('&', "and").nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c) && c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

const VARIANTS: &[&str] = &[
    "remix", "edit", "mix", "live", "karaoke", "instrumental", "cover", "sped up", "slowed", "acoustic", "version", "made famous", "originally performed", "in the style of", "tribute", "tv size",
];

fn score(hit: &YtTrack, t: &Track) -> i32 {
    let title = title_score(hit, t);
    let mut score = title;
    for (i, artist) in t.artists.iter().enumerate() {
        if same_artist(hit, artist) {
            score += if i == 0 { 3 } else { 1 };
        }
    }
    score += match gap(hit, t) {
        Some(0..=3) if title > 0 => 3,
        Some(4..=10) if title > 0 => 1,
        _ if too_long_or_short(hit, t) => -3,
        _ => 0,
    };
    let (spotify, youtube) = (t.name.to_lowercase(), hit.title.to_lowercase());
    for v in VARIANTS {
        score += match (youtube.contains(v), spotify.contains(v)) {
            (true, false) => -1,
            (true, true) => 1,
            _ => 0,
        };
    }
    score
}
