package ai.ultron.phone

import ai.ultron.core.PcBrain
import android.Manifest
import android.annotation.SuppressLint
import android.graphics.BitmapFactory
import android.location.LocationManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** ULTRON's notifications on the phone. */
object Notices {
    const val CHANNEL = "ultron_notices"
    const val CHANNEL_PLACES = "ultron_places"
    const val CHANNEL_MEETING = "ultron_meeting"

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "From ULTRON", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Reminders, timers, briefings and alerts from ULTRON on your PC"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_PLACES, "Place reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Reminders for when you arrive at or leave a place"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_MEETING, "Meeting recording", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while ULTRON records a meeting"
        })
    }

    fun canPost(ctx: Context) =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || ctx.hasPermissions(Manifest.permission.POST_NOTIFICATIONS)

    fun show(ctx: Context, id: Int, title: String, text: String, channel: String = CHANNEL, picture: android.graphics.Bitmap? = null) {
        if (!canPost(ctx)) return
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(ctx.getColor(R.color.amber))
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(if (picture != null) Notification.BigPictureStyle().bigPicture(picture).setSummaryText(text) else Notification.BigTextStyle().bigText(text))
            .apply { if (picture != null) setLargeIcon(picture) }
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
    }
}

/**
 * What the phone fetches from the PC in the background: new announcements
 * (shown as notifications), the widget's contents, and — once a few hours —
 * the day's health numbers going the other way.
 */
object Sync {
    private const val TAG = "UltronSync"
    private val lock = Any()

    /** Background thread only. Returns the new announcements (already notified unless `inApp`). */
    fun run(ctx: Context, inApp: Boolean = false): List<PcBrain.Notice> = synchronized(lock) {
        val prefs = Prefs(ctx)
        val c = prefs.config()
        if (!c.hasPc) return emptyList()
        val pc = PcBrain(c.pcUrl, c.pcPassword, prefs)
        var fresh = emptyList<PcBrain.Notice>()
        try {
            val after = prefs.lastNoticeSeq
            val (items, latest) = pc.notices(maxOf(after, 0))
            // First sync: start from now rather than replaying the whole log.
            if (after >= 0) {
                fresh = items
                for (n in items.takeLast(5)) {
                    // A security photo always gets a notification, even with the app open.
                    val picture = n.image?.let { id ->
                        runCatching { pc.securityPhoto(id).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
                    }
                    if (!inApp || n.image != null) Notices.show(ctx, (n.seq % 100_000).toInt(), n.title, n.text, picture = picture)
                }
            }
            prefs.lastNoticeSeq = latest
        } catch (e: Exception) {
            Log.i(TAG, "notices: ${e.message}")
            return emptyList() // PC not reachable: try again next time
        }
        try {
            val s = pc.summary()
            prefs.widgetJson = JSONObject()
                .put("upcoming", JSONArray(s.upcoming.map { JSONObject().put("text", it.text).put("dueAt", it.dueAt) }))
                .put("routines", JSONArray(s.routines))
                .put("at", System.currentTimeMillis())
                .toString()
            UltronWidget.refresh(ctx)
        } catch (e: Exception) {
            Log.i(TAG, "summary: ${e.message}")
        }
        pushLocation(ctx, pc)
        if (System.currentTimeMillis() - prefs.lastHealthPush > 3 * 3_600_000L && Health.granted(ctx)) {
            try {
                pc.pushHealth(Health.days(ctx, 3))
                prefs.lastHealthPush = System.currentTimeMillis()
            } catch (e: Exception) {
                Log.i(TAG, "health: ${e.message}")
            }
        }
        fresh
    }
}

/** The phone's last known location (no new fix, no battery cost), for the PC's "time to leave" alerts. */
@SuppressLint("MissingPermission") // checked just below
private fun pushLocation(ctx: Context, pc: PcBrain) {
    if (!ctx.hasPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)) return
    val sp = ctx.getSharedPreferences("ultron_sync", Context.MODE_PRIVATE)
    val lm = ctx.getSystemService(LocationManager::class.java)
    val loc = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        .maxByOrNull { it.time } ?: return
    if (loc.time <= sp.getLong("location_at", 0)) return
    try {
        pc.pushLocation(loc.latitude, loc.longitude, loc.accuracy, loc.time)
        sp.edit().putLong("location_at", loc.time).apply()
    } catch (e: Exception) {
        Log.i("UltronSync", "location: ${e.message}")
    }
}

/** Runs [Sync] every ~15 minutes (Android's shortest period) while online. */
class SyncJob : JobService() {
    private val worker = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        worker.execute {
            Sync.run(applicationContext)
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    companion object {
        private const val ID = 7

        fun schedule(ctx: Context) {
            val js = ctx.getSystemService(JobScheduler::class.java)
            if (js.getPendingJob(ID) != null) return
            // Never worth crashing over: the app works without it, just no notifications.
            runCatching {
                js.schedule(
                    JobInfo.Builder(ID, ComponentName(ctx, SyncJob::class.java))
                        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                        .setPeriodic(15 * 60_000L)
                        .setPersisted(true)
                        .build(),
                )
            }.onFailure { Log.w("UltronSync", "couldn't schedule: ${it.message}") }
        }
    }
}

/** After a restart: the sync job and the place alerts come back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        SyncJob.schedule(context)
        Places(context).registerAll()
    }
}
