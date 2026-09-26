package ai.ultron.core

import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.Call
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * ULTRON on the PC, reached over the home Wi-Fi or Tailscale. The PC does
 * the thinking with its full memory and tools; the phone lends it phone_*
 * tools, runs the ones it asks for, and hands the results back.
 */
class PcBrain(
    baseUrl: String,
    private val password: String,
    private val cookies: CookieStore,
    http: OkHttpClient = OkHttpClient(),
) {
    val baseUrl = baseUrl.trim().trimEnd('/')
    private val json = ObjectMapper()
    private val quick = http.newBuilder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).followRedirects(false).build()
    // A turn can take a while (tools, the advisor); the stream keeps it alive.
    private val slow = http.newBuilder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(180, TimeUnit.SECONDS).followRedirects(false).build()
    private val current = AtomicReference<Call?>()

    /** Signs in with the ULTRON password and keeps the session cookie. */
    fun login() {
        val call = quick.newCall(
            Request.Builder().url("$baseUrl/api/auth/login")
                .post(FormBody.Builder().add("password", password).add("next", "/").build())
                .build(),
        )
        val response = try {
            call.execute()
        } catch (e: IOException) {
            throw PcUnavailable("Can't reach ULTRON on the PC at $baseUrl.", e)
        }
        response.use { res ->
            if (res.code == 429) throw SetupProblem("The PC has locked sign-ins for a few minutes after wrong passwords.")
            val session = res.headers("Set-Cookie").firstOrNull { it.startsWith("$SESSION_COOKIE=") }?.substringBefore(';')
            if (session == null) {
                if (res.code in 300..399 || res.code == 200) throw SetupProblem("The PC didn't accept the ULTRON password — check it in the app's settings.")
                throw PcUnavailable("Sign-in failed (HTTP ${res.code}).")
            }
            cookies.set(session)
        }
    }

    private fun withSession(builder: Request.Builder): Request {
        cookies.get()?.let { builder.header("Cookie", it) }
        return builder.build()
    }

    /** Runs a request, signing in first (or again) when the PC asks for it. */
    private fun send(client: OkHttpClient, build: () -> Request.Builder, track: Boolean = false): Response {
        fun attempt(): Response {
            val call = client.newCall(withSession(build()))
            if (track) current.set(call)
            return try {
                call.execute()
            } catch (e: IOException) {
                if (call.isCanceled()) throw Cancelled()
                throw PcUnavailable("Can't reach ULTRON on the PC at $baseUrl.", e)
            }
        }
        if (cookies.get() == null) login()
        val res = attempt()
        if (res.code != 401) return res
        res.close()
        login()
        return attempt()
    }

    /** Is the PC there? Also brings back what ULTRON knows about the user. */
    fun fetchFacts(): List<String> {
        send(quick, { Request.Builder().url("$baseUrl/api/memory/facts").get() }).use { res ->
            if (!res.isSuccessful) throw PcUnavailable("The PC answered ${res.code}.")
            @Suppress("UNCHECKED_CAST")
            return (json.readValue(res.body!!.string(), Map::class.java)["facts"] as? List<Any?>)?.map { it.toString() } ?: emptyList()
        }
    }

    fun pushFacts(facts: List<String>) {
        if (facts.isEmpty()) return
        send(quick, { Request.Builder().url("$baseUrl/api/memory/facts").post(jsonBody(mapOf("facts" to facts))) }).use { res ->
            if (!res.isSuccessful) throw PcUnavailable("The PC answered ${res.code}.")
        }
    }

    /** Hands a finished conversation to the PC so it's remembered. */
    fun saveConversation(turns: List<Pair<String, String>>) {
        val messages = turns.flatMap { (user, reply) -> listOf(mapOf("role" to "user", "content" to user), mapOf("role" to "assistant", "content" to reply.ifBlank { "(no reply)" })) }
        send(quick, { Request.Builder().url("$baseUrl/api/memory/consolidate").post(jsonBody(mapOf("messages" to messages))) }).close()
    }

    fun cancel() {
        current.get()?.cancel()
    }

    /**
     * One user turn. `history` is the PC's conversation (opaque JSON, updated
     * in place). Returns what was spoken.
     */
    fun turn(
        history: MutableList<Any?>,
        userText: String,
        tools: List<ToolSpec>,
        runTool: (String, Map<String, Any?>) -> ToolResult,
        ui: AssistantUi,
    ): String {
        val clientTools = tools.map { it.toJson() }
        history += mapOf("role" to "user", "content" to userText)
        var spoken = StringBuilder()
        var body: Map<String, Any?> = mapOf("messages" to history.toList(), "clientTools" to clientTools, "client" to "android")
        repeat(MAX_HOPS) {
            val done = stream(body, ui, spoken)
            @Suppress("UNCHECKED_CAST")
            val messages = done["messages"] as? List<Any?>
            if (messages != null) {
                history.clear()
                history.addAll(messages)
            }
            @Suppress("UNCHECKED_CAST")
            val pending = done["pending"] as? Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val clientCalls = done["clientCalls"] as? List<Map<String, Any?>>
            when {
                pending != null -> {
                    // Something on the PC needs a yes/no (shutting down, sending an email…).
                    @Suppress("UNCHECKED_CAST")
                    val actions = (pending["toolUse"] as? List<Map<String, Any?>>).orEmpty()
                    val approved = ui.confirm("Allow this?", actions.joinToString("\n") { describePending(it) })
                    body = mapOf("resolution" to mapOf("token" to pending["token"], "approved" to approved), "clientTools" to clientTools, "client" to "android")
                }
                !clientCalls.isNullOrEmpty() -> {
                    @Suppress("UNCHECKED_CAST")
                    val results = ((done["serverResults"] as? List<Any?>) ?: emptyList()).toMutableList()
                    for (call in clientCalls) {
                        @Suppress("UNCHECKED_CAST")
                        val input = (call["input"] as? Map<String, Any?>) ?: emptyMap()
                        val name = call["name"].toString()
                        val r = runTool(name, input)
                        results += buildMap {
                            put("type", "tool_result")
                            put("tool_use_id", call["id"])
                            put("content", r.text)
                            if (r.isError) put("is_error", true)
                        }
                    }
                    history += mapOf("role" to "user", "content" to results)
                    body = mapOf("messages" to history.toList(), "clientTools" to clientTools, "client" to "android")
                }
                else -> return spoken.toString().trim().ifEmpty { (done["reply"] as? String).orEmpty() }
            }
        }
        return spoken.toString().trim()
    }

    /** Posts to /api/agent and reads the NDJSON stream up to its "done" event. */
    private fun stream(body: Map<String, Any?>, ui: AssistantUi, spoken: StringBuilder): Map<String, Any?> {
        send(slow, { Request.Builder().url("$baseUrl/api/agent").post(jsonBody(body)) }, track = true).use { res ->
            if (res.code == 429) throw SetupProblem(errorOf(res) ?: "Today's Claude budget on the PC is used up.")
            if (!res.isSuccessful) {
                val err = errorOf(res)
                if (res.code in 500..599 && err?.contains("ANTHROPIC_API_KEY") == true) throw SetupProblem(err)
                throw PcUnavailable(err ?: "The PC answered ${res.code}.")
            }
            val source = res.body!!.source()
            while (true) {
                val line = try {
                    source.readUtf8Line()
                } catch (e: IOException) {
                    if (current.get()?.isCanceled() == true) throw Cancelled()
                    throw PcUnavailable("Lost the connection to the PC.", e)
                } ?: throw PcUnavailable("The PC stopped answering mid-reply.")
                if (line.isBlank()) continue
                @Suppress("UNCHECKED_CAST")
                val event = json.readValue(line, Map::class.java) as Map<String, Any?>
                when (event["type"]) {
                    "text" -> {
                        val t = event["text"].toString()
                        spoken.append(t)
                        ui.onText(t)
                    }
                    "action" -> {
                        @Suppress("UNCHECKED_CAST")
                        val a = event["action"] as Map<String, Any?>
                        ui.onAction(a["name"].toString().replace('_', ' '), a["status"] == "done")
                    }
                    "error" -> throw if (spoken.isEmpty()) PcUnavailable(event["error"].toString()) else IOException(event["error"].toString())
                    "done" -> return event
                }
            }
        }
    }

    private fun errorOf(res: Response): String? = try {
        json.readValue(res.body!!.string(), Map::class.java)["error"]?.toString()
    } catch (_: Exception) {
        null
    }

    private fun jsonBody(value: Any) = json.writeValueAsString(value).toRequestBody("application/json".toMediaType())

    private fun describePending(t: Map<String, Any?>): String {
        @Suppress("UNCHECKED_CAST")
        val input = (t["input"] as? Map<String, Any?>).orEmpty()
        val detail = listOf("task", "message", "to", "subject", "action", "name").mapNotNull { k -> input[k]?.let { "$k: $it" } }
        return "${t["name"].toString().replace('_', ' ')}${if (detail.isNotEmpty()) " — ${detail.joinToString(", ")}" else ""}"
    }

    companion object {
        const val SESSION_COOKIE = "ultron_session"
        private const val MAX_HOPS = 8
    }
}
