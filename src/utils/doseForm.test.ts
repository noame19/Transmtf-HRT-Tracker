import { describe, it, expect } from 'vitest';
import { Ester, Route } from '../../types';
import {
    getAvailableEsters,
    hasQuickDosePanel,
    isPresetDose,
    drugKeyOf,
    DOSE_QUICK_PRESETS,
} from './doseForm';

// ───────────────────────────────────────────────────────────────────────────
// Per-route compound allow-list + quick-dose panel keying.
//
// Background: DoseFormModal's ester selector only renders when
// `availableEsters.length > 1`, so `getAvailableEsters(Route.rectal)` had to
// include more than just PROG once the user asked for a generalised rectal
// route (the original lock-down made the dropdown silently disappear and
// blocked any non-PROG rectal dose from being entered).

describe('getAvailableEsters', () => {
    it('rectal includes PROG for backwards compatibility (still the default)', () => {
        const esters = getAvailableEsters(Route.rectal);
        expect(esters).toContain(Ester.PROG);
    });

    it('rectal exposes the entire estradiol ester family so the ester dropdown is visible', () => {
        // Regression: previously `getAvailableEsters(Route.rectal)` returned
        // `[Ester.PROG]` (length = 1), which made DoseFormModal hide the
        // ester selector (`availableEsters.length > 1` gate) and prevented the
        // user from picking any other compound for rectal dosing.
        const esters = getAvailableEsters(Route.rectal);
        expect(esters.length).toBeGreaterThan(1);
        for (const e of [Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EU]) {
            expect(esters, `expected ${e} on rectal`).toContain(e);
        }
    });

    it('does not put any route + ester into an illegal cross-table that hasQuickDosePanel would lie about', () => {
        // hasQuickDosePanel must agree with the actual presets table — if a
        // (rectal, E2) entry were absent the panel would silently no-op. This
        // is the same invariant the runtime readLastDrug relies on.
        const rectal = getAvailableEsters(Route.rectal);
        for (const e of rectal) {
            const has = hasQuickDosePanel(Route.rectal, e);
            const presetListed = !!DOSE_QUICK_PRESETS[drugKeyOf(Route.rectal, e)];
            expect(has, `hasQuickDosePanel mismatch for rectal:${e}`).toBe(presetListed);
        }
    });
});

describe('presets for the newly exposed rectal estradiol entries', () => {
    // PROG keeps its bedside suppository preset (50/100/150/200). Non-PROG
    // rectal entries share no published PK-derived preset, so the panel
    // should remain hidden for them — the form will fall back to manual input.
    it('keeps the PROG rectal preset intact', () => {
        expect(DOSE_QUICK_PRESETS[`${Route.rectal}:${Ester.PROG}`]).toEqual([50, 100, 150, 200]);
    });

    it('non-PROG rectal combinations have no preset (panel hidden, manual input used)', () => {
        for (const e of [Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EU]) {
            expect(hasQuickDosePanel(Route.rectal, e), `rectal ${e} should not show presets`).toBe(false);
            expect(isPresetDose(Route.rectal, e, 100), `rectal ${e} isPresetDose`).toBe(false);
        }
    });
});
