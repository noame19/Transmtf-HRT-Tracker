package com.smirnovayama.hrttracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Re-schedules every alarm after a device reboot (or an app update).
 * Without this, AlarmManager loses all our pending alarms the moment the
 * phone restarts and the user gets zero reminders until the next time the
 * app is opened and JS re-runs the reschedule effect.
 *
 * We intentionally read from the same SharedPreferences key
 * (`hrt_notification_cache/plans_json`) that NotificationScheduler writes,
 * so the cached plan list is the single source of truth across restarts.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        val prefs = context.getSharedPreferences("hrt_notification_cache", Context.MODE_PRIVATE)
        val plansJson = prefs.getString("plans_json", "[]") ?: "[]"
        if (plansJson == "[]" || plansJson.isEmpty()) {
            Log.i(TAG, "onReceive: no cached plans — skipping reschedule")
            return
        }
        try {
            val n = NotificationScheduler.scheduleReminders(context, plansJson)
            Log.i(TAG, "onReceive: rescheduled $n alarms after $action")
        } catch (e: Exception) {
            Log.e(TAG, "onReceive: reschedule failed", e)
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}