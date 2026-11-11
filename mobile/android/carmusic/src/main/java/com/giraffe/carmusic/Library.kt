package com.giraffe.carmusic

import android.content.Context
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Lo que se ve en el auto (y en la pantalla del celular), armado con lo que da el núcleo de
 * Giraffe. Solo lo esencial:
 *
 *   Principal  → la selección rápida, "volver a escuchar" y tus mixes
 *   Biblioteca → Música que te gusta, tus playlists y álbumes
 *   Descargas  → lo que bajaste en Giraffe (o en CarMusic)
 *   + búsqueda (también por voz)
 *
 * Los ids: carpetas "home", "library", "downloads", "liked", "pl|ID", "al|ID"; canciones
 * "s|CARPETA|POSICIÓN|ID" (así, al tocar una, suena toda su lista desde ahí).
 */
class Library(private val ctx: Context) {
    companion object {
        const val ROOT = "root"
        // Cómo muestra Android Auto cada cosa: listas para canciones, cuadrícula para carpetas.
        private const val STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
        private const val STYLE_PLAYABLE = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
        private const val STYLE_BROWSABLE = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
        private const val GROUP = "android.media.browse.CONTENT_STYLE_GROUP_TITLE_HINT"
        private const val LIST = 1
        private const val GRID = 2

        fun rootExtras() = Bundle().apply {
            putBoolean(STYLE_SUPPORTED, true)
            putInt(STYLE_PLAYABLE, LIST)
            putInt(STYLE_BROWSABLE, GRID)
        }
    }

    /** Las canciones de cada carpeta abierta (para tocar una y que suene toda la lista). */
    private val lists = ConcurrentHashMap<String, List<JSONObject>>()
    private val titles = ConcurrentHashMap<String, String>()

    fun root(): MediaItem = folder(ROOT, ctx.getString(R.string.app_name), null)

    private fun res(name: String) = Uri.parse("android.resource://${ctx.packageName}/drawable/$name")

    private fun folder(id: String, title: String, art: Uri?, subtitle: String? = null, group: String? = null, grid: Boolean = true): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setArtist(subtitle)
                    .setArtworkUri(art)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS)
                    .setExtras(Bundle().apply {
                        if (group != null) putString(GROUP, group)
                        putInt(STYLE_PLAYABLE, LIST)
                        putInt(STYLE_BROWSABLE, if (grid) GRID else LIST)
                    })
                    .build()
            )
            .build()

    private fun artists(t: JSONObject): String {
        val a = t.optJSONArray("artists") ?: return t.optString("artist")
        return (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("name")?.takeIf(String::isNotEmpty) }.joinToString(", ")
    }

    /** Con Wi-Fi la mejor calidad; con datos móviles la normal (como "Automática" en Giraffe). */
    private fun quality(): String {
        val metered = (ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered
        return if (metered) "" else "?q=high"
    }

    fun song(t: JSONObject, parent: String, index: Int, group: String? = null): MediaItem {
        val vid = t.optString("id")
        val artist = artists(t)
        val album = t.optJSONObject("album")?.optString("name").orEmpty()
        return MediaItem.Builder()
            .setMediaId("s|$parent|$index|$vid")
            .setUri(Bridge.url("/api/stream/${Uri.encode(vid)}${quality()}"))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.optString("title"))
                    .setArtist(artist)
                    .setSubtitle(artist)
                    .setAlbumTitle(album)
                    .setArtworkUri(ArtProvider.uri(t.optString("art").ifEmpty { t.optString("thumb") }))
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .setExtras(Bundle().apply {
                        putString("vid", vid)
                        putString("artist", artist)
                        putString("album", album)
                        putInt("dur", t.optInt("duration"))
                        // Para poder descargarla tal cual desde el celular.
                        putString("json", t.toString())
                        putBoolean("dl", vid in downloaded)
                        if (group != null) putString(GROUP, group)
                    })
                    .build()
            )
            .build()
    }

    private fun tracksOf(a: JSONArray?): List<JSONObject> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }.filter { it.optString("id").isNotEmpty() }

    /** Lo que hay dentro de una carpeta (se llama en un hilo de fondo). */
    /** Las canciones ya descargadas (para marcarlas en las listas). */
    @Volatile private var downloaded: Set<String> = emptySet()

    private fun downloadedNow(): JSONArray {
        val a = runCatching { Bridge.json("/api/downloads").optJSONArray("items") }.getOrNull() ?: JSONArray()
        downloaded = (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optJSONObject("track")?.optString("id") }.toHashSet()
        return a
    }

    fun children(parent: String): List<MediaItem> {
        if (parent != ROOT && parent != "downloads") downloadedNow()
        return childrenOf(parent)
    }

    private fun childrenOf(parent: String): List<MediaItem> = when {
        parent == ROOT -> listOf(
            folder("home", ctx.getString(R.string.home), res("ic_home"), grid = false),
            folder("library", ctx.getString(R.string.library), res("ic_library"), grid = true),
            folder("downloads", ctx.getString(R.string.downloads), res("ic_download"), grid = false),
        )
        parent == "home" -> home()
        parent == "library" -> library()
        parent == "downloads" -> songs("downloads", downloadedNow().let { a ->
            tracksOf(JSONArray().also { out -> if (a != null) for (i in 0 until a.length()) a.optJSONObject(i)?.optJSONObject("track")?.let(out::put) })
        })
        parent == "liked" -> songs("liked", tracksOf(Bridge.json("/api/me/liked").optJSONArray("tracks")))
        parent.startsWith("pl|") -> songs(parent, playlist(parent.removePrefix("pl|")))
        parent.startsWith("al|") -> songs(parent, tracksOf(Bridge.json("/api/album/${Bridge.enc(parent.removePrefix("al|"))}").optJSONArray("tracks")))
        else -> emptyList()
    }

    private fun songs(parent: String, tracks: List<JSONObject>): List<MediaItem> {
        lists[parent] = tracks
        return tracks.mapIndexed { i, t -> song(t, parent, i) }
    }

    /** Una playlist entera (por páginas, hasta 1000 canciones). */
    private fun playlist(id: String): List<JSONObject> {
        val first = Bridge.json("/api/playlist/${Bridge.enc(id)}")
        val out = tracksOf(first.optJSONArray("tracks")).toMutableList()
        var token = first.optString("continuation").takeIf { it.isNotEmpty() && it != "null" }
        while (token != null && out.size < 1000) {
            val more = runCatching { Bridge.json("/api/playlist-more?token=${Bridge.enc(token!!)}") }.getOrNull() ?: break
            out += tracksOf(more.optJSONArray("tracks"))
            token = more.optString("continuation").takeIf { it.isNotEmpty() && it != "null" }
        }
        return out
    }

    /** Principal: canciones (selección rápida, volver a escuchar) y mixes/álbumes, por estante. */
    private fun home(): List<MediaItem> {
        val shelves = Bridge.json("/api/home").optJSONArray("shelves") ?: JSONArray()
        val playable = mutableListOf<JSONObject>()
        val out = mutableListOf<MediaItem>()
        for (s in 0 until shelves.length()) {
            val shelf = shelves.optJSONObject(s) ?: continue
            val title = shelf.optString("title")
            val items = shelf.optJSONArray("items") ?: continue
            for (i in 0 until minOf(items.length(), 20)) {
                val x = items.optJSONObject(i) ?: continue
                val track = if (shelf.optString("kind") == "songs") x else x.optJSONObject("track")
                if (track != null && track.optString("id").isNotEmpty()) {
                    out += song(track, "home", playable.size, title)
                    playable += track
                    continue
                }
                when (x.optString("kind")) {
                    "playlist" -> out += folder("pl|${x.optString("id")}", x.optString("title"), ArtProvider.uri(x.optString("thumb")), x.optString("subtitle"), title, grid = false)
                    "album" -> out += folder("al|${x.optString("id")}", x.optString("title"), ArtProvider.uri(x.optString("thumb")), x.optString("subtitle"), title, grid = false)
                }
            }
            if (out.size > 120) break
        }
        lists["home"] = playable
        return out
    }

    /** Biblioteca: Música que te gusta, tus playlists y álbumes. */
    private fun library(): List<MediaItem> {
        val out = mutableListOf(folder("liked", ctx.getString(R.string.liked), res("ic_like")))
        val lib = runCatching { Bridge.json("/api/me/library") }.getOrNull() ?: return out
        for (key in listOf("playlists", "albums")) {
            val a = lib.optJSONArray(key) ?: continue
            for (i in 0 until a.length()) {
                val x = a.optJSONObject(i) ?: continue
                val id = x.optString("id")
                if (id.isEmpty() || id == "LM" || id == "VLLM" || id == "SE") continue
                val prefix = if (key == "albums") "al|" else "pl|"
                out += folder(prefix + id, x.optString("title"), ArtProvider.uri(x.optString("thumb")), x.optString("subtitle"))
            }
        }
        return out
    }

    /** Búsqueda (también la de voz): lo que coincide por la letra primero, después las canciones. */
    /** Buscar: canciones (las que coinciden por letra primero) y después álbumes y playlists. */
    fun search(q: String): List<MediaItem> {
        downloadedNow()
        val all = java.util.concurrent.CompletableFuture.supplyAsync { runCatching { Bridge.json("/api/search?q=${Bridge.enc(q)}") }.getOrNull() }
        val only = runCatching { Bridge.json("/api/search?q=${Bridge.enc(q)}&filter=songs") }.getOrNull()
        val r = all.get() ?: JSONObject()
        val tracks = (tracksOf(r.optJSONArray("lyrics")) + tracksOf(only?.optJSONArray("songs")) + tracksOf(r.optJSONArray("songs"))).distinctBy { it.optString("id") }
        val parent = "q|$q"
        lists[parent] = tracks
        val songsT = ctx.getString(R.string.songs)
        val out = tracks.mapIndexed { i, t -> song(t, parent, i, songsT) }.toMutableList()
        for ((key, prefix, label) in listOf(Triple("albums", "al|", R.string.albums), Triple("playlists", "pl|", R.string.playlists))) {
            val a = r.optJSONArray(key) ?: continue
            for (i in 0 until a.length()) {
                val x = a.optJSONObject(i) ?: continue
                val id = x.optString("id")
                if (id.isEmpty()) continue
                out += folder(prefix + id, x.optString("title"), ArtProvider.uri(x.optString("thumb")), x.optString("subtitle"), ctx.getString(label), grid = false)
            }
        }
        return out
    }

    /**
     * Al tocar una canción: toda su lista, empezando por ella. Si la lista ya no está en
     * memoria (el auto reinició el servicio), se vuelve a pedir.
     */
    fun expand(mediaId: String): Pair<List<MediaItem>, Int>? {
        val p = mediaId.split('|')
        if (p.size < 4 || p[0] != "s") return null
        val parent = p.subList(1, p.size - 2).joinToString("|")
        val index = p[p.size - 2].toIntOrNull() ?: return null
        val list = lists[parent] ?: runCatching {
            if (parent.startsWith("q|")) search(parent.removePrefix("q|")) else children(parent)
            lists[parent]
        }.getOrNull() ?: return null
        if (list.isEmpty()) return null
        val vid = p.last()
        // Si la lista cambió, se busca la canción por su id.
        val at = if (index < list.size && list[index].optString("id") == vid) index else list.indexOfFirst { it.optString("id") == vid }.coerceAtLeast(0)
        return list.mapIndexed { i, t -> song(t, parent, i) } to at
    }

    /** Una canción sola, por su id (para las que llegan sin dirección desde un control). */
    fun resolve(item: MediaItem): MediaItem? {
        if (item.localConfiguration != null) return item
        val id = item.mediaId
        val p = id.split('|')
        if (p.size >= 4 && p[0] == "s") {
            expand(id)?.let { (l, at) -> return l.getOrNull(at) }
        }
        return null
    }
}
