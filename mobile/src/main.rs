//! Giraffe Music en una PC: el mismo núcleo que va dentro del APK, para probar la
//! interfaz desde el navegador (con el modo de celular de las herramientas de desarrollo).

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut port: u16 = 8787;
    let mut host = "127.0.0.1".to_string();
    let mut demo = false;
    let mut web_dir = None;
    let mut cookie = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" | "-p" => port = args.next().and_then(|p| p.parse().ok()).unwrap_or(port),
            "--host" => host = args.next().unwrap_or(host),
            "--demo" => demo = true,
            "--web" => web_dir = args.next().map(PathBuf::from),
            "--cookie" => cookie = Some(std::fs::read_to_string(args.next().unwrap_or_default())?),
            "-h" | "--help" => {
                println!(
                    "giraffe-music [--port 8787] [--host 127.0.0.1] [--demo] [--cookie cookie.txt] [--web carpeta]\n\n\
                     --demo     datos de ejemplo, sin conectarse a YouTube (para presentar sin internet)\n\
                     --host     0.0.0.0 para abrirlo desde el celular en la misma red\n\
                     --cookie   archivo con la cookie de music.youtube.com para usar tu cuenta"
                );
                return Ok(());
            }
            other => anyhow::bail!("opción desconocida: {other} (probá --help)"),
        }
    }

    let data_dir = std::env::var_os("GIRAFFE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".giraffe-music")
    });
    let router = giraffe::build(giraffe::Options { data_dir, demo, web_dir, cookie }).await?;
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("\n  🦒 Giraffe Music{} en http://{addr}\n", if demo { " (demo)" } else { "" });
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
