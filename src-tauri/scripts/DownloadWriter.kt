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
 * Returns the content:// uri string (API 29+) or absolute file path (API ≤28).
 */
object DownloadWriter {
    @JvmStatic
    fun saveToDownloads(context: Context, subdir: String, filename: String, contentB64: String): String {
        val safeSubdir = sanitizeSubdir(subdir)
        // Decode on Kotlin side so binary payloads (PNG, JPEG) survive — Rust
        // hands us a base64 String because JNI byte[] bridging is awkward.
        val bytes = android.util.Base64.decode(contentB64, android.util.Base64.DEFAULT)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, safeSubdir, filename, bytes)
        } else {
            saveViaLegacyFile(context, safeSubdir, filename, bytes)
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

    private fun sanitizeSubdir(s: String): String {
        val trimmed = s.trim().trim('/').trim()
        require(trimmed.isNotEmpty()) { "subdir cannot be empty" }
        require(!trimmed.contains("..")) { "subdir cannot contain '..'" }
        require(!trimmed.contains('/')) { "subdir cannot contain '/'" }
        return trimmed
    }

    private fun saveViaMediaStore(context: Context, subdir: String, filename: String, bytes: ByteArray): String {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/$subdir"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, guessMime(filename))
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
        return uri.toString()
    }

    private fun saveViaLegacyFile(context: Context, subdir: String, filename: String, bytes: ByteArray): String {
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
        if (appDir.exists() || appDir.mkdirs()) {
            val file = File(appDir, filename)
            file.writeBytes(bytes)
            return file.absolutePath
        }
        @Suppress("DEPRECATION")
        val root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val dir = File(root, subdir)
        if (!dir.exists() && !dir.mkdirs()) {
            throw RuntimeException("mkdirs failed for appDir=$appDir and publicDir=$dir")
        }
        val file = File(dir, filename)
        file.writeBytes(bytes)
        return file.absolutePath
    }

    private fun guessMime(filename: String): String = when {
        filename.endsWith(".json", ignoreCase = true) -> "application/json"
        filename.endsWith(".png", ignoreCase = true) -> "image/png"
        filename.endsWith(".jpg", ignoreCase = true) || filename.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
        filename.endsWith(".txt", ignoreCase = true) -> "text/plain"
        else -> "application/octet-stream"
    }
}
