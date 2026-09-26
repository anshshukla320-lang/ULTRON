package ai.ultron.core

/**
 * One ability of the phone that ULTRON's brain can use. The same definitions
 * go to both brains: sent to the PC (which hands calls back to the phone) and
 * to Claude directly when the phone thinks on its own.
 */
data class ToolSpec(
    val name: String,
    val description: String,
    /** JSON-schema properties, e.g. mapOf("to" to mapOf("type" to "string")). */
    val properties: Map<String, Map<String, Any?>> = emptyMap(),
    val required: List<String> = emptyList(),
    /** Asks the user on screen before running (calls, texts). */
    val confirm: Boolean = false,
    /** Only offered to the phone's own brain (the PC has its own version). */
    val phoneBrainOnly: Boolean = false,
) {
    /** The JSON the PC's /api/agent expects in `clientTools`. */
    fun toJson(): Map<String, Any?> = mapOf(
        "name" to name,
        "description" to description,
        "input_schema" to mapOf("type" to "object", "properties" to properties, "required" to required),
    )
}

private fun str(description: String) = mapOf("type" to "string", "description" to description)
private fun num(description: String) = mapOf("type" to "number", "description" to description)
private fun bool(description: String) = mapOf("type" to "boolean", "description" to description)
private fun enumOf(vararg values: String) = mapOf("type" to "string", "enum" to values.toList())

object PhoneTools {
    val all: List<ToolSpec> = listOf(
        ToolSpec(
            "phone_call",
            "Phone someone from the user's phone. `who` is a contact name or a number. The user confirms on screen first.",
            mapOf("who" to str("Contact name or phone number")),
            listOf("who"),
            confirm = true,
        ),
        ToolSpec(
            "phone_send_sms",
            "Send a text message (SMS) from the user's phone. Say the exact message and recipient in your reply; the user confirms on screen first.",
            mapOf("to" to str("Contact name or phone number"), "message" to str("Exact text to send")),
            listOf("to", "message"),
            confirm = true,
        ),
        ToolSpec(
            "phone_whatsapp",
            "Open WhatsApp on the phone with a message ready to send to someone (the user taps send). `to` is a contact name or number.",
            mapOf("to" to str("Contact name or phone number"), "message" to str("The message")),
            listOf("to", "message"),
        ),
        ToolSpec(
            "phone_find_contact",
            "Look up phone numbers in the phone's contacts by name.",
            mapOf("name" to str("Name or part of it")),
            listOf("name"),
        ),
        ToolSpec(
            "phone_set_alarm",
            "Set an alarm in the phone's clock app.",
            mapOf(
                "time" to str("24-hour time, e.g. 06:30"),
                "label" to str("Optional label"),
                "days" to mapOf("type" to "array", "items" to enumOf("mon", "tue", "wed", "thu", "fri", "sat", "sun"), "description" to "Repeat on these days (omit for once)"),
            ),
            listOf("time"),
        ),
        ToolSpec(
            "phone_set_timer",
            "Start a countdown timer in the phone's clock app.",
            mapOf("seconds" to num("Length in seconds"), "label" to str("Optional label")),
            listOf("seconds"),
        ),
        ToolSpec(
            "phone_open_app",
            "Open an app installed on the phone by its name (e.g. YouTube, Instagram, Google Maps, Camera).",
            mapOf("name" to str("App name")),
            listOf("name"),
        ),
        ToolSpec(
            "phone_open_url",
            "Open a web page on the phone.",
            mapOf("url" to str("Full URL")),
            listOf("url"),
        ),
        ToolSpec(
            "phone_navigate",
            "Start turn-by-turn directions on the phone (Google Maps).",
            mapOf("destination" to str("Place or address"), "mode" to enumOf("driving", "walking", "bicycling", "transit")),
            listOf("destination"),
        ),
        ToolSpec(
            "phone_torch",
            "Turn the phone's torch (flashlight) on or off.",
            mapOf("on" to bool("true = on, false = off")),
            listOf("on"),
        ),
        ToolSpec("phone_location", "Where the phone is right now (address and coordinates)."),
        ToolSpec("phone_battery", "The phone's battery level and whether it's charging."),
        ToolSpec(
            "phone_volume",
            "Change the phone's media volume.",
            mapOf("action" to enumOf("up", "down", "mute", "unmute", "set"), "level" to num("0-100, with set")),
            listOf("action"),
        ),
        ToolSpec(
            "phone_media",
            "Control whatever is playing on the phone (music, podcasts, videos).",
            mapOf("action" to enumOf("play_pause", "next", "previous")),
            listOf("action"),
        ),
        ToolSpec(
            "phone_copy",
            "Put text on the phone's clipboard so the user can paste it.",
            mapOf("text" to str("Text to copy")),
            listOf("text"),
        ),
        ToolSpec(
            "phone_remember",
            "Save a lasting fact about the user (a preference, a person, a plan). It's shared with ULTRON on the PC next time they connect.",
            mapOf("fact" to str("The fact, in one sentence")),
            listOf("fact"),
            phoneBrainOnly = true,
        ),
    )

    fun forPc(): List<ToolSpec> = all.filterNot { it.phoneBrainOnly }
    fun byName(name: String): ToolSpec? = all.firstOrNull { it.name == name }
}
