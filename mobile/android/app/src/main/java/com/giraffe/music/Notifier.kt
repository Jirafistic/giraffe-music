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
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Las notificaciones propias de Giraffe (la de la música la pone Media3):
 * - Descargas: "Downloading 23 of 257", una sola notificación que se actualiza.
 * - Versión nueva: la busca un trabajo del sistema una vez por día, con internet y sin la
 *   app abierta. Al tocarla se abre la app y aparece el aviso para actualizar.
 */
object Notifier {
    private const val CH_DL = "downloads"
    private const val CH_UPD = "updates"
    private const val ID_DL = 2
    private const val ID_UPD = 3
    private const val JOB_UPDATE = 10
    const val EXTRA_UPDATE = "giraffe.update"

    private fun channels(ctx: Context): NotificationManager {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CH_DL) == null) {
            nm.createNotificationChannel(NotificationChannel(CH_DL, "Downloads", NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_UPD, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        }
        return nm
    }

    private fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(ctx: Context, update: Boolean): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (update) i.putExtra(EXTRA_UPDATE, true)
        return PendingIntent.getActivity(ctx, if (update) 1 else 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // ------------------------------------------------------------------ descargas

    private val watching = AtomicBoolean(false)

    /** Sigue las descargas del núcleo hasta que terminen. Pregunta cada 1,5 s solo mientras
     *  hay descargas (una respuesta chica), y no depende de que la pantalla esté abierta. */
    fun watchDownloads(ctx: Context, port: Int) {
        if (port <= 0 || !watching.compareAndSet(false, true)) return
        val app = ctx.applicationContext
        Thread {
            val seen = HashSet<String>()
            var idle = 0
            try {
                while (idle < 3) {
                    val active = runCatching { JSONObject(get("http://127.0.0.1:$port/api/downloads/active")) }.getOrNull() ?: JSONObject()
                    val ids = active.keys().asSequence().toList()
                    if (ids.isEmpty()) idle++ else { idle = 0; seen.addAll(ids) }
                    if (ids.isNotEmpty()) {
                        val partial = ids.sumOf { active.optDouble(it, 0.0) }
                        val done = seen.size - ids.size
                        showDownloads(app, done, seen.size, ((done + partial) * 1000 / seen.size).toInt())
                    }
                    Thread.sleep(1500)
                }
            } finally {
                watching.set(false)
                if (seen.isNotEmpty()) showDownloadsDone(app, seen.size)
            }
        }.start()
    }

    private fun showDownloads(ctx: Context, done: Int, total: Int, permille: Int) {
        if (!allowed(ctx)) return
        val n = NotificationCompat.Builder(ctx, CH_DL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Downloading ${done + 1} of $total")
            .setContentText(if (total > 1) "$done of $total songs downloaded" else "Downloading song")
            .setProgress(1000, permille.coerceIn(0, 1000), false)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(openApp(ctx, false))
            .build()
        runCatching { channels(ctx).notify(ID_DL, n) }
    }

    private fun showDownloadsDone(ctx: Context, total: Int) {
        if (!allowed(ctx)) return
        val n = NotificationCompat.Builder(ctx, CH_DL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Downloads complete")
            .setContentText(if (total == 1) "1 song downloaded" else "$total songs downloaded")
            .setAutoCancel(true).setSilent(true)
            .setContentIntent(openApp(ctx, false))
            .build()
        runCatching { channels(ctx).notify(ID_DL, n) }
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
            .setContentTitle("Giraffe Music $ver is available")
            .setContentText("Tap to update")
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

    private fun get(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000; c.readTimeout = 15000
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("User-Agent", "GiraffeMusic")
        try { return c.inputStream.bufferedReader().use { it.readText() } } finally { c.disconnect() }
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
