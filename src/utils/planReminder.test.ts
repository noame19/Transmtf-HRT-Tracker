import { beforeEach, describe, expect, it } from 'vitest';
import { DoseEvent, Ester, Plan, Route } from '../../types';
import {
    classifyDueState,
    findDueReminders,
    hasMatchingEvent,
    isDueReminderStale,
    PLAN_REMINDER_AUTO_DISMISS_MIN,
    PLAN_REMINDER_TOLERANCE_MIN,
} from './planReminder';

// Reference "now" — pinned so tests don't drift with real wall-clock time.
const NOW = new Date(2026, 6, 5, 20, 0, 0, 0);  // 2026-07-05 20:00 local.

let evId = 0;
let planId = 0;

/** Build a DoseEvent at the given local date/time. */
function mkEvent(ester: Ester, route: Route, year: number, month: number, day: number, hour: number, minute = 0): DoseEvent {
    const ms = new Date(year, month, day, hour, minute, 0, 0).getTime();
    return {
        id: `ev-${evId++}`,
        ester,
        route,
        timeH: ms / 3600000,
        doseMG: 5,
        weightKG: 60,
        extras: {},
    };
}

/** Build a Plan that fires daily at HH:MM. */
function mkDailyPlan(ester: Ester, route: Route, hour: number, minute = 0, overrides: Partial<Plan> = {}): Plan {
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return {
        id: `plan-${planId++}`,
        ester,
        route,
        doseMG: 5,
        schedule: { kind: 'daily', times: [`${hh}:${mm}`] },
        startDateH: (NOW.getTime() - 30 * 86400000) / 3600000,
        enabled: true,
        leadMinutes: 5,
        extras: {},
        createdAtH: (NOW.getTime() - 30 * 86400000) / 3600000,
        updatedAtH: (NOW.getTime() - 86400000) / 3600000,
        ...overrides,
    };
}

beforeEach(() => {
    evId = 0;
    planId = 0;
});

// ── hasMatchingEvent ──────────────────────────────────────────────────────

describe('hasMatchingEvent', () => {
    it('returns false when there are no events', () => {
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            [],
        )).toBe(false);
    });

    it('returns true when an event matches by time + drug + route', () => {
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 20, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            events,
        )).toBe(true);
    });

    it('returns false when event is outside the tolerance window', () => {
        // Event at 17:00 — NOW is 20:00 → 3h gap > 60min tolerance.
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 17, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            events,
        )).toBe(false);
    });

    it('returns false when ester differs', () => {
        const events = [mkEvent(Ester.E2, Route.injection, 2026, 6, 5, 20, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            events,
        )).toBe(false);
    });

    it('returns false when route differs (non-equivalent)', () => {
        const events = [mkEvent(Ester.EV, Route.gel, 2026, 6, 5, 20, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            events,
        )).toBe(false);
    });

    it('treats oral and sublingual as equivalent (event=sublingual, plan=oral)', () => {
        const events = [mkEvent(Ester.EV, Route.sublingual, 2026, 6, 5, 20, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.oral },
            NOW,
            events,
        )).toBe(true);
    });

    it('treats oral and sublingual as equivalent (event=oral, plan=sublingual)', () => {
        const events = [mkEvent(Ester.EV, Route.oral, 2026, 6, 5, 20, 0)];
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.sublingual },
            NOW,
            events,
        )).toBe(true);
    });

    it('does not require doseMG to match', () => {
        // User records a half-dose — still satisfies the "took this" intent.
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 20, 0)];
        // Plan says 5mg; event had doseMG=5 in builder but the function
        // signature for plan is Pick<ester, route> — so doseMG literally
        // cannot be compared. Just confirm a match exists.
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW,
            events,
        )).toBe(true);
    });

    it('honours a custom tolerance', () => {
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 18, 30)];  // 1.5h early
        // Default ±60min → 1.5h gap → no match.
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW, events,
        )).toBe(false);
        // Custom ±120min → 1.5h gap → matches.
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW, events, 120,
        )).toBe(true);
    });
});

// ── findDueReminders ──────────────────────────────────────────────────────

describe('findDueReminders', () => {
    it('returns [] when there are no plans', () => {
        expect(findDueReminders([], [], NOW)).toEqual([]);
    });

    it('returns [] when the plan due is outside the window', () => {
        // Daily at 09:00 — NOW=20:00 → 11h gap > 5h late window.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 9, 0)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('returns the plan when due is within the window (past due)', () => {
        // Daily at 19:30 — NOW=20:00 → 30min past, within ±60min on-time.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 19, 30)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].plan.id).toBe(plans[0].id);
        expect(result[0].due.getHours()).toBe(19);
        expect(result[0].due.getMinutes()).toBe(30);
    });

    it('returns the plan when due is within the window (upcoming)', () => {
        // Daily at 20:20 — NOW=20:00 → 20min ahead, within new 30min pre-window.
        // dueMomentsInRange uses half-open [from, to) so to=20:31 excludes the
        // 20:31 boundary — 20:20 is comfortably inside.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 20)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(20);
        expect(result[0].due.getMinutes()).toBe(20);
    });

    it('skips plans whose due is already satisfied by an event', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 0)];
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 20, 0)];
        expect(findDueReminders(plans, events, NOW)).toEqual([]);
    });

    it('skips disabled plans', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 0, { enabled: false })];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('returns the closest due when a plan has multiple times today', () => {
        const plan: Plan = {
            id: `plan-${planId++}`,
            ester: Ester.EV,
            route: Route.injection,
            doseMG: 5,
            schedule: { kind: 'daily', times: ['10:00', '14:00', '20:30'] },
            startDateH: (NOW.getTime() - 30 * 86400000) / 3600000,
            enabled: true,
            leadMinutes: 5,
            extras: {},
            createdAtH: (NOW.getTime() - 30 * 86400000) / 3600000,
            updatedAtH: (NOW.getTime() - 86400000) / 3600000,
        };
        // NOW=20:00; sweep window [19:00, +5h).
        //   10:00 today = 10h ago → out (before from).
        //   14:00 today = 6h ago  → out (before from).
        //   20:30 today = 30min ahead → in (the only candidate).
        const result = findDueReminders([plan], [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(20);
        expect(result[0].due.getMinutes()).toBe(30);
    });

    it('returns multiple plans sorted by proximity to now', () => {
        // planA=19:30 (30min past — in on_time post-window)
        // planB=20:20 (20min ahead — closest, in on_time pre-window)
        // planC=18:30 (90min past — in late window [65min, 245min])
        const planA = mkDailyPlan(Ester.EV, Route.injection, 19, 30);
        const planB = mkDailyPlan(Ester.CPA, Route.oral, 20, 20);
        const planC = mkDailyPlan(Ester.EV, Route.gel, 18, 30);
        const result = findDueReminders([planA, planB, planC], [], NOW);
        expect(result).toHaveLength(3);
        expect(result[0].plan.id).toBe(planB.id);  // 20min closest first
        expect(result[1].plan.id).toBe(planA.id);  // 30min
        expect(result[2].plan.id).toBe(planC.id);  // 90min
    });

    it('does not return plans whose due was satisfied with oral when plan is sublingual', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.sublingual, 20, 0)];
        // Recorded as oral — canonicalises to oral = sublingual → satisfied.
        const events = [mkEvent(Ester.EV, Route.oral, 2026, 6, 5, 20, 0)];
        expect(findDueReminders(plans, events, NOW)).toEqual([]);
    });

    // ── Sweep window boundaries ─────────────────────────────────────────────
    // The combined window is due ∈ [now-4h05min, now+30min] minus the
    // 5-minute "transition gap" (now-65min, now-60min). These tests pin
    // the exact behaviour at the on-time pre boundary, the on-time/late
    // gap, and the late/stale boundary.

    it('includes a due exactly at the on-time upper boundary (now+30min)', () => {
        // 20:30 = NOW + 30min — on the boundary; should be on_time.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 30)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(20);
        expect(result[0].due.getMinutes()).toBe(30);
    });

    it('excludes a due 1 minute past the on-time upper boundary', () => {
        // 20:32 = NOW + 32min — outside the new 30min pre-window. The
        // sweep window tolerates this (to = now+31min strict `>=`), so
        // we want due = now+32min to prove the pre-window filter is the
        // thing dropping it, not the sweep boundary.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 32)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('excludes a due 5 minutes past the on-time upper boundary', () => {
        // 20:35 = NOW + 35min — well past the 30min pre-window.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 35)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('excludes a due inside the 5-minute transition gap (60min < past < 65min)', () => {
        // 18:58 = NOW - 62min — inside the gap (on_time closed at 60min,
        // late hasn't opened at 65min). No reminder should fire.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 18, 58)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('includes a due exactly at the late lower boundary (now-65min)', () => {
        // 18:55 = NOW - 65min — on the late boundary; should be late.
        // classifyDueState uses `>=`, so due at exactly 65min past is late.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 18, 55)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(18);
        expect(result[0].due.getMinutes()).toBe(55);
    });

    it('includes a due exactly at the late upper boundary (now-4h05min)', () => {
        // 15:55 = NOW - 245min — on the late boundary; should be late.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 15, 55)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(15);
        expect(result[0].due.getMinutes()).toBe(55);
    });

    it('excludes a due past the late upper boundary (now-4h06min)', () => {
        // 15:54 = NOW - 246min — past the stale threshold (245min).
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 15, 54)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('defaults to PLAN_REMINDER_TOLERANCE_MIN', () => {
        expect(PLAN_REMINDER_TOLERANCE_MIN).toBe(60);
    });
});

// ── classifyDueState ──────────────────────────────────────────────────────

describe('classifyDueState', () => {
    it('returns on_time when due is in the future', () => {
        const due = new Date(NOW.getTime() + 30 * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('on_time');
    });

    it('returns on_time when due is within the on-time window past', () => {
        // 30min past due — still inside the 60min on-time past window.
        const due = new Date(NOW.getTime() - 30 * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('on_time');
    });

    it('returns late when due is past the on-time window', () => {
        // 90min past due — past LATE_START_MIN (60min) → late.
        const due = new Date(NOW.getTime() - 90 * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('late');
    });

    it('returns late for a multi-hour overdue due', () => {
        const due = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('late');
    });
});

// ── isDueReminderStale ────────────────────────────────────────────────────

describe('isDueReminderStale', () => {
    it('returns false for a due moment in the future', () => {
        const due = new Date(NOW.getTime() + 60 * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(false);
    });

    it('returns false at exactly the auto-dismiss boundary', () => {
        // Edge: age === threshold → NOT stale (uses strict >).
        const due = new Date(NOW.getTime() - PLAN_REMINDER_AUTO_DISMISS_MIN * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(false);
    });

    it('returns true when past the auto-dismiss threshold', () => {
        const due = new Date(NOW.getTime() - (PLAN_REMINDER_AUTO_DISMISS_MIN + 1) * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(true);
    });

    it('returns true for a much older due', () => {
        const due = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(true);
    });
});