package com.giraffe.music

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Las notificaciones propias de Giraffe (la de la música la pone Media3):
 * - Descargas: "Downloading 23 of 257", una sola notificación que se actualiza.
 * - Versión nueva: la busca un trabajo del sistema una vez por día, con internet y sin la
 *   app abierta. Al tocarla se abre la app y aparece el aviso para actualizar.
 */
object Notifier {
    private const val CH_DL = "downloads"
    private const val CH_UPD = "updates"
    const val ID_DL = 2
    private const val ID_DL_DONE = 4
    private const val ID_UPD = 3
    private const val JOB_UPDATE = 10
    const val EXTRA_UPDATE = "giraffe.update"

    fun channels(ctx: Context): NotificationManager {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CH_DL) == null) {
            val es = es(ctx)
            nm.createNotificationChannel(NotificationChannel(CH_DL, if (es) "Descargas" else "Downloads", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_UPD, if (es) "Actualizaciones" else "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        }
        return nm
    }

    fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(ctx: Context, update: Boolean): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (update) i.putExtra(EXTRA_UPDATE, true)
        return PendingIntent.getActivity(ctx, if (update) 1 else 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // ------------------------------------------------------------------ descargas

    /** Español si el usuario lo eligió en la app (o el teléfono está en español). */
    fun es(ctx: Context): Boolean {
        val l = ctx.getSharedPreferences("giraffe", Context.MODE_PRIVATE).getString("lang", "auto")
        return l == "es" || (l != "en" && java.util.Locale.getDefault().language == "es")
    }

    /** Hay descargas: el servicio las mantiene vivas aunque la app quede en segundo plano. */
    fun watchDownloads(ctx: Context, port: Int) {
        if (port <= 0 || DownloadService.running) return
        val i = Intent(ctx, DownloadService::class.java).putExtra("port", port)
        runCatching { ContextCompat.startForegroundService(ctx, i) }
    }

    fun downloadsNotification(ctx: Context, done: Int, total: Int, permille: Int, cancel: PendingIntent?): android.app.Notification {
        channels(ctx)
        val es = es(ctx)
        val b = NotificationCompat.Builder(ctx, CH_DL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(when {
                total == 0 -> if (es) "Preparando descargas…" else "Preparing downloads…"
                es -> "Descargando ${done + 1} de $total"
                else -> "Downloading ${done + 1} of $total"
            })
            .setContentText(if (es) "$done de $total canciones descargadas" else "$done of $total songs downloaded")
            .setProgress(1000, permille.coerceIn(0, 1000), total == 0)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(openApp(ctx, false))
        if (cancel != null) b.addAction(0, if (es) "Cancelar" else "Cancel", cancel)
        return b.build()
    }

    fun showDownloadsDone(ctx: Context, total: Int) {
        if (!allowed(ctx) || total <= 0) return
        val es = es(ctx)
        val n = NotificationCompat.Builder(ctx, CH_DL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (es) "Descargas completas" else "Downloads complete")
            .setContentText(when {
                es && total == 1 -> "Se descargó 1 canción"
                es -> "Se descargaron $total canciones"
                total == 1 -> "1 song downloaded"
                else -> "$total songs downloaded"
            })
            .setAutoCancel(true).setSilent(true)
            .setContentIntent(openApp(ctx, false))
            .build()
        runCatching { channels(ctx).notify(ID_DL_DONE, n) }
    }

    fun get(url: String, method: String = "GET"): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 15000; c.requestMethod = method
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("User-Agent", "GiraffeMusic")
        try { return c.inputStream.bufferedReader().use { it.readText() } } finally { c.disconnect() }
    }

    // ------------------------------------------------------------------ versión nueva

    /** Programa la búsqueda diaria (si ya está programada, no hace nada). */
    fun scheduleUpdateCheck(ctx: Context) {
        if (BuildConfig.UPDATE_REPO.isEmpty()) return
        val js = ctx.getSystemService(JobScheduler::class.java)
        if (js.getPendingJob(JOB_UPDATE) != null) return
        js.schedule(
            JobInfo.Builder(JOB_UPDATE, ComponentName(ctx, UpdateCheckJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(24 * 60 * 60 * 1000L)
                .setPersisted(true)
                .build()
        )
    }

    /** Pregunta a GitHub por la última versión; avisa una sola vez por cada versión nueva. */
    fun checkUpdate(ctx: Context) {
        val rel = JSONObject(get("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest"))
        val ver = rel.optString("tag_name").removePrefix("v")
        if (ver.isEmpty() || !newer(ver, BuildConfig.VERSION_NAME)) return
        val prefs = ctx.getSharedPreferences("giraffe", Context.MODE_PRIVATE)
        if (prefs.getString("notifiedVersion", "") == ver) return
        prefs.edit().putString("notifiedVersion", ver).apply()
        if (!allowed(ctx)) return
        val n = NotificationCompat.Builder(ctx, CH_UPD)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (es(ctx)) "Giraffe Music $ver está disponible" else "Giraffe Music $ver is available")
            .setContentText(if (es(ctx)) "Toca para actualizar" else "Tap to update")
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx, true))
            .build()
        runCatching { channels(ctx).notify(ID_UPD, n) }
    }

    /** Al abrir la app desde el aviso de versión nueva, el aviso ya no hace falta. */
    fun clearUpdate(ctx: Context) = runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(ID_UPD) }

    private fun newer(a: String, b: String): Boolean {
        val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }; val y = pb.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

}

/** El trabajo diario del sistema que busca versiones nuevas (no deja nada corriendo). */
class UpdateCheckJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            runCatching { Notifier.checkUpdate(this) }
            jobFinished(params, false)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true
}

/**
 * Mantiene las descargas andando con la app en segundo plano o la pantalla apagada:
 * un servicio en primer plano con la notificación de progreso. Solo existe mientras
 * hay algo que bajar; al terminar se cierra solo (y suelta el wakelock).
 */
class DownloadService : android.app.Service() {
    companion object { @Volatile var running = false }
    private var thread: Thread? = null
    private var wake: android.os.PowerManager.WakeLock? = null
    private var wifi: android.net.wifi.WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val port = intent?.getIntExtra("port", -1) ?: -1
        if (intent?.action == "cancel") {
            Thread { runCatching { Notifier.get("http://127.0.0.1:$port/api/downloads/active", "DELETE") } }.start()
            return START_NOT_STICKY
        }
        val cancel = PendingIntent.getService(this, 5, Intent(this, DownloadService::class.java).setAction("cancel").putExtra("port", port),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val first = Notifier.downloadsNotification(this, 0, 0, 0, cancel)
        if (Build.VERSION.SDK_INT >= 29) startForeground(Notifier.ID_DL, first, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(Notifier.ID_DL, first)
        if (running || port <= 0) return START_NOT_STICKY
        running = true
        wake = (getSystemService(POWER_SERVICE) as android.os.PowerManager)
            .newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "giraffe:downloads").apply { setReferenceCounted(false); acquire(30 * 60 * 1000L) }
        @Suppress("DEPRECATION")
        wifi = (applicationContext.getSystemService(WIFI_SERVICE) as android.net.wifi.WifiManager)
            .createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "giraffe:downloads").apply { setReferenceCounted(false); acquire() }
        thread = Thread {
            val seen = HashSet<String>()
            val nm = Notifier.channels(this)
            var idle = 0
            var finished = 0
            try {
                while (idle < 3 && running) {
                    val active = runCatching { JSONObject(Notifier.get("http://127.0.0.1:$port/api/downloads/active")) }.getOrNull() ?: JSONObject()
                    val ids = active.keys().asSequence().toList()
                    if (ids.isEmpty()) idle++ else { idle = 0; seen.addAll(ids) }
                    if (ids.isNotEmpty()) {
                        val partial = ids.sumOf { active.optDouble(it, 0.0) }
                        finished = seen.size - ids.size
                        if (Notifier.allowed(this)) runCatching {
                            nm.notify(Notifier.ID_DL, Notifier.downloadsNotification(this, finished, seen.size, ((finished + partial) * 1000 / seen.size).toInt(), cancel))
                        }
                        wake?.acquire(30 * 60 * 1000L)
                    }
                    Thread.sleep(1500)
                }
                finished = seen.size
            } catch (_: InterruptedException) {
            } finally {
                running = false
                runCatching { wake?.release(); wifi?.release() }
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
                Notifier.showDownloadsDone(this, finished)
                stopSelf()
            }
        }.apply { start() }
        return START_NOT_STICKY
    }

    /** Android 15 limita estos servicios a 6 h por día: se corta prolijo y sigue la próxima vez. */
    override fun onTimeout(startId: Int, fgsType: Int) { running = false; thread?.interrupt() }

    override fun onDestroy() { running = false; runCatching { wake?.release(); wifi?.release() }; super.onDestroy() }
}
