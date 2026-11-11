package com.giraffe.carmusic

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.pow

/**
 * El reproductor de CarMusic y lo que ve el auto. Liviano a propósito:
 *  - sin pantalla web ni núcleo propio (usa el de Giraffe por el puente);
 *  - el auto ve Principal, Biblioteca, Descargas y la búsqueda (también por voz);
 *  - la letra: el verso que suena aparece en lugar del artista, cambiando con cada verso
 *    (un aviso por verso, ningún reloj corriendo de más);
 *  - el mismo reproductor eficiente que Giraffe (audio por hardware, buffer grande, caché).
 */
@OptIn(UnstableApi::class)
class CarService : MediaLibraryService() {
    private lateinit var player: ExoPlayer
    private var session: MediaLibrarySession? = null
    private var cache: SimpleCache? = null
    private lateinit var lib: Library
    private val io = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("carmusic", Context.MODE_PRIVATE) }
    private val search = HashMap<String, List<MediaItem>>()
    private val liked = HashSet<String>()

    // La letra de la canción actual.
    private var lines: List<Pair<Long, String>> = emptyList()
    private var lyricVid = ""
    private var lyricIdx = -2
    private val tick = Runnable { lyricTick() }

    private val LIKE = SessionCommand("LIKE", Bundle.EMPTY)
    private val SHUFFLE = SessionCommand("SHUFFLE", Bundle.EMPTY)
    private val REPEAT = SessionCommand("REPEAT", Bundle.EMPTY)

    override fun onCreate() {
        super.onCreate()
        Bridge.init(this)
        io.execute { Bridge.ensure() }
        lib = Library(this)

        val load = DefaultLoadControl.Builder().setBufferDurationsMs(60_000, 240_000, 1_500, 3_000).build()
        val disk = SimpleCache(File(cacheDir, "audio"), LeastRecentlyUsedCacheEvictor(128L * 1024 * 1024), StandaloneDatabaseProvider(this))
        cache = disk
        val source = CacheDataSource.Factory()
            .setCache(disk)
            .setUpstreamDataSourceFactory(DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(false))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(source))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setLoadControl(load)
            .build()
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setAudioOffloadPreferences(
                androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences.Builder()
                    .setAudioOffloadMode(androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
                    .build()
            )
            .build()

        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                val vid = item?.mediaMetadata?.extras?.getString("vid") ?: return
                if (vid == lyricVid) return // solo cambió el verso que se muestra
                onSong(item, vid)
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) = scheduleLyric()
            override fun onPositionDiscontinuity(o: Player.PositionInfo, n: Player.PositionInfo, reason: Int) = scheduleLyric()
            override fun onShuffleModeEnabledChanged(on: Boolean) = updateButtons()
            override fun onRepeatModeChanged(mode: Int) = updateButtons()
        })

        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaLibrarySession.Builder(this, player, Callback()).setSessionActivity(open).build()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_notification) })
        updateButtons()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        session?.run { player.release(); release() }
        session = null
        cache?.release()
        io.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ al empezar cada canción

    private fun onSong(item: MediaItem, vid: String) {
        lyricVid = vid
        lines = emptyList()
        lyricIdx = -2
        main.removeCallbacks(tick)
        if (!liked.contains(vid)) updateButtons()
        val md = item.mediaMetadata
        val ex = md.extras ?: Bundle.EMPTY
        io.execute {
            // Volumen parejo entre canciones (como en Giraffe).
            val gain = runCatching {
                val db = JSONObject(Bridge.http("/api/loudness/${Bridge.enc(vid)}", timeout = 8000)).optDouble("db", 0.0)
                if (db.isNaN() || db <= 0.0) 1f else 10.0.pow(-db / 20.0).toFloat()
            }.getOrDefault(1f)
            main.post { if (lyricVid == vid) player.volume = gain }
            if (!prefs.getBoolean("lyricsInCar", true)) return@execute
            val l = Lyrics.get(vid, md.title?.toString().orEmpty(), ex.getString("artist").orEmpty(), ex.getString("album").orEmpty(), ex.getInt("dur"))
            main.post { if (lyricVid == vid) { lines = l; scheduleLyric() } }
        }
    }

    // ------------------------------------------------------------------ la letra en el auto

    private fun scheduleLyric() {
        main.removeCallbacks(tick)
        if (lines.isNotEmpty()) main.post(tick)
    }

    /** Muestra el verso actual y se agenda para el próximo (nada corre entre versos). */
    private fun lyricTick() {
        if (lines.isEmpty() || !prefs.getBoolean("lyricsInCar", true)) return
        val pos = player.currentPosition
        val i = Lyrics.at(lines, pos)
        if (i != lyricIdx) {
            lyricIdx = i
            showLine(lines.getOrNull(i)?.second?.takeIf { it.isNotBlank() })
        }
        val next = lines.getOrNull(i + 1)?.first ?: return
        if (player.isPlaying) main.postDelayed(tick, ((next - pos) / player.playbackParameters.speed).toLong().coerceIn(50, 60_000))
    }

    /** El verso va donde estaba el artista (sin el verso, vuelve el artista). */
    private fun showLine(text: String?) {
        val i = player.currentMediaItemIndex
        val item = player.currentMediaItem ?: return
        val md = item.mediaMetadata
        val artist = md.extras?.getString("artist").orEmpty()
        val shown = if (text != null) "♪ $text" else artist
        if (md.artist?.toString() == shown) return
        val nmd = md.buildUpon().setArtist(shown).setSubtitle(shown).build()
        runCatching { player.replaceMediaItem(i, item.buildUpon().setMediaMetadata(nmd).build()) }
    }

    // ------------------------------------------------------------------ botones del auto

    private fun updateButtons() {
        val vid = player.currentMediaItem?.mediaMetadata?.extras?.getString("vid")
        val buttons = listOf(
            CommandButton.Builder().setDisplayName(getString(R.string.like)).setSessionCommand(LIKE)
                .setIconResId(if (vid != null && liked.contains(vid)) R.drawable.ic_like else R.drawable.ic_like_off).build(),
            CommandButton.Builder().setDisplayName(getString(R.string.shuffle)).setSessionCommand(SHUFFLE)
                .setIconResId(R.drawable.ic_shuffle).setEnabled(true).build(),
            CommandButton.Builder().setDisplayName(getString(R.string.repeat)).setSessionCommand(REPEAT)
                .setIconResId(if (player.repeatMode == Player.REPEAT_MODE_ONE) R.drawable.ic_repeat_one else R.drawable.ic_repeat).build(),
        )
        session?.setCustomLayout(buttons)
    }

    private inner class Callback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val cmds = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(LIKE).add(SHUFFLE).add(REPEAT).build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(cmds).build()
        }

        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, cmd: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
            when (cmd.customAction) {
                "SHUFFLE" -> player.shuffleModeEnabled = !player.shuffleModeEnabled
                "REPEAT" -> player.repeatMode = when (player.repeatMode) {
                    Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                    Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                    else -> Player.REPEAT_MODE_OFF
                }
                "LIKE" -> {
                    val vid = player.currentMediaItem?.mediaMetadata?.extras?.getString("vid") ?: return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                    val on = !liked.contains(vid)
                    if (on) liked += vid else liked -= vid
                    updateButtons()
                    io.execute { runCatching { Bridge.http("/api/me/like/${Bridge.enc(vid)}", "POST", JSONObject().put("rating", if (on) "LIKE" else "INDIFFERENT").toString()) } }
                }
            }
            updateButtons()
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        /** En segundo plano (las listas vienen del núcleo, propio o el de Giraffe). */
        private fun <T> bg(f: () -> T): ListenableFuture<T> {
            val out = SettableFuture.create<T>()
            io.execute {
                Bridge.ensure()
                runCatching(f).onSuccess { out.set(it) }.onFailure { out.setException(it) }
            }
            return out
        }

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(lib.root(), LibraryParams.Builder().setExtras(Library.rootExtras()).build()))

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            bg {
                val all = runCatching { lib.children(parentId) }.getOrDefault(emptyList())
                val from = (page * pageSize).coerceAtMost(all.size)
                LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, (from + pageSize).coerceAtMost(all.size))), params)
            }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            bg { lib.expand(mediaId)?.let { (l, i) -> LibraryResult.ofItem(l[i], null) } ?: LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE) }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
            io.execute {
                Bridge.ensure()
                val r = runCatching { lib.search(query) }.getOrDefault(emptyList())
                main.post { search[query] = r; session.notifySearchResultChanged(browser, query, r.size, params) }
            }
            return Futures.immediateFuture(LibraryResult.ofVoid())
        }

        override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            bg {
                val all = search[query] ?: lib.search(query).also { r -> main.post { search[query] = r } }
                val from = (page * pageSize).coerceAtMost(all.size)
                LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, (from + pageSize).coerceAtMost(all.size))), params)
            }

        /** Lo que llega para sonar: una canción de una lista (suena la lista desde ahí) o un pedido por voz. */
        override fun onSetMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, items: List<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
            bg {
                val one = items.singleOrNull()
                val voice = one?.requestMetadata?.searchQuery
                when {
                    one != null && one.mediaId.isEmpty() && !voice.isNullOrBlank() -> {
                        val r = lib.search(voice)
                        MediaSession.MediaItemsWithStartPosition(r, 0, C.TIME_UNSET)
                    }
                    one != null && one.mediaId.startsWith("s|") -> {
                        val (l, at) = lib.expand(one.mediaId) ?: (listOfNotNull(lib.resolve(one)) to 0)
                        MediaSession.MediaItemsWithStartPosition(l, at, startPositionMs)
                    }
                    else -> MediaSession.MediaItemsWithStartPosition(items.mapNotNull { lib.resolve(it) }, startIndex.coerceAtLeast(0), startPositionMs)
                }
            }

        override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, items: List<MediaItem>): ListenableFuture<List<MediaItem>> =
            bg { items.mapNotNull { lib.resolve(it) } }
    }
}
