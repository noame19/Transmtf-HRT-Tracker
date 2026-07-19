# 用药提醒:Android AlarmManager setAlarmClock 改造

> **For agentic workers:** 实施参考文档,记录 2026-07-19 改造的前后对比、为何选 setAlarmClock、外部 Android Studio 工程的 AndroidManifest 必加项。

## 背景(Why)

用户反馈:在 Android 12 设备上,App **没打开 + 后台被系统杀** 后,到时间不弹通知。

### 现状(改造前)

`src-tauri/scripts/NotificationScheduler.kt:129` 用的是:

```kotlin
am.setWindow(AlarmManager.RTC_WAKEUP, moment, TimeUnit.MINUTES.toMillis(5), pi)
```

- `setWindow` 是 **inexact**(系统允许 ±几分钟甚至更长延迟)
- **Doze 模式** + **App Standby Buckets** + **OEM 杀后台** 三重叠加下,完全可能直接丢闹钟
- 即便响了,延迟 10-30 分钟常见

### 目标

- 100% 准时
- App 关闭、杀后台、锁屏、Doze 模式全场景下都能触发
- 触发后只发**普通通知栏 notification**(不弹 Activity 锁屏全屏)

### 选型(Why setAlarmClock)

Android AlarmManager 三档精度 API:

| API | 精度 | 穿透 Doze | 穿透 App Standby | 杀后台存活 | 需权限 | 副作用 |
|---|---|---|---|---|---|---|
| `setWindow` | ±N 分钟 | ❌ | ❌ | ❌ | 无 | 无 |
| `setExactAndAllowWhileIdle` | ±几秒 | ✅ | ❌ | ❌(OEM 杀) | `SCHEDULE_EXACT_ALARM` (API 31+, 需用户授权) | 无 |
| `setAlarmClock` | 准时 | ✅ | ✅ | ✅(按 alarm clock 优先级) | `USE_EXACT_ALARM` (API 33+, 系统自动授权) + `SCHEDULE_EXACT_ALARM` (API 31-32) | 系统状态栏显示"下次闹钟"小标记(可接受) |

`setAlarmClock` 是 Android 平台上**唯一**在 Doze + App Standby + OEM 杀后台三连击下仍能 100% 触发的 API。系统把它和用户手动设的闹钟同等对待,优先级最高,不做批处理。

副作用(状态栏"下次闹钟"小标记)对药物提醒场景完全可接受,远好于"到点不响"。

## 改动(What)

### 改动 1: `src-tauri/scripts/NotificationScheduler.kt`

- `setWindow(...)` → `setAlarmClock(...)`
- 顶部 doc 注释更新,说明新策略
- 循环内的注释也更新

变更前后:

```diff
- am.setWindow(AlarmManager.RTC_WAKEUP, moment, TimeUnit.MINUTES.toMillis(5), pi)
+ am.setAlarmClock(AlarmManager.RTC_WAKEUP, moment, pi)
```

### 改动 2: `src-tauri/scripts/ReminderReceiver.kt`

**无需逻辑改动** — 已经只发 `NotificationCompat.Builder` 普通通知,没有 `setFullScreenIntent`,没有 `setUsesChronometer`,没有 `LaunchActivity` 强弹窗。仅顶部 doc 注释更新,说明"虽然是 setAlarmClock 触发的,但只发普通 heads-up notification,绝不抢锁屏"。

### 改动 3: 外部 Android Studio 工程的 `AndroidManifest.xml`

仓库里没有 AndroidManifest.xml 源文件(APK 是 `apk_dl/` 下手工构建的),用户需要在自己维护的 Android Studio 工程里加权限。

**必加项**(`<manifest>` 顶层):

```xml
<!-- 31 (Android 12) 以前的设备,以及 31-32 设备的 fallback -->
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />

<!-- 33 (Android 13) 及以上:不需要用户授权,系统自动授予 alarm-clock 类应用 -->
<uses-permission android:name="android.permission.USE_EXACT_ALARM" />
```

**必加 receiver 注册**(`<application>` 里):

```xml
<receiver
    android:name=".ReminderReceiver"
    android:exported="false">
    <intent-filter>
        <action android:name="com.smirnovayama.hrttracker.REMINDER_FIRE" />
    </intent-filter>
</receiver>

<receiver
    android:name=".BootReceiver"
    android:exported="true"
    android:permission="android.permission.RECEIVE_BOOT_COMPLETED">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
    </intent-filter>
</receiver>
```

**自启动白名单(国产 ROM 必加)**: MIUI/EMUI/ColorOS 即使有 BOOT_COMPLETED 注册,也不会自动启动。需在用户首启动引导加自启动白名单 + 电池优化白名单。代码里没有这部分 — 后续单独 issue。

## 验收清单(How to verify)

### 单元验证(代码)

- [x] `NotificationScheduler.kt` 已用 `setAlarmClock`
- [x] `ReminderReceiver.kt` 没有 `setFullScreenIntent` / `LaunchActivity` 强弹窗
- [x] `BootReceiver.kt` 不变(已正确实现 BOOT_COMPLETED + MY_PACKAGE_REPLACED)

### 集成验证(真机,需用户做)

仓库没有 Android 构建链路,以下清单用户在 Android Studio 重建 APK 后人工走通:

- [ ] Android 12 设备,安装新 APK
- [ ] 创建一条用药计划,leadMinutes=0,due=2 分钟后
- [ ] **完全杀掉 App**(从最近任务里滑掉)
- [ ] 等待 → 2 分钟后通知弹出(无锁屏全屏)
- [ ] 解锁手机,通知仍可见
- [ ] 锁屏 → 通知 heads-up 弹一下
- [ ] 设备重启 → BOOT_COMPLETED 后,所有未来提醒仍能正常响
- [ ] Android 13+ 设备:`USE_EXACT_ALARM` 在 manifest 后**不弹权限框**
- [ ] Android 12 设备:`SCHEDULE_EXACT_ALARM` 在 manifest 后**不弹权限框**(Android 12 行为: 只要 manifest 声明就 grant)
- [ ] Android 11 及以下:`setAlarmClock` 仍能工作(API 19+ 就有的方法,旧设备完全兼容)

### 不在本次范围内(留作 follow-up)

- Foreground Service 维持(API 26+ 需要常驻通知,UX 不友好)
- 引导用户加自启动 + 电池白名单对话框(国产 ROM 救星,需要 UX 设计)
- 锁屏全屏弹窗模式(用户明确拒绝)
- 提醒频次高的场景(如每天 6 次)考虑合并通知(避免系统"通知洪水"屏蔽)

## 风险

- **状态栏"下次闹钟"小标记**:用户首次看到会问"这是闹钟 app?" — 可在 App 内"设置"页加一句说明
- **OEM 杀后台 + BOOT_COMPLETED 收不到**: MIUI/EMUI/ColorOS 即使 manifest 加了 RECEIVE_BOOT_COMPLETED,也不会自动触发。需在首启动引导用户去系统设置加自启动。这部分**未在本次实施**,需要单独 issue。
- **系统时间改动**: 用户改时间会触发提前/延后,与原 setWindow 行为一致,无回归
- **重启 + 时区改动**: setAlarmClock 内部基于 RTC_WAKEUP(实时时钟),不受时区影响。与 setWindow 行为一致,无回归
