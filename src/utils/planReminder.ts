import { DoseEvent, Plan, Route } from '../../types';
import { dueMomentsInRange } from './planSchedule';
import { canonicalComplianceRoute } from './planCompliance';

// ── Defaults ──────────────────────────────────────────────────────────────

/** Tolerance window for "is this due moment 'now'?" — the banner shows when
 *  current time is within ±this many minutes of a scheduled due moment.
 *  Defaults to ±1h per UX decision: narrow enough that the user is not
 *  reminded 3 hours early (when they can't realistically act on it) but
 *  wide enough to forgive a small delay on either side of due. */
export const PLAN_REMINDER_TOLERANCE_MIN = 60;

/** Threshold past due for the state to flip from 'on_time' to 'late'.
 *  Once now - due exceeds this many minutes, the "已过服药时间" window
 *  takes over from the "该吃药了" window. */
export const PLAN_REMINDER_LATE_START_MIN = 60;

/** Past-due banner auto-dismiss threshold: if a due moment is more than this
 *  many hours in the past AND the user hasn't acted, stop nagging. The user
 *  is presumed to have either skipped intentionally or moved on; either way
 *  a stale banner becomes visual noise. Synonym kept for backward
 *  compatibility with the public API. */
export const PLAN_REMINDER_LATE_END_HOURS = 5;
/** @deprecated Use `PLAN_REMINDER_LATE_END_HOURS` instead. Retained for any
 *  external callers that still reference the old name. */
export const PLAN_REMINDER_AUTO_DISMISS_HOURS = PLAN_REMINDER_LATE_END_HOURS;

// ── Matching ──────────────────────────────────────────────────────────────

/**
 * Is there an existing DoseEvent that "satisfies" the given due moment?
 *
 * Match criteria (all three):
 *   1. Time within ±toleranceMin of `due` (so users can record slightly
 *      early/late and still satisfy the plan).
 *   2. Same ester (so CPA cannot satisfy an EV plan).
 *   3. Same canonical route (so oral / sublingual are interchangeable, same
 *      as the compliance check).
 *
 * We intentionally do NOT compare doseMG: a user who records a half-dose
 * for legitimate reasons still satisfies the "I took this" intent, and the
 * compliance banner is the right place to surface dosing deviations.
 */
export function hasMatchingEvent(
    plan: Pick<Plan, 'ester' | 'route'>,
    due: Date,
    events: DoseEvent[],
    toleranceMin: number = PLAN_REMINDER_TOLERANCE_MIN,
): boolean {
    const planRoute = canonicalComplianceRoute(plan.route);
    const dueMs = due.getTime();
    const tolMs = toleranceMin * 60 * 1000;
    for (const e of events) {
        if (e.ester !== plan.ester) continue;
        if (canonicalComplianceRoute(e.route) !== planRoute) continue;
        const evMs = e.timeH * 3600000;
        if (Math.abs(evMs - dueMs) <= tolMs) return true;
    }
    return false;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface DueReminder {
    plan: Plan;
    /** The scheduled moment this reminder is about (NOT the reminder's lead-
     *  adjusted fire time). */
    due: Date;
}

/**
 * Find every "due moment" within ±toleranceMin of `now` that the user hasn't
 * already satisfied via a DoseEvent.
 *
 * Powers the in-app ReminderBanner — drives it from **plans + history**,
 * NOT from the Android notification's pending-reminder SharedPreferences.
 * That decoupling means the banner shows up correctly regardless of whether
 * the user got here via a notification tap or by opening the app directly.
 *
 * Returns at most one entry per plan (the closest due moment). Sorted by
 * proximity to `now` so callers can just take [0] for "the most relevant
 * reminder" without re-sorting.
 */
export function findDueReminders(
    plans: Plan[],
    events: DoseEvent[],
    now: Date,
    toleranceMin: number = PLAN_REMINDER_TOLERANCE_MIN,
): DueReminder[] {
    const from = new Date(now.getTime() - toleranceMin * 60 * 1000);
    const to = new Date(now.getTime() + toleranceMin * 60 * 1000);
    const out: DueReminder[] = [];
    for (const p of plans) {
        if (!p.enabled) continue;
        const dues = dueMomentsInRange(p, from, to);
        if (dues.length === 0) continue;
        // Pick the closest due moment to now (earliest positive or latest
        // past — whichever is nearer). Multiple matches within the window
        // are unusual but possible (e.g. daily plan with multiple times).
        let closest = dues[0];
        let bestGap = Math.abs(closest.getTime() - now.getTime());
        for (let i = 1; i < dues.length; i++) {
            const gap = Math.abs(dues[i].getTime() - now.getTime());
            if (gap < bestGap) {
                closest = dues[i];
                bestGap = gap;
            }
        }
        if (!hasMatchingEvent(p, closest, events, toleranceMin)) {
            out.push({ plan: p, due: closest });
        }
    }
    out.sort((a, b) => {
        return Math.abs(a.due.getTime() - now.getTime())
             - Math.abs(b.due.getTime() - now.getTime());
    });
    return out;
}

/** Classify a due moment relative to "now". `on_time` covers everything
 *  up to `PLAN_REMINDER_LATE_START_MIN` past due, after which we flip to
 *  `late` ("已过服药时间"). The boundary deliberately uses the configured
 *  late-start threshold so callers and UI agree on the exact transition. */
export function classifyDueState(due: Date, now: Date): 'on_time' | 'late' {
    const lateStartMs = PLAN_REMINDER_LATE_START_MIN * 60 * 1000;
    return now.getTime() - due.getTime() > lateStartMs ? 'late' : 'on_time';
}

/** True iff a due moment is so far in the past that the banner should
 *  stop showing it. Used to drop stale reminders from the UI. */
export function isDueReminderStale(
    due: Date,
    now: Date,
    autoDismissHours: number = PLAN_REMINDER_LATE_END_HOURS,
): boolean {
    const ageMs = now.getTime() - due.getTime();
    if (ageMs <= 0) return false;
    return ageMs > autoDismissHours * 60 * 60 * 1000;
}

// ── Virtual records ───────────────────────────────────────────────────────

export interface VirtualRecord {
    plan: Plan;
    /** The scheduled moment this virtual record represents. */
    due: Date;
}

/**
 * Find every "due moment" within ±toleranceMin of `now` that the user
 * hasn't already satisfied via a DoseEvent.
 *
 * Sibling of `findDueReminders` but designed for the *list* surface:
 * `findDueReminders` returns at most one reminder per plan (drives the
 * modal); `findVirtualRecords` returns all in-window unsatisfied dues,
 * so the /history list can render one semi-transparent row per
 * unsatisfied due moment the user could plausibly confirm.
 *
 * The user's UX contract:
 *   - If a real record already exists within the window, suppress the
 *     virtual row (the user took it; nothing to confirm).
 *   - The modal + notification are the primary affordance; the virtual
 *     row is just a second chance for users who ignored those and
 *     scrolled back to history.
 */
export function findVirtualRecords(
    plans: Plan[],
    events: DoseEvent[],
    now: Date,
    toleranceMin: number = PLAN_REMINDER_TOLERANCE_MIN,
    ignored: ReadonlySet<string> = new Set(),
): VirtualRecord[] {
    const from = new Date(now.getTime() - toleranceMin * 60 * 1000);
    const to = new Date(now.getTime() + toleranceMin * 60 * 1000);
    const out: VirtualRecord[] = [];
    for (const p of plans) {
        if (!p.enabled) continue;
        const dues = dueMomentsInRange(p, from, to);
        for (const due of dues) {
            const key = `${p.id}@${due.getTime()}`;
            if (ignored.has(key)) continue;
            if (!hasMatchingEvent(p, due, events, toleranceMin)) {
                out.push({ plan: p, due });
            }
        }
    }
    out.sort((a, b) => a.due.getTime() - b.due.getTime());
    return out;
}