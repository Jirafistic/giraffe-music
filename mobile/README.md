<div align="center">
  <img src="web/icons/icon-192.png" width="96" alt="">
  <h1>Giraffe Music</h1>
  <p><strong>ytm-rs para Android: la interfaz de YouTube Music móvil, sin anuncios y cuidando la batería.</strong></p>
</div>

Giraffe Music es una app Android hecha sobre el núcleo de **ytm-rs**. Usa los mismos
archivos de `../src` (no son copias): las consultas a YouTube Music (`ytm.rs`,
`ytmapi.rs`), la resolución de audio (`innertube.rs`), SponsorBlock y el modelo de datos.
Los tests del repo original se ejecutan también dentro de Giraffe (`cargo test --lib`).

## Qué tiene

- **Interfaz como YouTube Music (diseño 2025):** Inicio con chips de ánimo, *Listen again*,
  *Quick picks* en columnas, mixes; **Samples** (fragmentos a pantalla completa);
  **Explore** (novedades, charts, moods & genres); **Library**; búsqueda con sugerencias,
  resultado principal y filtros; páginas de álbum, playlist y artista.
- **Reproductor completo:** selector canción/video, título con ›, chips (me gusta / no me
  gusta, Lyrics, Related, Save, Download, Share), barra fina, aleatorio y repetir.
  Al deslizar hacia arriba aparece la cola (*Playing from…*, Autoplay, reordenar con ≡).
  **Lyrics** sincronizadas (LRCLIB) con botón *Share*, y **Related** (*You might also like*,
  artistas similares, *More from*).
- **Tu cuenta de YouTube:** *Sign in with Google* (página de inicio de sesión de Google,
  como en ytm-rs de escritorio). Trae tus playlists, álbumes guardados, Liked Music,
  historial y el Inicio personalizado; los me gusta y *Save to playlist* se guardan en la
  cuenta. La sesión queda en la carpeta privada de la app.
- **Video:** el botón Song | Video muestra el videoclip sincronizado con la música (H.264
  hasta 720p, decodificado por hardware). Solo se carga con el reproductor abierto y la
  pantalla prendida: al bloquear el teléfono el video se suelta y la música sigue.
  Con *Data saver* activado no hay video.
- **Luces de fondo** en Inicio, con los colores de las primeras carátulas (un degradé
  quieto: no gasta batería).
- **Descargas:** audio + carátula + letra. Quedan en el almacenamiento privado de la app
  y con el comienzo del archivo mezclado (XOR por canción), así que **solo se pueden
  escuchar dentro de Giraffe Music**. Sin internet, la app ofrece ir a Descargas.
- **Sin anuncios:** se reproduce el archivo de audio de la canción (no el video con
  publicidad), se filtran los estantes promocionales y se saltan las partes que no son
  música de los videoclips (SponsorBlock).
- Notificación, pantalla de bloqueo, auriculares Bluetooth y Android Auto (Media3),
  temporizador para dormir, atrás de Android por capas.

## Batería

| Qué | Cómo |
| --- | --- |
| Decodificar audio | **ExoPlayer con *audio offload***: el chip de audio decodifica el AAC y el procesador duerme. Se elige AAC (no Opus) porque el teléfono lo decodifica por hardware. |
| Red | Buffer de hasta 4 minutos: el Wi-Fi/datos bajan en ráfagas y descansan. Caché de audio de 256 MB: lo que ya escuchaste se repite sin red. Descargas de a una y en bloques de 512 KB. |
| Con la pantalla apagada | El WebView queda en pausa (no dibuja). El reproductor nativo tiene su propia cola y sigue solo; el video se suelta. |
| Con la pantalla prendida | El progreso se actualiza 2 veces por segundo solo si algo suena, sin `requestAnimationFrame`. Nada de desenfoques (*blur*) ni animaciones infinitas; las transiciones usan solo `transform`. |
| Dibujo | Listas con `content-visibility`, imágenes del tamaño justo y diferidas, fuentes del sistema, una sola escucha de toques para toda la app. |
| Núcleo Rust | 2 hilos que casi siempre esperan a la red; respuestas en caché. |

## Cómo está armado

```
┌──────────────── APK ────────────────────────────────────────────┐
│ MainActivity (WebView)  ── window.GiraffeNative ──▶ PlaybackService │
│   interfaz web/ (HTML/CSS/JS)                       ExoPlayer+Media3│
│        │ http://127.0.0.1:47811                          │          │
│        ▼                                                 ▼          │
│ libgiraffe.so (Rust): ytm.rs · ytmapi.rs · innertube.rs · descargas │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
                YouTube Music · googlevideo · LRCLIB · SponsorBlock
```

- `src/lib.rs` arma el núcleo; `src/android.rs` es la entrada JNI.
- `src/shim/` reemplaza las piezas de escritorio que nombran esos archivos (proxy SOCKS,
  llavero del sistema, QuickJS para Premium) por versiones chicas.
- `android/` es el proyecto Kotlin: `MainActivity.kt`, `PlaybackService.kt`, `Native.kt`.

## Instalar

Pasá `app-arm64-v8a-release.apk` al teléfono y abrilo (Android pide permitir "instalar
apps desconocidas"). Para teléfonos viejos de 32 bits, `armeabi-v7a`; si no sabés,
el `universal`. Requiere Android 8.0 o más nuevo.

## Compilar

```sh
export ANDROID_HOME=~/Android/Sdk      # con el NDK 27 instalado
./build-apk.sh
```

O subí el repo a GitHub: el workflow `.github/workflows/giraffe-apk.yml` compila el APK
y lo deja en *Actions → Artifacts*.

La llave `android/giraffe.jks` es de demostración (para que las actualizaciones se
instalen encima). Para publicar, generá una propia y no la subas.

## Publicar en GitHub y actualizaciones dentro de la app

1. Creá el repo y poné su nombre en `android/gradle.properties`: `giraffe.updateRepo=usuario/repo`.
2. **Creá una llave de firma propia** (la de `android/giraffe.jks` es pública, de demostración):
   `keytool -genkeypair -keystore mi-llave.jks -alias giraffe -keyalg RSA -keysize 2048 -validity 10000`
   y cargala en los secretos del repo (ver `.github/workflows/giraffe-apk.yml`). Guardala bien:
   sin la misma llave, las actualizaciones no se instalan encima.
3. Publicá una versión con una etiqueta: `git tag v0.3.0 && git push --tags`. GitHub compila los
   APK y crea el release.

La app revisa los releases como mucho una vez por día al abrirse (o desde Settings → About),
baja el APK de tu procesador y abre el instalador de Android, que solo pide confirmar.

## Probar en la PC

```sh
cargo run --release -- --demo        # datos y música de ejemplo, sin internet
cargo run --release                  # YouTube Music real
```

Abrí `http://127.0.0.1:8787` con el modo celular de las herramientas de desarrollo.
Con `--host 0.0.0.0` también se abre desde el teléfono en la misma red. El modo demo
sirve para presentar el proyecto si la red del lugar bloquea YouTube.

## Límites conocidos

- Sin cuenta, *me gusta*, biblioteca e historial se guardan solo en el teléfono.
- Para una canción sin videoclip propio, el video se busca por título y artista; si la
  versión del video tiene otra intro, puede empezar en un punto un poco distinto.
- En el APK, SponsorBlock salta las partes no musicales mientras la app está abierta.
- Para transmitir a un parlante/TV se usa el selector de salida de audio de Android.

Licencia GPL-3.0, como ytm-rs.
