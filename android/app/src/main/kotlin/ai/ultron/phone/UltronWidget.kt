package ai.ultron.phone

import ai.ultron.core.PcBrain
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Home-screen widget: tap to talk, what's coming up, one-tap routines. */
class UltronWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
        // Fetch fresh contents; Sync re-renders when it's done.
        val pending = goAsync()
        Thread {
            try {
                Sync.run(context.applicationContext)
            } finally {
                pending.finish()
            }
        }.start()
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ROUTINE) return super.onReceive(context, intent)
        val name = intent.getStringExtra(EXTRA_NAME) ?: return
        val pending = goAsync()
        Thread {
            try {
                val prefs = Prefs(context)
                val c = prefs.config()
                val msg = try {
                    PcBrain(c.pcUrl, c.pcPassword, prefs).runRoutine(name).ifBlank { "Done." }
                } catch (e: Exception) {
                    "Couldn't run it: ${e.message}"
                }
                Notices.show(context, name.hashCode(), name.replaceFirstChar { it.titlecase(Locale.ROOT) }, msg)
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val ACTION_ROUTINE = "ai.ultron.phone.WIDGET_ROUTINE"
        const val EXTRA_NAME = "name"
        private val SLOTS = intArrayOf(R.id.routine1, R.id.routine2, R.id.routine3)

        fun refresh(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, UltronWidget::class.java))
            if (ids.isNotEmpty()) render(ctx, manager, ids)
        }

        private fun render(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
            val views = RemoteViews(ctx.packageName, R.layout.widget_ultron)
            val talk = Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_LISTEN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            views.setOnClickPendingIntent(R.id.widgetTalk, PendingIntent.getActivity(ctx, 1, talk, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))

            val data = runCatching { JSONObject(Prefs(ctx).widgetJson) }.getOrNull()
            val upcoming = data?.optJSONArray("upcoming")
            val lines = (0 until (upcoming?.length() ?: 0)).map { i ->
                val u = upcoming!!.getJSONObject(i)
                "${whenOf(u.optString("dueAt"))}  ${u.optString("text")}"
            }
            views.setTextViewText(
                R.id.widgetUpcoming,
                when {
                    data == null -> "Connect the PC in ULTRON's settings to see what's coming up."
                    lines.isEmpty() -> "Nothing coming up."
                    else -> lines.joinToString("\n")
                },
            )
            val routines = data?.optJSONArray("routines")
            SLOTS.forEachIndexed { i, id ->
                val name = routines?.optString(i)?.takeIf { it.isNotBlank() && i < routines.length() }
                if (name == null) {
                    views.setViewVisibility(id, View.GONE)
                } else {
                    views.setViewVisibility(id, View.VISIBLE)
                    views.setTextViewText(id, name.uppercase(Locale.ROOT))
                    val run = Intent(ctx, UltronWidget::class.java).setAction(ACTION_ROUTINE).putExtra(EXTRA_NAME, name)
                    views.setOnClickPendingIntent(id, PendingIntent.getBroadcast(ctx, 10 + i, run, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                }
            }
            manager.updateAppWidget(ids, views)
        }

        private fun whenOf(iso: String): String = runCatching {
            val t = Instant.parse(iso).atZone(ZoneId.systemDefault())
            val today = java.time.LocalDate.now()
            val pattern = if (t.toLocalDate() == today) "h:mm a" else "EEE h:mm a"
            t.format(DateTimeFormatter.ofPattern(pattern, Locale.ENGLISH))
        }.getOrDefault("")
    }
}
