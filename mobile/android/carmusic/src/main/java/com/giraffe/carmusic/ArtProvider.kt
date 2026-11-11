package com.giraffe.carmusic

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Las carátulas para Android Auto. El auto no puede pedirle imágenes al núcleo de Giraffe
 * (que solo escucha dentro del teléfono), así que las pide acá como content://…: se bajan una
 * vez por el núcleo y quedan guardadas en el caché de CarMusic.
 *
 * Solo entrega imágenes: las de YouTube (por el proxy de imágenes de Giraffe) y las carátulas
 * de las descargas. Nada más se puede pedir por acá.
 */
class ArtProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "com.giraffe.carmusic.art"

        /** content://…/a?u=<la carátula como la da la API> */
        fun uri(art: String?): Uri? {
            if (art.isNullOrEmpty()) return null
            return Uri.Builder().scheme("content").authority(AUTHORITY).path("a").appendQueryParameter("u", art).build()
        }
    }

    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val art = uri.getQueryParameter("u") ?: return null
        val path = when {
            art.startsWith("/api/img?") || art.startsWith("/api/dl/cover/") || art.startsWith("/api/cover/") -> art
            art.startsWith("https://") -> "/api/img?u=" + Uri.encode(art)
            else -> return null
        }
        val ctx = context ?: return null
        val dir = File(ctx.cacheDir, "art").apply { mkdirs() }
        val name = MessageDigest.getInstance("SHA-1").digest(path.toByteArray()).joinToString("") { "%02x".format(it) }
        val f = File(dir, name)
        if (!f.exists() || f.length() == 0L) {
            val c = URL(Bridge.url(path)).openConnection() as HttpURLConnection
            c.connectTimeout = 4000
            c.readTimeout = 15000
            try {
                if (c.responseCode != 200) return null
                val tmp = File(dir, "$name.tmp")
                c.inputStream.use { i -> tmp.outputStream().use { i.copyTo(it) } }
                tmp.renameTo(f)
            } finally {
                c.disconnect()
            }
            // Que el caché de carátulas no crezca sin límite (las más viejas se van).
            val all = dir.listFiles()?.sortedBy { it.lastModified() } ?: emptyList()
            if (all.size > 400) all.take(all.size - 400).forEach { it.delete() }
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri) = "image/*"
    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
