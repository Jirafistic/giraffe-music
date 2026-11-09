//! Reemplazo de `src/vault.rs`: en un servidor no hay llavero del sistema, así que el
//! inicio de sesión se guarda en un archivo que solo puede leer este usuario.

use std::path::{Path, PathBuf};

fn path(name: &str, dir: &Path) -> PathBuf {
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    dir.join(format!("{safe}.secret"))
}

pub fn get(name: &str, data_dir: &Path) -> Option<Vec<u8>> {
    std::fs::read(path(name, data_dir)).ok()
}

pub fn set(name: &str, data_dir: &Path, secret: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path(name, data_dir))?.write_all(secret)?;
    Ok(())
}

pub fn delete(name: &str, data_dir: &Path) {
    let _ = std::fs::remove_file(path(name, data_dir));
}
