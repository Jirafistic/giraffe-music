package com.giraffe.music

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Parcel

/**
 * El puente con Giraffe CarMusic. CarMusic no tiene núcleo propio: usa el de Giraffe, así
 * comparten la sesión de YouTube y las descargas (nada se baja ni se guarda dos veces).
 *
 * - Solo pueden conectarse apps firmadas con la misma llave (permiso "signature").
 * - Mientras CarMusic está conectado, Android mantiene vivo el núcleo de Giraffe; cuando se
 *   desconecta, el servicio se va y no queda nada corriendo.
 * - Pregunta 1 → el puerto del núcleo.
 */
class CarBridgeService : Service() {
    private var port = -1

    override fun onCreate() {
        super.onCreate()
        port = Native.start(filesDir.absolutePath)
    }

    override fun onBind(intent: Intent?): IBinder = object : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code == 1) {
                reply?.writeInt(port)
                return true
            }
            return super.onTransact(code, data, reply, flags)
        }
    }
}
