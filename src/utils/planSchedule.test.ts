import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    formatNextDue,
    sanitizePlansForConflict,
    pickPrimaryEnabledPlan,
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
        'overview.due.today': '今天',
        'overview.due.tomorrow': '明天',
        'overview.due.day_after': '后天',
        'overview.due.this_weekday': '本周{day}',
        'overview.due.next_weekday': '下周{day}',
        'overview.due.exact': '{m}月{d}日',
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
    it('classifies PROG as progestin', () => {
        // Progesterone (黄体酮) — new addition; takes the amber
        // progestin heatmap bucket that was previously reserved via the
        // string-equality fallback for legacy 'PRL' / 'Progesterone' values.
        expect(drugCategoryOf(Ester.PROG)).toBe('progestin');
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

    // ── Regression: defensive coercion of `now` to a number of ms.
    // Triggered in dev by a stale HMR closure that handed matchPlansForNow
    // a non-Date value via MainLayout.handleSmartAddEvent. The function
    // signature still says Date, but the runtime accepts epoch-ms numbers
    // (and anything else coercible via Number) without throwing.
    it('accepts `now` as an epoch-ms number without throwing', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const nowMs = new Date(2026, 6, 5, 20, 5).getTime();
        expect(() => matchPlansForNow([plan], nowMs, 15)).not.toThrow();
        const matches = matchPlansForNow([plan], nowMs, 15);
        expect(matches).toHaveLength(1);
        expect(matches[0].scheduledAt.getHours()).toBe(20);
    });

    it('falls back to Date.now() when `now` is non-coercible (NaN)', () => {
        // We don't assert the exact matches — just that the call doesn't
        // throw and returns a sensible shape. The fallback path is what
        // keeps the "+新增用药" button clickable when the input is garbage.
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        expect(() => matchPlansForNow([plan], Number('not-a-date'), 15)).not.toThrow();
        expect(Array.isArray(matchPlansForNow([plan], Number('not-a-date'), 15))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('findConflicts', () => {
    it('returns empty when candidate is disabled', () => {
        const a = makePlan({ id: 'a', ester: Ester.EV, route: Route.injection, enabled: true });
        const b = makePlan({ id: 'b', ester: Ester.EV, route: Route.injection, enabled: false });
        expect(findConflicts([a, b], a)).toEqual([]);
    });

    it('flags two estrogen plans (different ester / route) as conflicting', () => {
        // The category rule is broader than (ester, route): EV IM and EB oral
        // are both estrogen, so the user must disable one before enabling the
        // other. Switching regimens should go through the conflict-disable
        // dialog, not silently produce two enabled estrogen plans.
        const evIm = makePlan({
            id: 'ev-im',
            ester: Ester.EV,
            route: Route.injection,
            enabled: true,
            schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
        });
        const ebOral = makePlan({
            id: 'eb-oral',
            ester: Ester.EB,
            route: Route.oral,
            enabled: true,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const conflicts = findConflicts([evIm, ebOral], ebOral);
        expect(conflicts.map((c) => c.id)).toEqual(['ev-im']);
    });

    it('allows estrogen + anti-androgen to coexist (different drug categories)', () => {
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

    it('flags two anti-androgen plans (CPA + BICA) as conflicting', () => {
        const cpa = makePlan({
            id: 'cpa',
            ester: Ester.CPA,
            route: Route.oral,
            enabled: true,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const bica = makePlan({
            id: 'bica',
            ester: Ester.BICA,
            route: Route.oral,
            enabled: true,
            schedule: { kind: 'daily', times: ['20:00'] },
        });
        const conflicts = findConflicts([cpa, bica], bica);
        expect(conflicts.map((c) => c.id)).toEqual(['cpa']);
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

// ─────────────────────────────────────────────────────────────────────────────
// formatNextDue — relative phrase chosen by absolute day diff.
//
// Reference "now": Friday 2026-07-03 10:00 local. Mon of this week = 2026-06-29,
// Sun = 2026-07-05. Mon of next week = 2026-07-06, Sun = 2026-07-12.
// ─────────────────────────────────────────────────────────────────────────────

describe('formatNextDue', () => {
    const NOW = new Date(2026, 6, 3, 10, 0, 0); // 2026-07-03 Fri 10:00 local

    const tEn = (k: string, fallback?: string): string => {
        const templates: Record<string, string> = {
            'plan.weekday.0': 'Sun', 'plan.weekday.1': 'Mon', 'plan.weekday.2': 'Tue',
            'plan.weekday.3': 'Wed', 'plan.weekday.4': 'Thu', 'plan.weekday.5': 'Fri', 'plan.weekday.6': 'Sat',
            'overview.due.today': 'Today',
            'overview.due.tomorrow': 'Tomorrow',
            'overview.due.day_after': 'Day after',
            'overview.due.this_weekday': 'this {day}',
            'overview.due.next_weekday': 'next {day}',
        };
        return templates[k] ?? fallback ?? k;
    };

    it('dayDiff=0 → 今天 (zh) / Today (en)', () => {
        const due = new Date(2026, 6, 3, 20, 0, 0);
        expect(formatNextDue(due, NOW, tStub, 'zh')).toBe('今天');
        expect(formatNextDue(due, NOW, tEn, 'en')).toBe('Today');
    });

    it('dayDiff=1 → 明天 (zh) / Tomorrow (en)', () => {
        const due = new Date(2026, 6, 4, 20, 0, 0);
        expect(formatNextDue(due, NOW, tStub, 'zh')).toBe('明天');
        expect(formatNextDue(due, NOW, tEn, 'en')).toBe('Tomorrow');
    });

    it('dayDiff=2 → 后天 (zh) / Day after (en)', () => {
        const due = new Date(2026, 6, 5, 20, 0, 0); // Sunday
        expect(formatNextDue(due, NOW, tStub, 'zh')).toBe('后天');
        expect(formatNextDue(due, NOW, tEn, 'en')).toBe('Day after');
    });

    it('dayDiff in current week (≥ 3) → 本周X (zh) / this {day} (en)', () => {
        // 2026-07-04 is Saturday (dayDiff=1 falls to tomorrow, dayDiff=4 = Tue)
        // Use Saturday 2026-07-04 — that's dayDiff=1, falls to "tomorrow".
        // Use 2026-06-29 Mon — would be in the past (already passed this week).
        // Use 2026-06-30 Tue — also in the past relative to NOW (2026-07-03).
        // Saturday Mon-Sun block containing NOW spans 2026-06-29 (Mon) → 2026-07-05 (Sun).
        // Future dates in this block: only Sunday 2026-07-05 — but that's dayDiff=2.
        // So this branch needs dayDiff ≥ 3 in current week. Use a now earlier in the week.
        const wedNow = new Date(2026, 6, 1, 10, 0, 0); // 2026-07-01 Wed
        // 2026-07-04 Sat: dayDiff = 3, in this week → 本周六
        const dueSat = new Date(2026, 6, 4, 20, 0, 0);
        expect(formatNextDue(dueSat, wedNow, tStub, 'zh')).toBe('本周Sat');
        expect(formatNextDue(dueSat, wedNow, tEn, 'en')).toBe('this Sat');
    });

    it('dayDiff in next week → 下周X (zh) / next {day} (en)', () => {
        // Next Mon-Sun block: 2026-07-06 (Mon) → 2026-07-12 (Sun).
        const dueWed = new Date(2026, 6, 8, 20, 0, 0); // 2026-07-08 Wed
        expect(formatNextDue(dueWed, NOW, tStub, 'zh')).toBe('下周Wed');
        expect(formatNextDue(dueWed, NOW, tEn, 'en')).toBe('next Wed');
    });

    it('dayDiff ≥ 14 with CJK lang → exact "X月Y日"', () => {
        const due = new Date(2026, 6, 20, 20, 0, 0); // 2026-07-20, dayDiff=17
        expect(formatNextDue(due, NOW, tStub, 'zh')).toBe('7月20日');
    });

    it('dayDiff ≥ 14 with English lang → Intl short month + day', () => {
        const due = new Date(2026, 6, 20, 20, 0, 0); // 2026-07-20
        // Intl en-US with {month:'short', day:'numeric'} → "Jul 20"
        expect(formatNextDue(due, NOW, tEn, 'en')).toBe('Jul 20');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defensive sanitization (dirty localStorage / cloud-sync races)
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizePlansForConflict', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('returns the same reference when input already satisfies invariant', () => {
        const plans: Plan[] = [
            makePlan({ id: 'e1', ester: Ester.EV }),
            makePlan({ id: 'a1', ester: Ester.CPA, route: Route.oral, schedule: { kind: 'daily', times: ['08:00'] } }),
        ];
        const out = sanitizePlansForConflict(plans);
        expect(out).toBe(plans);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('handles empty list', () => {
        expect(sanitizePlansForConflict([])).toEqual([]);
    });

    it('disables older enabled duplicates in same category, keeps most-recent', () => {
        const t0 = 1000;
        const older = makePlan({ id: 'old', ester: Ester.EV, updatedAtH: t0 });
        const newer = makePlan({ id: 'new', ester: Ester.EV, updatedAtH: t0 + 100 });
        const cpa = makePlan({ id: 'cpa', ester: Ester.CPA, route: Route.oral, schedule: { kind: 'daily', times: ['08:00'] } });
        const out = sanitizePlansForConflict([older, newer, cpa]);

        // newer kept (most recent EV), older disabled, CPA untouched
        const byId = Object.fromEntries(out.map((p) => [p.id, p]));
        expect(byId.new.enabled).toBe(true);
        expect(byId.old.enabled).toBe(false);
        expect(byId.cpa.enabled).toBe(true);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/loaded localStorage had 2 enabled estrogen/);
    });

    it('keeps the only enabled plan in a category untouched (no warn)', () => {
        const ev = makePlan({ id: 'ev', ester: Ester.EV });
        const eb = makePlan({ id: 'eb', ester: Ester.EB, enabled: false }); // disabled, doesn't count
        const out = sanitizePlansForConflict([ev, eb]);
        expect(out[0].enabled).toBe(true);
        expect(out[1].enabled).toBe(false);
        // EB is disabled before sanitization so no conflict, no warn
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('disables multiple duplicates while keeping the single most-recent', () => {
        const a = makePlan({ id: 'a', ester: Ester.EV, updatedAtH: 100 });
        const b = makePlan({ id: 'b', ester: Ester.EV, updatedAtH: 300 });
        const c = makePlan({ id: 'c', ester: Ester.EV, updatedAtH: 200 });
        const out = sanitizePlansForConflict([a, b, c]);
        const byId = Object.fromEntries(out.map((p) => [p.id, p]));
        expect(byId.a.enabled).toBe(false);
        expect(byId.b.enabled).toBe(true);
        expect(byId.c.enabled).toBe(false);
    });

    it('cross-category enabled pairs (estrogen + anti-androgen) are NOT conflicts', () => {
        const ev = makePlan({ id: 'ev', ester: Ester.EV });
        const cpa = makePlan({ id: 'cpa', ester: Ester.CPA, route: Route.oral, schedule: { kind: 'daily', times: ['08:00'] } });
        const out = sanitizePlansForConflict([ev, cpa]);
        expect(out).toEqual([ev, cpa]); // no copy needed (sanitize is a no-op)
        expect(out[0]).toBe(ev); // same reference confirms no-copy
        expect(out[1]).toBe(cpa);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('pickPrimaryEnabledPlan', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('returns null when no plan matches the category', () => {
        const ev = makePlan({ id: 'ev', ester: Ester.EV });
        expect(pickPrimaryEnabledPlan([ev], 'anti_androgen')).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the only enabled plan, no warning', () => {
        const ev = makePlan({ id: 'ev', ester: Ester.EV });
        expect(pickPrimaryEnabledPlan([ev], 'estrogen')).toBe(ev);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('picks the most-recently-updated enabled plan when multiple qualify', () => {
        const older = makePlan({ id: 'old', ester: Ester.EV, updatedAtH: 100 });
        const newer = makePlan({ id: 'new', ester: Ester.EV, updatedAtH: 200 });
        const got = pickPrimaryEnabledPlan([older, newer], 'estrogen');
        expect(got?.id).toBe('new');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/compute-time defensive fallback/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// leadMinutes invariant — JS contract
//
// Kotlin's NotificationScheduler is responsible for subtracting leadMinutes
// when computing the alarm time. The JS helper is intentionally declarative:
// it returns the EXACT dose moment (not the alarm time). These tests pin
// down that contract so a future refactor that accidentally applies
// leadMinutes inside dueMomentsInRange / nextDueAfter will fail loudly.
//
// Background: Kotlin had a hidden bug where ParsedPlan didn't carry the
// leadMinutes field, so the scheduler always fired at the raw dose time.
// That's fixed; this is the symmetric JS-side lock so we don't drift back.
// ─────────────────────────────────────────────────────────────────────────────

describe('dueMomentsInRange — leadMinutes invariant', () => {
    it('returns moments at the exact dose time, never shifted by leadMinutes', () => {
        const plan = makePlan({
            schedule: { kind: 'daily', times: ['20:00'] },
            leadMinutes: 5,
        });
        const from = new Date(2026, 6, 5, 0, 0);
        const to = new Date(2026, 6, 7, 0, 0);
        const moments = dueMomentsInRange(plan, from, to);
        expect(moments).toHaveLength(2);
        moments.forEach(m => {
            expect(m.getHours()).toBe(20);
            expect(m.getMinutes()).toBe(0);
        });
    });

    it('different leadMinutes values produce identical moment timestamps', () => {
        // The contract: leadMinutes affects only the alarm time (Kotlin side),
        // never the dose moment. Lock it down across 0 / 5 / 30 minutes so a
        // future refactor that adds a "shift for UI preview" can't slip in.
        const from = new Date(2026, 6, 5, 0, 0);
        const to = new Date(2026, 6, 8, 0, 0);
        const a = makePlan({ leadMinutes: 0,  schedule: { kind: 'daily', times: ['09:00'] } });
        const b = makePlan({ leadMinutes: 5,  schedule: { kind: 'daily', times: ['09:00'] } });
        const c = makePlan({ leadMinutes: 30, schedule: { kind: 'daily', times: ['09:00'] } });
        const momentsA = dueMomentsInRange(a, from, to);
        const momentsB = dueMomentsInRange(b, from, to);
        const momentsC = dueMomentsInRange(c, from, to);
        expect(momentsB.map(m => m.getTime())).toEqual(momentsA.map(m => m.getTime()));
        expect(momentsC.map(m => m.getTime())).toEqual(momentsA.map(m => m.getTime()));
    });

    it('nextDueAfter also ignores leadMinutes (next dose stays at exact dose time)', () => {
        const plan5 = makePlan({ leadMinutes: 5, schedule: { kind: 'daily', times: ['20:00'] } });
        const plan0 = makePlan({ leadMinutes: 0, schedule: { kind: 'daily', times: ['20:00'] } });
        const from = new Date(2026, 6, 5, 10, 0);
        const next5 = nextDueAfter(plan5, from);
        const next0 = nextDueAfter(plan0, from);
        expect(next5?.getTime()).toBe(next0?.getTime());
        expect(next5?.getHours()).toBe(20);
        expect(next5?.getMinutes()).toBe(0);
    });
});
