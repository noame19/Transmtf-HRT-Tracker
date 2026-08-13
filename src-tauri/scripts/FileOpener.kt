package com.smirnovayama.hrttracker

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hands a previously-saved file off to the system "Open with" picker so
 * the user can pick which installed app consumes it.
 *
 * Two open strategies, picked by MIME:
 *   - `image/*` (share-image flow): plain ACTION_VIEW with the exact
 *     MIME — an image should only ever be offered to image-capable
 *     apps, listing text editors there only produces mojibake.
 *   - everything else (JSON exports, text): the "open everything"
 *     chooser below — Android's chooser filters by a single MIME and
 *     has no "list all apps" switch, so we union several candidate
 *     MIMEs: the main intent targets the catch-all MIME (file-manager bodies like
 *     ES/MT register the catch-all type) and EXTRA_INITIAL_INTENTS
 *     explicitly appends whatever resolves for text/plain,
 *     application/json and application/octet-stream (text editors,
 *     JSON tools, generic handlers). Every target carries
 *     FLAG_GRANT_READ_URI_PERMISSION so the FileProvider/MediaStore
 *     content:// URI stays readable for whichever app the user picks.
 *
 * There is intentionally NO `file://` handling: sharing a raw file://
 * URI to another app dies with FileUriExposedException on API 24+ and
 * no StrictMode relax can make another UID read an app-private dir.
 * If a stray file:// URI ever arrives it falls into the generic catch
 * below and surfaces a Chinese "ERR:" message instead of crashing.
 *
 * Result format: a tagged string the Rust side parses:
 *   - "OK"         on success
 *   - "ERR:<msg>"   on any failure (msg is human-readable Chinese)
 */
object FileOpener {
    @JvmStatic
    fun openWith(context: Context, uriString: String, mime: String): String {
        val uri = Uri.parse(uriString)
        return if (mime.startsWith("image/")) {
            openPlain(context, uri, mime)
        } else {
            openWithEverything(context, uri, mime)
        }
    }

    /** 单一 MIME 的普通 ACTION_VIEW,用于图片分享。 */
    private fun openPlain(context: Context, uri: Uri, mime: String): String {
        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(viewIntent)
            "OK"
        } catch (e: ActivityNotFoundException) {
            "ERR:已保存至下载目录，但未找到可打开 ${mime} 类型的应用。"
        } catch (e: SecurityException) {
            "ERR:系统拒绝打开此文件 (${mime})：${e.message ?: "权限不足"}"
        } catch (e: Exception) {
            "ERR:打开文件失败 (${mime})：${e.message ?: e.javaClass.simpleName}"
        }
    }

    /**
     * 文本类导出(JSON 等)的「开放所有」打开方式。
     *
     * Android 的 chooser 按 MIME 过滤,单一 MIME 永远只能覆盖一类
     * app(application/json → JSON 工具;text/plain → 文本编辑器;
     * 万能类型 → 文件管理器本体),没有"全部列出"的官方开关。这里把
     * 多类目标的并集拼进同一个 chooser:
     *   - 主 intent VIEW + 万能类型:文件管理器本体(ES/MT 等注册兜底
     *     万能类型的 app)
     *   - EXTRA_INITIAL_INTENTS:显式附加注册了 text/plain、
     *     application/json、application/octet-stream 的 app
     *
     * 每个附加 target 都带 FLAG_GRANT_READ_URI_PERMISSION,与主
     * intent 的授权一致,用户挑哪个 app 都能读文件。
     *
     * 注意:Android 11+ 包可见性限制下,queryIntentActivities 只
     * 返回本应用自己的组件,除非 manifest 声明了对应的 <queries>
     * (CI 注入 VIEW 万能类型)。chooser 主列表不受此限制。
     */
    private fun openWithEverything(context: Context, uri: Uri, mime: String): String {
        val pm = context.packageManager
        val baseIntent = Intent(Intent.ACTION_VIEW).apply {
            setData(uri)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(baseIntent, "打开方式").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val extraTargets = mutableListOf<Intent>()
        val seen = mutableSetOf<String>() // "package/class" 去重
        for (candidateMime in listOf("text/plain", "application/json", "application/octet-stream")) {
            if (candidateMime == mime) continue
            val probe = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, candidateMime)
            }
            for (ri in pm.queryIntentActivities(probe, 0)) {
                val ai = ri.activityInfo ?: continue
                val key = "${ai.packageName}/${ai.name}"
                if (!seen.add(key)) continue
                extraTargets += Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, candidateMime)
                    setClassName(ai.packageName, ai.name)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
        }

        val hasBase = pm.queryIntentActivities(baseIntent, 0).isNotEmpty()
        if (!hasBase && extraTargets.isEmpty()) {
            return "ERR:已保存至下载目录，但未找到可打开 ${mime} 类型的应用。"
        }
        if (extraTargets.isNotEmpty()) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extraTargets.toTypedArray())
        }

        return try {
            context.startActivity(chooser)
            "OK"
        } catch (e: ActivityNotFoundException) {
            "ERR:已保存至下载目录，但未找到可打开 ${mime} 类型的应用。"
        } catch (e: SecurityException) {
            "ERR:系统拒绝打开此文件 (${mime})：${e.message ?: "权限不足"}"
        } catch (e: Exception) {
            "ERR:打开文件失败 (${mime})：${e.message ?: e.javaClass.simpleName}"
        }
    }
}
