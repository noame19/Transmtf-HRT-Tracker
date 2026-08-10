package com.smirnovayama.hrttracker

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Static helper called from Rust via JNI to write a file into the device's
 * public Downloads folder, optionally under a sub-directory.
 *
 * - API 29+ (Android 10): MediaStore.Downloads ContentResolver (no permission)
 *   - Uses RELATIVE_PATH to place the file under Download/{subdir}/
 * - API ≤28: Environment.getExternalStoragePublicDirectory(Downloads)/{subdir}/
 *   - Needs WRITE_EXTERNAL_STORAGE (declared in AndroidManifest with maxSdkVersion=28)
 *
 * subdir constraints: non-empty, no '/', no '..' (sanitised to prevent path traversal).
 *
 * Returns a [SaveResult] carrying both an openable URI (for ACTION_VIEW) and a
 * human-readable display path (for the "Saved to {path}" dialog text).
 *
 * - On API 29+ MediaStore under scoped storage does NOT expose the on-disk path
 *   (`_data` column is null by design). We synthesise `displayPath` from
 *   `RELATIVE_PATH + DISPLAY_NAME`, which matches what the user sees in their
 *   file manager (e.g. `0/Download/HRT Tracker/foo.json`). The `uri` is the
 *   real `content://media/external/downloads/{id}` we just inserted.
 * - On API ≤28 we return the absolute file path as the URI prefix `file://`
 *   (so ACTION_VIEW can consume it directly) and the same path as displayPath.
 *
 * We deliberately never surface the raw `content://media/external/downloads/{id}`
 * as display text — those opaque IDs are useless to humans and look like noise
 * in a dialog.
 */
object DownloadWriter {

    /**
     * Pair of (openable URI, human-readable path) handed back to JS. The fields
     * match `SaveDataResult` in `lib.rs` (snake_case mapping handled there).
     */
    data class SaveResult(
        val uri: String,
        val displayPath: String,
        val mime: String,
    )

    @JvmStatic
    fun saveToDownloads(context: Context, subdir: String, filename: String, contentB64: String): SaveResult {
        val safeSubdir = sanitizeSubdir(subdir)
        // Decode on Kotlin side so binary payloads (PNG, JPEG) survive — Rust
        // hands us a base64 String because JNI byte[] bridging is awkward.
        val bytes = android.util.Base64.decode(contentB64, android.util.Base64.DEFAULT)
        val mime = guessMime(filename)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, safeSubdir, filename, bytes, mime)
        } else {
            saveViaLegacyFile(context, safeSubdir, filename, bytes, mime)
        }
    }

    /**
     * 把 text 写到系统剪贴板，给前端 navigator.clipboard.writeText 的兜底。
     *
     * 原因：Tauri Android 的 WebView 默认没有 clipboard-write 权限，浏览器
     * navigator.clipboard.writeText 在桌面调用就抛 NotAllowedError。所以
     * 前端走 invoke('clipboard_write_text', { text })，Rust JNI 进来调这里。
     * ClipData.newPlainText / setPrimaryClip 是 API 1 兼容。
     *
     * 返回 "OK"。
     */
    @JvmStatic
    fun copyToClipboard(context: Context, text: String): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("text", text))
        return "OK"
    }

    /**
     * 把系统剪贴板的纯文本读到前端。`navigator.clipboard.readText` 在
     * Tauri Android 的 WebView 默认会因为 focus / 权限问题抛
     * NotAllowedError（`copyToClipboard` 注释里描述的同一类问题）。这里
     * 直接走 Android 的 ClipboardManager，跳过 WebView。
     *
     * 仅在 Android 上用；iOS / 桌面继续走 navigator.clipboard.readText。
     *
     * 返回剪贴板里的文本（没有纯文本则返回空串）。
     */
    @JvmStatic
    fun readFromClipboard(context: Context): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        val item = clip.getItemAt(0)
        // coerceToText handles plain text / HTML / URI / Intent uniformly,
        // matching what the user "sees" when they paste into a normal text
        // field. The CoerceDescriptor flag is null because we have no UI
        // context here — null falls back to text-only resolution which is
        // exactly what the JS-side readText would return.
        return item.coerceToText(context).toString()
    }

    private fun sanitizeSubdir(s: String): String {
        val trimmed = s.trim().trim('/').trim()
        require(trimmed.isNotEmpty()) { "subdir cannot be empty" }
        require(!trimmed.contains("..")) { "subdir cannot contain '..'" }
        require(!trimmed.contains('/')) { "subdir cannot contain '/'" }
        return trimmed
    }

    private fun saveViaMediaStore(
        context: Context,
        subdir: String,
        filename: String,
        bytes: ByteArray,
        mime: String,
    ): SaveResult {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/$subdir"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, relativePath)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw RuntimeException("MediaStore.insert returned null")
        resolver.openOutputStream(uri)?.use { out ->
            out.write(bytes)
            out.flush()
        } ?: throw RuntimeException("openOutputStream returned null")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        // API 29+ under scoped storage does not expose the on-disk path
        // (MediaStore.Downloads.DATA column is null by design). Compose a
        // human-readable path from RELATIVE_PATH + DISPLAY_NAME — matches what
        // the user sees in the system file manager.
        val displayPath = "0/${relativePath}/${filename}"
        return SaveResult(uri.toString(), displayPath, mime)
    }

    private fun saveViaLegacyFile(
        context: Context,
        subdir: String,
        filename: String,
        bytes: ByteArray,
        mime: String,
    ): SaveResult {
        // Some devices (and many Android emulators / cloud-phone sandboxes) mount
        // /storage/emulated/0 via sdcardfs in "strict" mode (fsuid=1023, mask=6,
        // default_normal). Under that mount untrusted_app uids cannot mkdir new
        // subdirs under the public Download tree, so Environment.getExternal
        // StoragePublicDirectory(Downloads)/<subdir> throws EACCES. The path
        // under getExternalFilesDir() is app-owned, bypasses the sdcardfs gate,
        // and works on real devices and emulators alike. Real public Download
        // is attempted as a fallback for users who actually want the file in
        // the system Downloads folder on a non-strict device.
        val appDir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), subdir)
        val file: File = if (appDir.exists() || appDir.mkdirs()) {
            File(appDir, filename).also { it.writeBytes(bytes) }
        } else {
            @Suppress("DEPRECATION")
            val root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val dir = File(root, subdir)
            if (!dir.exists() && !dir.mkdirs()) {
                throw RuntimeException("mkdirs failed for appDir=$appDir and publicDir=$dir")
            }
            File(dir, filename).also { it.writeBytes(bytes) }
        }
        // On legacy storage the on-disk path IS the openable path. Prefix
        // with file:// so ACTION_VIEW consumes it the same way as a content://
        // URI on API 29+.
        return SaveResult("file://${file.absolutePath}", file.absolutePath, mime)
    }

    private fun guessMime(filename: String): String = when {
        filename.endsWith(".json", ignoreCase = true) -> "application/json"
        filename.endsWith(".png", ignoreCase = true) -> "image/png"
        filename.endsWith(".jpg", ignoreCase = true) || filename.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
        filename.endsWith(".txt", ignoreCase = true) -> "text/plain"
        else -> "application/octet-stream"
    }
}
