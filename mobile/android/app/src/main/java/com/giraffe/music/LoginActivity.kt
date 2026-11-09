package com.giraffe.music

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * "Sign in with Google": la página de inicio de sesión normal de Google, como en
 * ytm-rs de escritorio (`login.rs`). Cuando termina en music.youtube.com, se toman las
 * cookies de esa sesión y se le pasan al núcleo, que las guarda en la carpeta privada.
 * La contraseña nunca pasa por Giraffe Music: la escribe el usuario en la página de Google.
 */
class LoginActivity : ComponentActivity() {
    private var done = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(Color.WHITE, Color.WHITE))
        super.onCreate(savedInstanceState)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        // Empezar de cero: una sesión vieja o a medias no se mezcla con la nueva.
        cookies.removeAllCookies(null)

        val web = WebView(this)
        setContentView(web)
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(0, bars.top, 0, bars.bottom)
            insets
        }
        cookies.setAcceptThirdPartyCookies(web, true)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // El navegador del teléfono, sin la marca de "WebView" ("; wv"), que Google rechaza.
            userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/[\\d.]+ "), "")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) = check(url)
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) = check(url)
        }
        web.loadUrl("https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F")
    }

    /** Ya en music.youtube.com y con la cookie de sesión (SAPISID): listo. */
    private fun check(url: String?) {
        if (done || url == null || !url.startsWith("https://music.youtube.com")) return
        val c = CookieManager.getInstance().getCookie("https://music.youtube.com") ?: return
        if (!c.contains("SAPISID=")) return
        done = true
        CookieManager.getInstance().flush()
        setResult(RESULT_OK, Intent().putExtra("cookie", c))
        finish()
    }
}
