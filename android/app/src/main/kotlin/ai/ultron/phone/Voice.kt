package ai.ultron.phone

import ai.ultron.core.SpeechText
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/** Android's speech recogniser, one utterance at a time. Main thread only. */
class Ears(private val context: Context, private val events: Events) {
    interface Events {
        fun onListening()
        fun onPartial(text: String)
        fun onHeard(text: String)
        /** Nothing was said, or it couldn't be understood. */
        fun onNothing(error: String?)
    }

    private var recognizer: SpeechRecognizer? = null
    var active = false
        private set

    val available get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun listen() {
        stop()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = events.onListening()
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(events::onPartial)
            }
            override fun onResults(results: Bundle?) {
                active = false
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                if (text.isEmpty()) events.onNothing(null) else events.onHeard(text)
            }
            override fun onError(error: Int) {
                active = false
                events.onNothing(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> null
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is needed."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs a connection (or download offline speech in Google settings)."
                        else -> "Didn't catch that (error $error)."
                    },
                )
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        active = true
        r.startListening(intent)
    }

    fun stop() {
        active = false
        recognizer?.destroy()
        recognizer = null
    }
}

/** Speaks replies sentence by sentence, as they arrive. */
class Mouth(context: Context, private val onIdle: () -> Unit) {
    private var ready = false
    private val queued = mutableListOf<String>()
    private val pending = AtomicInteger(0)
    private var nextId = 0
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            pickVoice()
            queued.forEach(::say)
            queued.clear()
        }
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = finished()
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = finished()
            override fun onStop(utteranceId: String?, interrupted: Boolean) = finished()
        })
    }

    private fun finished() {
        if (pending.decrementAndGet() <= 0) {
            pending.set(0)
            onIdle()
        }
    }

    /** A deep British male voice if the phone has one — ULTRON's usual sound. */
    private fun pickVoice() {
        val voices: Set<Voice> = runCatching { tts.voices }.getOrNull().orEmpty()
        val gb = voices.filter { it.locale.language == "en" && it.locale.country == "GB" && !it.isNetworkConnectionRequired }
        val choice = gb.firstOrNull { it.name.contains("male", ignoreCase = true) && !it.name.contains("female", ignoreCase = true) }
            ?: gb.firstOrNull { Regex("en-gb-x-(rjs|gbd|gbb)").containsMatchIn(it.name) }
        if (choice != null) tts.voice = choice else tts.language = Locale.getDefault()
        tts.setSpeechRate(1.02f)
        tts.setPitch(0.9f)
    }

    val speaking get() = pending.get() > 0

    fun say(text: String) {
        val clean = SpeechText.segments(text).joinToString(" ") { it.text }
        if (clean.isBlank()) return
        if (!ready) {
            queued += clean
            return
        }
        pending.incrementAndGet()
        tts.speak(clean, TextToSpeech.QUEUE_ADD, null, "u${nextId++}")
    }

    fun stop() {
        queued.clear()
        pending.set(0)
        tts.stop()
    }

    fun shutdown() = tts.shutdown()
}
