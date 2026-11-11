//! Entrada desde Kotlin: `com.giraffe.music.Native.start(filesDir)` (Giraffe Music) y
//! `com.giraffe.carmusic.Core.start(filesDir)` (Giraffe CarMusic, cuando funciona sola).

use jni::JNIEnv;
use jni::objects::{JObject, JString};
use jni::sys::jint;

use crate::{ANDROID_PORT, Options, start_background};

/// Arranca el servidor local (una sola vez por proceso) y devuelve su puerto, o -1.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_giraffe_music_Native_start(env: JNIEnv, _this: JObject, data_dir: JString) -> jint {
    start(env, data_dir, ANDROID_PORT)
}

/// CarMusic arranca en otros puertos: así nunca le quita el suyo a Giraffe Music (que
/// necesita siempre el mismo para no perder los datos del WebView).
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_giraffe_carmusic_Core_start(env: JNIEnv, _this: JObject, data_dir: JString) -> jint {
    start(env, data_dir, ANDROID_PORT + 40)
}

fn start(mut env: JNIEnv, data_dir: JString, first_port: u16) -> jint {
    static PORT: std::sync::OnceLock<jint> = std::sync::OnceLock::new();
    let dir: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    *PORT.get_or_init(|| {
        android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("giraffe"));
        // Que un pánico en una petición no tumbe la app, solo esa petición.
        std::panic::set_hook(Box::new(|p| log::error!("panic: {p}")));
        let o = Options { data_dir: dir.into(), demo: false, web_dir: None, cookie: None };
        match start_background(o, first_port) {
            Ok(port) => port as jint,
            Err(e) => {
                log::error!("no arrancó el servidor: {e:#}");
                -1
            }
        }
    })
}
