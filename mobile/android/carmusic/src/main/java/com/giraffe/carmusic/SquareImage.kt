package com.giraffe.carmusic

import android.content.Context
import android.util.AttributeSet
import android.widget.ImageView

/** La carátula del reproductor: siempre cuadrada, del tamaño que entre (como en YouTube Music). */
class SquareImage(ctx: Context, attrs: AttributeSet?) : ImageView(ctx, attrs) {
    override fun onMeasure(w: Int, h: Int) {
        val ww = MeasureSpec.getSize(w)
        val hh = MeasureSpec.getSize(h)
        val side = when {
            MeasureSpec.getMode(h) == MeasureSpec.UNSPECIFIED -> ww
            MeasureSpec.getMode(w) == MeasureSpec.UNSPECIFIED -> hh
            else -> minOf(ww, hh)
        }
        setMeasuredDimension(side, side)
    }
}
