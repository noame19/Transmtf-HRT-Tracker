package com.smirnovayama.hrttracker

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File

/**
 * Static helper called from Rust via JNI to write an exported file (JSON
 * backup, debug log, etc.) into a location that can later be handed off
 * to the system "Open with" picker.
 *
 * Strategy (Android 10+ — primary path):
 *   - MediaStore.Downloads with RELATIVE_PATH = Download/{subdir}/
 *     This produces a real `content://media/external/downloads/{id}` URI
 *     that survives scoped storage and is consumable by any other app
 *     when paired with FLAG_GRANT_READ_URI_PERMISSION on the Intent.
 *   - ACTION_VIEW on this URI lets the user pick which app to open the
 *     JSON with — file managers, editors, cloud drives all participate.
 *
 * Strategy (Android 9 — fallback):
 *   - getExternalFilesDir(Downloads)/{subdir}/ — app-private external dir,
 *     works without WRITE_EXTERNAL_STORAGE under the strict sdcardfs
 *     mount that emulators / work-profile sandboxes enforce.
 *   - Returns a `file://` URI. StrictMode's death-on-file-uri-exposure
 *     must be disabled transiently at the call site (FileOpener.openWith)
 *     so the Intent doesn't crash with FileUriExposedException.
 *
 * subdir constraints: non-empty, no '/', no '..' (sanitised to prevent
 * path traversal). Sanitisation runs for both paths.
 *
 * Returns a [SaveResult] carrying:
 *   - `uri`: the openable URI string (`content://...` on Q+, `file://...`
 *     on legacy). Round-trips to FileOpener unchanged.
 *   - `displayPath`: human-readable path ("0/Download/HRT Tracker/foo.json"
 *     on Q+, absolute file path on legacy). Never the raw content:// id —
 *     those opaque ids are noise to humans.
 *   - `mime`: best-guess from filename extension.
 */
object DownloadWriter {

    /**
     * Pair of (openable URI, human-readable path, MIME) handed back to JS.
     * The fields match `SaveDataResult` in `lib.rs` (snake_case mapping
     * handled there).
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
            // Q (API 29) is where MediaStore.Downloads RELATIVE_PATH +
            // IS_PENDING semantics landed. We rely on that — anything
            // older falls back to the legacy path.
            try {
                saveViaMediaStore(context, safeSubdir, filename, bytes, mime)
            } catch (_: Exception) {
                // MediaStore can fail on vendor-skinned ROMs that re-route
                // external storage or block Downloads access even on Q+.
                // Fall back to app-private external dir so the user still
                // gets a working file (just without system-Downloads
                // visibility).
                saveViaLegacyFile(context, safeSubdir, filename, bytes, mime)
            }
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
        require(!trimmed.contains("/")) { "subdir cannot contain '/'" }
        return trimmed
    }

    /**
     * Primary save path on Android 10+. Inserts via MediaStore.Downloads
     * (the canonical way to write to the public Downloads collection
     * under scoped storage) and returns the system-issued content:// URI.
     *
     * This URI is the whole point of going through MediaStore:
     *   - It survives scoped storage (the raw _data column is null by
     *     design on Q+).
     *   - It works with FLAG_GRANT_READ_URI_PERMISSION — unlike file://,
     *     which the Android framework refuses to share with other apps.
     *   - It is consumable by any app that registered an Intent filter
     *     for the file's MIME, with no <provider> declaration on our side.
     *
     * If insert/openOutputStream/update returns null we throw — the
     * caller falls back to saveViaLegacyFile.
     */
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
        // human-readable path from RELATIVE_PATH + DISPLAY_NAME — matches
        // what the user sees in the system file manager.
        val displayPath = "0/${relativePath}/${filename}"
        // The toString() of a MediaStore content URI is exactly what other
        // apps want — "content://media/external/downloads/{id}". ACTION_VIEW
        // + FLAG_GRANT_READ_URI_PERMISSION on this URI is the standard way
        // to hand the file off to the system "Open with" picker.
        return SaveResult(uri.toString(), displayPath, mime)
    }

    /**
     * Fallback for Android 9 and below, plus any Q+ device where
     * MediaStore failed. Always writes to app-private external dir
     * (`getExternalFilesDir(Downloads)`) — never the public tree —
     * because:
     *   - Under sdcardfs "strict" mode (most emulators / work-profile
     *     sandboxes), untrusted_app uids cannot mkdir into the public
     *     Downloads tree.
     *   - Public Downloads requires WRITE_EXTERNAL_STORAGE, which we
     *     don't request on Q+ and don't want to request on legacy either
     *     (Google Play policy / privacy creep).
     *
     * Returns a FileProvider `content://` URI, NOT a `file://` URI:
     *   - `file://` triggers FileUriExposedException on API 24+ and even
     *     a StrictMode relax can't make other apps read an app-private
     *     dir (different UID, no read permission) — a dead end for the
     *     "open with" handoff.
     *   - FileProvider wraps the private file in a `content://` URI and
     *     the ACTION_VIEW intent carries FLAG_GRANT_READ_URI_PERMISSION,
     *     granting the receiving app a temporary read lease — the
     *     standard share-file mechanism (same as WeChat / file managers).
     *   - The provider + `<external-files-path name="downloads"
     *     path="Download/">` entry are declared in the CI manifest /
     *     res/xml patches, so this URI resolves at runtime.
     */
    private fun saveViaLegacyFile(
        context: Context,
        subdir: String,
        filename: String,
        bytes: ByteArray,
        mime: String,
    ): SaveResult {
        val appDir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), subdir)
        val file: File = if (appDir.exists() || appDir.mkdirs()) {
            File(appDir, filename).also { it.writeBytes(bytes) }
        } else {
            throw RuntimeException("Failed to create app-private Download dir: $appDir")
        }
        // displayPath keeps the human-readable on-disk path; the openable
        // URI is a FileProvider content:// that ACTION_VIEW can hand off.
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return SaveResult(uri.toString(), file.absolutePath, mime)
    }

    private fun guessMime(filename: String): String = when {
        filename.endsWith(".json", ignoreCase = true) -> "application/json"
        filename.endsWith(".png", ignoreCase = true) -> "image/png"
        filename.endsWith(".jpg", ignoreCase = true) || filename.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
        filename.endsWith(".txt", ignoreCase = true) -> "text/plain"
        else -> "application/octet-stream"
    }
}