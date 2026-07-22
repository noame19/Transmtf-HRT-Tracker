use std::collections::VecDeque;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use serde::Serialize;

const LOG_BUFFER_CAPACITY: usize = 2000;

#[derive(Clone, Serialize)]
struct LogEntry {
    ts: String,
    source: String,
    level: String,
    msg: String,
}

struct LogState {
    enabled: Mutex<bool>,
    buffer: Mutex<VecDeque<LogEntry>>,
}

impl LogState {
    fn new() -> Self {
        Self {
            enabled: Mutex::new(false),
            buffer: Mutex::new(VecDeque::with_capacity(LOG_BUFFER_CAPACITY)),
        }
    }

    fn append(&self, source: &str, level: &str, msg: &str) {
        let enabled = *self.enabled.lock().unwrap();
        if !enabled { return; }
        let entry = LogEntry {
            ts: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string(),
            source: source.to_string(),
            level: level.to_string(),
            msg: msg.to_string(),
        };
        let mut buf = self.buffer.lock().unwrap();
        if buf.len() >= LOG_BUFFER_CAPACITY {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    fn snapshot(&self) -> Vec<LogEntry> {
        self.buffer.lock().unwrap().iter().cloned().collect()
    }

    fn len(&self) -> usize {
        self.buffer.lock().unwrap().len()
    }

    fn clear(&self) {
        self.buffer.lock().unwrap().clear();
    }
}

static LOG_STATE: Lazy<LogState> = Lazy::new(LogState::new);

/// Attach a daemon JNI thread and run the closure with the current Activity
/// (the same one tao/wry cached during `Rust.onActivityCreate(this)`).
///
/// We use `tao::platform::android::ndk_glue::main_android_context()` instead
/// of `ndk_context::android_context()`: tao populates its `CONTEXTS` map from
/// the JNI entry that tauri/wry already wired up, so the JavaVM + jobject we
/// get back are byte-for-byte the same pointers wry uses internally. The
/// `ndk-context` crate has a separate global that nobody initialises on
/// Tauri 2 / wry 0.55 / tao 0.35, and earlier attempts to fill it ourselves
/// from Kotlin hit a different problem: when re-attaching on a different
/// thread, the stored jobject's class resolved to an unrelated Android
/// framework object (`ThreadedRenderer$ProcessInitializer$1`) and every
/// method lookup crashed with `NoSuchMethodError`.
#[cfg(target_os = "android")]
fn with_android_env<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject) -> Result<R, String>,
{
    let ctx = tao::platform::android::prelude::main_android_context()
        .ok_or_else(|| "no Android context (activity not yet created?)".to_string())?;
    let vm_ptr = ctx.java_vm;
    let ctx_ptr = ctx.context_jobject;
    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr as *mut _) }
        .map_err(|e| format!("JavaVM::from_raw: {}", e))?;
    let mut env = vm
        .attach_current_thread_as_daemon()
        .map_err(|e| format!("attach_current_thread_as_daemon: {}", e))?;
    let activity = unsafe { jni::objects::JObject::from_raw(ctx_ptr as *mut _) };
    f(&mut env, &activity)
}

#[cfg(target_os = "android")]
fn load_class_by_name<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
    class_name: &str,
) -> Result<jni::objects::JClass<'a>, String> {
    use jni::objects::JValue;
    let class_loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("call_method(getClassLoader): {}", e))?
        .l()
        .map_err(|e| format!("call_method(getClassLoader).l(): {}", e))?;
    let jname = env
        .new_string(class_name)
        .map_err(|e| format!("new_string(class name): {}", e))?;
    let class_obj = env
        .call_method(
            class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&jname)],
        )
        .map_err(|e| format!("call_method(loadClass): {}", e))?
        .l()
        .map_err(|e| format!("call_method(loadClass).l(): {}", e))?;
    Ok(class_obj.into())
}

/// Back-compat shim so existing DownloadWriter call sites keep working after
/// the loader was generalised into `load_class_by_name`.
#[cfg(target_os = "android")]
fn load_writer_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
) -> Result<jni::objects::JClass<'a>, String> {
    load_class_by_name(env, activity, "com/smirnovayama/hrttracker/DownloadWriter")
}

/// Convenience: `load_class_by_name` wrapped for the FileOpener.
#[cfg(target_os = "android")]
fn load_opener_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
) -> Result<jni::objects::JClass<'a>, String> {
    load_class_by_name(env, activity, "com/smirnovayama/hrttracker/FileOpener")
}

/// Convenience: `load_class_by_name` wrapped for DownloadManager (the
/// list/read/delete counterpart to DownloadWriter). Injected alongside
/// the writer so the auto-backup restore + 6-month-cleanup flows can
/// walk the Downloads tree from Rust.
#[cfg(target_os = "android")]
fn load_download_manager_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
) -> Result<jni::objects::JClass<'a>, String> {
    load_class_by_name(env, activity, "com/smirnovayama/hrttracker/DownloadManager")
}

/// Pull the three String fields off a Kotlin `DownloadWriter.SaveResult` and
/// re-package as a serde-serialisable Rust struct. The Kotlin data class is
/// generated as `DownloadWriter$SaveResult` in JVM type terms, with `getUri`,
/// `getDisplayPath`, `getMime` accessor methods.
#[cfg(target_os = "android")]
fn extract_save_result(
    env: &mut jni::JNIEnv,
    jobj: &jni::objects::JObject,
) -> Result<SaveDataResult, String> {
    let uri = env
        .get_field(jobj, "uri", "Ljava/lang/String;")
        .map_err(|e| format!("get_field(uri): {}", e))?
        .l()
        .map_err(|e| format!("get_field(uri).l(): {}", e))?;
    let uri_str = env
        .get_string((&uri).into())
        .map_err(|e| format!("get_string(uri): {}", e))?;

    let display_path = env
        .get_field(jobj, "displayPath", "Ljava/lang/String;")
        .map_err(|e| format!("get_field(displayPath): {}", e))?
        .l()
        .map_err(|e| format!("get_field(displayPath).l(): {}", e))?;
    let display_path_str = env
        .get_string((&display_path).into())
        .map_err(|e| format!("get_string(displayPath): {}", e))?;

    let mime = env
        .get_field(jobj, "mime", "Ljava/lang/String;")
        .map_err(|e| format!("get_field(mime): {}", e))?
        .l()
        .map_err(|e| format!("get_field(mime).l(): {}", e))?;
    let mime_str = env
        .get_string((&mime).into())
        .map_err(|e| format!("get_string(mime): {}", e))?;

    Ok(SaveDataResult {
        uri: uri_str.into(),
        display_path: display_path_str.into(),
        mime: mime_str.into(),
    })
}

/// Convenience: `load_class_by_name` wrapped for the NotificationScheduler.
#[cfg(target_os = "android")]
fn load_notification_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
) -> Result<jni::objects::JClass<'a>, String> {
    load_class_by_name(env, activity, "com/smirnovayama/hrttracker/NotificationScheduler")
}

#[cfg(target_os = "android")]
fn save_to_downloads_with_subdir_inner(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    subdir: &str,
    filename: &str,
    content: &str,
) -> Result<SaveDataResult, String> {
    use jni::objects::JValue;
    let jsubdir = env
        .new_string(subdir)
        .map_err(|e| format!("new_string(subdir): {}", e))?;
    let jfilename = env
        .new_string(filename)
        .map_err(|e| format!("new_string(filename): {}", e))?;
    let jcontent = env
        .new_string(content)
        .map_err(|e| format!("new_string(content): {}", e))?;
    let writer_class = load_writer_class(env, activity)?;
    let result = env
        .call_static_method(
            writer_class,
            "saveToDownloads",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lcom/smirnovayama/hrttracker/DownloadWriter$SaveResult;",
            &[
                JValue::Object(activity),
                JValue::Object(&jsubdir),
                JValue::Object(&jfilename),
                JValue::Object(&jcontent),
            ],
        )
        .map_err(|e| format!("call_static_method: {}", e))?
        .l()
        .map_err(|e| format!("call_static_method.l(): {}", e))?;
    extract_save_result(env, &result)
}

#[cfg(target_os = "android")]
fn clipboard_write_inner(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    text: &str,
) -> Result<String, String> {
    use jni::objects::JValue;
    let jtext = env
        .new_string(text)
        .map_err(|e| format!("new_string(text): {}", e))?;
    let writer_class = load_writer_class(env, activity)?;
    let result = env
        .call_static_method(
            writer_class,
            "copyToClipboard",
            "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(activity), JValue::Object(&jtext)],
        )
        .map_err(|e| format!("call_static_method: {}", e))?
        .l()
        .map_err(|e| format!("call_static_method.l(): {}", e))?;
    let jstr = env
        .get_string((&result).into())
        .map_err(|e| format!("get_string: {}", e))?;
    Ok(jstr.into())
}

#[tauri::command]
fn set_debug_mode(app: tauri::AppHandle, enabled: bool) {
    // Toggle the in-memory gate; webview console + Rust panic both reach
    // this buffer via consoleBridge.ts / append_log. The old "spawn logcat
    // subprocess" path was retired: it filtered by `hrt-tracker` tag and
    // never caught webview logs (which land in the Tauri/Console tag).
    {
        let mut flag = LOG_STATE.enabled.lock().unwrap();
        *flag = enabled;
    }
    if !enabled {
        LOG_STATE.clear();
    }
    let _ = app;
}

#[tauri::command]
fn get_log_count() -> usize {
    LOG_STATE.len()
}

#[tauri::command]
fn append_log(level: String, msg: String) {
    LOG_STATE.append("js", &level, &msg);
}

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn export_logs_to_download(_app: tauri::AppHandle) -> Result<SaveDataResult, String> {
    let entries = LOG_STATE.snapshot();
    if entries.is_empty() {
        return Err("No logs captured. Enable debug mode and reproduce the issue first.".to_string());
    }
    let mut text = String::with_capacity(entries.len() * 120);
    text.push_str("Transmtf HRT Tracker - Debug Log\n");
    text.push_str(&format!("Exported at: {}\n", chrono::Local::now().to_rfc3339()));
    text.push_str(&format!("Total entries: {}\n", entries.len()));
    text.push_str("---------------------------------------------------------------\n");
    for e in &entries {
        text.push_str(&format!("[{}] [{}] [{}] {}\n", e.ts, e.source, e.level, e.msg));
    }
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let filename = format!("hrt-tracker-logs-{}.txt", ts);
    #[cfg(target_os = "android")]
    {
        // Kotlin's DownloadWriter.saveToDownloads decodes base64 on its side
        // so binary payloads (PNG/JPEG) survive the JNI String hop. We have
        // plain text here, so encode before crossing the boundary.
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        return with_android_env(|env, activity| {
            save_to_downloads_with_subdir_inner(env, activity, "HRT Tracker", &filename, &b64)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("export_logs_to_download only available on Android".to_string())
    }
}

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn clipboard_write_text(_app: tauri::AppHandle, text: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        return with_android_env(|env, activity| {
            clipboard_write_inner(env, activity, &text)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("clipboard_write_text only available on Android".to_string())
    }
}

/// Result returned by `save_data_to_download` on Android. The frontend
/// surfaces `displayPath` in the "Saved to {path}" toast (e.g. "0/Download/
/// HRT Tracker/foo.json") and uses `uri` + `mime` later if the user taps
/// the path to open the file via `open_with_system`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveDataResult {
    uri: String,
    display_path: String,
    mime: String,
}

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn save_data_to_download(
    _app: tauri::AppHandle,
    subdir: String,
    filename: String,
    content_b64: String,
) -> Result<SaveDataResult, String> {
    // Frontend sends `contentB64`; Tauri's ArgumentCase::Camel default rewrites
    // the param name to camelCase for IPC, so `content_b64` here matches `contentB64` from JS.
    // Base64 decode happens on the Kotlin side (DownloadWriter.saveToDownloads),
    // so binary payloads like PNG/JPEG survive the JNI String hop.
    #[cfg(target_os = "android")]
    {
        return with_android_env(|env, activity| {
            save_to_downloads_with_subdir_inner(env, activity, &subdir, &filename, &content_b64)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("save_data_to_download only available on Android".to_string())
    }
}

/// Hand a previously-saved file off to the system "Open with" picker. The
/// frontend hands us back the `uri` + `mime` that `save_data_to_download`
/// returned, so the round-trip is fully lossless under Android 11+ scoped
/// storage (where the on-disk path is not exposed to the app).
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn open_with_system(
    _app: tauri::AppHandle,
    uri: String,
    mime: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::{JValue, JThrowable};
        return with_android_env(|env, activity| {
            let juri = env
                .new_string(&uri)
                .map_err(|e| format!("new_string(uri): {}", e))?;
            let jmime = env
                .new_string(&mime)
                .map_err(|e| format!("new_string(mime): {}", e))?;
            let cls = load_opener_class(env, activity)?;
            // Discard the String return value — we only care whether the call
            // *succeeded*. JNI's `call_static_method` does NOT automatically
            // raise a Rust Err when the JVM throws; the exception stays
            // pending on the env. Without the explicit check below, a Kotlin
            // RuntimeException("No app available to open ...") would silently
            // bubble into the next JNI call (or vanish entirely) and Rust
            // would return Ok(true), making the frontend think the click did
            // nothing. exception_occurred + toString + exception_clear is the
            // canonical way to surface JVM exceptions back to Rust.
            let _ = env.call_static_method(
                cls,
                "openWith",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(activity), JValue::Object(&juri), JValue::Object(&jmime)],
            );
            if let Some(exc) = env.exception_occurred()? {
                env.exception_clear()?;
                let desc = JThrowable::from(exc)
                    .to_string_lossy(env)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|_| "<unknown JNI exception>".to_string());
                return Err(format!("FileOpener.openWith threw: {}", desc));
            }
            Ok(true)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("open_with_system only available on Android".to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DownloadManager plumbing (Android file ops on the Downloads folder)
//
// Three commands back the auto-backup feature: listing what backup files
// already exist under a sub-directory (drives the "restore from backup"
// dropdown + the 6-month cleanup sweep), reading a specific backup so the
// JS side can pipe it into the existing import flow, and deleting a backup
// file the JS side has decided is stale. Kotlin lives in DownloadManager.kt;
// the JNI class + method names below MUST stay in lock-step with the
// `@JvmStatic` declarations there. The web (non-Android) builds return an
// empty list / error string so the JS side can degrade gracefully instead
// of exploding when `__TAURI_INTERNALS__` is undefined.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct DownloadFileInfo {
    /// Bare filename without subdir prefix — what `save_data_to_download`
    /// would have produced. JS uses this as both the dropdown label and
    /// the dedup key when re-reading / deleting.
    filename: String,
    /// MediaStore content:// URI on API 29+, `file://...` on legacy.
    /// Surfaced so a follow-up `read_download_file` can be a direct
    /// round-trip without re-listing; JS currently re-passes `filename`
    /// and lets Kotlin re-resolve, but keeping the field in the struct
    /// future-proofs against a performance-driven switch.
    uri: String,
    /// File size in bytes. `0` if the underlying provider doesn't surface it
    /// (legacy `listFiles` does; some MediaStore rows may not). Used by JS
    /// to short-circuit "definitely empty" candidates.
    size_bytes: i64,
    /// Last-modified timestamp in milliseconds since epoch. Aligns with
    /// `Date.now()` on the JS side so the 180-day cutoff is a straight
    /// numeric compare without a parse step.
    modified_at_ms: i64,
}

#[derive(serde::Serialize)]
struct DownloadFileContent {
    /// Base64 of the raw file bytes (same encoding `save_data_to_download`
    /// accepts on the way in, so the round-trip is lossless). `atob()` on
    /// the JS side turns this back into the exact JSON string the writer
    /// stored — JS can then pipe it straight into `processImportedData`.
    content_b64: String,
}

/// Walk the public Downloads tree and return every file under
/// `{subdir}/`. On non-Android builds this returns an empty vec (not an
/// error) — the JS side uses the empty result to hide the restore
/// dropdown on web instead of throwing a user-facing "Android only" toast.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn list_download_files(_app: tauri::AppHandle, subdir: String) -> Result<Vec<DownloadFileInfo>, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let jsubdir = env
                .new_string(&subdir)
                .map_err(|e| format!("new_string(subdir): {}", e))?;
            let cls = load_download_manager_class(env, activity)?;
            // Returns DownloadManager$FileInfo[] — a Java array of data
            // class instances, each carrying (filename, uri, sizeBytes,
            // modifiedAtMs). We unmarshal one row at a time.
            let array = env
                .call_static_method(
                    cls,
                    "listFiles",
                    "(Landroid/content/Context;Ljava/lang/String;)[Lcom/smirnovayama/hrttracker/DownloadManager$FileInfo;",
                    &[JValue::Object(activity), JValue::Object(&jsubdir)],
                )
                .map_err(|e| format!("call_static_method(listFiles): {}", e))?
                .l()
                .map_err(|e| format!("listFiles.l: {}", e))?;
            let array_ref = jni::objects::JObjectArray::from(array);
            let len = env
                .get_array_length(&array_ref)
                .map_err(|e| format!("get_array_length: {}", e))?;
            let mut out: Vec<DownloadFileInfo> = Vec::with_capacity(len as usize);
            for i in 0..len {
                let row = env
                    .get_object_array_element(&array_ref, i)
                    .map_err(|e| format!("get_object_array_element({}): {}", i, e))?;
                let row_obj = jni::objects::JObject::from(row);
                let filename = read_jstring_field(env, &row_obj, "filename")?;
                let uri = read_jstring_field(env, &row_obj, "uri")?;
                let size_bytes = env
                    .get_field(&row_obj, "sizeBytes", "J")
                    .map_err(|e| format!("get_field(sizeBytes): {}", e))?
                    .j()
                    .map_err(|e| format!("sizeBytes.j: {}", e))?;
                let modified_at_ms = env
                    .get_field(&row_obj, "modifiedAtMs", "J")
                    .map_err(|e| format!("get_field(modifiedAtMs): {}", e))?
                    .j()
                    .map_err(|e| format!("modifiedAtMs.j: {}", e))?;
                out.push(DownloadFileInfo {
                    filename,
                    uri,
                    size_bytes,
                    modified_at_ms,
                });
            }
            Ok(out)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = subdir;
        Ok(Vec::new())
    }
}

/// Read the bytes of a specific file under `{subdir}/`. Returned as
/// base64 so the JNI String hop stays binary-safe (same encoding
/// `save_data_to_download` accepts on write — JS atob → JSON.parse is
/// the round-trip path). On non-Android this returns an error so a
/// misguided web call can't silently treat an empty string as success.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn read_download_file(
    _app: tauri::AppHandle,
    subdir: String,
    filename: String,
) -> Result<DownloadFileContent, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let jsubdir = env
                .new_string(&subdir)
                .map_err(|e| format!("new_string(subdir): {}", e))?;
            let jfilename = env
                .new_string(&filename)
                .map_err(|e| format!("new_string(filename): {}", e))?;
            let cls = load_download_manager_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "readFile",
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Lcom/smirnovayama/hrttracker/DownloadManager$FileContent;",
                    &[JValue::Object(activity), JValue::Object(&jsubdir), JValue::Object(&jfilename)],
                )
                .map_err(|e| format!("call_static_method(readFile): {}", e))?
                .l()
                .map_err(|e| format!("readFile.l: {}", e))?;
            let result_obj = jni::objects::JObject::from(result);
            let content_b64 = read_jstring_field(env, &result_obj, "contentB64")?;
            Ok(DownloadFileContent { content_b64 })
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (subdir, filename);
        Err("read_download_file only available on Android".to_string())
    }
}

/// Delete a file under `{subdir}/`. Returns `true` if a row was
/// actually removed, `false` if the file was already gone (the latter
/// is treated as success by the JS cleanup loop so a previous partial
/// run doesn't re-trigger).
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn delete_download_file(
    _app: tauri::AppHandle,
    subdir: String,
    filename: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let jsubdir = env
                .new_string(&subdir)
                .map_err(|e| format!("new_string(subdir): {}", e))?;
            let jfilename = env
                .new_string(&filename)
                .map_err(|e| format!("new_string(filename): {}", e))?;
            let cls = load_download_manager_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "deleteFile",
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Z",
                    &[JValue::Object(activity), JValue::Object(&jsubdir), JValue::Object(&jfilename)],
                )
                .map_err(|e| format!("call_static_method(deleteFile): {}", e))?
                .z()
                .map_err(|e| format!("deleteFile.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (subdir, filename);
        Err("delete_download_file only available on Android".to_string())
    }
}

/// Pull a `String` field off a Kotlin data class via the auto-generated
/// `getXxx()` accessor. Kotlin compiles `val filename: String` into a
/// `private final String filename` field + a `public String getFilename()`
/// method; we hit the FIELD directly (descriptor `Ljava/lang/String;`)
/// instead of the getter so we don't depend on whether the property was
/// declared `val` (getter) or `var` (getter+setter).
#[cfg(target_os = "android")]
fn read_jstring_field(
    env: &mut jni::JNIEnv,
    obj: &jni::objects::JObject,
    field_name: &str,
) -> Result<String, String> {
    let raw = env
        .get_field(obj, field_name, "Ljava/lang/String;")
        .map_err(|e| format!("get_field({}): {}", field_name, e))?
        .l()
        .map_err(|e| format!("{}.l: {}", field_name, e))?;
    if raw.is_null() {
        return Ok(String::new());
    }
    let jstr = env
        .get_string((&raw).into())
        .map_err(|e| format!("get_string({}): {}", field_name, e))?;
    Ok(jstr.into())
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminder (Android notification) plumbing
//
// Each command is a thin shim that hands off to the matching
// `NotificationScheduler` `@JvmStatic` method. The Kotlin side does the real
// work (channel creation, AlarmManager registration, permission requests,
// pending-deep-link read/write) — Rust just plumbs the strings across JNI.
// All non-Android builds return a friendly error so the web preview never
// blows up on missing commands.
// ─────────────────────────────────────────────────────────────────────────────

/// Create the "hrt_reminders" NotificationChannel (idempotent, no-op on
/// API < 26 or when the channel already exists).
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn ensure_notification_channel(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(cls, "ensureChannel", "(Landroid/content/Context;)Z", &[JValue::Object(activity)])
                .map_err(|e| format!("call_static_method(ensureChannel): {}", e))?
                .z()
                .map_err(|e| format!("ensureChannel.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("ensure_notification_channel only available on Android".to_string())
    }
}

/// Returns whether the user has notifications enabled for our app.
/// On API 33+ this ALSO triggers the runtime POST_NOTIFICATIONS permission
/// dialog on first call (the dialog result is reflected in the return
/// value the next time the user re-opens the app).
///
/// We reuse the existing `areNotificationsEnabled` Kotlin entry point —
/// it returns the same boolean regardless of whether the system dialog
/// ran. The OS shows the dialog automatically on first access of the
/// protected API surface (`NotificationManagerCompat.from(ctx).areNotificationsEnabled()`),
/// so the JS side just calls this once and reads the answer.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn request_notification_permission(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(cls, "areNotificationsEnabled", "(Landroid/content/Context;)Z", &[JValue::Object(activity)])
                .map_err(|e| format!("call_static_method(areNotificationsEnabled): {}", e))?
                .z()
                .map_err(|e| format!("areNotificationsEnabled.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("request_notification_permission only available on Android".to_string())
    }
}

/// True if our app is in the device's "battery optimization whitelist"
/// (a.k.a. "not optimized", "unrestricted"). On API < 23 the feature
/// doesn't exist and we return true so the UI banner auto-dismisses.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn is_battery_optimization_ignored(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "isBatteryOptimizationIgnored",
                    "(Landroid/content/Context;)Z",
                    &[JValue::Object(activity)],
                )
                .map_err(|e| format!("call_static_method(isBatteryOptimizationIgnored): {}", e))?
                .z()
                .map_err(|e| format!("isBatteryOptimizationIgnored.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

/// Open the system battery-optimization settings page. Returns true if
/// the page launched (so the JS banner can re-check on next mount and
/// auto-dismiss). On API < 23 we always return true.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn request_ignore_battery_optimization(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "requestIgnoreBatteryOptimization",
                    "(Landroid/content/Context;)Z",
                    &[JValue::Object(activity)],
                )
                .map_err(|e| format!("call_static_method(requestIgnoreBatteryOptimization): {}", e))?
                .z()
                .map_err(|e| format!("requestIgnoreBatteryOptimization.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

/// Open the per-OEM "auto-start" / "background app management" page so
/// the user can whitelist our app for background execution + BOOT_COMPLETED
/// broadcasts. Tries known MIUI/EMUI/ColorOS/OriginOS component names
/// then falls back to AOSP "background app management" → app-info.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn open_manufacturer_auto_start_settings(_app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "openManufacturerAutoStartSettings",
                    "(Landroid/content/Context;)Z",
                    &[JValue::Object(activity)],
                )
                .map_err(|e| format!("call_static_method(openManufacturerAutoStartSettings): {}", e))?
                .z()
                .map_err(|e| format!("openManufacturerAutoStartSettings.z: {}", e))?;
            Ok(result)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

/// Re-derive every upcoming dose moment from the supplied plan list and
/// (re)register AlarmManager alarms for each. Idempotent — Kotlin clears
/// the cached plans before scheduling so stale entries can't linger. The
/// returned integer is the count of alarms actually scheduled (for log
/// debugging; UI doesn't surface it).
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn schedule_plan_reminders(_app: tauri::AppHandle, plans_json: String) -> Result<i32, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let jplans = env
                .new_string(&plans_json)
                .map_err(|e| format!("new_string(plans_json): {}", e))?;
            let n = env
                .call_static_method(
                    cls,
                    "scheduleReminders",
                    "(Landroid/content/Context;Ljava/lang/String;)I",
                    &[JValue::Object(activity), JValue::Object(&jplans)],
                )
                .map_err(|e| format!("call_static_method(scheduleReminders): {}", e))?
                .i()
                .map_err(|e| format!("scheduleReminders.i: {}", e))?;
            Ok(n as i32)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("schedule_plan_reminders only available on Android".to_string())
    }
}

/// Cancel alarms whose requestCode maps back to any of the supplied plan
/// ids. JS passes a JSON array of ids (string), e.g. `["plan-1","plan-2"]`.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn cancel_plan_reminders(_app: tauri::AppHandle, plan_ids_json: String) -> Result<i32, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let jids = env
                .new_string(&plan_ids_json)
                .map_err(|e| format!("new_string(plan_ids_json): {}", e))?;
            let n = env
                .call_static_method(
                    cls,
                    "cancelReminders",
                    "(Landroid/content/Context;Ljava/lang/String;)I",
                    &[JValue::Object(activity), JValue::Object(&jids)],
                )
                .map_err(|e| format!("call_static_method(cancelReminders): {}", e))?
                .i()
                .map_err(|e| format!("cancelReminders.i: {}", e))?;
            Ok(n as i32)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("cancel_plan_reminders only available on Android".to_string())
    }
}

/// Drop every alarm the app ever registered. Called when the user disables
/// the global reminder toggle, so the system isn't plagued by dead alarms.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn cancel_all_reminders(_app: tauri::AppHandle) -> Result<i32, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let n = env
                .call_static_method(
                    cls,
                    "cancelAll",
                    "(Landroid/content/Context;)I",
                    &[JValue::Object(activity)],
                )
                .map_err(|e| format!("call_static_method(cancelAll): {}", e))?
                .i()
                .map_err(|e| format!("cancelAll.i: {}", e))?;
            Ok(n as i32)
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("cancel_all_reminders only available on Android".to_string())
    }
}

/// Returns the deep-link JSON written by `ReminderReceiver` after firing
/// (one-shot read — the entry is cleared immediately so a fresh app launch
/// never replays an old reminder). Returns `None` if nothing pending.
#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn get_pending_reminders(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        return with_android_env(|env, activity| {
            let cls = load_notification_class(env, activity)?;
            let result = env
                .call_static_method(
                    cls,
                    "readPending",
                    "(Landroid/content/Context;)Ljava/lang/String;",
                    &[JValue::Object(activity)],
                )
                .map_err(|e| format!("call_static_method(readPending): {}", e))?
                .l()
                .map_err(|e| format!("readPending.l: {}", e))?;
            if result.is_null() {
                return Ok::<Option<String>, String>(None);
            }
            let jstr = env
                .get_string((&result).into())
                .map_err(|e| format!("get_string: {}", e))?;
            // Clear after read so the next call doesn't replay the same one.
            let cls2 = load_notification_class(env, activity)?;
            let _ = env.call_static_method(cls2, "clearPending", "(Landroid/content/Context;)V", &[JValue::Object(activity)]);
            Ok(Some(jstr.into()))
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("get_pending_reminders only available on Android".to_string())
    }
}

/// Install a Rust panic hook that writes the panic info + a backtrace to
/// logcat (`RustStdoutStderr` tag) before the process aborts. The release
/// build sets `panic = "abort"`, which kills the process the moment a
/// panic fires, so without this hook crashes leave zero evidence in the
/// log — `signal 6 (SIGABRT)` only. The hook costs nothing on the happy
/// path and lets us still triage user-reported crashes.
///
/// `set_hook` is process-global; calling it more than once replaces the
/// previous hook, so we keep the call inside `run()` (entry point) and
/// guard with a one-shot atomic so accidental double-init is a no-op.
#[cfg(any(target_os = "android", debug_assertions))]
fn install_panic_hook() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    std::panic::set_hook(Box::new(|info| {
        // 1. Forward to the default hook so logcat still gets the
        //    "thread '<name>' panicked at ..." line that `adb logcat`
        //    users are used to.
        eprintln!("thread '{}' panicked at {}\n\nbacktrace:\n{:?}",
            std::thread::current().name().unwrap_or("<unnamed>"),
            info,
            std::backtrace::Backtrace::force_capture(),
        );
        // 2. Push into our in-memory ring buffer so the webview can
        //    surface the crash via the existing debug-log export path.
        LOG_STATE.append("rust", "panic", &format!("{}\n{:?}", info, std::backtrace::Backtrace::force_capture()));
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(any(target_os = "android", debug_assertions))]
    install_panic_hook();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_log_count,
            append_log,
            set_debug_mode,
            export_logs_to_download,
            save_data_to_download,
            open_with_system,
            clipboard_write_text,
            list_download_files,
            read_download_file,
            delete_download_file,
            ensure_notification_channel,
            request_notification_permission,
            is_battery_optimization_ignored,
            request_ignore_battery_optimization,
            open_manufacturer_auto_start_settings,
            schedule_plan_reminders,
            cancel_plan_reminders,
            cancel_all_reminders,
            get_pending_reminders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}