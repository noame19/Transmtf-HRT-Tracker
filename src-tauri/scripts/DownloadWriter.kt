package com.smirnovayama.hrttracker

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Static helper called from Rust via JNI to write a debug log file into the
 * device's public Downloads folder so the user can pull it off via USB / MTP.
 *
 * - API 29+ (Android 10): MediaStore.Downloads ContentResolver (no permission)
 * - API ≤28: Environment.getExternalStoragePublicDirectory(Downloads) (needs WRITE_EXTERNAL_STORAGE)
 *
 * Returns the absolute file path written (or content:// uri string on API 29+).
 */
object DownloadWriter {
    fun saveToDownloads(context: Context, filename: String, content: String): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, filename, content)
        } else {
            saveViaLegacyFile(filename, content)
        }
    }

    private fun saveViaMediaStore(context: Context, filename: String, content: String): String {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw RuntimeException("MediaStore.insert returned null")
        resolver.openOutputStream(uri)?.use { out ->
            out.write(content.toByteArray(Charsets.UTF_8))
            out.flush()
        } ?: throw RuntimeException("openOutputStream returned null")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri.toString()
    }

    private fun saveViaLegacyFile(filename: String, content: String): String {
        @Suppress("DEPRECATION")
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, filename)
        file.writeText(content, Charsets.UTF_8)
        return file.absolutePath
    }
}
