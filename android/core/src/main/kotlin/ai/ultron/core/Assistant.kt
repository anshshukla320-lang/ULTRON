package ai.ultron.core

import com.anthropic.models.messages.MessageParam

/** What the user set up in the app. */
data class AssistantConfig(
    /** e.g. https://my-pc.tailnet.ts.net or http://192.168.1.20:3000; blank = no PC. */
    val pcUrl: String = "",
    val pcPassword: String = "",
    /** Anthropic API key for the phone's own brain; blank = PC only. */
    val apiKey: String = "",
) {
    val hasPc get() = pcUrl.isNotBlank() && pcPassword.isNotBlank()
    val hasOwnBrain get() = apiKey.isNotBlank()
}

/**
 * ULTRON on the phone: sends each request to the PC when it's reachable (the
 * full ULTRON, with the phone's abilities added), and thinks on its own when
 * it isn't. One conversation carries across a switch.
 */
class Assistant(
    private val config: () -> AssistantConfig,
    private val toolbox: PhoneToolbox,
    private val memory: MemoryStore,
    private val cookies: CookieStore,
    private val pcFactory: (AssistantConfig, CookieStore) -> PcBrain = { c, k -> PcBrain(c.pcUrl, c.pcPassword, k) },
    private val phoneFactory: (AssistantConfig) -> PhoneBrain = { c -> PhoneBrain(c.apiKey) },
    private val clock: () -> Long = System::currentTimeMillis,
    private val tools: List<ToolSpec> = PhoneTools.all,
) {
    private var pc: PcBrain? = null
    private var pcKey: AssistantConfig? = null
    private var phone: PhoneBrain? = null
    private var phoneKey: String? = null

    private var pcHistory = mutableListOf<Any?>()
    private var phoneHistory = mutableListOf<MessageParam>()
    /** Plain text of the conversation, for carrying it across a brain switch. */
    private val transcript = mutableListOf<Pair<String, String>>()
    private var historyBrain: Brain? = null

    private var pcOkAt = 0L
    private var pcDownAt = 0L
    private var lastSyncAt = 0L

    /** Which brain answered last. */
    var lastBrain: Brain? = null
        private set

    private fun pcBrain(c: AssistantConfig): PcBrain {
        if (pc == null || pcKey != c) {
            pc = pcFactory(c, cookies)
            pcKey = c
            pcOkAt = 0
            pcDownAt = 0
        }
        return pc!!
    }

    private fun phoneBrain(c: AssistantConfig): PhoneBrain {
        if (phone == null || phoneKey != c.apiKey) {
            phone = phoneFactory(c)
            phoneKey = c.apiKey
        }
        return phone!!
    }

    /** Checks the PC (briefly) unless it was seen recently; syncs memory while at it. */
    fun pcReachable(): Boolean {
        val c = config()
        if (!c.hasPc) return false
        val now = clock()
        if (now - pcOkAt < PC_OK_FOR_MS) return true
        if (now - pcDownAt < PC_RETRY_AFTER_MS) return false
        return try {
            val brain = pcBrain(c)
            val facts = brain.fetchFacts()
            memory.setFacts(facts)
            val pending = memory.pendingFacts()
            if (pending.isNotEmpty()) {
                brain.pushFacts(pending)
                memory.clearPendingFacts(pending)
                memory.setFacts((facts + pending).distinct())
            }
            lastSyncAt = now
            pcOkAt = now
            true
        } catch (e: PcUnavailable) {
            pcDownAt = now
            false
        }
    }

    /** A pure phone tool call, with the on-screen confirmation for calls and texts. */
    private fun runTool(ui: AssistantUi, name: String, input: Map<String, Any?>): ToolResult {
        val spec = tools.firstOrNull { it.name == name } ?: return ToolResult("There is no phone tool called \"$name\".", true)
        if (name == "phone_remember") {
            val fact = input["fact"]?.toString()?.trim().orEmpty()
            if (fact.isEmpty()) return ToolResult("Nothing to remember.", true)
            memory.addPendingFact(fact)
            memory.setFacts((memory.facts() + fact).distinct())
            ui.onAction("remembered", true)
            return ToolResult("Remembered.")
        }
        if (spec.confirm) {
            val (title, detail) = when (name) {
                "phone_call" -> "Call ${input["who"]}?" to ""
                else -> "Allow ${name.removePrefix("phone_").replace('_', ' ')}?" to input.toString()
            }
            if (!ui.confirm(title, detail)) {
                ui.onAction("${name.removePrefix("phone_").replace('_', ' ')} declined", false)
                return ToolResult("The user declined.", true)
            }
        }
        val result = try {
            toolbox.run(name, input)
        } catch (e: Exception) {
            ToolResult(e.message ?: e.toString(), true)
        }
        ui.onAction(name.removePrefix("phone_").replace('_', ' '), !result.isError)
        return result
    }

    /** Starts the next brain's history from the plain conversation so far. */
    private fun carryOver(to: Brain) {
        if (historyBrain == to) return
        val recent = transcript.takeLast(CARRY_TURNS)
        when (to) {
            Brain.PC -> {
                pcHistory = recent.flatMap { (u, a) -> listOf(mapOf("role" to "user", "content" to u), mapOf("role" to "assistant", "content" to a.ifBlank { "(no reply)" })) }.toMutableList()
            }
            Brain.PHONE -> {
                phoneHistory = recent.flatMap { (u, a) ->
                    listOf(
                        MessageParam.builder().role(MessageParam.Role.USER).content(u).build(),
                        MessageParam.builder().role(MessageParam.Role.ASSISTANT).content(a.ifBlank { "(no reply)" }).build(),
                    )
                }.toMutableList()
            }
        }
        historyBrain = to
    }

    /** One thing the user said. Returns the spoken reply (already streamed to the UI). */
    fun ask(text: String, ui: AssistantUi): String {
        val c = config()
        if (!c.hasPc && !c.hasOwnBrain) throw SetupProblem("Open settings and add your PC's address and password, or an Anthropic API key.")
        var reply: String? = null
        var answeredBy: Brain? = null
        if (pcReachable()) {
            carryOver(Brain.PC)
            ui.onBrain(Brain.PC)
            val streamed = StringBuilder()
            val tracking = object : AssistantUi by ui {
                override fun onText(delta: String) {
                    streamed.append(delta)
                    ui.onText(delta)
                }
            }
            val saved = pcHistory.toMutableList()
            try {
                reply = pcBrain(c).turn(pcHistory, text, tools.filterNot { it.phoneBrainOnly }, { n, i -> runTool(ui, n, i) }, tracking)
                answeredBy = Brain.PC
            } catch (e: PcUnavailable) {
                pcOkAt = 0
                pcDownAt = clock()
                pcHistory = saved
                // Nothing said yet: the phone can take over this very request.
                if (streamed.isNotEmpty() || !c.hasOwnBrain) throw e
            }
        }
        if (reply == null) {
            if (!c.hasOwnBrain) throw SetupProblem(if (c.hasPc) "I can't reach the PC right now, sir, and there's no API key set for the phone to think on its own." else "Add an Anthropic API key in settings.")
            carryOver(Brain.PHONE)
            ui.onBrain(Brain.PHONE)
            reply = phoneBrain(c).turn(phoneHistory, text, memory.facts(), tools, { n, i -> runTool(ui, n, i) }, ui)
            answeredBy = Brain.PHONE
        }
        lastBrain = answeredBy
        transcript += text to reply!!
        return reply
    }

    fun cancel() {
        pc?.cancel()
        phone?.cancel()
    }

    /** Ends the conversation; the PC remembers it (whichever brain answered). */
    fun newConversation() {
        val turns = transcript.toList()
        transcript.clear()
        pcHistory = mutableListOf()
        phoneHistory = mutableListOf()
        historyBrain = null
        if (turns.isEmpty() || !pcReachable()) return
        try {
            pcBrain(config()).saveConversation(turns)
        } catch (_: Exception) {
            // not worth bothering the user about
        }
    }

    fun turnsSoFar(): Int = transcript.size

    companion object {
        private const val PC_OK_FOR_MS = 60_000L
        private const val PC_RETRY_AFTER_MS = 20_000L
        private const val CARRY_TURNS = 8
    }
}
