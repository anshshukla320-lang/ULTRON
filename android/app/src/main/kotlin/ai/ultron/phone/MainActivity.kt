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
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.WindowManager
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
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
    /** Listening quietly for "Hey ULTRON" (not a command yet). */
    private var wakeMode = false
    private var resumed = false
    private var askedMicForWake = false
    /** A photo taken with the camera button, waiting for the question about it. */
    private var pendingPhoto: ByteArray? = null
    private val background = Executors.newSingleThreadExecutor()

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
            override fun onListening() {
                if (!wakeMode) setMode(OrbView.Mode.LISTENING, if (pendingPhoto != null) "ASK ABOUT THE PHOTO…" else "LISTENING…")
            }
            override fun onPartial(text: String) {
                if (!wakeMode) status.text = text
            }
            override fun onHeard(text: String) = heard(text)
            override fun onNothing(error: String?) {
                if (wakeMode) {
                    // Silence or a hiccup while waiting for the wake word: go again.
                    wakeMode = false
                    idle(wakeDelayMs = if (error == null) 250 else 3_000)
                    return
                }
                pendingPhoto?.let { photo ->
                    pendingPhoto = null
                    conversingByVoice = true
                    ask("What's in this photo?", photo)
                    return
                }
                if (error != null) addLine("ERR", error)
                idle()
            }
        })
        mouth = Mouth(this) { main.post(::speechFinished) }

        orb.setOnClickListener { orbTapped() }
        findViewById<TextView>(R.id.settings).setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
        findViewById<TextView>(R.id.newChat).setOnClickListener { newConversation() }
        findViewById<TextView>(R.id.send).setOnClickListener { sendTyped() }
        findViewById<TextView>(R.id.camera).setOnClickListener { cameraTapped() }
        input.setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_SEND) sendTyped()
            true
        }

        idle()
        if (!prefs.config().hasPc && !prefs.config().hasOwnBrain) {
            addLine("ULTRON", "Welcome, sir. Open settings (⚙) and add your PC's address and password, an Anthropic API key, or both.")
        }
        Notices.ensureChannels(this)
        if (prefs.config().hasPc) {
            SyncJob.schedule(this)
            askForNotificationsOnce()
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
        resumed = true
        updateBrainBadge(assistant.lastBrain)
        registerReceiver(power, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        main.post(pollNotices)
        if (prefs.wakeWord && !askedMicForWake && !hasPermissions(Manifest.permission.RECORD_AUDIO)) {
            askedMicForWake = true // once: the prompt itself pauses and resumes the app
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }
        idle()
    }

    override fun onPause() {
        super.onPause()
        resumed = false
        runCatching { unregisterReceiver(power) }
        main.removeCallbacks(pollNotices)
        main.removeCallbacks(wakeListen)
        if (wakeMode) {
            wakeMode = false
            ears.stop()
        }
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
        background.shutdownNow()
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
            ears.active && !wakeMode -> {
                ears.stop()
                pendingPhoto = null
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
        main.removeCallbacks(wakeListen)
        wakeMode = false
        ears.listen()
    }

    private fun heard(text: String) {
        if (wakeMode) {
            wakeMode = false
            val rest = VoiceCommands.afterWake(text)
            when {
                rest == null -> idle() // not for ULTRON: keep waiting
                rest.isEmpty() -> {
                    conversingByVoice = true
                    startListening()
                }
                else -> {
                    conversingByVoice = true
                    ask(rest)
                }
            }
            return
        }
        pendingPhoto?.let { photo ->
            pendingPhoto = null
            conversingByVoice = true
            ask(VoiceCommands.stripWake(text).ifEmpty { "What's in this photo?" }, photo)
            return
        }
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
        if (ears.active) ears.stop()
        wakeMode = false
        val photo = pendingPhoto
        pendingPhoto = null
        ask(text, photo)
    }

    private fun ask(text: String, photo: ByteArray? = null) {
        cancelConversationEnd()
        addLine("YOU", if (photo != null) "📷 $text" else text)
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
                assistant.ask(text, ui, photo)
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

    private fun idle(wakeDelayMs: Long = 400) {
        if (busy.get()) return
        val waking = prefs.wakeWord && hasPermissions(Manifest.permission.RECORD_AUDIO)
        setMode(OrbView.Mode.IDLE, if (waking) "SAY \"HEY ULTRON\" OR TAP THE ORB" else "TAP THE ORB TO TALK")
        main.removeCallbacks(wakeListen)
        if (waking) main.postDelayed(wakeListen, wakeDelayMs)
    }

    /** Waits for "Hey ULTRON" while the app is open and nothing else is going on. */
    private val wakeListen = Runnable {
        if (!prefs.wakeWord || !resumed || busy.get() || mouth.speaking || ears.active || pendingPhoto != null) return@Runnable
        if (MeetingService.recording || !ears.available || !hasPermissions(Manifest.permission.RECORD_AUDIO)) return@Runnable
        wakeMode = true
        ears.listen(quiet = true)
    }

    /** Keeps the screen on while charging, so a phone on its stand keeps listening. */
    private val power = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            if (plugged && prefs.wakeWord && prefs.stayAwakeCharging) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    /** While the app is open: the PC's announcements appear (and are spoken) here instead of as notifications. */
    private val pollNotices = object : Runnable {
        override fun run() {
            main.removeCallbacks(this)
            if (!resumed) return
            if (prefs.config().hasPc) {
                background.execute {
                    val fresh = Sync.run(applicationContext, inApp = true)
                    if (fresh.isNotEmpty()) main.post {
                        fresh.forEach { addLine("ULTRON", it.text) }
                        if (prefs.speakReplies && !busy.get() && !mouth.speaking && (!ears.active || wakeMode)) {
                            if (wakeMode) {
                                wakeMode = false
                                ears.stop()
                            }
                            fresh.forEach { mouth.say(it.text) }
                        }
                    }
                }
            }
            main.postDelayed(this, 60_000)
        }
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

    private val endConversation = Runnable {
        if (busy.get()) return@Runnable // still in a turn (e.g. taking a photo): ask() reschedules
        worker.execute { if (assistant.turnsSoFar() > 0) assistant.newConversation() } }
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

    // ── Camera ────────────────────────────────────────────────────────────

    private fun cameraTapped() {
        if (busy.get() || mouth.speaking) interrupt()
        ears.stop()
        wakeMode = false
        Thread {
            val jpeg = try {
                takePhoto("Take a photo, then ask about it")
            } catch (e: Exception) {
                main.post { addLine("ERR", e.message ?: e.toString()) }
                null
            }
            main.post {
                if (jpeg == null) {
                    idle()
                } else {
                    // Then the question: "what is this?", "translate it", …
                    pendingPhoto = jpeg
                    addLine("ACT", "📷 Photo taken — ask about it, or type.")
                    if (hasPermissions(Manifest.permission.RECORD_AUDIO) && ears.available) startListening()
                    else status.text = "TYPE A QUESTION ABOUT THE PHOTO"
                }
            }
        }.start()
    }

    private var photoLatch: CountDownLatch? = null
    private var photoOk = false

    override fun takePhoto(why: String): ByteArray? {
        val dir = File(cacheDir, "photos").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val latch = CountDownLatch(1)
        photoLatch = latch
        photoOk = false
        var error: Exception? = null
        main.post {
            try {
                status.text = why.uppercase()
                startActivityForResult(intent, REQ_PHOTO)
            } catch (e: Exception) {
                error = e
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.MINUTES)
        error?.let { throw IllegalStateException("There's no camera app on this phone.", it) }
        if (!photoOk || !file.exists() || file.length() == 0L) return null
        return try {
            shrink(file)
        } finally {
            file.delete()
        }
    }

    /** Upright, at most 1568 px on the long side (what Claude sees at full detail), as JPEG. */
    private fun shrink(file: File): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_PHOTO_SIDE) sample *= 2
        var bmp = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalStateException("Couldn't read the photo.")
        val rotation = when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        val scale = minOf(1f, MAX_PHOTO_SIDE.toFloat() / maxOf(bmp.width, bmp.height))
        if (rotation != 0f || scale < 1f) {
            val m = Matrix().apply { postScale(scale, scale); postRotate(rotation) }
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        }
        return ByteArrayOutputStream().use { out ->
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
            out.toByteArray()
        }
    }

    // ── Health Connect ────────────────────────────────────────────────────

    private var healthLatch: CountDownLatch? = null

    override fun requestHealthAccess(): Boolean {
        if (!Health.available(this)) return false
        val latch = CountDownLatch(1)
        healthLatch = latch
        main.post {
            try {
                startActivityForResult(Health.permissionIntent(this), REQ_HEALTH)
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        latch.await(3, TimeUnit.MINUTES)
        return Health.granted(this)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_PHOTO -> {
                photoOk = resultCode == RESULT_OK
                photoLatch?.countDown()
            }
            REQ_HEALTH -> healthLatch?.countDown()
        }
    }

    // ── Notifications ─────────────────────────────────────────────────────

    private fun askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || Notices.canPost(this)) return
        val sp = getSharedPreferences("ultron", MODE_PRIVATE)
        if (sp.getBoolean("asked_notifications", false)) return
        sp.edit().putBoolean("asked_notifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_MIC -> if (pendingListen && hasPermissions(Manifest.permission.RECORD_AUDIO)) {
                pendingListen = false
                startListening()
            } else {
                idle()
            }
            REQ_TOOL -> permissionLatch?.countDown()
        }
    }

    companion object {
        const val ACTION_LISTEN = "ai.ultron.phone.LISTEN"
        const val EXTRA_LISTEN = "listen"
        private const val REQ_MIC = 1
        private const val REQ_TOOL = 2
        private const val REQ_PHOTO = 3
        private const val REQ_HEALTH = 4
        private const val REQ_NOTIFY = 5
        private const val MAX_PHOTO_SIDE = 1568
    }
}
