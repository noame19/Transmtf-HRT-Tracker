import { describe, it, expect } from 'vitest';
import { Ester, Plan, Route } from '../../types';
import {
    drugCategoryOf,
    planKey,
    nextDueAfter,
    dueMomentsInRange,
    isDueAt,
    matchPlansForNow,
    findConflicts,
    summarizeSchedule,
    validatePlan,
} from './planSchedule';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<Plan> = {}): Plan {
    const start = new Date(2026, 6, 1, 0, 0, 0); // 2026-07-01 local midnight
    const now = start.getTime();
    return {
        id: 'plan-1',
        ester: Ester.EV,
        route: Route.injection,
        doseMG: 5,
        schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
        startDateH: now / 3600000,
        enabled: true,
        leadMinutes: 5,
        extras: {},
        createdAtH: now / 3600000,
        updatedAtH: now / 3600000,
        ...overrides,
    };
}

const tStub = (k: string, fallback?: string): string => {
    // Mimic real translations: templates contain placeholders that
    // summarizeSchedule() is responsible for substituting.
    const templates: Record<string, string> = {
        'plan.summary.daily_one': 'Daily {time}',
        'plan.summary.daily_multi': 'Daily {times}',
        'plan.summary.every_n_days': 'Every {n} days {times}',
        'plan.summary.weekly': '{days} {times}',
        'plan.weekday.0': 'Sun',
        'plan.weekday.1': 'Mon',
        'plan.weekday.2': 'Tue',
        'plan.weekday.3': 'Wed',
        'plan.weekday.4': 'Thu',
        'plan.weekday.5': 'Fri',
        'plan.weekday.6': 'Sat',
        'plan.next': 'Next {when}',
    };
    return templates[k] ?? fallback ?? k;
};

// ─────────────────────────────────────────────────────────────────────────────

describe('drugCategoryOf', () => {
    it('classifies estradiol esters as estrogen', () => {
        for (const e of [Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU]) {
            expect(drugCategoryOf(e)).toBe('estrogen');
        }
    });
    it('classifies CPA / BICA as anti_androgen', () => {
        expect(drugCategoryOf(Ester.CPA)).toBe('anti_androgen');
        expect(drugCategoryOf(Ester.BICA)).toBe('anti_androgen');
    });
});

describe('planKey', () => {
    it('joins ester and route with a colon', () => {
        expect(planKey({ ester: Ester.EV, route: Route.injection })).toBe('EV:injection');
        expect(planKey({ ester: Ester.CPA, route: Route.oral })).toBe('CPA:oral');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('dueMomentsInRange — every_n_days', () => {
    it('emits only days divisible by intervalDays, anchored at startDateH', () => {
        const plan = makePlan({
            schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
            startDateH: new Date(2026, 6, 1, 0, 0, 0).getTime() / 3600000,
        });
        // From 2026-07-01 00:00 to 2026-07-16 00:00 → days 1, 6, 11 → 3 doses at 20:00
        const from = new Date(2026, 6, 1, 0, 0);
        const to = new Date(2026, 6, 16, 0, 0);
        const moments = dueMomentsInRange(plan, from, to);
        expect(moments).toHaveLength(3);
        expect(moments[0].getDate()).toBe(1);
        expect(moments[1].getDate()).toBe(6);
        expect(moments[2].getDate()).toBe(11);
        moments.forEach((m) => expect(m.getHours()).toBe(20));
    });

    it('respects endDateH (no moments after it)', () => {
        const plan = makePlan({
            schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
            startDateH: new Date(2026, 6, 1, 0, 0, 0).getTime() / 3600000,
            endDateH: new Date(2026, 6, 6, 23, 0, 0).getTime() / 3600000,
        });
        const from = new Date(2026, 6, 1, 0, 0);
        const to = new Date(2026, 6, 20, 0, 0);
        const moments = dueMomentsInRange(plan, from, to);
        // Only days 1 and 6 are within endDate; day 11 is past end → excluded.
        expect(moments).toHaveLength(2);
        expect(moments.map((m) => m.getDate())).toEqual([1, 6]);
    });
});

describe('dueMomentsInRange — daily', () => {
    it('emits every day in range with each time', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['09:00', '21:00'] },
        });
        const from = new Date(2026, 6, 5, 0, 0);
        const to = new Date(2026, 6, 8, 0, 0);
        const moments = dueMomentsInRange(plan, from, to);
        // Days 5, 6, 7 → 2 doses/day → 6 moments
        expect(moments).toHaveLength(6);
        expect(moments.filter((m) => m.getHours() === 9)).toHaveLength(3);
        expect(moments.filter((m) => m.getHours() === 21)).toHaveLength(3);
    });
});

describe('dueMomentsInRange — weekly', () => {
    it('emits only matching weekdays', () => {
        // 2026-07-05 is a Sunday (getDay() === 0)
        const plan = makePlan({
            schedule: { kind: 'weekly', weekdays: [1, 3, 5], times: ['08:00'] }, // Mon Wed Fri
        });
        const from = new Date(2026, 6, 5, 0, 0);   // Sun
        const to = new Date(2026, 6, 19, 0, 0);   // Sun + 14 days
        const moments = dueMomentsInRange(plan, from, to);
        // Mon=6, Wed=8, Fri=10, Mon=13, Wed=15, Fri=17 → 6 moments
        expect(moments).toHaveLength(6);
        const days = moments.map((m) => m.getDate());
        expect(days).toEqual([6, 8, 10, 13, 15, 17]);
    });

    it('returns empty when weekdays array is empty', () => {
        const plan = makePlan({
            schedule: { kind: 'weekly', weekdays: [], times: ['08:00'] },
        });
        const moments = dueMomentsInRange(plan, new Date(2026, 6, 1), new Date(2026, 6, 30));
        expect(moments).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('nextDueAfter', () => {
    it('returns the next moment on or after `from`', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['09:00'] },
        });
        // 2026-07-05 10:00 → next due is 2026-07-06 09:00
        const from = new Date(2026, 6, 5, 10, 0);
        const next = nextDueAfter(plan, from);
        expect(next).not.toBeNull();
        expect(next!.getDate()).toBe(6);
        expect(next!.getHours()).toBe(9);
    });

    it('returns null for a disabled plan', () => {
        const plan = makePlan({ enabled: false });
        const next = nextDueAfter(plan, new Date(2026, 6, 1, 20, 0));
        expect(next).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('isDueAt', () => {
    const plan = makePlan({
        schedule: { kind: 'daily', times: ['20:00'] },
    });

    it('returns true exactly at the scheduled time', () => {
        expect(isDueAt(plan, new Date(2026, 6, 5, 20, 0), 15)).toBe(true);
    });
    it('returns true within tolerance window', () => {
        expect(isDueAt(plan, new Date(2026, 6, 5, 20, 14), 15)).toBe(true);
    });
    it('returns false outside tolerance', () => {
        expect(isDueAt(plan, new Date(2026, 6, 5, 20, 30), 15)).toBe(false);
    });
    it('returns false for a disabled plan', () => {
        const off = makePlan({ enabled: false, schedule: { kind: 'daily', times: ['20:00'] } });
        expect(isDueAt(off, new Date(2026, 6, 5, 20, 0), 15)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('matchPlansForNow', () => {
    it('returns 0 matches when no plan is in window', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const now = new Date(2026, 6, 5, 10, 0);
        expect(matchPlansForNow([plan], now, 15)).toHaveLength(0);
    });

    it('returns 1 match when a single plan is in window', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const matches = matchPlansForNow([plan], new Date(2026, 6, 5, 20, 0), 15);
        expect(matches).toHaveLength(1);
        expect(matches[0].plan.id).toBe('plan-1');
    });

    it('returns N matches when N plans are due at the same time', () => {
        const ev = makePlan({
            id: 'p-ev',
            ester: Ester.EV,
            route: Route.injection,
            schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
        });
        const cpa = makePlan({
            id: 'p-cpa',
            ester: Ester.CPA,
            route: Route.oral,
            doseMG: 12.5,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const matches = matchPlansForNow([ev, cpa], new Date(2026, 6, 1, 20, 0), 15);
        expect(matches).toHaveLength(2);
    });

    it('de-duplicates by plan id (closest moment wins)', () => {
        // Plan with two daily times; only the closer one should appear.
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['09:00', '21:00'] },
        });
        const matches = matchPlansForNow([plan], new Date(2026, 6, 5, 20, 50), 15);
        expect(matches).toHaveLength(1);
        expect(matches[0].scheduledAt.getHours()).toBe(21);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('findConflicts', () => {
    it('returns empty when candidate is disabled', () => {
        const a = makePlan({ id: 'a', ester: Ester.EV, route: Route.injection, enabled: true });
        const b = makePlan({ id: 'b', ester: Ester.EV, route: Route.injection, enabled: false });
        expect(findConflicts([a, b], a)).toEqual([]);
    });

    it('returns plans that share (ester, route) AND are enabled AND candidate is enabled', () => {
        const old = makePlan({
            id: 'old',
            ester: Ester.EV,
            route: Route.injection,
            enabled: true,
            schedule: { kind: 'daily', times: ['09:00'] },
        });
        const fresh = makePlan({
            id: 'fresh',
            ester: Ester.EV,
            route: Route.injection,
            enabled: true,
            schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
        });
        const conflicts = findConflicts([old, fresh], fresh);
        expect(conflicts.map((c) => c.id)).toEqual(['old']);
    });

    it('does not conflict across different esters or routes', () => {
        const cpa = makePlan({
            id: 'cpa',
            ester: Ester.CPA,
            route: Route.oral,
            enabled: true,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const ev = makePlan({
            id: 'ev',
            ester: Ester.EV,
            route: Route.injection,
            enabled: true,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        expect(findConflicts([cpa, ev], cpa)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('summarizeSchedule', () => {
    it('formats daily single-time schedule', () => {
        const p = makePlan({ schedule: { kind: 'daily', times: ['09:00'] } });
        const out = summarizeSchedule(p, tStub);
        expect(out).toContain('09:00');
    });
    it('formats every_n_days with interval', () => {
        const p = makePlan({ schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] } });
        const out = summarizeSchedule(p, tStub);
        expect(out).toContain('5');
        expect(out).toContain('20:00');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('validatePlan', () => {
    it('passes a valid every_n_days plan', () => {
        const errors = validatePlan(makePlan());
        expect(errors).toEqual([]);
    });

    it('flags zero / negative dose', () => {
        const errors = validatePlan(makePlan({ doseMG: 0 }));
        expect(errors.some((e) => e.field === 'dose')).toBe(true);
    });

    it('flags empty times array', () => {
        const errors = validatePlan(makePlan({ schedule: { kind: 'daily', times: [] } }));
        expect(errors.some((e) => e.field === 'times')).toBe(true);
    });

    it('flags invalid HH:MM', () => {
        const errors = validatePlan(makePlan({ schedule: { kind: 'daily', times: ['25:00'] } }));
        expect(errors.some((e) => e.field === 'times')).toBe(true);
    });

    it('flags endDate ≤ startDate', () => {
        const start = new Date(2026, 6, 1, 0, 0, 0).getTime() / 3600000;
        const errors = validatePlan(makePlan({
            startDateH: start,
            endDateH: start, // equal → invalid
        }));
        expect(errors.some((e) => e.field === 'endDate')).toBe(true);
    });

    it('flags weekly schedule with no weekdays', () => {
        const errors = validatePlan(makePlan({ schedule: { kind: 'weekly', weekdays: [], times: ['08:00'] } }));
        expect(errors.some((e) => e.field === 'weekdays')).toBe(true);
    });
});