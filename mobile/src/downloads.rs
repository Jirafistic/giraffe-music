//! Descargas: el audio, la carátula y la letra de una canción, guardados en la
//! carpeta privada de la app (en Android, `filesDir`: otras apps y el explorador de
//! archivos no la ven).
//!
//! Además, el comienzo de cada archivo se guarda mezclado (XOR con una clave por
//! canción): aunque alguien lo sacara del teléfono, no se reproduce en ningún otro
//! lado. Giraffe Music lo desmezcla al vuelo al servirlo. Solo se tocan los primeros
//! 64 KB, así que no cuesta nada de batería.
//!
//! Se descarga de a una canción por vez y en pedazos de 512 KB: la radio del teléfono
//! hace ráfagas cortas y vuelve a dormir.

use std::collections::{BTreeMap, HashMap};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::api::{self, LyricsQ};
use crate::{App, demo, innertube, proxy};

/// Cuánto del comienzo de cada archivo se guarda mezclado.
const HEAD: u64 = 64 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub track: Value,
    pub size: u64,
    pub mime: String,
    pub cover_mime: Option<String>,
    pub lyrics: Option<Value>,
    pub at: u64,
    /// Para normalizar el volumen sin internet.
    #[serde(default)]
    pub loudness: Option<f32>,
}

pub struct Downloads {
    dir: PathBuf,
    index: Mutex<BTreeMap<String, Entry>>,
    /// Progreso (0..1) de las que se están bajando o esperan su turno.
    active: Mutex<HashMap<String, f32>>,
    one_at_a_time: tokio::sync::Semaphore,
    /// Las que faltan bajar, en orden. Se guardan para seguir si la app se cierra.
    pending: Mutex<Vec<Value>>,
    /// Las que YouTube ya no tiene (borradas, privadas, bloqueadas): se saltean y se marcan.
    failed: Mutex<std::collections::BTreeSet<String>>,
}

/// La clave de una canción: un generador xorshift a partir de su id.
fn keystream(id: &str, len: usize) -> Vec<u8> {
    let mut x = format!("giraffe-music:{id}").bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3)) | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

/// Mezcla o desmezcla (es lo mismo) los bytes de `data` que caen en la cabecera,
/// sabiendo que `data` empieza en la posición `offset` del archivo.
fn mix(id: &str, offset: u64, data: &mut [u8]) {
    if offset >= HEAD {
        return;
    }
    let n = ((HEAD - offset) as usize).min(data.len());
    let key = keystream(id, (offset as usize) + n);
    for (i, b) in data[..n].iter_mut().enumerate() {
        *b ^= key[offset as usize + i];
    }
}

/// Mezcla un archivo chico entero (carátulas, letras).
fn mix_all(id: &str, data: &mut [u8]) {
    let key = keystream(&format!("{id}#all"), data.len());
    for (b, k) in data.iter_mut().zip(key) {
        *b ^= k;
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn safe(id: &str) -> bool {
    !id.is_empty() && id.len() < 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Downloads {
    pub fn open(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let index = std::fs::read(dir.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // Restos de una descarga cortada (la app se cerró a la mitad).
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().ends_with(".part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let pending = std::fs::read(dir.join("pending.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let failed = std::fs::read(dir.join("failed.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Ok(Self { dir, index: Mutex::new(index), active: Default::default(), one_at_a_time: tokio::sync::Semaphore::new(1), pending: Mutex::new(pending), failed: Mutex::new(failed) })
    }

    fn save_index(&self) {
        let data = serde_json::to_vec(&*self.index.lock().unwrap()).unwrap_or_default();
        let tmp = self.dir.join("index.json.tmp");
        if std::fs::write(&tmp, data).is_ok() {
            let _ = std::fs::rename(tmp, self.dir.join("index.json"));
        }
    }

    fn save_pending(&self) {
        let data = serde_json::to_vec(&*self.pending.lock().unwrap()).unwrap_or_default();
        let tmp = self.dir.join("pending.json.tmp");
        if std::fs::write(&tmp, data).is_ok() {
            let _ = std::fs::rename(tmp, self.dir.join("pending.json"));
        }
    }

    fn set_failed(&self, id: &str, failed: bool) {
        let mut f = self.failed.lock().unwrap();
        let changed = if failed { f.insert(id.to_owned()) } else { f.remove(id) };
        if changed {
            let _ = std::fs::write(self.dir.join("failed.json"), serde_json::to_vec(&*f).unwrap_or_default());
        }
    }

    fn unpend(&self, id: &str) {
        self.pending.lock().unwrap().retain(|t| t["id"].as_str() != Some(id));
        self.save_pending();
    }

    fn file(&self, id: &str, ext: &str) -> PathBuf {
        self.dir.join(format!("{id}.{ext}"))
    }

    pub fn loudness(&self, id: &str) -> Option<f32> {
        self.index.lock().unwrap().get(id).and_then(|e| e.loudness)
    }

    pub fn lyrics(&self, id: &str) -> Option<Value> {
        self.index.lock().unwrap().get(id).and_then(|e| e.lyrics.clone())
    }

    /// El audio de una canción descargada, con soporte de rangos (adelantar).
    pub async fn serve(&self, id: &str, h: &HeaderMap) -> Option<Response> {
        let e = self.index.lock().unwrap().get(id).cloned()?;
        let path = self.file(id, "a");
        let mut f = tokio::fs::File::open(&path).await.ok()?;
        let size = e.size;
        let (a, b) = api::parse_range(h, size).unwrap_or((0, size.saturating_sub(1)));
        // La cabecera mezclada se lee entera y se desmezcla; el resto va directo del disco.
        let mut head = Vec::new();
        if a < HEAD {
            let end = (b + 1).min(HEAD);
            head = vec![0; (end - a) as usize];
            f.seek(SeekFrom::Start(a)).await.ok()?;
            f.read_exact(&mut head).await.ok()?;
            mix(id, a, &mut head);
        }
        let rest_from = a.max(HEAD);
        let rest = if rest_from <= b {
            f.seek(SeekFrom::Start(rest_from)).await.ok()?;
            Some(tokio_util::io::ReaderStream::with_capacity(f.take(b - rest_from + 1), 64 * 1024))
        } else {
            None
        };
        let head = futures_util::stream::iter((!head.is_empty()).then(|| Ok::<_, std::io::Error>(bytes::Bytes::from(head))));
        let body = match rest {
            Some(r) => Body::from_stream(futures_util::StreamExt::chain(head, r)),
            None => Body::from_stream(head),
        };
        Some(api::audio_response(h, size, &e.mime, move |_, _| body))
    }

    fn list(&self) -> Value {
        let idx = self.index.lock().unwrap();
        let mut items: Vec<&Entry> = idx.values().collect();
        items.sort_by(|x, y| y.at.cmp(&x.at));
        let items: Vec<Value> = items
            .into_iter()
            .map(|e| {
                let mut t = e.track.clone();
                let id = t["id"].as_str().unwrap_or_default().to_owned();
                // Carátula local: se ve sin internet.
                if e.cover_mime.is_some() {
                    t["thumb"] = json!(format!("/api/dl/cover/{id}"));
                    t["art"] = json!(format!("/api/dl/cover/{id}"));
                }
                t["downloaded"] = json!(true);
                json!({"track": t, "size": e.size, "at": e.at, "lyrics": e.lyrics.as_ref().is_some_and(|l| !l["synced"].is_null() || !l["plain"].is_null())})
            })
            .collect();
        let bytes: u64 = idx.values().map(|e| e.size).sum();
        json!({"items": items, "active": *self.active.lock().unwrap(), "bytes": bytes, "failed": *self.failed.lock().unwrap()})
    }

    async fn remove(&self, id: &str) {
        self.index.lock().unwrap().remove(id);
        self.save_index();
        for ext in ["a", "c"] {
            let _ = tokio::fs::remove_file(self.file(id, ext)).await;
        }
    }
}

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/downloads", get(list).delete(clear))
        .route("/api/downloads/active", get(active).delete(cancel_all))
        .route("/api/downloads/failed", axum::routing::delete(forget_failed))
        .route("/api/download/{id}", post(start).delete(remove))
        .route("/api/dl/cover/{id}", get(cover))
}

async fn list(State(app): State<Arc<App>>) -> Response {
    let mut r = Json(app.downloads.list()).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// Solo las descargas en curso (id → progreso): lo que consulta la notificación.
async fn active(State(app): State<Arc<App>>) -> Response {
    let a = app.downloads.active.lock().unwrap().clone();
    Json(a).into_response()
}

/// Olvida canciones marcadas como "no se encontró" (por ejemplo, porque se quitaron de la playlist).
async fn forget_failed(State(app): State<Arc<App>>, Json(ids): Json<Vec<String>>) -> Response {
    for id in ids {
        app.downloads.set_failed(&id, false);
    }
    Json(json!({"ok": true})).into_response()
}

/// Cancela todo lo que falta bajar (botón "Cancel" de la notificación).
async fn cancel_all(State(app): State<Arc<App>>) -> Response {
    app.downloads.active.lock().unwrap().clear();
    app.downloads.pending.lock().unwrap().clear();
    app.downloads.save_pending();
    Json(json!({"ok": true})).into_response()
}

async fn remove(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    app.downloads.active.lock().unwrap().remove(&id);
    app.downloads.unpend(&id);
    app.downloads.remove(&id).await;
    Json(json!({"ok": true})).into_response()
}

async fn clear(State(app): State<Arc<App>>) -> Response {
    let ids: Vec<String> = app.downloads.index.lock().unwrap().keys().cloned().collect();
    for id in ids {
        app.downloads.remove(&id).await;
    }
    Json(json!({"ok": true})).into_response()
}

async fn cover(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let mime = app.downloads.index.lock().unwrap().get(&id).and_then(|e| e.cover_mime.clone());
    let (Some(mime), true) = (mime, safe(&id)) else { return StatusCode::NOT_FOUND.into_response() };
    match tokio::fs::read(app.downloads.file(&id, "c")).await {
        Ok(mut b) => {
            mix_all(&id, &mut b);
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=86400".to_string())], b).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct Track {
    id: String,
    title: String,
    #[serde(default)]
    artists: Vec<Value>,
    album: Option<Value>,
    duration: Option<u32>,
    art: Option<String>,
}

/// Pone una canción en la cola de descargas (el cuerpo es la canción, como la da la API).
async fn start(State(app): State<Arc<App>>, Path(id): Path<String>, Json(track): Json<Value>) -> Response {
    if !safe(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if app.downloads.index.lock().unwrap().contains_key(&id) {
        return Json(json!({"ok": true, "done": true})).into_response();
    }
    enqueue(&app, id, track, true);
    Json(json!({"ok": true})).into_response()
}

/// "No se encontró": YouTube respondió, pero sin audio para esa canción.
fn not_found(e: &anyhow::Error) -> bool {
    let s = format!("{e:#}").to_lowercase();
    s.contains("no audio stream") || s.contains("unavailable") || s.contains("not available") || s.contains("private") || s.contains("removed")
}

/// Al abrir la app: vuelve a poner en la cola lo que había quedado pendiente.
pub fn resume(app: Arc<App>) {
    let list = app.downloads.pending.lock().unwrap().clone();
    for t in list {
        if let Some(id) = t["id"].as_str().map(str::to_owned) {
            enqueue(&app, id, t, false);
        }
    }
}

/// Una por vez. Si algo falla (se cortó internet, YouTube no respondió) se reintenta con
/// esperas cada vez más largas; solo se abandona si la cancelan o falla muchas veces seguidas.
fn enqueue(app: &Arc<App>, id: String, track: Value, save: bool) {
    {
        let mut active = app.downloads.active.lock().unwrap();
        if active.contains_key(&id) {
            return;
        }
        active.insert(id.clone(), 0.0);
    }
    if save {
        app.downloads.set_failed(&id, false);
        app.downloads.pending.lock().unwrap().push(track.clone());
        app.downloads.save_pending();
    }
    let a = app.clone();
    tokio::spawn(async move {
        let _turn = a.downloads.one_at_a_time.acquire().await;
        for attempt in 0..6u64 {
            // Pudo haberse cancelado mientras esperaba.
            if !a.downloads.active.lock().unwrap().contains_key(&id) {
                break;
            }
            match download(&a, &id, track.clone()).await {
                Ok(()) => break,
                Err(e) => {
                    log::warn!("descarga de {id} (intento {}): {e:#}", attempt + 1);
                    let _ = tokio::fs::remove_file(a.downloads.file(&id, "a.part")).await;
                    if e.to_string().contains("cancelada") {
                        break;
                    }
                    // YouTube contestó pero no tiene la canción (borrada, privada, bloqueada):
                    // se prueba una vez más por las dudas y después se saltea, sin trabar la cola.
                    if not_found(&e) && attempt >= 1 {
                        a.downloads.set_failed(&id, true);
                        break;
                    }
                    if attempt == 5 {
                        break;
                    }
                    progress(&a, &id, 0.0);
                    tokio::time::sleep(Duration::from_secs([3, 10, 30, 60, 120][attempt as usize])).await;
                }
            }
        }
        a.downloads.active.lock().unwrap().remove(&id);
        a.downloads.unpend(&id);
    });
}

fn progress(app: &App, id: &str, p: f32) {
    if let Some(v) = app.downloads.active.lock().unwrap().get_mut(id) {
        *v = p;
    }
}

async fn download(app: &Arc<App>, id: &str, raw: Value) -> anyhow::Result<()> {
    let t: Track = serde_json::from_value(raw.clone())?;
    anyhow::ensure!(t.id == id, "id distinto");
    let d = &app.downloads;
    let part = d.file(id, "a.part");

    // 1. El audio.
    let mut f = tokio::fs::File::create(&part).await?;
    let mut loud = None;
    // Demo: las canciones "gone…" hacen de canciones que YouTube ya no tiene.
    anyhow::ensure!(!(app.demo && id.starts_with("gone")), "no audio stream in visionOS player response");
    let (size, mime) = if app.demo {
        let mut wav = demo::audio(id).to_vec();
        mix(id, 0, &mut wav);
        f.write_all(&wav).await?;
        (wav.len() as u64, "audio/wav")
    } else {
        let mut r = api::resolve(app, id, false).await?;
        loud = r.loudness;
        let mut pos = 0u64;
        let mut renewed = false;
        while pos < r.size {
            let to = (pos + api::CHUNK - 1).min(r.size - 1);
            let mut tries = 0;
            let mut data = loop {
                match api::fetch(&format!("{}&range={pos}-{to}", r.url)).await {
                    Ok(b) if !b.is_empty() => break b.to_vec(),
                    Err(e) if e.to_string().contains("403") && !renewed => {
                        renewed = true;
                        r = api::resolve(app, id, true).await?;
                    }
                    Err(e) if tries >= 4 => return Err(e),
                    _ => {
                        tries += 1;
                        tokio::time::sleep(Duration::from_millis(500 * tries)).await;
                    }
                }
            };
            mix(id, pos, &mut data);
            f.write_all(&data).await?;
            pos += data.len() as u64;
            progress(app, id, pos as f32 / r.size as f32 * 0.95);
            // Cancelada desde la app.
            if !d.active.lock().unwrap().contains_key(id) {
                anyhow::bail!("cancelada");
            }
        }
        (r.size, r.mime)
    };
    f.flush().await?;
    drop(f);

    // 2. La carátula, grande (la del reproductor).
    let mut cover_mime = None;
    if let Some(art) = t.art.as_deref() {
        let got: anyhow::Result<(Vec<u8>, String)> = async {
            if let Some(seed) = art.strip_prefix("/api/img?u=") {
                return Ok((demo::cover_svg(seed).into_bytes(), "image/svg+xml".to_string()));
            }
            // La grande de un video puede no existir (404): entonces la 4:3, que siempre está.
            let mut urls = vec![art.to_owned()];
            if art.contains("i.ytimg.com/vi/") {
                urls.push(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
            }
            let mut last = anyhow::anyhow!("sin carátula");
            for u in urls {
                match proxy::http().get(&u).header("User-Agent", innertube::UA).timeout(Duration::from_secs(15)).send().await.and_then(|r| r.error_for_status()) {
                    Ok(r) => {
                        let ct = r.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_owned();
                        return Ok((r.bytes().await?.to_vec(), ct));
                    }
                    Err(e) => last = e.into(),
                }
            }
            Err(last)
        }
        .await;
        match got {
            Ok((mut b, ct)) => {
                mix_all(id, &mut b);
                tokio::fs::write(d.file(id, "c"), b).await?;
                cover_mime = Some(ct);
            }
            Err(e) => log::warn!("carátula de {id}: {e:#}"),
        }
    }
    progress(app, id, 0.98);

    // 3. La letra (si no hay, la descarga igual vale).
    let artist = t.artists.iter().filter_map(|a| a["name"].as_str()).collect::<Vec<_>>().join(", ");
    let album = t.album.as_ref().and_then(|a| a["name"].as_str()).unwrap_or_default().to_owned();
    let q = LyricsQ { id: String::new(), title: t.title.clone(), artist, album, duration: t.duration };
    let lyrics = api::lyrics_lookup(app, &q).await.ok();

    tokio::fs::rename(&part, d.file(id, "a")).await?;
    d.index.lock().unwrap().insert(id.to_owned(), Entry { track: raw, size, mime: mime.to_owned(), cover_mime, lyrics, at: now(), loudness: loud });
    d.save_index();
    log::info!("descargada {id} ({} KB)", size / 1024);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixing_twice_restores() {
        let orig: Vec<u8> = (0..200_000u32).map(|i| (i * 7) as u8).collect();
        let mut a = orig.clone();
        mix("abc", 0, &mut a);
        assert_ne!(a[..1000], orig[..1000]);
        assert_eq!(a[HEAD as usize..], orig[HEAD as usize..]);
        // Desmezclar de a pedazos, como en un pedido con rango.
        let (x, y) = a.split_at_mut(30_000);
        mix("abc", 0, x);
        mix("abc", 30_000, y);
        assert_eq!(a, orig);
    }
}
