//! Búsqueda en YouTube común (no YouTube Music): para lo que YouTube Music no tiene
//! (covers, remixes, versiones en vivo, temas subidos por la gente). Los resultados son
//! videos, pero se tratan como canciones: se reproducen solo como audio (el mismo camino
//! que cualquier canción), se descargan y se agregan a playlists igual.
//!
//! Es una sola llamada al cliente web de YouTube, sin sesión (no ensucia el historial).

use serde_json::{Value, json};

use crate::model::{Link, Thumb, Track};

const WEB_VERSION: &str = "2.20261101.00.00";
/// Solo videos (sin canales, playlists, Shorts ni transmisiones).
const ONLY_VIDEOS: &str = "EgIQAQ%3D%3D";

pub async fn search(http: &reqwest::Client, query: &str, visitor_data: &str) -> anyhow::Result<Vec<Track>> {
    let body = json!({
        "context": {"client": {
            "clientName": "WEB",
            "clientVersion": WEB_VERSION,
            "hl": "es",
            "gl": "US",
            "visitorData": visitor_data,
        }},
        "query": query,
        "params": ONLY_VIDEOS,
    });
    let resp: Value = http
        .post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .header("User-Agent", crate::innertube::UA)
        .header("X-YouTube-Client-Name", "1")
        .header("X-YouTube-Client-Version", WEB_VERSION)
        .header("X-Goog-Visitor-Id", visitor_data)
        .header("Origin", "https://www.youtube.com")
        .timeout(std::time::Duration::from_secs(8))
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(parse(&resp))
}

fn parse(resp: &Value) -> Vec<Track> {
    let sections = &resp["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"];
    let mut out = vec![];
    for s in sections.as_array().map(Vec::as_slice).unwrap_or_default() {
        for item in s["itemSectionRenderer"]["contents"].as_array().map(Vec::as_slice).unwrap_or_default() {
            if let Some(t) = video(&item["videoRenderer"]) {
                out.push(t);
            }
        }
    }
    out
}

fn text(v: &Value) -> String {
    v["simpleText"].as_str().map(str::to_owned).unwrap_or_else(|| {
        v["runs"].as_array().map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect()).unwrap_or_default()
    })
}

/// "1:02:03" / "3:45" → segundos.
fn secs(s: &str) -> Option<u32> {
    s.split(':').try_fold(0u32, |acc, p| p.trim().parse::<u32>().ok().map(|n| acc * 60 + n))
}

/// "1,2 M de vistas" / "1.234.567 views" → número (solo los dígitos, si es el número entero).
fn views(s: &str) -> Option<u64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | ' ' | '\u{a0}')).filter(char::is_ascii_digit).collect();
    let rest = s[s.find(|c: char| c.is_alphabetic()).unwrap_or(s.len())..].to_lowercase();
    if rest.starts_with("mil") || rest.starts_with('k') || rest.starts_with('m') || rest.starts_with('b') {
        return None; // abreviado: mejor no inventar
    }
    digits.parse().ok()
}

fn video(v: &Value) -> Option<Track> {
    let id = v["videoId"].as_str()?;
    // Sin duración: es una transmisión en vivo o un estreno (no se puede escuchar entero).
    let duration = secs(&text(&v["lengthText"]))?;
    let owner = &v["ownerText"]["runs"][0];
    let name = owner["text"].as_str().unwrap_or_default();
    let thumbs = v["thumbnail"]["thumbnails"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| Some(Thumb { url: t["url"].as_str()?.split('?').next()?.to_owned(), width: t["width"].as_u64()? as u32, height: t["height"].as_u64()? as u32 }))
                .collect()
        })
        .unwrap_or_default();
    let title = text(&v["title"]);
    if title.is_empty() {
        return None;
    }
    Some(Track {
        id: id.to_owned(),
        title,
        // Los canales "- Topic" son los de las discográficas: el nombre real va sin eso. Sin
        // enlace: un canal común no tiene página de artista en YouTube Music.
        artists: vec![Link { name: name.trim_end_matches(" - Topic").to_owned(), id: None }],
        album: None,
        duration: Some(duration),
        thumbs,
        track_nr: None,
        plays: views(&text(&v["viewCountText"])),
        music_video: false,
        explicit: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_search_page() {
        let page = json!({"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [
                {"videoRenderer": {"videoId": "abc123", "title": {"runs": [{"text": "Canción (Live)"}]},
                    "ownerText": {"runs": [{"text": "Banda - Topic", "navigationEndpoint": {"browseEndpoint": {"browseId": "UC1"}}}]},
                    "lengthText": {"simpleText": "4:05"}, "viewCountText": {"simpleText": "1.234.567 vistas"},
                    "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/abc123/hq720.jpg?sqp=x", "width": 720, "height": 404}]}}},
                {"videoRenderer": {"videoId": "live1", "title": {"runs": [{"text": "En vivo"}]}}},
                {"shelfRenderer": {}}
            ]}}
        ]}}}}});
        let t = parse(&page);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "abc123");
        assert_eq!(t[0].duration, Some(245));
        assert_eq!(t[0].artists[0].name, "Banda");
        assert_eq!(t[0].plays, Some(1234567));
        assert_eq!(t[0].thumbs[0].url, "https://i.ytimg.com/vi/abc123/hq720.jpg");
        assert_eq!(secs("1:02:03"), Some(3723));
        assert_eq!(views("1,2 M de vistas"), None);
    }
}
