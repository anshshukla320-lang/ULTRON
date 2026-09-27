package ai.ultron.phone

import ai.ultron.core.Assistant
import ai.ultron.core.AssistantUi
import ai.ultron.core.Brain
import ai.ultron.core.Cancelled
import ai.ultron.core.PcUnavailable
import ai.ultron.core.SentenceChunker
import ai.ultron.core.SetupProblem
import ai.ultron.core.SpeechText
import ai.ultron.core.VoiceCommands
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity(), ActionHost {
    private lateinit var prefs: Prefs
    private lateinit var assistant: Assistant
    private lateinit var ears: Ears
    private lateinit var mouth: Mouth

    private lateinit var orb: OrbView
    private lateinit var status: TextView
    private lateinit var brainBadge: TextView
    private lateinit var log: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText

    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val busy = AtomicBoolean(false)
    /** The last request came by voice: after the reply, listen for a follow-up. */
    private var conversingByVoice = false
    private var replyView: TextView? = null
    private var pendingListen = false

    override val context: Context get() = this

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        assistant = Assistant({ prefs.config() }, PhoneActions(this, prefs), prefs, prefs)

        orb = findViewById(R.id.orb)
        status = findViewById(R.id.status)
        brainBadge = findViewById(R.id.brain)
        log = findViewById(R.id.log)
        scroll = findViewById(R.id.scroll)
        input = findViewById(R.id.input)

        ears = Ears(this, object : Ears.Events {
            override fun onListening() = setMode(OrbView.Mode.LISTENING, "LISTENING…")
            override fun onPartial(text: String) {
                status.text = text
            }
            override fun onHeard(text: String) = heard(text)
            override fun onNothing(error: String?) {
                if (error != null) addLine("ERR", error)
                idle()
            }
        })
        mouth = Mouth(this) { main.post(::speechFinished) }

        orb.setOnClickListener { orbTapped() }
        findViewById<TextView>(R.id.settings).setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        findViewById<TextView>(R.id.newChat).setOnClickListener { newConversation() }
        findViewById<TextView>(R.id.send).setOnClickListener { sendTyped() }
        input.setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_SEND) sendTyped()
            true
        }

        idle()
        if (!prefs.config().hasPc && !prefs.config().hasOwnBrain) {
            addLine("ULTRON", "Welcome, sir. Open settings (⚙) and add your PC's address and password, an Anthropic API key, or both.")
        }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** From the Quick Settings tile, the app shortcut, or the assist gesture. */
    private fun handleIntent(intent: Intent?) {
        val action = intent?.action
        if (action == ACTION_LISTEN || action == Intent.ACTION_ASSIST || intent?.getBooleanExtra(EXTRA_LISTEN, false) == true) {
            main.postDelayed({ startListening() }, 300)
        }
    }

    override fun onResume() {
        super.onResume()
        updateBrainBadge(assistant.lastBrain)
    }

    override fun onStop() {
        super.onStop()
        ears.stop()
        // Leaving the app ends the conversation; the PC remembers it.
        scheduleConversationEnd(delayMs = 60_000)
    }

    override fun onDestroy() {
        mouth.shutdown()
        ears.stop()
        worker.shutdownNow()
        super.onDestroy()
    }

    // ── Talking ──────────────────────────────────────────────────────────

    private fun orbTapped() {
        when {
            mouth.speaking || busy.get() -> {
                // Tap to interrupt, then speak again.
                interrupt()
                startListening()
            }
            ears.active -> {
                ears.stop()
                idle()
            }
            else -> startListening()
        }
    }

    private fun interrupt() {
        mouth.stop()
        assistant.cancel()
    }

    private fun startListening() {
        if (!ears.available) {
            addLine("ERR", "This phone has no speech recognition service (install or enable the Google app).")
            return
        }
        if (!hasPermissions(Manifest.permission.RECORD_AUDIO)) {
            pendingListen = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        mouth.stop()
        ears.listen()
    }

    private fun heard(text: String) {
        if (VoiceCommands.isStop(text)) {
            interrupt()
            conversingByVoice = false
            idle()
            return
        }
        conversingByVoice = true
        ask(VoiceCommands.stripWake(text).ifEmpty { text })
    }

    private fun sendTyped() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        input.setText("")
        conversingByVoice = false
        if (busy.get()) interrupt()
        ask(text)
    }

    private fun ask(text: String) {
        cancelConversationEnd()
        addLine("YOU", text)
        setMode(OrbView.Mode.THINKING, "THINKING…")
        replyView = null
        val chunker = SentenceChunker()
        busy.set(true)
        val ui = object : AssistantUi {
            override fun onBrain(brain: Brain) {
                main.post { updateBrainBadge(brain) }
            }
            override fun onText(delta: String) {
                main.post {
                    appendReply(delta)
                    if (prefs.speakReplies) chunker.push(delta).forEach(mouth::say)
                    setMode(OrbView.Mode.SPEAKING, "")
                }
            }
            override fun onAction(label: String, ok: Boolean) {
                main.post { addLine("ACT", if (ok) "✓ $label" else "✕ $label") }
            }
            override fun confirm(title: String, detail: String): Boolean = askOnScreen(title, detail)
        }
        worker.execute {
            var failure: String? = null
            try {
                assistant.ask(text, ui)
            } catch (_: Cancelled) {
                // the user interrupted
            } catch (e: SetupProblem) {
                failure = e.message
            } catch (e: PcUnavailable) {
                failure = "${e.message} Check that the PC is on and ULTRON is running, or add an API key so I can answer on my own."
            } catch (e: Exception) {
                failure = e.message ?: e.toString()
            }
            main.post {
                busy.set(false)
                val rest = chunker.flush()
                if (failure != null) {
                    addLine("ERR", failure!!)
                    if (prefs.speakReplies) mouth.say(failure!!)
                    setMode(OrbView.Mode.ERROR, "")
                } else if (rest.isNotEmpty() && prefs.speakReplies) {
                    mouth.say(rest)
                }
                if (!mouth.speaking) speechFinished()
                scheduleConversationEnd(delayMs = 3 * 60_000)
            }
        }
    }

    /** ULTRON finished speaking: keep the conversation going by voice. */
    private fun speechFinished() {
        if (busy.get()) return
        if (conversingByVoice && prefs.handsFree && !isFinishing) {
            startListening()
        } else {
            idle()
        }
    }

    // ── Screen ───────────────────────────────────────────────────────────

    private fun setMode(mode: OrbView.Mode, label: String) {
        orb.mode = mode
        if (label.isNotEmpty() || mode == OrbView.Mode.SPEAKING) status.text = label
    }

    private fun idle() {
        if (busy.get()) return
        setMode(OrbView.Mode.IDLE, "TAP THE ORB TO TALK")
    }

    private fun updateBrainBadge(brain: Brain?) {
        brainBadge.text = when (brain) {
            Brain.PC -> "● PC"
            Brain.PHONE -> "● PHONE"
            null -> ""
        }
        brainBadge.setTextColor(getColor(if (brain == Brain.PC) R.color.amber else R.color.muted))
    }

    private fun addLine(who: String, text: String): TextView {
        val tv = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(0, 10, 0, 10)
            setTextColor(getColor(if (who == "YOU") R.color.muted else if (who == "ERR") android.R.color.holo_red_light else R.color.text))
            this.text = if (who == "ULTRON" || who == "YOU") text else "$who  $text"
            if (who == "YOU") textAlignment = TextView.TEXT_ALIGNMENT_VIEW_END
        }
        log.addView(tv)
        while (log.childCount > 60) log.removeViewAt(0)
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
        return tv
    }

    private fun appendReply(delta: String) {
        val tv = replyView ?: addLine("ULTRON", "").also { replyView = it }
        tv.text = SpeechText.forDisplay(tv.text.toString() + delta)
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun newConversation() {
        interrupt()
        log.removeAllViews()
        worker.execute { assistant.newConversation() }
        addLine("ULTRON", "New conversation, sir.")
        idle()
    }

    private val endConversation = Runnable { worker.execute { if (assistant.turnsSoFar() > 0) assistant.newConversation() } }
    private fun scheduleConversationEnd(delayMs: Long) {
        main.removeCallbacks(endConversation)
        main.postDelayed(endConversation, delayMs)
    }
    private fun cancelConversationEnd() = main.removeCallbacks(endConversation)

    // ── ActionHost: things tools need from the screen ─────────────────────

    /** Yes/No on screen, waited for on the worker thread. */
    private fun askOnScreen(title: String, detail: String): Boolean {
        val latch = CountDownLatch(1)
        var answer = false
        main.post {
            AlertDialog.Builder(this)
                .setTitle(title)
                .apply { if (detail.isNotBlank()) setMessage(detail) }
                .setPositiveButton("Yes") { _, _ -> answer = true }
                .setNegativeButton("No", null)
                .setOnDismissListener { latch.countDown() }
                .show()
        }
        latch.await(2, TimeUnit.MINUTES)
        return answer
    }

    private var permissionLatch: CountDownLatch? = null

    override fun ensurePermissions(vararg permissions: String): Boolean {
        if (hasPermissions(*permissions)) return true
        val latch = CountDownLatch(1)
        permissionLatch = latch
        main.post { requestPermissions(arrayOf(*permissions), REQ_TOOL) }
        latch.await(2, TimeUnit.MINUTES)
        return hasPermissions(*permissions)
    }

    override fun startActivityOnUi(intent: Intent) {
        val latch = CountDownLatch(1)
        var error: Exception? = null
        main.post {
            try {
                startActivity(intent)
            } catch (e: Exception) {
                error = e
            }
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        error?.let { throw IllegalStateException("No app on the phone can do that.", it) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_MIC -> if (pendingListen && hasPermissions(Manifest.permission.RECORD_AUDIO)) {
                pendingListen = false
                startListening()
            }
            REQ_TOOL -> permissionLatch?.countDown()
        }
    }

    companion object {
        const val ACTION_LISTEN = "ai.ultron.phone.LISTEN"
        const val EXTRA_LISTEN = "listen"
        private const val REQ_MIC = 1
        private const val REQ_TOOL = 2
    }
}
