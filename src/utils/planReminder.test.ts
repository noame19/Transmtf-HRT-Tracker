import { beforeEach, describe, expect, it } from 'vitest';
import { DoseEvent, Ester, Plan, Route } from '../../types';
import {
    classifyDueState,
    findDueReminders,
    findVirtualRecords,
    hasMatchingEvent,
    isDueReminderStale,
    PLAN_REMINDER_LATE_END_HOURS,
    PLAN_REMINDER_LATE_START_MIN,
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
        // Event at 16:00 — NOW is 20:00 → 4h gap > 180min tolerance.
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 16, 0)];
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
        // Default ±60min → 90min gap → no match.
        expect(hasMatchingEvent(
            { ester: Ester.EV, route: Route.injection },
            NOW, events,
        )).toBe(false);
        // Custom ±120min → 90min gap → matches.
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
        // Daily at 09:00 — NOW=20:00 → 11h gap > 180min.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 9, 0)];
        expect(findDueReminders(plans, [], NOW)).toEqual([]);
    });

    it('returns the plan when due is within the window (past due)', () => {
        // Daily at 19:00 — NOW=20:00 → 1h past, within 180min.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 19, 0)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].plan.id).toBe(plans[0].id);
        expect(result[0].due.getHours()).toBe(19);
    });

    it('returns the plan when due is within the window (upcoming)', () => {
        // Daily at 20:45 — NOW=20:00 → 45min ahead, within 60min.
        // (dueMomentsInRange uses `moment >= to` so we can't sit exactly on
        // the upper bound — keep the due strictly inside the window.)
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 45)];
        const result = findDueReminders(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(20);
        expect(result[0].due.getMinutes()).toBe(45);
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
        // NOW=20:00; 10:00=10h ago (out), 14:00=6h ago (out), 20:30=30min ahead (in).
        // 20:30 is the only candidate — should be returned.
        const result = findDueReminders([plan], [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].due.getHours()).toBe(20);
        expect(result[0].due.getMinutes()).toBe(30);
    });

    it('returns multiple plans sorted by proximity to now', () => {
        const planA = mkDailyPlan(Ester.EV, Route.injection, 19, 0);   // 1h past  (60min)
        const planB = mkDailyPlan(Ester.CPA, Route.oral, 20, 30);      // 30min ahead (30min)
        const planC = mkDailyPlan(Ester.EV, Route.gel, 20, 45);        // 45min ahead (45min)
        const result = findDueReminders([planA, planB, planC], [], NOW);
        expect(result).toHaveLength(3);
        expect(result[0].plan.id).toBe(planB.id);  // closest first (30min)
        expect(result[1].plan.id).toBe(planC.id);  // 45min
        expect(result[2].plan.id).toBe(planA.id);  // 60min (farthest)
    });

    it('does not return plans whose due was satisfied with oral when plan is sublingual', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.sublingual, 20, 0)];
        // Recorded as oral — canonicalises to oral = sublingual → satisfied.
        const events = [mkEvent(Ester.EV, Route.oral, 2026, 6, 5, 20, 0)];
        expect(findDueReminders(plans, events, NOW)).toEqual([]);
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

    it('returns on_time when due is within the late-start window', () => {
        // Now is PLAN_REMINDER_LATE_START_MIN minutes past due → still
        // on_time (uses strict > comparison).
        const due = new Date(NOW.getTime() - PLAN_REMINDER_LATE_START_MIN * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('on_time');
    });

    it('returns late when due is past the late-start window', () => {
        const due = new Date(NOW.getTime() - (PLAN_REMINDER_LATE_START_MIN + 5) * 60 * 1000);
        expect(classifyDueState(due, NOW)).toBe('late');
    });

    it('returns late for a multi-hour overdue due', () => {
        const due = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);
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
        const due = new Date(NOW.getTime() - PLAN_REMINDER_LATE_END_HOURS * 60 * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(false);
    });

    it('returns true when past the auto-dismiss threshold', () => {
        const due = new Date(NOW.getTime() - (PLAN_REMINDER_LATE_END_HOURS + 1) * 60 * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(true);
    });

    it('returns true for a much older due', () => {
        const due = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
        expect(isDueReminderStale(due, NOW)).toBe(true);
    });
});

// ── findVirtualRecords ────────────────────────────────────────────────────

describe('findVirtualRecords', () => {
    it('returns [] when there are no plans', () => {
        expect(findVirtualRecords([], [], NOW)).toEqual([]);
    });

    it('returns [] when the plan due is outside the window', () => {
        // Daily at 09:00 — NOW=20:00 → 11h gap > 60min tolerance.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 9, 0)];
        expect(findVirtualRecords(plans, [], NOW)).toEqual([]);
    });

    it('returns the plan when due is in the past window and unsatisfied', () => {
        // Daily at 19:00 — NOW=20:00 → 1h past, within 60min.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 19, 0)];
        const result = findVirtualRecords(plans, [], NOW);
        expect(result).toHaveLength(1);
        expect(result[0].plan.id).toBe(plans[0].id);
        expect(result[0].due.getHours()).toBe(19);
    });

    it('returns the plan when due is in the future window and unsatisfied', () => {
        // Daily at 20:30 — NOW=20:00 → 30min ahead, within 60min.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 30)];
        const result = findVirtualRecords(plans, [], NOW);
        expect(result).toHaveLength(1);
    });

    it('skips dues already satisfied by an event', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 0)];
        const events = [mkEvent(Ester.EV, Route.injection, 2026, 6, 5, 20, 0)];
        expect(findVirtualRecords(plans, events, NOW)).toEqual([]);
    });

    it('skips disabled plans', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 0, { enabled: false })];
        expect(findVirtualRecords(plans, [], NOW)).toEqual([]);
    });

    it('skips dues whose key is in the ignored set', () => {
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 20, 0)];
        const result = findVirtualRecords(plans, [], NOW);
        expect(result).toHaveLength(1);
        const ignored = new Set<string>([`${result[0].plan.id}@${result[0].due.getTime()}`]);
        expect(findVirtualRecords(plans, [], NOW, 60, ignored)).toEqual([]);
    });

    it('returns multiple records sorted by due time ascending', () => {
        // Two plans whose dues are both within the window.
        const planA = mkDailyPlan(Ester.EV, Route.injection, 19, 30);  // 30min past
        const planB = mkDailyPlan(Ester.CPA, Route.oral, 20, 30);      // 30min ahead
        const result = findVirtualRecords([planA, planB], [], NOW);
        expect(result).toHaveLength(2);
        // Older due comes first.
        expect(result[0].plan.id).toBe(planA.id);
        expect(result[1].plan.id).toBe(planB.id);
    });

    it('includes due moments already past the late threshold (still within ±1h)', () => {
        // Daily at 19:00 — NOW=20:00 → 1h past, still within ±1h window.
        const plans = [mkDailyPlan(Ester.EV, Route.injection, 19, 0)];
        const result = findVirtualRecords(plans, [], NOW);
        expect(result).toHaveLength(1);
    });
});