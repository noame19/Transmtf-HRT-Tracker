package com.smirnovayama.hrttracker

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * AlarmManager + NotificationManager bridge for the medication plan
 * reminders. Lives entirely on the Kotlin side so R8 can reach every
 * `@JvmStatic` method from Rust via JNI without stripping the class —
 * `proguard-rules.pro` keeps `NotificationScheduler` and the companion
 * receivers whole.
 *
 * The Rust layer is a thin shim: it forwards the user's plan JSON here and
 * we do the scheduling locally. We intentionally use
 * `AlarmManager.setWindow()` (inexact) so the app does NOT need
 * `SCHEDULE_EXACT_ALARM` — a few minutes of drift is fine for a daily
 * medication reminder and avoids the Play Store extra-permission prompt.
 */
object NotificationScheduler {
    private const val TAG = "NotificationScheduler"
    private const val CHANNEL_ID = "hrt_reminders"
    private const val CHANNEL_NAME = "Medication Reminders"
    private const val CHANNEL_DESC = "Notifications for scheduled medication doses."

    private const val PLANS_PREFS = "hrt_notification_cache"
    private const val PLANS_JSON_KEY = "plans_json"
    private const val PENDING_KEY = "pending_deep_link"

    /** 30-day scheduling horizon — anything further is dropped, the next
     *  reminder sync (or the boot receiver) will re-fill the window. */
    private const val HORIZON_DAYS = 30L

    /**
     * Idempotent channel creation. API 26+ requires a channel for any
     * notification; older devices get the legacy notification path (which
     * still works fine because `NotificationCompat.Builder` accepts the
     * channel id unconditionally and silently ignores it pre-Oreo).
     */
    @JvmStatic
    fun ensureChannel(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val existing = nm.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = CHANNEL_DESC
                    enableVibration(true)
                }
                nm.createNotificationChannel(ch)
                Log.i(TAG, "ensureChannel: created channel $CHANNEL_ID")
            }
        }
        return true
    }

    /**
     * Whether the user has notifications globally enabled for our app. On
     * API < 33 there is no per-app runtime permission to request, so we just
     * trust the system toggle.
     */
    @JvmStatic
    fun areNotificationsEnabled(context: Context): Boolean {
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * Re-derive every due moment from the supplied plan list and register
     * one inexact alarm per moment. Idempotent: we first wipe every alarm
     * the app ever registered (tracked via SharedPreferences) so stale
     * entries from removed/edited plans can't linger.
     *
     * Returns the count of alarms actually scheduled (for logging / debug).
     */
    @JvmStatic
    fun scheduleReminders(context: Context, plansJson: String): Int {
        ensureChannel(context)

        // Persist the plans list so the boot receiver can re-schedule after
        // a device restart without a roundtrip to JS.
        prefs(context).edit().putString(PLANS_JSON_KEY, plansJson).apply()

        // Wipe existing alarms first. The request codes are derived from
        // (planId.hashCode() xor isoTime.hashCode()) so we can't enumerate
        // them without remembering — track the active ones in prefs.
        val activeCodes = prefs(context).getStringSet("active_request_codes", emptySet()) ?: emptySet()
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        for (codeStr in activeCodes) {
            val code = codeStr.toIntOrNull() ?: continue
            am.cancel(buildPendingIntent(context, code))
        }
        prefs(context).edit().remove("active_request_codes").apply()

        val plans = try {
            parsePlans(plansJson)
        } catch (e: Exception) {
            Log.e(TAG, "scheduleReminders: invalid plans JSON", e)
            return 0
        }
        if (plans.isEmpty()) return 0

        val now = System.currentTimeMillis()
        val horizonMs = now + TimeUnit.DAYS.toMillis(HORIZON_DAYS)
        val newCodes = HashSet<String>()
        var count = 0

        for (plan in plans) {
            if (!plan.enabled) continue
            val moments = planUpcomingMoments(plan, now, horizonMs)
            for ((moment, isoTime) in moments) {
                val requestCode = (plan.id.hashCode() xor isoTime.hashCode())
                val pi = buildPendingIntent(context, requestCode, plan.id, moment)
                // setWindow gives ±5min drift and dodges SCHEDULE_EXACT_ALARM.
                val windowMs = TimeUnit.MINUTES.toMillis(5)
                am.setWindow(AlarmManager.RTC_WAKEUP, moment, windowMs, pi)
                newCodes.add(requestCode.toString())
                count++
            }
        }

        prefs(context).edit().putStringSet("active_request_codes", newCodes).apply()
        Log.i(TAG, "scheduleReminders: $count alarms across ${plans.size} plans")
        return count
    }

    /** Drop alarms whose requestCode maps back to any of the supplied ids.
     *  JSON shape: a top-level array of plan-id strings. */
    @JvmStatic
    fun cancelReminders(context: Context, planIdsJson: String): Int {
        val ids = try {
            val arr = JSONArray(planIdsJson)
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        } catch (e: Exception) {
            Log.e(TAG, "cancelReminders: bad JSON", e)
            return 0
        }
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val activeCodes = prefs(context).getStringSet("active_request_codes", emptySet()) ?: emptySet()
        // We can't reverse-engineer planId from requestCode, so wipe
        // everything and re-schedule from the cached plan list excluding
        // the removed ids. Simpler than tracking (code → planId) separately.
        val cached = prefs(context).getString(PLANS_JSON_KEY, "[]") ?: "[]"
        val remaining = try {
            val arr = JSONArray(cached)
            (0 until arr.length()).map { arr.getJSONObject(it) }
                .filter { !ids.contains(it.optString("id")) }
        } catch (e: Exception) { emptyList() }
        val newJson = JSONArray().apply { remaining.forEach { put(it) } }.toString()
        return scheduleReminders(context, newJson.toString())
    }

    /** Cancel every alarm + clear the cached plan list. */
    @JvmStatic
    fun cancelAll(context: Context): Int {
        val activeCodes = prefs(context).getStringSet("active_request_codes", emptySet()) ?: emptySet()
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        for (codeStr in activeCodes) {
            val code = codeStr.toIntOrNull() ?: continue
            am.cancel(buildPendingIntent(context, code))
        }
        prefs(context).edit()
            .remove("active_request_codes")
            .remove(PLANS_JSON_KEY)
            .apply()
        return activeCodes.size
    }

    /** Returns the deep-link JSON written by `ReminderReceiver` after firing
     *  (one-shot — the JS side calls clearPending immediately). */
    @JvmStatic
    fun readPending(context: Context): String? {
        return prefs(context).getString(PENDING_KEY, null)
    }

    /** Drop the pending deep-link entry (called by Rust right after readPending). */
    @JvmStatic
    fun clearPending(context: Context) {
        prefs(context).edit().remove(PENDING_KEY).apply()
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PLANS_PREFS, Context.MODE_PRIVATE)

    private fun buildPendingIntent(
        context: Context,
        requestCode: Int,
        planId: String? = null,
        scheduledAtMs: Long = 0,
    ): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            action = "com.smirnovayama.hrttracker.REMINDER_FIRE"
            if (planId != null) {
                putExtra("planId", planId)
                putExtra("scheduledAtMs", scheduledAtMs)
            }
        }
        // FLAG_IMMUTABLE is required on API 23+; FLAG_UPDATE_CURRENT lets
        // us re-use the same requestCode when re-scheduling.
        var flags = PendingIntent.FLAG_IMMUTABLE
        if (planId != null) flags = flags or PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }

    /**
     * Compute upcoming moments in [fromMs, toMs] from a single plan's
     * schedule. Mirrors the TypeScript `dueMomentsInRange` so the Android
     * scheduler agrees with what the UI previews.
     *
     * Returns pairs of (epochMs, isoTime) so we can both schedule and
     * serialise a stable identifier into the request code.
     */
    private fun planUpcomingMoments(plan: ParsedPlan, fromMs: Long, toMs: Long): List<Pair<Long, String>> {
        val out = mutableListOf<Pair<Long, String>>()
        val times = plan.times
        if (times.isEmpty()) return out
        val startCal = plan.startCal
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = fromMs }
        // Cap the loop at 366 days as a safety net.
        for (i in 0 until 366) {
            val day = java.util.Calendar.getInstance().apply {
                timeInMillis = startCal.timeInMillis
                add(java.util.Calendar.DAY_OF_YEAR, i)
            }
            if (!matchesScheduleDay(plan, day)) continue
            for ((h, m) in times) {
                val moment = java.util.Calendar.getInstance().apply {
                    timeInMillis = day.timeInMillis
                    set(java.util.Calendar.HOUR_OF_DAY, h)
                    set(java.util.Calendar.MINUTE, m)
                    set(java.util.Calendar.SECOND, 0)
                    set(java.util.Calendar.MILLISECOND, 0)
                }
                val ms = moment.timeInMillis
                if (ms < fromMs) continue
                if (ms >= toMs) continue
                if (plan.endMs != null && ms > plan.endMs!!) continue
                val isoTime = formatIsoLocal(ms)
                out.add(ms to isoTime)
            }
        }
        return out
    }

    private fun matchesScheduleDay(plan: ParsedPlan, day: java.util.Calendar): Boolean {
        return when (plan.scheduleKind) {
            "daily" -> true
            "every_n_days" -> {
                val interval = plan.intervalDays
                if (interval <= 0) return false
                val daysSinceStart = daysBetween(plan.startCal, day)
                if (daysSinceStart < 0) return false
                daysSinceStart % interval == 0
            }
            "weekly" -> {
                val weekdays = plan.weekdays
                if (weekdays.isEmpty()) return false
                val dow = day.get(java.util.Calendar.DAY_OF_WEEK) - 1 // 0=Sun..6=Sat
                weekdays.contains(dow)
            }
            else -> false
        }
    }

    private fun daysBetween(a: java.util.Calendar, b: java.util.Calendar): Int {
        val aMid = stripTime(a).timeInMillis
        val bMid = stripTime(b).timeInMillis
        return ((bMid - aMid) / 86400000L).toInt()
    }

    private fun stripTime(c: java.util.Calendar): java.util.Calendar {
        val out = c.clone() as java.util.Calendar
        out.set(java.util.Calendar.HOUR_OF_DAY, 0)
        out.set(java.util.Calendar.MINUTE, 0)
        out.set(java.util.Calendar.SECOND, 0)
        out.set(java.util.Calendar.MILLISECOND, 0)
        return out
    }

    /** Lightweight local-time formatter — `YYYY-MM-DDTHH:MM:SS`. */
    private fun formatIsoLocal(epochMs: Long): String {
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = epochMs }
        fun pad(n: Int) = if (n < 10) "0$n" else n.toString()
        return "${cal.get(java.util.Calendar.YEAR)}-${pad(cal.get(java.util.Calendar.MONTH) + 1)}-${pad(cal.get(java.util.Calendar.DAY_OF_MONTH))}T${pad(cal.get(java.util.Calendar.HOUR_OF_DAY))}:${pad(cal.get(java.util.Calendar.MINUTE))}:${pad(cal.get(java.util.Calendar.SECOND))}"
    }

    // ── ParsedPlan ─────────────────────────────────────────────────────────

    private data class ParsedPlan(
        val id: String,
        val enabled: Boolean,
        val scheduleKind: String,
        val intervalDays: Int,
        val weekdays: Set<Int>,
        val times: List<Pair<Int, Int>>,
        val startCal: java.util.Calendar,
        val endMs: Long?,
    )

    private fun parsePlans(json: String): List<ParsedPlan> {
        val arr = JSONArray(json)
        val out = mutableListOf<ParsedPlan>()
        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val id = obj.optString("id", "")
            if (id.isEmpty()) continue
            val enabled = obj.optBoolean("enabled", true)
            val sched = obj.optJSONObject("schedule") ?: continue
            val kind = sched.optString("kind", "")
            val interval = sched.optInt("intervalDays", 0)
            val wdsArr = sched.optJSONArray("weekdays")
            val weekdays = if (wdsArr != null) {
                (0 until wdsArr.length()).map { wdsArr.getInt(it) }.toSet()
            } else emptySet()
            val timesArr = sched.optJSONArray("times") ?: continue
            val times = (0 until timesArr.length()).mapNotNull { idx ->
                val s = timesArr.optString(idx, "")
                val parts = s.split(":")
                if (parts.size != 2) null
                else {
                    val h = parts[0].toIntOrNull() ?: return@mapNotNull null
                    val m = parts[1].toIntOrNull() ?: return@mapNotNull null
                    if (h !in 0..23 || m !in 0..59) null else (h to m)
                }
            }
            val startMs = obj.optLong("startDateH", 0L) * 3600000L
            val startCal = java.util.Calendar.getInstance().apply { timeInMillis = startMs }
            val endMs = if (obj.has("endDateH") && !obj.isNull("endDateH")) {
                obj.optLong("endDateH") * 3600000L
            } else null
            out.add(ParsedPlan(id, enabled, kind, interval, weekdays, times, startCal, endMs))
        }
        return out
    }
}