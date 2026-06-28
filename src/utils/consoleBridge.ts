// consoleBridge.ts — capture JS console logs into Tauri ring buffer (debug mode only)
//
// Module side-effect: wraps console.log/info/warn/error/debug on first import.
// OFF state (localStorage 'hrt-debug-mode' != '1') is a complete no-op.

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
    interface Window {
        __TAURI_INTERNALS__?: { invoke?: InvokeFn };
    }
}

function isOn(): boolean {
    try {
        return localStorage.getItem('hrt-debug-mode') === '1';
    } catch {
        return false;
    }
}

function sendToBackend(level: string, args: unknown[]): void {
    if (!isOn()) return;
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    const msg = args
        .map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(' ');
    Promise.resolve(invoke('append_log', { level, msg })).catch(() => { /* swallow */ });
}

let installed = false;

export function installConsoleBridge(): void {
    if (installed) return;
    installed = true;
    const orig = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
    };
    console.log = (...args) => { sendToBackend('INFO', args); orig.log(...args); };
    console.info = (...args) => { sendToBackend('INFO', args); orig.info(...args); };
    console.warn = (...args) => { sendToBackend('WARN', args); orig.warn(...args); };
    console.error = (...args) => { sendToBackend('ERROR', args); orig.error(...args); };
    console.debug = (...args) => { sendToBackend('DEBUG', args); orig.debug(...args); };
}

if (typeof window !== 'undefined') {
    installConsoleBridge();
}
