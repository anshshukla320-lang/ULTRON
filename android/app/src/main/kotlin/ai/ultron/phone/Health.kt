package ai.ultron.phone

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import java.time.LocalDate
import java.time.ZoneId

/**
 * Steps, sleep and heart rate from Health Connect (where Google Fit,
 * Samsung Health, Fitbit and most watches put them). Read only.
 */
object Health {
    val PERMISSIONS = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
    )

    fun available(ctx: Context) = HealthConnectClient.getSdkStatus(ctx) == HealthConnectClient.SDK_AVAILABLE

    fun grantedSet(ctx: Context): Set<String> =
        if (!available(ctx)) emptySet()
        else runCatching { runBlocking { HealthConnectClient.getOrCreate(ctx).permissionController.getGrantedPermissions() } }.getOrDefault(emptySet())

    fun granted(ctx: Context) = grantedSet(ctx).isNotEmpty()

    /** Android's "allow ULTRON to read…" screen; start it for a result. */
    fun permissionIntent(ctx: Context): Intent =
        PermissionController.createRequestPermissionResultContract().createIntent(ctx, PERMISSIONS)

    /** Where to install/update Health Connect on phones before Android 14. */
    fun installIntent(): Intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"))

    /** One map per day, newest last, in the shape the PC stores. Background thread. */
    fun days(ctx: Context, count: Int): List<Map<String, Any?>> {
        if (!available(ctx)) throw IllegalStateException("Health Connect isn't on this phone (it's built into Android 14+, or install it from the Play Store).")
        val granted = grantedSet(ctx)
        if (granted.isEmpty()) throw SecurityException("ULTRON hasn't been allowed to read Health Connect yet — Settings → Allow health data.")
        val client = HealthConnectClient.getOrCreate(ctx)
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        fun can(record: kotlin.reflect.KClass<out androidx.health.connect.client.records.Record>) = HealthPermission.getReadPermission(record) in granted
        return runBlocking {
            (count.coerceIn(1, 30) - 1 downTo 0).map { back ->
                val day = today.minusDays(back.toLong())
                val start = day.atStartOfDay(zone).toInstant()
                val end = if (back == 0) java.time.Instant.now() else day.plusDays(1).atStartOfDay(zone).toInstant()
                val dayMetrics = buildSet<AggregateMetric<*>> {
                    if (can(StepsRecord::class)) add(StepsRecord.COUNT_TOTAL)
                    if (can(HeartRateRecord::class)) add(HeartRateRecord.BPM_AVG)
                    if (can(RestingHeartRateRecord::class)) add(RestingHeartRateRecord.BPM_AVG)
                }
                val r = if (dayMetrics.isEmpty()) null else client.aggregate(AggregateRequest(dayMetrics, TimeRangeFilter.between(start, end)))
                // The night before: sleep that ended this morning counts for this day.
                val sleep = if (!can(SleepSessionRecord::class)) null else client.aggregate(
                    AggregateRequest(
                        setOf(SleepSessionRecord.SLEEP_DURATION_TOTAL),
                        TimeRangeFilter.between(day.minusDays(1).atTime(18, 0).atZone(zone).toInstant(), day.atTime(14, 0).atZone(zone).toInstant()),
                    ),
                )[SleepSessionRecord.SLEEP_DURATION_TOTAL]
                buildMap {
                    put("date", day.toString())
                    r?.get(StepsRecord.COUNT_TOTAL)?.let { put("steps", it) }
                    sleep?.toMinutes()?.takeIf { it > 0 }?.let { put("sleepMinutes", it) }
                    r?.get(RestingHeartRateRecord.BPM_AVG)?.let { put("restingHeartRate", it) }
                    r?.get(HeartRateRecord.BPM_AVG)?.let { put("avgHeartRate", it) }
                }
            }
        }
    }

    fun describe(days: List<Map<String, Any?>>): String = days.joinToString("\n") { d ->
        val parts = listOfNotNull(
            (d["sleepMinutes"] as? Long)?.let { "slept ${it / 60} h ${it % 60} min" },
            (d["steps"] as? Long)?.let { "%,d steps".format(it) },
            (d["restingHeartRate"] as? Long)?.let { "resting heart rate $it" },
            (d["avgHeartRate"] as? Long)?.let { "average heart rate $it" },
        )
        "${d["date"]}: ${parts.joinToString(", ").ifEmpty { "nothing recorded" }}"
    }
}

/** Health Connect shows this when the user asks why ULTRON wants their data. */
class HealthRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        setContentView(ScrollView(this).apply {
            fitsSystemWindows = true
            addView(TextView(this@HealthRationaleActivity).apply {
                setPadding(pad, pad, pad, pad)
                setTextColor(getColor(R.color.text))
                textSize = 15f
                text = "ULTRON reads your steps, sleep and heart rate from Health Connect so it can answer questions like \"how did I sleep?\" and mention them in your morning briefing.\n\n" +
                    "It only reads — it never writes or changes anything. The numbers go to ULTRON on your own PC (if you've connected it) and, when you ask, to Claude to answer you. Nothing is shared with anyone else.\n\n" +
                    "You can take the permission back at any time in Health Connect."
            })
        })
    }
}
