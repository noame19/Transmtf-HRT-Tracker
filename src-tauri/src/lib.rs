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

#[tauri::command]
fn get_log_count() -> usize {
    LOG_STATE.len()
}

#[tauri::command]
fn append_log(level: String, msg: String) {
    LOG_STATE.append("js", &level, &msg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_log_count, append_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}