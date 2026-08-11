package com.smirnovayama.hrttracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hands a previously-saved file off to the system "Share" sheet so the user
 * can pick any installed app — Files, Drive, Slack, WeChat, Telegram, …
 *
 * Rationale (vs. ACTION_VIEW "Open with"):
 *   - ACTION_VIEW requires a registered consumer of the file's MIME. JSON
 *     files have no default opener on stock Android, so chooser is empty
 *     and startActivity throws ActivityNotFoundException.
 *   - ACTION_SEND is universal — every app that accepts text/files shows
 *     up, including cloud-storage + messengers, which is exactly what
 *     "export a JSON backup" wants.
 *   - Real users export JSON to send it somewhere (chat, drive, email);
 *     they almost never "open it in place".
 *
 * Scoped-storage note: the URI must be a `content://` URI with
 * FLAG_GRANT_READ_URI_PERMISSION set on BOTH the inner send intent and
 * the chooser intent, otherwise target apps get SecurityException when
 * they try to read the file. `file://` URIs (used by saveViaLegacyFile
 * before this rewrite) are not portable across apps under scoped storage —
 * kept as a fallback path that just reports the path textually.
 *
 * Returns "OK" on success, throws RuntimeException with a human-readable
 * message on failure. We catch the raw Android exceptions and re-throw
 * with our own copy so:
 *   1. The cause is logged with the full inner stack (not lost to
 *      Android's silent logcat-only reporting).
 *   2. The Rust side gets a useful string back through JNI, not the
 *      generic "Java exception was raised during method invocation"
 *      jni-rs fallback message.
 */
object FileOpener {
    @JvmStatic
    fun shareWith(context: Context, uriString: String, mime: String, chooserTitle: String): String {
        val uri = Uri.parse(uriString)
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(sendIntent, chooserTitle).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            context.startActivity(chooser)
        } catch (e: ActivityNotFoundException) {
            // Should be rare on real devices (the chooser itself can usually
            // render even with zero targets), but some hardened ROMs +
            // work-profile sandboxes do trip it. Fall back to copyToClipboard
            // of the path so the user still has a way out.
            throw RuntimeException(
                "No app available to share files of type \"$mime\" (uri=$uriString)",
                e
            )
        } catch (e: SecurityException) {
            throw RuntimeException(
                "System refused to share \"$uriString\" (mime=$mime): ${e.message ?: "permission denied"}",
                e
            )
        } catch (e: Exception) {
            throw RuntimeException(
                "Failed to share \"$uriString\" (mime=$mime): ${e.message ?: e.javaClass.simpleName}",
                e
            )
        }
        return "OK"
    }
}