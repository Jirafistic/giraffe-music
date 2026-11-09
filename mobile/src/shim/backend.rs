//! Los tipos de `src/backend.rs` que usa `ytm.rs`. El resto de ese archivo (audio con
//! rodio, ventanas, colas) es del escritorio; en el celular reproduce el navegador.

use crate::model::{self, Card, Thumb, Track};

pub const LIKE_GAP: std::time::Duration = std::time::Duration::from_millis(400);

#[derive(Clone, Debug, Default)]
pub struct Collection {
    pub id: String,
    pub is_album: bool,
    pub save_id: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub artists: Vec<model::Link>,
    pub description: Option<String>,
    pub thumbs: Vec<Thumb>,
    pub tracks: Vec<Track>,
    pub set_ids: Vec<Option<String>>,
    pub count: Option<u64>,
    pub owned: bool,
}

impl Collection {
    pub fn byline(&self) -> String {
        match self.count {
            Some(n) if self.subtitle.is_empty() => format!("{n} songs"),
            Some(n) => format!("{} • {n} songs", self.subtitle),
            None => self.subtitle.clone(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ArtistPage {
    pub id: String,
    pub name: String,
    pub banner: Vec<Thumb>,
    pub subscribers: Option<u64>,
    pub description: Option<String>,
    pub top: Vec<Track>,
    pub top_playlist: Option<String>,
    pub albums: Vec<Card>,
    pub playlists: Vec<Card>,
    pub similar: Vec<Card>,
}
