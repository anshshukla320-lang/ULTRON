package ai.ultron.phone

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** ULTRON's glowing orb: calm when idle, pulsing while it listens, spinning while it thinks. */
class OrbView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    enum class Mode { IDLE, LISTENING, THINKING, SPEAKING, ERROR }

    var mode = Mode.IDLE
        set(value) {
            field = value
            invalidate()
        }

    /** 0..1 — how loud the user is (listening) or how lively the reply is (speaking). */
    var level = 0f

    private var t = 0f
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val core = Paint(Paint.ANTI_ALIAS_FLAG)
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 4000
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            t = it.animatedFraction
            invalidate()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator.start()
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val r = min(width, height) * 0.30f
        val amber = if (mode == Mode.ERROR) Color.rgb(255, 80, 60) else Color.rgb(255, 170, 48)
        val phase = (t * 2 * PI).toFloat()
        val pulse = when (mode) {
            Mode.IDLE -> 0.03f * sin(phase)
            Mode.LISTENING -> 0.06f * sin(phase * 4) + 0.08f * level
            Mode.THINKING -> 0.02f * sin(phase * 8)
            Mode.SPEAKING -> 0.05f * sin(phase * 6) + 0.05f * level
            Mode.ERROR -> 0f
        }
        val rr = r * (1 + pulse)

        glow.shader = RadialGradient(cx, cy, rr * 1.8f, intArrayOf(Color.argb(90, 255, 154, 26), Color.argb(0, 255, 154, 26)), null, Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, rr * 1.8f, glow)

        ring.color = amber
        ring.strokeWidth = r * 0.12f
        canvas.drawCircle(cx, cy, rr, ring)
        ring.color = Color.argb(90, Color.red(amber), Color.green(amber), Color.blue(amber))
        ring.strokeWidth = r * 0.03f
        canvas.drawCircle(cx, cy, rr * 0.72f, ring)

        if (mode == Mode.THINKING || mode == Mode.LISTENING) {
            arc.color = Color.argb(200, 255, 221, 136)
            arc.strokeWidth = r * 0.05f
            val sweep = if (mode == Mode.THINKING) 90f else 40f
            val start = t * 360f * (if (mode == Mode.THINKING) 3 else 1)
            canvas.drawArc(cx - rr * 1.22f, cy - rr * 1.22f, cx + rr * 1.22f, cy + rr * 1.22f, start, sweep, false, arc)
            canvas.drawArc(cx - rr * 1.22f, cy - rr * 1.22f, cx + rr * 1.22f, cy + rr * 1.22f, start + 180, sweep, false, arc)
        }

        val coreR = r * 0.45f * (1 + pulse * 2)
        core.shader = RadialGradient(cx, cy, coreR, intArrayOf(Color.rgb(255, 221, 136), amber, Color.argb(0, 255, 122, 0)), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, coreR, core)
    }
}
