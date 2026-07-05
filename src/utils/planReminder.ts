import { DoseEvent, Plan, Route } from '../../types';
import { dueMomentsInRange } from './planSchedule';
import { canonicalComplianceRoute } from './planCompliance';

// ── Defaults ──────────────────────────────────────────────────────────────

/** Tolerance window for "is this due moment 'now'?" — the banner shows when
 *  current time is within ±this many minutes of a scheduled due moment.
 *  Defaults to ±3h per UX decision (looser than notification-only flow). */
export const PLAN_REMINDER_TOLERANCE_MIN = 180;

/** Past-due banner auto-dismiss threshold: if a due moment is more than this
 *  many hours in the past AND the user hasn't acted, stop nagging. The user
 *  is presumed to have either skipped intentionally or moved on; either way
 *  a stale banner becomes visual noise. */
export const PLAN_REMINDER_AUTO_DISMISS_HOURS = 6;

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

/** Classify a due moment relative to "now". `on_time` includes a small
 *  grace window (~1 min) where we don't yet say "late" — feels better. */
export function classifyDueState(due: Date, now: Date): 'on_time' | 'late' {
    const GRACE_MS = 60 * 1000;
    return now.getTime() - due.getTime() > GRACE_MS ? 'late' : 'on_time';
}

/** True iff a due moment is so far in the past that the banner should
 *  stop showing it. Used to drop stale reminders from the UI. */
export function isDueReminderStale(
    due: Date,
    now: Date,
    autoDismissHours: number = PLAN_REMINDER_AUTO_DISMISS_HOURS,
): boolean {
    const ageMs = now.getTime() - due.getTime();
    if (ageMs <= 0) return false;
    return ageMs > autoDismissHours * 60 * 60 * 1000;
}