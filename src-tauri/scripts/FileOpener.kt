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
 *   - image MIME (share-image flow): plain ACTION_VIEW with the exact
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
     * 文本类导出(JSON 等)的「开放所有」打开/分享方式。
     *
     * Android 的 chooser 按 MIME 过滤,单一 MIME 永远只能覆盖一类
     * app,没有"全部列出"的官方开关。这里把多类目标的并集拼进
     * 同一个 chooser:
     *   - 主 intent ACTION_SEND + text/星 + EXTRA_STREAM:覆盖
     *     微信/QQ/蓝牙/邮件这些 IM 通道(它们响应 SEND text 星);
     *     视频/音乐/图片 app 不响应 text 星,自然不会出现在
     *     主列表,避免之前 catchAll 星/星 探测把 mxplayer/夸克
     *     视频拉进来的问题。
     *   - EXTRA_INITIAL_INTENTS:精确文本/文档类 MIME 的 VIEW
     *     目标(text/plain 文本编辑器、application/json JSON
     *     工具、text 星 文件管理器本体、application/octet-stream
     *     通用处理者)。每个 target 独立指定 ACTION_VIEW 打开文件。
     *
     * 关键平衡:不用 星/星 兜底 ⇒ 视频/音乐/图片 app 不会被拉进
     * 列表(它们只注册 video 星 / audio 星 / image 星 / 星/星,
     * 不响应文本类 MIME);MT 这类注册 text 星 的文件管理器天然
     * 在 text 星 探测里命中。
     *
     * 每个 target 都带 FLAG_GRANT_READ_URI_PERMISSION,用户挑
     * 哪个 app 都能读文件。
     *
     * 注意:Android 11+ 包可见性限制下,queryIntentActivities 只
     * 返回本应用自己的组件,除非 manifest 声明了对应的 <queries>
     * (CI 注入 VIEW text 星 + SEND text 星)。chooser 主列表
     * 不受此限制。
     */
    private fun openWithEverything(context: Context, uri: Uri, mime: String): String {
        val pm = context.packageManager
        // 主 intent 用 ACTION_SEND:IM 的"发送给朋友"文件分享标准入口。
        // text/星 覆盖纯文本、JSON、HTML 等所有文本子类,微信/QQ/
        // MT/蓝牙/邮件全部覆盖;视频/音乐/图片 app 不响应 text/星,
        // 自然不在主列表里。
        val baseIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/*"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(baseIntent, "打开方式").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        val extraTargets = mutableListOf<Intent>()
        val seen = mutableSetOf<String>() // "package/class" 去重
        // 主 intent 能解析到的 app 已出现在 chooser 主列表,附加
        // 列表先标记去重,避免重复显示。
        for (ri in pm.queryIntentActivities(baseIntent, 0)) {
            val ai = ri.activityInfo ?: continue
            seen.add("${ai.packageName}/${ai.name}")
        }
        // 附加 ACTION_VIEW 类:精确文本/文档 MIME,排除视频/音乐/
        // 图片。text/星 探测命中注册了通用文本处理的文件管理器
        // (MT 管理器等),不再用 星/星 兜底。
        val viewProbes = listOf(
            "text/plain" to "text/plain",
            "application/json" to "application/json",
            "text/*" to mime,
            "application/octet-stream" to mime,
        )
        for ((probeMime, targetMime) in viewProbes) {
            val probe = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, probeMime)
            }
            for (ri in pm.queryIntentActivities(probe, 0)) {
                val ai = ri.activityInfo ?: continue
                val key = "${ai.packageName}/${ai.name}"
                if (!seen.add(key)) continue
                extraTargets += Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, targetMime)
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
