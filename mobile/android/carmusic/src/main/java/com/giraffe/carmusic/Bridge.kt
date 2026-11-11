package com.giraffe.carmusic

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.IBinder
import android.os.Parcel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** El núcleo de Giraffe en Rust (`libgiraffe.so`), el mismo que usa Giraffe Music. */
object Core {
    init {
        System.loadLibrary("giraffe")
    }

    /** Arranca el servidor local de CarMusic (una vez por proceso) y devuelve su puerto, o -1. */
    external fun start(dataDir: String): Int
}

/**
 * A qué núcleo le habla CarMusic. Es una app independiente con su propio núcleo, pero si
 * Giraffe Music (0.5.02 o más nueva) está instalada, se vincula con ella y usa el suyo: así
 * comparten la cuenta, las playlists y las descargas (cada canción se guarda una sola vez,
 * da igual desde qué app se bajó).
 *
 * Al vincularse, lo que CarMusic tenía descargado por su cuenta pasa a Giraffe y la copia
 * propia se borra en cuanto Giraffe la tiene, para no ocupar el doble.
 */
object Bridge {
    const val GIRAFFE = "com.giraffe.music"

    @Volatile var port = 0
        private set

    /** true: usando el núcleo de Giraffe Music. false: el propio. */
    @Volatile var linked = false
        private set

    private lateinit var app: Context
    private val lock = Any()

    fun init(ctx: Context) {
        if (!::app.isInitialized) app = ctx.applicationContext
    }

    fun installed(ctx: Context) = runCatching { ctx.packageManager.getPackageInfo(GIRAFFE, 0); true }.getOrDefault(false)

    fun url(path: String): String {
        if (port <= 0) ensure()
        return "http://127.0.0.1:$port$path"
    }

    /** Deja un núcleo listo (bloquea: solo en segundo plano). */
    fun ensure(): Boolean {
        if (port > 0) return true
        synchronized(lock) {
            if (port > 0) return true
            if (installed(app)) link()?.let { port = it; linked = true }
            if (port <= 0) {
                val p = Core.start(app.filesDir.absolutePath)
                if (p > 0) { port = p; linked = false }
            }
            if (port <= 0) return false
            waitReady()
            if (linked) Thread { runCatching { handOver() } }.start()
            return true
        }
    }

    private fun waitReady() {
        val until = System.currentTimeMillis() + 8000
        while (System.currentTimeMillis() < until) {
            if (runCatching { http("/api/status", timeout = 2000) }.isSuccess) return
            Thread.sleep(150)
        }
    }

    // ------------------------------------------------------------------ vínculo con Giraffe

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, b: IBinder?) {
            val p = runCatching {
                val data = Parcel.obtain()
                val reply = Parcel.obtain()
                try {
                    if (b?.transact(1, data, reply, 0) == true) reply.readInt() else -1
                } finally {
                    data.recycle(); reply.recycle()
                }
            }.getOrDefault(-1)
            // Si Giraffe se reinició (por ejemplo, al actualizarse), Android reconecta solo.
            if (p > 0 && linked) port = p
            linkPort = p
            linkLatch.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName?) {}
    }
    @Volatile private var linkPort = -1
    private var linkLatch = CountDownLatch(1)

    /** El puerto del núcleo de Giraffe, o null si es una versión sin vínculo (o no contesta). */
    private fun link(): Int? {
        linkLatch = CountDownLatch(1)
        val i = Intent().setComponent(ComponentName(GIRAFFE, "$GIRAFFE.CarBridgeService"))
        // Mientras CarMusic esté abierta o sonando, Android mantiene despierto el núcleo de Giraffe.
        val bound = runCatching { app.bindService(i, conn, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT) }.getOrDefault(false)
        if (!bound) return null
        linkLatch.await(6, TimeUnit.SECONDS)
        if (linkPort <= 0) { runCatching { app.unbindService(conn) }; return null }
        return linkPort
    }

    /**
     * Lo que CarMusic hizo sola antes de vincularse pasa a Giraffe: la sesión (si Giraffe no
     * tenía una) y las descargas. Las copias propias se borran cuando Giraffe ya las tiene.
     */
    private fun handOver() {
        val own = File(app.filesDir, "account.json")
        if (own.exists()) {
            val signed = runCatching { JSONObject(http("/api/account")).optBoolean("signedIn") }.getOrDefault(true)
            val cookie = runCatching { JSONObject(own.readText()).optString("cookie") }.getOrDefault("")
            if (!signed && cookie.contains("SAPISID=")) runCatching { http("/api/login", "POST", JSONObject().put("cookie", cookie).toString()) }
        }
        val dir = File(app.filesDir, "downloads")
        if (!dir.isDirectory || dir.list().isNullOrEmpty()) return
        val p = Core.start(app.filesDir.absolutePath)
        if (p <= 0) return
        val mine = runCatching { JSONObject(raw(p, "/api/downloads")).optJSONArray("items") }.getOrNull() ?: JSONArray()
        val theirs = runCatching { JSONObject(http("/api/downloads")).optJSONArray("items") }.getOrNull() ?: JSONArray()
        val have = (0 until theirs.length()).mapNotNull { theirs.optJSONObject(it)?.optJSONObject("track")?.optString("id") }.toHashSet()
        val missing = JSONArray()
        for (i in 0 until mine.length()) {
            val t = mine.optJSONObject(i)?.optJSONObject("track") ?: continue
            val id = t.optString("id")
            if (id in have) runCatching { raw(p, "/api/download/${enc(id)}", "DELETE") } else missing.put(t)
        }
        if (missing.length() > 0) {
            runCatching { http("/api/downloads", "POST", missing.toString()) }
            Downloads.watch(app)
        } else if (mine.length() == 0) {
            dir.deleteRecursively()
        }
    }

    // ------------------------------------------------------------------ HTTP

    /** GET/POST al núcleo (en un hilo de fondo, nunca en el principal). */
    fun http(path: String, method: String = "GET", body: String? = null, timeout: Int = 20000): String {
        if (port <= 0 && !ensure()) throw RuntimeException("sin núcleo")
        return raw(port, path, method, body, timeout)
    }

    private fun raw(p: Int, path: String, method: String = "GET", body: String? = null, timeout: Int = 20000): String {
        val c = URL("http://127.0.0.1:$p$path").openConnection() as HttpURLConnection
        c.connectTimeout = 4000
        c.readTimeout = timeout
        c.requestMethod = method
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        try {
            if (c.responseCode !in 200..299) throw RuntimeException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    fun json(path: String): JSONObject = JSONObject(http(path))

    fun enc(s: String): String = Uri.encode(s)
}
