package com.giraffe.music

/** El núcleo de Giraffe Music en Rust (`libgiraffe.so`, hecho con el código de ytm-rs). */
object Native {
    init {
        System.loadLibrary("giraffe")
    }

    /** Arranca el servidor local en 127.0.0.1 (una vez por proceso) y devuelve su puerto, o -1. */
    external fun start(dataDir: String): Int
}
