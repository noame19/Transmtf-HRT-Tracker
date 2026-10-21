import { describe, it, expect } from 'vitest';
import {
    DEFAULT_HEIGHT_CM,
    DEFAULT_WEIGHT_KG,
    backfillEventHeights,
    eventsNeedHeightMigration,
    eventsNeedWeightMigration,
    findLatestHeight,
    prefillHeightCM,
    resolveBodyStats,
} from './weight';
import { Ester, ExtraKey, Route, type DoseEvent } from '../lib/types';

const mk = (over: Partial<DoseEvent> & { timeH: number }): DoseEvent => ({
    id: `e-${over.timeH}`,
    route: Route.oral,
    ester: Ester.E2,
    doseMG: 2,
    weightKG: 55,
    extras: {} as Partial<Record<ExtraKey, number>>,
    ...over,
});

describe('eventsNeedHeightMigration', () => {
    it('flags rows with a missing / non-positive / non-numeric height', () => {
        expect(eventsNeedHeightMigration([mk({ timeH: 1 })])).toBe(true);
        expect(eventsNeedHeightMigration([mk({ timeH: 1, heightCm: 0 })])).toBe(true);
        expect(eventsNeedHeightMigration([mk({ timeH: 1, heightCm: Number.NaN })])).toBe(true);
        expect(eventsNeedHeightMigration([mk({ timeH: 1, heightCm: 176 })])).toBe(false);
        expect(eventsNeedHeightMigration([])).toBe(false);
        expect(eventsNeedHeightMigration(null)).toBe(false);
    });

    it('does not mistake a present weight for a present height', () => {
        // The whole bug in one assertion: weight was backfilled on every row
        // long ago, so eventsNeedWeightMigration says "clean" while every
        // height is still absent.
        const events = [mk({ timeH: 1, weightKG: 55 }), mk({ timeH: 2, weightKG: 56 })];
        expect(eventsNeedWeightMigration(events)).toBe(false);
        expect(eventsNeedHeightMigration(events)).toBe(true);
    });
});

describe('backfillEventHeights — nearest measured value, never a fake constant', () => {
    it('fills gaps from the nearest measurement on either side', () => {
        const events = [
            mk({ timeH: 10 }),                      // before first measurement
            mk({ timeH: 20, heightCm: 170 }),
            mk({ timeH: 30 }),                      // between
            mk({ timeH: 40, heightCm: 172 }),
            mk({ timeH: 50 }),                      // after last measurement
        ];
        const out = backfillEventHeights(events);
        expect(out.map(e => e.heightCm)).toEqual([170, 170, 170, 172, 172]);
    });

    it('breaks ties toward the earlier measurement', () => {
        const events = [
            mk({ timeH: 10, heightCm: 160 }),
            mk({ timeH: 20 }),
            mk({ timeH: 30, heightCm: 180 }),
        ];
        // 20 is equidistant; prefer the earlier (160) — a later growth spurt
        // should not retroactively rewrite older records.
        expect(backfillEventHeights(events)[1].heightCm).toBe(160);
    });

    it('leaves rows untouched when the log has no measurement at all', () => {
        const events = [mk({ timeH: 10 }), mk({ timeH: 20 })];
        const out = backfillEventHeights(events);
        expect(out).toHaveLength(2);
        out.forEach(e => expect(e.heightCm).toBeUndefined());
    });

    it('uses the explicit fallback only when nothing was ever measured', () => {
        const events = [mk({ timeH: 10 })];
        expect(backfillEventHeights(events, 165)[0].heightCm).toBe(165);
        expect(backfillEventHeights(events, Number.NaN)[0].heightCm).toBeUndefined();
        expect(backfillEventHeights(events, -1)[0].heightCm).toBeUndefined();
    });

    it('never overwrites a real height, even one far from its neighbours', () => {
        const events = [
            mk({ timeH: 10, heightCm: 150 }),
            mk({ timeH: 20, heightCm: 200 }), // suspicious, but not ours to fix
            mk({ timeH: 30, heightCm: 151 }),
        ];
        expect(backfillEventHeights(events).map(e => e.heightCm)).toEqual([150, 200, 151]);
    });

    it('is idempotent and preserves event identity for already-clean rows', () => {
        const clean = [mk({ timeH: 10, heightCm: 176 })];
        const once = backfillEventHeights(clean);
        expect(once[0]).toBe(clean[0]);         // same object reference
        expect(backfillEventHeights(once)[0]).toBe(clean[0]);
    });

    it('does not mutate the input array', () => {
        const events = [mk({ timeH: 10 }), mk({ timeH: 20, heightCm: 170 })];
        const snapshot = JSON.stringify(events);
        backfillEventHeights(events);
        expect(JSON.stringify(events)).toBe(snapshot);
    });

    it('drops non-object junk instead of crashing on it', () => {
        const events = [null, undefined, 42, mk({ timeH: 10, heightCm: 170 })] as unknown as DoseEvent[];
        const out = backfillEventHeights(events);
        expect(out).toHaveLength(1);
        expect(out[0].heightCm).toBe(170);
    });
});

describe('resolveBodyStats — the single entry point for non-form write paths', () => {
    it('prefers the newest measured height even when newer rows lost it', () => {
        // Exactly the shape produced by old one-tap confirms: the 176 cm
        // measurement sits in the past, while the rows created since then
        // carry weight but no height.
        const events = [
            mk({ timeH: 10, heightCm: 176 }),
            mk({ timeH: 20, weightKG: 54 }),
            mk({ timeH: 30, weightKG: 53 }),
        ];
        expect(resolveBodyStats(events)).toEqual({ weightKG: 53, heightCm: 176 });
    });

    it('falls back to the documented defaults on an empty log', () => {
        expect(resolveBodyStats([])).toEqual({
            weightKG: DEFAULT_WEIGHT_KG,
            heightCm: DEFAULT_HEIGHT_CM,
        });
    });

    it('agrees with the individual prefill helpers', () => {
        const events = [mk({ timeH: 5, heightCm: 168, weightKG: 60 })];
        const stats = resolveBodyStats(events);
        expect(stats.heightCm).toBe(findLatestHeight(events));
        expect(stats.heightCm).toBe(prefillHeightCM(events));
    });
});
