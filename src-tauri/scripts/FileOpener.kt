package com.smirnovayama.hrttracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.StrictMode

/**
 * Hands a previously-saved file off to the system "Open with" picker so
 * the user can pick which installed app consumes it — file managers,
 * editors, cloud drives, anything that registered an Intent filter for
 * the file's MIME.
 *
 * URI scheme handling:
 *   - `content://` (Android 10+ MediaStore path): straight ACTION_VIEW +
 *     FLAG_GRANT_READ_URI_PERMISSION. The MediaStore URI is built for
 *     exactly this — FLAG_GRANT_READ_URI_PERMISSION hands the receiving
 *     app a temporary read lease without us needing a <provider>.
 *   - `file://` (Android 9 fallback, app-private external dir):
 *     ACTION_VIEW + FLAG_GRANT_READ_URI_PERMISSION (the flag is a no-op
 *     on file:// but harmless), wrapped in a transient
 *     StrictMode.disableDeathOnFileUriExposure() so the call survives
 *     Android 7+'s FileUriExposedException kill. The receiving app can
 *     still read the file because it's the same UID's app-private dir.
 *
 * Result format: a tagged string the Rust side parses:
 *   - "OK"         on success
 *   - "ERR:<msg>"   on any failure (msg is human-readable Chinese)
 *
 * Why tagged-string instead of throwing a RuntimeException:
 *   jni-rs 0.21 returns a generic `Error::JavaException` ("Java exception
 *   was raised during method invocation") when it detects a pending
 *   exception on the JNIEnv, instead of surfacing the actual
 *   `Throwable.toString()` content. That makes the error invisible to
 *   the JS layer. Tagged-string return values cross the JNI boundary
 *   as plain UTF-8 without any exception-handling layer getting in
 *   the way, so the user gets the real diagnostic message instead of
 *   a useless wrapper.
 */
object FileOpener {
    @JvmStatic
    fun openWith(context: Context, uriString: String, mime: String): String {
        val uri = Uri.parse(uriString)
        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        // For file:// URIs on API 24+ the system refuses to hand them to
        // other apps (FileUriExposedException). The only reliable escape
        // hatch is to relax StrictMode *only* around this startActivity
        // call — we don't want a global policy change because that would
        // hide real bugs elsewhere.
        //
        // content:// URIs (Android 10+) don't need this — the framework
        // was designed for them. Skip the relax for content:// to avoid
        // masking other StrictMode hits.
        val needStrictModeRelax = uriString.startsWith("file://") &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
        val previousVmPolicy = if (needStrictModeRelax) {
            StrictMode.getVmPolicy().also {
                StrictMode.setVmPolicy(
                    StrictMode.VmPolicy.Builder(it)
                        .disableDeathOnFileUriExposure()
                        .build()
                )
            }
        } else null

        try {
            try {
                context.startActivity(viewIntent)
            } catch (e: ActivityNotFoundException) {
                // The URI itself is fine, but no installed app can handle
                // it. The classic case: stock Android emulator with zero
                // JSON consumers — there's literally no app that can
                // open application/json. Surface this clearly so the
                // frontend knows it's not a permission / URI bug.
                return "ERR:已保存至下载目录，但未找到可打开 ${mime} 类型的应用。"
            } catch (e: SecurityException) {
                // E.g. another app is in foreground / chooser blocked.
                return "ERR:系统拒绝打开此文件 (${mime})：${e.message ?: "权限不足"}"
            } catch (e: Exception) {
                return "ERR:打开文件失败 (${mime})：${e.message ?: e.javaClass.simpleName}"
            }
            return "OK"
        } finally {
            if (previousVmPolicy != null) {
                StrictMode.setVmPolicy(previousVmPolicy)
            }
        }
    }
}