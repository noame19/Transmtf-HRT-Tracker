import { describe, it, expect } from 'vitest';
import { DoseEvent, Ester, Plan, Route } from '../../types';
import {
    buildHeatmapRange,
    monthLabelFor,
    routesOfCell,
    timeSortedCellRows,
    upcomingPlanRowsForCell,
    heatmapColorForEster,
    HEATMAP_COLOR_BY_CATEGORY,
    type HeatmapDayCell,
} from './heatmapData';
import { drugCategoryOf } from './planSchedule';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3600000;

/** Local-time helper: build a Date for a given Y/M/D at local midnight. */
function localMid(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
    return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

/** Local-time helper: build an event's `timeH` (hours since Unix epoch) for
 *  a given local date. Mirrors the project's convention (date stored as a wall-
 *  clock Date.getTime() / 3600000). */
function localTimeH(year: number, month: number, day: number, hours = 0, minutes = 0): number {
    return localMid(year, month, day, hours, minutes).getTime() / HOUR;
}

function makeEvent(overrides: Partial<DoseEvent> = {}): DoseEvent {
    return {
        id: overrides.id ?? `ev-${Math.random().toString(36).slice(2)}`,
        route: Route.injection,
        timeH: localTimeH(2026, 7, 4, 20, 0),
        doseMG: 5,
        ester: Ester.EV,
        weightKG: 70,
        extras: {},
        ...overrides,
    };
}

// Mirrors `MedicationHeatmap.tsx → categoriesOfCell` so we can test the dedup
// contract from a node-friendly location. Keep in sync if either side changes.
function categoriesOfCellForTest(events: DoseEvent[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of events) {
        if (e.route === Route.patchRemove) continue;
        const cat = drugCategoryOf(e.ester);
        if (!seen.has(cat)) {
            seen.add(cat);
            out.push(cat);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('heatmapColorForEster / HEATMAP_COLOR_BY_CATEGORY', () => {
    it('maps each drug class to a stable hex colour', () => {
        expect(HEATMAP_COLOR_BY_CATEGORY.estrogen).toBe('#EC4899');
        expect(HEATMAP_COLOR_BY_CATEGORY.anti_androgen).toBe('#5a7eff');
        expect(HEATMAP_COLOR_BY_CATEGORY.progestin).toBe('#F59E0B');
        expect(HEATMAP_COLOR_BY_CATEGORY.other).toBe('#64748B');
    });

    it('routes a real Ester to the right palette bucket', () => {
        // Estradiol family → estrogen → pink
        expect(heatmapColorForEster(Ester.EV)).toBe('#EC4899');
        expect(heatmapColorForEster(Ester.E2)).toBe('#EC4899');
        // Anti-androgen → purple (CPA + BICA, both fall in the same bucket)
        expect(heatmapColorForEster(Ester.CPA)).toBe('#5a7eff');
        expect(heatmapColorForEster(Ester.BICA)).toBe('#5a7eff');
        // Progestin → amber (PROG / 黄体酮 — 之前一直靠 'PRL' 字符串 fallback 占位)
        expect(heatmapColorForEster(Ester.PROG)).toBe('#F59E0B');
        // Other (anything not in the switch arms — e.g. PRL isn't an Enum
        // value here, but a defensive read confirms the bucket contract).
        const otherEster = 'XYZ' as Ester;
        expect(heatmapColorForEster(otherEster)).toBe('#64748B');
    });

    it('uses the same DrugCategory contract as planSchedule', () => {
        // Invariant: drugCategoryOf must agree with heatmapColorForEster.
        for (const e of Object.values(Ester)) {
            const cat = drugCategoryOf(e);
            expect(HEATMAP_COLOR_BY_CATEGORY[cat]).toBeDefined();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('category dedup (cell-level colour count)', () => {
    it('CPA + BICA + EV dedupes to 2 categories, not 3', () => {
        // Regression: previously the component's local category mapper had a
        // string mismatch ('Bicalutamide' vs the actual Ester.BICA value),
        // so BICA fell through to the 'other' bucket and CPA + BICA + EV
        // rendered as 3 vertical stripes instead of the intended 2-category
        // wavy split. This test pins the contract: CPA and BICA both map to
        // anti_androgen, so the trio collapses to 2.
        const events = [
            makeEvent({ id: 'cpa', ester: Ester.CPA, route: Route.oral }),
            makeEvent({ id: 'bica', ester: Ester.BICA, route: Route.oral }),
            makeEvent({ id: 'ev', ester: Ester.EV, route: Route.injection }),
        ];
        const cats = categoriesOfCellForTest(events);
        expect(cats.sort()).toEqual(['anti_androgen', 'estrogen']);
        expect(cats.length).toBe(2);
    });

    it('BICA by itself is anti_androgen (regression for the BICA→other bug)', () => {
        expect(drugCategoryOf(Ester.BICA)).toBe('anti_androgen');
        expect(heatmapColorForEster(Ester.BICA)).toBe('#5a7eff');
    });

    it('PRL (string-cast legacy value) maps to progestin, not other', () => {
        // PRL isn't in the Ester enum today, so drugCategoryOf has to fall
        // through to a string check in the default branch. Without that
        // fallback, CPA + EV + PRL used to render as 3 stripes (red+blue+grey)
        // instead of the intended red+blue+amber.
        expect(drugCategoryOf('PRL' as Ester)).toBe('progestin');
        expect(drugCategoryOf('Progesterone' as Ester)).toBe('progestin');
        expect(heatmapColorForEster('PRL' as Ester)).toBe('#F59E0B');
    });

    it('EV + PRL dedupes to 2 distinct categories (estrogen + progestin)', () => {
        const events = [
            makeEvent({ id: 'ev', ester: Ester.EV, route: Route.injection }),
            makeEvent({ id: 'prl', ester: 'PRL' as Ester, route: Route.oral }),
        ];
        expect(categoriesOfCellForTest(events).sort()).toEqual(['estrogen', 'progestin']);
    });

    it('ignores patchRemove bookkeeping events when counting categories', () => {
        const events = [
            makeEvent({ id: 'apply', ester: Ester.EV, route: Route.patchApply }),
            makeEvent({ id: 'remove', ester: Ester.EV, route: Route.patchRemove }),
        ];
        expect(categoriesOfCellForTest(events)).toEqual(['estrogen']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — empty input', () => {
    it('produces a non-empty 7-row grid when there are no events', () => {
        const today = localMid(2026, 7, 4);
        const range = buildHeatmapRange([], today, 21);
        // Should snap start to the Monday of (today - 60d) and end to the
        // Sunday of (today + 21d). Either way, ≥ 7 days.
        expect(range.weeks.length).toBeGreaterThanOrEqual(2);
        for (const w of range.weeks) {
            expect(w.days.length).toBe(7);
        }
        expect(range.todayKey).toBe('2026-07-04');
    });

    it('snaps start to Monday', () => {
        // Today is 2026-07-04 which is a Saturday. First event is on 2026-01-15
        // (a Thursday). The Monday BEFORE 2026-01-15 is 2026-01-12.
        const events = [makeEvent({ timeH: localTimeH(2026, 1, 15, 20, 0) })];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        expect(range.startDate.getDay()).toBe(1); // Monday
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — single day admin event', () => {
    it('places the event on its date and routes it via the helper', () => {
        const ev = makeEvent({ id: 'a', timeH: localTimeH(2026, 7, 3, 20, 0), route: Route.injection });
        const range = buildHeatmapRange([ev], localMid(2026, 7, 4), 21);
        // Find the cell for 2026-07-03 (Friday).
        const cell = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === '2026-07-03');
        expect(cell).toBeDefined();
        expect(cell!.events.some((e) => e.id === 'a')).toBe(true);
        expect(routesOfCell(cell!)).toEqual([Route.injection]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — same day multiple events', () => {
    it('aggregates multiple events on the same day into one cell', () => {
        const events = [
            makeEvent({ id: 'ev-1', timeH: localTimeH(2026, 7, 4, 7, 0), route: Route.sublingual }),
            makeEvent({ id: 'ev-2', timeH: localTimeH(2026, 7, 4, 20, 0), route: Route.oral, ester: Ester.CPA }),
            makeEvent({ id: 'ev-3', timeH: localTimeH(2026, 7, 4, 22, 0), route: Route.injection }),
        ];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        const cell = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === '2026-07-04');
        expect(cell).toBeDefined();
        const rows = timeSortedCellRows(cell!);
        expect(rows.map((r) => r.route)).toEqual([Route.sublingual, Route.oral, Route.injection]);
        expect(rows.map((r) => r.timeH)).toEqual([
            localTimeH(2026, 7, 4, 7, 0),
            localTimeH(2026, 7, 4, 20, 0),
            localTimeH(2026, 7, 4, 22, 0),
        ]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — today marker', () => {
    it('flags exactly one cell as today', () => {
        const events = [makeEvent({ timeH: localTimeH(2026, 7, 4, 7, 0) })];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        const todayCells = range.weeks.flatMap((w) => w.days).filter((c) => c.isToday);
        expect(todayCells.length).toBe(1);
        expect(todayCells[0].dateKey).toBe('2026-07-04');
    });

    it('marks days strictly after today as isFuture', () => {
        const events = [makeEvent({ timeH: localTimeH(2026, 7, 4, 7, 0) })];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        const futureCells = range.weeks.flatMap((w) => w.days).filter((c) => c.isFuture);
        // Today + 21d of padding then snapped forward to Sunday → at least 21.
        expect(futureCells.length).toBeGreaterThanOrEqual(21);
        // ...but no farther than the nearest Sunday after today + 21d.
        // 2026-07-04 (Sat) + 21d = 2026-07-25 (Sat), snap to 2026-07-26 (Sun) → 22.
        expect(futureCells.length).toBeLessThanOrEqual(22);
        for (const c of futureCells) {
            expect(c.date.getTime()).toBeGreaterThan(range.today.getTime());
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — patch apply without remove', () => {
    it('shows the apply event only on its own day', () => {
        const apply = makeEvent({
            id: 'patch-apply',
            route: Route.patchApply,
            timeH: localTimeH(2026, 7, 4, 8, 0),
        });
        const range = buildHeatmapRange([apply], localMid(2026, 7, 4), 21);

        const applyDay = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === '2026-07-04');
        expect(applyDay).toBeDefined();
        expect(applyDay!.events.some((e) => e.id === 'patch-apply')).toBe(true);

        // The next day must NOT carry the apply event synthetically.
        const next = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === '2026-07-05');
        expect(next!.events.some((e) => e.id === 'patch-apply')).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — patch apply + remove (modern companionGroupId)', () => {
    it('propagates the apply event across every day from apply to remove inclusive', () => {
        const gid = 'pair-001';
        const apply = makeEvent({
            id: 'apply-1',
            route: Route.patchApply,
            timeH: localTimeH(2026, 7, 4, 8, 0),
            companionGroupId: gid,
        });
        const remove = makeEvent({
            id: 'remove-1',
            route: Route.patchRemove,
            timeH: localTimeH(2026, 7, 8, 8, 0),
            companionGroupId: gid,
        });
        const range = buildHeatmapRange([apply, remove], localMid(2026, 7, 4), 21);

        // 2026-07-04 .. 2026-07-08 inclusive should all show apply-1.
        for (const dateKey of ['2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']) {
            const cell = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === dateKey);
            expect(cell, `cell for ${dateKey}`).toBeDefined();
            expect(cell!.events.some((e) => e.id === 'apply-1'), `${dateKey} should carry apply`).toBe(true);
        }

        // 2026-07-09 (the day after remove) must NOT carry apply.
        const afterRemove = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === '2026-07-09');
        if (afterRemove) {
            expect(afterRemove.events.some((e) => e.id === 'apply-1')).toBe(false);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — patch apply + remove (legacy, no companionGroupId)', () => {
    it('falls back to time-axis pairing so the segment still propagates', () => {
        const apply = makeEvent({
            id: 'legacy-apply',
            route: Route.patchApply,
            timeH: localTimeH(2026, 7, 4, 8, 0),
        });
        const remove = makeEvent({
            id: 'legacy-remove',
            route: Route.patchRemove,
            timeH: localTimeH(2026, 7, 8, 8, 0),
        });
        const range = buildHeatmapRange([apply, remove], localMid(2026, 7, 4), 21);

        for (const k of ['2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']) {
            const cell = range.weeks.flatMap((w) => w.days).find((c) => c.dateKey === k);
            expect(cell!.events.some((e) => e.id === 'legacy-apply'), `${k} should carry apply`).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — week alignment', () => {
    it('always returns 7 cells per column', () => {
        const events = [makeEvent({ timeH: localTimeH(2026, 7, 4, 8, 0) })];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        for (const w of range.weeks) {
            expect(w.days.length).toBe(7);
        }
    });

    it('places the month label on the column where each new month first appears', () => {
        // Today = 2026-07-04 (Sat). Spread events across all 12 months so the
        // range starts in late June (week of 2026-06-29) and runs through
        // early January 2027, exercising multiple month-boundary labels.
        const events: DoseEvent[] = [];
        for (let m = 1; m <= 12; m++) {
            events.push(makeEvent({
                id: `ev-${m}`,
                timeH: localTimeH(2026, m, 15, 8, 0),
            }));
        }
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        const labelsOnCols = range.weeks.map((w) => w.monthLabel ?? '');
        const distinctLabels = Array.from(new Set(labelsOnCols.filter((s) => s !== '')));
        // Must include the latest event's month (Sep first appearance for the
        // event-on-2026-09-15 case) and at least 2 distinct month labels in
        // total. The exact first label depends on the Monday of the first
        // event's week (Jun for this fixture).
        expect(distinctLabels.length).toBeGreaterThanOrEqual(3);
        expect(labelsOnCols).toContain('Sep');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildHeatmapRange — end-date selection', () => {
    it('extends past today + futurePadDays when there are later events', () => {
        // Today = 2026-07-04, pad = 21d → expected end ~2026-07-25 unless an
        // event is later. Add an event on 2026-12-15 to push the window far
        // beyond the future-pad.
        const events = [
            makeEvent({ timeH: localTimeH(2026, 6, 1, 7, 0) }),
            makeEvent({ timeH: localTimeH(2026, 12, 15, 20, 0) }),
        ];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        // The last day rendered must be ≥ 2026-12-15.
        expect(range.endDate.getTime()).toBeGreaterThanOrEqual(localMid(2026, 12, 15).getTime());
    });

    it('falls back to today + futurePadDays when the latest event is in the past', () => {
        const events = [
            makeEvent({ timeH: localTimeH(2026, 1, 5, 7, 0) }),
            makeEvent({ timeH: localTimeH(2026, 6, 30, 20, 0) }),
        ];
        const range = buildHeatmapRange(events, localMid(2026, 7, 4), 21);
        // End must be at least today + 21d → 2026-07-25.
        expect(range.endDate.getTime()).toBeGreaterThanOrEqual(localMid(2026, 7, 25).getTime());
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('monthLabelFor', () => {
    it('returns "N月" for zh / zh-TW (numeric + 月 format)', () => {
        const d = new Date(2026, 5, 1, 0, 0, 0, 0); // June
        expect(monthLabelFor(d, undefined, 'zh')).toBe('6月');
        expect(monthLabelFor(d, undefined, 'zh-TW')).toBe('6月');
    });

    it('returns English short label by default', () => {
        const d = new Date(2026, 5, 1, 0, 0, 0, 0);
        expect(monthLabelFor(d)).toBe('Jun');
    });

    it('returns English short label when lang is en/ja', () => {
        const d = new Date(2026, 5, 1, 0, 0, 0, 0);
        expect(monthLabelFor(d, undefined, 'en')).toBe('Jun');
        expect(monthLabelFor(d, undefined, 'ja')).toBe('Jun');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('upcomingPlanRowsForCell — future plan tooltip', () => {
    /** Minimal HeatmapDayCell fixture for unit-testing the row builder. */
    function makeCell(y: number, m: number, d: number): HeatmapDayCell {
        const date = new Date(y, m - 1, d, 0, 0, 0, 0);
        return {
            date,
            dateKey: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
            events: [],
            isToday: false,
            isFuture: true,
        };
    }

    function makePlan(overrides: Partial<Plan> = {}): Plan {
        return {
            id: overrides.id ?? 'plan-1',
            ester: overrides.ester ?? Ester.EV,
            route: overrides.route ?? Route.injection,
            doseMG: overrides.doseMG ?? 5,
            schedule: overrides.schedule ?? { kind: 'daily', times: ['20:00'] },
            startDateH: overrides.startDateH ?? localTimeH(2026, 7, 1, 0, 0),
            endDateH: overrides.endDateH,
            enabled: overrides.enabled ?? true,
            leadMinutes: overrides.leadMinutes ?? 5,
            label: overrides.label,
            extras: overrides.extras ?? {},
            createdAtH: 0,
            updatedAtH: 0,
        };
    }

    it('emits one row per daily plan fire on the cell date', () => {
        const plan = makePlan({ id: 'p-daily', schedule: { kind: 'daily', times: ['08:00', '20:00'] } });
        const cell = makeCell(2026, 7, 4);
        const rows = upcomingPlanRowsForCell(cell, [plan]);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => new Date(r.timeH * 3600000).getHours())).toEqual([8, 20]);
        expect(rows[0].source).toBe('plan');
    });

    it('ignores disabled plans', () => {
        const plan = makePlan({ enabled: false });
        const rows = upcomingPlanRowsForCell(makeCell(2026, 7, 4), [plan]);
        expect(rows).toHaveLength(0);
    });

    it('emits no rows when no plan fires that day', () => {
        // every_n_days with interval=7, anchored at 2026-07-01. Next fires:
        // 07-01, 07-08, 07-15, … so 07-04 is between fires → no row.
        const plan = makePlan({
            schedule: { kind: 'every_n_days', intervalDays: 7, times: ['20:00'] },
            startDateH: localTimeH(2026, 7, 1, 0, 0),
        });
        const rows = upcomingPlanRowsForCell(makeCell(2026, 7, 4), [plan]);
        expect(rows).toHaveLength(0);
    });

    it('sorts rows from multiple plans / fires by timeH ascending', () => {
        const p1 = makePlan({ id: 'a', ester: Ester.EV, schedule: { kind: 'daily', times: ['22:00'] } });
        const p2 = makePlan({ id: 'b', ester: Ester.CPA, schedule: { kind: 'daily', times: ['08:00'] } });
        const rows = upcomingPlanRowsForCell(makeCell(2026, 7, 4), [p1, p2]);
        expect(rows.map((r) => String(r.ester))).toEqual(['CPA', 'EV']);
    });
});
