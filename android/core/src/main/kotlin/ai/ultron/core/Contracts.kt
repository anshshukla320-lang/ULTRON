package ai.ultron.core

import java.io.IOException

/** Which brain answered: ULTRON on the PC, or the phone thinking on its own. */
enum class Brain { PC, PHONE }

/** What the Android app shows and asks while ULTRON works. */
interface AssistantUi {
    fun onBrain(brain: Brain) {}
    /** A piece of the spoken reply, as it streams in. */
    fun onText(delta: String) {}
    /** Something ULTRON did ("Texted Priya", "Turned the light off"). */
    fun onAction(label: String, ok: Boolean) {}
    /** Blocks until the user taps Yes or No on screen. */
    fun confirm(title: String, detail: String): Boolean
}

data class ToolResult(val text: String, val isError: Boolean = false)

/** Runs phone_* tools on the phone (implemented by the Android app). */
fun interface PhoneToolbox {
    fun run(name: String, input: Map<String, Any?>): ToolResult
}

/** What ULTRON knows about the user, kept on the phone for when the PC is away. */
interface MemoryStore {
    fun facts(): List<String>
    fun setFacts(facts: List<String>)
    /** Facts learned by the phone's brain, not yet sent to the PC. */
    fun pendingFacts(): List<String>
    fun addPendingFact(fact: String)
    fun clearPendingFacts(sent: List<String>)
}

class InMemoryStore : MemoryStore {
    private var facts = listOf<String>()
    private val pending = mutableListOf<String>()
    override fun facts() = facts
    override fun setFacts(facts: List<String>) { this.facts = facts }
    override fun pendingFacts() = pending.toList()
    override fun addPendingFact(fact: String) { pending += fact }
    override fun clearPendingFacts(sent: List<String>) { pending.removeAll(sent) }
}

/** Remembers the PC session cookie between app launches. */
interface CookieStore {
    fun get(): String?
    fun set(value: String?)
}

class InMemoryCookies : CookieStore {
    private var v: String? = null
    override fun get() = v
    override fun set(value: String?) { v = value }
}

/** The PC couldn't be reached (or answered with an error before saying anything). */
class PcUnavailable(message: String, cause: Throwable? = null) : IOException(message, cause)

/** Something the user needs to fix (wrong password, no API key…) — said out loud as is. */
class SetupProblem(message: String) : Exception(message)

class Cancelled : Exception("cancelled")
