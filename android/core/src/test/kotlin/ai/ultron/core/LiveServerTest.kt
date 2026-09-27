package ai.ultron.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Against a real ULTRON server (with a scripted Claude behind it). Skipped
 * unless ULTRON_E2E_URL and ULTRON_E2E_PASSWORD are set.
 */
class LiveServerTest {
    private val url = System.getenv("ULTRON_E2E_URL")
    private val password = System.getenv("ULTRON_E2E_PASSWORD")

    @Test fun `phone tools round-trip through the real server`() {
        if (url == null || password == null) return
        val pc = PcBrain(url, password, InMemoryCookies())
        pc.pushFacts(listOf("Favourite colour is teal"))
        assertTrue("Favourite colour is teal" in pc.fetchFacts(), "memory synced to the PC")

        val ui = FakeUi()
        val ran = mutableListOf<Pair<String, Map<String, Any?>>>()
        val history = mutableListOf<Any?>()
        val reply = pc.turn(history, "text priya I'm running late", PhoneTools.forPc(), { n, i -> ran += n to i; ToolResult("Sent to Priya.") }, ui)
        println("REPLY: $reply\nACTIONS: ${ui.actions}\nHISTORY: ${history.size} messages")
        assertEquals(listOf("phone_send_sms" to mapOf<String, Any?>("to" to "Priya", "message" to "Running late")), ran)
        assertTrue(ui.actions.any { it.first == "get system info" && it.second }, "the PC ran its own tool in the same turn")
        assertTrue(reply.startsWith("Texting Priya and checking the PC. Done, sir."), "one continuous reply: $reply")
        assertTrue(reply.contains("Sent to Priya."), "the phone's result reached Claude: $reply")
        assertEquals(4, history.size, "user, assistant(tool uses), user(both results), assistant")
    }
}
