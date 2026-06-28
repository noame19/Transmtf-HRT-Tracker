use std::collections::VecDeque;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::sync::Mutex as StdMutex;
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

static LOGCAT_CHILD: Lazy<StdMutex<Option<Child>>> = Lazy::new(|| StdMutex::new(None));

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
    let classloader = env
        .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("getClassLoader: {}", e))?
        .l()
        .map_err(|e| format!("getClassLoader.l(): {}", e))?;
    let class_name = env
        .new_string("com/smirnovayama/hrttracker/DownloadWriter")
        .map_err(|e| format!("new_string(class): {}", e))?;
    let writer_class = env
        .call_method(
            classloader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&class_name)],
        )
        .map_err(|e| format!("loadClass: {}", e))?
        .l()
        .map_err(|e| format!("loadClass.l(): {}", e))?;
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

fn stop_logcat() {
    if let Ok(mut guard) = LOGCAT_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn start_logcat(app_tag: &str) {
    stop_logcat();
    let child = Command::new("logcat")
        .args(["-v", "time", "-T", "1", "-s", app_tag])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        if let Some(stdout) = child.stdout.take() {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            std::thread::spawn(move || {
                for line in reader.lines().flatten() {
                    LOG_STATE.append("logcat", "INFO", &line);
                }
                let _ = child.wait();
            });
        } else {
            // 没拿到 stdout，放回 child
            if let Ok(mut guard) = LOGCAT_CHILD.lock() {
                *guard = Some(child);
            }
        }
    }
    // Note: if spawn returned Err (e.g. logcat binary missing on the device),
    // we silently ignore. The frontend will see get_log_count stay at 0 from
    // the logcat source and may surface that as an empty log stream.
}

#[tauri::command]
fn set_debug_mode(app: tauri::AppHandle, enabled: bool) {
    {
        let mut flag = LOG_STATE.enabled.lock().unwrap();
        *flag = enabled;
    }
    if enabled {
        // tauri.conf.json 的 productName 作为 logcat tag 过滤
        let tag = env!("CARGO_PKG_NAME");
        start_logcat(tag);
    } else {
        stop_logcat();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_log_count, append_log, set_debug_mode, export_logs_to_download])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}