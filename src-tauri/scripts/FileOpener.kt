package com.smirnovayama.hrttracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hands a previously-saved file off to the system "Open with" picker.
 *
 * The save flow (DownloadWriter) returns a content:// or file:// URI plus a
 * MIME type. We wrap that in an ACTION_VIEW Intent and wrap *that* in
 * Intent.createChooser so the user always gets to pick which app opens the
 * file — even if there's a default registered. This is the only way to
 * surface files saved to MediaStore.Downloads to other apps (Files, Drive,
 * Slack, …) under Android 11+ scoped storage: FLAG_GRANT_READ_URI_PERMISSION
 * gives them a temporary read lease on the content:// URI.
 *
 * On API ≤28 the URI is file:// — those apps don't need the flag but it's
 * harmless when set.
 *
 * Note: FLAG_ACTIVITY_NEW_TASK is required because Rust invokes us with the
 * application Context, not an Activity Context.
 *
 * Returns "OK" on success, throws otherwise. We deliberately catch and
 * re-throw as RuntimeException so the message lands back on the Rust side
 * via JNI — without the try/catch the Android framework would just log to
 * logcat and Rust would return Ok(true), masking the real cause (e.g. no
 * app handles the MIME, missing grant, security exception).
 */
object FileOpener {
    @JvmStatic
    fun openWith(context: Context, uriString: String, mime: String): String {
        val uri = Uri.parse(uriString)
        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(viewIntent, "Open with").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            context.startActivity(chooser)
        } catch (e: ActivityNotFoundException) {
            throw RuntimeException(
                "No app available to open files of type \"$mime\" (uri=$uriString)",
                e
            )
        } catch (e: SecurityException) {
            // e.g. another app is in foreground / chooser blocked.
            throw RuntimeException(
                "System refused to open \"$uriString\" (mime=$mime): ${e.message}",
                e
            )
        } catch (e: Exception) {
            throw RuntimeException(
                "Failed to open \"$uriString\" (mime=$mime): ${e.message}",
                e
            )
        }
        return "OK"
    }
}
