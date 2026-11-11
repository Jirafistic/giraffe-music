package com.giraffe.carmusic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Descargar y quitar descargas. Lo hace el núcleo (el propio o el de Giraffe, si están
 * vinculadas: entonces la canción queda una sola vez y la ven las dos apps).
 */
object Downloads {
    /** En segundo plano. */
    fun add(ctx: Context, tracks: JSONArray) {
        if (tracks.length() == 0) return
        Bridge.http("/api/downloads", "POST", tracks.toString())
        watch(ctx)
    }

    fun remove(id: String) = Bridge.http("/api/download/${Bridge.enc(id)}", "DELETE")

    /** La notificación con el progreso, mientras haya algo bajando. */
    fun watch(ctx: Context) {
        runCatching { ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java)) }
    }
}

/**
 * Mientras se descarga: un servicio en primer plano con "Descargando 3 de 20", así Android no
 * corta la descarga con la pantalla apagada. Termina solo cuando no queda nada.
 */
class DownloadService : Service() {
    companion object {
        @Volatile var running = false
        private const val ID = 7
        private const val CH = "downloads"
    }

    private var thread: Thread? = null
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?) = null

    private fun note(text: String, done: Int, total: Int, ongoing: Boolean): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            nm.createNotificationChannel(NotificationChannel(CH, getString(R.string.downloads), NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val b = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CH) else @Suppress("DEPRECATION") Notification.Builder(this))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
        if (ongoing) {
            b.setProgress(maxOf(total, 1), done, total == 0)
            val cancel = PendingIntent.getService(this, 1, Intent(this, DownloadService::class.java).setAction("cancel"), PendingIntent.FLAG_IMMUTABLE)
            b.addAction(Notification.Action.Builder(null, getString(R.string.cancel), cancel).build())
        }
        return b.build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "cancel") {
            Thread { runCatching { Bridge.http("/api/downloads/active", "DELETE") } }.start()
            return START_NOT_STICKY
        }
        val first = note(getString(R.string.downloading), 0, 0, true)
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, first)
        if (running) return START_NOT_STICKY
        running = true
        Bridge.init(this)
        wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "carmusic:dl")
            .apply { setReferenceCounted(false); acquire(30 * 60 * 1000L) }
        thread = Thread {
            val seen = HashSet<String>()
            val nm = getSystemService(NotificationManager::class.java)
            var idle = 0
            try {
                while (idle < 3 && running) {
                    val active = runCatching { JSONObject(Bridge.http("/api/downloads/active")) }.getOrNull() ?: JSONObject()
                    val ids = active.keys().asSequence().toList()
                    if (ids.isEmpty()) idle++ else { idle = 0; seen += ids }
                    if (ids.isNotEmpty()) {
                        val done = seen.size - ids.size
                        runCatching { nm.notify(ID, note(getString(R.string.downloading_n, done + 1, seen.size), done, seen.size, true)) }
                        wake?.acquire(30 * 60 * 1000L)
                    }
                    Thread.sleep(1500)
                }
            } catch (_: InterruptedException) {
            } finally {
                running = false
                runCatching { wake?.release() }
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
                if (seen.isNotEmpty()) runCatching { nm.notify(ID + 1, note(getString(R.string.download_done), 0, 0, false)) }
                stopSelf()
            }
        }.apply { start() }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) { running = false; thread?.interrupt() }

    override fun onDestroy() { running = false; runCatching { wake?.release() }; super.onDestroy() }
}
