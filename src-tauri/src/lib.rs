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
fn with_android_env<F>(f: F) -> Result<String, String>
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject) -> Result<String, String>,
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
fn load_writer_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
) -> Result<jni::objects::JClass<'a>, String> {
    use jni::objects::JValue;
    let class_loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("call_method(getClassLoader): {}", e))?
        .l()
        .map_err(|e| format!("call_method(getClassLoader).l(): {}", e))?;
    let jname = env
        .new_string("com/smirnovayama/hrttracker/DownloadWriter")
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

#[cfg(target_os = "android")]
fn save_to_downloads_inner(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    filename: &str,
    content: &str,
) -> Result<String, String> {
    use jni::objects::JValue;
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
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(activity),
                JValue::Object(&jfilename),
                JValue::Object(&jcontent),
            ],
        )
        .map_err(|e| format!("call_static_method: {}", e))?
        .l()
        .map_err(|e| format!("call_static_method.l(): {}", e))?;
    let jstr = env
        .get_string((&result).into())
        .map_err(|e| format!("get_string: {}", e))?;
    Ok(jstr.into())
}

#[cfg(target_os = "android")]
fn save_to_downloads_with_subdir_inner(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    subdir: &str,
    filename: &str,
    content: &str,
) -> Result<String, String> {
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
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
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
    let jstr = env
        .get_string((&result).into())
        .map_err(|e| format!("get_string: {}", e))?;
    Ok(jstr.into())
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
fn export_logs_to_download(_app: tauri::AppHandle) -> Result<String, String> {
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
        return with_android_env(|env, activity| {
            save_to_downloads_inner(env, activity, &filename, &text)
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

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables, dead_code))]
fn save_data_to_download(
    _app: tauri::AppHandle,
    subdir: String,
    filename: String,
    content_b64: String,
) -> Result<String, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_log_count,
            append_log,
            set_debug_mode,
            export_logs_to_download,
            save_data_to_download,
            clipboard_write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}