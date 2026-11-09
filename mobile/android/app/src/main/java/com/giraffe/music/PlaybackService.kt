package com.giraffe.music

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.AudioEffect
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.Util
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.pow
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import java.io.File
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * El reproductor: ExoPlayer en un servicio, así la música sigue con la app cerrada y
 * aparece en la notificación, la pantalla de bloqueo, los auriculares y el auto.
 *
 * Batería:
 *  - Audio offload: el chip de audio decodifica el AAC y el procesador se duerme
 *    mientras el buffer alcanza (ExoPlayer suelta el wake lock en ese modo).
 *  - Buffer grande (hasta 4 min): la radio (Wi-Fi/datos) baja en ráfagas y descansa.
 *  - Caché en disco (256 MB): lo que ya se escuchó se repite desde el teléfono, sin red.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var cache: SimpleCache? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var pausedAt = 0L

    companion object {
        /** La sesión de audio del reproductor, para abrir el ecualizador del sistema sobre ella. */
        @Volatile
        var audioSessionId = 0
    }

    override fun onCreate() {
        super.onCreate()
        val attrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()
        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs = */ 60_000,
                /* maxBufferMs = */ 240_000,
                /* bufferForPlaybackMs = */ 1_500,
                /* bufferForPlaybackAfterRebufferMs = */ 3_000,
            )
            .build()
        // Las URLs son del núcleo local (/api/stream/ID): la misma canción, la misma clave.
        val disk = SimpleCache(
            File(cacheDir, "audio"),
            LeastRecentlyUsedCacheEvictor(256L * 1024 * 1024),
            StandaloneDatabaseProvider(this),
        )
        cache = disk
        val source = CacheDataSource.Factory()
            .setCache(disk)
            .setUpstreamDataSourceFactory(DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(false))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(source))
            .setAudioAttributes(attrs, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true) // pausa al desconectar los auriculares
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setLoadControl(load)
            .build()
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setAudioOffloadPreferences(
                TrackSelectionParameters.AudioOffloadPreferences.Builder()
                    .setAudioOffloadMode(TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
                    .build()
            )
            .build()

        // Sesión de audio propia, anunciada a los ecualizadores del sistema (y Dolby).
        val sid = Util.generateAudioSessionIdV21(this)
        player.audioSessionId = sid
        audioSessionId = sid
        sendBroadcast(
            Intent(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION)
                .putExtra(AudioEffect.EXTRA_AUDIO_SESSION, sid)
                .putExtra(AudioEffect.EXTRA_PACKAGE_NAME, packageName)
                .putExtra(AudioEffect.EXTRA_CONTENT_TYPE, AudioEffect.CONTENT_TYPE_MUSIC)
        )

        // Normalizar el volumen: cada canción baja hasta el nivel de referencia de
        // YouTube (-14 LUFS). Es solo el volumen del reproductor: no gasta nada.
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) = normalize(player, item)
        })

        // Seguir al conectar auriculares: un aviso de Android cuando aparece una salida de
        // audio (nada que revise a cada rato). Solo si la música se pausó hace poco.
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
                val headphones = added.any {
                    it.isSink && it.type in setOf(
                        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET,
                    )
                }
                val on = getSharedPreferences("giraffe", Context.MODE_PRIVATE).getString("resumeHeadphones", "0") == "1"
                if (headphones && on && !player.isPlaying && player.mediaItemCount > 0 &&
                    System.currentTimeMillis() - pausedAt < 30 * 60_000
                ) {
                    player.prepare()
                    player.play()
                }
            }
        }, main)
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) pausedAt = System.currentTimeMillis()
            }
        })

        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_notification) }
        )
    }

    private fun normalize(player: ExoPlayer, item: MediaItem?) {
        val id = item?.mediaId ?: return
        if (!getSharedPreferences("giraffe", Context.MODE_PRIVATE).getBoolean("normalize", true)) {
            player.volume = 1f
            return
        }
        io.execute {
            val gain = runCatching {
                val port = Native.start(filesDir.absolutePath)
                val c = URL("http://127.0.0.1:$port/api/loudness/${android.net.Uri.encode(id)}").openConnection() as HttpURLConnection
                c.connectTimeout = 3000
                c.readTimeout = 8000
                val body = c.inputStream.bufferedReader().use { it.readText() }
                val db = org.json.JSONObject(body).optDouble("db", 0.0)
                if (db.isNaN() || db <= 0.0) 1f else 10.0.pow(-db / 20.0).toFloat()
            }.getOrDefault(1f)
            main.post { if (player.currentMediaItem?.mediaId == id) player.volume = gain }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Si se cierra la app sin nada sonando, el servicio también se va. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        sendBroadcast(
            Intent(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION)
                .putExtra(AudioEffect.EXTRA_AUDIO_SESSION, audioSessionId)
                .putExtra(AudioEffect.EXTRA_PACKAGE_NAME, packageName)
        )
        io.shutdown()
        cache?.release()
        cache = null
        super.onDestroy()
    }
}
