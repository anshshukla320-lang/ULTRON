package ai.ultron.core

import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.mockwebserver.MockResponse

val JSON = ObjectMapper()

/** Records what the UI was told and answers confirmations as scripted. */
class FakeUi(var approve: Boolean = true) : AssistantUi {
    val text = StringBuilder()
    val actions = mutableListOf<Pair<String, Boolean>>()
    val confirms = mutableListOf<Pair<String, String>>()
    val brains = mutableListOf<Brain>()
    override fun onBrain(brain: Brain) { brains += brain }
    override fun onText(delta: String) { text.append(delta) }
    override fun onAction(label: String, ok: Boolean) { actions += label to ok }
    override fun confirm(title: String, detail: String): Boolean {
        confirms += title to detail
        return approve
    }
}

class FakeToolbox : PhoneToolbox {
    val calls = mutableListOf<Pair<String, Map<String, Any?>>>()
    override fun run(name: String, input: Map<String, Any?>): ToolResult {
        calls += name to input
        return ToolResult("$name done")
    }
}

/** A Claude streaming response (server-sent events), built from blocks. */
object Sse {
    sealed interface Block
    data class Text(val text: String) : Block
    data class ToolUse(val id: String, val name: String, val inputJson: String) : Block

    fun response(stopReason: String, vararg blocks: Block): MockResponse {
        val sb = StringBuilder()
        fun event(type: String, data: Any) {
            sb.append("event: $type\ndata: ${JSON.writeValueAsString(data)}\n\n")
        }
        event(
            "message_start",
            mapOf(
                "type" to "message_start",
                "message" to mapOf(
                    "id" to "msg_1", "type" to "message", "role" to "assistant", "model" to "claude-sonnet-5",
                    "content" to emptyList<Any>(), "stop_reason" to null, "stop_sequence" to null,
                    "usage" to mapOf("input_tokens" to 10, "output_tokens" to 1),
                ),
            ),
        )
        blocks.forEachIndexed { i, b ->
            when (b) {
                is Text -> {
                    event("content_block_start", mapOf("type" to "content_block_start", "index" to i, "content_block" to mapOf("type" to "text", "text" to "")))
                    // Split into two deltas, like real streaming.
                    val mid = b.text.length / 2
                    for (part in listOf(b.text.substring(0, mid), b.text.substring(mid))) {
                        event("content_block_delta", mapOf("type" to "content_block_delta", "index" to i, "delta" to mapOf("type" to "text_delta", "text" to part)))
                    }
                }
                is ToolUse -> {
                    event("content_block_start", mapOf("type" to "content_block_start", "index" to i, "content_block" to mapOf("type" to "tool_use", "id" to b.id, "name" to b.name, "input" to emptyMap<String, Any>())))
                    event("content_block_delta", mapOf("type" to "content_block_delta", "index" to i, "delta" to mapOf("type" to "input_json_delta", "partial_json" to b.inputJson)))
                }
            }
            event("content_block_stop", mapOf("type" to "content_block_stop", "index" to i))
        }
        event("message_delta", mapOf("type" to "message_delta", "delta" to mapOf("stop_reason" to stopReason, "stop_sequence" to null), "usage" to mapOf("output_tokens" to 20)))
        event("message_stop", mapOf("type" to "message_stop"))
        return MockResponse().setHeader("Content-Type", "text/event-stream").setBody(sb.toString())
    }
}

fun ndjson(vararg events: Map<String, Any?>): MockResponse =
    MockResponse().setHeader("Content-Type", "application/x-ndjson").setBody(events.joinToString("") { JSON.writeValueAsString(it) + "\n" })
