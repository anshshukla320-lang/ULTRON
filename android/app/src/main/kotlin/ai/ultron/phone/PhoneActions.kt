package ai.ultron.phone

import ai.ultron.core.PcBrain
import ai.ultron.core.PhoneToolbox
import ai.ultron.core.ToolResult
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.view.KeyEvent
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** What the actions need from the screen: asking for permissions and starting other apps. */
interface ActionHost {
    val context: Context
    /** Blocks (off the main thread) until the user answers Android's permission prompt. */
    fun ensurePermissions(vararg permissions: String): Boolean
    fun startActivityOnUi(intent: Intent)
    /** Opens the camera; the JPEG (downscaled) once the user takes the photo, null if they don't. */
    fun takePhoto(why: String): ByteArray?
    /** Android's Health Connect permission screen; true if anything was allowed. */
    fun requestHealthAccess(): Boolean
}

/** The phone_* tools, done with Android's own APIs. Runs on a background thread. */
class PhoneActions(private val host: ActionHost, private val prefs: Prefs) : PhoneToolbox {
    private val ctx get() = host.context

    override fun run(name: String, input: Map<String, Any?>): ToolResult = try {
        when (name) {
            "phone_call" -> call(str(input, "who"))
            "phone_send_sms" -> sms(str(input, "to"), str(input, "message"))
            "phone_whatsapp" -> whatsapp(str(input, "to"), str(input, "message"))
            "phone_find_contact" -> ToolResult(findContacts(str(input, "name")).joinToString("\n") { "${it.first}: ${it.second}" }.ifEmpty { "No contact matches \"${input["name"]}\"." })
            "phone_set_alarm" -> alarm(str(input, "time"), input["label"]?.toString(), input["days"] as? List<*>)
            "phone_set_timer" -> timer((input["seconds"] as? Number)?.toInt() ?: 0, input["label"]?.toString())
            "phone_open_app" -> openApp(str(input, "name"))
            "phone_open_url" -> openUrl(str(input, "url"))
            "phone_navigate" -> navigate(str(input, "destination"), input["mode"]?.toString())
            "phone_torch" -> torch(input["on"] == true || input["on"] == "true")
            "phone_location" -> location()
            "phone_battery" -> battery()
            "phone_volume" -> volume(str(input, "action"), (input["level"] as? Number)?.toInt())
            "phone_media" -> media(str(input, "action"))
            "phone_copy" -> copy(str(input, "text"))
            "phone_camera" -> camera(input["why"]?.toString())
            "phone_save_place" -> savePlace(str(input, "name"), input["address"]?.toString()?.trim()?.ifEmpty { null })
            "phone_location_trigger" -> locationTrigger(str(input, "place"), str(input, "when"), input["routine"]?.toString()?.trim()?.ifEmpty { null }, input["reminder"]?.toString()?.trim()?.ifEmpty { null })
            "phone_list_places" -> ToolResult(Places(ctx).describe())
            "phone_delete_place" -> ToolResult(if (Places(ctx).delete(str(input, "name"))) "Forgotten." else "There's no saved place called \"${input["name"]}\".")
            "phone_meeting_notes" -> meeting(str(input, "action"), input["title"]?.toString().orEmpty())
            "phone_health" -> health((input["days"] as? Number)?.toInt() ?: 7)
            else -> ToolResult("The phone can't do \"$name\".", true)
        }
    } catch (e: Exception) {
        ToolResult(e.message ?: e.toString(), true)
    }

    private fun str(input: Map<String, Any?>, key: String): String =
        input[key]?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("Missing \"$key\".")

    // ── People ────────────────────────────────────────────────────────────

    /** Contacts whose name contains the query: (name, number). */
    private fun findContacts(query: String): List<Pair<String, String>> {
        if (!host.ensurePermissions(Manifest.permission.READ_CONTACTS)) throw SecurityException("I need permission to read your contacts for that.")
        val out = linkedMapOf<String, Pair<String, String>>()
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
            arrayOf("%$query%"),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
        )?.use { c ->
            while (c.moveToNext() && out.size < 10) {
                val name = c.getString(0) ?: continue
                val number = c.getString(1)?.filter { it.isDigit() || it == '+' } ?: continue
                out.putIfAbsent("$name|$number", name to number)
            }
        }
        return out.values.toList()
    }

    /** A number as given, or the one contact the name matches. */
    private fun numberFor(who: String): Pair<String, String> {
        val digits = who.filter { it.isDigit() || it == '+' }
        if (digits.count(Char::isDigit) >= 5 && digits.length >= who.count { !it.isWhitespace() } - 3) return who to digits
        val matches = findContacts(who)
        val exact = matches.filter { it.first.equals(who, ignoreCase = true) }
        val pick = exact.ifEmpty { matches }
        return when {
            pick.isEmpty() -> throw IllegalArgumentException("No contact called \"$who\".")
            pick.map { it.second }.distinct().size > 1 -> throw IllegalArgumentException("\"$who\" matches several numbers: ${pick.joinToString { "${it.first} ${it.second}" }} — which one?")
            else -> pick.first()
        }
    }

    private fun call(who: String): ToolResult {
        val (name, number) = numberFor(who)
        host.startActivityOnUi(Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(number)}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return ToolResult("Opened the dialler with $name's number — the user taps call.")
    }

    /** Opens the Messages app with the text written; the user taps send. (Sending
     *  directly needs the SMS permission, which Play Protect blocks for apps
     *  installed outside the Play Store.) */
    private fun sms(to: String, message: String): ToolResult {
        val (name, number) = numberFor(to)
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${Uri.encode(number)}"))
            .putExtra("sms_body", message)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        host.startActivityOnUi(intent)
        return ToolResult("Opened Messages with the text to $name ready — the user taps send.")
    }

    private fun whatsapp(to: String, message: String): ToolResult {
        val (name, raw) = numberFor(to)
        var number = raw.filter(Char::isDigit)
        if (number.startsWith("0")) number = number.trimStart('0')
        if (!raw.startsWith("+") && number.length == 10) number = prefs.countryCode + number
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://api.whatsapp.com/send?phone=$number&text=${Uri.encode(message)}"))
        val pm = ctx.packageManager
        listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { pkg -> runCatching { pm.getPackageInfo(pkg, 0) }.isSuccess }?.let { intent.setPackage(it) }
        host.startActivityOnUi(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return ToolResult("Opened WhatsApp with the message to $name ready — the user taps send.")
    }

    // ── Clock ─────────────────────────────────────────────────────────────

    private fun alarm(time: String, label: String?, days: List<*>?): ToolResult {
        val m = Regex("""^(\d{1,2})[:.](\d{2})$""").find(time.trim()) ?: throw IllegalArgumentException("Time should look like 06:30.")
        val (h, min) = m.destructured
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, h.toInt())
            .putExtra(AlarmClock.EXTRA_MINUTES, min.toInt())
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        label?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        val dayNums = days?.mapNotNull { DAYS[it.toString().take(3).lowercase()] }
        if (!dayNums.isNullOrEmpty()) intent.putExtra(AlarmClock.EXTRA_DAYS, ArrayList(dayNums))
        host.startActivityOnUi(intent)
        return ToolResult("Alarm set for ${h.toInt()}:$min${if (!dayNums.isNullOrEmpty()) " on ${days.joinToString()}" else ""}.")
    }

    private fun timer(seconds: Int, label: String?): ToolResult {
        require(seconds in 1..86_400) { "Timer length should be between 1 second and 24 hours." }
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        label?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it) }
        host.startActivityOnUi(intent)
        return ToolResult("Timer started for ${seconds / 60} min ${seconds % 60} s.")
    }

    // ── Apps and the web ──────────────────────────────────────────────────

    private fun openApp(name: String): ToolResult {
        val pm = ctx.packageManager
        val launchers = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        val want = name.lowercase(Locale.ROOT).replace(" ", "")
        val labelled = launchers.map { it to it.loadLabel(pm).toString() }
        val hit = labelled.firstOrNull { it.second.lowercase(Locale.ROOT).replace(" ", "") == want }
            ?: labelled.filter { it.second.lowercase(Locale.ROOT).replace(" ", "").contains(want) }.minByOrNull { it.second.length }
            ?: throw IllegalArgumentException("No app called \"$name\" on this phone.")
        val intent = pm.getLaunchIntentForPackage(hit.first.activityInfo.packageName) ?: throw IllegalStateException("${hit.second} can't be opened.")
        host.startActivityOnUi(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return ToolResult("Opened ${hit.second}.")
    }

    private fun openUrl(url: String): ToolResult {
        val u = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) url else "https://$url"
        host.startActivityOnUi(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return ToolResult("Opened $u.")
    }

    private fun navigate(destination: String, mode: String?): ToolResult {
        val m = when (mode) { "walking" -> "w"; "bicycling" -> "b"; "transit" -> "r"; else -> "d" }
        val nav = Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=${Uri.encode(destination)}&mode=$m")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps/dir/?api=1&destination=${Uri.encode(destination)}&travelmode=${mode ?: "driving"}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        host.startActivityOnUi(if (nav.resolveActivity(ctx.packageManager) != null) nav else web)
        return ToolResult("Directions to $destination started.")
    }

    private fun copy(text: String): ToolResult {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        val latch = CountDownLatch(1)
        // The clipboard must be touched from the main thread on some phones.
        android.os.Handler(ctx.mainLooper).post {
            cm.setPrimaryClip(ClipData.newPlainText("ULTRON", text))
            latch.countDown()
        }
        latch.await(3, TimeUnit.SECONDS)
        return ToolResult("Copied to the clipboard.")
    }

    // ── Hardware ──────────────────────────────────────────────────────────

    private fun torch(on: Boolean): ToolResult {
        val cm = ctx.getSystemService(CameraManager::class.java)
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            ?: throw IllegalStateException("This phone has no torch.")
        cm.setTorchMode(id, on)
        return ToolResult(if (on) "Torch on." else "Torch off.")
    }

    private fun location(): ToolResult {
        host.ensurePermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        // "Approximate" location is enough; GPS only when precise was allowed.
        if (!ctx.hasPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)) throw SecurityException("I need location permission for that.")
        val l = Places.here(ctx)
        val address = Places.addressOf(ctx, l)
        return ToolResult("${address ?: "Unknown address"} (${"%.5f".format(Locale.ROOT, l.latitude)}, ${"%.5f".format(Locale.ROOT, l.longitude)}, accurate to about ${l.accuracy.toInt()} m).")
    }

    private fun battery(): ToolResult {
        val bm = ctx.getSystemService(BatteryManager::class.java)
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return ToolResult("Battery $level%${if (bm.isCharging) ", charging" else ""}.")
    }

    private fun volume(action: String, level: Int?): ToolResult {
        val am = ctx.getSystemService(AudioManager::class.java)
        val stream = AudioManager.STREAM_MUSIC
        val max = am.getStreamMaxVolume(stream)
        when (action) {
            "up" -> repeat(2) { am.adjustStreamVolume(stream, AudioManager.ADJUST_RAISE, 0) }
            "down" -> repeat(2) { am.adjustStreamVolume(stream, AudioManager.ADJUST_LOWER, 0) }
            "mute" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, 0)
            "unmute" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_UNMUTE, 0)
            "set" -> am.setStreamVolume(stream, ((level ?: 50).coerceIn(0, 100) * max + 50) / 100, 0)
            else -> throw IllegalArgumentException("Volume action should be up, down, mute, unmute or set.")
        }
        return ToolResult("Media volume ${am.getStreamVolume(stream) * 100 / max.coerceAtLeast(1)}%.")
    }

    private fun media(action: String): ToolResult {
        val key = when (action) {
            "play_pause" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            else -> throw IllegalArgumentException("Media action should be play_pause, next or previous.")
        }
        val am = ctx.getSystemService(AudioManager::class.java)
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
        return ToolResult("Done.")
    }

    // ── Camera ────────────────────────────────────────────────────────────

    private fun camera(why: String?): ToolResult {
        val jpeg = host.takePhoto(why?.ifBlank { null } ?: "Point the camera and take the photo") ?: return ToolResult("The user didn't take a photo.", true)
        return ToolResult("Here's the photo the user just took.", imageJpeg = jpeg)
    }

    // ── Places and location triggers ──────────────────────────────────────

    private fun savePlace(name: String, address: String?): ToolResult {
        val (lat, lon) = if (address != null) {
            Places.geocode(ctx, address)
        } else {
            host.ensurePermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            if (!ctx.hasPermissions(Manifest.permission.ACCESS_FINE_LOCATION)) throw SecurityException("I need precise location permission to save where you are.")
            Places.here(ctx).let { it.latitude to it.longitude }
        }
        Places(ctx).savePlace(name, lat, lon)
        val where = address ?: Places.addressOf(ctx, android.location.Location("").apply { latitude = lat; longitude = lon }) ?: "here"
        if (!Places.isHome(name)) return ToolResult("Saved \"$name\" ($where).")
        // Home is watched so the PC knows when the user is out (security mode, "left on" warnings).
        val background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            (host.ensurePermissions(Manifest.permission.ACCESS_FINE_LOCATION) && host.ensurePermissions(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
        Places(ctx).registerAll()
        return ToolResult(
            "Saved home ($where). ULTRON on the PC will know when you leave and come back (for security mode)." +
                if (background) "" else " For that to work with the app closed, set Location to \"Allow all the time\".",
        )
    }

    private fun locationTrigger(place: String, on: String, routine: String?, reminder: String?): ToolResult {
        require(on == "arrive" || on == "leave") { "\"when\" should be arrive or leave." }
        require(routine != null || reminder != null) { "Give a routine to run, a reminder to show, or both." }
        if (routine != null && !prefs.config().hasPc) throw IllegalStateException("Routines run on ULTRON on the PC, and the PC isn't set up in the app.")
        if (!host.ensurePermissions(Manifest.permission.ACCESS_FINE_LOCATION)) throw SecurityException("Location triggers need precise location permission.")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) host.ensurePermissions(Manifest.permission.POST_NOTIFICATIONS)
        val p = Places(ctx).addTrigger(place, Places.Trigger(on, routine, reminder))
        // Android 10+: noticing arrivals with the app closed needs "Allow all the time".
        val background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || host.ensurePermissions(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        Places(ctx).registerAll()
        val what = listOfNotNull(routine?.let { "run \"$it\"" }, reminder?.let { "remind you: $it" }).joinToString(" and ")
        return ToolResult(
            "When you ${if (on == "arrive") "arrive at" else "leave"} ${p.name}, I'll $what." +
                if (background) "" else " Note: location is only allowed while the app is open, so this won't work with ULTRON closed — set Location to \"Allow all the time\" in the app's settings.",
        )
    }

    // ── Meetings ──────────────────────────────────────────────────────────

    private fun meeting(action: String, title: String): ToolResult {
        val c = prefs.config()
        if (!c.hasPc) throw IllegalStateException("Meeting notes are written by ULTRON on the PC, and the PC isn't set up in the app.")
        val pc = PcBrain(c.pcUrl, c.pcPassword, prefs)
        return when (action) {
            "start" -> {
                if (MeetingService.recording) return ToolResult("Already recording the meeting.")
                if (!host.ensurePermissions(Manifest.permission.RECORD_AUDIO)) throw SecurityException("I need the microphone for that.")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) host.ensurePermissions(Manifest.permission.POST_NOTIFICATIONS)
                val id = pc.meetingStart(title)
                MeetingService.start(ctx, id, title)
                ToolResult("Recording the meeting on the phone. The screen can go off; it keeps recording. Tell me when it's over.")
            }
            "stop" -> {
                MeetingService.stop()
                ToolResult(pc.meetingStop().ifBlank { "The notes are saved on the PC." })
            }
            else -> throw IllegalArgumentException("action should be start or stop.")
        }
    }

    // ── Health ────────────────────────────────────────────────────────────

    private fun health(days: Int): ToolResult {
        if (!Health.available(ctx)) throw IllegalStateException("Health Connect isn't on this phone (it's built into Android 14 and later; on older phones install it from the Play Store).")
        if (!Health.granted(ctx) && !host.requestHealthAccess()) throw SecurityException("ULTRON wasn't allowed to read health data.")
        val data = Health.days(ctx, days)
        // Pass them on to the PC too, for the briefing and the journal.
        val c = prefs.config()
        if (c.hasPc) runCatching { PcBrain(c.pcUrl, c.pcPassword, prefs).pushHealth(data) }
        return ToolResult(Health.describe(data))
    }

    private companion object {
        val DAYS = mapOf(
            "sun" to Calendar.SUNDAY, "mon" to Calendar.MONDAY, "tue" to Calendar.TUESDAY, "wed" to Calendar.WEDNESDAY,
            "thu" to Calendar.THURSDAY, "fri" to Calendar.FRIDAY, "sat" to Calendar.SATURDAY,
        )
    }
}

/** True if every permission is already granted. */
fun Context.hasPermissions(vararg permissions: String) =
    permissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
