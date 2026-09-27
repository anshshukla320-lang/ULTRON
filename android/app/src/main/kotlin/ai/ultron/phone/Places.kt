package ai.ultron.phone

import ai.ultron.core.PcBrain
import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Saved places ("home", "office") and what to do on arriving or leaving:
 * run an ULTRON routine on the PC, or show a reminder. Android's own
 * proximity alerts watch for them, so nothing runs in between.
 */
class Places(private val ctx: Context) {
    data class Trigger(val on: String, val routine: String?, val reminder: String?)
    data class Place(val name: String, val lat: Double, val lon: Double, val radius: Float, val triggers: List<Trigger>)

    private val prefs = Prefs(ctx)

    fun all(): List<Place> {
        val raw = prefs.placesJson.ifBlank { "[]" }
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return List(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            val t = o.optJSONArray("triggers") ?: JSONArray()
            Place(
                o.getString("name"), o.getDouble("lat"), o.getDouble("lon"), o.optDouble("radius", 150.0).toFloat(),
                List(t.length()) { j ->
                    val x = t.getJSONObject(j)
                    Trigger(x.getString("on"), x.optString("routine").ifBlank { null }, x.optString("reminder").ifBlank { null })
                },
            )
        }
    }

    private fun save(places: List<Place>) {
        prefs.placesJson = JSONArray(places.map { p ->
            JSONObject().put("name", p.name).put("lat", p.lat).put("lon", p.lon).put("radius", p.radius.toDouble())
                .put("triggers", JSONArray(p.triggers.map { JSONObject().put("on", it.on).put("routine", it.routine ?: "").put("reminder", it.reminder ?: "") }))
        }).toString()
    }

    fun find(name: String): Place? = all().firstOrNull { it.name.equals(name.trim(), ignoreCase = true) }

    fun savePlace(name: String, lat: Double, lon: Double, radius: Float = 150f) {
        val old = find(name)
        save(all().filterNot { it.name.equals(name, ignoreCase = true) } + Place(name.trim(), lat, lon, radius, old?.triggers.orEmpty()))
        registerAll()
    }

    fun addTrigger(place: String, trigger: Trigger): Place {
        val p = find(place) ?: throw IllegalArgumentException("There's no saved place called \"$place\" — save it first (\"this is $place\").")
        // One trigger per place and direction: a new one replaces the old.
        val updated = p.copy(triggers = p.triggers.filterNot { it.on == trigger.on } + trigger)
        save(all().map { if (it.name == p.name) updated else it })
        registerAll()
        return updated
    }

    fun delete(name: String): Boolean {
        val p = find(name) ?: return false
        unregister(p)
        save(all().filterNot { it.name == p.name })
        return true
    }

    fun describe(): String = all().joinToString("\n") { p ->
        val t = p.triggers.joinToString("; ") { tr ->
            listOfNotNull(tr.routine?.let { "run \"$it\"" }, tr.reminder?.let { "remind \"$it\"" }).joinToString(" and ").let { "on ${tr.on}: $it" }
        }
        "${p.name} (${"%.4f".format(Locale.ROOT, p.lat)}, ${"%.4f".format(Locale.ROOT, p.lon)})${if (t.isNotEmpty()) " — $t" else " — no triggers"}"
    }.ifEmpty { "No places saved yet." }

    // ── Android's proximity alerts ────────────────────────────────────────

    private fun intentFor(p: Place, flags: Int): PendingIntent? = PendingIntent.getBroadcast(
        ctx, 0,
        Intent(ctx, PlaceReceiver::class.java).setData(Uri.parse("ultron-place:${Uri.encode(p.name.lowercase(Locale.ROOT))}")),
        // Mutable: the system adds whether we're entering or leaving.
        flags or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0),
    )

    private fun unregister(p: Place) {
        val pi = intentFor(p, PendingIntent.FLAG_NO_CREATE) ?: return
        runCatching { ctx.getSystemService(LocationManager::class.java).removeProximityAlert(pi) }
        pi.cancel()
    }

    /** (Re)arms an alert for every place that has a trigger. Needs precise location. */
    @SuppressLint("MissingPermission")
    fun registerAll(): Boolean {
        if (!ctx.hasPermissions(Manifest.permission.ACCESS_FINE_LOCATION)) return false
        val lm = ctx.getSystemService(LocationManager::class.java)
        for (p in all()) {
            unregister(p)
            // "home" is always watched: the PC's security mode follows it.
            if (p.triggers.isEmpty() && !isHome(p.name)) continue
            val pi = intentFor(p, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            runCatching { lm.addProximityAlert(p.lat, p.lon, p.radius, -1, pi) }
        }
        return true
    }

    companion object {
        fun isHome(name: String) = name.trim().equals("home", ignoreCase = true)

        /** Where the phone is now (permissions already granted). Background thread. */
        @SuppressLint("MissingPermission")
        fun here(ctx: Context): Location {
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
            return loc ?: throw IllegalStateException("Couldn't get a location fix.")
        }

        fun addressOf(ctx: Context, l: Location): String? = try {
            @Suppress("DEPRECATION")
            Geocoder(ctx, Locale.getDefault()).getFromLocation(l.latitude, l.longitude, 1)?.firstOrNull()?.getAddressLine(0)
        } catch (_: Exception) {
            null
        }

        fun geocode(ctx: Context, address: String): Pair<Double, Double> {
            @Suppress("DEPRECATION")
            val a = runCatching { Geocoder(ctx, Locale.getDefault()).getFromLocationName(address, 1)?.firstOrNull() }.getOrNull()
                ?: throw IllegalArgumentException("Couldn't find \"$address\" on the map.")
            return a.latitude to a.longitude
        }
    }
}

/** A saved place was reached or left. */
class PlaceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val name = intent.data?.schemeSpecificPart ?: return
        val entering = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, true)
        val on = if (entering) "arrive" else "leave"
        val place = Places(context).find(name) ?: return
        val trigger = place.triggers.firstOrNull { it.on == on }
        if (trigger == null && !Places.isHome(place.name)) return
        // GPS jitter at the edge of the circle: once per 10 minutes is plenty.
        val sp = context.getSharedPreferences("ultron_places_fired", Context.MODE_PRIVATE)
        val key = "${place.name}|$on"
        val now = System.currentTimeMillis()
        if (now - sp.getLong(key, 0) < 10 * 60_000L) return
        sp.edit().putLong(key, now).apply()

        val pending = goAsync()
        Thread {
            try {
                if (Places.isHome(place.name)) {
                    // Tell the PC: it switches security mode on/off (if the user wants that).
                    val prefs = Prefs(context)
                    val c = prefs.config()
                    if (c.hasPc) runCatching { PcBrain(c.pcUrl, c.pcPassword, prefs).setAway(!entering) }
                }
                trigger?.reminder?.let {
                    Notices.show(context, key.hashCode(), if (entering) "At ${place.name}" else "Leaving ${place.name}", it, Notices.CHANNEL_PLACES)
                }
                trigger?.routine?.let { routine ->
                    val prefs = Prefs(context)
                    val c = prefs.config()
                    val msg = try {
                        if (!c.hasPc) throw IllegalStateException("the PC isn't set up")
                        PcBrain(c.pcUrl, c.pcPassword, prefs).runRoutine(routine).ifBlank { "Ran \"$routine\"." }
                    } catch (e: Exception) {
                        "Couldn't run \"$routine\": ${e.message}"
                    }
                    Notices.show(context, key.hashCode() + 1, if (entering) "Welcome to ${place.name}" else "Left ${place.name}", msg, Notices.CHANNEL_PLACES)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }
}
