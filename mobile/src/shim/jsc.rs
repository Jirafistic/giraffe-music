//! Reemplazo de `src/jsc.rs`. El original corre el reproductor JS de YouTube en QuickJS
//! para descifrar las URLs de las cuentas Premium; en el celular se usa siempre el
//! cliente visionOS (`innertube.rs`), que da URLs sin cifrar, así que no hace falta y
//! la librería de Android queda más chica y sin código C.

use std::path::Path;

#[derive(Clone)]
pub struct Player {
    pub id: String,
    pub sts: u32,
}

pub struct Solver;

impl Solver {
    pub fn new(_data_dir: &Path) -> Self {
        Solver
    }

    pub async fn player(&self, _http: &reqwest::Client) -> anyhow::Result<Player> {
        anyhow::bail!("el descifrado de Premium no está incluido en Giraffe Music")
    }

    pub async fn solve(&self, _player: &Player, _n: Option<String>, _sig: Option<String>) -> anyhow::Result<(Option<String>, Option<String>)> {
        anyhow::bail!("el descifrado de Premium no está incluido en Giraffe Music")
    }
}
