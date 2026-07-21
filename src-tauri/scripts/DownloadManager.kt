package com.smirnovayama.hrttracker

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Companion to [DownloadWriter] — handles list / read / delete of files that
 * [DownloadWriter] previously wrote into the public Downloads folder under
 * `subdir`.
 *
 * Mirrors the writer's two-pronged storage strategy:
 *
 *  - API 29+ (Android 10): MediaStore.Downloads ContentResolver, filtered by
 *    `RELATIVE_PATH = Download/{subdir}/`. No runtime permission needed.
 *  - API ≤28 (Build.VERSION_CODES.P): app-private
 *    `getExternalFilesDir(Downloads)/{subdir}/` first — the same sdcardfs-safe
 *    fallback the writer uses on strict-mount devices — public
 *    `Download/{subdir}/` as secondary. Matches what the writer actually wrote
 *    so list/read stay symmetric.
 *
 * `subdir` sanitisation rules (mirrors DownloadWriter.sanitizeSubdir) and
 * `filename` path-traversal guard (`/` and `..` rejected) keep a malicious JS
 * caller from escaping the HRT Tracker folder. Only the Rust JNI shim is
 * expected to invoke these — JS never sees the JNI surface directly.
 */
object DownloadManager {

    /**
     * Lightweight row used by `list_files`. `uri` is the MediaStore content://
     * handle (or `file://...` on legacy) — surfaced so `read_file` can be a
     * direct round-trip without re-listing.
     */
    data class FileInfo(
        val filename: String,
        val uri: String,
        val sizeBytes: Long,
        val modifiedAtMs: Long,
    )

    data class FileContent(
        val contentB64: String,
    )

    @JvmStatic
    fun listFiles(context: Context, subdir: String): Array<FileInfo> {
        val safeSubdir = sanitizeSubdir(subdir)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            listViaMediaStore(context, safeSubdir)
        } else {
            listViaLegacyFile(context, safeSubdir)
        }
    }

    @JvmStatic
    fun readFile(context: Context, subdir: String, filename: String): FileContent {
        val safeSubdir = sanitizeSubdir(subdir)
        requireSafeFilename(filename)
        val bytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            readViaMediaStore(context, safeSubdir, filename)
                ?: throw RuntimeException("File not found: $safeSubdir/$filename")
        } else {
            readViaLegacyFile(context, safeSubdir, filename)
                ?: throw RuntimeException("File not found: $safeSubdir/$filename")
        }
        // NO_WRAP keeps it on a single line; JS `atob()` doesn't need line
        // breaks. We deliberately don't use `STANDARD` (which inserts
        // 76-column newlines) so the payload stays compact for IPC.
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        return FileContent(b64)
    }

    @JvmStatic
    fun deleteFile(context: Context, subdir: String, filename: String): Boolean {
        val safeSubdir = sanitizeSubdir(subdir)
        requireSafeFilename(filename)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            deleteViaMediaStore(context, safeSubdir, filename)
        } else {
            deleteViaLegacyFile(context, safeSubdir, filename)
        }
    }

    // ───────────────────────────────────────────────────────────────────
    // MediaStore (API 29+) implementations
    // ───────────────────────────────────────────────────────────────────

    private fun listViaMediaStore(context: Context, subdir: String): Array<FileInfo> {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/$subdir"
        val projection = arrayOf(
            MediaStore.Downloads._ID,
            MediaStore.Downloads.DISPLAY_NAME,
            MediaStore.Downloads.SIZE,
            MediaStore.Downloads.DATE_MODIFIED,
        )
        // RELATIVE_PATH is the canonical filter — DISPLAY_NAME alone would
        // match a file with the same name in another folder. Equality
        // (not LIKE) because RELATIVE_PATH is a directory-equality field.
        val selection = "${MediaStore.Downloads.RELATIVE_PATH} = ?"
        val selectionArgs = arrayOf("$relativePath/")
        val out = ArrayList<FileInfo>()
        resolver.query(collection, projection, selection, selectionArgs, null)?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Downloads._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.Downloads.SIZE)
            val dateCol = c.getColumnIndexOrThrow(MediaStore.Downloads.DATE_MODIFIED)
            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                val uri = ContentUris.withAppendedId(collection, id)
                out.add(
                    FileInfo(
                        filename = c.getString(nameCol) ?: continue,
                        uri = uri.toString(),
                        sizeBytes = c.getLong(sizeCol),
                        // DATE_MODIFIED is seconds since epoch; bump to ms
                        // so the JS Date constructor + 180-day math line up.
                        modifiedAtMs = c.getLong(dateCol) * 1000L,
                    ),
                )
            }
        }
        return out.toTypedArray()
    }

    private fun readViaMediaStore(context: Context, subdir: String, filename: String): ByteArray? {
        val info = listViaMediaStore(context, subdir).firstOrNull { it.filename == filename }
            ?: return null
        val uri = Uri.parse(info.uri)
        return context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }

    private fun deleteViaMediaStore(context: Context, subdir: String, filename: String): Boolean {
        val info = listViaMediaStore(context, subdir).firstOrNull { it.filename == filename }
            ?: return false
        return context.contentResolver.delete(Uri.parse(info.uri), null, null) > 0
    }

    // ───────────────────────────────────────────────────────────────────
    // Legacy file (API ≤28) implementations
    //
    // Same priority as DownloadWriter: app-private first (sdcardfs-safe),
    // public Download/{subdir}/ as secondary. Read returns null if neither
    // has the file (mirrors MediaStore "no row found" behaviour).
    // ───────────────────────────────────────────────────────────────────

    private fun listViaLegacyFile(context: Context, subdir: String): Array<FileInfo> {
        val out = ArrayList<FileInfo>()
        for (file in collectLegacyDirs(context, subdir)) {
            val files = file.listFiles() ?: continue
            for (f in files) {
                if (f.isFile) {
                    out.add(
                        FileInfo(
                            filename = f.name,
                            uri = "file://${f.absolutePath}",
                            sizeBytes = f.length(),
                            modifiedAtMs = f.lastModified(),
                        ),
                    )
                }
            }
        }
        return out.toTypedArray()
    }

    private fun readViaLegacyFile(context: Context, subdir: String, filename: String): ByteArray? {
        for (dir in collectLegacyDirs(context, subdir)) {
            val f = File(dir, filename)
            if (f.isFile) return f.readBytes()
        }
        return null
    }

    private fun deleteViaLegacyFile(context: Context, subdir: String, filename: String): Boolean {
        var deleted = false
        for (dir in collectLegacyDirs(context, subdir)) {
            val f = File(dir, filename)
            if (f.isFile && f.delete()) deleted = true
        }
        return deleted
    }

    /**
     * Return the candidate parent directories in lookup priority order.
     * Keeping the priority in one place avoids drift between read / delete
     * if the fallback chain ever grows.
     */
    private fun collectLegacyDirs(context: Context, subdir: String): List<File> {
        val dirs = ArrayList<File>(2)
        dirs.add(File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), subdir))
        @Suppress("DEPRECATION")
        val publicDir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            subdir,
        )
        dirs.add(publicDir)
        return dirs
    }

    // ───────────────────────────────────────────────────────────────────
    // Sanitisation — mirrors DownloadWriter.sanitizeSubdir so the two
    // classes can't disagree about what counts as a valid subdir.
    // ───────────────────────────────────────────────────────────────────

    private fun sanitizeSubdir(s: String): String {
        val trimmed = s.trim().trim('/').trim()
        require(trimmed.isNotEmpty()) { "subdir cannot be empty" }
        require(!trimmed.contains("..")) { "subdir cannot contain '..'" }
        require(!trimmed.contains('/')) { "subdir cannot contain '/'" }
        return trimmed
    }

    private fun requireSafeFilename(filename: String) {
        require(filename.isNotEmpty()) { "filename cannot be empty" }
        require(!filename.contains('/')) { "filename cannot contain '/'" }
        require(!filename.contains("..")) { "filename cannot contain '..'" }
        require(!filename.contains('\\')) { "filename cannot contain '\\\\'" }
    }
}
