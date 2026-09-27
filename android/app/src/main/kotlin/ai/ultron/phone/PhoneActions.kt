package ai.ultron.phone

import ai.ultron.core.PhoneToolbox
import ai.ultron.core.ToolResult
import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.CancellationSignal
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

    @SuppressLint("MissingPermission") // checked by ensurePermissions
    private fun location(): ToolResult {
        host.ensurePermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        // "Approximate" location is enough; GPS only when precise was allowed.
        if (!ctx.hasPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)) throw SecurityException("I need location permission for that.")
        val precise = ctx.hasPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        val lm = ctx.getSystemService(LocationManager::class.java)
        val providers = listOfNotNull(if (precise) LocationManager.GPS_PROVIDER else null, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) throw IllegalStateException("Location is switched off on the phone.")
        var loc: Location? = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val latch = CountDownLatch(1)
            val cancel = CancellationSignal()
            lm.getCurrentLocation(providers.last(), cancel, ctx.mainExecutor) { l -> loc = l; latch.countDown() }
            if (!latch.await(15, TimeUnit.SECONDS)) cancel.cancel()
        }
        if (loc == null) loc = providers.mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
        val l = loc ?: throw IllegalStateException("Couldn't get a location fix.")
        val address = try {
            @Suppress("DEPRECATION")
            Geocoder(ctx, Locale.getDefault()).getFromLocation(l.latitude, l.longitude, 1)?.firstOrNull()?.getAddressLine(0)
        } catch (_: Exception) {
            null
        }
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
