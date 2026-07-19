# Android 桌面小组件 设计稿 (2026-07-20)

## Context（为什么做）

### 用户场景
- 当前 App 是 Tauri v2 + Android WebView 形态，所有浓度/计划信息都必须**打开 App 进 /overview 页**才能看到。
- 用户的使用习惯：HRT 用药节奏稳定（每天 1-3 次），但偶尔在路上 / 公司 / 睡前想快速看"下次啥时候吃药 / 现在浓度大概多少 / 这个月服从率怎么样"，**不值得打开 App**。
- 桌面小组件（AppWidget）正是为这种"瞥一眼"场景设计——锁屏后第一次解锁就能看到关键信息。

### 为什么不做"实时浓度 widget"
- **算法 2958 行 TS**（pk.ts 1240 + calibration.ts 246 + personalModel.ts 751 + mipd.ts 721）跑在 React 端，**不能移植到 Kotlin**（工作量 3 个月+，双份维护不可接受）。
- 浓度每分钟衰减：widget 上写"现在 E2 是 145 pg/mL"如果不每分钟重算就是**不诚实的数字**。
- **诚实的方案**：App 端（Rust 端）把"当前浓度 + 下次倒计时"算好缓存到 SharedPreferences；widget 端只读缓存 + 算 staleness 显示"5 分钟前更新"。
- 这是用户已确认的选择（brainstorm 阶段回答）。

### 7 个 widget 的取舍
用户的桌面空间 vs 信息密度的 tradeoff：
- **3x2 横版 / 2x3 竖版 浓度单侧**：桌面紧 / 想看实时浓度近似值（横版含 CI，竖版只显示核心数值）
- **3x2 横版 / 2x3 竖版 计划单侧**：桌面紧 / 只关心下次什么时候吃药（横版含全部字段，竖版丢次要）
- **5x2 精简全卡**：桌面空间大 / 想看浓度 + 下次计划（去掉所有次要信息）
- **4x3 日历**：当月服从率趋势

---

## 范围

### 改
- `src-tauri/src/lib.rs` — 新增 `compute_widget_snapshot` Tauri command
- `src-tauri/src/snapshot.rs` — 新建，snapshot 算 + 序列化（复用 pk.ts 算法 via Node.js 子进程 OR 直接在 Rust 重写关键插值）
- `src/state/AppDataContext.tsx` — 新增 `useWidgetSnapshot()` hook，写入时机管理
- `src/main.tsx`（或合适入口）— 注册 snapshot 写入触发点（启动 + visibilitychange + events/plans 变更）
- `.github/workflows/android-release.yml` — 自动 patch AndroidManifest.xml 加 7 个 AppWidgetProvider + WorkManager 权限
- `src-tauri/scripts/NotificationScheduler.kt` — 新增 `WidgetRefreshWorker` 类（WorkManager Worker）

### 新增
- `src-tauri/scripts/WidgetSnapshot.kt` — Kotlin 数据类（@JvmField 字段对齐 snapshot JSON schema）
- `src-tauri/scripts/widget/E2ConcWidgetProvider.kt`（3x2+2x3 浓度）
- `src-tauri/scripts/widget/E2PlanWidgetProvider.kt`（3x2+2x3 计划）
- `src-tauri/scripts/widget/E2FullWidgetProvider.kt`（5x2 精简全卡）
- `src-tauri/scripts/widget/AaConcWidgetProvider.kt`（3x2+2x3 浓度）
- `src-tauri/scripts/widget/AaPlanWidgetProvider.kt`（3x2+2x3 计划）
- `src-tauri/scripts/widget/AaFullWidgetProvider.kt`（5x2 精简全卡）
- `src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt`（4x3 月历热力图）
- `src-tauri/scripts/widget/WidgetRenderHelper.kt` — 共享渲染逻辑（读 snapshot + 算 staleness + RemoteViews 装配）
- `src-tauri/scripts/widget/WidgetRefreshWorker.kt` — WorkManager Worker，每 30 分钟触发
- `src-tauri/scripts/widget/BootReceiver.kt`（已在 scripts/ 下）— 扩展：BOOT_COMPLETED 后重排 WorkManager
- `src-tauri/scripts/widget/layouts/widget_*.xml` × 7 — RemoteViews 布局
- `src-tauri/scripts/widget/layouts/widget_*_info.xml` × 7 — widget 元数据（min/max width/height、previewImage、resizeMode）
- `src-tauri/scripts/widget/layouts/widget_cell_*.xml` × 3 — 共享日历单元格 + 浓度单元格 drawable
- `src-tauri/scripts/AndroidManifest.widget.snippet.xml` — 7 个 receiver + 必要权限的 XML 片段（给 CI patch 锚点）
- `src/utils/widgetSnapshot.ts` — TypeScript 类型 + JSON schema + Rust 端序列化函数
- `src/components/__tests__/widgetSnapshot.test.ts` — vitest 单测（snapshot 算 + staleness 计算）

### 不改
- `OverviewView.tsx`（4 卡片不动）— widget 是独立功能，不复用 OverviewView 的渲染逻辑
- `MedicationHeatmap.tsx`（App 内热力图）— widget 用简化版色块规则，不是它的 view 层
- 现有的 `ReminerReceiver.kt` / `NotificationScheduler.kt` / `BootReceiver.kt`（通知 + 重启恢复 alarm 链路不动）

---

## 1. Widget 矩阵

**三类语义不同的 widget**：
- **浓度单侧**（E2 + 抗雄各一个）：只看"现在浓度多少"
- **计划单侧**（E2 + 抗雄各一个）：只看"下次啥时候吃"
- **精简全卡**（E2 + 抗雄各一个）：**同时显示浓度和计划**，一个 widget 装两件事（用户原话："5x2 横长条本来就是用来同时放入浓度和计划的"）

| Widget ID 后缀 | 显示 | 尺寸 | 显示字段 | 缓存来源 |
|---|---|---|---|---|
| `e2_conc_3x2` / `e2_conc_2x3` | E2 当前浓度单侧 | 3x2 或 2x3 cells（用户装时选） | 3x2: 浓度+CI+staleness; 2x3: 浓度+单位（丢 CI、staleness） | snapshot.e2 |
| `e2_plan_3x2` / `e2_plan_2x3` | E2 下次计划单侧 | 3x2 或 2x3 cells（用户装时选） | 3x2: 药名+剂量+途径+倒计时+绝对时间+staleness; 2x3: 药名+倒计时+绝对时间（丢剂量、staleness） | snapshot.e2 |
| `e2_full_5x2` | E2 精简全卡（浓度+计划同卡） | 5x2 cells only | 左侧: 浓度数值 + 单位；右侧: 药名 + 剂量 + 途径 + 下次时间(时分) + staleness | snapshot.e2 |
| `aa_conc_3x2` / `aa_conc_2x3` | 抗雄当前浓度单侧 | 3x2 或 2x3 cells（用户装时选） | 3x2: 浓度+CI+staleness; 2x3: 浓度+单位（丢 CI、staleness） | snapshot.aa |
| `aa_plan_3x2` / `aa_plan_2x3` | 抗雄下次计划单侧 | 3x2 或 2x3 cells（用户装时选） | 3x2: 药名+剂量+途径+倒计时+绝对时间+staleness; 2x3: 药名+倒计时+绝对时间（丢剂量、staleness） | snapshot.aa |
| `aa_full_5x2` | 抗雄精简全卡（浓度+计划同卡） | 5x2 cells only | 左侧: 浓度数值 + 单位；右侧: 药名 + 剂量 + 途径 + 下次时间(时分) + staleness | snapshot.aa |
| `cal_heatmap_4x3` | 月历热力图 | 4x3 cells | 最近 6 周 × 7 天 = 42 格色块，今天高亮 | snapshot.calendarHeatmap |

**精简全卡（5x2）去掉**（用户原话："可以只保留关键数据，当前浓度值、下次计划 肌注 药物 剂量 时间"）：
- 上次服用时间
- 群体 PK 范围（68% CI、95% CI 都不显示）
- baseline / endogenous / personal model 标识
- status badge（high / luteal / follicular 等）
- adherence（个人模型命中率）
- 原始药物浓度（Base / Raw）

**保留**：当前浓度值 + 单位 + 95% CI（不！连 95% CI 也去掉，保持桌面"瞥一眼"极简——下面渲染布局也按这个新口径调整）

---

## 2. 数据契约（widget_snapshot JSON schema）

写到 SharedPreferences `hrt_widget_snapshot` slot 的 JSON：

```json
{
  "schemaVersion": 1,
  "computedAtMs": 1721342400000,
  "events": [...],   // 完整 DoseEvent[] JSON，widget 重算 staleness 时不用
  "plans": [...],    // 完整 Plan[] JSON
  "postponeLog": [...],  // 推迟日志（heat map 需要）
  "dueLog": [...],       // 计划达成日志（heat map 需要）
  "e2": {
    "primaryPlan": {
      "ester": "EV",
      "drugName": "Estradiol Valerate",
      "doseMG": 4.0,
      "route": "sublingual"
    },
    "currentLevelPGmL": 145.7,
    "ci95Low": 130.0,
    "ci95High": 162.0,
    "hasPersonalModel": true,
    "nextDueAtMs": 1721353200000,
    "lastDoseAtMs": 1721304000000
  },
  "antiandrogen": {
    "primaryPlan": {
      "ester": "CPA",
      "drugName": "Cyproterone Acetate",
      "doseMG": 50.0,
      "route": "oral"
    },
    "currentLevelNgML": 28.3,
    "ci95Low": 22.0,
    "ci95High": 35.0,
    "hasPersonalModel": false,
    "nextDueAtMs": 1721355000000,
    "lastDoseAtMs": 1721304000000
  },
  "calendarHeatmap": [
    // 42 个 cell，按"周一开始"顺序
    {"dateMs": 1721174400000, "color": "empty", "today": false},
    {"dateMs": 1721260800000, "color": "E2", "today": false},
    {"dateMs": 1721347200000, "color": "CPA", "today": true},
    ...
  ]
}
```

**`calendarHeatmap[].color` 取值**：
- `"empty"` — 当天无用药无计划
- `"E2"` — 当天有 E2 用药
- `"CPA"` — 当天有 CPA 用药
- `"E2+CPA"` — 当天有 E2 + CPA 两种
- `"planOnly"` — 当天只有计划无实际用药（未来 7 天内）
- `"postpone"` — 当天有推迟记录
- 今天固定为 `"today"` 高亮（紫色 #cb64ff 背景 + 白字日期）

---

## 3. Tauri Rust 新 command

### 3.1 新增命令

```rust
// src-tauri/src/lib.rs
#[tauri::command]
pub fn compute_widget_snapshot(
    events: Vec<DoseEvent>,
    plans: Vec<Plan>,
    postpone_log: Vec<PostponeLogEntry>,
    due_log: Vec<DueLogEntry>,
    now_ms: i64,
) -> Result<WidgetSnapshot, String> {
    snapshot::compute(events, plans, &postpone_log, &due_log, now_ms)
}
```

### 3.2 实现要点

`src-tauri/src/snapshot.rs`（新建，~400 行）：
- 调用 `pk::runSimulation()` + `interpolateConcentration_E2()` + `interpolateCompoundConcentration()`
- 调用 `personalModel::computeSimulationWithCI()`（如果 hasPersonalModel）
- 调用 `planSchedule::nextDueAfter()` 算 E2/抗雄下次用药时间
- 调用 `heatmapData` 同款逻辑生成 42 格色块（Kotlin 端可能用简化版，但 Rust 端必须复用 TS 算法保证一致性）

**复用 TS 算法的选择**：
- **方案 A（推荐）**：Rust 端**直接复用** pk.ts 的核心函数（用 `ts-rs` 或 `napi-rs` 把 pk.ts 编译为 NAPI 模块，Rust 通过 Node 子进程调用）
- **方案 B**：在 Rust 端重写 pk.ts 的 1240 行 PK 计算（工作量 2-3 周，纯 Rust 性能好）
- **方案 C**：把 pk.ts 算法打包为 JS bundle，Rust 通过 `tauri::api::shell` 调 Node.js 跑（每次 snapshot 计算起一个 Node 子进程，慢但实现快）

**MVP 选 C**：先用 Node 子进程方案跑通 widget 流水线，性能不是问题（30 分钟一次）。后续如性能不够再优化为方案 B。

### 3.3 性能预期
- Node 子进程冷启动 ~300ms
- 计算 42 格热力图 + 2 个浓度插值 ~200ms
- 合计 widget snapshot 计算 < 1s（用户感知不到）

---

## 4. JS 端写入时机

`src/state/AppDataContext.tsx` 新增：

```typescript
// 何时调 compute_widget_snapshot 并写入 SharedPreferences
useEffect(() => {
  const writeSnapshot = async () => {
    const snapshot = await invoke<WidgetSnapshot>('compute_widget_snapshot', {
      events: eventsRef.current,
      plans: plansRef.current,
      postponeLog: postponeLogRef.current,
      dueLog: dueLogRef.current,
      nowMs: Date.now(),
    });
    // 写到 SharedPreferences — 通过新 Tauri command 转发给 Kotlin
    await invoke('write_widget_snapshot', { snapshot });
  };

  // 触发点：
  // 1) App 启动后（cold start）— useEffect 首跑
  // 2) visibilitychange 切回前台
  // 3) events / plans / postponeLog / dueLog 任一变更（debounce 1s）
  // 4) App 端每 5 分钟兜底（防止上面漏触发）
}, [...]);
```

**写入兜底**：App 端每 5 分钟兜底重算 + 写 snapshot（用 setInterval，App 切到后台时 setInterval 被浏览器节流到 1 分钟一次，足够）。

**新 Tauri command `write_widget_snapshot`**：
```rust
#[tauri::command]
pub fn write_widget_snapshot(
    snapshot: WidgetSnapshot,
    env: ...,
    activity: ...,
) -> Result<(), String> {
    // JNI 调用 Kotlin: WidgetSnapshotStore.write(context, json)
    let cls = load_notification_class(env, activity)?;
    let json = serde_json::to_string(&snapshot).map_err(|e| e.to_string())?;
    env.call_static_method(
        cls, "writeWidgetSnapshot",
        "(Landroid/content/Context;Ljava/lang/String;)V",
        &[JValue::Object(activity), JValue::Object(env.new_string(json)?)],
    )?;
    Ok(())
}
```

**Kotlin 端**：
```kotlin
// src-tauri/scripts/WidgetSnapshotStore.kt
@JvmStatic
fun writeWidgetSnapshot(ctx: Context, json: String) {
    ctx.getSharedPreferences("hrt_widget_snapshot", Context.MODE_PRIVATE)
        .edit()
        .putString("snapshot_v1", json)
        .putLong("computed_at_ms", System.currentTimeMillis())
        .apply()
    // 同时立即触发所有 7 个 widget 重绘（不等 WorkManager 30 分钟）
    WidgetRefresher.refreshAll(ctx)
}
```

---

## 5. 7 个 AppWidgetProvider 骨架

每个 Provider 都是独立 `AppWidgetProvider` 子类，结构统一（~80 行）：

```kotlin
// src-tauri/scripts/widget/E2ConcWidgetProvider.kt
class E2ConcWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        ctx: Context,
        mgr: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        appWidgetIds.forEach { id ->
            val snapshot = WidgetSnapshotStore.read(ctx)
            val rv = WidgetRenderHelper.renderE2Conc(ctx, snapshot)
            mgr.updateAppWidget(id, rv)
        }
    }
}
```

**共享逻辑** `WidgetRenderHelper.kt`（~500 行）：
- `renderE2Conc(ctx, snapshot, vertical)` — 装配 E2 浓度 3x2 + 2x3 RemoteViews（按 vertical 切布局）
- `renderE2Plan(ctx, snapshot, now, vertical)` — 装配 E2 计划 3x2 + 2x3 RemoteViews（算倒计时）
- `renderE2Full(ctx, snapshot, now)` — 装配 E2 全卡 5x2 RemoteViews
- `renderAaConc / renderAaPlan / renderAaFull` — 抗雄三件套
- `renderCalendarHeatmap(ctx, snapshot, now)` — 装配 42 格月历色块
- `computeStalenessText(snapshot, now)` — "5 分钟前更新" / "2 小时前更新"
- `computeCountdownText(nextDueMs, now)` — "2h 35m" / "已过期 15m"

---

## 6. 7 个 widget XML 布局

每个 widget 一个布局 XML，结构示例：

### 6.1 widget_e2_conc.xml（单文件，3x2 + 2x3 双布局）

E2 浓度 widget 用**单 layout XML**，内部包含 3x2 横版 + 2x3 竖版两套子 layout，由 Kotlin `onAppWidgetOptionsChanged` 根据实际 size 切 visibility。

```xml
<LinearLayout orientation="vertical" padding="8dp">
  <!-- ── 3x2 横版布局（vertical=false 时显示）───────────── -->
  <LinearLayout id="row3x2" orientation="vertical">
    <LinearLayout orientation="horizontal" weightSum="2">
      <TextView id="title3x2" text="E2 估算" textSize="11sp" weight="1" />
      <TextView id="stale3x2" textSize="9sp" gravity="end" weight="1" />
    </LinearLayout>
    <LinearLayout orientation="horizontal" baselineAligned="true">
      <TextView id="value3x2" textSize="26sp" textColor="@color/e2_pink" weight="1" />
      <TextView id="ci3x2" textSize="10sp" gravity="bottom" weight="1" />
    </LinearLayout>
  </LinearLayout>

  <!-- ── 2x3 竖版布局（vertical=true 时显示,丢 CI / staleness）─── -->
  <LinearLayout id="col2x3" orientation="vertical" gravity="center">
    <TextView id="title2x3" text="E2 估算" textSize="10sp" />
    <TextView id="value2x3" textSize="28sp" textColor="@color/e2_pink" />
    <TextView id="unit2x3" text="pg/mL" textSize="11sp" />
  </LinearLayout>
</LinearLayout>
```

### 6.2 widget_e2_plan.xml（单文件，3x2 + 2x3 双布局）

```xml
<LinearLayout orientation="vertical" padding="8dp">
  <!-- ── 3x2 横版 ──────────────────────────────────────── -->
  <LinearLayout id="row3x2" orientation="vertical">
    <LinearLayout orientation="horizontal">
      <TextView id="title3x2" text="下次 E2" textSize="11sp" weight="1" />
      <TextView id="route3x2" textSize="10sp" weight="1" gravity="end" />
    </LinearLayout>
    <LinearLayout orientation="horizontal" baselineAligned="true">
      <TextView id="countdown3x2" textSize="24sp" weight="1" />
      <TextView id="absTime3x2" textSize="14sp" gravity="end" weight="1" />
    </LinearLayout>
    <TextView id="drug3x2" textSize="10sp" />  <!-- 药名+剂量,如"EV 4mg" -->
  </LinearLayout>

  <!-- ── 2x3 竖版(丢剂量、staleness,只留药名+倒计时+绝对时间) ── -->
  <LinearLayout id="col2x3" orientation="vertical" gravity="center">
    <TextView id="title2x3" text="下次 E2" textSize="10sp" />
    <TextView id="countdown2x3" textSize="26sp" />
    <LinearLayout orientation="horizontal">
      <TextView id="drug2x3" textSize="11sp" weight="1" />
      <TextView id="absTime2x3" textSize="11sp" weight="1" gravity="end" />
    </LinearLayout>
  </LinearLayout>
</LinearLayout>
```

### 6.3 widget_e2_full.xml（5x2 固定，无 CI / 无 status）

5x2 widget 是**单一固定尺寸**（不需 3x2 + 2x3 切），layout 单文件：
```xml
<LinearLayout orientation="horizontal" padding="8dp">
  <LinearLayout weight="1" orientation="vertical">
    <TextView id="titleConc" text="E2 估算" />
    <LinearLayout orientation="horizontal">
      <TextView id="valueConc" textSize="28sp" textColor="@color/e2_pink" />
      <TextView id="unitConc" textSize="12sp" text="pg/mL" />
    </LinearLayout>
  </LinearLayout>
  <LinearLayout weight="1" orientation="vertical">
    <TextView id="titlePlan" text="下次计划" />
    <TextView id="drugPlan" text="EV 4mg" />
    <TextView id="routePlan" text="舌下含服" textSize="11sp" />
    <TextView id="timePlan" textSize="22sp" text="19:00" />
  </LinearLayout>
  <TextView id="stale" textSize="9sp" gravity="bottom" />
</LinearLayout>
```

### 6.4 widget_cal_heatmap.xml（4x3 固定，42 格月历）
```xml
<LinearLayout orientation="vertical" padding="6dp">
  <TextView id="monthLabel" />
  <GridLayout id="grid" columnCount="7" rowCount="6">
    <!-- 42 个 <TextView> 用代码动态 inflate（widget 里 static layout 不能循环） -->
  </GridLayout>
  <TextView id="legend" />
</LinearLayout>
```

**日历格动态 inflate 方案**：
- layout XML 里只放 `<GridLayout columnCount="7" rowCount="6" id="grid" />` 容器
- Kotlin 端 `for (i in 0 until 42) { val cell = RemoteViews(packageName, R.layout.widget_heatmap_cell); cell.setTextViewText(R.id.cellDay, "..."); cell.setInt(R.id.cellBg, "setBackgroundColor", color); rv.addView(R.id.grid, cell) }`
- 性能：单 widget 42 个 RemoteViews 子 view 渲染 < 100ms，OK

### 6.5 widget_*_info.xml × 7

每个 widget 一个元数据 XML（定义最小/最大尺寸 + resizeMode）：

```xml
<!-- widget_e2_conc_info.xml -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  minWidth="140dp" minHeight="140dp"      <!-- 2x3 也能装下 -->
  minResizeWidth="140dp" minResizeHeight="140dp"
  targetCellWidth="3" targetCellHeight="2"  <!-- 默认 3x2,launcher 允许拉成 2x3 -->
  widgetCategory="home_screen"
  previewImage="@drawable/widget_preview_e2_conc"
  updatePeriodMillis="0"                 <!-- 关闭系统自动刷新，WorkManager 接管 -->
  initialLayout="@layout/widget_e2_conc"
  resizeMode="horizontal|vertical"
  description="@string/widget_e2_conc_desc" />
```

**单 widget 支持 3x2 + 2x3 的机制**：

Android 12+ 允许 launcher 让用户把 widget 拉成不同 cell 尺寸。同一个 Provider + 同一个 layout XML，通过 `getAppWidgetOptions(width, height)` 在 `onUpdate` 里读当前实际尺寸，决定哪些字段 visible：

```kotlin
// E2ConcWidgetProvider.kt
override fun onAppWidgetOptionsChanged(
    ctx: Context, mgr: AppWidgetManager, id: Int, options: Bundle,
) {
    val widthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
    val heightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
    // 2x3 cells ≈ 140dp 宽 × 210dp 高
    // 3x2 cells ≈ 210dp 宽 × 140dp 高
    // 判断: height > width → 2x3 竖版; 否则 3x2 横版
    val isVertical = heightDp > widthDp
    val rv = WidgetRenderHelper.renderE2Conc(ctx, snapshot, vertical = isVertical)
    mgr.updateAppWidget(id, rv)
}
```

**layout 内部**（widget_e2_conc.xml，单文件覆盖两种尺寸）：
```xml
<LinearLayout orientation="vertical" padding="8dp">
  <!-- 3x2 横版布局（vertical=false）：横向排列 -->
  <LinearLayout id="row3x2" orientation="horizontal">
    <TextView id="title3x2" />
    <TextView id="value3x2" />
    <TextView id="ci3x2" />
    <TextView id="stale3x2" />
  </LinearLayout>
  <!-- 2x3 竖版布局（vertical=true）：纵向堆叠 -->
  <LinearLayout id="col2x3" orientation="vertical">
    <TextView id="title2x3" />
    <TextView id="value2x3" />
    <!-- 隐藏 CI 和 staleness（竖版太窄） -->
  </LinearLayout>
</LinearLayout>
```

onUpdate 根据 `vertical` 决定 `setViewVisibility(R.id.row3x2, View.GONE/VISIBLE)` 和 col2x3 同理。

---

## 7. WorkManager 调度

### 7.1 WidgetRefreshWorker

```kotlin
// src-tauri/scripts/widget/WidgetRefreshWorker.kt
class WidgetRefreshWorker(
    ctx: Context,
    params: WorkerParameters,
) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val snapshot = WidgetSnapshotStore.read(ctx)
        if (snapshot == null) {
            // App 还没运行过 — 不刷 widget，等下次 App 启动写入
            return Result.success()
        }
        // 1. 算 staleness + 倒计时，重绘所有 7 类 widget
        WidgetRefresher.refreshAll(ctx, snapshot)
        return Result.success()
    }
}
```

### 7.2 调度入口

```kotlin
// WidgetRefreshScheduler.kt
object WidgetRefreshScheduler {
    private const val WORK_NAME = "hrt_widget_refresh"
    
    fun schedule(ctx: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiresBatteryNotLow(false)        // 30 分钟一次不耗电，省电约束可关
                    .setRequiresNetworkNotConnected(false) // 完全离线算
                    .build()
            )
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,  // 已存在就不重排（BootReceiver 会 KEEP+reschedule）
            request,
        )
    }
    
    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_NAME)
    }
}
```

### 7.3 BootReceiver 扩展

现有 `BootReceiver.kt` 加一段：BOOT_COMPLETED + MY_PACKAGE_REPLACED 时调 `WidgetRefreshScheduler.schedule(context)`，保证 OEM 杀掉重启后 WorkManager 重新排上。

---

## 8. AndroidManifest.xml 新增项

CI patch 锚点（`src-tauri/scripts/AndroidManifest.widget.snippet.xml`）：

```xml
<manifest>
    <!-- 新权限：WorkManager 所需（其实只需普通 app 权限，但显式声明清晰） -->
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />  <!-- 已加 -->
    
    <application>
        <!-- 7 个 AppWidgetProvider -->
        <receiver android:name=".widget.E2ConcWidgetProvider" android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/widget_e2_conc_info" />
        </receiver>
        <!-- ... AA 三件套 + CalendarHeatmapWidgetProvider ... 同结构 6 个 ... -->
        
        <!-- WorkManager 自注册（androidx.work.WorkManagerInitializer），
             我们没有自定义 Configuration，无需显式禁用默认 initializer。 -->
    </application>
</manifest>
```

**CI 自动 patch 策略**（沿用 android-release.yml 既有风格）：
- workflow 加一个新 step："Inject widget providers into AndroidManifest.xml"
- 对每个 receiver / meta-data 做幂等注入（`grep -q` 检查后再 sed/python 写）

---

## 9. CI workflow 改动（android-release.yml）

新增 step（在"Patch AndroidManifest.xml"之后）：

```yaml
- name: Inject widget providers into AndroidManifest.xml
  run: |
    set -e
    MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
    python3 - <<'PY'
    import pathlib
    p = pathlib.Path("src-tauri/gen/android/app/src/main/AndroidManifest.xml")
    s = p.read_text()
    if "E2ConcWidgetProvider" not in s:
        widget_xml = pathlib.Path("src-tauri/scripts/AndroidManifest.widget.snippet.xml").read_text()
        # 把 widget_xml 中的所有 receiver / meta-data 块插入到 </application> 前
        injection = widget_xml.split("<application>")[1].split("</application>")[0]
        s = s.replace("</application>", injection + "\n    </application>", 1)
        p.write_text(s)
        print("injected 7 widget providers")
    else:
        print("widget providers already declared — no-op")
    PY

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
    cp src-tauri/scripts/widget/layouts/*_info.xml "$RES_DIR/xml/" 2>/dev/null || true
    ls "$RES_DIR/layout/" "$RES_DIR/xml/"
```

**ProGuard keep 规则**新增：
```proguard
# widget providers — AlarmManager/WorkManager 通过 class name 反射调用
-keep class com.smirnovayama.hrttracker.widget.* { *; }
-keep class com.smirnovayama.hrttracker.widget.**$* { *; }
```

---

## 10. 测试策略

### 10.1 单元测试（vitest）

`src/utils/widgetSnapshot.test.ts`：
- 测试 `computeWidgetSnapshot()`：
  - 空 events + 空 plans → 空 snapshot，浓度 0，下次 due null
  - 单次 E2 用药 1 小时前 → 浓度 = peak * decay(1h)
  - 计划周期 24h → nextDue 准确
  - CI 计算边界（lo == hi 时不渲染）
- 测试 staleness 计算：
  - `now - computedAtMs < 5min` → "刚刚"
  - `5min <= diff < 60min` → "N 分钟前更新"
  - `diff >= 60min` → "N 小时前更新"
  - `diff >= 24h` → "1 天前更新"（文案带"· 数据可能已变化"，但**不染色**）

### 10.2 Android instrumented test

`src-tauri/androidTest/widget/`：
- `E2ConcWidgetProviderTest`：模拟 AppWidgetManager 给 Provider 喂一个 snapshot，验证 RemoteViews 包含正确 TextView 文本
- `WidgetRefreshWorkerTest`：注入 mock snapshot，runTest() 验证 WidgetRefresher.refreshAll 被调
- `CalendarHeatmapProviderTest`：验证 42 格 GridLayout 子 view 数量 + 今天高亮

### 10.3 真机验证 checklist

按 `docs/superpowers/specs/2026-07-19-android-exact-alarm-setup.md` 同样模式输出 `2026-07-20-android-widget-verify.md`：
- [ ] 7 个 widget 都能装上桌面
- [ ] 装上后立即显示 snapshot（App 冷启动后装）
- [ ] 30 分钟后 WorkManager 自动刷新（看 Logcat）
- [ ] 杀 App 后 widget 仍显示（不消失）
- [ ] OEM 杀 WorkManager 后 widget 仍能显示（只是 staleness 增长）
- [ ] 点 widget 跳 App /overview
- [ ] 重启手机后 widget 仍正常显示
- [ ] 日历 widget 42 格全部渲染，今天高亮紫色

---

## 11. 风险与边界

### 11.1 WorkManager 被 OEM 杀
- **风险**：小米/华为/OPPO 后台杀 WorkManager 后，widget 30 分钟一次刷新停止
- **缓解**：
  - 复用现有 `WhitelistBanner` —— 用户手动加白名单后 WorkManager 不被杀
  - `BootReceiver` 监 `MY_PACKAGE_REPLACED` / `BOOT_COMPLETED` 重排 WorkManager
  - 兜底：用户每次进 App 也调 `WidgetRefreshScheduler.schedule()` 重新排

### 11.2 RemoteViews 不能用 SVG / 自定义绘制
- **风险**：日历色块不能用 Canvas，必须用预制 drawable + setBackgroundColor
- **方案**：6 种 color 各自对应 1 个 drawable（empty / E2 / CPA / E2+CPA / planOnly / today），`widget_heatmap_cell.xml` 引用
- 妥协：色块圆角和发光效果用纯色 + 圆角 drawable

### 11.3 42 格 RemoteViews 性能
- **风险**：addView 42 次可能触发 RemoteViews 序列化慢
- **实测**：Android 12+ 单 widget < 50ms，可接受
- **降级**：如真出现卡顿，用 `setImageViewBitmap` 预渲染整张 42 格 PNG（牺牲一点更新速度换渲染速度）

### 11.4 snapshot 计算 Node 子进程冷启动
- **风险**：每次 WorkManager 触发都冷启动 Node，~300ms 启动 + 200ms 计算 = 500ms 延迟
- **优化路径**（后续）：
  - 阶段 1（MVP）：Node 子进程，可接受
  - 阶段 2（如嫌慢）：Rust 重写 pk.ts 核心插值（2-3 周）
  - 阶段 3（如还嫌慢）：缓存 + 增量更新

### 11.5 浓度快照的 staleness 提示
- **风险**：widget 显示"现在 145 pg/mL"但实际可能已衰减到 130（5x2 widget 没显示 CI，用户没有可信度指示器）
- **缓解**（已按用户要求简化）：
  - 3x2 / 2x3 widget 全部显示 staleness
  - 5x2 widget 也保留 staleness
  - **不搞颜色变化**（不橙色不红色），只用纯文字标"X 分钟前更新"
  - staleness 文案分级（仅文字）：
    - `< 5 分钟` → "刚刚更新"
    - `5 ~ 30 分钟` → "N 分钟前更新"
    - `30 分钟 ~ 2 小时` → "半小时前更新"
    - `≥ 2 小时` → "N 小时前更新"
    - `≥ 24 小时` → "1 天前更新"（文案带"· 数据可能已变化"提示，但不染色）

### 11.6 PRL 不在 widget 范围
- 用户计划里有 PRL（卡麦角林）但概览页没显示 PRL 卡片
- **当前决策**：widget 不支持 PRL（与 OverviewView 对齐）
- **未来扩展**：数据契约里 PRL 是可选字段，未来可加 `prl_conc` / `prl_plan` widget

### 11.7 日历 widget 固定 4x3（不支持 3x3）
- 3x3 cells 装 42 格色块太挤（每格 ~28dp）
- 日历 widget 只提供 4x3（每格 ~33dp 清晰）
- brainstorm 阶段已确认

### 11.8 单 widget 内同时支持 3x2 + 2x3 切布局
- **机制**：onAppWidgetOptionsChanged → 读 width/height → setViewVisibility
- **风险**：第一次装 widget 时只在 onUpdate 跑一次（不会触发 onAppWidgetOptionsChanged），用户**先装成 3x2 拉成 2x3 时**才会重新 render
- **缓解**：onUpdate 也按当前 size 切一次 layout（双保险）

---

## 12. 关键文件清单

| 文件 | 操作 | 行数预估 |
|---|---|---|
| `src-tauri/src/snapshot.rs` | 新建 | ~400 |
| `src-tauri/src/lib.rs` | 改（加 2 个 command） | +50 |
| `src/state/AppDataContext.tsx` | 改（snapshot hook） | +80 |
| `src/utils/widgetSnapshot.ts` | 新建（类型 + 序列化） | ~150 |
| `src/utils/__tests__/widgetSnapshot.test.ts` | 新建 | ~200 |
| `src-tauri/scripts/widget/E2ConcWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/E2PlanWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/E2FullWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/AaConcWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/AaPlanWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/AaFullWidgetProvider.kt` | 新建 | ~80 |
| `src-tauri/scripts/widget/CalendarHeatmapWidgetProvider.kt` | 新建 | ~120 |
| `src-tauri/scripts/widget/WidgetRenderHelper.kt` | 新建（共享渲染） | ~500 |
| `src-tauri/scripts/widget/WidgetRefreshWorker.kt` | 新建 | ~50 |
| `src-tauri/scripts/widget/WidgetRefreshScheduler.kt` | 新建 | ~50 |
| `src-tauri/scripts/widget/WidgetSnapshotStore.kt` | 新建 | ~100 |
| `src-tauri/scripts/widget/BootReceiver.kt` | 改（+重排 WorkManager） | +20 |
| `src-tauri/scripts/widget/layouts/widget_e2_conc.xml` | 新建（含 3x2 + 2x3 双布局） | ~50 |
| `src-tauri/scripts/widget/layouts/widget_e2_plan.xml` | 新建（含 3x2 + 2x3 双布局） | ~60 |
| `src-tauri/scripts/widget/layouts/widget_aa_conc.xml` | 新建（含 3x2 + 2x3 双布局） | ~50 |
| `src-tauri/scripts/widget/layouts/widget_aa_plan.xml` | 新建（含 3x2 + 2x3 双布局） | ~60 |
| `src-tauri/scripts/widget/layouts/widget_e2_full.xml` | 新建（5x2 固定） | ~40 |
| `src-tauri/scripts/widget/layouts/widget_aa_full.xml` | 新建（5x2 固定） | ~40 |
| `src-tauri/scripts/widget/layouts/widget_cal_heatmap.xml` | 新建（4x3 固定） | ~50 |
| `src-tauri/scripts/widget/layouts/widget_*_info.xml` × 7 | 新建（appwidget-provider 元数据） | ~15 × 7 |
| `src-tauri/scripts/widget/layouts/widget_heatmap_cell.xml` | 新建（日历单元格模板） | ~20 |
| `src-tauri/scripts/widget/layouts/widget_preview_*.png` × 7 | 新建（widget picker 预览图,2x 尺寸 PNG） | 用脚本生成占位 |
| `src-tauri/scripts/AndroidManifest.widget.snippet.xml` | 新建 | ~100 |
| `.github/workflows/android-release.yml` | 改（+3 个 patch step） | +60 |
| `docs/superpowers/specs/2026-07-20-android-widget-verify.md` | 新建 | ~80 |

**总工作量预估**：~2500 行新代码（不含测试），分 6-7 个 commit，工作量 2-3 周。