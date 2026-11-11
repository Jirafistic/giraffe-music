//! Escuchar juntos, en la misma red Wi-Fi y sin servidores de afuera.
//!
//! Quien crea la sesión (el anfitrión) abre un puerto en su Wi-Fi que solo responde a
//! quien tenga el código. Los demás teléfonos se conectan a él y siguen lo que suena:
//! misma canción, mismo segundo. Cualquiera puede pausar, adelantar o poner otra canción;
//! el pedido va al anfitrión y de ahí a todos.
//!
//! Batería: no hay relojes. Cada teléfono deja una sola consulta "en espera" (long-poll)
//! que el anfitrión contesta solo cuando algo cambia (o cada 25 s, para saber quién sigue).
//!
//! El código (8 letras) lleva adentro los dos últimos números de la IP del anfitrión, así
//! se puede escribir a mano sin escanear: el invitado completa la IP con la suya.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::App;

/// Puertos del anfitrión en el Wi-Fi (el primero libre).
const LAN_PORTS: [u16; 4] = [47812, 47813, 47814, 47815];
/// Hasta cuántas personas (con el anfitrión).
pub const MAX: usize = 4;
const ALPHA: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/// Un invitado que no consulta en este tiempo se fue (las consultas duran 25 s).
const GONE: Duration = Duration::from_secs(45);

#[derive(Clone, Default)]
struct Shared {
    /// La canción y la cola que suenan, como las manda la interfaz del anfitrión.
    state: Value,
    playing: bool,
    pos: f64,
    at: Option<Instant>,
}

impl Shared {
    /// Lo que suena ahora, con la posición calculada a este instante.
    fn now(&self) -> Value {
        let mut pos = self.pos;
        if self.playing {
            if let Some(at) = self.at {
                pos += at.elapsed().as_secs_f64();
            }
        }
        let mut v = self.state.clone();
        if v.is_object() {
            v["pos"] = json!(pos);
            v["playing"] = json!(self.playing);
        }
        v
    }
}

enum Mode {
    Off,
    Host {
        code: String,
        addr: SocketAddr,
        shared: Shared,
        members: HashMap<String, Member>,
        cmds: Vec<Value>,
        bad_codes: u32,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
    },
    Guest {
        code: String,
        host: SocketAddr,
        member: String,
        shared: Shared,
        count: usize,
        /// Si el anfitrión le dio permiso para cambiar la música.
        control: bool,
        ended: bool,
        stop: Arc<std::sync::atomic::AtomicBool>,
    },
}

struct Member {
    name: String,
    seen: Instant,
    /// "Anfitrión" (puede cambiar la música) o "Invitado" (solo escucha, lo predeterminado).
    control: bool,
}

pub struct Together {
    mode: Mutex<Mode>,
    /// Sube con cada cambio; las consultas en espera se despiertan con él.
    version: watch::Sender<u64>,
}

impl Default for Together {
    fn default() -> Self {
        Self { mode: Mutex::new(Mode::Off), version: watch::channel(0).0 }
    }
}

impl Together {
    fn bump(&self) {
        self.version.send_modify(|v| *v += 1);
    }

    fn count(members: &mut HashMap<String, Member>) -> usize {
        members.retain(|_, m| m.seen.elapsed() < GONE);
        1 + members.len()
    }

    /// Lo que ve la interfaz de este teléfono.
    fn snapshot(&self) -> Value {
        let v = *self.version.borrow();
        let mut m = self.mode.lock().unwrap();
        match &mut *m {
            Mode::Off => json!({"mode": "off", "v": v}),
            Mode::Host { code, addr, members, cmds, .. } => {
                let count = Self::count(members);
                let mut list: Vec<Value> = members.iter().map(|(id, m)| json!({"id": id, "name": m.name, "control": m.control, "since": m.seen.elapsed().as_secs()})).collect();
                list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                json!({"mode": "host", "v": v, "code": pretty(code), "addr": addr.to_string(), "count": count, "max": MAX, "members": list, "cmds": std::mem::take(cmds)})
            }
            Mode::Guest { code, shared, count, control, ended, .. } => {
                json!({"mode": "guest", "v": v, "code": pretty(code), "count": count, "max": MAX, "control": control, "ended": ended, "state": shared.now()})
            }
        }
    }
}

fn pretty(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

/// La IP de este teléfono en el Wi-Fi (sin mandar nada: solo se pregunta qué interfaz usaría).
fn local_ip() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("10.255.255.255:9").or_else(|_| s.connect("8.8.8.8:53")).ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn random_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish() as u32
}

/// 8 letras: 4 con la IP y el puerto (20 bits), 4 secretas (20 bits).
fn make_code(ip: Ipv4Addr, port_i: usize) -> String {
    let o = ip.octets();
    let r = random_u32();
    let head = ((o[2] as u32) << 12) | ((o[3] as u32) << 4) | ((port_i as u32 & 3) << 2) | (r & 3);
    let secret = (r >> 2) & 0xFFFFF;
    let enc = |x: u32| (0..4).rev().map(|k| ALPHA[((x >> (k * 5)) & 31) as usize] as char).collect::<String>();
    enc(head) + &enc(secret)
}

/// Limpia lo que escribió el usuario: mayúsculas, sin guiones ni espacios; 0→O, 1→I no existen.
fn clean_code(s: &str) -> Option<String> {
    let c: String = s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    (c.len() == 8 && c.bytes().all(|b| ALPHA.contains(&b))).then_some(c)
}

/// La dirección del anfitrión a partir del código y la IP propia.
fn host_from_code(code: &str, mine: Ipv4Addr) -> SocketAddr {
    let val = |s: &str| s.bytes().fold(0u32, |a, b| (a << 5) | ALPHA.iter().position(|&x| x == b).unwrap_or(0) as u32);
    let head = val(&code[..4]);
    let o = mine.octets();
    let ip = Ipv4Addr::new(o[0], o[1], (head >> 12) as u8, (head >> 4) as u8);
    SocketAddr::new(IpAddr::V4(ip), LAN_PORTS[((head >> 2) & 3) as usize])
}

fn lan_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(4)).build().unwrap_or_default()
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({"error": msg}))).into_response()
}

// ------------------------------------------------------------------ rutas de este teléfono

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/together", get(events))
        .route("/api/together/host", post(host))
        .route("/api/together/join", post(join))
        .route("/api/together/leave", post(leave))
        .route("/api/together/state", post(publish))
        .route("/api/together/cmd", post(command))
        .route("/api/together/role", post(role))
        .route("/api/together/qr.svg", get(qr))
}

#[derive(Deserialize)]
struct Since {
    #[serde(default)]
    since: u64,
}

/// La interfaz pregunta "¿algo nuevo desde la versión X?" y espera hasta 25 s.
async fn events(State(app): State<Arc<App>>, Query(q): Query<Since>) -> Response {
    let t = &app.together;
    let mut rx = t.version.subscribe();
    if *rx.borrow() <= q.since {
        let _ = tokio::time::timeout(Duration::from_secs(25), rx.wait_for(|v| *v > q.since)).await;
    }
    let mut r = Json(t.snapshot()).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    r
}

/// Crear una sesión: abre el puerto en el Wi-Fi y arma el código.
async fn host(State(app): State<Arc<App>>) -> Response {
    stop_current(&app).await;
    let Some(ip) = local_ip() else { return err(StatusCode::SERVICE_UNAVAILABLE, "no-wifi") };
    let mut bound = None;
    for (i, port) in LAN_PORTS.iter().enumerate() {
        if let Ok(l) = tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), *port)).await {
            bound = Some((i, l));
            break;
        }
    }
    let Some((port_i, listener)) = bound else { return err(StatusCode::SERVICE_UNAVAILABLE, "no-port") };
    let code = make_code(ip, port_i);
    let addr = SocketAddr::new(IpAddr::V4(ip), LAN_PORTS[port_i]);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    *app.together.mode.lock().unwrap() = Mode::Host { code: code.clone(), addr, shared: Shared::default(), members: HashMap::new(), cmds: vec![], bad_codes: 0, stop: Some(stop_tx) };
    let lan = lan_routes().with_state(app.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, lan).with_graceful_shutdown(async { let _ = stop_rx.await; }).await;
    });
    // Quién sigue conectado: se revisa cada 15 s mientras dure la sesión.
    let a = app.clone();
    tokio::spawn(async move {
        let mut last = 1;
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let n = match &mut *a.together.mode.lock().unwrap() {
                Mode::Host { members, .. } => Together::count(members),
                _ => break,
            };
            if n != last {
                last = n;
                a.together.bump();
            }
        }
    });
    log::info!("escuchar juntos: anfitrión en {addr}");
    app.together.bump();
    Json(app.together.snapshot()).into_response()
}

#[derive(Deserialize)]
struct JoinQ {
    code: String,
    #[serde(default)]
    name: String,
    /// Del QR: la dirección exacta del anfitrión (con el código escrito a mano se deduce).
    host: Option<String>,
}

/// Unirse a una sesión con el código (o lo que trae el QR).
async fn join(State(app): State<Arc<App>>, Json(q): Json<JoinQ>) -> Response {
    let Some(code) = clean_code(&q.code) else { return err(StatusCode::BAD_REQUEST, "bad-code") };
    let host = match q.host.as_deref().and_then(|h| h.parse::<SocketAddr>().ok()) {
        Some(h) => h,
        None => match local_ip() {
            Some(mine) => host_from_code(&code, mine),
            None => return err(StatusCode::SERVICE_UNAVAILABLE, "no-wifi"),
        },
    };
    let r = lan_client().post(format!("http://{host}/t/join")).json(&json!({"code": code, "name": q.name})).timeout(Duration::from_secs(6)).send().await;
    let v: Value = match r {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        Ok(r) if r.status() == StatusCode::CONFLICT => return err(StatusCode::CONFLICT, "full"),
        Ok(_) => return err(StatusCode::FORBIDDEN, "bad-code"),
        Err(_) => return err(StatusCode::BAD_GATEWAY, "unreachable"),
    };
    let member = v["member"].as_str().unwrap_or_default().to_owned();
    stop_current(&app).await;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *app.together.mode.lock().unwrap() = Mode::Guest {
        code: code.clone(),
        host,
        member: member.clone(),
        shared: shared_from(&v),
        count: v["count"].as_u64().unwrap_or(2) as usize,
        control: v["control"].as_bool().unwrap_or(false),
        ended: false,
        stop: stop.clone(),
    };
    app.together.bump();
    tokio::spawn(follow(app.clone(), host, code, member, v["v"].as_u64().unwrap_or(0), stop));
    Json(app.together.snapshot()).into_response()
}

fn shared_from(v: &Value) -> Shared {
    let st = &v["state"];
    Shared { state: st.clone(), playing: st["playing"].as_bool().unwrap_or(false), pos: st["pos"].as_f64().unwrap_or(0.0), at: Some(Instant::now()) }
}

/// El invitado sigue al anfitrión: una consulta en espera por vez.
async fn follow(app: Arc<App>, host: SocketAddr, code: String, member: String, mut since: u64, stop: Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering::Relaxed;
    let http = lan_client();
    let mut failing_since: Option<Instant> = None;
    while !stop.load(Relaxed) {
        let r = http.get(format!("http://{host}/t/state")).query(&[("code", code.as_str()), ("member", member.as_str()), ("since", &since.to_string())]).timeout(Duration::from_secs(35)).send().await;
        if stop.load(Relaxed) {
            break;
        }
        match r {
            Ok(r) if r.status().is_success() => {
                failing_since = None;
                let v: Value = r.json().await.unwrap_or_default();
                if v["ended"].as_bool() == Some(true) {
                    break;
                }
                since = v["v"].as_u64().unwrap_or(since);
                if let Mode::Guest { shared, count, control, .. } = &mut *app.together.mode.lock().unwrap() {
                    *shared = shared_from(&v);
                    *count = v["count"].as_u64().unwrap_or(2) as usize;
                    *control = v["control"].as_bool().unwrap_or(false);
                }
                app.together.bump();
            }
            // El anfitrión terminó la sesión (o ya no nos reconoce).
            Ok(r) if r.status() == StatusCode::GONE || r.status() == StatusCode::FORBIDDEN => break,
            _ => {
                // Sin respuesta: se reintenta un rato (el Wi-Fi puede cortarse un momento).
                let t0 = *failing_since.get_or_insert_with(Instant::now);
                if t0.elapsed() > Duration::from_secs(25) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    if !stop.load(Relaxed) {
        if let Mode::Guest { ended, .. } = &mut *app.together.mode.lock().unwrap() {
            *ended = true;
        }
        app.together.bump();
    }
}

/// Salir (invitado) o terminar la sesión (anfitrión).
async fn leave(State(app): State<Arc<App>>) -> Response {
    stop_current(&app).await;
    app.together.bump();
    Json(app.together.snapshot()).into_response()
}

async fn stop_current(app: &Arc<App>) {
    let old = std::mem::replace(&mut *app.together.mode.lock().unwrap(), Mode::Off);
    match old {
        Mode::Host { stop, .. } => {
            if let Some(s) = stop {
                let _ = s.send(());
            }
        }
        Mode::Guest { host, code, member, stop, ended, .. } => {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if !ended {
                let _ = lan_client().post(format!("http://{host}/t/leave")).json(&json!({"code": code, "member": member})).timeout(Duration::from_secs(3)).send().await;
            }
        }
        Mode::Off => {}
    }
}

/// El anfitrión cuenta qué suena (lo manda su interfaz cuando cambia algo).
async fn publish(State(app): State<Arc<App>>, Json(v): Json<Value>) -> Response {
    let changed = match &mut *app.together.mode.lock().unwrap() {
        Mode::Host { shared, .. } => {
            shared.playing = v["playing"].as_bool().unwrap_or(false);
            shared.pos = v["pos"].as_f64().unwrap_or(0.0);
            shared.at = Some(Instant::now());
            shared.state = v;
            true
        }
        _ => false,
    };
    if changed {
        app.together.bump();
    }
    Json(json!({"ok": changed})).into_response()
}

/// Un invitado tocó un control: el pedido va al anfitrión.
async fn command(State(app): State<Arc<App>>, Json(cmd): Json<Value>) -> Response {
    let target = match &*app.together.mode.lock().unwrap() {
        Mode::Guest { host, code, member, ended: false, .. } => Some((*host, code.clone(), member.clone())),
        _ => None,
    };
    let Some((host, code, member)) = target else { return err(StatusCode::CONFLICT, "not-guest") };
    let ok = lan_client()
        .post(format!("http://{host}/t/cmd"))
        .json(&json!({"code": code, "member": member, "cmd": cmd}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());
    Json(json!({"ok": ok})).into_response()
}

#[derive(Deserialize)]
struct RoleQ {
    member: String,
    control: bool,
}

/// El anfitrión cambia el permiso de alguien (Anfitrión = puede cambiar la música; Invitado = solo escucha).
async fn role(State(app): State<Arc<App>>, Json(q): Json<RoleQ>) -> Response {
    if let Mode::Host { members, .. } = &mut *app.together.mode.lock().unwrap() {
        if let Some(m) = members.get_mut(&q.member) {
            m.control = q.control;
        }
    }
    app.together.bump();
    Json(app.together.snapshot()).into_response()
}

/// El QR de la sesión (lo dibuja el núcleo: un SVG chico, sin librerías en la página).
async fn qr(State(app): State<Arc<App>>) -> Response {
    let text = match &*app.together.mode.lock().unwrap() {
        Mode::Host { code, addr, .. } => format!("GIRAFFE:{code}@{addr}"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let Ok(q) = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M) else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let svg = q.render::<qrcode::render::svg::Color>().min_dimensions(240, 240).quiet_zone(true).dark_color(qrcode::render::svg::Color("#000")).light_color(qrcode::render::svg::Color("#fff")).build();
    ([(header::CONTENT_TYPE, "image/svg+xml"), (header::CACHE_CONTROL, "no-store")], svg).into_response()
}

// ------------------------------------------------------------------ lo que se abre en el Wi-Fi

#[derive(Deserialize)]
struct Who {
    code: String,
    #[serde(default)]
    member: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    since: u64,
}

fn lan_routes() -> Router<Arc<App>> {
    Router::new().route("/t/join", post(lan_join)).route("/t/state", get(lan_state)).route("/t/cmd", post(lan_cmd)).route("/t/leave", post(lan_leave))
}

/// Revisa el código; demasiados intentos con códigos malos cierran la sesión.
fn check(app: &App, code: &str) -> Result<(), Response> {
    let mut m = app.together.mode.lock().unwrap();
    match &mut *m {
        Mode::Host { code: c, bad_codes, .. } => {
            if clean_code(code).as_deref() == Some(c.as_str()) {
                Ok(())
            } else {
                *bad_codes += 1;
                if *bad_codes > 40 {
                    drop(m);
                    log::warn!("escuchar juntos: demasiados códigos incorrectos, se cierra la sesión");
                }
                Err(err(StatusCode::FORBIDDEN, "bad-code"))
            }
        }
        _ => Err(err(StatusCode::GONE, "ended")),
    }
}

async fn lan_join(State(app): State<Arc<App>>, Json(w): Json<Who>) -> Response {
    if let Err(r) = check(&app, &w.code) {
        return r;
    }
    let member = format!("{:08x}", random_u32());
    {
        let mut m = app.together.mode.lock().unwrap();
        let Mode::Host { members, .. } = &mut *m else { return err(StatusCode::GONE, "ended") };
        let n = Together::count(members);
        if n >= MAX {
            return err(StatusCode::CONFLICT, "full");
        }
        let name: String = w.name.trim().chars().take(30).collect();
        let name = if name.is_empty() { format!("#{}", n + 1) } else { name };
        members.insert(member.clone(), Member { name, seen: Instant::now(), control: false });
    }
    app.together.bump();
    Json(lan_view(&app, Some(&member))).into_response()
}

fn lan_view(app: &App, member: Option<&str>) -> Value {
    let v = *app.together.version.borrow();
    let mut m = app.together.mode.lock().unwrap();
    match &mut *m {
        Mode::Host { shared, members, .. } => {
            let mut control = false;
            if let Some(id) = member {
                if let Some(m) = members.get_mut(id) {
                    m.seen = Instant::now();
                    control = m.control;
                }
            }
            json!({"v": v, "member": member, "count": Together::count(members), "control": control, "state": shared.now()})
        }
        _ => json!({"ended": true}),
    }
}

async fn lan_state(State(app): State<Arc<App>>, Query(w): Query<Who>) -> Response {
    if let Err(r) = check(&app, &w.code) {
        return r;
    }
    let known = matches!(&*app.together.mode.lock().unwrap(), Mode::Host { members, .. } if members.contains_key(&w.member));
    if !known {
        return err(StatusCode::FORBIDDEN, "unknown");
    }
    let mut rx = app.together.version.subscribe();
    if *rx.borrow() <= w.since {
        let _ = tokio::time::timeout(Duration::from_secs(25), rx.wait_for(|v| *v > w.since)).await;
    }
    Json(lan_view(&app, Some(&w.member))).into_response()
}

#[derive(Deserialize)]
struct Cmd {
    code: String,
    member: String,
    cmd: Value,
}

async fn lan_cmd(State(app): State<Arc<App>>, Json(c): Json<Cmd>) -> Response {
    if let Err(r) = check(&app, &c.code) {
        return r;
    }
    if let Mode::Host { cmds, members, .. } = &mut *app.together.mode.lock().unwrap() {
        match members.get(&c.member) {
            None => return err(StatusCode::FORBIDDEN, "unknown"),
            // Invitado: solo escucha.
            Some(m) if !m.control => return err(StatusCode::FORBIDDEN, "no-permission"),
            _ => {}
        }
        if cmds.len() < 20 {
            cmds.push(c.cmd);
        }
    }
    app.together.bump();
    Json(json!({"ok": true})).into_response()
}

async fn lan_leave(State(app): State<Arc<App>>, Json(w): Json<Who>) -> Response {
    if check(&app, &w.code).is_ok() {
        if let Mode::Host { members, .. } = &mut *app.together.mode.lock().unwrap() {
            members.remove(&w.member);
        }
        app.together.bump();
    }
    Json(json!({"ok": true})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_round_trip() {
        let ip = Ipv4Addr::new(192, 168, 1, 37);
        for i in 0..4 {
            let c = make_code(ip, i);
            assert_eq!(c.len(), 8);
            let back = host_from_code(&c, Ipv4Addr::new(192, 168, 1, 99));
            assert_eq!(back, SocketAddr::new(IpAddr::V4(ip), LAN_PORTS[i]));
            assert_eq!(clean_code(&format!(" {}-{} ", &c[..4].to_lowercase(), &c[4..])).as_deref(), Some(c.as_str()));
        }
        assert!(clean_code("ABC").is_none());
        assert!(clean_code("ABCD-EF01").is_none()); // 0 y 1 no están en el alfabeto
    }
}
