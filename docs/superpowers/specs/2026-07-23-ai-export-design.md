# 设计文档：设置页「一键导出咨询 AI」

**日期**：2026-07-23
**范围**：在 `SettingsPage` → 数据管理 section 新增一个条目「一键导出咨询 AI」，弹窗选时间范围后把格式化好的 AI 友好 Markdown 文本复制到剪贴板。

---

## 目标

让用户能从 app 一键复制一份"医生 / AI 助手立刻能看懂"的健康数据快照（英文 Markdown + 动态语言 prompt），不用自己整理。

---

## 用户故事

作为 HRT 用药记录者，我想要：
1. 在设置页找到"一键导出咨询 AI"按钮
2. 点击后弹窗显示一个时间范围选择器（默认近 30 天，可选 7d / 30d / 90d / All / 自定义）
3. 看到生成结果的预览（折叠展开）
4. 点"Copy to Clipboard"把内容贴进任何 AI 软件

---

## 设计原则

- **不输出算法内部状态**：prefs / calibration (model, mode, applyE2* 等) / personalModel (theta, Rlog) / simCI / 原始 dueLog 和 postponeLog 事件 — 这些 AI 读不懂且会分散注意力
- **输出 KPI 计算后的数值**，不输出原始事件
- **数据部分全英文**（国际 AI 默认语言，且避免不同语种用户的混淆）
- **Prompt 部分**：5 条要点 + 任务指令硬编码英文常量；唯一动态部分是"要求 AI 用什么语言回复"那一行，按用户当前 app 语言注入
- **纯函数 + React 组件分离**，格式化函数脱离 React / Tauri context，方便单测
- **复用现有剪贴板 API**：`invoke('clipboard_write_text')` + web `navigator.clipboard.writeText` fallback
- **复用弹窗 UX 模式**：仿 `ShareImageModal` 的日期范围卡片（preset 按钮 + 手动 date input）

---

## 架构

### 新增文件

#### `src/utils/aiExport.ts`

**导出函数**：
```typescript
export interface AIExportInput {
    events: DoseEvent[];
    labResults: LabResult[];
    plans: Plan[];
    basicInfo: BasicInfo;
    postponeLog: PostponeLogEntry[];
    dueLog: DueLogEntry[];
    /** 'YYYY-MM-DD' 包含端点 */
    rangeStart: string;
    rangeEnd: string;
    lang: 'zh' | 'zh-TW' | 'en' | 'ja';
    /** 用于"exported at" 注脚；ISO 字符串 */
    exportedAt: string;
}

export interface AIExportOutput {
    text: string;
    /** true 表示生成结果超过 100KB 上限，禁止复制 */
    tooLarge: boolean;
}

export function buildAITextExport(input: AIExportInput): AIExportOutput;
```

**纯函数**：无 React / 无 Tauri / 无 localStorage 依赖。所有时间窗口 / KPI 计算都用本地传入的快照，避免隐式读取副作用。

**内部 helper**：
- `calculateAge(birth: string | null, today: Date): number | null`
- `formatEventLine(e: DoseEvent): string` — `- YYYY-MM-DD HH:MM | {Route} | {mg} mg {Ester}`
- `formatLabLine(l: LabResult): string` — `- YYYY-MM-DD HH:MM | {metric} | {value} {unit}`
- `calculate90DayAchievement(dueLog, today: Date): { rate: number; numerator: number; denominator: number } | null`
  - 与 `MedicationHeatmap.computeStats` 的 90 天达成率口径一致
  - 窗口 = `[today - 89d, today]`，分母 = taken + skipped，分子 = taken
- `calculateMonthPostponeCount(postponeLog, yearMonth: string): number`
  - 过滤 `e.yearMonth === yearMonth`，sum `days`

#### `src/components/AIExportModal.tsx`

**Props**：
```typescript
interface Props {
    isOpen: boolean;
    onClose: () => void;
    events: DoseEvent[];
    labResults: LabResult[];
    plans: Plan[];
    basicInfo: BasicInfo;
    postponeLog: PostponeLogEntry[];
    dueLog: DueLogEntry[];
    lang: Lang;
}
```

**状态**：
- `startDate: string` (YYYY-MM-DD)
- `endDate: string`
- `previewOpen: boolean` (默认 false)
- `copyState: 'idle' | 'copied'`

**useEffect 初始化**：打开时 default = `setPreset(30)`。

**useMemo 预览文本**：`buildAITextExport()` 依赖 `[startDate, endDate, events, labResults, plans, basicInfo, postponeLog, dueLog, lang, exportedAt]`。

**复制按钮**：
```typescript
const handleCopy = async () => {
    const result = buildAITextExport({...});
    if (result.tooLarge) {
        showDialog('alert', t('aiExport.tooLarge'));
        return;
    }
    try {
        if (!isTauri) {
            await navigator.clipboard.writeText(result.text);
        } else {
            await invoke('clipboard_write_text', { text: result.text });
        }
        setCopyState('copied');
        setTimeout(() => setCopyState('idle'), 2000);
    } catch (err: any) {
        const msg = err?.message || String(err);
        showDialog('alert', `${t('aiExport.error')}: ${msg}`);
    }
};
```

**UI 布局**：仿 `ShareImageModal.tsx` 的"日期范围"卡片：
1. 标题栏 + 关闭按钮
2. 副标题（说明用途）
3. 日期范围卡片（preset 按钮 + 手动 date input）
4. Preview 卡片（折叠 / 展开按钮 + `<pre>` 等宽字体）
5. "Copy to Clipboard" 主按钮（disabled 当：no data / invalid range / tooLarge）
6. 空数据提示（如 events.length === 0 && labResults.length === 0）

### 修改文件

#### `src/pages/SettingsPage.tsx`

1. 顶部 import 加 `AIExportModal`
2. `const [isAIExportOpen, setIsAIExportOpen] = useState(false)`
3. 在「数据管理」section 的 `<button>` 之间插入新条目（一键复制 和 清除 之间）
4. 末尾 JSX 加 `<AIExportModal />` 挂载点，传入 context 中已有的 events / labResults / plans / postponeLog / dueLog，以及 `loadBasicInfo()` 和 `lang`

#### `src/i18n/translations.ts`

4 语种都加键（zh / zh-TW / en / ja）：

```
settings.aiExport.title    "一键导出咨询 AI" / "Export for AI Analysis" / ...
settings.aiExport.desc     "导出 AI 友好的文本到剪切板，可粘贴到 AI 软件" / ...
aiExport.title             "Export for AI Analysis"
aiExport.desc              "Generate an AI-friendly Markdown snapshot of your health data"
aiExport.rangeLabel        "Date Range"
aiExport.rangeFrom         "From"
aiExport.rangeTo           "To"
aiExport.range7d           "Last 7d"
aiExport.range30d          "Last 30d"
aiExport.range90d          "Last 90d"
aiExport.rangeAll          "All"
aiExport.rangeInvalid      "Start date must be before end date"
aiExport.previewLabel      "Preview"
aiExport.previewToggle     "Show / Hide preview"
aiExport.copy              "Copy to Clipboard"
aiExport.copied            "Copied!"
aiExport.empty             "No data to export"
aiExport.tooLarge          "Export too large, please shorten the date range"
aiExport.error             "Copy failed"
aiExport.promptLang.zh     "Respond in 简体中文 (zh)"
aiExport.promptLang.zh-TW  "Respond in 正體中文 (zh-TW)"
aiExport.promptLang.ja     "Respond in 日本語 (ja)"
aiExport.promptLang.en     "Respond in English (matches the user's app language)"
```

---

## 输出文本结构（示例，lang='zh'）

```markdown
# HRT Medication Data Export — AI Analysis Request

Please analyze the data below and follow these instructions:

1. Evaluate the current dosing regimen and PK timeline balance
   (peak/trough levels, dosing intervals, fluctuation risk).
2. Evaluate whether the administration route and ester choice match
   standard international guidelines (WPATH SOC 8 / Endocrine Society).
3. Identify potential risks or compliance issues based on the recorded
   events.
4. Provide actionable insights and guidance for the next medical
   consultation.
5. Keep your tone objective, professional, empathetic, and
   evidence-based.

IMPORTANT: Respond in 简体中文 (zh) — this matches the user's current
app language. Do not switch to English in your reply.

---

## Patient Profile

- Age: 28
- HRT Start Date: 2024-03-15
- Allergies / Contraindications: None recorded

---

## Active Dosing Plans

- EV | IM Injection | 5 mg | Every 5 days at 20:30
- CPA | Oral | 12.5 mg | Every 2 days at 20:00

---

## Recent Medication Log (Last 30 days)

- 2026-06-22 20:30 | IM Injection | 5 mg EV
- 2026-06-27 20:30 | IM Injection | 5 mg EV
- ...

(Or: "No doses recorded in this date range." if empty)

---

## Lab Results (Last 30 days)

- 2026-07-05 09:00 | E2 | 156 pg/mL
- 2026-06-10 09:00 | T | 0.42 ng/mL

(Or: "No lab results in this date range." if empty)

---

## Recent Adherence KPIs

- 90-day Achievement Rate: 87% (31/36 due days taken; 5 skipped)
- This Month's Postpone Count: 2 events

---

## Notes

- Data exported from Transmtf HRT Tracker on 2026-07-23 14:30 UTC
- The above is an automatically-generated snapshot. Pre/post dose labs are
  shown without clinical interpretation; consult your physician for medical
  advice.
```

**Section-by-section 输出规则**：

| Section | 输入 | 输出规则 |
|---|---|---|
| Header | `lang`, `exportedAt` | 标题固定英文；5 条要点固定英文；promptLang 行按 lang 取 |
| Patient Profile | `basicInfo` | Age 从 birth (YYYY-MM) + today 推算；HRT Start 直接显示；Allergies 空 → "None recorded"，非空 → 显示文本 |
| Active Dosing Plans | `plans.filter(p => p.enabled)` | 每行 `{ester} \| {route} \| {doseMG} mg \| Every {intervalDays}d at {HH:MM}`；空 → "No active plans." |
| Medication Log | `events.filter(e => timeH in range)` | 按 timeH 升序；空 → "No doses recorded..." |
| Lab Results | `labResults.filter(l => timeH in range)` | 按 timeH 升序；空 → "No lab results..." |
| Adherence KPIs | `dueLog`, `postponeLog`, today | 90-day Achievement 用 dueLog 口径 C；Postpone Count 过滤当前年-月 |
| Notes | `exportedAt` | "Data exported from Transmtf HRT Tracker on ..." + 免责说明 |

**绝对不输出**（实现时显式 not included）：
- prefs（lang / themeColor / darkMode / remindersEnabled）
- calibration（model / mode / applyE2LearningToCPA / applyCPAInhibitionToE2）
- personalModel（thetaMean / thetaCov / Rlog / observationCount）
- simCI（ci95Low/High、ci68Low/High、antiandrogen map）
- 原始 dueLog / postponeLog 事件（只输出 KPI 数值）

---

## 错误处理与边界

| 场景 | 行为 |
|---|---|
| events + labResults 都为空 | 弹窗显示 "No data to export"，复制按钮 disabled |
| startDate > endDate | date input 红边，下方红字 "Start must be before end"，按钮 disabled |
| 复制失败（Tauri / web clipboard） | alert 显示真实错误消息，不静默失败 |
| basicInfo 全空 | Profile section 三行都输出 "Not recorded" 或 "None recorded"，section 保留 |
| plans 全 disabled | "No active plans." |
| events 在范围外 / labResults 在范围外 | 对应 section 输出 "No X recorded in this date range." |
| dueLog 空 | KPI 输出 "Insufficient data (no dueLog entries yet)" |
| dueLog 在 90 天窗口外为空 | KPI 输出 "Insufficient data (no due days in last 90 days)" |
| birth 非法 / null | Age 显示 "Not recorded"，不抛错 |
| timeH 异常（NaN / 负数 / Infinity） | filter 时跳过，不抛错 |
| lang 不在 4 语种 | fallback 到 `aiExport.promptLang.en` |
| 输出文本 > 100KB | 返回 `tooLarge: true`，UI disable 复制 + alert "Export too large..." |
| Tauri 不可用（web preview） | 走 `navigator.clipboard.writeText`；不支持则 alert |
| 弹窗打开后 events/labResults 后台变化 | useMemo 依赖会触发重算（接受） |

---

## 测试覆盖

### `src/utils/aiExport.test.ts`（新建，必做）

覆盖所有 Section 输出规则：

1. **Patient Profile** (5 cases)
   - birth 完整 → 正确年龄（含跨月减 1）
   - birth null → "Not recorded"
   - birth 非法 → "Not recorded" 不抛错
   - hrtStart null → "Not recorded"
   - allergies 空 vs 非空

2. **Active Dosing Plans** (3 cases)
   - 全 enabled → 全列
   - 部分 disabled → 只列 enabled
   - 全空 → "No active plans."

3. **Medication Log** (4 cases)
   - 全部在范围内 → 全部列出，按 timeH 升序
   - 部分在范围外 → 只列范围内
   - 全在范围外 → "No doses recorded in this date range."
   - 空数组 → 同上

4. **Lab Results** (4 cases，同 medication log)

5. **Adherence KPIs** (6 cases)
   - dueLog 全 taken → "100%"
   - 部分 taken + skipped → 正确百分比 + (num/den)
   - dueLog 空 → "Insufficient data"
   - 90 天窗口外无 due → "Insufficient data (no due days in last 90 days)"
   - postponeLog 本月 N → "N events"
   - postponeLog 本月 0 → "0 events"
   - postponeLog 非本月 → 不计入

6. **Prompt 注入** (5 cases)
   - lang='zh' → 含 `Respond in 简体中文`
   - lang='zh-TW' → 含 `Respond in 正體中文`
   - lang='ja' → 含 `Respond in 日本語`
   - lang='en' → 含 `Respond in English (matches the user's app language)`
   - prompt 5 条要点跨语种内容一致（都是英文）

7. **整体结构** (3 cases)
   - 以 `# HRT Medication Data Export — AI Analysis Request` 开头
   - 包含全部 6 个 section（Profile / Plans / Medication / Labs / KPIs / Notes）
   - 输出文本 > 100KB 时 `tooLarge: true`

### `AIExportModal.test.tsx`（新建，可选轻量）

参考 `ShareImageModal` 的测试密度（如有），覆盖：
- 打开时默认 Last 30d 高亮 + date input 已填好
- 点 "Last 7d" → startDate/endDate 更新
- startDate > endDate → 按钮 disabled
- 点 Copy → mock `invoke` 被调用 + 文本参数非空
- 空 events + 空 labResults → "No data" 提示

---

## 实施步骤

1. 写 `src/utils/aiExport.ts`（纯函数 + 类型）
2. 写 `src/utils/aiExport.test.ts`（vitest）
3. 写 `src/components/AIExportModal.tsx`（React 组件）
4. 改 `src/pages/SettingsPage.tsx`（按钮 + 挂载）
5. 改 `src/i18n/translations.ts`（4 语种键）
6. 本地验证：`npx tsc --noEmit` + `npx vitest run`
7. commit：`feat: 设置页新增"一键导出咨询 AI"，英文 Markdown + 动态 prompt 语言注入`

---

## 不在本次范围

- 不做"导出 PDF / Word 给医生"等格式变体
- 不做"导出图片版"（已有 ShareImageModal 走的是曲线图路径，不是数据快照）
- 不做"自动同步到 Notion / Obsidian"等外部集成
- 不动 `buildExportPayload` 的 JSON 导出（那是设备迁移用途，AI 解读不友好）
- 不动 i18n 的 promptLang 键以外的提示文案（4 套翻译可能需要翻译者校对，但不在代码范围）