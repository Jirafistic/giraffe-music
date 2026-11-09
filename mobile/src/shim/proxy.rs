//! Reemplazo de `src/proxy.rs` del escritorio: un solo cliente HTTP compartido.
//! (El de escritorio maneja proxys SOCKS/Tor; acá no hace falta y se respeta
//! HTTPS_PROXY del sistema, que reqwest ya lee solo.)

use std::sync::OnceLock;
use std::time::Duration;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

pub fn http() -> reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .gzip(true)
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .expect("cliente HTTP")
    })
    .clone()
}

pub struct Setting;

impl Setting {
    pub fn resolve(&self) -> Option<url::Url> {
        None
    }
}

pub fn active() -> &'static Setting {
    &Setting
}

pub fn can_switch_exit() -> bool {
    false
}

pub async fn new_circuit(_available: impl AsyncFn(&reqwest::Client) -> bool) -> bool {
    false
}

/// `spotify.rs` arma su propio cliente; acá no hay proxy que aplicarle.
pub fn apply(b: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    b.gzip(true).connect_timeout(Duration::from_secs(10))
}
