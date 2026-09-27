package ai.ultron.phone

import ai.ultron.core.InMemoryCookies
import ai.ultron.core.PcBrain
import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import java.util.concurrent.Executors

/** Where the PC is, its password, the phone's own API key, and a few switches. */
class SettingsActivity : Activity() {
    private lateinit var prefs: Prefs
    private val worker = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = dp(20)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        setContentView(ScrollView(this).apply { fitsSystemWindows = true; addView(column) })

        column.addView(heading("ULTRON ON YOUR PC"))
        column.addView(note("The full ULTRON — memory, smart home, email, your computer. Use your Tailscale address (https://…ts.net) to reach it from anywhere, or http://<PC's IP>:3000 at home."))
        val url = field(column, "PC address", prefs.pcUrl, InputType.TYPE_TEXT_VARIATION_URI)
        val password = field(column, "ULTRON password", prefs.pcPassword, InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val result = note("")
        column.addView(button("TEST CONNECTION") {
            val u = url.text.toString()
            val p = password.text.toString()
            result.text = "Checking…"
            worker.execute {
                val msg = try {
                    val facts = PcBrain(u, p, InMemoryCookies()).fetchFacts()
                    "✓ Connected. ULTRON on the PC knows ${facts.size} thing${if (facts.size == 1) "" else "s"} about you."
                } catch (e: Exception) {
                    "✕ ${e.message}"
                }
                runOnUiThread { result.text = msg }
            }
        })
        column.addView(result)

        column.addView(heading("THE PHONE'S OWN BRAIN"))
        column.addView(note("When the PC can't be reached, the phone talks to Claude directly with this key (console.anthropic.com → API keys). Leave empty to use the PC only. Stored encrypted on this phone."))
        val key = field(column, "Anthropic API key", prefs.apiKey, InputType.TYPE_TEXT_VARIATION_PASSWORD)

        column.addView(heading("VOICE"))
        val handsFree = switch(column, "Keep listening after a reply", prefs.handsFree)
        val speak = switch(column, "Speak replies out loud", prefs.speakReplies)
        val country = field(column, "Country code for WhatsApp numbers", prefs.countryCode, InputType.TYPE_CLASS_NUMBER)

        val wake = switch(column, "Listen for \"Hey ULTRON\" while the app is open", prefs.wakeWord)
        val awake = switch(column, "…and keep the screen on while charging", prefs.stayAwakeCharging)
        column.addView(note("With both on, a phone on its charger works like a smart speaker: leave ULTRON open and just say \"Hey ULTRON, …\"."))

        column.addView(heading("PERMISSIONS"))
        column.addView(note("Each is asked for the first time it's needed anyway; set them up here in one go if you like."))
        column.addView(button("ALLOW NOTIFICATIONS") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        })
        column.addView(note("Reminders, timers and alerts from ULTRON on your PC appear on the phone within ~15 minutes, even with the app closed."))
        column.addView(button("ALLOW LOCATION ALL THE TIME") {
            if (!hasPermissions(Manifest.permission.ACCESS_FINE_LOCATION)) {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 2)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 3)
            }
        })
        column.addView(note("For location triggers (\"when I get home, turn the lights on\"). Tap twice: first precise location, then \"Allow all the time\"."))
        val healthNote = note("")
        column.addView(button("ALLOW HEALTH DATA") {
            if (Health.available(this)) {
                @Suppress("DEPRECATION")
                startActivityForResult(Health.permissionIntent(this), 4)
            } else {
                runCatching { startActivity(Health.installIntent()) }.onFailure { healthNote.text = "Install Health Connect from the Play Store first." }
            }
        })
        column.addView(healthNote.apply { text = "Steps, sleep and heart rate from Health Connect (Google Fit, Samsung Health, Fitbit…), read only — for \"how did I sleep?\" and your morning briefing." })

        column.addView(note("Tip: add ULTRON to Quick Settings (pull down the shade → edit ✎) or long-press the app icon → \"Talk to ULTRON\" to start talking in one tap. There's a home-screen widget too (long-press the home screen → Widgets → ULTRON)."))

        column.addView(button("SAVE") {
            prefs.pcUrl = url.text.toString()
            prefs.pcPassword = password.text.toString()
            prefs.apiKey = key.text.toString()
            prefs.handsFree = handsFree.isChecked
            prefs.speakReplies = speak.isChecked
            prefs.countryCode = country.text.toString()
            prefs.wakeWord = wake.isChecked
            prefs.stayAwakeCharging = awake.isChecked
            prefs.set(null) // new address or password: sign in again
            if (prefs.config().hasPc) SyncJob.schedule(this)
            finish()
        })
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(getColor(R.color.amber))
        typeface = android.graphics.Typeface.MONOSPACE
        letterSpacing = 0.2f
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setPadding(0, dp(22), 0, dp(4))
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(getColor(R.color.muted))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setPadding(0, dp(4), 0, dp(6))
    }

    private fun field(parent: LinearLayout, label: String, value: String, variation: Int): EditText {
        parent.addView(note(label).apply { setTextColor(getColor(R.color.text)) })
        val e = EditText(this).apply {
            setText(value)
            inputType = if (variation == InputType.TYPE_CLASS_NUMBER) variation else InputType.TYPE_CLASS_TEXT or variation
            setTextColor(getColor(R.color.text))
            setSingleLine()
        }
        parent.addView(e)
        return e
    }

    private fun switch(parent: LinearLayout, label: String, value: Boolean): Switch {
        val s = Switch(this).apply {
            text = label
            isChecked = value
            setTextColor(getColor(R.color.text))
            setPadding(0, dp(8), 0, dp(8))
        }
        parent.addView(s)
        return s
    }

    private fun button(text: String, onClick: () -> Unit) = TextView(this).apply {
        this.text = text
        gravity = Gravity.CENTER
        setTextColor(getColor(R.color.amber))
        typeface = android.graphics.Typeface.MONOSPACE
        letterSpacing = 0.2f
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        setBackgroundResource(android.R.drawable.btn_default)
        background.setTint(getColor(R.color.bg))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
    }
}
