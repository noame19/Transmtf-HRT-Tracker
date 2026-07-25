import type { DoseEvent, LabResult, Plan, Route } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from '../components/BasicInfoModal';

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
    /** Used for "exported at" footnote. */
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
    sublingual: 'Sublingual',
    patchApply: 'Patch (apply)',
    patchRemove: 'Patch (remove)',
};

/** SL_TIER i18n 缩写,见 SublingualTierParams 的 theta。导出时把"快速/随手/标准/严格"
 *  这些标签写给 AI,比一个数字 tier=1 更直观。 */
const SL_TIER_LABEL: Record<number, string> = {
    0: 'quick',
    1: 'casual',
    2: 'standard',
    3: 'strict',
};

/** GEL_SITE 索引 i18n 缩写。必须与 DoseFormModal 的 GEL_SITE_ORDER 一一对应:
 *  0=arm, 1=thigh, 2=scrotal, 3=abdomen。 */
const GEL_SITE_LABEL: Record<number, string> = {
    0: 'arm',
    1: 'thigh',
    2: 'scrotal',
    3: 'abdomen',
};

/** 抽出 route-specific extras 的可读摘要。
 *  - 注射/口服:extras 为空,返回空串
 *  - 舌下:tier=1 或 θ=0.45
 *  - 凝胶:product=N, site=arm, ~750cm²
 *  - 贴片(只有 apply):removes 2026-07-25 22:00 (从 companionGroupId 配对的 remove 事件查)
 */
function formatEventExtrasTail(
    e: DoseEvent,
    pairedPatchRemove: DoseEvent | null,
): string {
    const parts: string[] = [];

    // 舌下:tier 优先,自定义 θ 其次
    if (e.route === 'sublingual') {
        const tier = e.extras['sublingualTier'];
        const theta = e.extras['sublingualTheta'];
        if (typeof tier === 'number' && tier in SL_TIER_LABEL) {
            parts.push(`tier=${tier} (${SL_TIER_LABEL[tier]})`);
        } else if (typeof theta === 'number' && isFinite(theta)) {
            parts.push(`θ=${theta.toFixed(2)}`);
        }
    }

    // 凝胶:产品 + 部位 + 面积
    if (e.route === 'gel') {
        const productId = e.extras['gelProductId'];
        const siteIdx = e.extras['gelSite'];
        const area = e.extras['areaCM2'];
        if (typeof productId === 'number') parts.push(`product=${productId}`);
        if (typeof siteIdx === 'number' && siteIdx in GEL_SITE_LABEL) {
            parts.push(`site=${GEL_SITE_LABEL[siteIdx]}`);
        }
        if (typeof area === 'number' && area > 0) {
            parts.push(`~${Math.round(area)}cm²`);
        }
    }

    // 贴片 apply:从配对的 remove 事件查撕下时间
    if (e.route === 'patchApply' && pairedPatchRemove) {
        const rMs = pairedPatchRemove.timeH * 3600_000;
        if (isFinite(rMs) && rMs > 0) {
            parts.push(`removes ${msToDateTime(rMs)}`);
        }
    }

    return parts.length === 0 ? '' : ` — ${parts.join(', ')}`;
}

/** 在 export 主流程里一次性给每个 patch apply 配对出 remove,避免每行重做查找。
 *  返回 Map<applyId, removeEvent>,apply 没配对则 entry 不存在。 */
function buildPatchRemoveMap(events: DoseEvent[]): Map<string, DoseEvent> {
    const map = new Map<string, DoseEvent>();
    // 先收集所有 patchRemove,按 companionGroupId 反查
    const removesByGroup = new Map<string, DoseEvent>();
    for (const e of events) {
        if (e.route === 'patchRemove' && e.companionGroupId) {
            // 同一 groupId 理论上只有一个 remove,后者覆盖前者即可
            removesByGroup.set(e.companionGroupId, e);
        }
    }
    for (const e of events) {
        if (e.route === 'patchApply' && e.companionGroupId) {
            const rm = removesByGroup.get(e.companionGroupId);
            if (rm) map.set(e.id, rm);
        }
    }
    return map;
}

function formatEventLine(e: DoseEvent, pairedPatchRemove: DoseEvent | null = null): string {
    const ms = e.timeH * 3600_000;
    if (!isFinite(ms) || ms < 0) return ''; // skip malformed
    const dt = msToDateTime(ms);
    const route = ROUTE_DISPLAY[e.route] ?? String(e.route);
    // P0-2 (2026-07-25): 每条记录后都带当条记录自己的 weightKG + heightCm,
    // 不再导一个孤立的"最新身高体重"。doseMG>0 的事件保存兜底保证字段始终正数。
    const bodyStats = `(${e.weightKG} kg, ${e.heightCm ?? '—'} cm)`;
    const tail = formatEventExtrasTail(e, pairedPatchRemove);
    return `- ${dt} | ${route} | ${e.doseMG} mg ${e.ester} ${bodyStats}${tail}`;
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

function formatRangeLabel(start: string, end: string): string {
    if (start === end) return start;
    return `${start} ~ ${end}`;
}

function promptLangLine(lang: SupportedLang): string {
    switch (lang) {
        case 'zh': return 'Respond in 简体中文 (zh)';
        case 'zh-TW': return 'Respond in 正體中文 (zh-TW)';
        case 'ja': return 'Respond in 日本語 (ja)';
        case 'en': return "Respond in English (matches the user's app language)";
    }
}

/** Pull a representative HH:MM from a Plan.schedule. Falls back to 20:00. */
function firstScheduleTime(plan: Plan): string {
    const first = plan.schedule.times[0];
    if (typeof first === 'string' && /^\d{2}:\d{2}$/.test(first)) return first;
    return '20:00';
}

/** Friendly summary of a Plan's schedule. e.g. "Every 5d", "Daily", "Weekly (Mon, Wed)". */
function planScheduleSummary(plan: Plan): string {
    const s = plan.schedule;
    if (s.kind === 'daily') return 'Daily';
    if (s.kind === 'every_n_days') return `Every ${s.intervalDays}d`;
    // weekly — names of weekdays
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const list = s.weekdays.map(d => names[d]).join(', ');
    return `Weekly (${list})`;
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
            const route = ROUTE_DISPLAY[p.route] ?? String(p.route);
            const summary = planScheduleSummary(p);
            const time = firstScheduleTime(p);
            out.push(`- ${p.ester} | ${route} | ${p.doseMG} mg | ${summary} at ${time}`);
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
    // P2-2 (2026-07-25): 在 log 顶部加一行 "in range / total" 上下文,
    // 让 AI 知道是用户筛错了范围,还是范围内真的没数据。
    const totalEventCount = (events ?? []).length;
    out.push(`- Events in range: ${eventsInRange.length} (of ${totalEventCount} total)`);
    if (eventsInRange.length === 0) {
        out.push('No doses recorded in this date range.');
    } else {
        const patchRemoveMap = buildPatchRemoveMap(events ?? []);
        for (const e of eventsInRange) {
            const line = formatEventLine(e, patchRemoveMap.get(e.id) ?? null);
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
    const totalLabCount = (labResults ?? []).length;
    out.push(`- Labs in range: ${labsInRange.length} (of ${totalLabCount} total)`);
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