package com.giraffe.music

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.content.Context
import android.graphics.Color
import android.media.audiofx.AudioEffect
import android.net.ConnectivityManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

/**
 * La pantalla: un WebView con la interfaz (servida por el núcleo en Rust en 127.0.0.1)
 * que maneja al reproductor nativo a través de `window.GiraffeNative`.
 *
 * La interfaz no hace nada en segundo plano: el reproductor nativo tiene su propia
 * cola y sigue solo; la página se entera de los cambios por eventos cuando vuelve.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var port = -1
    private var controller: MediaController? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private val main = Handler(Looper.getMainLooper())
    private var insetTop = 0
    private var insetBottom = 0

    /** Permiso de notificaciones (Android 13+): se pide una sola vez, al abrir la app. */
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    /** La app se abrió desde el aviso de versión nueva: la interfaz muestra el diálogo de actualizar. */
    private var openedForUpdate = false

    /** Vuelve de la ventana de Google con la cookie de sesión (o sin nada si se canceló). */
    private val loginLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cookie = r.data?.getStringExtra("cookie")
        emit(JSONObject().put("e", "login").put("cookie", cookie ?: JSONObject.NULL))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Barras del sistema transparentes: la interfaz se dibuja detrás, como YouTube Music.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        port = Native.start(filesDir.absolutePath)
        openedForUpdate = intent?.getBooleanExtra(Notifier.EXTRA_UPDATE, false) == true
        if (openedForUpdate) Notifier.clearUpdate(this)
        Notifier.scheduleUpdateCheck(this)
        val prefs = getSharedPreferences("giraffe", Context.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotif", false)) {
            prefs.edit().putBoolean("askedNotif", true).apply()
            notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        web = WebView(this).apply {
            setBackgroundColor(0xFF030303.toInt())
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        setContentView(web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
            setSupportZoom(false)
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            offscreenPreRaster = false
        }
        web.addJavascriptInterface(Bridge(), "GiraffeNative")
        // Diálogos de la página (confirmar borrar descargas, etc.).
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            // La página pudo no estar lista cuando llegaron los márgenes: se mandan de nuevo.
            override fun onPageFinished(view: WebView, url: String?) {
                sendInsets()
                sync()
            }

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == "127.0.0.1") return false
                // Links externos, al navegador.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, req.url)) }
                return true
            }
        }

        // Márgenes de las barras del sistema, en px de CSS (dp), para la interfaz.
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val d = resources.displayMetrics.density
            insetTop = (bars.top / d).toInt()
            insetBottom = (bars.bottom / d).toInt()
            sendInsets()
            insets
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Atrás cierra el reproductor/menús o vuelve de página; en el inicio, la
                // app pasa al fondo (la música sigue), no se cierra.
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (port > 0) {
            web.loadUrl("http://127.0.0.1:$port/")
        } else {
            web.loadData(
                "<body style='background:#030303;color:#fff;font-family:sans-serif;padding:40px'>Giraffe Music couldn't start.</body>",
                "text/html", "utf-8",
            )
        }
        connect()
    }

    /** Se conecta al servicio de reproducción (lo arranca si hace falta). */
    private fun connect() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val f = MediaController.Builder(this, token).buildAsync()
        controllerFuture = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(listener)
            sync()
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onStart() {
        super.onStart()
        web.onResume()
        emit(JSONObject().put("e", "vis").put("hidden", false))
        sync()
    }

    override fun onStop() {
        // La página deja de dibujar el progreso; el reproductor nativo sigue solo.
        emit(JSONObject().put("e", "vis").put("hidden", true))
        // Sin dibujar nada en segundo plano. El JavaScript sigue (pocas veces: solo
        // cuando cambia la canción, para la cola y el autoplay); la música es nativa.
        main.post { web.onPause() }
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(Notifier.EXTRA_UPDATE, false)) {
            Notifier.clearUpdate(this)
            emit(JSONObject().put("e", "checkUpdate"))
        }
    }

    override fun onDestroy() {
        controller?.removeListener(listener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        web.destroy()
        super.onDestroy()
    }

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.containsAny(
                    Player.EVENT_IS_PLAYING_CHANGED,
                    Player.EVENT_MEDIA_ITEM_TRANSITION,
                    Player.EVENT_PLAYBACK_STATE_CHANGED,
                    Player.EVENT_POSITION_DISCONTINUITY,
                    Player.EVENT_TIMELINE_CHANGED,
                )
            ) sync()
            if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && player.playbackState == Player.STATE_ENDED) {
                emit(JSONObject().put("e", "ended"))
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            emit(JSONObject().put("e", "error").put("msg", error.errorCodeName))
            // Saltar a la siguiente en vez de quedarse trabado.
            controller?.let { c ->
                if (c.hasNextMediaItem()) {
                    c.seekToNextMediaItem()
                    c.prepare()
                    c.play()
                }
            }
        }
    }

    private fun sendInsets() {
        emit(JSONObject().put("e", "insets").put("top", insetTop).put("bottom", insetBottom))
    }

    /** El estado actual para la interfaz (una vez por cambio, no por segundo). */
    private fun sync() {
        val c = controller ?: return
        val dur = c.duration
        emit(
            JSONObject()
                .put("e", "sync")
                .put("i", c.currentMediaItemIndex)
                .put("pos", c.currentPosition)
                .put("dur", if (dur == C.TIME_UNSET) -1 else dur)
                .put("buf", c.bufferedPosition)
                .put("playing", c.isPlaying)
                .put("loading", c.playbackState == Player.STATE_BUFFERING)
                .put("n", c.mediaItemCount)
        )
    }

    private fun emit(msg: JSONObject) {
        if (!::web.isInitialized) return
        main.post { web.evaluateJavascript("window.__gm&&window.__gm($msg)", null) }
    }

    private fun items(json: String): List<MediaItem> {
        val a = JSONArray(json)
        return List(a.length()) { i ->
            val o = a.getJSONObject(i)
            val id = o.getString("id")
            val art = o.optString("art")
            val artUri = when {
                art.isEmpty() -> null
                art.startsWith("/") -> Uri.parse("http://127.0.0.1:$port$art")
                else -> Uri.parse(art)
            }
            MediaItem.Builder()
                .setMediaId(id)
                .setUri("http://127.0.0.1:$port/api/stream/${Uri.encode(id)}${quality()}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(o.optString("title"))
                        .setArtist(o.optString("artist"))
                        .setAlbumTitle(o.optString("album"))
                        .setArtworkUri(artUri)
                        .build()
                )
                .build()
        }
    }

    private fun metered(): Boolean = (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered

    /** La calidad elegida para la red actual (datos móviles o Wi-Fi), como en YouTube Music. */
    private fun quality(): String {
        val p = getSharedPreferences("giraffe", Context.MODE_PRIVATE)
        // Con Wi-Fi siempre la mejor; con datos lo que elija el usuario (Automática = normal).
        val q = if (metered()) p.getString("qMobile", "normal") else "high"
        return if (q == "low" || q == "high") "?q=$q" else ""
    }

    /** Todo lo de MediaController va en el hilo principal. */
    private fun ui(f: (MediaController) -> Unit) {
        main.post { controller?.let { runCatching { f(it) } } }
    }

    /** Lo que la interfaz puede pedirle al teléfono (`window.GiraffeNative`). */
    inner class Bridge {
        @JavascriptInterface
        fun setQueue(json: String, index: Int, startMs: Double, play: Boolean) = ui { c ->
            c.setMediaItems(items(json), index, startMs.toLong())
            // Al restaurar la sesión (en pausa) no se prepara: nada se baja hasta tocar play.
            if (play) c.prepare()
            c.playWhenReady = play
        }

        @JavascriptInterface
        fun replaceUpcoming(json: String) = ui { c ->
            val from = c.currentMediaItemIndex + 1
            if (from < c.mediaItemCount) c.removeMediaItems(from, c.mediaItemCount)
            c.addMediaItems(items(json))
        }

        /** Todo menos la que suena: lo de antes y lo de después (para mezclar sin cortar). */
        @JavascriptInterface
        fun rebase(before: String, after: String) = ui { c ->
            val i = c.currentMediaItemIndex
            if (i + 1 < c.mediaItemCount) c.removeMediaItems(i + 1, c.mediaItemCount)
            if (i > 0) c.removeMediaItems(0, i)
            val b = items(before)
            if (b.isNotEmpty()) c.addMediaItems(0, b)
            c.addMediaItems(items(after))
        }

        @JavascriptInterface
        fun insert(json: String, at: Int) = ui { c -> c.addMediaItems(at.coerceIn(0, c.mediaItemCount), items(json)) }

        @JavascriptInterface
        fun move(from: Int, to: Int) = ui { c -> c.moveMediaItem(from, to) }

        @JavascriptInterface
        fun remove(i: Int) = ui { c -> if (i in 0 until c.mediaItemCount) c.removeMediaItem(i) }

        @JavascriptInterface
        fun play() = ui { c ->
            if (c.playbackState == Player.STATE_IDLE) c.prepare()
            if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition()
            c.play()
        }

        @JavascriptInterface
        fun pause() = ui { it.pause() }

        @JavascriptInterface
        fun seekTo(ms: Double) = ui { it.seekTo(ms.toLong()) }

        @JavascriptInterface
        fun skipTo(i: Int) = ui { c ->
            if (i in 0 until c.mediaItemCount) {
                c.seekToDefaultPosition(i)
                c.prepare()
                c.play()
            }
        }

        @JavascriptInterface
        fun next() = ui { it.seekToNext() }

        @JavascriptInterface
        fun prev() = ui { it.seekToPrevious() }

        @JavascriptInterface
        fun setRepeat(mode: Int) = ui { it.repeatMode = mode }

        @JavascriptInterface
        fun sync() = main.post { this@MainActivity.sync() }

        /** Cambia la canción que suena por otra versión (canción ↔ videoclip) en el mismo punto. */
        @JavascriptInterface
        fun replaceCurrent(json: String, startMs: Double) = ui { c ->
            val i = c.currentMediaItemIndex
            if (i < 0) return@ui
            val wasPlaying = c.playWhenReady
            c.replaceMediaItem(i, items(json)[0])
            c.seekTo(i, startMs.toLong())
            c.prepare()
            c.playWhenReady = wasPlaying
        }

        // ---- Ecualizador y Dolby Atmos: solo si el teléfono los tiene.
        private fun eqIntent() = Intent(AudioEffect.ACTION_DISPLAY_AUDIO_EFFECT_CONTROL_PANEL)
            .putExtra(AudioEffect.EXTRA_AUDIO_SESSION, PlaybackService.audioSessionId)
            .putExtra(AudioEffect.EXTRA_PACKAGE_NAME, packageName)
            .putExtra(AudioEffect.EXTRA_CONTENT_TYPE, AudioEffect.CONTENT_TYPE_MUSIC)

        private fun dolbyIntent(): Intent? = listOf(
            "com.dolby.daxappui", "com.dolby.daxappUI", "com.dolby.dax2appUI", "com.dolby.ds1appUI",
            "com.motorola.dolby.dolbyui", "com.dolby.atmos", "com.lenovo.dolby",
        ).firstNotNullOfOrNull { packageManager.getLaunchIntentForPackage(it) }

        @JavascriptInterface
        fun audioTools(): String = JSONObject()
            .put("eq", eqIntent().resolveActivity(packageManager) != null)
            .put("dolby", dolbyIntent() != null)
            .toString()

        @JavascriptInterface
        fun openEqualizer() = main.post { runCatching { startActivity(eqIntent()) } }

        @JavascriptInterface
        fun openDolby() = main.post { dolbyIntent()?.let { runCatching { startActivity(it) } } }

        @JavascriptInterface
        fun setNormalize(on: Boolean) {
            getSharedPreferences("giraffe", Context.MODE_PRIVATE).edit().putBoolean("normalize", on).apply()
        }

        @JavascriptInterface
        fun openUrl(url: String) = main.post { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }

        /** Vibración cortita (la del teclado): respeta si el usuario la apagó en el teléfono. */
        @JavascriptInterface
        fun haptic() = main.post { web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }

        @JavascriptInterface
        fun isMetered(): Boolean = metered()

        @JavascriptInterface
        fun setPref(key: String, value: String) {
            getSharedPreferences("giraffe", Context.MODE_PRIVATE).edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun appVersion(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        @JavascriptInterface
        fun updateRepo(): String = BuildConfig.UPDATE_REPO

        @JavascriptInterface
        fun abi(): String = Build.SUPPORTED_ABIS.firstOrNull() ?: ""

        /** Baja e instala la versión nueva (el usuario solo confirma en la pantalla de Android). */
        @JavascriptInterface
        fun installUpdate(url: String) {
            if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                main.post {
                    emit(JSONObject().put("e", "update").put("need", "permission"))
                    runCatching { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                }
                return
            }
            Thread {
                try {
                    val apk = Updater.download(this@MainActivity, url) { p -> emit(JSONObject().put("e", "update").put("p", p)) }
                    Updater.install(this@MainActivity, apk)
                } catch (e: Exception) {
                    emit(JSONObject().put("e", "update").put("error", e.message ?: "error"))
                }
            }.start()
        }

        /** Reinicia la app (la pantalla y la interfaz) para cambiar de interfaz. La música no se corta:
         *  sigue en su servicio. */
        @JavascriptInterface
        fun restart() = main.post { recreate() }

        /** Escuchar juntos: el lector de QR de Google (abre su propia pantalla de cámara). */
        @JavascriptInterface
        fun scanQr() = main.post {
            val opts = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
            runCatching {
                com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(this@MainActivity, opts).startScan()
                    .addOnSuccessListener { emit(JSONObject().put("e", "qr").put("text", it.rawValue ?: "")) }
                    .addOnCanceledListener { emit(JSONObject().put("e", "qr").put("cancel", true)) }
                    .addOnFailureListener { emit(JSONObject().put("e", "qr").put("error", it.message ?: "error")) }
            }.onFailure { emit(JSONObject().put("e", "qr").put("error", it.message ?: "error")) }
        }

        /** Conectado a una red Wi-Fi (Escuchar juntos funciona dentro de la misma red). */
        @JavascriptInterface
        fun onWifi(): Boolean {
            val cm = getSystemService(ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
            return caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
        }

        /** Hay descargas nuevas: la notificación las sigue hasta que terminen. */
        @JavascriptInterface
        fun dlWatch() = Notifier.watchDownloads(this@MainActivity, port)

        @JavascriptInterface
        fun takeUpdateIntent(): Boolean = openedForUpdate.also { openedForUpdate = false }

        @JavascriptInterface
        fun login() = main.post { loginLauncher.launch(Intent(this@MainActivity, LoginActivity::class.java)) }

        @JavascriptInterface
        fun logout() = main.post { CookieManager.getInstance().removeAllCookies(null) }

        @JavascriptInterface
        fun insets(): String = "$insetTop,$insetBottom"

        @JavascriptInterface
        fun share(title: String, url: String) = main.post {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "$title\n$url")
            startActivity(Intent.createChooser(send, null))
        }
    }
}
