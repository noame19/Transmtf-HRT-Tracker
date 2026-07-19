package com.smirnovayama.hrttracker

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * AlarmManager entry point. When a scheduled alarm fires, we:
 *   1. Look up the cached plan + its next moment from the intent extras.
 *   2. Build a regular heads-up notification in the system tray (NO
 *      fullScreenIntent, NO lock-screen takeover — the user explicitly
 *      asked for a normal notification despite using setAlarmClock under
 *      the hood).
 *   3. Write the deep-link JSON to SharedPreferences so the JS side can
 *      pick it up the next time the app is foregrounded.
 *   4. Schedule the next reminder for the same plan (incrementally — avoids
 *      a full table re-scan every minute).
 *
 * If notifications are disabled (channel muted or permission denied) we
 * silently drop the alert — the schedule itself stays intact so a future
 * re-enable will start firing again.
 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val planId = intent.getStringExtra("planId")
        val scheduledAtMs = intent.getLongExtra("scheduledAtMs", 0L)
        if (planId == null || scheduledAtMs <= 0) {
            Log.w(TAG, "onReceive: missing planId or scheduledAtMs — dropping")
            return
        }

        if (!NotificationScheduler.areNotificationsEnabled(context)) {
            Log.i(TAG, "onReceive: notifications disabled — skipping")
            return
        }
        NotificationScheduler.ensureChannel(context)

        // Pull the plan out of the cached JSON to get its display label.
        val prefs = context.getSharedPreferences("hrt_notification_cache", Context.MODE_PRIVATE)
        val plansJson = prefs.getString("plans_json", "[]") ?: "[]"
        val plan = findPlan(plansJson, planId)
        val title = plan?.title() ?: "该吃药了"
        val body = "用药计划已到：${plan?.summary() ?: planId}"

        // Deep-link back to MainActivity — the activity's onNewIntent will
        // stash planId + scheduledAtMs into the pending slot the JS side
        // polls.
        val deepLink = android.content.Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("deep_link_plan_id", planId)
            putExtra("deep_link_scheduled_at", scheduledAtMs)
        }
        val pi = PendingIntent.getActivity(
            context,
            planId.hashCode(),
            deepLink,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = NotificationCompat.Builder(context, "hrt_reminders")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)

        // Three action buttons — each opens MainActivity with a different
        // `deep_link_action` extra so JS poller can dispatch to the right
        // handler (smartAddEvent / handleDelayPlan). Distinct requestCodes
        // per action are required so PendingIntent.getActivity doesn't
        // overwrite an earlier button's intent.
        builder.addAction(0, "已服用", actionPendingIntent(context, planId, scheduledAtMs, "confirm"))
        builder.addAction(0, "推迟 1 天", actionPendingIntent(context, planId, scheduledAtMs, "delay_1d"))
        builder.addAction(0, "推迟 2 天", actionPendingIntent(context, planId, scheduledAtMs, "delay_2d"))

        val notification = builder.build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(planId.hashCode(), notification)

        // Stash the deep-link for the JS poller. We deliberately use the
        // same SharedPreferences that NotificationScheduler.readPending
        // reads from — Rust picks it up on the next invoke.
        val pendingJson = org.json.JSONObject().apply {
            put("planId", planId)
            put("scheduledAtMs", scheduledAtMs)
            put("firedAtMs", System.currentTimeMillis())
        }.toString()
        prefs.edit().putString("pending_deep_link", pendingJson).apply()

        // Schedule the NEXT moment for the same plan (cheap increment).
        scheduleNextForPlan(context, plansJson, planId, scheduledAtMs)
    }

    /**
     * Build a PendingIntent for a single notification action button. We
     * funnel every action through MainActivity (rather than a dedicated
     * BroadcastReceiver) because the DoseEvent list + plan overrides live
     * in JS localStorage — Kotlin has no way to mutate them safely without
     * an app launch. MainActivity.onNewIntent forwards the action to the
     * `pending_deep_link` SharedPreferences slot the JS poller watches.
     */
    private fun actionPendingIntent(
        context: Context,
        planId: String,
        scheduledAtMs: Long,
        action: String,
    ): PendingIntent {
        val intent = android.content.Intent(context, MainActivity::class.java).apply {
            this.action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("deep_link_plan_id", planId)
            putExtra("deep_link_scheduled_at", scheduledAtMs)
            putExtra("deep_link_action", action)
        }
        // Distinct requestCode per action so all three are simultaneously
        // alive in the system (otherwise PI dedup would collapse them).
        val requestCode = (planId.hashCode() xor action.hashCode())
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /**
     * Ask NotificationScheduler to re-derive the plan list and re-emit
     * alarms. Since `scheduleReminders` is idempotent (wipes everything
     * first), this naturally bumps the just-fired plan past its current
     * moment. Re-deriving the whole list is heavier than just computing
     * the next moment locally, but it keeps the Kotlin-side logic thin and
     * means the cached plan list stays the single source of truth.
     */
    private fun scheduleNextForPlan(context: Context, plansJson: String, planId: String, firedAtMs: Long) {
        // Shift the fired plan's startDateH forward by one cycle so the
        // recomputed due-moments skip the moment we just fired. Then call
        // scheduleReminders as usual.
        try {
            val arr = org.json.JSONArray(plansJson)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                if (obj.optString("id") != planId) continue
                val sched = obj.optJSONObject("schedule") ?: return
                val kind = sched.optString("kind")
                val startMs = obj.optLong("startDateH", 0L) * 3600000L
                if (kind == "every_n_days" && startMs < firedAtMs) {
                    val interval = sched.optInt("intervalDays", 1)
                    val daysSinceStart = ((firedAtMs - startMs) / 86400000L).toInt()
                    val cyclesDone = daysSinceStart / interval + 1
                    val newStart = (startMs + cyclesDone * interval * 86400000L) / 3600000L
                    obj.put("startDateH", newStart)
                }
                // For 'daily' / 'weekly' we don't need to shift — the next
                // moment is the following day/week automatically.
            }
            NotificationScheduler.scheduleReminders(context, arr.toString())
        } catch (e: Exception) {
            Log.e(TAG, "scheduleNextForPlan: failed", e)
        }
    }

    private fun findPlan(plansJson: String, planId: String): FoundPlan? {
        return try {
            val arr = org.json.JSONArray(plansJson)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                if (obj.optString("id") == planId) {
                    val ester = obj.optString("ester", "")
                    val route = obj.optString("route", "")
                    val dose = obj.optDouble("doseMG", 0.0)
                    return FoundPlan(ester, route, dose)
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    private data class FoundPlan(val ester: String, val route: String, val dose: Double) {
        fun title(): String = "$ester · $dose mg"
        fun summary(): String = "$ester · ${"%.2f".format(dose)} mg · $route"
    }

    companion object {
        private const val TAG = "ReminderReceiver"
    }
}