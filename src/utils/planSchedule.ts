import { Ester, Plan, Route } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for plan scheduling + smart-prefill matching. No DOM / no React.
// All times use the user's local Date (no timezone math) — consistent with the
// existing `parseLocalDate` / `toLocalDateStr` convention in BatchDoseModal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drug-class derivation from the Ester enum. Used for UI grouping / colours /
 * pre-fill-aware category strings. E2-E2 family → estrogen, CPA / BICA → anti-androgen.
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
        default:
            return 'other';
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
    const times = plan.schedule.times
        .map(parseHHMM)
        .filter((x): x is { h: number; m: number } => x !== null);
    if (times.length === 0) return [];

    const startDay = startOfLocalDay(from);
    const endDay = startOfLocalDay(to);
    // Cap iterations at 366 days as a safety net against runaway schedules.
    const maxDays = 366;
    const totalDays = Math.min(maxDays, daysBetween(startDay, endDay) + 1);

    for (let i = 0; i < totalDays; i++) {
        const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
        if (!matchesScheduleDay(plan, day)) continue;
        for (const { h, m } of times) {
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

function matchesScheduleDay(plan: Plan, day: Date): boolean {
    switch (plan.schedule.kind) {
        case 'daily':
            return true;
        case 'every_n_days': {
            const interval = plan.schedule.intervalDays;
            if (!Number.isFinite(interval) || interval <= 0) return false;
            const anchor = new Date(plan.startDateH * 3600000);
            const days = daysBetween(anchor, day);
            if (days < 0) return false;
            return days % Math.round(interval) === 0;
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
    const windowMs = toleranceMinutes * 60 * 1000;
    const from = new Date(now.getTime() - Math.max(windowMs, 60 * 60 * 1000));
    const to = new Date(now.getTime() + windowMs);
    const out: Array<{ plan: Plan; scheduledAt: Date; offsetMs: number }> = [];
    for (const plan of plans) {
        if (!plan.enabled) continue;
        const moments = dueMomentsInRange(plan, from, to);
        if (moments.length === 0) continue;
        // Pick the closest moment to `now`.
        let best = moments[0];
        let bestDelta = Math.abs(best.getTime() - now.getTime());
        for (let i = 1; i < moments.length; i++) {
            const d = Math.abs(moments[i].getTime() - now.getTime());
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

/** Returns enabled plans (excluding `candidate.id`) that share `planKey()`. */
export function findConflicts(plans: Plan[], candidate: Plan): Plan[] {
    const candKey = planKey(candidate);
    return plans.filter((p) => p.id !== candidate.id && p.enabled && candidate.enabled && planKey(p) === candKey);
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
            const dayKeys = plan.schedule.weekdays.map((d) => `plan.weekday.${d}`);
            const days = plan.schedule.weekdays
                .map((d, i) => t(dayKeys[i], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] ?? '?'))
                .join(' / ');
            return t('plan.summary.weekly', 'Weekly')
                .replace('{days}', days)
                .replace('{times}', fmtTimes(plan.schedule.times));
        }
    }
}

/** Human-readable preview line used in the plan card subtitle. */
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
    field: 'times' | 'interval' | 'weekdays' | 'startDate' | 'endDate' | 'dose';
    message: string;
}

export function validatePlan(plan: Plan): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    if (!Number.isFinite(plan.doseMG) || plan.doseMG <= 0) {
        errors.push({ field: 'dose', message: 'dose must be > 0' });
    }
    if (plan.schedule.times.length === 0) {
        errors.push({ field: 'times', message: 'at least one time required' });
    }
    for (const t of plan.schedule.times) {
        if (parseHHMM(t) === null) {
            errors.push({ field: 'times', message: `invalid HH:MM "${t}"` });
        }
    }
    switch (plan.schedule.kind) {
        case 'every_n_days':
            if (!Number.isFinite(plan.schedule.intervalDays) || plan.schedule.intervalDays < 1) {
                errors.push({ field: 'interval', message: 'interval must be ≥ 1 day' });
            }
            break;
        case 'weekly':
            if (!plan.schedule.weekdays || plan.schedule.weekdays.length === 0) {
                errors.push({ field: 'weekdays', message: 'pick at least one weekday' });
            }
            break;
    }
    if (plan.endDateH !== undefined && plan.endDateH <= plan.startDateH) {
        errors.push({ field: 'endDate', message: 'endDate must be after startDate' });
    }
    return errors;
}

// Re-export Route so consumers can import it from this single module if they want.
export { Route, Ester };