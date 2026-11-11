package com.giraffe.carmusic

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.RenderEffect
import android.graphics.Shader
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * La pantalla de CarMusic en el celular: mínima, con el estilo de YouTube Music. Navegar
 * (Principal, Biblioteca, Descargas, buscar), el mini reproductor y el reproductor con la
 * carátula difuminada de fondo, la letra que avanza y los controles. Mantener apretada una
 * canción, playlist o álbum la descarga; en ⋮ están la cuenta y los ajustes.
 *
 * Batería: no hay nada corriendo con la pantalla cerrada. El reproductor actualiza la barra
 * y la letra solo mientras se ve y suena; el fondo difuminado se calcula una vez por canción.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(2)
    private var browserF: ListenableFuture<MediaBrowser>? = null
    private var browser: MediaBrowser? = null
    private val stack = ArrayList<Pair<String, String>>() // (carpeta, título)
    private var rows: List<Any> = emptyList()  // MediaItem o String (título de estante)
    private var lines: List<Pair<Long, String>> = emptyList()
    private var lyricVid = ""
    private val prefs by lazy { getSharedPreferences("carmusic", Context.MODE_PRIVATE) }

    private lateinit var list: ListView
    private lateinit var title: TextView
    private lateinit var back: ImageButton
    private lateinit var searchBox: EditText
    private lateinit var loading: ProgressBar
    private lateinit var empty: TextView
    private lateinit var mini: View
    private lateinit var player: View
    private lateinit var seek: SeekBar
    private var dragging = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
        list = findViewById(R.id.list)
        title = findViewById(R.id.title)
        back = findViewById(R.id.back)
        searchBox = findViewById(R.id.searchBox)
        loading = findViewById(R.id.loading)
        empty = findViewById(R.id.empty)
        mini = findViewById(R.id.mini)
        player = findViewById(R.id.player)
        seek = findViewById(R.id.seek)

        // Respeta la barra de estado y la de navegación.
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars())
            findViewById<View>(R.id.browse).setPadding(0, b.top, 0, 0)
            findViewById<View>(R.id.playerBody).setPadding(dp(24), b.top, dp(24), b.bottom + dp(12))
            (mini.layoutParams as ViewGroup.MarginLayoutParams).bottomMargin = b.bottom + dp(10)
            ins
        }

        list.adapter = adapter
        list.setOnItemClickListener { _, _, pos, _ -> (rows.getOrNull(pos) as? MediaItem)?.let(::open) }
        back.setOnClickListener { goBack() }
        findViewById<View>(R.id.searchBtn).setOnClickListener { toggleSearch() }
        findViewById<View>(R.id.moreBtn).setOnClickListener(::menu)
        searchBox.setOnEditorActionListener { _, a, e ->
            if (a == EditorInfo.IME_ACTION_SEARCH || e?.keyCode == KeyEvent.KEYCODE_ENTER) { doSearch(searchBox.text.toString()); true } else false
        }
        mapOf(R.id.chipHome to ("home" to R.string.home), R.id.chipLib to ("library" to R.string.library), R.id.chipDl to ("downloads" to R.string.downloads))
            .forEach { (v, p) -> findViewById<View>(v).setOnClickListener { stack.clear(); push(p.first, getString(p.second)) } }

        mini.setOnClickListener { showPlayer(true) }
        findViewById<View>(R.id.miniPlay).setOnClickListener { toggle() }
        findViewById<View>(R.id.miniNext).setOnClickListener { browser?.seekToNext() }
        findViewById<View>(R.id.down).setOnClickListener { showPlayer(false) }
        findViewById<View>(R.id.play).setOnClickListener { toggle() }
        findViewById<View>(R.id.prev).setOnClickListener { browser?.seekToPrevious() }
        findViewById<View>(R.id.next).setOnClickListener { browser?.seekToNext() }
        findViewById<View>(R.id.shuffle).setOnClickListener { browser?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled } }
        findViewById<View>(R.id.repeat).setOnClickListener {
            browser?.let { it.repeatMode = when (it.repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF } }
        }
        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, p: Int, fromUser: Boolean) {
                if (fromUser) browser?.let { findViewById<TextView>(R.id.tPos).text = fmt(it.duration * p / 1000) }
            }
            override fun onStartTrackingTouch(s: SeekBar?) { dragging = true }
            override fun onStopTrackingTouch(s: SeekBar?) {
                dragging = false
                browser?.let { if (it.duration > 0) it.seekTo(it.duration * seek.progress / 1000) }
            }
        })
        layoutStage()

        Bridge.init(this)
        list.setOnItemLongClickListener { _, v, pos, _ -> (rows.getOrNull(pos) as? MediaItem)?.let { itemMenu(v, it) }; true }
        empty.setOnClickListener { if (account?.optBoolean("signedIn") == false) login() }
        if (!prefs.getBoolean("welcomed", false)) welcome()
        checkUpdate(false)
    }

    override fun onStart() {
        super.onStart()
        val f = MediaBrowser.Builder(this, SessionToken(this, ComponentName(this, CarService::class.java))).buildAsync()
        browserF = f
        f.addListener({
            val b = runCatching { f.get() }.getOrNull() ?: return@addListener
            browser = b
            b.addListener(listener)
            if (stack.isEmpty()) push("home", getString(R.string.home)) else load(stack.last().first)
            nowPlaying()
            refreshAccount()
        }, MoreExecutors.directExecutor().let { ex -> java.util.concurrent.Executor { main.post(it) } })
    }

    override fun onStop() {
        main.removeCallbacks(progress)
        browser?.removeListener(listener)
        browserF?.let { MediaBrowser.releaseFuture(it) }
        browser = null
        super.onStop()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            player.visibility == View.VISIBLE -> showPlayer(false)
            searchBox.visibility == View.VISIBLE -> toggleSearch()
            stack.size > 1 -> goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        layoutStage()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ------------------------------------------------------------------ navegar

    private fun push(id: String, name: String) {
        stack += id to name
        load(id)
    }

    private fun goBack() {
        if (stack.size > 1) { stack.removeAt(stack.size - 1); load(stack.last().first) }
    }

    private fun load(id: String) {
        val b = browser ?: return
        val atRoot = stack.size <= 1
        back.visibility = if (atRoot) View.GONE else View.VISIBLE
        title.text = if (atRoot) getString(R.string.app_name) else stack.last().second
        findViewById<View>(R.id.chips).visibility = if (atRoot) View.VISIBLE else View.GONE
        listOf(R.id.chipHome to "home", R.id.chipLib to "library", R.id.chipDl to "downloads").forEach { (v, cid) ->
            val on = stack.firstOrNull()?.first == cid
            findViewById<TextView>(v).apply {
                setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
                setTextColor(if (on) 0xFF030303.toInt() else 0xFFFFFFFF.toInt())
            }
        }
        show(emptyList(), true)
        val f = b.getChildren(id, 0, 1000, null)
        f.addListener({
            if (stack.lastOrNull()?.first != id) return@addListener
            show(runCatching { f.get().value?.toList() }.getOrNull() ?: emptyList(), false)
        }, { main.post(it) })
    }

    private fun doSearch(q: String) {
        val b = browser ?: return
        if (q.isBlank()) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(searchBox.windowToken, 0)
        stack.add("q|$q" to q)
        back.visibility = View.VISIBLE
        title.text = q
        findViewById<View>(R.id.chips).visibility = View.GONE
        show(emptyList(), true)
        val f = b.getSearchResult(q, 0, 100, null)
        f.addListener({ show(runCatching { f.get().value?.toList() }.getOrNull() ?: emptyList(), false) }, { main.post(it) })
    }

    private fun toggleSearch() {
        val on = searchBox.visibility != View.VISIBLE
        searchBox.visibility = if (on) View.VISIBLE else View.GONE
        val im = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        if (on) { searchBox.requestFocus(); im.showSoftInput(searchBox, 0) } else im.hideSoftInputFromWindow(searchBox.windowToken, 0)
    }

    /** Arma las filas, con el título de cada estante (como en Principal de YouTube Music). */
    private fun show(items: List<MediaItem>, busy: Boolean) {
        val out = ArrayList<Any>()
        var group: String? = null
        for (it in items) {
            val g = it.mediaMetadata.extras?.getString("android.media.browse.CONTENT_STYLE_GROUP_TITLE_HINT")
            if (g != null && g != group) { out += g; group = g }
            out += it
        }
        rows = out
        adapter.notifyDataSetChanged()
        loading.visibility = if (busy) View.VISIBLE else View.GONE
        empty.visibility = if (!busy && items.isEmpty()) View.VISIBLE else View.GONE
        val needsAccount = account?.optBoolean("signedIn") == false && stack.firstOrNull()?.first == "library"
        empty.text = getString(if (needsAccount) R.string.sign_in_hint else R.string.empty)
        if (busy) list.setSelection(0)
    }

    private fun open(item: MediaItem) {
        val md = item.mediaMetadata
        if (md.isBrowsable == true) return push(item.mediaId, md.title?.toString().orEmpty())
        val b = browser ?: return
        // Se manda solo la canción tocada: el reproductor arma toda su lista desde ahí.
        b.setMediaItem(item)
        b.prepare()
        b.play()
    }

    private val adapter = object : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(p: Int) = rows[p]
        override fun getItemId(p: Int) = p.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(p: Int) = if (rows[p] is String) 1 else 0
        override fun isEnabled(p: Int) = rows[p] !is String
        override fun getView(p: Int, convert: View?, parent: ViewGroup): View {
            val r = rows[p]
            if (r is String) {
                val v = (convert ?: layoutInflater.inflate(R.layout.header, parent, false)) as TextView
                v.text = r
                return v
            }
            val item = r as MediaItem
            val v = convert ?: layoutInflater.inflate(R.layout.row, parent, false)
            val md = item.mediaMetadata
            v.findViewById<TextView>(R.id.t1).text = md.title
            v.findViewById<TextView>(R.id.t2).text = md.extras?.getString("artist") ?: md.subtitle ?: md.artist
            v.findViewById<View>(R.id.dl).visibility = if (md.extras?.getBoolean("dl") == true) View.VISIBLE else View.GONE
            Img.load(v.findViewById(R.id.thumb), md.artworkUri, dp(56))
            return v
        }
    }

    // ------------------------------------------------------------------ reproducir

    private val listener = object : Player.Listener {
        override fun onEvents(p: Player, e: Player.Events) {
            if (e.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED, Player.EVENT_IS_PLAYING_CHANGED,
                    Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) nowPlaying()
        }
    }

    private fun toggle() {
        val b = browser ?: return
        if (b.isPlaying) b.pause() else { if (b.playbackState == Player.STATE_IDLE) b.prepare(); b.play() }
    }

    private fun nowPlaying() {
        val b = browser ?: return
        val item = b.currentMediaItem
        mini.visibility = if (item == null || player.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        if (item == null) { showPlayer(false); return }
        val md = item.mediaMetadata
        val artist = md.extras?.getString("artist") ?: md.artist?.toString().orEmpty()
        val playIc = if (b.isPlaying) R.drawable.ic_pause else R.drawable.ic_play
        findViewById<TextView>(R.id.miniTitle).text = md.title
        findViewById<TextView>(R.id.miniSub).text = artist
        findViewById<ImageButton>(R.id.miniPlay).setImageResource(playIc)
        findViewById<ImageButton>(R.id.play).setImageResource(playIc)
        findViewById<TextView>(R.id.pTitle).text = md.title
        findViewById<TextView>(R.id.pArtist).text = artist
        findViewById<ImageButton>(R.id.shuffle).alpha = if (b.shuffleModeEnabled) 1f else .5f
        findViewById<ImageButton>(R.id.repeat).apply {
            setImageResource(if (b.repeatMode == Player.REPEAT_MODE_ONE) R.drawable.ic_repeat_one else R.drawable.ic_repeat)
            alpha = if (b.repeatMode == Player.REPEAT_MODE_OFF) .5f else 1f
        }
        val vid = md.extras?.getString("vid").orEmpty()
        if (vid != lyricVid) {
            lyricVid = vid
            lines = emptyList()
            Img.load(findViewById(R.id.miniArt), md.artworkUri, dp(48))
            Img.load(findViewById(R.id.art), md.artworkUri, dp(420))
            // El fondo: la carátula difuminada (se calcula una vez por canción).
            Img.load(findViewById(R.id.blur), md.artworkUri, 24, blur = true)
            loadLyrics(md, vid)
        }
        tick()
    }

    private fun loadLyrics(md: MediaMetadata, vid: String) {
        renderLyric(-1)
        if (vid.isEmpty()) return
        val ex = md.extras ?: Bundle.EMPTY
        io.execute {
            val l = Lyrics.get(vid, md.title?.toString().orEmpty(), ex.getString("artist").orEmpty(), ex.getString("album").orEmpty(), ex.getInt("dur"))
            main.post { if (lyricVid == vid) { lines = l; tick() } }
        }
    }

    private var shownLine = -2
    private fun renderLyric(i: Int) {
        val box = findViewById<View>(R.id.lyr)
        box.visibility = if (lines.isEmpty()) View.GONE else View.VISIBLE
        if (i == shownLine && lines.isNotEmpty()) return
        shownLine = i
        findViewById<TextView>(R.id.lyrPrev).text = lines.getOrNull(i - 1)?.second.orEmpty()
        findViewById<TextView>(R.id.lyrCur).text = lines.getOrNull(i)?.second?.ifBlank { "♪" } ?: if (lines.isNotEmpty()) "♪" else ""
        findViewById<TextView>(R.id.lyrNext).text = lines.getOrNull(i + 1)?.second.orEmpty()
    }

    /** La barra y la letra: solo con el reproductor a la vista y sonando. */
    private val progress = Runnable { tick() }
    private fun tick() {
        main.removeCallbacks(progress)
        val b = browser ?: return
        if (player.visibility != View.VISIBLE) return
        val pos = b.currentPosition
        val dur = b.duration.takeIf { it > 0 } ?: 0
        if (!dragging) {
            seek.progress = if (dur > 0) (pos * 1000 / dur).toInt() else 0
            findViewById<TextView>(R.id.tPos).text = fmt(pos)
        }
        findViewById<TextView>(R.id.tDur).text = if (dur > 0) fmt(dur) else ""
        renderLyric(if (lines.isEmpty()) -1 else Lyrics.at(lines, pos))
        if (b.isPlaying) main.postDelayed(progress, 250)
    }

    private fun fmt(ms: Long): String {
        val s = ms / 1000
        return "%d:%02d".format(s / 60, s % 60)
    }

    private fun showPlayer(on: Boolean) {
        if (on && browser?.currentMediaItem == null) return
        player.visibility = if (on) View.VISIBLE else View.GONE
        // El mini reproductor flota (tiene sombra) y quedaría encima de los controles.
        mini.visibility = if (on || browser?.currentMediaItem == null) View.GONE else View.VISIBLE
        if (on) { player.alpha = 0f; player.translationY = dp(40).toFloat(); player.animate().alpha(1f).translationY(0f).setDuration(220).start() }
        tick()
    }

    /** Acostado (como la pantalla de un auto): carátula a la izquierda y letra a la derecha. */
    private fun layoutStage() {
        val wide = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val stage = findViewById<LinearLayout>(R.id.stage)
        val art = findViewById<View>(R.id.art)
        val lyr = findViewById<View>(R.id.lyr)
        stage.orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        art.layoutParams = LinearLayout.LayoutParams(if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT, if (wide) ViewGroup.LayoutParams.MATCH_PARENT else 0, 1f).apply { gravity = android.view.Gravity.CENTER }
        lyr.layoutParams = LinearLayout.LayoutParams(if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, if (wide) 1.2f else 0f).apply {
            if (wide) marginStart = dp(28)
        }
        stage.gravity = android.view.Gravity.CENTER
    }

    // ------------------------------------------------------------------ menú, bienvenida, Giraffe

    private fun menu(anchor: View) {
        val m = PopupMenu(this, anchor)
        val here = stack.lastOrNull()?.first.orEmpty()
        if (here.startsWith("pl|") || here.startsWith("al|") || here == "liked") m.menu.add(0, 5, 0, R.string.download_all)
        val acc = account
        if (acc?.optBoolean("signedIn") == true) {
            m.menu.add(0, 6, 1, getString(R.string.signed_as, acc.optString("name"))).isEnabled = false
            m.menu.add(0, 7, 2, R.string.sign_out)
        } else m.menu.add(0, 8, 1, R.string.sign_in)
        m.menu.add(0, 1, 3, R.string.lyrics_in_car).apply { isCheckable = true; isChecked = prefs.getBoolean("lyricsInCar", true) }
        m.menu.add(0, 2, 4, R.string.android_auto_help)
        m.menu.add(0, 3, 5, R.string.check_updates)
        if (Bridge.port > 0) m.menu.add(0, 9, 6, if (Bridge.linked) R.string.linked_on else R.string.linked_off).isEnabled = false
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> prefs.edit().putBoolean("lyricsInCar", !prefs.getBoolean("lyricsInCar", true)).apply()
                2 -> welcome()
                3 -> checkUpdate(true)
                5 -> downloadAll(here)
                7 -> io.execute { runCatching { Bridge.http("/api/logout", "POST") }; refreshAccount(reload = true) }
                8 -> login()
            }
            true
        }
        m.show()
    }

    // ------------------------------------------------------------------ cuenta

    @Volatile private var account: JSONObject? = null

    private fun refreshAccount(reload: Boolean = false) {
        io.execute {
            val a = runCatching { Bridge.json("/api/account") }.getOrNull() ?: return@execute
            main.post {
                val was = account
                val changed = if (was == null) !a.optBoolean("signedIn") else was.optBoolean("signedIn") != a.optBoolean("signedIn")
                account = a
                if ((reload || changed) && stack.isNotEmpty()) load(stack.last().first)
            }
        }
    }

    private fun login() {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(this, LoginActivity::class.java), 41)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        val cookie = data?.getStringExtra("cookie")
        if (requestCode != 41 || resultCode != RESULT_OK || cookie == null) return
        io.execute {
            val ok = runCatching { Bridge.http("/api/login", "POST", JSONObject().put("cookie", cookie).toString(), timeout = 30000) }.isSuccess
            if (!ok) main.post { Toast.makeText(this, R.string.error, Toast.LENGTH_SHORT).show() }
            refreshAccount(reload = true)
        }
    }

    // ------------------------------------------------------------------ descargas

    /** Mantener apretado: descargar (o quitar) una canción, o bajar una playlist o álbum entero. */
    private fun itemMenu(anchor: View, item: MediaItem) {
        val md = item.mediaMetadata
        val m = PopupMenu(this, anchor)
        if (md.isBrowsable == true) {
            if (!(item.mediaId.startsWith("pl|") || item.mediaId.startsWith("al|") || item.mediaId == "liked")) return
            m.menu.add(0, 1, 0, R.string.download_all)
        } else if (md.extras?.getBoolean("dl") == true) m.menu.add(0, 2, 0, R.string.remove_download)
        else m.menu.add(0, 3, 0, R.string.download)
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> downloadAll(item.mediaId)
                2 -> io.execute {
                    runCatching { Downloads.remove(md.extras?.getString("vid").orEmpty()) }
                    main.post { stack.lastOrNull()?.let { s -> load(s.first) } }
                }
                3 -> md.extras?.getString("json")?.let { j -> download(JSONArray().put(JSONObject(j))) }
            }
            true
        }
        m.show()
    }

    private fun downloadAll(folder: String) {
        val b = browser ?: return
        val f = b.getChildren(folder, 0, 1000, null)
        f.addListener({
            val items = runCatching { f.get().value?.toList() }.getOrNull() ?: emptyList()
            val a = JSONArray()
            items.forEach { i -> if (i.mediaMetadata.extras?.getBoolean("dl") != true) i.mediaMetadata.extras?.getString("json")?.let { a.put(JSONObject(it)) } }
            download(a)
        }, { main.post(it) })
    }

    private fun download(tracks: JSONArray) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7)
        }
        Toast.makeText(this, R.string.download_queued, Toast.LENGTH_SHORT).show()
        if (tracks.length() == 0) return
        // La notificación se arranca acá, con la app a la vista (Android no deja hacerlo desde el fondo).
        io.execute { runCatching { Downloads.add(applicationContext, tracks) } }
    }

    private fun welcome() {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(R.string.welcome_title)
            .setMessage(R.string.welcome_body)
            .setPositiveButton(R.string.got_it) { _, _ -> prefs.edit().putBoolean("welcomed", true).apply() }
            .setNeutralButton(R.string.open_auto) { _, _ ->
                prefs.edit().putBoolean("welcomed", true).apply()
                val auto = packageManager.getLaunchIntentForPackage("com.google.android.projection.gearhead")
                runCatching { startActivity(auto ?: Intent(android.provider.Settings.ACTION_SETTINGS)) }
            }
            .show()
    }

    // ------------------------------------------------------------------ actualizaciones (GitHub)

    /** Una vez por día (o al pedirla): el APK "giraffe-carmusic-X.Y.apk" del último release. */
    private fun checkUpdate(manual: Boolean) {
        if (BuildConfig.UPDATE_REPO.isEmpty()) return
        val now = System.currentTimeMillis()
        if (!manual && now - prefs.getLong("updChecked", 0) < 86_400_000) return
        prefs.edit().putLong("updChecked", now).apply()
        io.execute {
            val found = runCatching {
                val c = URL("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest").openConnection() as HttpURLConnection
                c.setRequestProperty("Accept", "application/vnd.github+json")
                c.connectTimeout = 10000; c.readTimeout = 15000
                val rel = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
                val assets = rel.getJSONArray("assets")
                val re = Regex("""giraffe-carmusic-([\d.]+)\.apk""")
                (0 until assets.length()).map { assets.getJSONObject(it) }.firstNotNullOfOrNull { a ->
                    re.matchEntire(a.optString("name"))?.let { it.groupValues[1] to a.optString("browser_download_url") }
                }
            }.getOrNull()
            main.post {
                if (found != null && newer(found.first, BuildConfig.VERSION_NAME)) offerUpdate(found.first, found.second)
                else if (manual) Toast.makeText(this, R.string.latest, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun newer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return false
    }

    private fun offerUpdate(ver: String, url: String) {
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(getString(R.string.update_available))
            .setMessage("Giraffe CarMusic $ver")
            .setNegativeButton(R.string.later, null)
            .setPositiveButton(R.string.update) { _, _ ->
                if (!packageManager.canRequestPackageInstalls()) {
                    runCatching { startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                    return@setPositiveButton
                }
                val t = Toast.makeText(this, "…", Toast.LENGTH_LONG).also { it.show() }
                io.execute {
                    runCatching {
                        val apk = Updater.download(this, url) {}
                        Updater.install(this, apk)
                    }.onFailure { main.post { t.cancel(); Toast.makeText(this, R.string.error, Toast.LENGTH_SHORT).show() } }
                }
            }
            .show()
    }
}

/**
 * Imágenes chicas y en memoria (sin librerías): se bajan una vez por el proveedor de
 * carátulas y se reducen al tamaño que se muestra. El fondo difuminado sale de una versión
 * diminuta de la carátula, estirada (en Android 12+ además con el difuminado de la GPU).
 */
object Img {
    private val cache = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pool = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())

    fun load(v: ImageView, uri: Uri?, px: Int, blur: Boolean = false) {
        val key = "$uri@$px"
        v.tag = key
        if (uri == null) { v.setImageDrawable(null); return }
        // Íconos propios (Principal, Biblioteca, Descargas…).
        if (uri.scheme == "android.resource") {
            val id = v.context.resources.getIdentifier(uri.lastPathSegment, "drawable", v.context.packageName)
            v.scaleType = ImageView.ScaleType.CENTER
            v.setImageResource(id)
            return
        }
        if (!blur) v.scaleType = ImageView.ScaleType.CENTER_CROP
        cache.get(key)?.let { set(v, it, blur); return }
        if (!blur) v.setImageDrawable(null)
        val ctx = v.context.applicationContext
        pool.execute {
            val bmp = runCatching { decode(ctx, uri, px) }.getOrNull() ?: return@execute
            cache.put(key, bmp)
            main.post { if (v.tag == key) set(v, bmp, blur) }
        }
    }

    private fun set(v: ImageView, b: Bitmap, blur: Boolean) {
        v.setImageBitmap(b)
        if (blur && Build.VERSION.SDK_INT >= 31) v.setRenderEffect(RenderEffect.createBlurEffect(40f, 40f, Shader.TileMode.CLAMP))
    }

    private fun decode(ctx: Context, uri: Uri, px: Int): Bitmap? {
        val cr = ctx.contentResolver
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, o) }
        var s = 1
        while (o.outWidth / (s * 2) >= px && o.outHeight / (s * 2) >= px) s *= 2
        val b = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = s }) } ?: return null
        if (b.width <= px * 2) return b
        val w = px
        val h = (b.height * px.toFloat() / b.width).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(b, w, h, true)
    }
}
