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

function formatEventLine(e: DoseEvent): string {
    const ms = e.timeH * 3600_000;
    if (!isFinite(ms) || ms < 0) return ''; // skip malformed
    const dt = msToDateTime(ms);
    const route = ROUTE_DISPLAY[e.route] ?? String(e.route);
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