import { describe, it, expect } from 'vitest';
import { parseImportedBackup, importHasContent, importFallbackWeight } from './importData';
import { Ester, Route } from '../../types';

const ev = { timeH: 100, doseMG: 1.5, route: 'gel', ester: 'E2', weightKG: 70, extras: {} };
const lab = { timeH: 50, concValue: 120, unit: 'pmol/l' };
const gel = { id: 1000, name: 'X', kPenBase: 0.14, kLoss: 1.26, kRel: 0.022, concentrationMGmL: 1, defaultAreaCM2: 400 };

describe('parseImportedBackup — partial sections use null = "keep existing"', () => {
    it('gel-only backup: labResults and events sections are absent → null', () => {
        const r = parseImportedBackup({ gelProducts: [gel] }, 70);
        expect(r.events).toEqual([]);          // no events section
        expect(r.labResults).toBeNull();       // absent → keep existing
        expect(r.gelProducts).toHaveLength(1); // present
        expect(importHasContent(r)).toBe(true);
    });

    it('events-only legacy top-level array: labs/gel absent → null (labs preserved)', () => {
        const r = parseImportedBackup([ev], 70);
        expect(r.events).toHaveLength(1);
        expect(r.labResults).toBeNull();
        expect(r.gelProducts).toBeNull();
    });

    it('labResults: [] is PRESENT-but-empty → [] (clears), not null', () => {
        const r = parseImportedBackup({ labResults: [] }, 70);
        expect(r.labResults).toEqual([]);      // present → clear
        expect(importHasContent(r)).toBe(true); // valid import (intent: clear labs)
    });

    it('full backup overwrites all three sections', () => {
        const r = parseImportedBackup({ events: [ev], labResults: [lab], gelProducts: [gel] }, 70);
        expect(r.events).toHaveLength(1);
        expect(r.labResults).toHaveLength(1);
        expect(r.gelProducts).toHaveLength(1);
    });

    it('empty object / garbage is not valid content', () => {
        expect(importHasContent(parseImportedBackup({}, 70))).toBe(false);
        expect(importHasContent(parseImportedBackup(42, 70))).toBe(false);
    });

    it('counts rows migrated for missing per-dose weight, using fallback', () => {
        const r = parseImportedBackup({ events: [{ timeH: 1, doseMG: 1, route: 'gel', ester: 'E2', extras: {} }] }, 65);
        expect(r.events[0].weightKG).toBe(65);
        expect(r.migratedCount).toBe(1);
    });

    it('accepts EU injection rows through the enum validator', () => {
        const r = parseImportedBackup({
            events: [{ timeH: 1, doseMG: 100, route: Route.injection, ester: Ester.EU, weightKG: 70, extras: {} }],
        }, 70);
        expect(r.events).toHaveLength(1);
        expect(r.events[0].route).toBe(Route.injection);
        expect(r.events[0].ester).toBe(Ester.EU);
    });

    it('drops rows with unknown route or ester instead of force-casting them', () => {
        const r = parseImportedBackup({
            events: [
                ev,
                { timeH: 1, doseMG: 100, route: 'injection', ester: 'EUU', weightKG: 70, extras: {} },
                { timeH: 2, doseMG: 100, route: 'implant', ester: 'EU', weightKG: 70, extras: {} },
            ],
        }, 70);
        expect(r.events).toHaveLength(1);
        expect(r.events[0].ester).toBe(Ester.E2);
    });

    it('drops corrupt gel products via the shared sanitizer (id<1000, NaN rate)', () => {
        const r = parseImportedBackup({ gelProducts: [gel, { id: 1, ...gel, id2: 0 }, { id: 1001, name: 'bad', kPenBase: NaN, kLoss: 1, kRel: 1 }] }, 70);
        expect(r.gelProducts).toHaveLength(1);
        expect(r.gelProducts![0].id).toBe(1000);
    });
});

describe('importFallbackWeight', () => {
    it('uses top-level weight when valid, else the default', () => {
        expect(importFallbackWeight({ weight: 80 }, 70)).toBe(80);
        expect(importFallbackWeight({ weight: -5 }, 70)).toBe(70);
        expect(importFallbackWeight([], 70)).toBe(70);
    });
});
