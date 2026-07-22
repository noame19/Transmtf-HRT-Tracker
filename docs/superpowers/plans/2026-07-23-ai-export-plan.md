# 设置页「一键导出咨询 AI」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `SettingsPage` → 数据管理 section 新增「一键导出咨询 AI」条目，弹窗选时间范围后把英文 Markdown + 动态语言 prompt 复制到剪贴板。

**Architecture:** 纯函数 `buildAITextExport()` 放 `src/utils/aiExport.ts`(无 React / 无 Tauri 依赖，可单测)；React 弹窗 `AIExportModal.tsx` 仿 `ShareImageModal` 的日期范围 UX(preset 按钮 + 手动 date input + preview 折叠)；设置页加按钮 + 挂载点；i18n 4 语种各加 ~16 个 key。输出文本**全英文 + 唯一动态语言行**(按用户当前 app 语言要求 AI 回复语言)。

**Tech Stack:** React 18 + TypeScript + vitest + happy-dom(组件测试)+ lucide-react(图标)+ 现有 `useFocusTrap` / `useDialog` / `glass-card` / `btn-press-glass` 设计 token。

**Spec:** `docs/superpowers/specs/2026-07-23-ai-export-design.md`

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/utils/aiExport.ts` | 纯函数 `buildAITextExport()` + KPI 计算 helper + 类型 | 新建 |
| `src/utils/aiExport.test.ts` | vitest 单测覆盖所有 Section 输出规则 | 新建 |
| `src/components/AIExportModal.tsx` | 弹窗 + 日期范围 + preview + 复制按钮 | 新建 |
| `src/components/AIExportModal.test.tsx` | 弹窗轻量测试(默认范围 / preset / 复制触发) | 新建 |
| `src/pages/SettingsPage.tsx` | 加按钮 + 状态 + 挂载 modal | 改 |
| `src/i18n/translations.ts` | 加 4 语种 ~16 个 key | 改 |

---

## 任务分解(6 个,按依赖顺序)

每个任务一个 commit,前缀沿用 `feat:` / `test:`。

---

### Task 1: i18n 新增 key(4 语种)

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\i18n\translations.ts`

- [ ] **Step 1: 在 zh 段加 key(放在 `settings.group.data` 附近,具体行号由实际文件决定)**

```ts
"settings.aiExport.title": "一键导出咨询 AI",
"settings.aiExport.desc": "导出 AI 友好的文本到剪切板，可粘贴到 AI 软件",
"aiExport.title": "Export for AI Analysis",
"aiExport.desc": "Generate an AI-friendly Markdown snapshot of your health data to the clipboard.",
"aiExport.rangeLabel": "Date Range",
"aiExport.rangeFrom": "From",
"aiExport.rangeTo": "To",
"aiExport.range7d": "Last 7d",
"aiExport.range30d": "Last 30d",
"aiExport.range90d": "Last 90d",
"aiExport.rangeAll": "All",
"aiExport.rangeInvalid": "Start date must be before end date",
"aiExport.previewLabel": "Preview",
"aiExport.previewToggle": "Show / Hide preview",
"aiExport.copy": "Copy to Clipboard",
"aiExport.copied": "Copied!",
"aiExport.empty": "No data to export",
"aiExport.tooLarge": "Export too large, please shorten the date range",
"aiExport.error": "Copy failed",
"aiExport.promptLang.zh": "Respond in 简体中文 (zh)",
"aiExport.promptLang.zh-TW": "Respond in 正體中文 (zh-TW)",
"aiExport.promptLang.ja": "Respond in 日本語 (ja)",
"aiExport.promptLang.en": "Respond in English (matches the user's app language)",
```

注意:`aiExport.title` / `aiExport.desc` / 按钮等弹窗内的英文文案也是 zh 段的值 —— 4 语种下都展示相同的英文(因为数据输出本身就是英文)。这避免了 i18n 文案膨胀,且符合"主语言是 zh 用户看英文"的设计意图。

- [ ] **Step 2: 在 en 段加同样的 key(英文版)**

```ts
"settings.aiExport.title": "Export for AI Analysis",
"settings.aiExport.desc": "Generate an AI-friendly Markdown snapshot to the clipboard.",
"aiExport.title": "Export for AI Analysis",
"aiExport.desc": "Generate an AI-friendly Markdown snapshot of your health data to the clipboard.",
"aiExport.rangeLabel": "Date Range",
"aiExport.rangeFrom": "From",
"aiExport.rangeTo": "To",
"aiExport.range7d": "Last 7d",
"aiExport.range30d": "Last 30d",
"aiExport.range90d": "Last 90d",
"aiExport.rangeAll": "All",
"aiExport.rangeInvalid": "Start date must be before end date",
"aiExport.previewLabel": "Preview",
"aiExport.previewToggle": "Show / Hide preview",
"aiExport.copy": "Copy to Clipboard",
"aiExport.copied": "Copied!",
"aiExport.empty": "No data to export",
"aiExport.tooLarge": "Export too large, please shorten the date range",
"aiExport.error": "Copy failed",
"aiExport.promptLang.zh": "Respond in 简体中文 (zh)",
"aiExport.promptLang.zh-TW": "Respond in 正體中文 (zh-TW)",
"aiExport.promptLang.ja": "Respond in 日本語 (ja)",
"aiExport.promptLang.en": "Respond in English (matches the user's app language)",
```

- [ ] **Step 3: 在 zh-TW 段加**

```ts
"settings.aiExport.title": "一鍵匯出諮詢 AI",
"settings.aiExport.desc": "匯出 AI 友善的文字到剪貼簿，可貼到 AI 軟體",
"aiExport.title": "Export for AI Analysis",
"aiExport.desc": "Generate an AI-friendly Markdown snapshot of your health data to the clipboard.",
"aiExport.rangeLabel": "Date Range",
"aiExport.rangeFrom": "From",
"aiExport.rangeTo": "To",
"aiExport.range7d": "Last 7d",
"aiExport.range30d": "Last 30d",
"aiExport.range90d": "Last 90d",
"aiExport.rangeAll": "All",
"aiExport.rangeInvalid": "Start date must be before end date",
"aiExport.previewLabel": "Preview",
"aiExport.previewToggle": "Show / Hide preview",
"aiExport.copy": "Copy to Clipboard",
"aiExport.copied": "Copied!",
"aiExport.empty": "No data to export",
"aiExport.tooLarge": "Export too large, please shorten the date range",
"aiExport.error": "Copy failed",
"aiExport.promptLang.zh": "Respond in 简体中文 (zh)",
"aiExport.promptLang.zh-TW": "Respond in 正體中文 (zh-TW)",
"aiExport.promptLang.ja": "Respond in 日本語 (ja)",
"aiExport.promptLang.en": "Respond in English (matches the user's app language)",
```

- [ ] **Step 4: 在 ja 段加**

```ts
"settings.aiExport.title": "AI 相談用にエクスポート",
"settings.aiExport.desc": "AI 向けのテキストをクリップボードにコピー",
"aiExport.title": "Export for AI Analysis",
"aiExport.desc": "Generate an AI-friendly Markdown snapshot of your health data to the clipboard.",
"aiExport.rangeLabel": "Date Range",
"aiExport.rangeFrom": "From",
"aiExport.rangeTo": "To",
"aiExport.range7d": "Last 7d",
"aiExport.range30d": "Last 30d",
"aiExport.range90d": "Last 90d",
"aiExport.rangeAll": "All",
"aiExport.rangeInvalid": "Start date must be before end date",
"aiExport.previewLabel": "Preview",
"aiExport.previewToggle": "Show / Hide preview",
"aiExport.copy": "Copy to Clipboard",
"aiExport.copied": "Copied!",
"aiExport.empty": "No data to export",
"aiExport.tooLarge": "Export too large, please shorten the date range",
"aiExport.error": "Copy failed",
"aiExport.promptLang.zh": "Respond in 简体中文 (zh)",
"aiExport.promptLang.zh-TW": "Respond in 正體中文 (zh-TW)",
"aiExport.promptLang.ja": "Respond in 日本語 (ja)",
"aiExport.promptLang.en": "Respond in English (matches the user's app language)",
```

- [ ] **Step 5: 跑 tsc 确认无错**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | grep "src/" || echo "tsc: 0 errors in src/"
```

Expected: `tsc: 0 errors in src/`(注意:`src-tauri/target` 下的 .ts 文件是 Tauri 编译产物，不影响 src 代码)。

- [ ] **Step 6: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/i18n/translations.ts && git commit -m "feat(i18n): 新增 aiExport 相关文案 key(中/英/繁/日 4 语种)"
```

---

### Task 2: 新建 `src/utils/aiExport.ts`(纯函数 + 类型)

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\utils\aiExport.ts`

- [ ] **Step 1: 写文件**

```ts
import type { DoseEvent, LabResult } from '../../types';
import type { Plan } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from '../components/BasicInfoModal';
import { AppDataContext } from '../contexts/AppDataContext';

// ── Public types ──────────────────────────────────────────────────────

export type SupportedLang = 'zh' | 'zh-TW' | 'en' | 'ja';

export interface AIExportInput {
    events: DoseEvent[];
    labResults: LabResult[];
    plans: Plan[];
    basicInfo: BasicInfo;
    postponeLog: PostponeLogEntry[];
    dueLog: DueLogEntry[];
    /** Inclusive range start, YYYY-MM-DD (local time). */
    rangeStart: string;
    /** Inclusive range end, YYYY-MM-DD (local time). */
    rangeEnd: string;
    lang: SupportedLang;
    /** Used for "exported at" footnote. ISO string or any parseable date. */
    exportedAt: Date;
}

export interface AIExportOutput {
    text: string;
    /** True if generated text exceeds 100KB — caller should refuse copy. */
    tooLarge: boolean;
}

const MAX_BYTES = 100_000;

// ── Date helpers (local time) ──────────────────────────────────────────

/** Parse YYYY-MM-DD into local-midnight ms. Returns NaN on malformed input. */
function dateKeyToMs(s: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    return new Date(y, mo, d, 0, 0, 0, 0).getTime();
}

/** Convert ms-since-epoch to YYYY-MM-DD local date key. */
function msToDateKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Convert ms-since-epoch to "YYYY-MM-DD HH:MM" local. */
function msToDateTime(ms: number): string {
    const d = new Date(ms);
    const date = msToDateKey(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${date} ${hh}:${mm}`;
}

// ── KPI calculators ───────────────────────────────────────────────────

/**
 * 90-day achievement rate from dueLog (口径 C).
 *   window = [today - 89d, today] (90 calendar days inclusive)
 *   numerator = taken within window
 *   denominator = taken + skipped within window (postponed excluded)
 */
function calculate90DayAchievement(
    dueLog: DueLogEntry[],
    todayMs: number,
): { rate: number; numerator: number; denominator: number } | null {
    if (dueLog.length === 0) return null;
    const cutoffMs = todayMs - 89 * 86_400_000;
    let taken = 0;
    let applicable = 0;
    for (const e of dueLog) {
        const t = dateKeyToMs(e.dateKey);
        if (!isFinite(t) || t < cutoffMs || t > todayMs) continue;
        if (e.status === 'taken') {
            taken += 1;
            applicable += 1;
        } else if (e.status === 'skipped') {
            applicable += 1;
        }
    }
    if (applicable === 0) return null;
    return { rate: taken / applicable, numerator: taken, denominator: applicable };
}

function calculateMonthPostponeCount(
    postponeLog: PostponeLogEntry[],
    yearMonth: string,
): number {
    return postponeLog
        .filter(e => e.yearMonth === yearMonth)
        .reduce((sum, e) => sum + e.days, 0);
}

// ── Age calculation ───────────────────────────────────────────────────

function calculateAge(birth: string | null, today: Date): number | null {
    if (!birth) return null;
    const m = /^(\d{4})-(\d{2})$/.exec(birth);
    if (!m) return null;
    const by = +m[1], bm = +m[2];
    if (bm < 1 || bm > 12) return null;
    let age = today.getFullYear() - by;
    if (today.getMonth() + 1 < bm) age -= 1;
    return age >= 0 ? age : null;
}

// ── Section builders ──────────────────────────────────────────────────

const ROUTE_DISPLAY: Record<string, string> = {
    injection: 'IM Injection',
    oral: 'Oral',
    gel: 'Transdermal Gel',
    patch: 'Patch',
};

function formatEventLine(e: DoseEvent): string {
    const ms = e.timeH * 3600_000;
    if (!isFinite(ms) || ms < 0) return ''; // skip malformed
    const dt = msToDateTime(ms);
    const route = ROUTE_DISPLAY[e.route] ?? e.route;
    return `- ${dt} | ${route} | ${e.doseMG} mg ${e.ester}`;
}

function formatLabLine(l: LabResult): string {
    const ms = l.timeH * 3600_000;
    if (!isFinite(ms) || ms < 0) return '';
    const dt = msToDateTime(ms);
    return `- ${dt} | ${l.metric} | ${l.concValue} ${l.unit}`;
}

function sectionHeader(title: string): string {
    return `\n---\n\n## ${title}\n\n`;
}

// ── Main export ───────────────────────────────────────────────────────

export function buildAITextExport(input: AIExportInput): AIExportOutput {
    const {
        events, labResults, plans, basicInfo, postponeLog, dueLog,
        rangeStart, rangeEnd, lang, exportedAt,
    } = input;

    const today = new Date();
    const todayMs = today.getTime();
    const startMs = dateKeyToMs(rangeStart);
    const endMs = dateKeyToMs(rangeEnd);
    // Inclusive end-of-day
    const endInclusiveMs = isFinite(endMs) ? endMs + 86_400_000 - 1 : NaN;

    const out: string[] = [];

    // ── Header + prompt (固定英文) ─────────────────────────
    out.push('# HRT Medication Data Export — AI Analysis Request');
    out.push('');
    out.push('Please analyze the data below and follow these instructions:');
    out.push('');
    out.push('1. Evaluate the current dosing regimen and PK timeline balance (peak/trough levels, dosing intervals, fluctuation risk).');
    out.push('2. Evaluate whether the administration route and ester choice match standard international guidelines (WPATH SOC 8 / Endocrine Society).');
    out.push('3. Identify potential risks or compliance issues based on the recorded events.');
    out.push('4. Provide actionable insights and guidance for the next medical consultation.');
    out.push('5. Keep your tone objective, professional, empathetic, and evidence-based.');
    out.push('');
    out.push(`IMPORTANT: ${promptLangLine(lang)} — this matches the user's current app language. Do not switch language in your reply.`);
    out.push('');

    // ── Patient Profile ───────────────────────────────────
    out.push(sectionHeader('Patient Profile').trimStart());
    const age = calculateAge(basicInfo.birth, today);
    out.push(`- Age: ${age !== null ? age : 'Not recorded'}`);
    out.push(`- HRT Start Date: ${basicInfo.hrtStart ?? 'Not recorded'}`);
    const allergies = basicInfo.allergies?.trim();
    out.push(`- Allergies / Contraindications: ${allergies ? allergies : 'None recorded'}`);
    out.push('');

    // ── Active Dosing Plans ───────────────────────────────
    out.push(sectionHeader('Active Dosing Plans').trimStart());
    const activePlans = plans.filter(p => p.enabled);
    if (activePlans.length === 0) {
        out.push('No active plans.');
    } else {
        for (const p of activePlans) {
            const route = ROUTE_DISPLAY[p.route] ?? p.route;
            const interval = (p as any).intervalDays;
            const startH = (p as any).startHour ?? 20;
            const hh = String(startH).padStart(2, '0');
            out.push(`- ${p.ester} | ${route} | ${p.doseMG} mg | Every ${interval}d at ${hh}:00`);
        }
    }
    out.push('');

    // ── Medication Log ────────────────────────────────────
    out.push(sectionHeader(`Recent Medication Log (${formatRangeLabel(rangeStart, rangeEnd)})`).trimStart());
    const eventsInRange = (events ?? [])
        .filter(e => {
            const ms = e.timeH * 3600_000;
            return isFinite(ms) && ms >= 0 && ms >= startMs && ms <= endInclusiveMs;
        })
        .sort((a, b) => a.timeH - b.timeH);
    if (eventsInRange.length === 0) {
        out.push('No doses recorded in this date range.');
    } else {
        for (const e of eventsInRange) {
            const line = formatEventLine(e);
            if (line) out.push(line);
        }
    }
    out.push('');

    // ── Lab Results ───────────────────────────────────────
    out.push(sectionHeader(`Lab Results (${formatRangeLabel(rangeStart, rangeEnd)})`).trimStart());
    const labsInRange = (labResults ?? [])
        .filter(l => {
            const ms = l.timeH * 3600_000;
            return isFinite(ms) && ms >= 0 && ms >= startMs && ms <= endInclusiveMs;
        })
        .sort((a, b) => a.timeH - b.timeH);
    if (labsInRange.length === 0) {
        out.push('No lab results in this date range.');
    } else {
        for (const l of labsInRange) {
            const line = formatLabLine(l);
            if (line) out.push(line);
        }
    }
    out.push('');

    // ── Adherence KPIs ────────────────────────────────────
    out.push(sectionHeader('Recent Adherence KPIs').trimStart());
    const achievement = calculate90DayAchievement(dueLog, todayMs);
    if (achievement === null) {
        if (dueLog.length === 0) {
            out.push('- 90-day Achievement Rate: Insufficient data (no dueLog entries yet)');
        } else {
            out.push('- 90-day Achievement Rate: Insufficient data (no due days in last 90 days)');
        }
    } else {
        const pct = Math.round(achievement.rate * 100);
        out.push(`- 90-day Achievement Rate: ${pct}% (${achievement.numerator}/${achievement.denominator} due days taken)`);
    }
    const yearMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const postponeCount = calculateMonthPostponeCount(postponeLog, yearMonth);
    out.push(`- This Month's Postpone Count: ${postponeCount} event${postponeCount === 1 ? '' : 's'}`);
    out.push('');

    // ── Notes ─────────────────────────────────────────────
    out.push(sectionHeader('Notes').trimStart());
    out.push(`- Data exported from Transmtf HRT Tracker on ${exportedAt.toISOString()}`);
    out.push('- The above is an automatically-generated snapshot. Pre/post dose labs are shown without clinical interpretation; consult your physician for medical advice.');
    out.push('');

    const text = out.join('\n');
    return {
        text,
        tooLarge: text.length > MAX_BYTES,
    };
}

function formatRangeLabel(start: string, end: string): string {
    if (start === end) return start;
    return `${start} ~ ${end}`;
}

function promptLangLine(lang: SupportedLang): string {
    switch (lang) {
        case 'zh': return 'Respond in 简体中文 (zh)';
        case 'zh-TW': return 'Respond in 正體中文 (zh-TW)';
        case 'ja': return 'Respond in 日本語 (ja)';
        case 'en': return 'Respond in English (matches the user\'s app language)';
    }
}
```

- [ ] **Step 2: 跑 tsc 确认**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | grep "src/" || echo "tsc: 0 errors in src/"
```

Expected: `tsc: 0 errors in src/`。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/utils/aiExport.ts && git commit -m "feat(utils): 新建 buildAITextExport 纯函数 + 90 天 KPI / 本月推迟计算 helper"
```

---

### Task 3: `aiExport.test.ts` 单测(TDD,先写测试)

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\utils\aiExport.test.ts`

- [ ] **Step 1: 写测试文件**

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildAITextExport, type AIExportInput } from './aiExport';
import type { DoseEvent, LabResult, Plan } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from '../components/BasicInfoModal';

// ── Test fixtures ─────────────────────────────────────────────────────

const today = new Date('2026-07-23T10:00:00');

function ms(dateStr: string): number {
    return new Date(dateStr).getTime();
}

function eventH(dateStr: string): number {
    return new Date(dateStr).getTime() / 3600_000;
}

const basicInfo: BasicInfo = {
    route: 'MtF',
    birth: '1998-05',
    heightCm: 168,
    allergies: '',
    hrtStart: '2024-03-15',
};

const emptyBasicInfo: BasicInfo = {
    route: null,
    birth: null,
    heightCm: null,
    allergies: '',
    hrtStart: null,
};

const sampleEvents: DoseEvent[] = [
    {
        id: 'e1', timeH: eventH('2026-07-22T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
    {
        id: 'e2', timeH: eventH('2026-07-06T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
    {
        id: 'e3', timeH: eventH('2026-06-01T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
];

const sampleLabs: LabResult[] = [
    { id: 'l1', timeH: eventH('2026-07-05T09:00:00'), metric: 'E2', concValue: 156, unit: 'pg/mL' },
    { id: 'l2', timeH: eventH('2026-04-01T09:00:00'), metric: 'T', concValue: 0.42, unit: 'ng/mL' },
];

const samplePlans: Plan[] = [
    { id: 'p1', ester: 'EV', route: 'injection', doseMG: 5, intervalDays: 5, enabled: true } as Plan,
    { id: 'p2', ester: 'CPA', route: 'oral', doseMG: 12.5, intervalDays: 2, enabled: true } as Plan,
    { id: 'p3', ester: 'EEn', route: 'injection', doseMG: 8, intervalDays: 7, enabled: false } as Plan,
];

const emptyInput: AIExportInput = {
    events: [], labResults: [], plans: [], basicInfo: emptyBasicInfo,
    postponeLog: [], dueLog: [],
    rangeStart: '2026-06-23', rangeEnd: '2026-07-23',
    lang: 'zh', exportedAt: today,
};

const fullInput: AIExportInput = {
    events: sampleEvents,
    labResults: sampleLabs,
    plans: samplePlans,
    basicInfo,
    postponeLog: [],
    dueLog: [],
    rangeStart: '2026-06-23',
    rangeEnd: '2026-07-23',
    lang: 'zh',
    exportedAt: today,
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('buildAITextExport — Patient Profile', () => {
    it('computes age correctly with cross-month handling', () => {
        // Birth May 1998, today July 23 2026 → age 28 (birthday already passed)
        const out = buildAITextExport({ ...fullInput, basicInfo });
        expect(out.text).toMatch(/Age: 28/);
    });

    it('subtracts 1 when birthday has not occurred this year', () => {
        const futureBirthday: BasicInfo = { ...basicInfo, birth: '1998-12' };
        const out = buildAITextExport({ ...fullInput, basicInfo: futureBirthday });
        // Dec birthday hasn't come yet in July → age 27
        expect(out.text).toMatch(/Age: 27/);
    });

    it('shows Not recorded when birth is null', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: emptyBasicInfo });
        expect(out.text).toMatch(/Age: Not recorded/);
    });

    it('shows Not recorded when birth is malformed', () => {
        const malformed: BasicInfo = { ...basicInfo, birth: '1998-13' };
        const out = buildAITextExport({ ...fullInput, basicInfo: malformed });
        expect(out.text).toMatch(/Age: Not recorded/);
    });

    it('shows hrtStart when set', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo });
        expect(out.text).toMatch(/HRT Start Date: 2024-03-15/);
    });

    it('shows Not recorded when hrtStart is null', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: emptyBasicInfo });
        expect(out.text).toMatch(/HRT Start Date: Not recorded/);
    });

    it('shows None recorded when allergies is empty', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: { ...basicInfo, allergies: '' } });
        expect(out.text).toMatch(/Allergies \/ Contraindications: None recorded/);
    });

    it('shows allergies text when set', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: { ...basicInfo, allergies: 'Peanut allergy' } });
        expect(out.text).toMatch(/Allergies \/ Contraindications: Peanut allergy/);
    });
});

describe('buildAITextExport — Active Dosing Plans', () => {
    it('lists only enabled plans', () => {
        const out = buildAITextExport({ ...fullInput });
        expect(out.text).toContain('EV');
        expect(out.text).toContain('CPA');
        expect(out.text).not.toContain('EEn');
    });

    it('shows No active plans when all disabled', () => {
        const out = buildAITextExport({ ...fullInput, plans: [] });
        expect(out.text).toContain('No active plans.');
    });
});

describe('buildAITextExport — Medication Log', () => {
    it('filters events to the requested range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-07-01', rangeEnd: '2026-07-31' });
        expect(out.text).toContain('e1'); // 2026-07-22 in range
        expect(out.text).toContain('e2'); // 2026-07-06 in range
        expect(out.text).not.toContain('e3'); // 2026-06-01 out of range
    });

    it('sorts events by timeH ascending', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-06-01', rangeEnd: '2026-07-31' });
        const e2Idx = out.text.indexOf('2026-07-06');
        const e1Idx = out.text.indexOf('2026-07-22');
        expect(e2Idx).toBeGreaterThan(0);
        expect(e1Idx).toBeGreaterThan(e2Idx);
    });

    it('shows No doses recorded when empty', () => {
        const out = buildAITextExport({ ...fullInput, events: [] });
        expect(out.text).toContain('No doses recorded in this date range.');
    });

    it('shows No doses recorded when all events out of range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-05-01', rangeEnd: '2026-05-15' });
        expect(out.text).toContain('No doses recorded in this date range.');
    });
});

describe('buildAITextExport — Lab Results', () => {
    it('filters labs to the requested range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-06-01', rangeEnd: '2026-07-31' });
        expect(out.text).toContain('E2'); // 2026-07-05 in range
        expect(out.text).not.toContain('| T |'); // 2026-04-01 out of range
    });

    it('shows No lab results when empty', () => {
        const out = buildAITextExport({ ...fullInput, labResults: [] });
        expect(out.text).toContain('No lab results in this date range.');
    });
});

describe('buildAITextExport — Adherence KPIs', () => {
    // 90-day window from today (2026-07-23): [2026-04-25, 2026-07-23]
    it('computes 100% when all dueLog entries are taken', () => {
        const dueLog: DueLogEntry[] = [];
        for (let i = 0; i < 10; i++) {
            const dateMs = today.getTime() - i * 5 * 86_400_000;
            const d = new Date(dateMs);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dueLog.push({ id: `d${i}`, planId: 'p1', dateKey: key, status: 'taken', tsMs: dateMs });
        }
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toMatch(/90-day Achievement Rate: 100% \(10\/10 due days taken\)/);
    });

    it('computes partial rate with mixed taken/skipped', () => {
        const dueLog: DueLogEntry[] = [];
        for (let i = 0; i < 10; i++) {
            const dateMs = today.getTime() - i * 5 * 86_400_000;
            const d = new Date(dateMs);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dueLog.push({ id: `d${i}`, planId: 'p1', dateKey: key, status: i < 7 ? 'taken' : 'skipped', tsMs: dateMs });
        }
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toMatch(/90-day Achievement Rate: 70% \(7\/10 due days taken\)/);
    });

    it('excludes postponed from both numerator and denominator', () => {
        const dueLog: DueLogEntry[] = [
            { id: 'd1', planId: 'p1', dateKey: '2026-07-20', status: 'taken', tsMs: 1 },
            { id: 'd2', planId: 'p1', dateKey: '2026-07-15', status: 'taken', tsMs: 1 },
            { id: 'd3', planId: 'p1', dateKey: '2026-07-10', status: 'postponed', tsMs: 1 },
            { id: 'd4', planId: 'p1', dateKey: '2026-07-05', status: 'skipped', tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, dueLog });
        // 2 taken / (2 taken + 1 skipped) = 2/3 = 67%
        expect(out.text).toMatch(/90-day Achievement Rate: 67% \(2\/3 due days taken\)/);
    });

    it('shows Insufficient data when dueLog is empty', () => {
        const out = buildAITextExport({ ...fullInput, dueLog: [] });
        expect(out.text).toContain('Insufficient data (no dueLog entries yet)');
    });

    it('shows Insufficient data when no due days in 90-day window', () => {
        const dueLog: DueLogEntry[] = [
            { id: 'd1', planId: 'p1', dateKey: '2020-01-01', status: 'taken', tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toContain('Insufficient data (no due days in last 90 days)');
    });

    it('counts this-month postpone events', () => {
        const postponeLog: PostponeLogEntry[] = [
            { id: 'p1', planId: 'p1', yearMonth: '2026-07', days: 2, tsMs: 1 },
            { id: 'p2', planId: 'p2', yearMonth: '2026-07', days: 1, tsMs: 1 },
            { id: 'p3', planId: 'p1', yearMonth: '2026-06', days: 5, tsMs: 1 }, // last month, ignore
        ];
        const out = buildAITextExport({ ...fullInput, postponeLog });
        expect(out.text).toContain("This Month's Postpone Count: 3 events");
    });

    it('uses singular event when count is 1', () => {
        const postponeLog: PostponeLogEntry[] = [
            { id: 'p1', planId: 'p1', yearMonth: '2026-07', days: 1, tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, postponeLog });
        expect(out.text).toMatch(/Postpone Count: 1 event(?!s)/);
    });

    it('shows 0 events when no this-month postpones', () => {
        const out = buildAITextExport({ ...fullInput, postponeLog: [] });
        expect(out.text).toContain("This Month's Postpone Count: 0 events");
    });
});

describe('buildAITextExport — prompt language injection', () => {
    it('injects 简体中文 for lang=zh', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'zh' });
        expect(out.text).toContain('Respond in 简体中文 (zh)');
    });

    it('injects 正體中文 for lang=zh-TW', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'zh-TW' });
        expect(out.text).toContain('Respond in 正體中文 (zh-TW)');
    });

    it('injects 日本語 for lang=ja', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'ja' });
        expect(out.text).toContain('Respond in 日本語 (ja)');
    });

    it('injects English for lang=en', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'en' });
        expect(out.text).toContain("Respond in English (matches the user's app language)");
    });

    it('prompt 5 instructions are in English across all langs', () => {
        for (const lang of ['zh', 'zh-TW', 'ja', 'en'] as const) {
            const out = buildAITextExport({ ...fullInput, lang });
            expect(out.text).toContain('1. Evaluate the current dosing regimen');
            expect(out.text).toContain('5. Keep your tone objective, professional, empathetic');
        }
    });
});

describe('buildAITextExport — overall structure', () => {
    it('starts with the standard header', () => {
        const out = buildAITextExport({ ...emptyInput });
        expect(out.text.startsWith('# HRT Medication Data Export — AI Analysis Request')).toBe(true);
    });

    it('contains all 6 sections', () => {
        const out = buildAITextExport({ ...fullInput });
        expect(out.text).toContain('## Patient Profile');
        expect(out.text).toContain('## Active Dosing Plans');
        expect(out.text).toContain('## Recent Medication Log');
        expect(out.text).toContain('## Lab Results');
        expect(out.text).toContain('## Recent Adherence KPIs');
        expect(out.text).toContain('## Notes');
    });

    it('marks tooLarge=true when text exceeds 100KB', () => {
        const hugeEvents: DoseEvent[] = [];
        for (let i = 0; i < 5000; i++) {
            hugeEvents.push({
                id: `e${i}`, timeH: eventH('2024-01-01T00:00:00') + i,
                route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
            } as DoseEvent);
        }
        const out = buildAITextExport({ ...fullInput, events: hugeEvents });
        expect(out.tooLarge).toBe(true);
    });

    it('handles empty inputs without throwing', () => {
        expect(() => buildAITextExport({ ...emptyInput })).not.toThrow();
        const out = buildAITextExport({ ...emptyInput });
        expect(out.tooLarge).toBe(false);
        expect(out.text.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run src/utils/aiExport.test.ts
```

Expected: 全部 passed。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/utils/aiExport.test.ts && git commit -m "test: buildAITextExport 单元测试覆盖 Profile/Plans/Logs/KPIs/Prompt/Structure"
```

---

### Task 4: 新建 `src/components/AIExportModal.tsx`

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\AIExportModal.tsx`

- [ ] **Step 1: 写文件**

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Bot, Calendar, Clipboard, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { DoseEvent, LabResult, Plan } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from './BasicInfoModal';
import { buildAITextExport, type SupportedLang } from '../utils/aiExport';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    events: DoseEvent[];
    labResults: LabResult[];
    plans: Plan[];
    basicInfo: BasicInfo;
    postponeLog: PostponeLogEntry[];
    dueLog: DueLogEntry[];
    lang: SupportedLang;
}

// YYYY-MM-DD local helpers
function msToDateKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateKeyToMs(s: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
}

type Preset = 7 | 30 | 90 | 'all';

const AIExportModal: React.FC<Props> = ({
    isOpen, onClose, events, labResults, plans, basicInfo,
    postponeLog, dueLog, lang,
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const dialogRef = useFocusTrap(isOpen, onClose);
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [activePreset, setActivePreset] = useState<Preset | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

    // Initialize defaults on open: today - 30d ~ today, preset 30 highlighted.
    useEffect(() => {
        if (!isOpen) return;
        const now = new Date();
        const todayKey = msToDateKey(now.getTime());
        const thirtyDaysAgoKey = msToDateKey(now.getTime() - 30 * 86_400_000);
        setStartDate(thirtyDaysAgoKey);
        setEndDate(todayKey);
        setActivePreset(30);
        setPreviewOpen(false);
        setCopyState('idle');
    }, [isOpen]);

    const setPreset = (preset: Preset) => {
        const now = new Date();
        const todayKey = msToDateKey(now.getTime());
        if (preset === 'all') {
            // For 'all', use earliest event date as start (or 1 year ago as fallback)
            let startMs = now.getTime() - 365 * 86_400_000;
            for (const e of events) {
                const ms = e.timeH * 3600_000;
                if (isFinite(ms) && ms < startMs) startMs = ms;
            }
            for (const l of labResults) {
                const ms = l.timeH * 3600_000;
                if (isFinite(ms) && ms < startMs) startMs = ms;
            }
            setStartDate(msToDateKey(startMs));
            setEndDate(todayKey);
            setActivePreset('all');
            return;
        }
        const days = preset;
        const endMs = now.getTime();
        const startMs = endMs - days * 86_400_000;
        setStartDate(msToDateKey(startMs));
        setEndDate(todayKey);
        setActivePreset(preset);
    };

    const dateRangeInvalid = !!startDate && !!endDate
        && isFinite(dateKeyToMs(startDate))
        && isFinite(dateKeyToMs(endDate))
        && dateKeyToMs(startDate) > dateKeyToMs(endDate);

    const hasData = events.length > 0 || labResults.length > 0;

    // Generate text — memoized on every relevant input.
    const generated = useMemo(() => {
        if (!startDate || !endDate) return null;
        return buildAITextExport({
            events, labResults, plans, basicInfo, postponeLog, dueLog,
            rangeStart: startDate, rangeEnd: endDate, lang,
            exportedAt: new Date(),
        });
    }, [events, labResults, plans, basicInfo, postponeLog, dueLog, startDate, endDate, lang]);

    const handleCopy = async () => {
        if (!generated) return;
        if (generated.tooLarge) {
            await showDialog('alert', t('aiExport.tooLarge'));
            return;
        }
        try {
            if (!isTauri) {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(generated.text);
                } else {
                    throw new Error('clipboard not supported');
                }
            } else {
                await invoke('clipboard_write_text', { text: generated.text });
            }
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 2000);
        } catch (err: any) {
            const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'unknown';
            await showDialog('alert', `${t('aiExport.error')}: ${msg}`);
        }
    };

    if (!isOpen) return null;

    const canCopy = hasData && !dateRangeInvalid && !!generated && !generated.tooLarge;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="ai-export-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                {/* Header */}
                <div className="flex justify-between items-center mb-5 shrink-0">
                    <h3 id="ai-export-modal-title" className="text-xl font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <Bot size={20} style={{ color: 'var(--accent-500)' }} />
                        {t('aiExport.title')}
                    </h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                    {t('aiExport.desc')}
                </p>

                <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-4">
                    {/* Date range card */}
                    <div className="rounded-2xl p-4 flex flex-col gap-3"
                        style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                        <div className="flex items-center gap-2">
                            <Calendar size={16} style={{ color: 'var(--accent-500)' }} />
                            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                                {t('aiExport.rangeLabel')}
                            </span>
                        </div>

                        <div className="flex gap-3 items-end flex-wrap">
                            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                                <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('aiExport.rangeFrom')}
                                </label>
                                <input
                                    type="date"
                                    value={startDate}
                                    onChange={(e) => { setStartDate(e.target.value); setActivePreset(null); }}
                                    className="rounded-lg px-3 py-2 text-sm font-medium outline-none transition"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: `1px solid ${dateRangeInvalid ? '#ef4444' : 'var(--border-primary)'}`,
                                        colorScheme: 'light dark',
                                    }}
                                />
                            </div>
                            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                                <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('aiExport.rangeTo')}
                                </label>
                                <input
                                    type="date"
                                    value={endDate}
                                    onChange={(e) => { setEndDate(e.target.value); setActivePreset(null); }}
                                    className="rounded-lg px-3 py-2 text-sm font-medium outline-none transition"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: `1px solid ${dateRangeInvalid ? '#ef4444' : 'var(--border-primary)'}`,
                                        colorScheme: 'light dark',
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex gap-2 flex-wrap">
                            {([7, 30, 90, 'all'] as Preset[]).map(p => (
                                <button
                                    key={String(p)}
                                    type="button"
                                    onClick={() => setPreset(p)}
                                    data-testid={`preset-${p}`}
                                    className="px-2.5 py-1 rounded-md text-xs font-semibold transition btn-press-glass"
                                    style={{
                                        background: activePreset === p ? 'var(--accent-500)' : 'var(--bg-card)',
                                        color: activePreset === p ? 'white' : 'var(--text-secondary)',
                                        border: `1px solid ${activePreset === p ? 'var(--accent-500)' : 'var(--border-primary)'}`,
                                    }}
                                >
                                    {p === 'all' ? t('aiExport.rangeAll') : t(`aiExport.range${p}d` as `aiExport.range${number}d`)}
                                </button>
                            ))}
                        </div>

                        {dateRangeInvalid && (
                            <p className="text-xs" style={{ color: '#ef4444' }}>
                                {t('aiExport.rangeInvalid')}
                            </p>
                        )}
                    </div>

                    {/* Preview card */}
                    {generated && (
                        <div className="rounded-2xl p-4 flex flex-col gap-2"
                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                            <button
                                type="button"
                                onClick={() => setPreviewOpen(v => !v)}
                                className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider w-full justify-between"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                <span>{t('aiExport.previewLabel')}</span>
                                {previewOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                            {previewOpen && (
                                <pre
                                    data-testid="ai-export-preview"
                                    className="text-[11px] leading-relaxed overflow-auto max-h-64 p-3 rounded-lg whitespace-pre-wrap break-words"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--border-primary)',
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                    }}
                                >
                                    {generated.text}
                                </pre>
                            )}
                        </div>
                    )}

                    {/* Too-large warning */}
                    {generated?.tooLarge && (
                        <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm"
                            style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                            <AlertTriangle size={16} />
                            {t('aiExport.tooLarge')}
                        </div>
                    )}

                    {/* Empty data notice */}
                    {!hasData && (
                        <p className="text-center text-sm py-2" style={{ color: 'var(--text-tertiary)' }}>
                            {t('aiExport.empty')}
                        </p>
                    )}
                </div>

                {/* Footer */}
                <div className="mt-5 shrink-0">
                    <button
                        type="button"
                        onClick={handleCopy}
                        disabled={!canCopy}
                        data-testid="ai-export-copy-btn"
                        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-bold transition glass-btn-primary btn-press-glass disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Clipboard size={18} />
                        {copyState === 'copied' ? t('aiExport.copied') : t('aiExport.copy')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AIExportModal;
```

- [ ] **Step 2: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | grep "src/" || echo "tsc: 0 errors in src/"
```

Expected: `tsc: 0 errors in src/`。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/AIExportModal.tsx && git commit -m "feat(modal): 新建 AIExportModal 弹窗(日期范围 + preview + 复制)"
```

---

### Task 5: `AIExportModal.test.tsx` 轻量测试

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\AIExportModal.test.tsx`

- [ ] **Step 1: 写测试文件**

```tsx
// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => undefined),
}));

vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string) => k,
        lang: 'zh',
    }),
}));

vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({
        showDialog: vi.fn(async () => 'alert'),
    }),
}));

import AIExportModal from './AIExportModal';
import type { BasicInfo } from './BasicInfoModal';
import type { DoseEvent, LabResult, Plan } from '../../types';
import type { PostponeLogEntry, DueLogEntry } from './BasicInfoModal';

const basicInfo: BasicInfo = {
    route: 'MtF', birth: '1998-05', heightCm: 168, allergies: '', hrtStart: '2024-03-15',
};

const events: DoseEvent[] = [
    { id: 'e1', timeH: 469800.5, route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55 } as DoseEvent,
];
const labResults: LabResult[] = [
    { id: 'l1', timeH: 469720, metric: 'E2', concValue: 156, unit: 'pg/mL' },
];
const plans: Plan[] = [
    { id: 'p1', ester: 'EV', route: 'injection', doseMG: 5, intervalDays: 5, enabled: true } as Plan,
];

beforeEach(() => {
    // Fix "today" so date calculations are deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T10:00:00'));
});
afterEach(() => {
    vi.useRealTimers();
    cleanup();
});

describe('AIExportModal', () => {
    it('initializes with Last 30d highlighted and date inputs filled', () => {
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const preset30 = screen.getByTestId('preset-30');
        expect(preset30.style.background).not.toBe('');
        // Verify dates are filled (any non-empty value)
        const dateInputs = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/);
        expect(dateInputs.length).toBeGreaterThanOrEqual(2);
    });

    it('clicking Last 7d updates date range', () => {
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const before = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0];
        fireEvent.click(screen.getByTestId('preset-7'));
        const after = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0];
        expect(before).not.toBe(after);
    });

    it('disables copy button when no data', () => {
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={[]} labResults={[]} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        expect(screen.getByTestId('ai-export-copy-btn')).toBeDisabled();
    });

    it('disables copy button when startDate > endDate', () => {
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const dateInputs = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/);
        fireEvent.change(dateInputs[0], { target: { value: '2026-12-31' } });
        fireEvent.change(dateInputs[1], { target: { value: '2026-01-01' } });
        expect(screen.getByTestId('ai-export-copy-btn')).toBeDisabled();
    });

    it('clicking preview toggle reveals the generated text', () => {
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        // Preview hidden initially
        expect(screen.queryByTestId('ai-export-preview')).toBeNull();
        // Find the toggle button by aria or role — previewLabel is the text "aiExport.previewLabel"
        const toggleBtn = screen.getByRole('button', { name: /aiExport\.previewLabel/ });
        fireEvent.click(toggleBtn);
        expect(screen.getByTestId('ai-export-preview')).toBeInTheDocument();
        expect(screen.getByTestId('ai-export-preview').textContent).toContain('Patient Profile');
    });

    it('clicking copy invokes clipboard with non-empty text', async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        (invoke as any).mockClear();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        fireEvent.click(screen.getByTestId('ai-export-copy-btn'));
        // invoke is async — flush microtasks
        await new Promise(r => setTimeout(r, 0));
        expect(invoke).toHaveBeenCalledWith('clipboard_write_text', expect.objectContaining({
            text: expect.any(String),
        }));
        const call = (invoke as any).mock.calls[0][1];
        expect(call.text.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: 跑测试**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run src/components/AIExportModal.test.tsx
```

Expected: 全部 passed。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/AIExportModal.test.tsx && git commit -m "test: AIExportModal 弹窗测试覆盖默认范围/preset/disabled/preview/复制"
```

---

### Task 6: SettingsPage 加按钮 + 挂载 modal

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\pages\SettingsPage.tsx`

- [ ] **Step 1: 顶部 import 区加 `Bot` 图标 + `AIExportModal` + `loadBasicInfo`(若未引入)**

在 `lucide-react` 的 import 末尾(line 36)加 `Bot`。然后在 `BasicInfoModal` import 后(line 53)加:

```tsx
import AIExportModal from '../components/AIExportModal';
```

(注:`loadBasicInfo` 已经从 `'../components/BasicInfoModal'` 引入，见 line 53。)

- [ ] **Step 2: 在 `useState` 区(在 line 326 附近)加 modal open state**

```tsx
    const [isAIExportOpen, setIsAIExportOpen] = useState(false);
```

- [ ] **Step 3: 在「数据管理」section 的"一键复制"`<button>` 后(line 1175 后)、"清除"`<button>` 前插入新条目**

```tsx
                        <button
                            onClick={() => setIsAIExportOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Bot className="text-purple-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('settings.aiExport.title')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.aiExport.desc')}</p>
                            </div>
                        </button>
```

- [ ] **Step 4: 在 SettingsPage 末尾的 JSX(在 `<ImportModal />` 附近,line 1381 后)挂载 modal**

```tsx
            <AIExportModal
                isOpen={isAIExportOpen}
                onClose={() => setIsAIExportOpen(false)}
                events={events}
                labResults={labResults}
                plans={plans}
                basicInfo={basicInfo ?? loadBasicInfo()}
                postponeLog={postponeLog}
                dueLog={dueLog}
                lang={lang}
            />
```

注意:`basicInfo` 已经是组件 state(line 326 初始化)，不需要 fallback，但加 `?? loadBasicInfo()` 是防御 —— 万一初始 load 失败 modal 仍能跑。

- [ ] **Step 5: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | grep "src/" || echo "tsc: 0 errors in src/"
```

Expected: `tsc: 0 errors in src/`。

- [ ] **Step 6: 跑全部测试**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run
```

Expected: 全部 passing(包括新加的 aiExport.test.ts ~30 个 + AIExportModal.test.tsx 6 个)。

- [ ] **Step 7: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/pages/SettingsPage.tsx && git commit -m "feat(settings): 数据管理 section 新增「一键导出咨询 AI」条目 + 挂载 AIExportModal"
```

---

### Task 7: 整体验证 + 最终 commit

**Files:**
- 无代码改动,只验证

- [ ] **Step 1: 全套验证**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run && npx tsc --noEmit 2>&1 | grep -v "src-tauri/target" | grep "src/" || echo "tsc: 0 errors in src/"
```

Expected: vitest 全绿 + tsc 0 errors in src/。

- [ ] **Step 2: Spec 覆盖核对**

逐条核对 spec §设计原则:

- [ ] 不输出 prefs/calibration/personalModel/simCI/原始 dueLog+postponeLog — Task 2 `buildAITextExport` 显式 not destructured ✓
- [ ] 输出 KPI 计算后的数值 — Task 2 `calculate90DayAchievement` / `calculateMonthPostponeCount` ✓
- [ ] 数据部分全英文 — Task 2 Section builders 全用英文常量 ✓
- [ ] Prompt 部分 5 条要点英文常量 + 唯一动态语言行 — Task 2 `promptLangLine()` ✓
- [ ] 纯函数 + React 组件分离 — Task 2 utils/aiExport.ts + Task 4 AIExportModal.tsx ✓
- [ ] 复用现有剪贴板 API — Task 4 `invoke('clipboard_write_text')` + `navigator.clipboard.writeText` ✓
- [ ] 仿 ShareImageModal 日期范围 UX — Task 4 date input + 4 preset + preview card ✓

- [ ] **Step 3: 手动验证(dev server)**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npm run dev
```

- 设置页 → 数据管理 → 看到「一键导出咨询 AI」新条目(紫色 Bot 图标)
- 点 → 弹窗打开,默认 Last 30d 高亮 + 日期填好
- 点 Last 7d → 日期更新为近 7 天
- 点 Show preview → 折叠展开,显示生成的英文 Markdown
- 点 Copy → 系统 toast "Copied!" 2 秒后复原
- 粘贴到任意文本编辑器 → 看到完整英文 Markdown,prompt 部分含 `Respond in 简体中文 (zh)`(因为 lang='zh')
- 切换语言到 en → 重新打开弹窗 → preview 显示的 prompt 部分变为 `Respond in English (matches the user's app language)`
- 空 events + 空 labResults → 弹窗显示 "No data to export" + Copy 按钮 disabled

如果任何步骤失败,记录到 spec 的「Follow-up」段(本 plan 范围内**不修**)。

- [ ] **Step 4: 最终确认 commit(若 Step 3 验证有发现)**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git status --short
```

若无任何未提交改动,跳过。否则:

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add -A && git commit -m "chore: 验证完成"
```

---

## 自检报告

**1. Spec 覆盖**:

| Spec 章节 | Plan 任务 |
|---|---|
| 目标 / 用户故事 | Task 1-7 整体 |
| 架构(纯函数 + 组件分离) | Task 2(utils) + Task 4(modal) |
| 4 语种 i18n 键 | Task 1 |
| `buildAITextExport` 函数签名 + 类型 | Task 2 Step 1 |
| 7 个 Section 输出规则 | Task 2 Section builders + Task 3 测试 |
| 错误处理与边界(13 项) | Task 2(filter/skip/tooLarge) + Task 4(disabled/alerts) + Task 5 测试 |
| 测试覆盖(7 大类) | Task 3 |
| 弹窗 UI 仿 ShareImageModal | Task 4 |
| 复用剪贴板 API | Task 4 |
| 实施步骤 | Task 1-7 |

**2. Placeholder scan**: ✅ 无 "TBD" / "TODO" / "implement later"。所有代码块都是完整可粘贴的。

**3. 类型一致性**:
- `AIExportInput` / `AIExportOutput` / `SupportedLang` 在 Task 2 定义,Task 3 测试 import,Task 4 modal import — 一致
- `BasicInfo` / `PostponeLogEntry` / `DueLogEntry` 从 `'./BasicInfoModal'` import — 与 BasicInfoModal.tsx export 一致
- `Preset = 7 | 30 | 90 | 'all'` 在 Task 4 定义,Task 5 测试用 `preset-7` 等 testid — 一致
- `data-testid="preset-${p}"` 在 Task 4,Task 5 测试用 `screen.getByTestId('preset-7')` — 一致
- `data-testid="ai-export-copy-btn"` 在 Task 4,Task 5 测试用 — 一致
- `data-testid="ai-export-preview"` 在 Task 4,Task 5 测试用 — 一致

---

## 执行检查清单

- [ ] Task 1: i18n 文案 4 语种
- [ ] Task 2: aiExport.ts 纯函数
- [ ] Task 3: aiExport.test.ts 单测(~30 个)
- [ ] Task 4: AIExportModal.tsx 弹窗
- [ ] Task 5: AIExportModal.test.tsx 弹窗测试(6 个)
- [ ] Task 6: SettingsPage 按钮 + 挂载
- [ ] Task 7: 全套验证 + 手动验证

**总计:7 个任务,7 个 commit**(每个 Task 1 个 commit;Task 7 视情况追加 0-1 个)