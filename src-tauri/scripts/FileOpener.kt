package com.smirnovayama.hrttracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hands a previously-saved file off to the system "Open with" picker so
 * the user can pick which installed app consumes it — file managers,
 * editors, cloud drives, anything that registered an Intent filter for
 * the file's MIME.
 *
 * URI scheme handling:
 *   - `content://` from MediaStore (Android 10+, the primary path):
 *     straight ACTION_VIEW + FLAG_GRANT_READ_URI_PERMISSION — the
 *     MediaStore URI is built for exactly this.
 *   - `content://` from FileProvider (Android 9 and below, the legacy
 *     fallback path): DownloadWriter.saveViaLegacyFile wraps the
 *     app-private file into a FileProvider URI, and the same
 *     FLAG_GRANT_READ_URI_PERMISSION grants the receiving app a
 *     temporary read lease.
 *
 * There is intentionally NO `file://` handling here anymore: sharing a
 * raw file:// URI to another app dies with FileUriExposedException on
 * API 24+ and no StrictMode relax can make another UID read an
 * app-private dir — it was a dead end. If a stray file:// URI ever
 * arrives it falls into the generic catch below and surfaces a Chinese
 * "ERR:" message instead of crashing.
 *
 * Result format: a tagged string the Rust side parses:
 *   - "OK"         on success
 *   - "ERR:<msg>"   on any failure (msg is human-readable Chinese)
 *
 * Why tagged-string instead of throwing a RuntimeException:
 *   jni-rs 0.21 returns a generic `Error::JavaException` ("Java exception
 *   was thrown") when it detects a pending exception on the JNIEnv,
 *   instead of surfacing the actual `Throwable.toString()` content. That
 *   makes the error invisible to the JS layer. Tagged-string return
 *   values cross the JNI boundary as plain UTF-8 without any
 *   exception-handling layer getting in the way, so the user gets the
 *   real diagnostic message instead of a useless wrapper.
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
    }
}
