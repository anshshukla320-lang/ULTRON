package ai.ultron.core

/**
 * Splits a streamed reply into whole sentences the moment each is complete,
 * so the phone can start speaking the first one while the rest is still
 * being written. Same rules as the PC page (lib/sentenceChunker.ts).
 */
class SentenceChunker {
    private val buffer = StringBuilder()

    fun push(delta: String): List<String> {
        buffer.append(delta)
        val text = buffer.toString()
        val out = mutableListOf<String>()
        var start = 0
        for (match in BOUNDARY.findAll(text)) {
            val end = match.range.last + 1
            if (insideLangTag(text.substring(0, end))) continue
            if (match.value.startsWith(".") && ABBREVIATION_BEFORE.containsMatchIn(text.substring(start, match.range.first))) continue
            val candidate = text.substring(start, end).trim()
            if (candidate.isNotEmpty()) out += candidate
            start = end
        }
        buffer.delete(0, start)
        return out
    }

    fun flush(): String {
        val rest = buffer.toString().trim()
        buffer.clear()
        return rest
    }

    private companion object {
        val BOUNDARY = Regex("""[.!?]+["')\]]*\s+|\n+""")
        val ABBREVIATION_BEFORE = Regex("""\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|approx|e\.g|i\.e|a\.m|p\.m)$""", RegexOption.IGNORE_CASE)
        val OPEN_TAG = Regex("""<lang\b[^>]*>""", RegexOption.IGNORE_CASE)
        val CLOSE_TAG = Regex("""</lang>""", RegexOption.IGNORE_CASE)
        val PARTIAL_TAG = Regex("""<[^>]*$""")

        fun insideLangTag(text: String) =
            OPEN_TAG.findAll(text).count() > CLOSE_TAG.findAll(text).count() || PARTIAL_TAG.containsMatchIn(text)
    }
}

/** A piece of a reply to speak, in a language when ULTRON marked one. */
data class SpeechSegment(val text: String, val lang: String?)

object SpeechText {
    private val LANG_TAG = Regex("""<lang\s+code=["']?([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)["']?\s*>([\s\S]*?)</lang>""", RegexOption.IGNORE_CASE)
    private val STRAY_TAG = Regex("""</?lang[^>]*>""", RegexOption.IGNORE_CASE)

    /** ULTRON marks foreign phrases <lang code="es">…</lang> for native voices. */
    fun segments(text: String): List<SpeechSegment> {
        val out = mutableListOf<SpeechSegment>()
        fun add(chunk: String, lang: String?) {
            val clean = chunk.replace(STRAY_TAG, "").replace(Regex("\\s+"), " ").trim()
            if (!clean.any { it.isLetterOrDigit() }) return
            val prev = out.lastOrNull()
            if (prev != null && prev.lang == lang) out[out.size - 1] = prev.copy(text = "${prev.text} $clean") else out += SpeechSegment(clean, lang)
        }
        var last = 0
        for (m in LANG_TAG.findAll(text)) {
            add(text.substring(last, m.range.first), null)
            val code = m.groupValues[1].replace('_', '-')
            add(m.groupValues[2], if (code.lowercase().startsWith("en")) null else code)
            last = m.range.last + 1
        }
        add(text.substring(last), null)
        return out
    }

    fun forDisplay(text: String): String = text.replace(LANG_TAG, "$2").replace(STRAY_TAG, "")
}

/** Voice commands handled on the phone without asking any brain. */
object VoiceCommands {
    private val STOP = Regex(
        """^(?:(?:hey|ok)[,]?\s+)?(?:(?:ultron|altron)[,]?\s+)?(?:stop|stop it|stop talking|quiet|be quiet|shut up|silence|never ?mind|cancel|cancel that|that'?s enough|enough)(?:\s+(?:please|now|ultron))?[.!]?$""",
        RegexOption.IGNORE_CASE,
    )
    private val LEADING_WAKE = Regex("""^\s*(?:(?:hey|ok)[,]?\s*)?(?:ultron|altron)\b[,.!]?\s*""", RegexOption.IGNORE_CASE)

    fun isStop(text: String) = STOP.matches(text.trim())
    fun stripWake(text: String) = text.replace(LEADING_WAKE, "").trim()
}
