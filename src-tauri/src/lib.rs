use std::collections::VecDeque;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use serde::Serialize;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

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

#[cfg(target_os = "android")]
fn save_to_downloads_via_jni(content: String, filename: String) -> Result<String, String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;
    use ndk_context::android_context;

    let android_ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw failed: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread failed: {}", e))?;
    let jcontent = env
        .new_string(&content)
        .map_err(|e| format!("new_string(content): {}", e))?;
    let jfilename = env
        .new_string(&filename)
        .map_err(|e| format!("new_string(filename): {}", e))?;
    let activity = unsafe { JObject::from_raw(android_ctx.context().cast()) };
    // ClassLoader dance: env.find_class only sees the system classloader on Android;
    // app classes (com.smirnovayama.hrttracker.DownloadWriter) must be loaded via the
    // activity's own classloader.
    let class_loader = env
        .call_method(
            &activity,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .map_err(|e| format!("call_method(getClassLoader): {}", e))?
        .l()
        .map_err(|e| format!("call_method(getClassLoader).l(): {}", e))?;
    let jname = env
        .new_string("com/smirnovayama/hrttracker/DownloadWriter")
        .map_err(|e| format!("new_string(class name): {}", e))?;
    let writer_class: jni::objects::JClass<'_> = env
        .call_method(
            class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&jname)],
        )
        .map_err(|e| format!("call_method(loadClass): {}", e))?
        .l()
        .map_err(|e| format!("call_method(loadClass).l(): {}", e))?
        .into();
    let result = env
        .call_static_method(
            writer_class,
            "saveToDownloads",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(&activity),
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

#[cfg(not(target_os = "android"))]
fn save_to_downloads_via_jni(_content: String, _filename: String) -> Result<String, String> {
    Err("save_to_downloads_via_jni only available on Android".to_string())
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
    let _ = app; // 保留参数，未来扩展
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
fn export_logs_to_download() -> Result<String, String> {
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
    save_to_downloads_via_jni(text, filename)
}

#[tauri::command]
fn clipboard_write_text(text: String) -> Result<String, String> {
    clipboard_write_via_jni(text)
}

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
fn save_to_downloads_via_jni_generic(
    subdir: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;
    use ndk_context::android_context;

    let android_ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw failed: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread failed: {}", e))?;
    let jsubdir = env
        .new_string(&subdir)
        .map_err(|e| format!("new_string(subdir): {}", e))?;
    let jfilename = env
        .new_string(&filename)
        .map_err(|e| format!("new_string(filename): {}", e))?;
    let jcontent = env
        .new_string(&content)
        .map_err(|e| format!("new_string(content): {}", e))?;
    let activity = unsafe { JObject::from_raw(android_ctx.context().cast()) };
    // ClassLoader dance: see save_to_downloads_via_jni for rationale
    let class_loader = env
        .call_method(
            &activity,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .map_err(|e| format!("call_method(getClassLoader): {}", e))?
        .l()
        .map_err(|e| format!("call_method(getClassLoader).l(): {}", e))?;
    let jname = env
        .new_string("com/smirnovayama/hrttracker/DownloadWriter")
        .map_err(|e| format!("new_string(class name): {}", e))?;
    let writer_class: jni::objects::JClass<'_> = env
        .call_method(
            class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&jname)],
        )
        .map_err(|e| format!("call_method(loadClass): {}", e))?
        .l()
        .map_err(|e| format!("call_method(loadClass).l(): {}", e))?
        .into();
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
    let jstr = env
        .get_string((&result).into())
        .map_err(|e| format!("get_string: {}", e))?;
    Ok(jstr.into())
}

#[cfg(not(target_os = "android"))]
fn save_to_downloads_via_jni_generic(
    _subdir: String,
    _filename: String,
    _content: String,
) -> Result<String, String> {
    Err("save_to_downloads_via_jni_generic only available on Android".to_string())
}

#[cfg(target_os = "android")]
fn clipboard_write_via_jni(text: String) -> Result<String, String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;
    use ndk_context::android_context;

    let android_ctx = android_context();
    let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }
        .map_err(|e| format!("JavaVM::from_raw failed: {}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread failed: {}", e))?;
    let jtext = env
        .new_string(&text)
        .map_err(|e| format!("new_string(text): {}", e))?;
    let activity = unsafe { JObject::from_raw(android_ctx.context().cast()) };
    // ClassLoader dance: see save_to_downloads_via_jni for rationale
    let class_loader = env
        .call_method(
            &activity,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .map_err(|e| format!("call_method(getClassLoader): {}", e))?
        .l()
        .map_err(|e| format!("call_method(getClassLoader).l(): {}", e))?;
    let jname = env
        .new_string("com/smirnovayama/hrttracker/DownloadWriter")
        .map_err(|e| format!("new_string(class name): {}", e))?;
    let writer_class: jni::objects::JClass<'_> = env
        .call_method(
            class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&jname)],
        )
        .map_err(|e| format!("call_method(loadClass): {}", e))?
        .l()
        .map_err(|e| format!("call_method(loadClass).l(): {}", e))?
        .into();
    let result = env
        .call_static_method(
            writer_class,
            "copyToClipboard",
            "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(&activity),
                JValue::Object(&jtext),
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

#[cfg(not(target_os = "android"))]
fn clipboard_write_via_jni(_text: String) -> Result<String, String> {
    Err("clipboard_write_via_jni only available on Android".to_string())
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