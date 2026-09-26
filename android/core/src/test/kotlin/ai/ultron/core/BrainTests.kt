package ai.ultron.core

import com.anthropic.models.messages.MessageParam
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@Suppress("UNCHECKED_CAST")
class PhoneBrainTest {
    private val server = MockWebServer().apply { start() }

    @AfterTest fun stop() = server.shutdown()

    @Test fun `streams text, runs a phone tool, and sends the result back`() {
        server.enqueue(Sse.response("tool_use", Sse.Text("Torch on. "), Sse.ToolUse("toolu_1", "phone_torch", """{"on": true}""")))
        server.enqueue(Sse.response("end_turn", Sse.Text("Done, sir.")))
        val brain = PhoneBrain("sk-test", server.url("/").toString().trimEnd('/'))
        val ui = FakeUi()
        val box = FakeToolbox()
        val history = mutableListOf<MessageParam>()
        val now = ZonedDateTime.of(2026, 9, 26, 21, 5, 0, 0, ZoneId.of("Asia/Kolkata"))
        val reply = brain.turn(history, "torch on", listOf("Lives in Pune"), PhoneTools.all, { n, i -> box.run(n, i) }, ui, now)

        assertEquals("Torch on. Done, sir.", reply)
        assertEquals("Torch on. Done, sir.", ui.text.toString())
        assertEquals(listOf("phone_torch" to mapOf<String, Any?>("on" to true)), box.calls)
        assertEquals(4, history.size, "user, assistant(tool_use), user(tool_result), assistant")

        val first = JSON.readValue(server.takeRequest().body.readUtf8(), Map::class.java) as Map<String, Any?>
        assertEquals("claude-sonnet-5", first["model"])
        assertEquals(true, first["stream"])
        assertEquals(mapOf("effort" to "medium"), first["output_config"])
        val system = first["system"] as List<Map<String, Any?>>
        assertEquals(mapOf("type" to "ephemeral"), system[0]["cache_control"], "fixed prompt is cached")
        assertTrue((system[1]["text"] as String).contains("Saturday, 26 September 2026, 9:05 PM IST"))
        assertTrue((system[1]["text"] as String).contains("- Lives in Pune"))
        val tools = first["tools"] as List<Map<String, Any?>>
        assertEquals("web_search_20260209", tools[0]["type"])
        assertEquals(PhoneTools.all.map { it.name }, tools.drop(1).map { it["name"] })
        assertEquals(mapOf("type" to "ephemeral"), tools.last()["cache_control"], "tool list is cached")
        assertEquals(listOf("on"), (tools.first { it["name"] == "phone_torch" }["input_schema"] as Map<String, Any?>)["required"])

        val second = JSON.readValue(server.takeRequest().body.readUtf8(), Map::class.java) as Map<String, Any?>
        val lastMsg = (second["messages"] as List<Map<String, Any?>>).last()
        val result = (lastMsg["content"] as List<Map<String, Any?>>).single()
        assertEquals("tool_result", result["type"])
        assertEquals("toolu_1", result["tool_use_id"])
        assertEquals("phone_torch done", result["content"])
    }

    @Test fun `a made-up tool is answered with an error, not run`() {
        server.enqueue(Sse.response("tool_use", Sse.ToolUse("toolu_9", "phone_launch_rocket", "{}")))
        server.enqueue(Sse.response("end_turn", Sse.Text("I can't do that.")))
        val box = FakeToolbox()
        PhoneBrain("sk-test", server.url("/").toString().trimEnd('/')).turn(mutableListOf(), "launch", emptyList(), PhoneTools.all, { n, i -> box.run(n, i) }, FakeUi())
        assertTrue(box.calls.isEmpty())
        server.takeRequest()
        assertTrue(server.takeRequest().body.readUtf8().contains("There is no tool named"))
    }

    @Test fun `a refusal is still answered out loud`() {
        server.enqueue(Sse.response("refusal"))
        val reply = PhoneBrain("sk-test", server.url("/").toString().trimEnd('/')).turn(mutableListOf(), "x", emptyList(), PhoneTools.all, { _, _ -> ToolResult("") }, FakeUi())
        assertEquals("I can't help with that one, sir.", reply)
    }

    @Test fun `a bad API key is a setup problem`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"""))
        assertFailsWith<SetupProblem> {
            PhoneBrain("sk-bad", server.url("/").toString().trimEnd('/')).turn(mutableListOf(), "hi", emptyList(), PhoneTools.all, { _, _ -> ToolResult("") }, FakeUi())
        }
    }
}

/** A fake ULTRON PC server: login, memory, and a scripted /api/agent. */
@Suppress("UNCHECKED_CAST")
class FakePc(private val agentReplies: ArrayDeque<MockResponse>) : Dispatcher() {
    val agentBodies = ConcurrentLinkedQueue<Map<String, Any?>>()
    val pushedFacts = ConcurrentLinkedQueue<List<String>>()
    var logins = 0
    var down = false
    var facts = listOf("Prefers tea", "Sister is Priya")

    override fun dispatch(request: RecordedRequest): MockResponse {
        if (down) return MockResponse().setResponseCode(502)
        val cookieOk = request.getHeader("Cookie") == "ultron_session=tok"
        return when (request.path) {
            "/api/auth/login" -> {
                logins++
                if (request.body.readUtf8().contains("password=secret")) {
                    MockResponse().setResponseCode(303).setHeader("Location", "/").addHeader("Set-Cookie", "ultron_session=tok; Path=/; HttpOnly")
                } else {
                    MockResponse().setResponseCode(303).setHeader("Location", "/login?error=1")
                }
            }
            "/api/memory/facts" -> when {
                !cookieOk -> MockResponse().setResponseCode(401)
                request.method == "POST" -> {
                    pushedFacts += (JSON.readValue(request.body.readUtf8(), Map::class.java)["facts"] as List<String>)
                    MockResponse().setBody("""{"added":1}""")
                }
                else -> MockResponse().setBody(JSON.writeValueAsString(mapOf("facts" to facts)))
            }
            "/api/agent" -> if (!cookieOk) MockResponse().setResponseCode(401) else {
                agentBodies += JSON.readValue(request.body.readUtf8(), Map::class.java) as Map<String, Any?>
                agentReplies.removeFirstOrNull() ?: MockResponse().setResponseCode(500)
            }
            "/api/memory/consolidate" -> MockResponse().setBody("{}")
            else -> MockResponse().setResponseCode(404)
        }
    }
}

@Suppress("UNCHECKED_CAST")
class PcBrainTest {
    private val server = MockWebServer().apply { start() }

    @AfterTest fun stop() = server.shutdown()

    private fun url() = server.url("/").toString().trimEnd('/')

    @Test fun `signs in, lends phone tools, runs the ones the PC asks for and resumes`() {
        val done1 = mapOf(
            "type" to "done",
            "messages" to listOf(mapOf("role" to "user", "content" to "text priya"), mapOf("role" to "assistant", "content" to listOf(mapOf("type" to "tool_use", "id" to "t1", "name" to "phone_send_sms", "input" to mapOf("to" to "Priya", "message" to "Late")), mapOf("type" to "tool_use", "id" to "t2", "name" to "get_weather", "input" to emptyMap<String, Any>())))),
            "reply" to "",
            "pending" to null,
            "clientCalls" to listOf(mapOf("id" to "t1", "name" to "phone_send_sms", "input" to mapOf("to" to "Priya", "message" to "Late"))),
            "serverResults" to listOf(mapOf("type" to "tool_result", "tool_use_id" to "t2", "content" to "Sunny")),
        )
        val fake = FakePc(
            ArrayDeque(
                listOf(
                    ndjson(mapOf("type" to "text", "text" to "Texting Priya. "), mapOf("type" to "action", "action" to mapOf("name" to "get_weather", "status" to "done")), done1),
                    ndjson(mapOf("type" to "text", "text" to "Sent, sir."), mapOf("type" to "done", "messages" to listOf<Any>(), "reply" to "Sent, sir.", "pending" to null)),
                ),
            ),
        )
        server.dispatcher = fake
        val cookies = InMemoryCookies()
        val pc = PcBrain(url(), "secret", cookies)
        assertEquals(listOf("Prefers tea", "Sister is Priya"), pc.fetchFacts())
        assertEquals("ultron_session=tok", cookies.get())

        val ui = FakeUi()
        val ran = mutableListOf<String>()
        val reply = pc.turn(mutableListOf(), "text priya I'm late", PhoneTools.forPc(), { n, _ -> ran += n; ToolResult("Sent.") }, ui)
        assertEquals("Texting Priya. Sent, sir.", reply)
        assertEquals(listOf("phone_send_sms"), ran)
        assertEquals(listOf("get weather" to true), ui.actions)

        val (first, second) = fake.agentBodies.toList()
        assertEquals("android", first["client"])
        val tools = (first["clientTools"] as List<Map<String, Any?>>).map { it["name"] }
        assertTrue("phone_send_sms" in tools && "phone_remember" !in tools, "phone_remember stays on the phone")
        val resumed = (second["messages"] as List<Map<String, Any?>>).last()
        assertEquals("user", resumed["role"])
        val blocks = resumed["content"] as List<Map<String, Any?>>
        assertEquals(listOf("t2", "t1"), blocks.map { it["tool_use_id"] }, "server's results, then the phone's")
        assertEquals("Sent.", blocks[1]["content"])
    }

    @Test fun `a PC confirmation is asked on the phone and answered`() {
        val pending = mapOf("type" to "done", "messages" to listOf<Any>(), "reply" to "Shall I?", "pending" to mapOf("token" to "tok123", "toolUse" to listOf(mapOf("id" to "x", "name" to "power_action", "input" to mapOf("action" to "sleep")))))
        val fake = FakePc(ArrayDeque(listOf(ndjson(mapOf("type" to "text", "text" to "Shall I? "), pending), ndjson(mapOf("type" to "done", "messages" to listOf<Any>(), "reply" to "Declined.", "pending" to null)))))
        server.dispatcher = fake
        val ui = FakeUi(approve = false)
        PcBrain(url(), "secret", InMemoryCookies()).turn(mutableListOf(), "sleep the pc", PhoneTools.forPc(), { _, _ -> ToolResult("") }, ui)
        assertEquals("power action — action: sleep", ui.confirms.single().second)
        val resolution = fake.agentBodies.toList()[1]["resolution"] as Map<String, Any?>
        assertEquals(mapOf("token" to "tok123", "approved" to false), resolution)
    }

    @Test fun `wrong password is a setup problem, a dead PC is unavailable`() {
        server.dispatcher = FakePc(ArrayDeque())
        assertFailsWith<SetupProblem> { PcBrain(url(), "wrong", InMemoryCookies()).fetchFacts() }
        server.shutdown()
        assertFailsWith<PcUnavailable> { PcBrain(url(), "secret", InMemoryCookies()).fetchFacts() }
    }
}

@Suppress("UNCHECKED_CAST")
class AssistantTest {
    private val pcServer = MockWebServer().apply { start() }
    private val claude = MockWebServer().apply { start() }

    @AfterTest fun stop() {
        pcServer.shutdown()
        claude.shutdown()
    }

    private fun assistant(fake: FakePc, memory: MemoryStore, box: PhoneToolbox, tools: List<ToolSpec> = PhoneTools.all, now: () -> Long = { System.currentTimeMillis() }): Assistant {
        pcServer.dispatcher = fake
        val cfg = AssistantConfig(pcServer.url("/").toString().trimEnd('/'), "secret", "sk-test")
        return Assistant({ cfg }, box, memory, InMemoryCookies(), phoneFactory = { PhoneBrain(it.apiKey, claude.url("/").toString().trimEnd('/')) }, clock = now, tools = tools)
    }

    @Test fun `uses the PC when it's there, the phone when it isn't, and carries the conversation over`() {
        val fake = FakePc(ArrayDeque(listOf(ndjson(mapOf("type" to "text", "text" to "Your sister is Priya."), mapOf("type" to "done", "messages" to listOf<Any>(), "reply" to "Your sister is Priya.", "pending" to null)))))
        val memory = InMemoryStore()
        var now = 1_000_000L
        val a = assistant(fake, memory, FakeToolbox()) { now }
        val ui = FakeUi()
        assertEquals("Your sister is Priya.", a.ask("who's my sister?", ui))
        assertEquals(Brain.PC, a.lastBrain)
        assertEquals(listOf("Prefers tea", "Sister is Priya"), memory.facts(), "memory synced from the PC")

        // The PC goes away mid-conversation: the same request is answered on the phone.
        fake.down = true
        now += 120_000
        claude.enqueue(Sse.response("tool_use", Sse.ToolUse("toolu_1", "phone_remember", """{"fact": "Priya's birthday is 3 March"}""")))
        claude.enqueue(Sse.response("end_turn", Sse.Text("Noted, sir.")))
        val ui2 = FakeUi()
        assertEquals("Noted, sir.", a.ask("remember her birthday is 3 March", ui2))
        assertEquals(Brain.PHONE, a.lastBrain)
        assertEquals(listOf(Brain.PHONE), ui2.brains)
        val body = claude.takeRequest().body.readUtf8()
        assertTrue(body.contains("who's my sister?") && body.contains("Your sister is Priya."), "earlier turn carried over")
        assertTrue(body.contains("- Sister is Priya"), "PC memory used offline")
        assertEquals(listOf("Priya's birthday is 3 March"), memory.pendingFacts())

        // PC back: the fact learned offline is pushed to it.
        fake.down = false
        now += 120_000
        assertTrue(a.pcReachable())
        assertEquals(listOf(listOf("Priya's birthday is 3 March")), fake.pushedFacts.toList())
        assertTrue(memory.pendingFacts().isEmpty())
    }

    @Test fun `a tool marked confirm needs a yes on screen`() {
        val fake = FakePc(ArrayDeque()).also { it.down = true }
        val guarded = PhoneTools.all.map { if (it.name == "phone_torch") it.copy(confirm = true) else it }
        claude.enqueue(Sse.response("tool_use", Sse.ToolUse("toolu_1", "phone_torch", """{"on": true}""")))
        claude.enqueue(Sse.response("end_turn", Sse.Text("Okay, leaving it off.")))
        val box = FakeToolbox()
        val ui = FakeUi(approve = false)
        assistant(fake, InMemoryStore(), box, tools = guarded).ask("torch on", ui)
        assertEquals("Allow torch?", ui.confirms.single().first)
        assertTrue(box.calls.isEmpty(), "declined — not run")
        // Calls and texts open the dialler/Messages for the user to finish, so they don't ask twice.
        assertTrue(PhoneTools.all.none { it.confirm })
    }

    @Test fun `nothing set up is a setup problem`() {
        val a = Assistant({ AssistantConfig() }, FakeToolbox(), InMemoryStore(), InMemoryCookies())
        assertFailsWith<SetupProblem> { a.ask("hi", FakeUi()) }
    }
}

class SpeechTest {
    @Test fun `sentences come out as soon as they're complete`() {
        val c = SentenceChunker()
        assertEquals(emptyList(), c.push("Hello Dr. Smith, it's 3 p.m. "))
        assertEquals(listOf("Hello Dr. Smith, it's 3 p.m. now."), c.push("now. And"))
        assertEquals(emptyList(), c.push(" in Spanish, <lang code=\"es\">¿Qué tal? Muy"))
        // A sentence ending inside a language tag is spoken once the reply ends (same as the PC page).
        assertEquals(emptyList(), c.push(" bien.</lang> "))
        assertEquals("And in Spanish, <lang code=\"es\">¿Qué tal? Muy bien.</lang>", c.flush())
    }

    @Test fun `language tags become native-voice segments`() {
        assertEquals(
            listOf(SpeechSegment("It's", null), SpeechSegment("¿Dónde está?", "es"), SpeechSegment("in Spanish.", null)),
            SpeechText.segments("It's <lang code=\"es\">¿Dónde está?</lang> in Spanish."),
        )
        assertEquals("Say ciao.", SpeechText.forDisplay("Say <lang code=\"it\">ciao</lang>."))
    }

    @Test fun `stop and wake words`() {
        assertTrue(VoiceCommands.isStop("Stop"))
        assertTrue(VoiceCommands.isStop("hey ultron, be quiet please"))
        assertTrue(!VoiceCommands.isStop("stop the music in the kitchen"))
        assertEquals("what time is it", VoiceCommands.stripWake("Hey Ultron, what time is it"))
    }
}
