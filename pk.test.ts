import { describe, it, expect } from 'vitest';
import { Route, Ester, type DoseEvent, type LabResult } from './types';
import {
    bicalutamideConcNgML,
    runSimulation,
    isAntiandrogen,
    pickPrimaryAntiandrogen,
    ANTIANDROGENS,
    GelSite,
    GEL_PRODUCTS,
    GEL_SITE_FACTORS,
    gel3CompCentralAmount,
    gelEventCentralAmount,
    resolveGelKinetics,
    setCustomGelProducts,
    sanitizeGelProduct,
    gelProductExists,
    type GelProductSpec,
    CorePK,
} from './pk';
import { computeSimulationWithCI, initPersonalModel, replayPersonalModel } from './personalModel';

const HOUR = 1;
const DAY = 24;

function bicaEvent(timeH: number, doseMG = 50): DoseEvent {
    return {
        id: `bica-${timeH}`,
        route: Route.oral,
        timeH,
        doseMG,
        ester: Ester.BICA,
        weightKG: 70,
        extras: {},
    };
}

describe('antiandrogen registry', () => {
    it('classifies CPA and BICA as anti-androgens, E2 as not', () => {
        expect(isAntiandrogen(Ester.CPA)).toBe(true);
        expect(isAntiandrogen(Ester.BICA)).toBe(true);
        expect(isAntiandrogen(Ester.E2)).toBe(false);
        expect(isAntiandrogen(Ester.EV)).toBe(false);
    });

    it('exposes a spec for each anti-androgen with a positive CI cap', () => {
        expect(ANTIANDROGENS[Ester.CPA]).toBeTruthy();
        expect(ANTIANDROGENS[Ester.BICA]).toBeTruthy();
        expect(ANTIANDROGENS[Ester.BICA]!.ciMaxNative).toBeGreaterThan(1000);
    });
});

describe('bicalutamide single 50 mg dose PK', () => {
    const dose = [bicaEvent(0, 50)];

    // Sample the analytic curve directly (no simulation-grid time bound).
    const sample = (h: number) => bicalutamideConcNgML(dose, h);

    it('peaks (Tmax) around 31 h (accept 24–40 h)', () => {
        let tmax = 0;
        let cmax = 0;
        for (let h = 1; h <= 96; h += 0.5) {
            const c = sample(h);
            if (c > cmax) { cmax = c; tmax = h; }
        }
        expect(tmax).toBeGreaterThanOrEqual(24);
        expect(tmax).toBeLessThanOrEqual(40);
    });

    it('reaches a single-dose Cmax near 0.77 µg/mL (accept 580–960 ng/mL)', () => {
        let cmax = 0;
        for (let h = 1; h <= 96; h += 0.5) cmax = Math.max(cmax, sample(h));
        expect(cmax).toBeGreaterThanOrEqual(580);
        expect(cmax).toBeLessThanOrEqual(960);
    });

    it('has a terminal half-life near 5.8 d (accept 4.5–7.5 d)', () => {
        const t1 = 8 * DAY;
        const t2 = 13 * DAY;
        const c1 = sample(t1);
        const c2 = sample(t2);
        expect(c1).toBeGreaterThan(0);
        expect(c2).toBeGreaterThan(0);
        expect(c2).toBeLessThan(c1); // terminal decay
        const halfLifeH = (Math.log(2) * (t2 - t1)) / Math.log(c1 / c2);
        const halfLifeD = halfLifeH / 24;
        expect(halfLifeD).toBeGreaterThanOrEqual(4.5);
        expect(halfLifeD).toBeLessThanOrEqual(7.5);
    });
});

describe('bicalutamide 50 mg once-daily steady state', () => {
    it('approaches ~9 µg/mL by day 42–45 (accept 7000–11000 ng/mL)', () => {
        const events: DoseEvent[] = [];
        for (let day = 0; day < 56; day++) events.push(bicaEvent(day * DAY, 50));
        const cDay45 = bicalutamideConcNgML(events, 45 * DAY);
        expect(cDay45).toBeGreaterThanOrEqual(7000);
        expect(cDay45).toBeLessThanOrEqual(11000);
    });
});

describe('runSimulation byCompound', () => {
    it('produces a positive BICA component series', () => {
        const events = [bicaEvent(0, 50), bicaEvent(DAY, 50), bicaEvent(2 * DAY, 50)];
        const sim = runSimulation(events)!;
        expect(sim).toBeTruthy();
        const bica = sim.byCompound[Ester.BICA];
        expect(bica).toBeTruthy();
        expect(bica!.values.length).toBe(sim.timeH.length);
        expect(Math.max(...bica!.values)).toBeGreaterThan(0);
    });

    it('keeps the legacy concPGmL_CPA mirror consistent with byCompound[CPA]', () => {
        const cpa: DoseEvent[] = [
            { id: 'c1', route: Route.oral, timeH: 0, doseMG: 50, ester: Ester.CPA, weightKG: 70, extras: {} },
            { id: 'c2', route: Route.oral, timeH: DAY, doseMG: 50, ester: Ester.CPA, weightKG: 70, extras: {} },
        ];
        const sim = runSimulation(cpa)!;
        const cpaSeries = sim.byCompound[Ester.CPA];
        expect(cpaSeries).toBeTruthy();
        expect(cpaSeries!.values).toEqual(sim.concPGmL_CPA);
        expect(Math.max(...sim.concPGmL_CPA)).toBeGreaterThan(0);
    });
});

describe('CPA + BICA coexisting', () => {
    function cpaEvent(timeH: number, doseMG = 50): DoseEvent {
        return { id: `cpa-${timeH}`, route: Route.oral, timeH, doseMG, ester: Ester.CPA, weightKG: 70, extras: {} };
    }
    function e2Inj(timeH: number): DoseEvent {
        return { id: `e2-${timeH}`, route: Route.injection, timeH, doseMG: 5, ester: Ester.EV, weightKG: 70, extras: {} };
    }

    const events: DoseEvent[] = [];
    for (let day = 0; day < 56; day++) {
        events.push(cpaEvent(day * DAY, 50));
        events.push(bicaEvent(day * DAY, 50));
    }
    events.push(e2Inj(0));

    it('produces independent CPA and BICA component series', () => {
        const sim = runSimulation(events)!;
        expect(sim.byCompound[Ester.CPA]).toBeTruthy();
        expect(sim.byCompound[Ester.BICA]).toBeTruthy();
        expect(Math.max(...sim.byCompound[Ester.CPA]!.values)).toBeGreaterThan(0);
        expect(Math.max(...sim.byCompound[Ester.BICA]!.values)).toBeGreaterThan(0);
        // concPGmL_CPA mirrors byCompound[CPA]
        expect(sim.byCompound[Ester.CPA]!.values).toEqual(sim.concPGmL_CPA);
    });

    it('never folds BICA into the E2 total curve (concPGmL = E2 + CPA·1000 only)', () => {
        const sim = runSimulation(events)!;
        const cpa = sim.byCompound[Ester.CPA]!.values;
        for (let i = 0; i < sim.timeH.length; i += Math.ceil(sim.timeH.length / 20)) {
            const expected = sim.concPGmL_E2[i] + cpa[i] * 1000;
            expect(Math.abs(sim.concPGmL[i] - expected)).toBeLessThan(1e-6);
        }
    });

    it('applies per-compound CI caps (CPA ≤ 500, BICA can exceed 500 up to its own cap)', () => {
        const sim = runSimulation(events)!;
        const ci = computeSimulationWithCI(sim, events, initPersonalModel(), true, [], 'ekf', false);
        const cpaAdj = ci.antiandrogen[Ester.CPA]!.adjusted;
        const bicaAdj = ci.antiandrogen[Ester.BICA]!.adjusted;
        expect(Math.max(...cpaAdj)).toBeLessThanOrEqual(ANTIANDROGENS[Ester.CPA]!.ciMaxNative);
        // BICA steady state (~9000 ng/mL) must NOT be clipped by CPA's 500 cap.
        expect(Math.max(...bicaAdj)).toBeGreaterThan(500);
        expect(Math.max(...bicaAdj)).toBeLessThanOrEqual(ANTIANDROGENS[Ester.BICA]!.ciMaxNative);
    });

    it('does not apply E2 adherence scaling to BICA, but does to CPA', () => {
        const sim = runSimulation(events)!;
        // Non-zero adherence amplitude exp(theta0)=1.5, learning ON.
        const state = initPersonalModel();
        state.thetaMean = [Math.log(1.5), 0];
        const ci = computeSimulationWithCI(sim, events, state, true, [], 'ekf', false);

        const bicaAdj = ci.antiandrogen[Ester.BICA]!.adjusted;
        const bicaRaw = sim.byCompound[Ester.BICA]!.values;
        const bicaCap = ANTIANDROGENS[Ester.BICA]!.ciMaxNative;
        // BICA must be untouched by theta (scale fixed at 1).
        for (let i = 0; i < bicaAdj.length; i += Math.ceil(bicaAdj.length / 20)) {
            expect(Math.abs(bicaAdj[i] - Math.min(bicaRaw[i], bicaCap))).toBeLessThan(1e-6);
        }

        // CPA must be scaled by exp(theta0)=1.5 (below its cap).
        const cpaAdj = ci.antiandrogen[Ester.CPA]!.adjusted;
        const cpaRaw = sim.byCompound[Ester.CPA]!.values;
        const idx = cpaRaw.findIndex(v => v > 1 && v < 300);
        expect(idx).toBeGreaterThan(-1);
        expect(cpaAdj[idx]).toBeCloseTo(cpaRaw[idx] * 1.5, 4);
    });

    it('exposes a BICA population CI band even with NO E2 lab (initPersonalModel)', () => {
        const bicaEvents = [bicaEvent(0, 50), bicaEvent(DAY, 50), bicaEvent(2 * DAY, 50)];
        const sim = runSimulation(bicaEvents)!;
        const ci = computeSimulationWithCI(sim, bicaEvents, initPersonalModel(), false, [], 'ekf', false);
        const b = ci.antiandrogen[Ester.BICA]!;
        const i = b.adjusted.findIndex(v => v > 100);
        expect(i).toBeGreaterThan(-1);
        expect(b.ci95High[i]).toBeGreaterThan(b.adjusted[i]);
        expect(b.ci95Low[i]).toBeLessThan(b.adjusted[i]);
        expect(b.ci95Low[i]).toBeGreaterThan(0);
    });

    it('a BICA-only lab does NOT unlock E2 EKF (postDoseObservationCount stays 0)', () => {
        const evs = [bicaEvent(0, 50)];
        const labs: LabResult[] = [{ id: 'l1', timeH: 5 * DAY, concValue: 50, unit: 'pg/ml' }];
        const state = replayPersonalModel(evs, labs);
        expect(state.postDoseObservationCount).toBe(0);
    });
});

describe('pickPrimaryAntiandrogen', () => {
    const cpa = (timeH: number): DoseEvent => ({ id: `c${timeH}`, route: Route.oral, timeH, doseMG: 50, ester: Ester.CPA, weightKG: 70, extras: {} });

    it('returns null when there are no anti-androgen doses', () => {
        const e2: DoseEvent = { id: 'e', route: Route.injection, timeH: 0, doseMG: 5, ester: Ester.EV, weightKG: 70, extras: {} };
        expect(pickPrimaryAntiandrogen([e2], 10 * DAY)).toBeNull();
    });

    it('picks the most recently dosed anti-androgen at or before now', () => {
        expect(pickPrimaryAntiandrogen([cpa(0), bicaEvent(DAY)], 2 * DAY)).toBe(Ester.BICA);
        expect(pickPrimaryAntiandrogen([bicaEvent(0), cpa(DAY)], 2 * DAY)).toBe(Ester.CPA);
    });

    it('ignores future doses when an earlier dose is already taken', () => {
        expect(pickPrimaryAntiandrogen([cpa(0), bicaEvent(10 * DAY)], DAY)).toBe(Ester.CPA);
    });

    it('falls back to the soonest upcoming when all doses are in the future', () => {
        expect(pickPrimaryAntiandrogen([bicaEvent(10 * DAY), cpa(5 * DAY)], 0)).toBe(Ester.CPA);
    });

    it('handles single-compound histories', () => {
        expect(pickPrimaryAntiandrogen([cpa(0), cpa(DAY)], 2 * DAY)).toBe(Ester.CPA);
        expect(pickPrimaryAntiandrogen([bicaEvent(0), bicaEvent(DAY)], 2 * DAY)).toBe(Ester.BICA);
    });

    it('counts a dose exactly at now as already taken', () => {
        expect(pickPrimaryAntiandrogen([cpa(0), bicaEvent(2 * DAY)], 2 * DAY)).toBe(Ester.BICA);
    });

    it('with nowH omitted, picks the latest dose by time (including future)', () => {
        expect(pickPrimaryAntiandrogen([cpa(0), bicaEvent(10 * DAY)])).toBe(Ester.BICA);
    });

    it('breaks ties on equal timeH by event order (last recorded wins)', () => {
        expect(pickPrimaryAntiandrogen([cpa(DAY), bicaEvent(DAY)], 2 * DAY)).toBe(Ester.BICA);
        expect(pickPrimaryAntiandrogen([bicaEvent(DAY), cpa(DAY)], 2 * DAY)).toBe(Ester.CPA);
    });
});

describe('layered transdermal gel model', () => {
    const oestrogel = GEL_PRODUCTS[0];
    const ke = CorePK.kClear;

    // Numerically integrate central(t)*ke = total amount cleared, which at t→∞
    // equals the total that ever entered the central compartment.
    const clearedFraction = (kPen: number, kLoss: number, kRel: number, wash?: number) => {
        const dt = 0.01;
        let auc = 0;
        for (let t = dt; t <= 3000; t += dt) auc += gel3CompCentralAmount(1, t, kPen, kLoss, kRel, ke, wash) * dt;
        return auc * ke;
    };

    it('conserves mass: absorbed fraction = kPen/(kPen+kLoss)', () => {
        const { kPen, kLoss, kRel } = resolveGelKinetics(oestrogel, GelSite.arm, oestrogel.refDoseMG, oestrogel.defaultAreaCM2);
        const expected = kPen / (kPen + kLoss);
        expect(clearedFraction(kPen, kLoss, kRel)).toBeCloseTo(expected, 3);
    });

    it('peaks (tmax) in the labelled 4–16 h window', () => {
        const { kPen, kLoss, kRel } = resolveGelKinetics(oestrogel, GelSite.thigh, 1.5, oestrogel.defaultAreaCM2);
        let tmax = 0, peak = 0;
        for (let t = 0.1; t <= 96; t += 0.1) {
            const m = gel3CompCentralAmount(1.5, t, kPen, kLoss, kRel, ke);
            if (m > peak) { peak = m; tmax = t; }
        }
        expect(tmax).toBeGreaterThanOrEqual(4);
        expect(tmax).toBeLessThanOrEqual(16);
    });

    it('1 h wash-off retains ~62–80% of exposure (labels: −22% / −30%)', () => {
        const { kPen, kLoss, kRel } = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, oestrogel.defaultAreaCM2);
        const retention = clearedFraction(kPen, kLoss, kRel, 1) / clearedFraction(kPen, kLoss, kRel);
        expect(retention).toBeGreaterThanOrEqual(0.62);
        expect(retention).toBeLessThanOrEqual(0.80);
    });

    it('scrotal site raises absorbed fraction well above non-genital', () => {
        const arm = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, oestrogel.defaultAreaCM2);
        const scr = resolveGelKinetics(oestrogel, GelSite.scrotal, 1.5, oestrogel.defaultAreaCM2);
        const fArm = arm.kPen / (arm.kPen + arm.kLoss);
        const fScr = scr.kPen / (scr.kPen + scr.kLoss);
        expect(GEL_SITE_FACTORS[GelSite.scrotal]).toBeGreaterThan(GEL_SITE_FACTORS[GelSite.arm]);
        expect(fScr).toBeGreaterThan(fArm * 2);
    });

    it('larger application area raises absorbed fraction (lower dose density)', () => {
        const small = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 200);
        const large = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 1500);
        const fSmall = small.kPen / (small.kPen + small.kLoss);
        const fLarge = large.kPen / (large.kPen + large.kLoss);
        expect(fLarge).toBeGreaterThan(fSmall);
    });

    it('returns 0 for non-physical / non-finite rates (kLoss<0, ke<=0, NaN)', () => {
        expect(gel3CompCentralAmount(1, 10, 0.14, -0.5, 0.022, 0.41)).toBe(0);
        expect(gel3CompCentralAmount(1, 10, 0.14, 1.26, 0.022, 0)).toBe(0);
        expect(gel3CompCentralAmount(1, 10, NaN, 1.26, 0.022, 0.41)).toBe(0);
        expect(gel3CompCentralAmount(1, 10, 0.14, 1.26, 0.022, Infinity)).toBe(0);
    });

    it('sanitizeGelProduct drops only on a non-finite RATE; defaults missing metadata', () => {
        // A missing/NaN kinetic RATE must DROP the product, not fabricate a curve.
        expect(sanitizeGelProduct({ id: 1000, name: 'bad', kPenBase: null, kLoss: null, kRel: null })).toBeNull();
        expect(sanitizeGelProduct({ id: 1000, name: 'bad', kPenBase: NaN, kLoss: 1.26, kRel: 0.022, concentrationMGmL: 1, defaultAreaCM2: 400 })).toBeNull();
        // id below the custom base is rejected (never shadows a preset).
        expect(sanitizeGelProduct({ id: 1, name: 'x', kPenBase: 0.14, kLoss: 1.26, kRel: 0.022 })).toBeNull();
        // Valid rates but missing display metadata → KEPT with sane defaults.
        const meta = sanitizeGelProduct({ id: 1000, name: 'Old', kPenBase: 0.14, kLoss: 1.26, kRel: 0.022, defaultAreaCM2: 400 });
        expect(meta).not.toBeNull();
        expect(meta!.concentrationMGmL).toBe(1.0);
        expect(meta!.refDoseMG).toBeCloseTo(400 * 0.002, 6);
        // finite-but-out-of-range values are clamped, entry kept.
        const ok = sanitizeGelProduct({ id: 1000, name: 'ok', kPenBase: 99, kLoss: -5, kRel: 0.022, concentrationMGmL: 1, defaultAreaCM2: 400 });
        expect(ok).not.toBeNull();
        expect(ok!.kLoss).toBe(0);
        // kRel is held inside the UI-editable half-life window [1, 240] h.
        const slow = sanitizeGelProduct({ id: 1000, name: 'slow', kPenBase: 0.14, kLoss: 1.26, kRel: 0.0001, concentrationMGmL: 1, defaultAreaCM2: 400 });
        expect(Math.log(2) / slow!.kRel).toBeLessThanOrEqual(240 + 1e-9);
    });

    it('a dropped corrupt product leaves its events on the safe default, finite', () => {
        setCustomGelProducts([{ id: 1000, nameKey: '', name: 'bad', concentrationMGmL: 1, defaultAreaCM2: 400, refDoseMG: 1.5, kPenBase: NaN, kLoss: -1, kRel: 0.022 } as GelProductSpec]);
        expect(gelProductExists(1000)).toBe(false); // corrupt entry was dropped
        const event: DoseEvent = {
            id: 'g', route: Route.gel, timeH: 0, doseMG: 1.5, ester: Ester.E2, weightKG: 70,
            extras: { gelProductId: 1000, gelSite: 0, areaCM2: 400 } as DoseEvent['extras'],
        };
        const v = gelEventCentralAmount(event, 8, CorePK.kClear); // falls back to Oestrogel
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        setCustomGelProducts([]);
    });

    it('stays finite (no NaN) when cascade eigenvalues nearly coincide', () => {
        // Force kPen+kLoss ≈ ke and kRel ≈ ke to exercise the degenerate guards.
        const v1 = gel3CompCentralAmount(1, 10, 0.21, 0.20, ke, ke);
        const v2 = gel3CompCentralAmount(1, 50, ke / 2, ke / 2, ke, ke);
        expect(Number.isFinite(v1)).toBe(true);
        expect(Number.isFinite(v2)).toBe(true);
        expect(v1).toBeGreaterThanOrEqual(0);
    });

    it('produces a positive E2 gel series through runSimulation (product resolved by id)', () => {
        const events: DoseEvent[] = [0, DAY, 2 * DAY].map((timeH, i) => ({
            id: `gel-${i}`,
            route: Route.gel,
            timeH,
            doseMG: 1.5,
            ester: Ester.E2,
            weightKG: 70,
            // Only the product reference + per-application site/area are stored;
            // kinetics are resolved from the registry at simulation time.
            extras: {
                gelProductId: oestrogel.id,
                gelSite: 0,
                areaCM2: oestrogel.defaultAreaCM2,
            } as DoseEvent['extras'],
        }));
        const sim = runSimulation(events)!;
        expect(sim).toBeTruthy();
        expect(sim.concPGmL_E2.length).toBe(sim.timeH.length);
        expect(Math.max(...sim.concPGmL_E2)).toBeGreaterThan(0);
    });

    it('editing a custom product propagates to its records (setCustomGelProducts)', () => {
        const custom: GelProductSpec = {
            id: 1000, nameKey: '', name: 'Test', concentrationMGmL: 1.0,
            defaultAreaCM2: 400, refDoseMG: 1.5, kPenBase: 0.14, kLoss: 1.26, kRel: 0.022,
        };
        const event: DoseEvent = {
            id: 'g', route: Route.gel, timeH: 0, doseMG: 1.5, ester: Ester.E2, weightKG: 70,
            extras: { gelProductId: 1000, gelSite: 0, areaCM2: 400 } as DoseEvent['extras'],
        };
        setCustomGelProducts([custom]);
        const low = gelEventCentralAmount(event, 8, CorePK.kClear);
        // Double the penetration → larger systemic amount for the same record.
        setCustomGelProducts([{ ...custom, kPenBase: 0.28 }]);
        const high = gelEventCentralAmount(event, 8, CorePK.kClear);
        expect(high).toBeGreaterThan(low);
        setCustomGelProducts([]); // reset engine registry for other tests
    });
});

// Silence unused-import noise for HOUR in case future tests use it.
void HOUR;
