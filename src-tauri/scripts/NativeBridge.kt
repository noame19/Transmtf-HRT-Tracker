package com.smirnovayama.hrttracker

/**
 * Kotlin-side bridge to the `hrt_tracker_lib` native library.
 *
 * The matching JNI symbols are exposed from `src-tauri/src/lib.rs`:
 *   - `Java_com_smirnovayama_hrttracker_NativeBridge_initializeAndroidContext`
 *     feeds the JavaVM + Activity into `ndk_context::initialize_android_context`,
 *     so `ndk_context::android_context()` (used by `with_android_env`) works later.
 *
 * Library name must match `[lib] name = "hrt_tracker_lib"` in Cargo.toml
 * (System.loadLibrary strips the `lib` prefix and `.so` suffix).
 *
 * Renamed from `Rust` → `NativeBridge`: tauri-cli auto-generates a
 * `Rust.kt` in the same package (under `generated/`) which clashes with
 * our class, so we pick a different top-level name.
 */
object NativeBridge {
    init {
        System.loadLibrary("hrt_tracker_lib")
    }

    /**
     * Call this from `MainActivity.onCreate` BEFORE `super.onCreate(...)` returns
     * — i.e. on the main thread before any Tauri command that touches the
     * Android `JavaVM`/`Context` via JNI is dispatched.
     */
    @JvmStatic
    external fun initializeAndroidContext(activity: Any)
}