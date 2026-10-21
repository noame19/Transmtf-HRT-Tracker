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

        // Record the fire BEFORE any early return so the health panel can show
        // "alarms are actually firing" even while notifications are muted.
        val prefs = context.getSharedPreferences("hrt_notification_cache", Context.MODE_PRIVATE)
        prefs.edit()
            .putLong("health_last_fire_at", System.currentTimeMillis())
            .apply()

        if (!NotificationScheduler.areNotificationsEnabled(context)) {
            // Do NOT return early. Previously this dropped the alert AND left
            // the alarm chain un-advanced, so turning notifications back on
            // later produced... nothing, because the chain had already run dry
            // at the horizon edge. Advance the schedule first, then bail.
            Log.i(TAG, "onReceive: notifications disabled — advancing schedule only")
            scheduleNextForPlan(context, prefs.getString("plans_json", "[]") ?: "[]", planId, scheduledAtMs)
            return
        }
        NotificationScheduler.ensureChannel(context)

        // Pull the plan out of the cached JSON to get its display label.
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
            actionRequestCode(planId, scheduledAtMs, "body"),
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
        // Key on (plan, scheduled moment) rather than plan alone. With the old
        // plan-only id, a plan with two times a day had its second notification
        // silently REPLACE the first — the user saw one reminder where they
        // should have seen two. Still stable per moment, so onNewIntent's
        // NotificationManager.cancel(notificationIdFor(...)) matches.
        nm.notify(notificationIdFor(planId, scheduledAtMs), notification)

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
        // Distinct requestCode per (plan, moment, action). The moment has to
        // be part of it: with only plan+action, FLAG_UPDATE_CURRENT made every
        // future occurrence of the same action reuse ONE PendingIntent whose
        // extras pointed at the most recently built moment. Tapping 已服用 on
        // an older notification then recorded the wrong scheduled time.
        val requestCode = actionRequestCode(planId, scheduledAtMs, action)
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
                    // 注意这里必须用 optDouble：贴片常见 3.5 天周期，optInt 会把它
                    // 截成 3，镇点（startDateH）就被推到错误的一天，下一次通知直接偏掉。
                    // 改成毫秒累加后，与 TS 侧 occurrencesPerDay 的数学保持同构。
                    val intervalDays = sched.optDouble("intervalDays", 1.0)
                    if (intervalDays > 0.0) {
                        val intervalMs = (intervalDays * 86400000.0).toLong()
                        val cyclesDone = (firedAtMs - startMs) / intervalMs + 1
                        val newStart = (startMs + cyclesDone * intervalMs) / 3600000L
                        obj.put("startDateH", newStart)
                    }
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

    /**
     * Coerce an arbitrary (planId, moment, action) triple into the 32-bit int
     * Android requires, without the collision-prone `hashCode()` xor chains
     * that were here before.
     *
     * The old scheme (`planId.hashCode() xor action.hashCode()`) ignored the
     * scheduled moment entirely, so two occurrences of the same plan shared
     * one PendingIntent; `FLAG_UPDATE_CURRENT` then rewrote its extras every
     * time a later alarm was scheduled, and tapping 已服用 on the notification
     * that was still on screen sent the *other* moment's timestamp.
     *
     * XOR of two hashes is also a weak mixer — `a.hashCode()` xor
     * `b.hashCode()` collides far more often than a proper hash. We now fold
     * the moment in and run it through a small avalanche step.
     */
    private fun actionRequestCode(planId: String, scheduledAtMs: Long, action: String): Int {
        var h = planId.hashCode()
        h = h * 31 + (scheduledAtMs xor (scheduledAtMs ushr 32)).toInt()
        h = h * 31 + action.hashCode()
        // Final avalanche so nearby inputs don't land on nearby codes.
        h = h xor (h ushr 16)
        h *= 0x85ebca6b.toInt()
        h = h xor (h ushr 13)
        h *= 0xc2b2ae35.toInt()
        h = h xor (h ushr 16)
        return h
    }

    /** Stable per-(plan, moment) notification id. */
    private fun notificationIdFor(planId: String, scheduledAtMs: Long): Int =
        actionRequestCode(planId, scheduledAtMs, "notification")

    private data class FoundPlan(val ester: String, val route: String, val dose: Double) {
        fun title(): String = "$ester · $dose mg"
        fun summary(): String = "$ester · ${"%.2f".format(dose)} mg · $route"
    }

    companion object {
        private const val TAG = "ReminderReceiver"
    }
}