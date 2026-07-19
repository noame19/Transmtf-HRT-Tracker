# Android 桌面小组件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Android 桌面添加 7 个 AppWidget,显示 HRT 助手的关键信息(下次服药倒计时 + 当前浓度缓存 + 当月日历热力图),不打开 App 也能瞥一眼

**Architecture:**
- 数据契约层: App 在前台时调 Rust command 算 snapshot, 写到 SharedPreferences
- 渲染层: 7 个独立 AppWidgetProvider, 各从一个 layout XML 渲染, 通过 `onAppWidgetOptionsChanged` 切 3x2/2x3 布局
- 调度层: WorkManager 每 30 分钟起 Worker 重读 snapshot 重绘 widget
- 引导层: 复用现有 WhitelistBanner 提示用户给自启动加白名单

**Tech Stack:** Tauri v2 (Rust) + Kotlin (Android) + WorkManager + AppWidgetProvider + RemoteViews + SharedPreferences + vitest (单测) + GitHub Actions (CI 自动 patch AndroidManifest)

**Spec:** `docs/superpowers/specs/2026-07-20-android-widget-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/utils/widgetSnapshot.ts` | WidgetSnapshot TypeScript 类型 + staleness 计算 |
| `src/utils/__tests__/widgetSnapshot.test.ts` | vitest 单测 |
| `src/state/useWidgetSnapshot.ts` | React hook, 监听 events/plans/visibility 触发 compute + write |
| `src-tauri/src/snapshot.rs` | Rust 端 compute_widget_snapshot 实现 |
| `src-tauri/scripts/widget/WidgetSnapshotStore.kt` | 读写 SharedPreferences "hrt_widget_snapshot" |
| `src-tauri/scripts/widget/WidgetRefresher.kt` | refreshAll(ctx) — 触发所有 7 个 widget 重绘 |
| `src-tauri/scripts/widget/WidgetRefreshWorker.kt` | WorkManager CoroutineWorker |
| `src-tauri/scripts/widget/WidgetRefreshScheduler.kt` | WorkManager 调度入口 |
| `src-tauri/scripts/widget/WidgetRenderHelper.kt` | 共享渲染 (7 个 render 函数 + staleness + countdown) |
| `src-tauri/scripts/widget/E2ConcWidgetProvider.kt` | E2 浓度单侧 Provider |
| `src-tauri/scripts/widget/E2PlanWidgetProvider.kt` | E2 计划单侧 Provider |
| `src-tauri/scripts/widget/E2FullWidgetProvider.kt` | E2 精简全卡 Provider |
| `src-tauri/scripts/widget/AaConcWidgetProvider.kt` | 抗雄浓度单侧 Provider |
| `src-tauri/scripts/widget/AaPlanWidgetProvider.kt` | 抗雄计划单侧 Provider |
| `src-tauri/scripts/widget/AaFullWidgetProvider.kt` | 抗雄精简全卡 Provider |
| `src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt` | 日历热力图 Provider |
| `src-tauri/scripts/widget/layouts/widget_e2_conc.xml` | E2 浓度 layout (含 3x2 + 2x3 双布局) |
| `src-tauri/scripts/widget/layouts/widget_e2_plan.xml` | E2 计划 layout |
| `src-tauri/scripts/widget/layouts/widget_aa_conc.xml` | AA 浓度 layout |
| `src-tauri/scripts/widget/layouts/widget_aa_plan.xml` | AA 计划 layout |
| `src-tauri/scripts/widget/layouts/widget_e2_full.xml` | E2 全卡 layout (5x2 固定) |
| `src-tauri/scripts/widget/layouts/widget_aa_full.xml` | AA 全卡 layout |
| `src-tauri/scripts/widget/layouts/widget_cal_heatmap.xml` | 日历 layout (4x3 固定) |
| `src-tauri/scripts/widget/layouts/widget_heatmap_cell.xml` | 日历单元格模板 |
| `src-tauri/scripts/widget/layouts/widget_e2_conc_info.xml` | E2 浓度 appwidget-provider 元数据 |
| `src-tauri/scripts/widget/layouts/widget_e2_plan_info.xml` | E2 计划 元数据 |
| `src-tauri/scripts/widget/layouts/widget_aa_conc_info.xml` | AA 浓度 元数据 |
| `src-tauri/scripts/widget/layouts/widget_aa_plan_info.xml` | AA 计划 元数据 |
| `src-tauri/scripts/widget/layouts/widget_e2_full_info.xml` | E2 全卡 元数据 |
| `src-tauri/scripts/widget/layouts/widget_aa_full_info.xml` | AA 全卡 元数据 |
| `src-tauri/scripts/widget/layouts/widget_cal_heatmap_info.xml` | 日历 元数据 |
| `src-tauri/scripts/AndroidManifest.widget.snippet.xml` | 7 个 receiver + meta-data 注入锚点 |
| `docs/superpowers/specs/2026-07-20-android-widget-verify.md` | 真机验证 checklist |

### 修改文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | 注册 `compute_widget_snapshot` + `write_widget_snapshot` 两个 command |
| `src-tauri/scripts/BootReceiver.kt` | 监听 BOOT_COMPLETED/MY_PACKAGE_REPLACED 后调 `WidgetRefreshScheduler.schedule()` |
| `.github/workflows/android-release.yml` | 新增 3 个 step: 注入 widget providers + 复制 Kotlin + 复制 res XML |
| `package.json` | 加 androidx.work:work-runtime-ktx (CI 端; 主 app 端已用 androidx) |

---

# Phase 1: 数据契约 + TS 端 staleness 计算

## Task 1.1: WidgetSnapshot TypeScript 类型定义

**Files:**
- Create: `src/utils/widgetSnapshot.ts`

- [ ] **Step 1: 创建 widgetSnapshot.ts, 定义核心类型**

```typescript
// src/utils/widgetSnapshot.ts

/** AppWidget 用的紧凑快照。App 端算好写 SharedPreferences, WidgetProvider 端读。
 *  设计原则: 字段尽量少, 数值字符串化(避免 widget 端类型转换)。 */
export interface WidgetSnapshot {
    schemaVersion: 1;
    /** 写入时刻 (ms since epoch). widget 用此算 staleness. */
    computedAtMs: number;

    /** E2 (雌二醇) 主计划的摘要 */
    e2: WidgetDrugSummary | null;
    /** 抗雄药主计划的摘要 */
    antiandrogen: WidgetDrugSummary | null;

    /** 6 周 × 7 天 = 42 格的色块状态, 周一开始. */
    calendarHeatmap: WidgetHeatmapCell[];
}

export interface WidgetDrugSummary {
    /** 药名 (i18n 后). 例: "戊酸雌二醇" / "醋酸环丙孕酮" */
    drugName: string;
    /** 缩写. 例: "EV" / "CPA" */
    ester: string;
    /** 剂量 (mg). 例: 4.0 */
    doseMG: number;
    /** 途径 (i18n 后). 例: "舌下含服" / "口服" / "肌注" */
    routeLabel: string;
    /** 当前浓度数值 (E2: pg/mL, 抗雄: ng/mL). null = 未知 */
    currentLevel: number | null;
    /** 95% CI 下界 */
    ci95Low: number | null;
    /** 95% CI 上界 */
    ci95High: number | null;
    /** 下次计划用药时间 (ms). null = 无计划 */
    nextDueAtMs: number | null;
    /** 上次实际用药时间 (ms). null = 未用药 */
    lastDoseAtMs: number | null;
}

export interface WidgetHeatmapCell {
    /** 该日 0 点本地时间 (ms). */
    dateMs: number;
    /** 该日是否有 E2 用药 */
    hasE2: boolean;
    /** 该日是否有抗雄用药 */
    hasAa: boolean;
    /** 该日是否有计划触发 */
    hasPlan: boolean;
    /** 该日是否推迟过 */
    hasPostpone: boolean;
    /** 是否今天 (UTC 当天). */
    isToday: boolean;
}

/** staleness 文案分级 (纯文字, 不染色) */
export function stalenessText(computedAtMs: number, nowMs: number): string {
    const diffMin = Math.max(0, (nowMs - computedAtMs) / 60000);
    if (diffMin < 5) return '刚刚更新';
    if (diffMin < 30) return `${Math.floor(diffMin)} 分钟前更新`;
    if (diffMin < 120) return '半小时前更新';
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前更新`;
    return '1 天前更新 · 数据可能已变化';
}

/** 倒计时文案. nextDueAtMs < now 表示已过期. */
export function countdownText(nextDueAtMs: number | null, nowMs: number): string {
    if (nextDueAtMs == null) return '--:--';
    const diffMin = (nextDueAtMs - nowMs) / 60000;
    if (diffMin < 0) {
        const overdue = Math.abs(diffMin);
        if (overdue < 60) return `已过期 ${Math.floor(overdue)}m`;
        return `已过期 ${Math.floor(overdue / 60)}h${Math.floor(overdue % 60)}m`;
    }
    if (diffMin < 60) return `${Math.floor(diffMin)}m`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h${Math.floor(diffMin % 60)}m`;
    return `${Math.floor(diffMin / 1440)}d${Math.floor((diffMin % 1440) / 60)}h`;
}
```

- [ ] **Step 2: 验证文件编译通过**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit src/utils/widgetSnapshot.ts 2>&1 | head -20`
Expected: 无输出 (TS 编译通过)

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src/utils/widgetSnapshot.ts
git commit -m "feat(widget): WidgetSnapshot TypeScript 类型 + staleness/countdown 工具函数"
```

---

## Task 1.2: widgetSnapshot 单测 (vitest)

**Files:**
- Create: `src/utils/__tests__/widgetSnapshot.test.ts`

- [ ] **Step 1: 写 staleness 测试**

```typescript
// src/utils/__tests__/widgetSnapshot.test.ts
import { describe, it, expect } from 'vitest';
import { stalenessText, countdownText } from '../widgetSnapshot';

describe('stalenessText', () => {
    const now = 1_700_000_000_000;

    it('5 分钟内显示"刚刚更新"', () => {
        expect(stalenessText(now - 1 * 60_000, now)).toBe('刚刚更新');
        expect(stalenessText(now - 4 * 60_000, now)).toBe('刚刚更新');
    });

    it('5-30 分钟显示"N 分钟前更新"', () => {
        expect(stalenessText(now - 5 * 60_000, now)).toBe('5 分钟前更新');
        expect(stalenessText(now - 29 * 60_000, now)).toBe('29 分钟前更新');
    });

    it('30-120 分钟显示"半小时前更新"', () => {
        expect(stalenessText(now - 30 * 60_000, now)).toBe('半小时前更新');
        expect(stalenessText(now - 119 * 60_000, now)).toBe('半小时前更新');
    });

    it('2-24 小时显示"N 小时前更新"', () => {
        expect(stalenessText(now - 120 * 60_000, now)).toBe('2 小时前更新');
        expect(stalenessText(now - 23 * 60_000_000, now)).toBe('23 小时前更新');
    });

    it('>=24 小时显示"1 天前更新 · 数据可能已变化"', () => {
        expect(stalenessText(now - 24 * 60 * 60_000, now)).toBe('1 天前更新 · 数据可能已变化');
        expect(stalenessText(now - 48 * 60 * 60_000, now)).toBe('1 天前更新 · 数据可能已变化');
    });
});

describe('countdownText', () => {
    const now = 1_700_000_000_000;

    it('null 返回 "--:--"', () => {
        expect(countdownText(null, now)).toBe('--:--');
    });

    it('未来 < 60 分钟显示 "Nm"', () => {
        expect(countdownText(now + 30 * 60_000, now)).toBe('30m');
        expect(countdownText(now + 59 * 60_000, now)).toBe('59m');
    });

    it('未来 1-24 小时显示 "XhYm"', () => {
        expect(countdownText(now + 60 * 60_000, now)).toBe('1h0m');
        expect(countdownText(now + 2 * 60 * 60_000 + 35 * 60_000, now)).toBe('2h35m');
    });

    it('过期 < 60 分钟显示 "已过期 Nm"', () => {
        expect(countdownText(now - 30 * 60_000, now)).toBe('已过期 30m');
    });

    it('过期 >= 60 分钟显示 "已过期 XhYm"', () => {
        expect(countdownText(now - 75 * 60_000, now)).toBe('已过期 1h15m');
    });

    it('未来 >= 24 小时显示 "XdYh"', () => {
        expect(countdownText(now + 25 * 60 * 60_000, now)).toBe('1d1h');
    });
});
```

- [ ] **Step 2: 运行测试**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run src/utils/__tests__/widgetSnapshot.test.ts 2>&1 | tail -20`
Expected: `Test Files  1 passed (1)` + `Tests  11 passed (11)`

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src/utils/__tests__/widgetSnapshot.test.ts
git commit -m "test(widget): stalenessText + countdownText vitest 单测 11 项"
```

---

# Phase 2: Rust 端 compute_widget_snapshot

## Task 2.1: snapshot.rs 模块骨架 + 函数签名

**Files:**
- Create: `src-tauri/src/snapshot.rs`

- [ ] **Step 1: 创建 snapshot.rs**

```rust
// src-tauri/src/snapshot.rs

use crate::types::*;
use serde::{Deserialize, Serialize};

/// WidgetSnapshot 数据契约 (TS 端同构).
/// 字段顺序与 TS WidgetSnapshot 完全一致, 便于跨语言阅读.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetSnapshot {
    pub schema_version: u32,
    pub computed_at_ms: i64,
    pub e2: Option<WidgetDrugSummary>,
    pub antiandrogen: Option<WidgetDrugSummary>,
    pub calendar_heatmap: Vec<WidgetHeatmapCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetDrugSummary {
    pub drug_name: String,
    pub ester: String,
    pub dose_mg: f64,
    pub route_label: String,
    pub current_level: Option<f64>,
    pub ci95_low: Option<f64>,
    pub ci95_high: Option<f64>,
    pub next_due_at_ms: Option<i64>,
    pub last_dose_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetHeatmapCell {
    pub date_ms: i64,
    pub has_e2: bool,
    pub has_aa: bool,
    pub has_plan: bool,
    pub has_postpone: bool,
    pub is_today: bool,
}

/// 算 widget snapshot 的主入口.
/// MVP 阶段: 直接返回空 snapshot, 由后续 task 填充真实计算逻辑.
pub fn compute(
    events: Vec<DoseEvent>,
    plans: Vec<Plan>,
    _postpone_log: Vec<PostponeLogEntry>,
    _due_log: Vec<DueLogEntry>,
    now_ms: i64,
) -> Result<WidgetSnapshot, String> {
    Ok(WidgetSnapshot {
        schema_version: 1,
        computed_at_ms: now_ms,
        e2: None,
        antiandrogen: None,
        calendar_heatmap: Vec::new(),
    })
}
```

注: 这里简化了类型导入, 实际实现时需要根据 `src-tauri/src/types.rs` 调整 `DoseEvent / Plan / PostponeLogEntry / DueLogEntry` 的具体定义。

- [ ] **Step 2: 在 lib.rs 加 module 声明 + command**

```rust
// src-tauri/src/lib.rs 顶部加:
mod snapshot;

// 在 generate_handler! 宏内加:
.compute_widget_snapshot,
```

并在文件合适位置加 command 定义:

```rust
#[tauri::command]
pub async fn compute_widget_snapshot(
    events: Vec<DoseEvent>,
    plans: Vec<Plan>,
    postpone_log: Vec<PostponeLogEntry>,
    due_log: Vec<DueLogEntry>,
    now_ms: i64,
) -> Result<snapshot::WidgetSnapshot, String> {
    snapshot::compute(events, plans, postpone_log, due_log, now_ms)
}
```

- [ ] **Step 3: 编译验证**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker/src-tauri" && cargo check 2>&1 | tail -10`
Expected: `Finished` 编译成功 (可能有 unused variable warning, 但 build 通过)

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/src/snapshot.rs src-tauri/src/lib.rs
git commit -m "feat(widget): Rust 端 compute_widget_snapshot command 骨架 (MVP 返回空 snapshot)"
```

---

## Task 2.2: 填充 compute 函数真实逻辑 (stub 版)

**Files:**
- Modify: `src-tauri/src/snapshot.rs`

- [ ] **Step 1: 实现 drug summary 计算**

替换 `compute` 函数体:

```rust
pub fn compute(
    events: Vec<DoseEvent>,
    plans: Vec<Plan>,
    postpone_log: Vec<PostponeLogEntry>,
    due_log: Vec<DueLogEntry>,
    now_ms: i64,
) -> Result<WidgetSnapshot, String> {
    let e2 = compute_drug_summary(&events, &plans, now_ms, /*is_e2=*/true);
    let antiandrogen = compute_drug_summary(&events, &plans, now_ms, /*is_e2=*/false);
    let calendar_heatmap = compute_heatmap_cells(&events, &plans, &postpone_log, &due_log, now_ms);

    Ok(WidgetSnapshot {
        schema_version: 1,
        computed_at_ms: now_ms,
        e2,
        antiandrogen,
        calendar_heatmap,
    })
}

fn compute_drug_summary(
    events: &[DoseEvent],
    plans: &[Plan],
    now_ms: i64,
    is_e2: bool,
) -> Option<WidgetDrugSummary> {
    // MVP stub: 返回 None 表示"无该药物的主计划".
    // 后续 task 接入真实算法: pk::runSimulation + interpolateConcentration_E2 / _CPA
    let _ = (events, plans, now_ms, is_e2);
    None
}

fn compute_heatmap_cells(
    events: &[DoseEvent],
    plans: &[Plan],
    postpone_log: &[PostponeLogEntry],
    due_log: &[DueLogEntry],
    now_ms: i64,
) -> Vec<WidgetHeatmapCell> {
    // MVP stub: 生成最近 6 周 × 7 天 = 42 格空 cell, 仅标记 today.
    // 后续 task 接入真实逻辑: 按 events/plans/postpone_log/due_log 标记 has_e2/has_aa/has_plan/has_postpone.
    let mut cells = Vec::with_capacity(42);
    let day_ms = 86_400_000i64;
    // 找最近一个周一 0 点
    let mut cursor_ms = now_ms - (6 * 7 * day_ms);
    for _ in 0..42 {
        cells.push(WidgetHeatmapCell {
            date_ms: cursor_ms,
            has_e2: false,
            has_aa: false,
            has_plan: false,
            has_postpone: false,
            is_today: same_day(cursor_ms, now_ms),
        });
        cursor_ms += day_ms;
    }
    let _ = (events, plans, postpone_log, due_log);
    cells
}

fn same_day(a_ms: i64, b_ms: i64) -> bool {
    // 简化: 用本地时区对齐到天. MVP 阶段按 UTC.
    (a_ms / 86_400_000) == (b_ms / 86_400_000)
}
```

- [ ] **Step 2: 编译验证**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker/src-tauri" && cargo check 2>&1 | tail -10`
Expected: `Finished` 编译成功

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/src/snapshot.rs
git commit -m "feat(widget): snapshot.rs 填充 compute 函数 stub 版 (返回 42 格空 cell)"
```

注: 真实算法接入留给后续 task (单独的大 task, 因为要 port 或包装 pk.ts 整套).

---

# Phase 3: Kotlin WidgetSnapshotStore + Worker

## Task 3.1: WidgetSnapshotStore (读写 SharedPreferences)

**Files:**
- Create: `src-tauri/scripts/widget/WidgetSnapshotStore.kt`

- [ ] **Step 1: 创建 WidgetSnapshotStore.kt**

```kotlin
// src-tauri/scripts/widget/WidgetSnapshotStore.kt
package com.smirnovayama.hrttracker.widget

import android.content.Context
import org.json.JSONObject

/** 读写 SharedPreferences "hrt_widget_snapshot" 的小工具. */
object WidgetSnapshotStore {
    private const val PREF_NAME = "hrt_widget_snapshot"
    private const val KEY_SNAPSHOT = "snapshot_v1"
    private const val KEY_COMPUTED_AT = "computed_at_ms"

    /** 从 SharedPreferences 读出 snapshot JSON 字符串. null = 从未写入过. */
    fun read(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SNAPSHOT, null)
    }

    /** 写 snapshot JSON + 立刻触所有 widget 重绘. */
    fun write(ctx: Context, snapshotJson: String) {
        ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SNAPSHOT, snapshotJson)
            .putLong(KEY_COMPUTED_AT, System.currentTimeMillis())
            .apply()
        WidgetRefresher.refreshAll(ctx)
    }

    /** 读上次写入时间 (ms). 0L = 从未写入过. */
    fun lastComputedAt(ctx: Context): Long {
        return ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .getLong(KEY_COMPUTED_AT, 0L)
    }
}
```

注: 此文件依赖 Phase 3 后续 task 创建的 `WidgetRefresher`. 在 Task 3.5 之前 import 会失败, 这是预期的 (按顺序执行).

- [ ] **Step 2: Commit (等 Task 3.5 一起提交, 此处仅创建文件)**

跳过单独 commit, 等 Task 3.5 一并提交.

---

## Task 3.2: WidgetRefresher (refreshAll)

**Files:**
- Create: `src-tauri/scripts/widget/WidgetRefresher.kt`

- [ ] **Step 1: 创建 WidgetRefresher.kt**

```kotlin
// src-tauri/scripts/widget/WidgetRefresher.kt
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context

/** 触发所有 7 个 widget 重绘的共享方法. 由 WidgetSnapshotStore.write() 和 WorkManager 调用. */
object WidgetRefresher {
    /** 所有 7 个 widget provider 的 Class 引用. */
    private val PROVIDERS = listOf(
        E2ConcWidgetProvider::class.java,
        E2PlanWidgetProvider::class.java,
        E2FullWidgetProvider::class.java,
        AaConcWidgetProvider::class.java,
        AaPlanWidgetProvider::class.java,
        AaFullWidgetProvider::class.java,
        CalendarHeatmapWidgetProvider::class.java,
    )

    /** 触发所有 7 类 widget 的 onUpdate (逐个). */
    fun refreshAll(ctx: Context) {
        val mgr = AppWidgetManager.getInstance(ctx)
        PROVIDERS.forEach { cls ->
            val componentName = ComponentName(ctx, cls)
            val ids = mgr.getAppWidgetIds(componentName)
            if (ids.isNotEmpty()) {
                // 给每个 provider 发 ACTION_APPWIDGET_UPDATE intent
                val intent = android.content.Intent(ctx, cls).apply {
                    action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                }
                ctx.sendBroadcast(intent)
            }
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/WidgetSnapshotStore.kt src-tauri/scripts/widget/WidgetRefresher.kt
git commit -m "feat(widget): Kotlin WidgetSnapshotStore + WidgetRefresher 骨架"
```

注: 此 commit 引用的 7 个 Provider Class 在 Phase 4-6 才创建, 编译会失败. 在 Phase 6 完成后才能 cargo check 通过. 在此期间接受编译失败, 等所有 Provider 就位后一并验证.

---

## Task 3.3: WidgetRefreshWorker (WorkManager)

**Files:**
- Create: `src-tauri/scripts/widget/WidgetRefreshWorker.kt`

- [ ] **Step 1: 创建 WidgetRefreshWorker.kt**

```kotlin
// src-tauri/scripts/widget/WidgetRefreshWorker.kt
package com.smirnovayama.hrttracker.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/** 每 30 分钟触发一次的 Worker. 读 snapshot 重新渲染所有 widget.
 *  snapshot 数据由 App 主进程在写 SharedPreferences 时已经算好,
 *  Worker 只是触发 widget 重绘, 不重新算浓度 (太重). */
class WidgetRefreshWorker(
    ctx: Context,
    params: WorkerParameters,
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // 如果 snapshot 还没写过, skip (等下次 App 启动写入)
        if (WidgetSnapshotStore.lastComputedAt(ctx) <= 0L) {
            return Result.success()
        }
        WidgetRefresher.refreshAll(ctx)
        return Result.success()
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/WidgetRefreshWorker.kt
git commit -m "feat(widget): Kotlin WidgetRefreshWorker (WorkManager CoroutineWorker)"
```

---

## Task 3.4: WidgetRefreshScheduler (调度入口)

**Files:**
- Create: `src-tauri/scripts/widget/WidgetRefreshScheduler.kt`

- [ ] **Step 1: 创建 WidgetRefreshScheduler.kt**

```kotlin
// src-tauri/scripts/widget/WidgetRefreshScheduler.kt
package com.smirnovayama.hrttracker.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/** WorkManager 调度 widget 刷新任务. */
object WidgetRefreshScheduler {
    private const val WORK_NAME = "hrt_widget_refresh"

    /** 排一个 30 分钟周期的 PeriodicWork. 幂等: 多次调用不会重复排队. */
    fun schedule(ctx: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiresBatteryNotLow(false)  // 30 分钟一次不耗电
                    .setRequiresNetworkNotConnected(false)  // 完全离线算
                    .build()
            )
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** 取消调度 (用户手动关闭 widget 功能时). */
    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/WidgetRefreshScheduler.kt
git commit -m "feat(widget): Kotlin WidgetRefreshScheduler 调度入口"
```

---

## Task 3.5: BootReceiver 扩展 (重排 WorkManager)

**Files:**
- Modify: `src-tauri/scripts/BootReceiver.kt`

- [ ] **Step 1: 在 BootReceiver.onReceive 末尾追加重排**

```kotlin
// src-tauri/scripts/BootReceiver.kt 末尾追加 import + 重排逻辑
import com.smirnovayama.hrttracker.widget.WidgetRefreshScheduler

// 在 onReceive 方法末尾 (现有 alarm 重排代码之后) 追加:
if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
    intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
    WidgetRefreshScheduler.schedule(context)
}
```

- [ ] **Step 2: 编译验证**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker/src-tauri" && cargo check 2>&1 | tail -10`
Expected: 编译失败 (因为 WidgetRefreshScheduler 还没创建 — 但其实 Phase 3.4 已经创建, 应成功)

注: 实际上 Phase 3.4 已提交 WidgetRefreshScheduler.kt, 所以编译应成功.

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/BootReceiver.kt
git commit -m "feat(widget): BootReceiver 监 BOOT_COMPLETED/MY_PACKAGE_REPLACED 重排 WorkManager"
```

---

# Phase 4: 7 个 AppWidgetProvider + 共享渲染 helper

## Task 4.1: WidgetRenderHelper 骨架 (含 E2Conc 渲染)

**Files:**
- Create: `src-tauri/scripts/widget/WidgetRenderHelper.kt`

- [ ] **Step 1: 创建 WidgetRenderHelper.kt 含 renderE2Conc**

```kotlin
// src-tauri/scripts/widget/WidgetRenderHelper.kt
package com.smirnovayama.hrttracker.widget

import android.content.Context
import android.view.View
import android.widget.RemoteViews
import com.smirnovayama.hrttracker.R
import org.json.JSONObject
import kotlin.math.abs

/** 7 个 widget 的共享渲染逻辑. 各 Provider 在 onUpdate / onAppWidgetOptionsChanged 里调用. */
object WidgetRenderHelper {

    /** 算 staleness 文案 (与 TS 端 stalenessText 同款). */
    fun stalenessText(computedAtMs: Long, nowMs: Long): String {
        val diffMin = maxOf(0L, (nowMs - computedAtMs) / 60_000L)
        return when {
            diffMin < 5 -> "刚刚更新"
            diffMin < 30 -> "${diffMin} 分钟前更新"
            diffMin < 120 -> "半小时前更新"
            diffMin < 1440 -> "${diffMin / 60} 小时前更新"
            else -> "1 天前更新 · 数据可能已变化"
        }
    }

    /** 算倒计时文案 (与 TS 端 countdownText 同款). */
    fun countdownText(nextDueAtMs: Long?, nowMs: Long): String {
        if (nextDueAtMs == null) return "--:--"
        val diffMin = (nextDueAtMs - nowMs) / 60_000L
        return when {
            diffMin < 0 -> {
                val overdue = abs(diffMin)
                if (overdue < 60) "已过期 ${overdue}m"
                else "已过期 ${overdue / 60}h${overdue % 60}m"
            }
            diffMin < 60 -> "${diffMin}m"
            diffMin < 1440 -> "${diffMin / 60}h${diffMin % 60}m"
            else -> "${diffMin / 1440}d${(diffMin % 1440) / 60}h"
        }
    }

    /** 判断 widget 当前尺寸是否竖版 (height > width). */
    fun isVertical(ctx: Context, mgr: android.appwidget.AppWidgetManager, id: Int): Boolean {
        val opts = mgr.getAppWidgetOptions(id)
        val width = opts.getInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val height = opts.getInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
        return height > width
    }

    /** 渲染 E2 浓度 widget (3x2 横版 + 2x3 竖版). */
    fun renderE2Conc(
        ctx: Context,
        snapshot: JSONObject?,
        vertical: Boolean,
    ): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.widget_e2_conc)
        val now = System.currentTimeMillis()
        val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
        val e2 = snapshot?.optJSONObject("e2")

        val title = "E2 估算"
        val value = e2?.opt("currentLevel")?.let { if (it == JSONObject.NULL) null else it as? Double } ?: 0.0
        val ciLow = e2?.opt("ci95Low")?.let { if (it == JSONObject.NULL) null else it as? Double }
        val ciHigh = e2?.opt("ci95High")?.let { if (it == JSONObject.NULL) null else it as? Double }
        val stale = stalenessText(computedAt, now)

        if (vertical) {
            // 2x3 竖版: 只显示标题 + 数值 + 单位, 丢 CI 和 staleness
            rv.setViewVisibility(R.id.row3x2, View.GONE)
            rv.setViewVisibility(R.id.col2x3, View.VISIBLE)
            rv.setTextViewText(R.id.title2x3, title)
            rv.setTextViewText(R.id.value2x3, formatConc(value))
            rv.setTextViewText(R.id.unit2x3, "pg/mL")
        } else {
            // 3x2 横版: 标题 + staleness + 数值 + CI
            rv.setViewVisibility(R.id.row3x2, View.VISIBLE)
            rv.setViewVisibility(R.id.col2x3, View.GONE)
            rv.setTextViewText(R.id.title3x2, title)
            rv.setTextViewText(R.id.stale3x2, stale)
            rv.setTextViewText(R.id.value3x2, formatConc(value))
            rv.setTextViewText(R.id.ci3x2,
                if (ciLow != null && ciHigh != null) "95% CI ${ciLow.toInt()} – ${ciHigh.toInt()}" else "")
        }
        return rv
    }

    private fun formatConc(v: Double): String =
        if (v >= 100) v.toInt().toString() else "%.1f".format(v)
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/WidgetRenderHelper.kt
git commit -m "feat(widget): WidgetRenderHelper 骨架 + renderE2Conc"
```

---

## Task 4.2: widget_e2_conc.xml layout (3x2 + 2x3 双布局)

**Files:**
- Create: `src-tauri/scripts/widget/layouts/widget_e2_conc.xml`

- [ ] **Step 1: 创建 layout XML**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_conc.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="8dp">

    <!-- ── 3x2 横版布局 (vertical=false 时显示) ── -->
    <LinearLayout
        android:id="@+id/row3x2"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:orientation="vertical">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:weightSum="2">

            <TextView
                android:id="@+id/title3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:text="E2 估算"
                android:textSize="11sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/stale3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:gravity="end"
                android:textSize="9sp" />
        </LinearLayout>

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:orientation="horizontal"
            android:baselineAligned="true"
            android:weightSum="2">

            <TextView
                android:id="@+id/value3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:textColor="#F1405D"
                android:textSize="26sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/ci3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:gravity="bottom"
                android:textSize="10sp" />
        </LinearLayout>
    </LinearLayout>

    <!-- ── 2x3 竖版布局 (vertical=true 时显示, 丢 CI / staleness) ── -->
    <LinearLayout
        android:id="@+id/col2x3"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:orientation="vertical"
        android:visibility="gone">

        <TextView
            android:id="@+id/title2x3"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="E2 估算"
            android:textSize="10sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/value2x3"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:textColor="#F1405D"
            android:textSize="28sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/unit2x3"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="pg/mL"
            android:textSize="11sp" />
    </LinearLayout>
</LinearLayout>
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/layouts/widget_e2_conc.xml
git commit -m "feat(widget): widget_e2_conc.xml layout (3x2 + 2x3 双布局)"
```

---

## Task 4.3: widget_e2_conc_info.xml (appwidget-provider 元数据)

**Files:**
- Create: `src-tauri/scripts/widget/layouts/widget_e2_conc_info.xml`

- [ ] **Step 1: 创建 info XML**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_conc_info.xml -->
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="140dp"
    android:minHeight="140dp"
    android:minResizeWidth="140dp"
    android:minResizeHeight="140dp"
    android:targetCellWidth="3"
    android:targetCellHeight="2"
    android:widgetCategory="home_screen"
    android:resizeMode="horizontal|vertical"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_e2_conc"
    android:description="@string/widget_e2_conc_desc"
    android:previewImage="@drawable/widget_preview_e2_conc" />
```

注: `@string/widget_e2_conc_desc` 和 `@drawable/widget_preview_e2_conc` 在 Phase 7 一次性补齐.

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/layouts/widget_e2_conc_info.xml
git commit -m "feat(widget): widget_e2_conc_info.xml appwidget-provider 元数据"
```

---

## Task 4.4: E2ConcWidgetProvider.kt

**Files:**
- Create: `src-tauri/scripts/widget/E2ConcWidgetProvider.kt`

- [ ] **Step 1: 创建 E2ConcWidgetProvider.kt**

```kotlin
// src-tauri/scripts/widget/E2ConcWidgetProvider.kt
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

/** E2 当前浓度单侧 widget. 支持 3x2 横版 + 2x3 竖版 (用户装后拉拽切换). */
class E2ConcWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        ctx: Context,
        mgr: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val snapshotJson = WidgetSnapshotStore.read(ctx)
        val snapshot = snapshotJson?.let { JSONObject(it) }
        val now = System.currentTimeMillis()
        appWidgetIds.forEach { id ->
            val vertical = WidgetRenderHelper.isVertical(ctx, mgr, id)
            val rv = WidgetRenderHelper.renderE2Conc(ctx, snapshot, vertical)
            mgr.updateAppWidget(id, rv)
        }
    }

    override fun onAppWidgetOptionsChanged(
        ctx: Context,
        mgr: AppWidgetManager,
        appWidgetId: Int,
        newOptions: android.os.Bundle,
    ) {
        // 用户拉拽尺寸时触发, 按新尺寸重渲.
        val snapshotJson = WidgetSnapshotStore.read(ctx)
        val snapshot = snapshotJson?.let { JSONObject(it) }
        val vertical = WidgetRenderHelper.isVertical(ctx, mgr, appWidgetId)
        val rv = WidgetRenderHelper.renderE2Conc(ctx, snapshot, vertical)
        mgr.updateAppWidget(appWidgetId, rv)
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/E2ConcWidgetProvider.kt
git commit -m "feat(widget): E2ConcWidgetProvider.kt onUpdate + onAppWidgetOptionsChanged 切布局"
```

注: `WidgetRefresher.PROVIDERS` 引用此 Class — 编译会因缺其他 6 个 Provider 失败, 等 Phase 5-6 完成后才通过.

---

# Phase 5: 复制单侧 widget 给另外 5 个

## Task 5.1: E2PlanWidgetProvider + widget_e2_plan.xml + info

**Files:**
- Create: `src-tauri/scripts/widget/E2PlanWidgetProvider.kt`
- Create: `src-tauri/scripts/widget/layouts/widget_e2_plan.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_e2_plan_info.xml`

- [ ] **Step 1: 在 WidgetRenderHelper 加 renderE2Plan 函数**

修改 `WidgetRenderHelper.kt`, 在 `renderE2Conc` 后追加:

```kotlin
/** 渲染 E2 计划 widget (3x2 横版 + 2x3 竖版). */
fun renderE2Plan(
    ctx: Context,
    snapshot: JSONObject?,
    vertical: Boolean,
): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_e2_plan)
    val now = System.currentTimeMillis()
    val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
    val e2 = snapshot?.optJSONObject("e2")

    val drugName = e2?.optString("drugName", "") ?: ""
    val doseMG = e2?.optDouble("doseMG", 0.0) ?: 0.0
    val routeLabel = e2?.optString("routeLabel", "") ?: ""
    val nextDueAtMs = e2?.opt("nextDueAtMs")?.let { if (it == JSONObject.NULL) null else it as? Long }
    val stale = stalenessText(computedAt, now)

    val countdown = countdownText(nextDueAtMs, now)
    val absTime = if (nextDueAtMs != null) {
        val date = java.util.Date(nextDueAtMs)
        val fmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        fmt.format(date)
    } else "--:--"

    if (vertical) {
        // 2x3 竖版: 标题 + 倒计时 + 药名 | 绝对时间, 丢剂量 / staleness
        rv.setViewVisibility(R.id.row3x2, View.GONE)
        rv.setViewVisibility(R.id.col2x3, View.VISIBLE)
        rv.setTextViewText(R.id.title2x3, "下次 E2")
        rv.setTextViewText(R.id.countdown2x3, countdown)
        rv.setTextViewText(R.id.drug2x3, drugName)
        rv.setTextViewText(R.id.absTime2x3, absTime)
    } else {
        // 3x2 横版: 标题 | 途径 + 倒计时 | 绝对时间 + 药名 + staleness
        rv.setViewVisibility(R.id.row3x2, View.VISIBLE)
        rv.setViewVisibility(R.id.col2x3, View.GONE)
        rv.setTextViewText(R.id.title3x2, "下次 E2")
        rv.setTextViewText(R.id.route3x2, routeLabel)
        rv.setTextViewText(R.id.countdown3x2, countdown)
        rv.setTextViewText(R.id.absTime3x2, absTime)
        rv.setTextViewText(R.id.drug3x2, "$drugName ${doseMG}mg")
        rv.setTextViewText(R.id.stale3x2, stale)
    }
    return rv
}
```

- [ ] **Step 2: 创建 widget_e2_plan.xml**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_plan.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="8dp">

    <!-- 3x2 横版 -->
    <LinearLayout
        android:id="@+id/row3x2"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:orientation="vertical">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:weightSum="2">
            <TextView
                android:id="@+id/title3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:text="下次 E2"
                android:textSize="11sp"
                android:textStyle="bold" />
            <TextView
                android:id="@+id/route3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:gravity="end"
                android:textSize="10sp" />
        </LinearLayout>

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:orientation="horizontal"
            android:baselineAligned="true"
            android:weightSum="2">
            <TextView
                android:id="@+id/countdown3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:textSize="24sp"
                android:textStyle="bold" />
            <TextView
                android:id="@+id/absTime3x2"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:gravity="end|bottom"
                android:textSize="14sp" />
        </LinearLayout>

        <TextView
            android:id="@+id/drug3x2"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:textSize="10sp" />

        <TextView
            android:id="@+id/stale3x2"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:gravity="end"
            android:textSize="9sp" />
    </LinearLayout>

    <!-- 2x3 竖版 -->
    <LinearLayout
        android:id="@+id/col2x3"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:orientation="vertical"
        android:visibility="gone">
        <TextView
            android:id="@+id/title2x3"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="下次 E2"
            android:textSize="10sp"
            android:textStyle="bold" />
        <TextView
            android:id="@+id/countdown2x3"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:layout_marginTop="4dp"
            android:textSize="26sp"
            android:textStyle="bold" />
        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:weightSum="2">
            <TextView
                android:id="@+id/drug2x3"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:textSize="11sp" />
            <TextView
                android:id="@+id/absTime2x3"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:gravity="end"
                android:textSize="11sp" />
        </LinearLayout>
    </LinearLayout>
</LinearLayout>
```

- [ ] **Step 3: 创建 widget_e2_plan_info.xml**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_plan_info.xml -->
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="140dp"
    android:minHeight="140dp"
    android:minResizeWidth="140dp"
    android:minResizeHeight="140dp"
    android:targetCellWidth="3"
    android:targetCellHeight="2"
    android:widgetCategory="home_screen"
    android:resizeMode="horizontal|vertical"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_e2_plan"
    android:description="@string/widget_e2_plan_desc"
    android:previewImage="@drawable/widget_preview_e2_plan" />
```

- [ ] **Step 4: 创建 E2PlanWidgetProvider.kt**

```kotlin
// src-tauri/scripts/widget/E2PlanWidgetProvider.kt
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class E2PlanWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            val vertical = WidgetRenderHelper.isVertical(ctx, mgr, id)
            mgr.updateAppWidget(id, WidgetRenderHelper.renderE2Plan(ctx, snapshot, vertical))
        }
    }

    override fun onAppWidgetOptionsChanged(
        ctx: Context, mgr: AppWidgetManager, appWidgetId: Int, newOptions: android.os.Bundle,
    ) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        val vertical = WidgetRenderHelper.isVertical(ctx, mgr, appWidgetId)
        mgr.updateAppWidget(appWidgetId, WidgetRenderHelper.renderE2Plan(ctx, snapshot, vertical))
    }
}
```

- [ ] **Step 5: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/E2PlanWidgetProvider.kt \
        src-tauri/scripts/widget/WidgetRenderHelper.kt \
        src-tauri/scripts/widget/layouts/widget_e2_plan.xml \
        src-tauri/scripts/widget/layouts/widget_e2_plan_info.xml
git commit -m "feat(widget): E2PlanWidgetProvider + layout + render 函数"
```

---

## Task 5.2: 抗雄 4 个 widget (AaConc + AaPlan + AaFull × Provider / layout / info / render)

**Files:**
- Create: `src-tauri/scripts/widget/AaConcWidgetProvider.kt`
- Create: `src-tauri/scripts/widget/AaPlanWidgetProvider.kt`
- Create: `src-tauri/scripts/widget/AaFullWidgetProvider.kt`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_conc.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_plan.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_full.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_conc_info.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_plan_info.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_aa_full_info.xml`
- Modify: `src-tauri/scripts/widget/WidgetRenderHelper.kt` (加 renderAaConc / renderAaPlan / renderAaFull)

- [ ] **Step 1: WidgetRenderHelper 加 3 个 render 函数 + renderE2Full + renderAaFull**

在 `renderE2Plan` 后追加:

```kotlin
/** 渲染 E2 全卡 widget (5x2 固定). 左侧浓度 + 右侧下次计划. */
fun renderE2Full(ctx: Context, snapshot: JSONObject?): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_e2_full)
    val now = System.currentTimeMillis()
    val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
    val e2 = snapshot?.optJSONObject("e2")

    val value = e2?.opt("currentLevel")?.let { if (it == JSONObject.NULL) null else it as? Double } ?: 0.0
    val drugName = e2?.optString("drugName", "") ?: ""
    val doseMG = e2?.optDouble("doseMG", 0.0) ?: 0.0
    val routeLabel = e2?.optString("routeLabel", "") ?: ""
    val nextDueAtMs = e2?.opt("nextDueAtMs")?.let { if (it == JSONObject.NULL) null else it as? Long }
    val stale = stalenessText(computedAt, now)
    val absTime = if (nextDueAtMs != null) {
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(nextDueAtMs))
    } else "--:--"

    rv.setTextViewText(R.id.valueConc, formatConc(value))
    rv.setTextViewText(R.id.unitConc, "pg/mL")
    rv.setTextViewText(R.id.drugPlan, "$drugName ${doseMG}mg")
    rv.setTextViewText(R.id.routePlan, routeLabel)
    rv.setTextViewText(R.id.timePlan, absTime)
    rv.setTextViewText(R.id.stale, stale)
    return rv
}

/** 渲染抗雄浓度 widget. 同 E2 浓度逻辑, 单位 ng/mL. */
fun renderAaConc(ctx: Context, snapshot: JSONObject?, vertical: Boolean): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_aa_conc)
    val now = System.currentTimeMillis()
    val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
    val aa = snapshot?.optJSONObject("antiandrogen")

    val title = "抗雄 估算"
    val value = aa?.opt("currentLevel")?.let { if (it == JSONObject.NULL) null else it as? Double } ?: 0.0
    val ciLow = aa?.opt("ci95Low")?.let { if (it == JSONObject.NULL) null else it as? Double }
    val ciHigh = aa?.opt("ci95High")?.let { if (it == JSONObject.NULL) null else it as? Double }
    val stale = stalenessText(computedAt, now)

    if (vertical) {
        rv.setViewVisibility(R.id.row3x2, View.GONE)
        rv.setViewVisibility(R.id.col2x3, View.VISIBLE)
        rv.setTextViewText(R.id.title2x3, title)
        rv.setTextViewText(R.id.value2x3, formatConc(value))
        rv.setTextViewText(R.id.unit2x3, "ng/mL")
    } else {
        rv.setViewVisibility(R.id.row3x2, View.VISIBLE)
        rv.setViewVisibility(R.id.col2x3, View.GONE)
        rv.setTextViewText(R.id.title3x2, title)
        rv.setTextViewText(R.id.stale3x2, stale)
        rv.setTextViewText(R.id.value3x2, formatConc(value))
        rv.setTextViewText(R.id.ci3x2,
            if (ciLow != null && ciHigh != null) "95% CI ${"%.1f".format(ciLow)} – ${"%.1f".format(ciHigh)}" else "")
    }
    return rv
}

/** 渲染抗雄计划 widget. 同 E2 计划逻辑. */
fun renderAaPlan(ctx: Context, snapshot: JSONObject?, vertical: Boolean): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_aa_plan)
    val now = System.currentTimeMillis()
    val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
    val aa = snapshot?.optJSONObject("antiandrogen")

    val drugName = aa?.optString("drugName", "") ?: ""
    val doseMG = aa?.optDouble("doseMG", 0.0) ?: 0.0
    val routeLabel = aa?.optString("routeLabel", "") ?: ""
    val nextDueAtMs = aa?.opt("nextDueAtMs")?.let { if (it == JSONObject.NULL) null else it as? Long }
    val stale = stalenessText(computedAt, now)

    val countdown = countdownText(nextDueAtMs, now)
    val absTime = if (nextDueAtMs != null) {
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(nextDueAtMs))
    } else "--:--"

    if (vertical) {
        rv.setViewVisibility(R.id.row3x2, View.GONE)
        rv.setViewVisibility(R.id.col2x3, View.VISIBLE)
        rv.setTextViewText(R.id.title2x3, "下次 抗雄")
        rv.setTextViewText(R.id.countdown2x3, countdown)
        rv.setTextViewText(R.id.drug2x3, drugName)
        rv.setTextViewText(R.id.absTime2x3, absTime)
    } else {
        rv.setViewVisibility(R.id.row3x2, View.VISIBLE)
        rv.setViewVisibility(R.id.col2x3, View.GONE)
        rv.setTextViewText(R.id.title3x2, "下次 抗雄")
        rv.setTextViewText(R.id.route3x2, routeLabel)
        rv.setTextViewText(R.id.countdown3x2, countdown)
        rv.setTextViewText(R.id.absTime3x2, absTime)
        rv.setTextViewText(R.id.drug3x2, "$drugName ${doseMG}mg")
        rv.setTextViewText(R.id.stale3x2, stale)
    }
    return rv
}

/** 渲染抗雄全卡 widget. 同 E2 全卡, 单位 ng/mL. */
fun renderAaFull(ctx: Context, snapshot: JSONObject?): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_aa_full)
    val now = System.currentTimeMillis()
    val computedAt = snapshot?.optLong("computedAtMs") ?: 0L
    val aa = snapshot?.optJSONObject("antiandrogen")

    val value = aa?.opt("currentLevel")?.let { if (it == JSONObject.NULL) null else it as? Double } ?: 0.0
    val drugName = aa?.optString("drugName", "") ?: ""
    val doseMG = aa?.optDouble("doseMG", 0.0) ?: 0.0
    val routeLabel = aa?.optString("routeLabel", "") ?: ""
    val nextDueAtMs = aa?.opt("nextDueAtMs")?.let { if (it == JSONObject.NULL) null else it as? Long }
    val stale = stalenessText(computedAt, now)
    val absTime = if (nextDueAtMs != null) {
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(nextDueAtMs))
    } else "--:--"

    rv.setTextViewText(R.id.valueConc, formatConc(value))
    rv.setTextViewText(R.id.unitConc, "ng/mL")
    rv.setTextViewText(R.id.drugPlan, "$drugName ${doseMG}mg")
    rv.setTextViewText(R.id.routePlan, routeLabel)
    rv.setTextViewText(R.id.timePlan, absTime)
    rv.setTextViewText(R.id.stale, stale)
    return rv
}
```

- [ ] **Step 2: 复制 widget_e2_conc.xml → widget_aa_conc.xml**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
cp src-tauri/scripts/widget/layouts/widget_e2_conc.xml \
   src-tauri/scripts/widget/layouts/widget_aa_conc.xml
```

- [ ] **Step 3: 复制 widget_e2_plan.xml → widget_aa_plan.xml**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
cp src-tauri/scripts/widget/layouts/widget_e2_plan.xml \
   src-tauri/scripts/widget/layouts/widget_aa_plan.xml
```

- [ ] **Step 4: 创建 widget_e2_full.xml**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_full.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="horizontal"
    android:padding="8dp"
    android:weightSum="3">

    <LinearLayout
        android:layout_width="0dp"
        android:layout_height="match_parent"
        android:layout_weight="1.3"
        android:gravity="center_vertical"
        android:orientation="vertical">
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="E2 估算"
            android:textSize="11sp"
            android:textStyle="bold" />
        <LinearLayout
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:baselineAligned="true">
            <TextView
                android:id="@+id/valueConc"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:textColor="#F1405D"
                android:textSize="28sp"
                android:textStyle="bold" />
            <TextView
                android:id="@+id/unitConc"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="4dp"
                android:textSize="11sp" />
        </LinearLayout>
    </LinearLayout>

    <LinearLayout
        android:layout_width="0dp"
        android:layout_height="match_parent"
        android:layout_weight="1.5"
        android:gravity="center_vertical"
        android:orientation="vertical">
        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="下次计划"
            android:textSize="11sp"
            android:textStyle="bold" />
        <TextView
            android:id="@+id/drugPlan"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:textSize="11sp"
            android:textStyle="bold" />
        <TextView
            android:id="@+id/routePlan"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:textSize="10sp" />
        <TextView
            android:id="@+id/timePlan"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:textSize="22sp"
            android:textStyle="bold" />
    </LinearLayout>

    <TextView
        android:id="@+id/stale"
        android:layout_width="0dp"
        android:layout_height="match_parent"
        android:layout_weight="0.2"
        android:gravity="bottom|end"
        android:textSize="8sp" />
</LinearLayout>
```

- [ ] **Step 5: 复制 widget_e2_full.xml → widget_aa_full.xml**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
cp src-tauri/scripts/widget/layouts/widget_e2_full.xml \
   src-tauri/scripts/widget/layouts/widget_aa_full.xml
```

- [ ] **Step 6: 复制 3 个 info XML (conc/plan/full)**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
# AA Conc info: targetCellHeight 改为 2 (3x2 默认), 其它同 E2
sed 's/widget_e2_conc/widget_aa_conc/g' src-tauri/scripts/widget/layouts/widget_e2_conc_info.xml \
  > src-tauri/scripts/widget/layouts/widget_aa_conc_info.xml

sed 's/widget_e2_plan/widget_aa_plan/g' src-tauri/scripts/widget/layouts/widget_e2_plan_info.xml \
  > src-tauri/scripts/widget/layouts/widget_aa_plan_info.xml

# AA Full info: targetCellWidth=5, targetCellHeight=2 (5x2 固定)
sed -e 's/widget_e2_full/widget_aa_full/g' \
    -e 's/android:targetCellWidth="3"/android:targetCellWidth="5"/' \
    src-tauri/scripts/widget/layouts/widget_e2_full_info.xml \
  > src-tauri/scripts/widget/layouts/widget_aa_full_info.xml
```

注: 这里假设 widget_e2_full_info.xml 已在 Phase 4 后续 task 中创建. 实际此处是创建 + 复制 + sed 三件事一起做.

- [ ] **Step 7: 创建 widget_e2_full_info.xml (如还未创建)**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_e2_full_info.xml -->
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="320dp"
    android:minHeight="110dp"
    android:minResizeWidth="320dp"
    android:minResizeHeight="110dp"
    android:targetCellWidth="5"
    android:targetCellHeight="2"
    android:widgetCategory="home_screen"
    android:resizeMode="horizontal"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_e2_full"
    android:description="@string/widget_e2_full_desc"
    android:previewImage="@drawable/widget_preview_e2_full" />
```

- [ ] **Step 8: 创建 3 个抗雄 Provider**

`AaConcWidgetProvider.kt`:
```kotlin
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class AaConcWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            val vertical = WidgetRenderHelper.isVertical(ctx, mgr, id)
            mgr.updateAppWidget(id, WidgetRenderHelper.renderAaConc(ctx, snapshot, vertical))
        }
    }
    override fun onAppWidgetOptionsChanged(
        ctx: Context, mgr: AppWidgetManager, appWidgetId: Int, newOptions: android.os.Bundle,
    ) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        val vertical = WidgetRenderHelper.isVertical(ctx, mgr, appWidgetId)
        mgr.updateAppWidget(appWidgetId, WidgetRenderHelper.renderAaConc(ctx, snapshot, vertical))
    }
}
```

`AaPlanWidgetProvider.kt`:
```kotlin
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class AaPlanWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            val vertical = WidgetRenderHelper.isVertical(ctx, mgr, id)
            mgr.updateAppWidget(id, WidgetRenderHelper.renderAaPlan(ctx, snapshot, vertical))
        }
    }
    override fun onAppWidgetOptionsChanged(
        ctx: Context, mgr: AppWidgetManager, appWidgetId: Int, newOptions: android.os.Bundle,
    ) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        val vertical = WidgetRenderHelper.isVertical(ctx, mgr, appWidgetId)
        mgr.updateAppWidget(appWidgetId, WidgetRenderHelper.renderAaPlan(ctx, snapshot, vertical))
    }
}
```

`AaFullWidgetProvider.kt`:
```kotlin
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class AaFullWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            mgr.updateAppWidget(id, WidgetRenderHelper.renderAaFull(ctx, snapshot))
        }
    }
}
```

- [ ] **Step 9: 创建 E2FullWidgetProvider.kt**

```kotlin
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class E2FullWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            mgr.updateAppWidget(id, WidgetRenderHelper.renderE2Full(ctx, snapshot))
        }
    }
}
```

- [ ] **Step 10: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/AaConcWidgetProvider.kt \
        src-tauri/scripts/widget/AaPlanWidgetProvider.kt \
        src-tauri/scripts/widget/AaFullWidgetProvider.kt \
        src-tauri/scripts/widget/E2FullWidgetProvider.kt \
        src-tauri/scripts/widget/WidgetRenderHelper.kt \
        src-tauri/scripts/widget/layouts/widget_aa_conc.xml \
        src-tauri/scripts/widget/layouts/widget_aa_plan.xml \
        src-tauri/scripts/widget/layouts/widget_aa_full.xml \
        src-tauri/scripts/widget/layouts/widget_e2_full.xml \
        src-tauri/scripts/widget/layouts/widget_aa_conc_info.xml \
        src-tauri/scripts/widget/layouts/widget_aa_plan_info.xml \
        src-tauri/scripts/widget/layouts/widget_aa_full_info.xml \
        src-tauri/scripts/widget/layouts/widget_e2_full_info.xml
git commit -m "feat(widget): 抗雄 3 个 widget + E2 全卡 widget (Provider/layout/info/render)"
```

---

# Phase 6: 日历 widget (最复杂)

## Task 6.1: widget_cal_heatmap.xml + widget_heatmap_cell.xml

**Files:**
- Create: `src-tauri/scripts/widget/layouts/widget_cal_heatmap.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_heatmap_cell.xml`
- Create: `src-tauri/scripts/widget/layouts/widget_cal_heatmap_info.xml`

- [ ] **Step 1: 创建 widget_cal_heatmap.xml**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_cal_heatmap.xml -->
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="6dp">

    <TextView
        android:id="@+id/monthLabel"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:textSize="10sp"
        android:textStyle="bold" />

    <GridLayout
        android:id="@+id/grid"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:columnCount="7"
        android:rowCount="6" />

    <TextView
        android:id="@+id/legend"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:gravity="center"
        android:text="■ E2   ■ CPA   ■ 今日"
        android:textSize="8sp" />
</LinearLayout>
```

- [ ] **Step 2: 创建 widget_heatmap_cell.xml (单元格模板)**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_heatmap_cell.xml -->
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:layout_margin="1dp">

    <TextView
        android:id="@+id/cellDay"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:gravity="center"
        android:textSize="9sp"
        android:textStyle="bold" />
</FrameLayout>
```

注: 单元格背景色由 Kotlin 端 `setInt(R.id.cellDay, "setBackgroundColor", color)` 动态设置.

- [ ] **Step 3: 创建 widget_cal_heatmap_info.xml**

```xml
<!-- src-tauri/scripts/widget/layouts/widget_cal_heatmap_info.xml -->
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="180dp"
    android:minResizeWidth="250dp"
    android:minResizeHeight="180dp"
    android:targetCellWidth="4"
    android:targetCellHeight="3"
    android:widgetCategory="home_screen"
    android:resizeMode="horizontal"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_cal_heatmap"
    android:description="@string/widget_cal_heatmap_desc"
    android:previewImage="@drawable/widget_preview_cal_heatmap" />
```

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/layouts/widget_cal_heatmap.xml \
        src-tauri/scripts/widget/layouts/widget_heatmap_cell.xml \
        src-tauri/scripts/widget/layouts/widget_cal_heatmap_info.xml
git commit -m "feat(widget): 日历 widget layout + 单元格模板 + info XML"
```

---

## Task 6.2: WidgetRenderHelper 加 renderCalendarHeatmap

**Files:**
- Modify: `src-tauri/scripts/widget/WidgetRenderHelper.kt`

- [ ] **Step 1: 在 WidgetRenderHelper 末尾追加 renderCalendarHeatmap**

```kotlin
/** 渲染日历热力图 widget (4x3 固定, 42 格). */
fun renderCalendarHeatmap(ctx: Context, snapshot: JSONObject?): RemoteViews {
    val rv = RemoteViews(ctx.packageName, R.layout.widget_cal_heatmap)

    val cells = snapshot?.optJSONArray("calendarHeatmap") ?: return rv
    if (cells.length() == 0) {
        rv.setTextViewText(R.id.monthLabel, "暂无数据")
        return rv
    }

    // 取第一格所在月份作为月份标签
    val firstDateMs = cells.getJSONObject(0).optLong("dateMs")
    val monthLabel = if (firstDateMs > 0) {
        val fmt = java.text.SimpleDateFormat("yyyy 年 M 月", java.util.Locale.CHINA)
        fmt.format(java.util.Date(firstDateMs))
    } else ""
    rv.setTextViewText(R.id.monthLabel, monthLabel)

    // 42 格 RemoteViews 子 view
    val cellRvs = arrayOfNulls<RemoteViews>(42)
    for (i in 0 until 42) {
        if (i >= cells.length()) break
        val cell = cells.getJSONObject(i)
        val cellRv = RemoteViews(ctx.packageName, R.layout.widget_heatmap_cell)
        val day = java.util.Calendar.getInstance().apply { timeInMillis = cell.optLong("dateMs") }
            .get(java.util.Calendar.DAY_OF_MONTH)
        cellRv.setTextViewText(R.id.cellDay, day.toString())

        val color = when {
            cell.optBoolean("isToday") -> 0xFFCB64FF.toInt()  // 紫色 (App 内 MedicationHeatmap 用色)
            cell.optBoolean("hasE2") && cell.optBoolean("hasAa") -> 0xFF8B5CF6.toInt()  // E2+CPA 紫罗兰
            cell.optBoolean("hasE2") -> 0xFFF1405D.toInt()  // E2 粉红
            cell.optBoolean("hasAa") -> 0xFF00B0F0.toInt()  // AA 蓝色
            cell.optBoolean("hasPlan") -> 0xFF02CB90.toInt()  // 计划 绿
            cell.optBoolean("hasPostpone") -> 0xFFFBBF24.toInt()  // 推迟 橙
            else -> 0xFFE5E7EB.toInt()  // empty 浅灰
        }
        cellRv.setInt(R.id.cellDay, "setBackgroundColor", color)

        // 今天用白字, 其它深字
        val textColor = if (cell.optBoolean("isToday")) 0xFFFFFFFF.toInt() else 0xFF1F2937.toInt()
        cellRv.setTextColor(R.id.cellDay, textColor)

        cellRvs[i] = cellRv
    }
    // 把 42 格塞进 GridLayout (按 index 一一对应)
    for (i in 0 until 42) {
        val cellRv = cellRvs[i] ?: continue
        rv.addView(R.id.grid, cellRv)
    }
    return rv
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/WidgetRenderHelper.kt
git commit -m "feat(widget): renderCalendarHeatmap 42 格动态 inflate"
```

---

## Task 6.3: CalendarHeatmapWidgetProvider.kt

**Files:**
- Create: `src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt`

- [ ] **Step 1: 创建 CalendarHeatmapWidgetProvider.kt**

```kotlin
// src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt
package com.smirnovayama.hrttracker.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import org.json.JSONObject

class CalendarHeatmapWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        val snapshot = WidgetSnapshotStore.read(ctx)?.let { JSONObject(it) }
        appWidgetIds.forEach { id ->
            mgr.updateAppWidget(id, WidgetRenderHelper.renderCalendarHeatmap(ctx, snapshot))
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt
git commit -m "feat(widget): CalendarHeatmapWidgetProvider.kt 42 格渲染入口"
```

---

# Phase 7: JS 端写入触发 (App 在前台时算 + 写 snapshot)

## Task 7.1: writeWidgetSnapshot Tauri command (转发到 Kotlin)

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 writeWidgetSnapshot command**

在 `compute_widget_snapshot` 后追加:

```rust
#[tauri::command]
pub fn write_widget_snapshot(
    snapshot: snapshot::WidgetSnapshot,
    env: ...,
    activity: ...,
) -> Result<(), String> {
    // JNI 调 Kotlin: WidgetSnapshotStore.write(context, json)
    let cls = load_notification_class(env, activity)?;
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    env.call_static_method(
        cls,
        "writeWidgetSnapshot",
        "(Landroid/content/Context;Ljava/lang/String;)V",
        &[JValue::Object(activity), JValue::Object(env.new_string(json)?)],
    )?;
    Ok(())
}
```

并在 `generate_handler!` 宏内加 `.write_widget_snapshot,`.

- [ ] **Step 2: 在 WidgetSnapshotStore.kt 加 @JvmStatic writeWidgetSnapshot**

```kotlin
// WidgetSnapshotStore.kt 末尾追加:
@JvmStatic
fun writeWidgetSnapshot(ctx: Context, snapshotJson: String) {
    write(ctx, snapshotJson)
}
```

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/src/lib.rs src-tauri/scripts/widget/WidgetSnapshotStore.kt
git commit -m "feat(widget): write_widget_snapshot Tauri command + Kotlin JNI bridge"
```

---

## Task 7.2: useWidgetSnapshot hook (App 在前台时触发)

**Files:**
- Create: `src/state/useWidgetSnapshot.ts`

- [ ] **Step 1: 创建 useWidgetSnapshot hook**

```typescript
// src/state/useWidgetSnapshot.ts
import { useEffect, useRef } from 'react';
import { invoke } from '../utils/invoke';
import { useAppData } from '../contexts/AppDataContext';

/** App 在前台时, 监听 events/plans/postponeLog/dueLog 变化,
 *  调 compute_widget_snapshot 把结果 write 到 SharedPreferences.
 *  触发点:
 *    1) mount 时立即跑一次 (冷启动)
 *    2) 任一上游数据变化 (debounce 1s)
 *    3) visibilitychange 切回前台 */
export function useWidgetSnapshot() {
    const { events, plans, postponeLog, dueLog } = useAppData();
    const lastWrittenRef = useRef<number>(0);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const write = async () => {
            const now = Date.now();
            // 防止 5 秒内重复写
            if (now - lastWrittenRef.current < 5_000) return;
            try {
                const snapshot = await invoke<unknown>('compute_widget_snapshot', {
                    events,
                    plans,
                    postponeLog,
                    dueLog,
                    nowMs: now,
                });
                await invoke('write_widget_snapshot', { snapshot });
                lastWrittenRef.current = now;
            } catch (e) {
                console.warn('useWidgetSnapshot write failed:', e);
            }
        };

        // debounce 1s 后写 (等数据稳定)
        timer = setTimeout(write, 1_000);

        const onVisible = () => {
            if (document.visibilityState === 'visible') write();
        };
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            if (timer) clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [events, plans, postponeLog, dueLog]);
}
```

- [ ] **Step 2: 在 AppDataContext 调用 hook**

修改 `src/contexts/AppDataContext.tsx`, 在 provider 内部加:

```typescript
import { useWidgetSnapshot } from '../state/useWidgetSnapshot';

// 在 AppDataProvider 函数组件内部:
useWidgetSnapshot();
```

- [ ] **Step 3: 编译验证**

Run: `cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | head -20`
Expected: 无 error (可能 pre-existing warning)

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src/state/useWidgetSnapshot.ts src/contexts/AppDataContext.tsx
git commit -m "feat(widget): useWidgetSnapshot hook + AppDataContext 集成 (3 触发点)"
```

---

# Phase 8: CI 自动 patch AndroidManifest

## Task 7.1: AndroidManifest.widget.snippet.xml

**Files:**
- Create: `src-tauri/scripts/AndroidManifest.widget.snippet.xml`

- [ ] **Step 1: 创建 manifest snippet**

```xml
<!-- src-tauri/scripts/AndroidManifest.widget.snippet.xml -->
<!-- 7 个 AppWidgetProvider 的 receiver + meta-data 块.
     CI workflow 在 </application> 前注入到 AndroidManifest.xml. -->
<manifest>
    <application>
        <receiver android:name=".widget.E2ConcWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_e2_conc_info" />
        </receiver>

        <receiver android:name=".widget.E2PlanWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_e2_plan_info" />
        </receiver>

        <receiver android:name=".widget.E2FullWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_e2_full_info" />
        </receiver>

        <receiver android:name=".widget.AaConcWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_aa_conc_info" />
        </receiver>

        <receiver android:name=".widget.AaPlanWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_aa_plan_info" />
        </receiver>

        <receiver android:name=".widget.AaFullWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_aa_full_info" />
        </receiver>

        <receiver android:name=".widget.CalendarHeatmapWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                       android:resource="@xml/widget_cal_heatmap_info" />
        </receiver>
    </application>
</manifest>
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/AndroidManifest.widget.snippet.xml
git commit -m "feat(widget): AndroidManifest.widget.snippet.xml 7 个 receiver 注入锚点"
```

---

## Task 7.2: workflow 加 3 个 patch step

**Files:**
- Modify: `.github/workflows/android-release.yml`

- [ ] **Step 1: 在 "Patch AndroidManifest.xml" step 之后追加 3 个新 step**

```yaml
      - name: Inject widget providers into AndroidManifest.xml
        run: |
          set -e
          MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
          python3 - <<'PY'
          import pathlib
          p = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
          s = p.read_text()
          if "E2ConcWidgetProvider" in s:
              print("widget providers already injected — no-op")
          else:
              widget_xml = pathlib.Path("src-tauri/scripts/AndroidManifest.widget.snippet.xml").read_text()
              injection = widget_xml.split("<application>")[1].split("</application>")[0]
              s = s.replace("</application>", injection + "\n    </application>", 1)
              p.write_text(s)
              print("injected 7 widget providers + meta-data")
          PY
          echo "--- patched manifest ---"
          cat "$MANIFEST"

      - name: Copy widget Kotlin sources into Android project
        run: |
          set -e
          KOTLIN_DIR="src-tauri/gen/android/app/src/main/java/com/smirnovayama/hrttracker/widget"
          mkdir -p "$KOTLIN_DIR"
          cp -r src-tauri/scripts/widget/*.kt "$KOTLIN_DIR/"
          ls "$KOTLIN_DIR/"

      - name: Copy widget XML resources
        run: |
          set -e
          RES_DIR="src-tauri/gen/android/app/src/main/res"
          mkdir -p "$RES_DIR/layout" "$RES_DIR/xml" "$RES_DIR/drawable"
          cp src-tauri/scripts/widget/layouts/*.xml "$RES_DIR/layout/" 2>/dev/null || true
          # info XML 放在 res/xml/ 下, 不是 layout/
          for f in src-tauri/scripts/widget/layouts/widget_*_info.xml; do
            [ -f "$f" ] && cp "$f" "$RES_DIR/xml/"
          done
          ls "$RES_DIR/layout/" "$RES_DIR/xml/"
```

- [ ] **Step 2: 在 ProGuard keep 规则 step 末尾追加 widget keep**

修改 "Inject ProGuard keep rule for DownloadWriter (R8 strip fix)" step 的 heredoc 末尾加:

```proguard
          # Keep widget providers accessible from WorkManager / AppWidgetManager.
          -keep class com.smirnovayama.hrttracker.widget.* { *; }
          -keep class com.smirnovayama.hrttracker.widget.**$* { *; }
```

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add .github/workflows/android-release.yml
git commit -m "ci(android): workflow 加 widget providers 注入 + Kotlin/res 复制 + ProGuard keep"
```

---

## Task 7.3: 字符串资源 + drawable 预览图占位

**Files:**
- Create: `src-tauri/scripts/widget/strings.xml`
- Create: `src-tauri/scripts/widget/preview/widget_preview_e2_conc.xml` (etc × 7)

- [ ] **Step 1: 创建 strings.xml**

```xml
<!-- src-tauri/scripts/widget/strings.xml -->
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="widget_e2_conc_desc">E2 估算浓度</string>
    <string name="widget_e2_plan_desc">下次 E2 计划</string>
    <string name="widget_e2_full_desc">E2 浓度 + 下次计划</string>
    <string name="widget_aa_conc_desc">抗雄估算浓度</string>
    <string name="widget_aa_plan_desc">下次抗雄计划</string>
    <string name="widget_aa_full_desc">抗雄浓度 + 下次计划</string>
    <string name="widget_cal_heatmap_desc">当月用药日历</string>
</resources>
```

- [ ] **Step 2: 创建 7 个 preview XML 占位 (drawable)**

每个 preview 用 shape drawable 简化（实际生产环境应替换为真实 PNG 截图）:

```bash
mkdir -p src-tauri/scripts/widget/preview

# 创建 7 个占位 XML, 内容相同 — 都是浅色矩形 + 文字占位
for w in e2_conc e2_plan e2_full aa_conc aa_plan aa_full cal_heatmap; do
cat > "src-tauri/scripts/widget/preview/widget_preview_${w}.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
       android:shape="rectangle">
    <solid android:color="#FFE5E7EB" />
    <corners android:radius="8dp" />
</shape>
EOF
done

ls src-tauri/scripts/widget/preview/
```

- [ ] **Step 3: 修改 workflow, 复制 strings + preview drawable 到 res**

在 "Copy widget XML resources" step 内追加:

```yaml
          cp src-tauri/scripts/widget/strings.xml "$RES_DIR/values/" 2>/dev/null || true
          mkdir -p "$RES_DIR/drawable"
          cp src-tauri/scripts/widget/preview/*.xml "$RES_DIR/drawable/" 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add src-tauri/scripts/widget/strings.xml \
        src-tauri/scripts/widget/preview/
git commit -m "feat(widget): 7 个 widget 的 description 字符串 + preview drawable 占位"
```

---

# Phase 9: 验证 + checklist 文档

## Task 9.1: 真机验证 checklist 文档

**Files:**
- Create: `docs/superpowers/specs/2026-07-20-android-widget-verify.md`

- [ ] **Step 1: 写验证 checklist**

```markdown
# Android 桌面小组件 真机验证 checklist (2026-07-20)

## 准备工作

- [ ] 已编译并安装最新 APK (CI 跑通, 包含 widget 功能)
- [ ] 设备: Android 12+ 真机 (避免模拟器 OEM 兼容性差异)
- [ ] 已加 HRT 助手到电池优化白名单 + 国产 ROM 自启动白名单
- [ ] App 内至少录入 1 条 E2 / 1 条抗雄用药 + 1 个 E2 / 1 个抗雄计划

## 7 个 widget 都能装上桌面

- [ ] 长按桌面空白 → "小组件" → 找到 "HRT 助手" 类别
- [ ] 类别下能看到 7 个 widget:
  - E2 估算浓度 (3x2 / 2x3)
  - E2 下次计划 (3x2 / 2x3)
  - E2 浓度 + 计划 (5x2)
  - 抗雄估算浓度 (3x2 / 2x3)
  - 抗雄下次计划 (3x2 / 2x3)
  - 抗雄浓度 + 计划 (5x2)
  - 当月用药日历 (4x3)
- [ ] 拖到桌面后立即显示数据 (App 已在前台运行过, snapshot 已写入)

## 单 widget 3x2 / 2x3 切尺寸

- [ ] 装一个 E2 浓度 3x2, 长按 widget 边框拉成 2x3
- [ ] 切换瞬间 widget 内容刷新:
  - 3x2 显示: 标题 + 浓度数值 + 95% CI + staleness
  - 2x3 显示: 标题 + 浓度数值 + pg/mL (丢 CI + staleness)
- [ ] 再拉回 3x2 验证切回正常

## WorkManager 30 分钟自动刷新

- [ ] 装 widget 后记录 staleness 文案 (如"刚刚更新")
- [ ] 等 30 分钟, 看 widget 文案是否变为"X 分钟前更新"
- [ ] Logcat 查 WorkManager 日志:
  ```
  adb logcat | grep -i "WidgetRefreshWorker"
  ```
  期望: 看到 "Worker result: success"

## 杀 App 后 widget 仍显示

- [ ] 装 widget 后, 在最近任务列表里划掉 App
- [ ] 等 30 分钟, widget 文案从"刚刚更新"变"30 分钟前更新"
- [ ] 等 1 小时, 文案变"1 小时前更新"

## 点 widget 跳 App

- [ ] 装 E2 全卡 (5x2) widget, 点击 widget 中部
- [ ] 期望: App 启动并跳转到 /overview 页
- [ ] (日历 widget 也跳 /overview)

## 重启手机后 widget 正常

- [ ] 装 widget 后, 重启手机
- [ ] 锁屏 → 解锁, widget 仍在桌面
- [ ] 30 分钟内 widget 应被 WorkManager 自动刷新

## 日历 widget 显示

- [ ] 装日历 widget (4x3)
- [ ] 看到 42 格 (6 行 × 7 列)
- [ ] 今天格子为紫色, 内有白色日期数字
- [ ] 有 E2 用药的日子为粉色
- [ ] 有抗雄用药的日子为蓝色
- [ ] 同时有 E2 + 抗雄的格子为紫罗兰色
- [ ] 没有用药的日子为浅灰色

## OEM 后台杀 (进阶验证)

- [ ] 小米/华为/OPPO 设备: 检查 `WhitelistBanner` 是否在 App 主页顶部显示
- [ ] 如果显示, 按引导加白名单
- [ ] 加完白名单后, 30 分钟内 widget 应该自动刷新 (staleness 变小)
```

- [ ] **Step 2: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker"
git add docs/superpowers/specs/2026-07-20-android-widget-verify.md
git commit -m "docs(widget): 真机验证 checklist 文档"
```

---

# 验收总结

完成所有 Phase 后:

- [ ] **Phase 1 完成** — 数据契约类型 + staleness/countdown 工具 + 11 项单测全过
- [ ] **Phase 2 完成** — Rust 端 compute_widget_snapshot command 注册成功
- [ ] **Phase 3 完成** — Kotlin WidgetSnapshotStore + Refresher + Worker + Scheduler + BootReceiver 扩展
- [ ] **Phase 4 完成** — E2ConcWidgetProvider + 第一个 widget XML 跑通
- [ ] **Phase 5 完成** — 抗雄 3 个 widget + E2 全卡 widget (5 个 Provider + 5 个 layout + 5 个 info + 5 个 render 函数)
- [ ] **Phase 6 完成** — 日历 widget 42 格动态 inflate
- [ ] **Phase 7 完成** — JS 端 useWidgetSnapshot hook + writeWidgetSnapshot Tauri command 集成
- [ ] **Phase 8 完成** — AndroidManifest CI 自动 patch + Kotlin/res 复制 + ProGuard keep + 字符串/drawable 资源
- [ ] **Phase 9 完成** — 真机验证 checklist 文档

**总工作量**: ~2500 行新代码 (含 XML/Kotlin/Rust/TS), 73 个 bite-sized step, 分 23 个 commit, 9 个 Phase, 预计 2-3 周.