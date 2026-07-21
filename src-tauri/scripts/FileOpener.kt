package com.smirnovayama.hrttracker

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
 * Returns "OK" on success, throws otherwise (the JNI caller surfaces the
 * error to JS). Note: FLAG_ACTIVITY_NEW_TASK is required because Rust
 * invokes us with the application Context, not an Activity Context.
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
        context.startActivity(chooser)
        return "OK"
    }
}
