//! Giraffe Music — el núcleo nativo.
//!
//! Reutiliza el núcleo de ytm-rs tal cual (los mismos archivos de `../src`, sin
//! copiarlos): las consultas a YouTube Music (`ytm.rs`, `ytmapi.rs`), la resolución de
//! audio (`innertube.rs`), SponsorBlock y el modelo de datos (`model.rs`). Encima
//! expone una API local chica en 127.0.0.1 que usan la interfaz (WebView) y el
//! reproductor nativo (ExoPlayer) del APK, y guarda las descargas.
//!
//! En el APK esto es `libgiraffe.so`, que arranca `MainActivity` por JNI (`android.rs`).
//! En una PC, `src/main.rs` lo corre como programa para probar desde el navegador.

#![allow(dead_code)]

// --- El núcleo de ytm-rs, compartido con la app de escritorio ---
#[path = "../../src/innertube.rs"]
mod innertube;
#[path = "../../src/model.rs"]
mod model;
#[path = "../../src/sponsorblock.rs"]
mod sponsorblock;
#[path = "../../src/transfer/spotify.rs"]
mod spotify;
#[path = "../../src/webmusic.rs"]
mod webmusic;
#[path = "../../src/ytm.rs"]
mod ytm;
#[path = "../../src/ytmapi.rs"]
mod ytmapi;

// --- Reemplazos chicos de las partes de escritorio que esos archivos nombran ---
#[path = "shim/backend.rs"]
mod backend;
#[path = "shim/jsc.rs"]
mod jsc;
#[path = "shim/proxy.rs"]
mod proxy;
#[path = "shim/vault.rs"]
mod vault;

mod account;
mod transfer;
mod api;
mod demo;
mod downloads;
mod together;
mod web;

#[cfg(target_os = "android")]
mod android;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub struct App {
    pub api: ytmapi::Api,
    pub demo: bool,
    /// Servir `web/` desde el disco (para desarrollar sin recompilar).
    pub web_dir: Option<PathBuf>,
    pub streams: api::StreamCache,
    pub downloads: downloads::Downloads,
    pub together: together::Together,
    /// Modo demo: si se "inició sesión" con la cuenta de ejemplo.
    pub demo_auth: std::sync::atomic::AtomicBool,
    pub data_dir: PathBuf,
    /// La importación de Spotify en curso (o la última).
    pub transfer: std::sync::Mutex<transfer::State>,
}

impl App {
    /// Si hay una cuenta iniciada (cookie), las consultas van como ella.
    pub fn auth(&self) -> bool {
        self.api.account().is_some()
    }

    /// Con sesión, real o de demo.
    pub fn signed_in(&self) -> bool {
        self.auth() || self.demo_auth.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub struct Options {
    pub data_dir: PathBuf,
    pub demo: bool,
    pub web_dir: Option<PathBuf>,
    pub cookie: Option<String>,
}

/// Arma la app y su router. `data_dir` guarda la sesión, el caché de YouTube Music y
/// las descargas (en Android, la carpeta privada de la app).
pub async fn build(o: Options) -> anyhow::Result<axum::Router> {
    std::fs::create_dir_all(&o.data_dir)?;
    let api = ytmapi::Api::new(&o.data_dir);
    if let Some(cookie) = o.cookie {
        match api.session_from_cookie(cookie.trim()).await {
            Ok(s) => {
                api.sign_in(s);
                log::info!("sesión iniciada con la cookie");
            }
            Err(e) => log::warn!("no se pudo iniciar sesión con esa cookie: {e:#}"),
        }
    }
    let downloads = downloads::Downloads::open(o.data_dir.join("downloads"))?;
    let app = Arc::new(App { api, demo: o.demo, web_dir: o.web_dir, streams: Default::default(), downloads, together: Default::default(), demo_auth: Default::default(), data_dir: o.data_dir.clone(), transfer: Default::default() });
    if !o.demo {
        // Que la primera pantalla no espere el visitorData.
        let a = app.clone();
        tokio::spawn(async move { a.api.ensure_visitor().await });
    }
    // Las descargas que quedaron a la mitad la última vez siguen solas.
    downloads::resume(app.clone());
    Ok(api::routes().merge(account::routes()).merge(transfer::routes()).merge(downloads::routes()).merge(together::routes()).merge(web::routes()).with_state(app))
}

/// Puerto fijo del servidor local del APK: el mismo en cada arranque, así el WebView
/// conserva su origen (y con él los "me gusta", el historial y los ajustes).
pub const ANDROID_PORT: u16 = 47811;

/// Arranca el servidor en un hilo propio y devuelve el puerto en cuanto escucha.
/// Prueba algunos puertos seguidos por si el fijo estuviera ocupado.
pub fn start_background(o: Options, first_port: u16) -> anyhow::Result<u16> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new().name("giraffe-server".into()).spawn(move || {
        // Dos hilos alcanzan: casi todo el tiempo está esperando la red.
        let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
            Ok(rt) => rt,
            Err(e) => return tx.send(Err(anyhow::anyhow!(e))).unwrap_or(()),
        };
        rt.block_on(async move {
            let router = match build(o).await {
                Ok(r) => r,
                Err(e) => return tx.send(Err(e)).unwrap_or(()),
            };
            let mut listener = None;
            for port in first_port..first_port + 20 {
                if let Ok(l) = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                    listener = Some((l, port));
                    break;
                }
            }
            let Some((listener, port)) = listener else {
                return tx.send(Err(anyhow::anyhow!("no hay puerto libre"))).unwrap_or(());
            };
            let _ = tx.send(Ok(port));
            if let Err(e) = axum::serve(listener, router).await {
                log::error!("servidor: {e:#}");
            }
        });
    })?;
    rx.recv()?
}
