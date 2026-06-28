# 通用下载到 /sdcard/Download/HRT Tracker/ + Release APK + 应用名改 HRT Tracker — 设计文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 Android WebView 上失效的"下载文件"功能（导出图表 PNG + 导出 JSON 数据备份）统一通过 Rust + JNI 写到 `/sdcard/Download/HRT Tracker/` 公共目录；同时把 GitHub Actions 切成 release build 出 ~30-50MB APK；APK 应用名从 "Transmtf HRT Tracker" 改 "HRT Tracker"。

**Architecture:**
1. **DownloadWriter.kt 泛化**：把现有 `saveToDownloads(Context, filename, content)` 改为 `saveToDownloads(Context, subdir, filename, content)`。API 29+ 在 `MediaStore.Downloads` 集合下用 `RELATIVE_PATH` 列写入子目录；API ≤28 在 `getExternalStoragePublicDirectory(Downloads)/{subdir}/` 下创建子目录。Kotlin 端做 subdir 路径校验（防 `..` 越权）。
2. **Rust 新增 command**：`#[tauri::command] fn save_data_to_download(app: AppHandle, subdir: String, filename: String, content_b64: String) -> Result<String, String>`，通过 JNI 调更新后的 `DownloadWriter.saveToDownloads`，返回可见的 URI 字符串。
3. **前端改 invoke**：`ShareImageModal.handleDownload` 和 `SettingsPage.downloadFile` 都改用 `invoke('save_data_to_download', { subdir: 'HRT Tracker', filename, content_b64: base64(content) })`，删掉 detached `<a>` + `link.click()`。
4. **Workflow 切分**：
   - 新增 `.github/workflows/android-release.yml`：触发 `push: tags: v*.*.*` + `workflow_dispatch`；build 命令去掉 `--debug` flag；artifact name `android-release-apk`。
   - 改 `.github/workflows/android-debug.yml`：去掉 `push: tags` 触发，只留 `workflow_dispatch`（仅在 attach debugger 场景手动跑）；artifact name 保留 `android-debug-apk`。
5. **应用名**：`tauri.conf.json` 的 `productName` 和 `windows[0].title` 从 "Transmtf HRT Tracker" 改 "HRT Tracker"。Android 端应用名由 Tauri 在 init 时根据 `productName` 生成 `app_name` string resource，productName 改完后 init 重新生成即可生效。

**Tech Stack:**
- Rust: `jni = "0.21"`（已存在）+ `base64 = "0.22"`（新增）— Rust 端把 base64 解码后传给 Kotlin
- Kotlin: `MediaStore.Downloads.RELATIVE_PATH` (API 29+) / `File.mkdirs()` (API ≤28)
- Tauri 2.x command + invoke pattern（已有）
- 前端: 现有 React + lucide-react + i18n 模式
- GitHub Actions: 复用现有 ubuntu-latest + JDK 17 + Node 22 + Android SDK 31 + NDK 26

---

## 设计原则

1. **保持 UI/交互/功能不变**：按钮位置、点击行为、提示文案位置全部保持一致。区别只是底层从 `<a>.click()` 换成 `invoke`。
2. **最小权限**：复用 T11 已有的 `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion="28"`) 权限，不加新权限。
3. **同根因合并修**：导出图片 + 导出 JSON 都走同一个 `save_data_to_download` command，避免重复造轮子。
4. **零冗余 build 资源**：debug workflow 改手动触发，每次 push tag 只跑一次 release（节省 ~20 分钟/次）。
5. **i18n 完整**：所有新加的"已保存到 {path}" 提示走 4 语言翻译。
6. **零运行时开销**：不开 debug mode 时 `save_data_to_download` 是普通 invoke，开销可忽略。

---

## 后端架构

### DownloadWriter.kt 改动

```kotlin
object DownloadWriter {
    fun saveToDownloads(context: Context, subdir: String, filename: String, content: String): String {
        val safeSubdir = sanitizeSubdir(subdir)  // 校验 + 拒绝 ".." / "/" / 空
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, safeSubdir, filename, content)
        } else {
            saveViaLegacyFile(safeSubdir, filename, content)
        }
    }

    private fun sanitizeSubdir(s: String): String {
        val trimmed = s.trim().trim('/')
        require(trimmed.isNotEmpty()) { "subdir cannot be empty" }
        require(!trimmed.contains("..")) { "subdir cannot contain '..'" }
        require(!trimmed.contains('/')) { "subdir cannot contain '/'" }
        return trimmed
    }

    private fun saveViaMediaStore(context: Context, subdir: String, filename: String, content: String): String {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, guessMime(filename))
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$subdir")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw RuntimeException("MediaStore.insert returned null")
        resolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            ?: throw RuntimeException("openOutputStream returned null")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri.toString()
    }

    private fun saveViaLegacyFile(subdir: String, filename: String, content: String): String {
        @Suppress("DEPRECATION")
        val root = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val dir = File(root, subdir)
        if (!dir.exists() && !dir.mkdirs()) throw RuntimeException("mkdirs failed for $dir")
        val file = File(dir, filename)
        file.writeText(content, Charsets.UTF_8)
        return file.absolutePath
    }

    private fun guessMime(filename: String): String = when {
        filename.endsWith(".json", true) -> "application/json"
        filename.endsWith(".png", true) -> "image/png"
        filename.endsWith(".txt", true) -> "text/plain"
        else -> "application/octet-stream"
    }
}
```

### Rust save_data_to_download command

```rust
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

#[tauri::command]
fn save_data_to_download(
    subdir: String,
    filename: String,
    content_b64: String,
) -> Result<String, String> {
    let bytes = BASE64
        .decode(content_b64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    let content = String::from_utf8(bytes)
        .map_err(|e| format!("utf8 decode failed: {}", e))?;
    save_to_downloads_via_jni_generic(subdir, filename, content)
}

#[cfg(target_os = "android")]
fn save_to_downloads_via_jni_generic(subdir: String, filename: String, content: String) -> Result<String, String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;
    use ndk_context::android_context;

    let android_ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw failed: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread failed: {}", e))?;
    let jsubdir = env.new_string(&subdir)
        .map_err(|e| format!("new_string(subdir): {}", e))?;
    let jfilename = env.new_string(&filename)
        .map_err(|e| format!("new_string(filename): {}", e))?;
    let jcontent = env.new_string(&content)
        .map_err(|e| format!("new_string(content): {}", e))?;
    let activity = unsafe { JObject::from_raw(android_ctx.context().cast()) };
    let writer_class = env.find_class("com/smirnovayama/hrttracker/DownloadWriter")
        .map_err(|e| format!("find_class(DownloadWriter): {}", e))?;
    let result = env
        .call_static_method(
            writer_class,
            "saveToDownloads",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(&activity),
                JValue::Object(&jsubdir),
                JValue::Object(&jfilename),
                JValue::Object(&jcontent),
            ],
        )
        .map_err(|e| format!("call_static_method: {}", e))?
        .l()
        .map_err(|e| format!("call_static_method.l(): {}", e))?;
    let jstr = env.get_string((&result).into())
        .map_err(|e| format!("get_string: {}", e))?;
    Ok(jstr.into())
}

#[cfg(not(target_os = "android"))]
fn save_to_downloads_via_jni_generic(_subdir: String, _filename: String, _content: String) -> Result<String, String> {
    Err("save_to_downloads_via_jni_generic only available on Android".to_string())
}
```

`invoke_handler` 注册：
```rust
.invoke_handler(tauri::generate_handler![
    get_log_count, append_log, set_debug_mode, export_logs_to_download,
    save_data_to_download  // 新增
])
```

### Cargo.toml 新增依赖

```toml
[dependencies]
base64 = "0.22"
```

---

## 前端架构

### ShareImageModal.handleDownload 改动

`src/components/ShareImageModal.tsx:290-316` 改为：

```typescript
import { invoke } from '@tauri-apps/api/core';

const handleDownload = async () => {
    if (!printRef.current) return;
    setGenerating(true);
    setError('');
    setSavedPath('');
    try {
        const dataUrl = await toPng(printRef.current, {
            cacheBust: true,
            pixelRatio: 1,
            backgroundColor: palette.bg,
            width: CANVAS_W,
            height: CANVAS_H,
            imagePlaceholder:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        });
        // dataUrl 是 "data:image/png;base64,XXXX" → 去掉前缀
        const commaIdx = dataUrl.indexOf(',');
        const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        const filename = `hrt-share-${now.toISOString().slice(0, 10)}.png`;
        const path = await invoke<string>('save_data_to_download', {
            subdir: 'HRT Tracker',
            filename,
            content_b64: b64,
        });
        setSavedPath(path);
    } catch (err) {
        console.error('Failed to generate image:', err);
        setError(t('share.error') || 'Failed to generate image. Please try again.');
    } finally {
        setGenerating(false);
    }
};
```

UI 增加 `savedPath` state，保存成功后弹绿色提示条显示 `t('share.savedTo', { path: savedPath })`。

### SettingsPage.downloadFile 改动

`src/pages/SettingsPage.tsx:261-269` 改为：

```typescript
import { invoke } from '@tauri-apps/api/core';

const downloadFile = async (data: string, filename: string) => {
    try {
        // text 走 base64 编码
        const b64 = btoa(unescape(encodeURIComponent(data)));
        const path = await invoke<string>('save_data_to_download', {
            subdir: 'HRT Tracker',
            filename,
            content_b64: b64,
        });
        showDialog('alert', t('drawer.export_saved', { path }) || `已保存到 ${path}`);
    } catch (err) {
        console.error('Failed to save file:', err);
        showDialog('alert', t('drawer.export_failed') || '保存失败，请重试');
    }
};
```

`handleExport`（line 271）调 `await downloadFile(...)`（原来同步调，现在变 async）。`handleQuickExport`（剪贴板路径）保留不动作为 fallback。

### i18n 翻译键

`src/i18n/translations.ts` 新增：

| 键 | en | zh-CN | zh-TW | ja |
|---|---|---|---|---|
| `share.savedTo` | `Saved to {path}` | `已保存到 {path}` | `已儲存到 {path}` | `{path} に保存しました` |
| `drawer.export_saved` | `Saved to {path}` | `已保存到 {path}` | `已儲存到 {path}` | `{path} に保存しました` |
| `drawer.export_failed` | `Save failed. Please retry.` | `保存失败，请重试` | `儲存失敗，請重試` | `保存に失敗しました。再試行してください` |

---

## Workflow 架构

### .github/workflows/android-release.yml (新增)

完整复用 `android-debug.yml` 步骤，唯一区别：
- 触发器：`push: tags: v*.*.*` + `workflow_dispatch`
- build 命令：`npx @tauri-apps/cli@2 android build --apk`（去掉 `--debug`）
- artifact name：`android-release-apk`

### .github/workflows/android-debug.yml (改)

- 触发器：**只** `workflow_dispatch`（去掉 `push: tags: v*.*.*`）
- 其余步骤保留不变
- artifact name 保留 `android-debug-apk`

### 触发矩阵

| 事件 | android-release.yml | android-debug.yml |
|---|---|---|
| `git push tag v1.3.1` | ✅ 自动跑 | ❌ 不跑 |
| GitHub UI 手动 dispatch release | ✅ | ❌ |
| GitHub UI 手动 dispatch debug | ❌ | ✅ |
| `git push` 到 main / feature branch | ❌ | ❌ |

---

## tauri.conf.json 改动

```diff
 {
   "$schema": "https://schema.tauri.app/config/2",
-  "productName": "Transmtf HRT Tracker",
+  "productName": "HRT Tracker",
   "version": "1.3.0",
   "identifier": "com.smirnovayama.hrttracker",
   "build": { ... },
   "app": {
     "windows": [
       {
         "label": "main",
-        "title": "Transmtf HRT Tracker",
+        "title": "HRT Tracker",
         ...
       }
     ],
   ...
 }
```

`bundle.targets`（`["dmg", "app", "msi"]`）保持不动——这些是桌面平台用的，与 Android 无关。

Android 端应用名由 Tauri 在 `npx tauri android init` 时根据 `productName` 生成 `app/src/main/res/values/strings.xml` 的 `<string name="app_name">HRT Tracker</string>`。Workflow 已经 `init` 之后才编译，所以 productName 改了会自然生效。

---

## 测试

- **后端单元**：`cargo test` 跑过（如有）— base64 解码 / 错误路径
- **下载功能集成**：本地无法测（没 Android 设备），靠 GitHub Actions build + 模拟器/真机手动验证
- **Workflow 集成**：
  1. 改完后 commit + push
  2. 本地打 tag `v1.3.1-rc1` + push → 触发 release workflow
  3. 等待 5-7 分钟
  4. 下载 artifact `android-release-apk`
  5. 装到 Android 手机 → 应用名应显示 "HRT Tracker"
  6. 开 app → 设置 → 调试 → 启用 → 数据管理 → 导出 JSON → 文件管理器 `/sdcard/Download/HRT Tracker/hrt-dosages-2026-06-29.json` 存在
  7. 概览 tab → 导出图片 → `/sdcard/Download/HRT Tracker/hrt-share-2026-06-29.png` 存在
- **体积验证**：artifact 体积 ≤ 50 MB（debug ~400MB 基准）

---

## 文件变更清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src-tauri/scripts/DownloadWriter.kt` | 修改 | 加 subdir 参数 + sanitize + RELATIVE_PATH |
| `src-tauri/Cargo.toml` | 修改 | 加 base64 = "0.22" |
| `src-tauri/src/lib.rs` | 修改 | 加 save_data_to_download command + JNI |
| `src-tauri/tauri.conf.json` | 修改 | productName + title 改 "HRT Tracker" |
| `src/components/ShareImageModal.tsx` | 修改 | handleDownload 走 invoke |
| `src/pages/SettingsPage.tsx` | 修改 | downloadFile 走 invoke |
| `src/i18n/translations.ts` | 修改 | 加 3 个翻译键 × 4 语言 |
| `.github/workflows/android-release.yml` | 新增 | release build（tag + dispatch） |
| `.github/workflows/android-debug.yml` | 修改 | 去掉 tag 触发，只 dispatch |
| `src-tauri/gen/android/app/src/main/res/values/strings.xml` | 自动 | init 重新生成 app_name |

---

## 风险

- **风险 1**：`base64` crate 体积 + 编译时间 — Rust 端的额外依赖，~0.5s 编译开销，可接受
- **风险 2**：`MediaStore.Downloads.RELATIVE_PATH` 在 API 29+ 工作正常，但某些 OEM ROM（小米/华为）可能不识别 RELATIVE_PATH → 文件落到 `Download/` 根目录而非 `Download/HRT Tracker/`，但不影响文件可读性；如发现再降级到 legacy path
- **风险 3**：`btoa(unescape(encodeURIComponent(...)))` 是 base64-of-UTF8 的老 trick，现代浏览器支持 `btoa(String.fromCharCode(...new TextEncoder().encode(data)))` 但兼容性差，统一用 unescape trick 在 Android WebView 上稳
- **风险 4**：release build 默认无 devtools，consoleBridge 在生产环境是 no-op（这是预期行为，跟 T11 一致）

---

## 完成标准

1. `npm run build` 成功
2. `cargo check --target aarch64-linux-android` 通过（不动也能编）
3. GitHub Actions `android-release.yml` 在 push tag 后成功
4. APK 体积 ≤ 50MB（universal）
5. APK 安装后启动器应用名显示 "HRT Tracker"
6. 设置 → 数据管理 → 导出 JSON → 在 `/sdcard/Download/HRT Tracker/` 找到 `.json` 文件
7. 概览 → 导出图片 → 在 `/sdcard/Download/HRT Tracker/` 找到 `.png` 文件
8. 调试 mode 仍可开关，日志导出仍可工作（T11 回归）
