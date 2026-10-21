import { Ester, ExtraKey, Plan, PlanSchedule, Route } from '../lib/types';

/**
 * A patch plan may carry its strength either as a total dose (`doseMG > 0`,
 * the classic "patch releases X mg over its lifetime" figure) or as a release
 * rate (`extras.releaseRateUGPerDay > 0`, which is what the box usually
 * prints and what most people actually copy down). Exactly one of the two is
 * required — never both, never neither.
 *
 * Records already worked this way (`DoseFormModal` stores `doseMG: 0` plus a
 * rate in `extras`). Plans did not, so a rate-only plan failed validation with
 * "dose must be > 0" and could never be saved. This helper is the single
 * source of truth for "is this plan's strength specified?" so the validator,
 * the card subtitle and the editor can't drift apart.
 */
export function planReleaseRate(plan: Pick<Plan, 'route' | 'extras'>): number {
    const raw = plan.extras?.[ExtraKey.releaseRateUGPerDay];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** True when the plan is a patch whose strength is expressed as µg/day only. */
export function isRateOnlyPlan(plan: Pick<Plan, 'route' | 'doseMG' | 'extras'>): boolean {
    return plan.route === Route.patchApply && planReleaseRate(plan) > 0 && !(plan.doseMG > 0);
}

/**
 * Bounds for `every_n_days` interval. The lower bound is 0.5 rather than a
 * number close to 0 so that a mis-typed "0.05" cannot quietly turn a plan
 * into a near-continuous drip. The upper bound is 365 days: long-acting
 * depots (estradiol undecylate, EU_DEPOT_PK t½ ≈ 35 d) are legitimately dosed
 * every couple of months, and `dueMomentsInRange` already caps its day scan
 * at 366 days, so anything beyond that could never produce a moment anyway.
 *
 * Fractions are deliberately allowed (1.5 or 3.5 days is a real regimen),
 * see `matchesScheduleDay` for how a fractional period maps onto calendar
 * days.
 */
export const MIN_INTERVAL_DAYS = 0.5;
export const MAX_INTERVAL_DAYS = 365;

/** Smallest meaningful patch release rate, in µg/day. Transdermal patches are
 *  dosed in whole µg/day (25 / 50 / 100 …) so the floor only exists to keep a
 *  stray "0" or negative out. Kept here next to the other plan bounds so the
 *  editor input's `min`, the validator and `planReleaseRate` can't drift. */
export const MIN_PATCH_RATE = 0.1;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for plan scheduling + smart-prefill matching. No DOM / no React.
// All times use the user's local Date (no timezone math) — consistent with the
// existing `parseLocalDate` / `toLocalDateStr` convention in BatchDoseModal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drug-class derivation from the Ester enum. Used for UI grouping / colours /
 * pre-fill-aware category strings. E2 family → estrogen, CPA / BICA →
 * anti-androgen. PRL (and other legacy string-cast values) → progestin via
 * the string-equality fallback inside the default branch — they're not in
 * the enum today but show up in serialized legacy data and must keep their
 * semantically correct colour in the heatmap.
 */
export function drugCategoryOf(ester: Ester): 'estrogen' | 'anti_androgen' | 'progestin' | 'other' {
    switch (ester) {
        case Ester.E2:
        case Ester.EB:
        case Ester.EV:
        case Ester.EC:
        case Ester.EN:
        case Ester.EU:
            return 'estrogen';
        case Ester.CPA:
        case Ester.BICA:
            return 'anti_androgen';
        case Ester.PROG:
            // Progesterone (黄体酮) — owns the 'progestin' heatmap bucket
            // (#F59E0B amber, predefined). Listed explicitly so the enum
            // member takes precedence over the string-equality fallback below
            // (which only exists for legacy / non-enum values).
            return 'progestin';
        default: {
            // Fallback for string-cast values outside the enum (PRL,
            // Progesterone, …). Keep this in sync with the palette keys in
            // `heatmapData.ts → HEATMAP_COLOR_BY_CATEGORY`.
            const s = String(ester);
            if (s === 'PRL' || s === 'Progesterone') return 'progestin';
            return 'other';
        }
    }
}

/** Stable identity for the "physical drug" so the conflict rule treats e.g. EV IM
 *  and EV oral as the same drug (just different routes). */
export function planKey(p: Pick<Plan, 'ester' | 'route'>): string {
    return `${p.ester}:${p.route}`;
}

/** Parse `HH:MM` into [hours, minutes] in local time. Returns null on bad input. */
function parseHHMM(s: string): { h: number; m: number } | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
        return null;
    }
    return { h, m: min };
}

/** Build a local-time Date at the given Y/M/D + HH:MM. */
function localDateAt(y: number, month: number, d: number, h: number, m: number): Date {
    const out = new Date(y, month, d, h, m, 0, 0);
    return out;
}

/** Strip time-of-day from a Date, leaving local-midnight. */
function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Days between two local-midnights (positive if b > a). */
function daysBetween(a: Date, b: Date): number {
    const A = startOfLocalDay(a).getTime();
    const B = startOfLocalDay(b).getTime();
    return Math.round((B - A) / 86400000);
}

/** True if the plan's schedule window is open at `at`. */
function isInDateWindow(plan: Plan, at: Date): boolean {
    const tH = at.getTime() / 3600000;
    if (tH < plan.startDateH) return false;
    if (plan.endDateH !== undefined && tH > plan.endDateH) return false;
    return true;
}

/**
 * Returns every moment at which this plan is "due" in the half-open range
 * [from, to]. Each emitted Date is at the exact local-clock time of the dose
 * (NOT yet offset by leadMinutes — apply that at the call site so this helper
 * stays purely declarative about the schedule itself).
 *
 * Used by:
 *   - Rust NotificationScheduler (after we subtract leadMinutes per plan)
 *   - ReminderBanner for "next 7 days of upcoming doses" previews
 */
export function dueMomentsInRange(plan: Plan, from: Date, to: Date): Date[] {
    if (!plan.enabled) return [];
    const out: Date[] = [];
    if (parseTimes(plan.schedule.times).length === 0) {
        // A weekly plan may take all of its times from the per-weekday
        // overlay, so an empty shared `times` is not automatically fatal.
        const hasOverlay = plan.schedule.kind === 'weekly' &&
            Object.values(plan.schedule.timesByWeekday ?? {}).some((ts) => (ts ?? []).length > 0);
        if (!hasOverlay) return [];
    }

    const startDay = startOfLocalDay(from);
    const endDay = startOfLocalDay(to);
    // Cap iterations at 366 days as a safety net against runaway schedules.
    const maxDays = 366;
    const totalDays = Math.min(maxDays, daysBetween(startDay, endDay) + 1);

    for (let i = 0; i < totalDays; i++) {
        const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
        if (!matchesScheduleDay(plan, day)) continue;
        for (const { h, m } of timesOnDay(plan.schedule, day)) {
            const moment = localDateAt(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
            // Skip moments outside [from, to) or before startDate / after endDate.
            if (moment < from) continue;
            if (moment >= to) continue;
            if (!isInDateWindow(plan, moment)) continue;
            out.push(moment);
        }
    }
    return out;
}

function parseTimes(raw: string[]): Array<{ h: number; m: number }> {
    return raw
        .map(parseHHMM)
        .filter((x): x is { h: number; m: number } => x !== null);
}

/**
 * The dose times that apply on `day`.
 *
 * `daily` / `every_n_days` always use the shared `schedule.times`. `weekly`
 * consults the optional per-weekday overlay first (see `PlanSchedule`'s doc
 * comment) so e.g. Monday 21:00 and Wednesday 09:00 can coexist in one plan.
 */
function timesOnDay(schedule: PlanSchedule, day: Date): Array<{ h: number; m: number }> {
    if (schedule.kind === 'weekly') {
        const override = schedule.timesByWeekday?.[day.getDay()];
        if (override && override.length > 0) return parseTimes(override);
    }
    return parseTimes(schedule.times);
}

function matchesScheduleDay(plan: Plan, day: Date): boolean {
    switch (plan.schedule.kind) {
        case 'daily':
            return true;
        case 'every_n_days': {
            const interval = plan.schedule.intervalDays;
            if (!Number.isFinite(interval) || interval <= 0) return false;
            const anchor = startOfLocalDay(new Date(plan.startDateH * 3600000));
            const days = daysBetween(anchor, day);
            if (days < 0) return false;
            // Fractional intervals (e.g. 3.5 days) cannot be expressed as
            // `days % interval` — a modulo only has 0/1 as its answer while a
            // fractional period puts the k-th dose *between* two calendar
            // days. Project the day onto the nearest occurrence index instead:
            //
            //   n = round(days / interval)        → which dose is this?
            //   round(n * interval)               → the day it lands on
            //
            // For integer intervals this reduces to `days % interval === 0`
            // exactly (round() is the identity on integers), so existing
            // integer plans keep their current schedule bit-for-bit. For
            // fractional intervals the day offsets alternate between the two
            // neighbouring integers, e.g. interval=3.5 starting at day 0 →
            // days 0, 4, 7, 11, 14 … (gaps 4/3/4/3, average 3.5) and
            // interval=1.5 → days 0, 2, 3, 5, 6, 8 … (gaps 2/1/2/1, avg 1.5).
            const n = Math.round(days / interval);
            return Math.abs(days - Math.round(n * interval)) < 1e-6;
        }
        case 'weekly': {
            if (!plan.schedule.weekdays || plan.schedule.weekdays.length === 0) return false;
            return plan.schedule.weekdays.includes(day.getDay());
        }
    }
}

/** Next moment ≥ `from` at which the plan is due. Returns null if past endDate
 *  or schedule can't produce one (e.g. invalid). */
export function nextDueAfter(plan: Plan, from: Date): Date | null {
    const horizon = new Date(from.getTime() + 366 * 86400000);
    const moments = dueMomentsInRange(plan, from, horizon);
    return moments.length > 0 ? moments[0] : null;
}

/** True iff `at` is within ±toleranceMinutes of a scheduled due moment for `plan`. */
export function isDueAt(plan: Plan, at: Date, toleranceMinutes: number): boolean {
    if (!plan.enabled) return false;
    const windowMs = toleranceMinutes * 60 * 1000;
    // Look back 1h (to catch prior missed moments) and forward 1h.
    const from = new Date(at.getTime() - Math.max(windowMs, 60 * 60 * 1000));
    const to = new Date(at.getTime() + Math.max(windowMs, 60 * 60 * 1000));
    const moments = dueMomentsInRange(plan, from, to);
    for (const m of moments) {
        if (Math.abs(m.getTime() - at.getTime()) <= windowMs) return true;
    }
    return false;
}

/** Find every plan whose schedule has a moment within ±toleranceMinutes of `now`.
 *  Sorted by absolute offset ascending. Each plan appears at most once (the
 *  closest matching moment). */
export function matchPlansForNow(
    plans: Plan[],
    now: Date,
    toleranceMinutes: number,
): Array<{ plan: Plan; scheduledAt: Date }> {
    // Defensive: accept anything Date-like (number = epoch ms, string = ISO).
    // The type signature says Date, but a stale HMR closure or a JSON-rehydrated
    // deep-link payload can hand us a number — falling back to "now" is safer
    // than throwing mid-click on the "+新增用药" button.
    const nowMs: number = now instanceof Date
        ? now.getTime()
        : Number(now) || Date.now();
    const windowMs = toleranceMinutes * 60 * 1000;
    const from = new Date(nowMs - Math.max(windowMs, 60 * 60 * 1000));
    const to = new Date(nowMs + windowMs);
    const out: Array<{ plan: Plan; scheduledAt: Date; offsetMs: number }> = [];
    for (const plan of plans) {
        if (!plan.enabled) continue;
        const moments = dueMomentsInRange(plan, from, to);
        if (moments.length === 0) continue;
        // Pick the closest moment to `now`.
        let best = moments[0];
        let bestDelta = Math.abs(best.getTime() - nowMs);
        for (let i = 1; i < moments.length; i++) {
            const d = Math.abs(moments[i].getTime() - nowMs);
            if (d < bestDelta) {
                best = moments[i];
                bestDelta = d;
            }
        }
        if (bestDelta <= windowMs) {
            out.push({ plan, scheduledAt: best, offsetMs: bestDelta });
        }
    }
    out.sort((a, b) => a.offsetMs - b.offsetMs);
    return out.map(({ plan, scheduledAt }) => ({ plan, scheduledAt }));
}

/** Returns enabled plans (excluding `candidate.id`) that share `candidate`'s
 *  drug category (estrogen / anti_androgen / …). The conflict rule is "one
 *  enabled plan per drug category at a time" — having two enabled estrogen
 *  plans (e.g. EV IM + EB oral) is rejected because the user can only be on one
 *  estrogen regimen at a time. Cross-category pairs (EV + CPA) are allowed. */
export function findConflicts(plans: Plan[], candidate: Plan): Plan[] {
    const candCategory = drugCategoryOf(candidate.ester);
    return plans.filter(
        (p) => p.id !== candidate.id && p.enabled && candidate.enabled && drugCategoryOf(p.ester) === candCategory,
    );
}

/**
 * Enforce the "one enabled plan per drug category" invariant on an arbitrary
 * list (most importantly, a list loaded from localStorage where the user may
 * have manually edited JSON or a cloud-sync round-trip inserted a stale row).
 *
 * Strategy: for each drug category, if more than one plan is enabled, keep
 * the one with the LATEST `updatedAtH` and disable the rest. Returns the same
 * array reference when the input already satisfies the invariant (so the
 * caller can cheaply check `result === input` to detect dirty data).
 *
 * Pure / synchronous / deterministic — safe to call on the React render path.
 */
export function sanitizePlansForConflict(plans: Plan[]): Plan[] {
    const enabledByCategory = new Map<ReturnType<typeof drugCategoryOf>, Plan[]>();
    for (const p of plans) {
        if (!p.enabled) continue;
        const cat = drugCategoryOf(p.ester);
        const bucket = enabledByCategory.get(cat);
        if (bucket) bucket.push(p);
        else enabledByCategory.set(cat, [p]);
    }

    const keepIds = new Set<string>();
    for (const [cat, group] of enabledByCategory) {
        if (group.length === 1) {
            keepIds.add(group[0].id);
            continue;
        }
        // 2+ enabled in same category → deterministic tiebreaker: most recent.
        const sorted = [...group].sort((a, b) => b.updatedAtH - a.updatedAtH);
        keepIds.add(sorted[0].id);
        // eslint-disable-next-line no-console
        console.warn(
            `[plans] loaded localStorage had ${group.length} enabled ${cat} plans ` +
            `(${group.map((p) => p.label || p.id).join(', ')}); ` +
            `keeping most-recently-updated "${sorted[0].label || sorted[0].id}", ` +
            `auto-disabling the rest.`,
        );
    }

    let touched = false;
    const out = plans.map((p) => {
        if (!p.enabled) return p;
        if (keepIds.has(p.id)) return p;
        touched = true;
        return { ...p, enabled: false };
    });
    return touched ? out : plans;
}

/**
 * Compute-time fallback for dirty state: pick the "primary" enabled plan in a
 * given drug category. Returns the most-recently-updated enabled plan (or null
 * if none). Logs a warning when >1 plan qualifies — sanitize should have
 * prevented this on load, but a runtime race (cloud-sync / manual toggle that
 * lost the wrapper fight) can still slip through.
 */
export function pickPrimaryEnabledPlan(plans: Plan[], category: ReturnType<typeof drugCategoryOf>): Plan | null {
    const candidates = plans.filter((p) => p.enabled && drugCategoryOf(p.ester) === category);
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
        // eslint-disable-next-line no-console
        console.warn(
            `[plans] compute-time defensive fallback: ${candidates.length} enabled ${category} plans; ` +
            `using most-recently-updated. Run sanitizePlansForConflict if this keeps appearing.`,
        );
    }
    return [...candidates].sort((a, b) => b.updatedAtH - a.updatedAtH)[0];
}

/** Friendly schedule summary, e.g. "每 5 天 20:00" / "每日 09:00 / 21:00".
 *  `t` is a translation lookup (zh / en / zh-TW / ja) provided by the caller. */
export function summarizeSchedule(plan: Plan, t: (k: string, fallback?: string) => string): string {
    const fmtTimes = (times: string[]): string =>
        times.length === 1 ? times[0] : times.join(' / ');
    switch (plan.schedule.kind) {
        case 'daily':
            if (plan.schedule.times.length === 1) {
                return t('plan.summary.daily_one', 'Daily').replace('{time}', plan.schedule.times[0]);
            }
            return t('plan.summary.daily_multi', 'Daily')
                .replace('{times}', fmtTimes(plan.schedule.times));
        case 'every_n_days': {
            const i = plan.schedule.intervalDays;
            return t('plan.summary.every_n_days', `Every ${i} days`)
                .replace('{n}', String(i))
                .replace('{times}', fmtTimes(plan.schedule.times));
        }
        case 'weekly': {
            const schedule = plan.schedule;
            const dayLabel = (d: number) =>
                t(`plan.weekday.${d}`, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] ?? '?');
            // When every selected weekday shares the same times we keep the
            // compact "Mon / Thu 11:00" form. As soon as the per-weekday
            // overlay makes them differ, each day gets its own times so the
            // card can't imply that Monday is also dosed at Wednesday's hour.
            const perDay = schedule.weekdays.map((d) => fmtTimes(
                schedule.timesByWeekday?.[d]?.length ? schedule.timesByWeekday[d] as string[] : schedule.times,
            ));
            const distinct = new Set(perDay);
            if (distinct.size <= 1) {
                return t('plan.summary.weekly', 'Weekly')
                    .replace('{days}', schedule.weekdays.map(dayLabel).join(' / '))
                    .replace('{times}', perDay[0] ?? '');
            }
            const joined = schedule.weekdays
                .map((d, i) => `${dayLabel(d)} ${perDay[i]}`)
                .join(' · ');
            return t('plan.summary.weekly_per_day', '{days}')
                .replace('{days}', joined)
                .replace('{times}', '');
        }
    }
}

/** Human-readable preview line used in the plan card subtitle. */
/**
 * Human-readable dose for a plan card / banner / reminder title.
 *
 * A patch plan that only carries a release rate has `doseMG === 0` on purpose
 * (the PK engine doses from `rateMGh`, not from a bolus). Rendering
 * `${plan.doseMG} mg` for those produced a literal "剂量 0 mg" on every
 * surface — technically true, completely wrong to read.
 *
 * Returns e.g. `"100 µg/d"` for rate-only patches and `"6.25 mg"` otherwise.
 * Callers should append `t('plan.card.dose_unit')` themselves when they want
 * the "剂量" prefix.
 */
export function formatPlanDose(plan: Pick<Plan, 'route' | 'doseMG' | 'extras'>): string {
    const rate = planReleaseRate(plan);
    if (rate > 0 && isRateOnlyPlan(plan)) return `${parseFloat(rate.toFixed(3))} µg/d`;
    if (rate > 0) {
        // Legacy rows carry both a mg dose and a rate (they were written by an
        // older editor that showed both fields). The mg value is what the PK
        // engine prefers there, so show it but keep the rate visible.
        const mg = Number.isFinite(plan.doseMG) ? parseFloat(plan.doseMG.toFixed(3)) : 0;
        return `${mg} mg · ${parseFloat(rate.toFixed(3))} µg/d`;
    }
    const mg = Number.isFinite(plan.doseMG) ? parseFloat(plan.doseMG.toFixed(3)) : 0;
    return `${mg} mg`;
}

export function planSubtitle(plan: Plan, t: (k: string, fallback?: string) => string): string {
    const sched = summarizeSchedule(plan, t);
    const next = nextDueAfter(plan, new Date());
    const nextStr = next
        ? t('plan.next', 'Next').replace('{when}', formatLocalDateTime(next, t))
        : '';
    return nextStr ? `${sched} · ${nextStr}` : sched;
}

function formatLocalDateTime(d: Date, _t: (k: string, fallback?: string) => string): string {
    // Lightweight local-time formatter — the host page can replace this with
    // `formatDate` / `formatTime` if it wants full i18n.
    const pad = (n: number) => n < 10 ? '0' + n : String(n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers used by PlanEditModal before save.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanValidationError {
    field: 'times' | 'interval' | 'weekdays' | 'startDate' | 'endDate' | 'dose' | 'leadMinutes';
    /** 英文 fallback —— 用于翻译缺失时直接展示,也方便 vitest 断言。 */
    message: string;
    /** i18n 翻译键（plan.error.*）。调用方用 `t(key, message)` 翻译。 */
    messageKey: string;
    /** 需要替换的占位符(形如 `{time}`)。调用方遍历 .replace。无占位符时可省略。 */
    params?: Record<string, string>;
}

export function validatePlan(plan: Plan): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    // 贴片计划的「强度」可以用总剂量（mg）或释放速率（µg/d）任一表达，
    // 两者都没有才算错。之前一律要求 doseMG > 0，导致只填速率的贴片计划
    // 永远存不下去（UI 在 rate 模式下还不渲染剂量输入框，直接无解）。
    const rateOnly = isRateOnlyPlan(plan);
    if (!Number.isFinite(plan.doseMG) || (plan.doseMG <= 0 && !rateOnly)) {
        errors.push({
            field: 'dose',
            message: 'dose must be > 0 (or a release rate for patch plans)',
            messageKey: 'plan.error.dose_invalid',
        });
    }
    // 提前提醒分钟数必须落在 [0, 30]：上限受「该用药了」弹窗 on_time 窗口 due-30min 约束，
    // 超过 30 分钟的提前通知会让用户进 app 时弹窗已经关了。
    if (!Number.isFinite(plan.leadMinutes) || plan.leadMinutes < 0 || plan.leadMinutes > 30) {
        errors.push({
            field: 'leadMinutes',
            message: 'leadMinutes must be in [0, 30]',
            messageKey: 'plan.error.lead_invalid',
        });
    }
    if (plan.schedule.times.length === 0) {
        errors.push({
            field: 'times',
            message: 'at least one time required',
            messageKey: 'plan.error.times_required',
        });
    }
    for (const t of plan.schedule.times) {
        if (parseHHMM(t) === null) {
            errors.push({
                field: 'times',
                message: `invalid HH:MM "${t}"`,
                messageKey: 'plan.error.invalid_time',
                params: { time: t },
            });
        }
    }
    switch (plan.schedule.kind) {
        case 'every_n_days':
            // 小数周期（如 1.5 / 3.5 天）现已支持；上限 365 天是为了不让
            // dueMomentsInRange / Kotlin 通知调度白撞 366 天循环。
            if (
                !Number.isFinite(plan.schedule.intervalDays) ||
                plan.schedule.intervalDays < MIN_INTERVAL_DAYS ||
                plan.schedule.intervalDays > MAX_INTERVAL_DAYS
            ) {
                errors.push({
                    field: 'interval',
                    message: `interval must be in [${MIN_INTERVAL_DAYS}, ${MAX_INTERVAL_DAYS}] days`,
                    messageKey: 'plan.error.interval_invalid',
                });
            }
            break;
        case 'weekly':
            if (!plan.schedule.weekdays || plan.schedule.weekdays.length === 0) {
                errors.push({
                    field: 'weekdays',
                    message: 'pick at least one weekday',
                    messageKey: 'plan.error.weekdays_required',
                });
            }
            break;
    }
    if (plan.endDateH !== undefined && plan.endDateH <= plan.startDateH) {
        errors.push({
            field: 'endDate',
            message: 'endDate must be after startDate',
            messageKey: 'plan.error.end_after_start',
        });
    }
    return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Next-due formatting for the home / overview cards.
//
// Style rules:
//   - today        → "今天"
//   - +1 day       → "明天"
//   - +2 days      → "后天"
//   - this week    → "本周X"     (only when due day-of-week is in current Mon-Sun block
//                                 and diff ≥ 3 days, so we don't collide with 今天/明天/后天)
//   - next week    → "下周X"
//   - 2+ weeks out → exact date ("7月12日" / "Jul 12" etc.)
//
// The caller passes `t` so we can delegate the week-day token (`周一` / `Mon` /
// `週一` / `月`) to the existing i18n keys `plan.weekday.{0..6}` and the relative
// phrases to dedicated `overview.due.*` keys. Pure function — no React / DOM.
// ─────────────────────────────────────────────────────────────────────────────

const ZH_CJK = ['zh', 'zh-CN', 'zh-TW', 'ja'] as const;

function isCjk(lang: string): boolean {
    return (ZH_CJK as readonly string[]).includes(lang);
}

/** Monday-of-today's calendar week (zh/CN/TW/JP convention). */
function startOfIsoWeek(d: Date): Date {
    const dow = d.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    // Days to subtract to land on Monday: Sun→1, Mon→0, Tue→6, ... Sat→2
    const offsetToMonday = (dow + 6) % 7;
    const monday = startOfLocalDay(d);
    monday.setDate(monday.getDate() - offsetToMonday);
    return monday;
}

/**
 * Format a `due` Date as a relative phrase understood by the user.
 *
 * @param due  Next-scheduled dose moment (already in user's local tz)
 * @param now  Current time (also local)
 * @param t    i18n function: `t(key)` or `t(key, fallback)` returns the string
 * @param lang Current UI language (`zh` | `en` | `zh-TW` | `ja`)
 *
 * Returns:
 *   - `今天` / `Tomorrow` / `今日` / `明日` etc. for 0..2 days
 *   - `本周X` / `next Mon` / etc. when due falls inside current Mon-Sun week
 *   - `下周X` / etc. when due falls inside next Mon-Sun week
 *   - `7月12日` (CJK) or `Jul 12` (en) when due is ≥ 2 weeks out
 */
export function formatNextDue(due: Date, now: Date, t: (key: string, fallback?: string) => string, lang: string): string {
    const todayStart = startOfLocalDay(now);
    const dueStart = startOfLocalDay(due);
    const dayDiff = daysBetween(todayStart, dueStart);

    if (dayDiff === 0) return t('overview.due.today', '今天');
    if (dayDiff === 1) return t('overview.due.tomorrow', '明天');
    if (dayDiff === 2) return t('overview.due.day_after', '后天');

    const dow = due.getDay(); // 0=Sun..6=Sat
    const wkLabel = t(`plan.weekday.${dow}`); // localized weekday token

    // Compute Monday boundaries for this week, next week, and the week after.
    const thisWeekStart = startOfIsoWeek(todayStart);
    const nextWeekStart = new Date(thisWeekStart);
    nextWeekStart.setDate(thisWeekStart.getDate() + 7);
    const weekAfterStart = new Date(thisWeekStart);
    weekAfterStart.setDate(thisWeekStart.getDate() + 14);

    if (dueStart >= thisWeekStart && dueStart < nextWeekStart) {
        return t('overview.due.this_weekday', '本周{day}').replace('{day}', wkLabel);
    }
    if (dueStart >= nextWeekStart && dueStart < weekAfterStart) {
        return t('overview.due.next_weekday', '下周{day}').replace('{day}', wkLabel);
    }

    // ≥ 2 weeks out → exact date. CJK numerals, English short month name.
    if (isCjk(lang)) {
        const m = due.getMonth() + 1;
        const d = due.getDate();
        return t('overview.due.exact', '{m}月{d}日').replace('{m}', String(m)).replace('{d}', String(d));
    }
    // Use Intl.DateTimeFormat for English (and any future locale). Falls back
    // to "M/D" if the locale token somehow has no parser.
    try {
        return new Intl.DateTimeFormat(lang || 'en-US', { month: 'short', day: 'numeric' }).format(due);
    } catch {
        return `${due.getMonth() + 1}/${due.getDate()}`;
    }
}

// Re-export Route so consumers can import it from this single module if they want.
export { Route, Ester };