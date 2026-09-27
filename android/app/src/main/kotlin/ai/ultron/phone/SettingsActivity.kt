package ai.ultron.phone

import ai.ultron.core.InMemoryCookies
import ai.ultron.core.PcBrain
import android.app.Activity
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

        column.addView(note("Tip: add ULTRON to Quick Settings (pull down the shade → edit ✎) or long-press the app icon → \"Talk to ULTRON\" to start talking in one tap."))

        column.addView(button("SAVE") {
            prefs.pcUrl = url.text.toString()
            prefs.pcPassword = password.text.toString()
            prefs.apiKey = key.text.toString()
            prefs.handsFree = handsFree.isChecked
            prefs.speakReplies = speak.isChecked
            prefs.countryCode = country.text.toString()
            prefs.set(null) // new address or password: sign in again
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
