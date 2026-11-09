//! Modo demo (`--demo`): datos de ejemplo inventados, carátulas generadas y audio
//! sintetizado, para mostrar la app sin internet ni cuenta (presentaciones, pruebas).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use bytes::Bytes;
use serde_json::{Value, json};

struct Song {
    title: &'static str,
    artist: usize,
    album: usize,
    secs: u32,
}

const ARTISTS: &[&str] = &[
    "Luna Vértice", "Los Jirafales", "Nébula Sur", "Cata Ríos", "Bruma", "Ola Norte", "Sofía Ámbar", "Kilómetro 0", "Delta Azul", "Malva",
];

/// (título, artista, año, single)
const ALBUMS: &[(&str, usize, u32, bool)] = &[
    ("Cuello Largo", 1, 2026, false),
    ("Medianoche en Pocitos", 0, 2025, false),
    ("Satélites", 2, 2026, false),
    ("Río de Plata", 3, 2024, false),
    ("Niebla", 4, 2026, true),
    ("Marea Alta", 5, 2025, false),
    ("Ámbar", 6, 2026, false),
    ("Ruta 1", 7, 2023, false),
    ("Profundo", 8, 2026, true),
    ("Flores de Invierno", 9, 2025, false),
];

const SONGS: &[Song] = &[
    Song { title: "Mirando Desde Arriba", artist: 1, album: 0, secs: 204 },
    Song { title: "Sabana Eléctrica", artist: 1, album: 0, secs: 187 },
    Song { title: "Manchas", artist: 1, album: 0, secs: 221 },
    Song { title: "Hojas de Acacia", artist: 1, album: 0, secs: 198 },
    Song { title: "Medianoche en Pocitos", artist: 0, album: 1, secs: 236 },
    Song { title: "Rambla", artist: 0, album: 1, secs: 192 },
    Song { title: "Luces del Puerto", artist: 0, album: 1, secs: 213 },
    Song { title: "Órbita", artist: 2, album: 2, secs: 245 },
    Song { title: "Señal Perdida", artist: 2, album: 2, secs: 201 },
    Song { title: "Gravedad Cero", artist: 2, album: 2, secs: 178 },
    Song { title: "Corriente", artist: 3, album: 3, secs: 229 },
    Song { title: "Orilla", artist: 3, album: 3, secs: 195 },
    Song { title: "Agua Dulce", artist: 3, album: 3, secs: 207 },
    Song { title: "Niebla", artist: 4, album: 4, secs: 183 },
    Song { title: "Marea Alta", artist: 5, album: 5, secs: 219 },
    Song { title: "Faro", artist: 5, album: 5, secs: 200 },
    Song { title: "Sal y Viento", artist: 5, album: 5, secs: 188 },
    Song { title: "Ámbar", artist: 6, album: 6, secs: 232 },
    Song { title: "Miel", artist: 6, album: 6, secs: 174 },
    Song { title: "Otoño Lento", artist: 6, album: 6, secs: 241 },
    Song { title: "Kilómetro Cero", artist: 7, album: 7, secs: 210 },
    Song { title: "Peaje", artist: 7, album: 7, secs: 166 },
    Song { title: "Profundo", artist: 8, album: 8, secs: 226 },
    Song { title: "Flores de Invierno", artist: 9, album: 9, secs: 199 },
    Song { title: "Escarcha", artist: 9, album: 9, secs: 215 },
    Song { title: "Jardín Gris", artist: 9, album: 9, secs: 203 },
];

const MIXES: &[(&str, &str)] = &[
    ("My Supermix", "Los Jirafales, Luna Vértice, Nébula Sur and more"),
    ("My Mix 1", "Cata Ríos, Ola Norte, Bruma and more"),
    ("My Mix 2", "Sofía Ámbar, Malva, Delta Azul and more"),
    ("Discover Mix", "Kilómetro 0, Bruma, Malva and more"),
    ("New Release Mix", "Delta Azul, Bruma, Ámbar and more"),
    ("Replay Mix", "Los Jirafales, Cata Ríos and more"),
];

const CHARTS: [&str; 4] = ["Top 100 Songs Uruguay", "Top 100 Songs Global", "Trending 20 Uruguay", "Top 100 Music Videos"];

const CHIPS: &[&str] = &["Energize", "Relax", "Feel good", "Workout", "Podcasts", "Party", "Focus", "Commute", "Romance", "Sad", "Sleep"];

fn cover(seed: &str) -> String {
    format!("/api/img?u=/demo/{seed}")
}

fn song_id(i: usize) -> String {
    format!("demo{i:02}")
}

fn song_index(id: &str) -> usize {
    id.strip_prefix("demo").and_then(|n| n.parse().ok()).unwrap_or(0) % SONGS.len()
}

fn track(i: usize) -> Value {
    let s = &SONGS[i % SONGS.len()];
    let c = cover(&format!("a{}", s.album));
    json!({
        "id": song_id(i % SONGS.len()),
        "title": s.title,
        "artists": [{"name": ARTISTS[s.artist], "id": format!("art{}", s.artist)}],
        "album": {"name": ALBUMS[s.album].0, "id": format!("alb{}", s.album)},
        "duration": s.secs,
        "thumb": c, "art": c,
        "explicit": i % 7 == 3,
        "wide": i % 5 == 4,
        "plays": 120_000 + (i as u64 * 7_919_137) % 40_000_000,
        "video": false,
    })
}

fn album_card(i: usize) -> Value {
    let (t, a, y, single) = ALBUMS[i % ALBUMS.len()];
    json!({"title": t, "subtitle": format!("{} • {}", if single { "Single" } else { "Album" }, ARTISTS[a]), "thumb": cover(&format!("a{i}")), "round": false, "kind": "album", "id": format!("alb{}", i % ALBUMS.len()), "year": y})
}

fn mix_card(i: usize) -> Value {
    let (t, sub) = MIXES[i % MIXES.len()];
    json!({"title": t, "subtitle": sub, "thumb": cover(&format!("m{i}")), "round": false, "kind": "playlist", "id": format!("pl{i}")})
}

fn artist_card(i: usize) -> Value {
    json!({"title": ARTISTS[i], "subtitle": format!("{}K subscribers", 12 + i * 37), "thumb": cover(&format!("r{i}")), "round": true, "kind": "artist", "id": format!("art{i}")})
}

fn song_card(i: usize) -> Value {
    let t = track(i);
    json!({"title": t["title"], "subtitle": format!("Song • {}", t["artists"][0]["name"].as_str().unwrap_or("")), "thumb": t["thumb"], "round": false, "kind": "song", "id": t["id"], "track": t})
}

/// Un orden distinto pero estable para cada estante o chip.
fn order(seed: usize, n: usize) -> Vec<usize> {
    let mut v: Vec<usize> = (0..SONGS.len()).collect();
    let mut x = seed as u64 * 2654435761 + 1;
    for i in (1..v.len()).rev() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        v.swap(i, (x % (i as u64 + 1)) as usize);
    }
    v.truncate(n);
    v
}

pub fn home(params: Option<&str>) -> Value {
    let sel: Option<usize> = params.and_then(|p| p.strip_prefix("chip")).and_then(|n| n.parse().ok());
    let seed = sel.map_or(1, |s| s + 11);
    let chips: Vec<Value> = CHIPS
        .iter()
        .enumerate()
        .map(|(i, c)| json!({"title": c, "params": if sel == Some(i) { Value::Null } else { json!(format!("chip{i}")) }, "selected": sel == Some(i)}))
        .collect();
    let mut shelves = vec![
        json!({"title": "Listen again", "strapline": "JIRAFA", "kind": "cards", "items": order(seed + 1, 10).into_iter().enumerate().map(|(k, i)| if k % 3 == 2 { album_card(SONGS[i].album) } else { song_card(i) }).collect::<Vec<_>>()}),
        json!({"title": "Quick picks", "strapline": "START RADIO FROM A SONG", "kind": "songs", "rows": 4, "items": order(seed + 2, 16).into_iter().map(track).collect::<Vec<_>>()}),
        json!({"title": "Mixed for you", "kind": "cards", "items": (0..MIXES.len()).map(mix_card).collect::<Vec<_>>()}),
        json!({"title": "New releases", "kind": "cards", "items": ([8usize, 4, 2, 6, 0, 9]).iter().map(|&i| album_card(i)).collect::<Vec<_>>()}),
        json!({"title": "Forgotten favorites", "kind": "songs", "rows": 4, "items": order(seed + 3, 12).into_iter().map(track).collect::<Vec<_>>()}),
        json!({"title": "Recommended artists", "kind": "cards", "items": (0..ARTISTS.len()).map(artist_card).collect::<Vec<_>>()}),
        json!({"title": "Albums for you", "kind": "cards", "items": order(seed + 4, 10).into_iter().map(|i| album_card(SONGS[i].album)).collect::<Vec<_>>()}),
    ];
    if sel.is_some() {
        shelves.remove(0);
    }
    json!({"chips": chips, "shelves": shelves, "continuation": null})
}

pub fn explore() -> Value {
    json!({
        "newReleases": ([8usize, 4, 2, 6, 0, 9, 5, 1]).iter().map(|&i| album_card(i)).collect::<Vec<_>>(),
        "topSongs": order(99, 20).into_iter().map(track).collect::<Vec<_>>(),
        "charts": (0..4).map(|i| json!({"title": CHARTS[i], "subtitle": "Chart • Giraffe Music", "thumb": cover(&format!("c{i}")), "round": false, "kind": "playlist", "id": format!("pl{}", 10 + i)})).collect::<Vec<_>>(),
    })
}

fn matches(hay: &str, q: &str) -> bool {
    hay.to_lowercase().contains(&q.to_lowercase())
}

pub fn search(q: &str, _filter: &str) -> Value {
    let q = q.trim();
    let mut songs: Vec<usize> = (0..SONGS.len()).filter(|&i| matches(SONGS[i].title, q) || matches(ARTISTS[SONGS[i].artist], q)).collect();
    if songs.is_empty() {
        songs = order(q.len() + 5, 8);
    }
    let artists: Vec<usize> = (0..ARTISTS.len()).filter(|&i| matches(ARTISTS[i], q)).collect();
    let albums: Vec<usize> = (0..ALBUMS.len()).filter(|&i| matches(ALBUMS[i].0, q) || matches(ARTISTS[ALBUMS[i].1], q)).collect();
    json!({
        "songs": songs.iter().take(12).map(|&i| track(i)).collect::<Vec<_>>(),
        "artists": artists.iter().map(|&i| artist_card(i)).collect::<Vec<_>>(),
        "albums": albums.iter().map(|&i| album_card(i)).collect::<Vec<_>>(),
        "playlists": (0..3).map(mix_card).collect::<Vec<_>>(),
        "videos": [],
    })
}

pub fn suggest(q: &str, signed_in: bool) -> Value {
    let mut out: Vec<Value> = Vec::new();
    if signed_in {
        for h in ["los jirafales", "nebula sur orbita", "cata rios"] {
            if h.starts_with(&q.to_lowercase()) {
                out.push(json!({"text": h, "history": true, "forget": format!("demo:{h}")}));
            }
        }
    }
    if !q.is_empty() {
        for s in SONGS.iter().map(|s| s.title).chain(ARTISTS.iter().copied()) {
            let l = s.to_lowercase();
            if l.starts_with(&q.to_lowercase()) && !out.iter().any(|o| o["text"] == l.as_str()) {
                out.push(json!({"text": l, "history": false}));
            }
        }
    }
    json!(out.into_iter().take(8).collect::<Vec<_>>())
}

pub fn collection(id: &str, is_album: bool) -> Value {
    let n: usize = id.trim_start_matches(|c: char| !c.is_ascii_digit()).parse().unwrap_or(0);
    let (title, subtitle, songs, thumb) = if is_album {
        let (t, a, y, single) = ALBUMS[n % ALBUMS.len()];
        let songs: Vec<usize> = (0..SONGS.len()).filter(|&i| SONGS[i].album == n % ALBUMS.len()).collect();
        (t.to_string(), format!("{} • {} • {y}", if single { "Single" } else { "Album" }, ARTISTS[a]), songs, cover(&format!("a{}", n % ALBUMS.len())))
    } else {
        let (t, _) = if n >= 10 { (CHARTS[(n - 10) % 4], "") } else { MIXES[n % MIXES.len()] };
        let seed = if n >= 10 { n - 10 } else { n };
        (t.to_string(), "Playlist • Giraffe Music • 2026".to_string(), order(n + 40, 20), cover(&format!("{}{seed}", if n >= 10 { "c" } else { "m" })))
    };
    let owned = !is_album && (n == 7 || n == 8);
    let tracks: Vec<Value> = songs.iter().enumerate().map(|(k, &i)| { let mut t = track(i); if owned { t["setId"] = json!(format!("set{k}")); } t }).collect();
    let duration: u64 = songs.iter().map(|&i| SONGS[i].secs as u64).sum();
    let paged = id == "pl1";
    json!({
        "continuation": if paged { json!("demo-1") } else { Value::Null },
        "limit": if paged { 60 } else { tracks.len() },
        "id": id, "isAlbum": is_album, "title": title, "subtitle": subtitle,
        "byline": format!("{} songs", tracks.len()),
        "artists": if is_album { json!([{"name": ARTISTS[ALBUMS[n % ALBUMS.len()].1], "id": format!("art{}", ALBUMS[n % ALBUMS.len()].1)}]) } else { json!([]) },
        "description": if is_album { Value::Null } else { json!("A mix made just for you, refreshed often.") },
        "owned": !is_album && (n == 7 || n == 8),
        "thumb": thumb, "tracks": tracks, "duration": duration,
    })
}

pub fn artist(id: &str) -> Value {
    let n: usize = id.trim_start_matches("art").parse().unwrap_or(0) % ARTISTS.len();
    let mut top: Vec<usize> = (0..SONGS.len()).filter(|&i| SONGS[i].artist == n).collect();
    top.extend(order(n + 70, 3));
    let albums: Vec<usize> = (0..ALBUMS.len()).filter(|&i| ALBUMS[i].1 == n).collect();
    json!({
        "id": id, "name": ARTISTS[n], "banner": cover(&format!("r{n}")),
        "subscribers": 12_000 + n as u64 * 37_000,
        "description": format!("{} es un proyecto musical de Montevideo, Uruguay.", ARTISTS[n]),
        "top": top.iter().take(5).map(|&i| track(i)).collect::<Vec<_>>(),
        "topPlaylist": format!("pl{n}"),
        "albums": albums.iter().map(|&i| album_card(i)).collect::<Vec<_>>(),
        "playlists": [mix_card(n)],
        "similar": (0..ARTISTS.len()).filter(|&i| i != n).take(6).map(artist_card).collect::<Vec<_>>(),
    })
}

pub fn radio(id: &str) -> Value {
    let i = song_index(id);
    let mut v = vec![i];
    v.extend(order(i + 200, 20).into_iter().filter(|&j| j != i));
    json!(v.into_iter().map(track).collect::<Vec<_>>())
}

pub fn lyrics(title: &str) -> Value {
    const LINES: &[&str] = &[
        "Desde arriba veo la ciudad", "Las luces cambian de lugar", "Y el viento sopla en la sabana", "Cuello largo, mirada lejana",
        "", "Cuando cae la noche en el sur", "Todo se vuelve más azul", "Camino lento, sin apuro", "Sé que mañana es seguro",
        "", "Y si me pierdo entre la niebla", "Sigo el sonido que me lleva", "Hasta la orilla del río", "Donde el silencio es mío",
        "", "Mirando desde arriba, oh", "Mirando desde arriba", "Nada me puede alcanzar", "Mirando desde arriba",
    ];
    let mut lrc = String::new();
    let mut t = 6.0_f64;
    for l in LINES {
        lrc += &format!("[{:02}:{:05.2}]{l}\n", (t / 60.0) as u32, t % 60.0);
        t += if l.is_empty() { 3.0 } else { 2.4 };
    }
    let _ = title;
    json!({"synced": lrc, "plain": LINES.join("\n")})
}

// ------------------------------------------------------------------ media

/// Una carátula abstracta (degradé y formas) a partir de una semilla.
pub fn cover_svg(seed: &str) -> String {
    let h = seed.bytes().fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619));
    let hue = h % 360;
    let hue2 = (hue + 40 + (h >> 9) % 120) % 360;
    let round = seed.contains('r');
    let shape = match (h >> 4) % 3 {
        0 => format!("<circle cx='{}' cy='{}' r='{}' fill='hsl({hue2},70%,62%)' opacity='.85'/>", 30 + (h >> 3) % 40, 30 + (h >> 7) % 40, 18 + (h >> 11) % 18),
        1 => format!("<rect x='18' y='{}' width='64' height='{}' rx='4' fill='hsl({hue2},65%,58%)' opacity='.8' transform='rotate({} 50 50)'/>", 30 + (h >> 5) % 20, 10 + (h >> 8) % 20, (h >> 12) % 90),
        _ => format!("<path d='M0 {} Q50 {} 100 {} V100 H0Z' fill='hsl({hue2},60%,55%)' opacity='.85'/>", 55 + (h >> 3) % 20, 20 + (h >> 7) % 40, 50 + (h >> 11) % 30),
    };
    let face = if round {
        // Artistas: una silueta simple.
        format!("<circle cx='50' cy='40' r='16' fill='hsl({hue},30%,88%)' opacity='.9'/><path d='M22 92c4-20 16-28 28-28s24 8 28 28z' fill='hsl({hue},30%,88%)' opacity='.9'/>")
    } else {
        String::new()
    };
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl({hue},55%,38%)'/><stop offset='1' stop-color='hsl({},50%,16%)'/></linearGradient></defs><rect width='100' height='100' fill='url(#g)'/>{shape}{face}</svg>",
        (hue + 200) % 360
    )
}

static AUDIO: LazyLock<Mutex<HashMap<String, Bytes>>> = LazyLock::new(Default::default);

/// 40 s de música sintetizada (arpegio sobre cuatro acordes), WAV mono 22 kHz.
pub fn audio(id: &str) -> Bytes {
    if let Some(b) = AUDIO.lock().unwrap().get(id) {
        return b.clone();
    }
    const RATE: u32 = 22_050;
    const SECS: u32 = 40;
    let i = song_index(id) as f32;
    let root = 196.0 * 2f32.powf(((i * 5.0) % 12.0) / 12.0);
    let prog = [[0, 4, 7, 12], [-3, 0, 4, 9], [-7, -3, 0, 5], [-5, -1, 2, 7]];
    let n = (RATE * SECS) as usize;
    let mut pcm = Vec::with_capacity(n * 2);
    let note_len = RATE as usize / 4;
    for s in 0..n {
        let t = s as f32 / RATE as f32;
        let bar = (s / (note_len * 8)) % 4;
        let step = (s / note_len) % 8;
        let semi = prog[bar][[0, 1, 2, 3, 2, 1, 2, 3][step]] as f32;
        let f = root * 2f32.powf(semi / 12.0);
        let k = (s % note_len) as f32 / RATE as f32;
        let env = (-k * 5.0).exp() * (k * 200.0).min(1.0);
        let bass_f = root / 2.0 * 2f32.powf(prog[bar][0] as f32 / 12.0);
        let mut v = 0.32 * env * ((2.0 * std::f32::consts::PI * f * t).sin() + 0.25 * (4.0 * std::f32::consts::PI * f * t).sin());
        v += 0.18 * (2.0 * std::f32::consts::PI * bass_f * t).sin();
        let fade = (t / 1.5).min(1.0) * ((SECS as f32 - t) / 2.0).clamp(0.0, 1.0);
        pcm.extend_from_slice(&(((v * fade).clamp(-1.0, 1.0) * 30000.0) as i16).to_le_bytes());
    }
    let mut wav = Vec::with_capacity(44 + pcm.len());
    let data = pcm.len() as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav.extend_from_slice(&pcm);
    let b = Bytes::from(wav);
    AUDIO.lock().unwrap().insert(id.to_owned(), b.clone());
    b
}

/// El videoclip de ejemplo (fuera del APK: el modo demo es para la PC).
pub fn video() -> Bytes {
    #[cfg(not(target_os = "android"))]
    {
        Bytes::from_static(include_bytes!("../demo/clip.mp4"))
    }
    #[cfg(target_os = "android")]
    {
        Bytes::new()
    }
}

pub fn account() -> Value {
    json!({"signedIn": true, "name": "Demo account", "photo": null, "handle": "@giraffedemo"})
}

/// La biblioteca de la cuenta de ejemplo.
pub fn library() -> Value {
    json!({
        "playlists": (0..4).map(mix_card).chain([json!({"title": "Para estudiar", "subtitle": "Playlist • Demo account • 24 songs", "thumb": cover("u0"), "round": false, "kind": "playlist", "id": "pl7"}), json!({"title": "Viaje al Chuy", "subtitle": "Playlist • Demo account • 18 songs", "thumb": cover("u1"), "round": false, "kind": "playlist", "id": "pl8"})]).collect::<Vec<_>>(),
        "albums": ([0usize, 3, 6, 9]).iter().map(|&i| album_card(i)).collect::<Vec<_>>(),
    })
}

pub fn liked() -> Value {
    let t: Vec<Value> = order(321, 14).into_iter().map(track).collect();
    json!({"tracks": t, "count": 14})
}

pub fn history() -> Value {
    json!(order(777, 20).into_iter().map(track).collect::<Vec<_>>())
}

/// Páginas siguientes de la playlist de ejemplo pl1 (20 canciones cada una).
pub fn playlist_more(token: &str) -> Value {
    let n: usize = token.strip_prefix("demo-").and_then(|n| n.parse().ok()).unwrap_or(9);
    let tracks: Vec<Value> = order(500 + n, 20).into_iter().map(track).collect();
    json!({"tracks": tracks, "continuation": if n < 2 { json!(format!("demo-{}", n + 1)) } else { Value::Null }})
}
