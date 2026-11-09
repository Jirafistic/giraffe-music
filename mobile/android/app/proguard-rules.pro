# Lo que llama JavaScript (WebView) y lo que llama Rust (JNI) no se puede renombrar.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.giraffe.music.Native { *; }
