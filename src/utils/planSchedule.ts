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