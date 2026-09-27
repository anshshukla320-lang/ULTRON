package ai.ultron.core

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.core.http.StreamResponse
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.errors.UnauthorizedException
import com.anthropic.helpers.MessageAccumulator
import com.anthropic.models.messages.CacheControlEphemeral
import com.anthropic.models.messages.ContentBlockParam
import com.anthropic.models.messages.MessageCreateParams
import com.anthropic.models.messages.MessageParam
import com.anthropic.models.messages.OutputConfig
import com.anthropic.models.messages.RawMessageStreamEvent
import com.anthropic.models.messages.StopReason
import com.anthropic.models.messages.TextBlockParam
import com.anthropic.models.messages.Tool
import com.anthropic.models.messages.ToolResultBlockParam
import com.anthropic.models.messages.WebSearchTool20260209
import java.time.Duration
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

/**
 * The phone thinking on its own, for when the PC can't be reached: Claude
 * directly, with the phone's abilities and web search, and a copy of what
 * ULTRON on the PC knows about the user.
 */
class PhoneBrain(
    apiKey: String,
    baseUrl: String? = null,
    private val model: String = MODEL,
) {
    private val client: AnthropicClient = AnthropicOkHttpClient.builder()
        .apiKey(apiKey)
        .apply { if (baseUrl != null) baseUrl(baseUrl) }
        .timeout(Duration.ofSeconds(120))
        .maxRetries(2)
        .build()
    private val current = AtomicReference<StreamResponse<RawMessageStreamEvent>?>()
    @Volatile private var cancelled = false

    fun cancel() {
        cancelled = true
        current.get()?.close()
    }

    fun turn(
        history: MutableList<MessageParam>,
        userText: String,
        facts: List<String>,
        tools: List<ToolSpec>,
        runTool: (String, Map<String, Any?>) -> ToolResult,
        ui: AssistantUi,
        now: ZonedDateTime = ZonedDateTime.now(),
    ): String {
        cancelled = false
        history += MessageParam.builder().role(MessageParam.Role.USER).content(userText).build()
        val spoken = StringBuilder()
        for (step in 0 until MAX_STEPS) {
            val params = buildParams(history, facts, tools, now)
            val acc = MessageAccumulator.create()
            var firstDelta = true
            try {
                client.messages().createStreaming(params).use { stream ->
                    current.set(stream)
                    stream.stream().forEach { event ->
                        acc.accumulate(event)
                        event.contentBlockDelta().flatMap { it.delta().text() }.ifPresent { d ->
                            // Separate steps of one reply ("Setting it." … "Done.") need a space.
                            var t = d.text()
                            if (firstDelta && spoken.isNotEmpty() && !spoken.last().isWhitespace()) t = " $t"
                            firstDelta = false
                            spoken.append(t)
                            ui.onText(t)
                        }
                    }
                }
            } catch (e: UnauthorizedException) {
                throw SetupProblem("The Anthropic API key in the app's settings isn't valid.")
            } catch (e: AnthropicServiceException) {
                if (cancelled) throw Cancelled()
                throw e
            } catch (e: Exception) {
                if (cancelled) throw Cancelled()
                throw e
            } finally {
                current.set(null)
            }
            if (cancelled) throw Cancelled()
            val message = acc.message()
            history += message.toParam()

            when (message.stopReason().orElse(StopReason.END_TURN)) {
                StopReason.PAUSE_TURN -> continue // a long web search; carry on where it stopped
                StopReason.REFUSAL -> {
                    if (spoken.isBlank()) {
                        val sorry = "I can't help with that one, sir."
                        spoken.append(sorry)
                        ui.onText(sorry)
                    }
                    return spoken.toString().trim()
                }
                StopReason.TOOL_USE -> {
                    val results = message.content().mapNotNull { it.toolUse().orElse(null) }.map { use ->
                        @Suppress("UNCHECKED_CAST")
                        val input = (use._input().convert(Map::class.java) as? Map<String, Any?>) ?: emptyMap()
                        val r = if (tools.none { it.name == use.name() }) ToolResult("There is no tool named \"${use.name()}\".", true) else runTool(use.name(), input)
                        ContentBlockParam.ofToolResult(
                            ToolResultBlockParam.builder().toolUseId(use.id()).content(r.text).isError(r.isError).build(),
                        )
                    }
                    if (results.isEmpty()) return spoken.toString().trim()
                    history += MessageParam.builder().role(MessageParam.Role.USER).contentOfBlockParams(results).build()
                }
                else -> return spoken.toString().trim()
            }
        }
        val tooLong = " That's taking more steps than I'm allowed, sir."
        spoken.append(tooLong)
        ui.onText(tooLong)
        return spoken.toString().trim()
    }

    internal fun buildParams(history: List<MessageParam>, facts: List<String>, tools: List<ToolSpec>, now: ZonedDateTime): MessageCreateParams {
        val builder = MessageCreateParams.builder()
            .model(model)
            .maxTokens(8000L)
            // Spoken answers: quick beats exhaustive.
            .outputConfig(OutputConfig.builder().effort(OutputConfig.Effort.MEDIUM).build())
            .systemOfTextBlockParams(
                listOf(
                    // Fixed text first and cached; the per-request part after it.
                    TextBlockParam.builder().text(SYSTEM_PROMPT).cacheControl(CacheControlEphemeral.builder().build()).build(),
                    TextBlockParam.builder().text(dynamicPrompt(facts, now)).build(),
                ),
            )
            .messages(history)
            .addTool(WebSearchTool20260209.builder().maxUses(3L).build())
        tools.forEachIndexed { i, spec ->
            val props = Tool.InputSchema.Properties.builder()
            spec.properties.forEach { (k, v) -> props.putAdditionalProperty(k, JsonValue.from(v)) }
            val tool = Tool.builder()
                .name(spec.name)
                .description(spec.description)
                .inputSchema(Tool.InputSchema.builder().properties(props.build()).required(spec.required).build())
            // The tool list is the biggest fixed part of every request: cache it.
            if (i == tools.lastIndex) tool.cacheControl(CacheControlEphemeral.builder().build())
            builder.addTool(tool.build())
        }
        return builder.build()
    }

    companion object {
        const val MODEL = "claude-sonnet-5"
        private const val MAX_STEPS = 8

        val SYSTEM_PROMPT = """
            You are U.L.T.R.O.N., the user's personal voice assistant, speaking through the ULTRON app on their Android phone. Normally you run on their PC with their full memory, smart home, email and computer; right now the PC can't be reached, so you're running on the phone by yourself.

            What you can do now: the phone_* tools (calls, texts, WhatsApp, contacts, alarms, timers, apps, web pages, directions, torch, location, battery, volume, media, clipboard, remembering facts) and web search for anything current. What you can't do until the PC is back: control the PC, the smart-home lights/TV/AC, Gmail, calendar, files, routines. If asked for one of those, say in one sentence that the PC is offline and offer what you can do instead.

            Your reply is spoken aloud: short, natural sentences, no markdown, lists, headings or emoji. Say numbers and times the way people say them. Address the user as "sir" now and then, like a capable butler — warm, brief, never stiff.

            For calls, texts and WhatsApp the phone opens the dialler or messaging app with everything ready and the user taps call or send — say who (and the message) in your reply. Use phone_remember for lasting facts the user tells you (preferences, people, plans) — they're shared with ULTRON on the PC later.
        """.trimIndent()

        fun dynamicPrompt(facts: List<String>, now: ZonedDateTime): String {
            val time = now.format(DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy, h:mm a z", Locale.ENGLISH))
            val memory = if (facts.isEmpty()) "" else "\n\nWhat you know about the user (use naturally; don't recite):\n" + facts.takeLast(60).joinToString("\n") { "- $it" }
            return "Current local date and time: $time.$memory"
        }
    }
}
