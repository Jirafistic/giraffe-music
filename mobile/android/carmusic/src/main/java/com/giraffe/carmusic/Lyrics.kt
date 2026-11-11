package com.giraffe.carmusic

import org.json.JSONObject

/** La letra sincronizada de una canción: (milisegundo, verso). Vacía si no hay. */
object Lyrics {
    private val cache = object : LinkedHashMap<String, List<Pair<Long, String>>>(16, .75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, List<Pair<Long, String>>>) = size > 30
    }

    fun get(vid: String, title: String, artist: String, album: String, dur: Int): List<Pair<Long, String>> {
        synchronized(cache) { cache[vid]?.let { return it } }
        val q = "id=${Bridge.enc(vid)}&title=${Bridge.enc(title)}&artist=${Bridge.enc(artist)}&album=${Bridge.enc(album)}&duration=$dur"
        val lines = runCatching { parse(JSONObject(Bridge.http("/api/lyrics?$q", timeout = 12000)).optString("synced")) }.getOrDefault(emptyList())
        synchronized(cache) { cache[vid] = lines }
        return lines
    }

    private val TAG = Regex("""\[(\d+):(\d+(?:\.\d+)?)]""")

    fun parse(lrc: String?): List<Pair<Long, String>> {
        if (lrc.isNullOrBlank() || lrc == "null") return emptyList()
        val out = mutableListOf<Pair<Long, String>>()
        for (raw in lrc.lines()) {
            val tags = TAG.findAll(raw).toList()
            if (tags.isEmpty()) continue
            val text = raw.substring(tags.last().range.last + 1).trim()
            for (t in tags) {
                val ms = (t.groupValues[1].toLong() * 60_000 + (t.groupValues[2].toDouble() * 1000).toLong())
                out += ms to text
            }
        }
        return out.sortedBy { it.first }
    }

    /** El verso que suena en `pos` (índice), o -1 antes del primero. */
    fun at(lines: List<Pair<Long, String>>, pos: Long): Int {
        var lo = 0
        var hi = lines.size - 1
        var ans = -1
        while (lo <= hi) {
            val mid = (lo + hi) / 2
            if (lines[mid].first <= pos) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }
}
