import { DoseEvent, Plan, Route } from '../../types';
import { dueMomentsInRange } from './planSchedule';
import { canonicalComplianceRoute } from './planCompliance';

// ── Defaults ──────────────────────────────────────────────────────────────

/** On-time window radius. Banner / modal show "该吃药了" when current time
 *  is within ±this many minutes of a scheduled due moment. Set to ±60min
 *  per UX decision — a 1h slack on each side of the scheduled time. */
export const PLAN_REMINDER_TOLERANCE_MIN = 60;

/** Boundary at which a due moment flips from 'on_time' to 'late'. A due at
 *  NOW-60min is still on_time (strict `>`), NOW-61min is late. Picked to
 *  match the upper edge of the on-time window so the two states don't
 *  overlap on the boundary. */
export const PLAN_REMINDER_LATE_START_MIN = 60;

/** How long past `due` the late state stays visible. The "已过服药时间"
 *  window is the half-open interval (due+LATE_START_MIN, due+LATE_END_HOURS].
 *  Past this point the banner auto-dismisses so it doesn't nag forever. */
export const PLAN_REMINDER_LATE_END_HOURS = 5;

/** Alias kept for callers that imported the old name. Equals
 *  `PLAN_REMINDER_LATE_END_HOURS` so auto-dismiss always lines up with
 *  the upper edge of the late window. */
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
    // Combined "on_time + late" sweep window, expressed in *due* space:
    //   due ∈ [now-5h, now+1h]
    // because each state is a window in *now* space around the same due:
    //   on_time  = now ∈ [due-1h, due+1h]  →  due ∈ [now-1h, now+1h]
    //   late     = now ∈ (due+1h, due+5h] →  due ∈ [now-5h, now-1h)
    // The earlier asymmetric "[now-1h, now+5h]" version was wrong: it let a
    // due 2h ahead (still inside [now-1h, now+5h]) into the reminder set,
    // even though it's outside both on_time and late windows. The corrected
    // union is 6h wide but only spans `now-5h` to `now+1h` in due-space.
    //
    // We add 1 minute of slack to `to` because `dueMomentsInRange` uses a
    // strict `>=` upper bound and we want due = now+1h (the on-time/late
    // boundary) to be included as on_time, not silently dropped.
    const from = new Date(now.getTime() - PLAN_REMINDER_LATE_END_HOURS * 60 * 60 * 1000);
    const to = new Date(now.getTime() + (toleranceMin + 1) * 60 * 1000);
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

/** Classify a due moment relative to "now". 'on_time' covers the window
 *  [due-TOLERANCE_MIN, due+LATE_START_MIN] (≤ 60min past due); 'late'
 *  covers (due+LATE_START_MIN, due+LATE_END_HOURS]. The boundary uses
 *  strict `>` so a due exactly LATE_START_MIN in the past is still on_time. */
export function classifyDueState(due: Date, now: Date): 'on_time' | 'late' {
    const LATE_START_MS = PLAN_REMINDER_LATE_START_MIN * 60 * 1000;
    return now.getTime() - due.getTime() > LATE_START_MS ? 'late' : 'on_time';
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