import { describe, it, expect } from 'vitest';
import { Route, Ester, ExtraKey, type DoseEvent, type LabResult } from './types';
import {
    bicalutamideConcNgML,
    runSimulation,
    isAntiandrogen,
    isE2Family,
    pickPrimaryAntiandrogen,
    ANTIANDROGENS,
    EU_DEPOT_PK,
    GelSite,
    GEL_PRODUCTS,
    GEL_SITE_FACTORS,
    gel3CompCentralAmount,
    gelEventCentralAmount,
    resolveGelKinetics,
    resolveGelCoverageArea,
    GEL_COVERAGE_TEMPLATES,
    GEL_COVERAGE_MANUAL_IDX,
    GEL_PALM_AREA_CM2,
    gelCoApplicationFactor,
    GEL_COAPPLICATION_FACTORS,
    setCustomGelProducts,
    sanitizeGelProduct,
    gelProductExists,
    type GelProductSpec,
    CorePK,
    _analytic3C,
    getBioavailabilityMultiplier,
    getToE2Factor,
    resolveParams,
} from './pk';
import { computeSimulationWithCI, initPersonalModel, replayPersonalModel, replayPersonalModelTimeline, computeE2AtTimeWithTheta } from './personalModel';

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

    it('thin coat (larger area) absorbs MORE than a thick coat of the same dose', () => {
        // Pharmacology / FDA labels: spreading the SAME dose over a larger area
        // (thinner film, lower dose density) RAISES fractional absorption. The model
        // must implement thin > thick, never the reverse.
        const thick = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 200);   // dense, small area
        const thin = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 1500);   // spread, large area
        const fThick = thick.kPen / (thick.kPen + thick.kLoss);
        const fThin = thin.kPen / (thin.kPen + thin.kLoss);
        expect(fThin).toBeGreaterThan(fThick);
    });

    it('scrotal estimate is AREA-INVARIANT (genital skin is not dose-density limited)', () => {
        // The scrotal application area is unknowable, so its kinetics must not depend
        // on it — the 8× site factor alone carries genital permeability.
        const a = resolveGelKinetics(oestrogel, GelSite.scrotal, 1.5, 50);
        const b = resolveGelKinetics(oestrogel, GelSite.scrotal, 1.5, 750);
        const c = resolveGelKinetics(oestrogel, GelSite.scrotal, 1.5, 1500);
        expect(a.kPen).toBeCloseTo(b.kPen, 12);
        expect(b.kPen).toBeCloseTo(c.kPen, 12);
        // ...whereas a keratinized site (arm) DOES vary with area.
        const armSmall = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 50);
        const armLarge = resolveGelKinetics(oestrogel, GelSite.arm, 1.5, 1500);
        expect(armSmall.kPen).not.toBeCloseTo(armLarge.kPen, 6);
    });

    // `concentrationMGmL` is now an explicit kinetic variable (it formerly only
    // labelled the product). Two gels identical except for strength must diverge
    // OFF the reference density, where the strength-scaled dose-density half-point
    // bites — but stay identical AT each product's reference dose/area.
    const mkGel = (conc: number): GelProductSpec => ({
        id: 1000, nameKey: '', name: `c${conc}`, concentrationMGmL: conc,
        defaultAreaCM2: 400, refDoseMG: 1.5, kPenBase: 0.140, kLoss: 1.260, kRel: 0.022,
    });
    const fOf = (k: ReturnType<typeof resolveGelKinetics>) => k.kPen / (k.kPen + k.kLoss);

    it('concentration changes absorbed fraction off the reference density', () => {
        // Spread 1.5 mg over 1000 cm² (σ below the 400 cm² reference density).
        const dilute = fOf(resolveGelKinetics(mkGel(0.5), GelSite.arm, 1.5, 1000));
        const strong = fOf(resolveGelKinetics(mkGel(2.0), GelSite.arm, 1.5, 1000));
        expect(Math.abs(dilute - strong)).toBeGreaterThan(1e-3);
        // At a sub-reference areal load the dilute gel (lower σ_sat) is pushed
        // further up the absorption curve than the concentrated one.
        expect(dilute).toBeGreaterThan(strong);
    });

    it('concentration does NOT change absorbed fraction at the reference dose/area', () => {
        // factor == 1 at the product's own reference, independent of strength, so a
        // default-dose prediction is unchanged whatever the concentration field says.
        const dilute = fOf(resolveGelKinetics(mkGel(0.5), GelSite.arm, 1.5, 400));
        const strong = fOf(resolveGelKinetics(mkGel(2.0), GelSite.arm, 1.5, 400));
        expect(dilute).toBeCloseTo(strong, 9);
        expect(dilute).toBeCloseTo(0.140 / (0.140 + 1.260), 9);
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

describe('gel application-coverage templates', () => {
    const oestrogel = GEL_PRODUCTS[0]; // defaultAreaCM2 = 750

    const idxOfKind = (kind: string) => GEL_COVERAGE_TEMPLATES.findIndex(t => t.kind === kind);

    it('the "product" template resolves to the product default area', () => {
        const idx = idxOfKind('product');
        expect(resolveGelCoverageArea(idx, oestrogel, 0)).toBe(oestrogel.defaultAreaCM2);
        // Manual cm² is ignored for a non-manual template.
        expect(resolveGelCoverageArea(idx, oestrogel, 999)).toBe(oestrogel.defaultAreaCM2);
    });

    it('a "fixed" palm template resolves to its labelled cm² (palm method)', () => {
        const palm2 = GEL_COVERAGE_TEMPLATES.findIndex(t => t.key === 'palm2');
        expect(resolveGelCoverageArea(palm2, oestrogel, 0)).toBe(2 * GEL_PALM_AREA_CM2);
    });

    it('the "manual" template uses the typed cm², falling back to product default', () => {
        expect(resolveGelCoverageArea(GEL_COVERAGE_MANUAL_IDX, oestrogel, 333)).toBe(333);
        // Blank / non-positive manual entry falls back to the product default.
        expect(resolveGelCoverageArea(GEL_COVERAGE_MANUAL_IDX, oestrogel, NaN)).toBe(oestrogel.defaultAreaCM2);
        expect(resolveGelCoverageArea(GEL_COVERAGE_MANUAL_IDX, oestrogel, 0)).toBe(oestrogel.defaultAreaCM2);
    });

    it('an out-of-range / undefined index falls back to manual semantics', () => {
        expect(resolveGelCoverageArea(999, oestrogel, 250)).toBe(250);
        expect(resolveGelCoverageArea(undefined, oestrogel, 0)).toBe(oestrogel.defaultAreaCM2);
    });

    it('templates form an ascending coverage ladder under one product', () => {
        const areas = GEL_COVERAGE_TEMPLATES
            .filter(t => t.kind === 'fixed')
            .map((_, i) => i);
        // palm1 < palm2 < palm3 (the graduated palm options).
        const a1 = resolveGelCoverageArea(GEL_COVERAGE_TEMPLATES.findIndex(t => t.key === 'palm1'), oestrogel, 0);
        const a2 = resolveGelCoverageArea(GEL_COVERAGE_TEMPLATES.findIndex(t => t.key === 'palm2'), oestrogel, 0);
        const a3 = resolveGelCoverageArea(GEL_COVERAGE_TEMPLATES.findIndex(t => t.key === 'palm3'), oestrogel, 0);
        expect(a1).toBeLessThan(a2);
        expect(a2).toBeLessThan(a3);
        expect(areas.length).toBeGreaterThan(0);
    });
});

describe('gel co-applied product modifiers', () => {
    const oestrogel = GEL_PRODUCTS[0];
    const ke = CorePK.kClear;

    const gelEvent = (coApplied?: number): DoseEvent => ({
        id: `g-${coApplied ?? 'x'}`, route: Route.gel, timeH: 0, doseMG: 1.5, ester: Ester.E2, weightKG: 70,
        extras: {
            gelProductId: oestrogel.id,
            gelSite: 0,
            areaCM2: oestrogel.defaultAreaCM2,
            ...(coApplied !== undefined ? { gelCoApplied: coApplied } : {}),
        } as DoseEvent['extras'],
    });

    it('factor: none=1, sunscreen<1, moisturizer>1; out-of-range/absent → 1', () => {
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: 0 })).toBe(1.0);
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: 1 })).toBe(GEL_COAPPLICATION_FACTORS.sunscreen);
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: 2 })).toBe(GEL_COAPPLICATION_FACTORS.moisturizer);
        expect(GEL_COAPPLICATION_FACTORS.sunscreen).toBeLessThan(1);
        expect(GEL_COAPPLICATION_FACTORS.moisturizer).toBeGreaterThan(1);
        // Absent, non-finite, negative, and unknown/future indices all collapse to the
        // neutral 1.0 — an unknown value must NEVER be reinterpreted as moisturizer.
        expect(gelCoApplicationFactor({})).toBe(1.0);
        expect(gelCoApplicationFactor(undefined)).toBe(1.0);
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: 99 })).toBe(1.0);
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: -1 })).toBe(1.0);
        expect(gelCoApplicationFactor({ [ExtraKey.gelCoApplied]: NaN })).toBe(1.0);
    });

    it('scales the curve by exactly the co-application factor (linear cascade)', () => {
        const tau = 8;
        const base = gelEventCentralAmount(gelEvent(0), tau, ke);
        const sun = gelEventCentralAmount(gelEvent(1), tau, ke);
        const moist = gelEventCentralAmount(gelEvent(2), tau, ke);
        expect(base).toBeGreaterThan(0);
        expect(sun / base).toBeCloseTo(GEL_COAPPLICATION_FACTORS.sunscreen, 9);
        expect(moist / base).toBeCloseTo(GEL_COAPPLICATION_FACTORS.moisturizer, 9);
        // An event with no co-applied tag matches the explicit "none".
        expect(gelEventCentralAmount(gelEvent(undefined), tau, ke)).toBeCloseTo(base, 9);
    });

    it('preserves tmax (a pure exposure scaling, not a shape change)', () => {
        const peakOf = (coApplied: number) => {
            let tmax = 0, peak = 0;
            for (let t = 0.1; t <= 96; t += 0.1) {
                const m = gelEventCentralAmount(gelEvent(coApplied), t, ke);
                if (m > peak) { peak = m; tmax = t; }
            }
            return tmax;
        };
        expect(peakOf(2)).toBeCloseTo(peakOf(0), 5);
    });
});

describe('estradiol undecylate (EU) IM depot', () => {
    // A neutral personal model (theta = [0,0]) evaluates the bare POPULATION curve
    // at any instant, grid-independent — the same role bicalutamideConcNgML plays
    // for BICA. This lets us pin EU directly to its sparse literature anchors.
    const euEvent = (timeH: number, doseMG = 100): DoseEvent => ({
        id: `eu-${timeH}`, route: Route.injection, timeH, doseMG, ester: Ester.EU, weightKG: 70, extras: {},
    });
    const popE2 = (events: DoseEvent[], timeH: number) => computeE2AtTimeWithTheta(events, timeH, [0, 0]);

    it('uses free-E2 clearance for EU while other injections keep injection k3', () => {
        const euParams = resolveParams(euEvent(0, 100));
        const evParams = resolveParams({ ...euEvent(0, 10), id: 'ev', ester: Ester.EV });
        expect(euParams.k3).toBeCloseTo(CorePK.kClear, 12);
        expect(evParams.k3).toBeCloseTo(CorePK.kClearInjection, 12);
        expect(euParams.k3).not.toBeCloseTo(evParams.k3, 6);
    });

    it('uses releaseScale times the EU molar conversion as injected exposure F', () => {
        const expected = EU_DEPOT_PK.releaseScale * getToE2Factor(Ester.EU);
        expect(getToE2Factor(Ester.EU)).toBeCloseTo(272.38 / 440.66, 6);
        expect(getBioavailabilityMultiplier(Route.injection, Ester.EU, {})).toBeCloseTo(expected, 12);
    });

    it('does not hit the singular _analytic3C guard for EU depot rates', () => {
        const k1 = EU_DEPOT_PK.ka;
        const k2 = EU_DEPOT_PK.kCleave;
        const k3 = CorePK.kClear;
        expect(Math.abs(k1 - k2)).toBeGreaterThan(1e-9);
        expect(Math.abs(k1 - k3)).toBeGreaterThan(1e-9);
        expect(Math.abs(k2 - k3)).toBeGreaterThan(1e-9);
        const amount = _analytic3C(24, 100, getBioavailabilityMultiplier(Route.injection, Ester.EU, {}), k1, k2, k3);
        expect(amount).toBeGreaterThan(0);
    });

    describe('single 100 mg dose vs published anchors', () => {
        const dose = [euEvent(0, 100)];
        const at = (days: number) => popE2(dose, days * DAY);

        it('day 1 E2 ≈ 500 pg/mL (accept 400–650)', () => {
            const c = at(1);
            expect(c).toBeGreaterThanOrEqual(400);
            expect(c).toBeLessThanOrEqual(650);
        });

        it('day 14 E2 ≈ 340 pg/mL (accept 250–450)', () => {
            const c = at(14);
            expect(c).toBeGreaterThanOrEqual(250);
            expect(c).toBeLessThanOrEqual(450);
        });

        it('peaks within the first ~2 days and is already declining by day 14', () => {
            let tmax = 0, cmax = 0;
            for (let h = 1; h <= 14 * DAY; h += 1) {
                const c = popE2(dose, h);
                if (c > cmax) { cmax = c; tmax = h; }
            }
            expect(tmax).toBeLessThanOrEqual(2 * DAY);   // early Tmax (flip-flop, fast clearance)
            expect(at(14)).toBeLessThan(at(1));
        });

        it('has a multi-week flip-flop terminal half-life (≈ 20–55 d), NOT the fast injection rate', () => {
            const c14 = at(14), c42 = at(42);
            expect(c42).toBeGreaterThan(0);
            expect(c42).toBeLessThan(c14);
            const halfLifeD = (Math.log(2) * (42 - 14)) / Math.log(c14 / c42);
            expect(halfLifeD).toBeGreaterThanOrEqual(20);
            expect(halfLifeD).toBeLessThanOrEqual(55);
        });

        it('is dose-proportional (50 mg gives half of 100 mg)', () => {
            const half = popE2([euEvent(0, 50)], 1 * DAY);
            expect(half).toBeCloseTo(at(1) / 2, 3);
        });
    });

    describe('100 mg every 30 days accumulates toward published troughs', () => {
        // Doses on days 0,30,…,180. A dose landing exactly on the evaluation instant
        // contributes 0 (central amount at tau=0 is 0), so trough(dayN) = sum over
        // the doses strictly before it — i.e. the value just prior to the next shot.
        const monthly = Array.from({ length: 7 }, (_, i) => euEvent(i * 30 * DAY, 100));
        const trough = (dayN: number) => popE2(monthly, dayN * DAY);

        it('month-3 trough ≈ 486–560 pg/mL (accept 400–600)', () => {
            const c = trough(90);
            expect(c).toBeGreaterThanOrEqual(400);
            expect(c).toBeLessThanOrEqual(600);
        });

        it('month-6 trough ≈ 540–598 pg/mL (accept 450–650)', () => {
            const c = trough(180);
            expect(c).toBeGreaterThanOrEqual(450);
            expect(c).toBeLessThanOrEqual(650);
        });

        it('troughs rise monotonically toward steady state (month 1 < 3 < 6)', () => {
            expect(trough(30)).toBeLessThan(trough(90));
            expect(trough(90)).toBeLessThan(trough(180));
        });
    });

    it('stays finite and non-negative across a 1-year horizon', () => {
        const dose = [euEvent(0, 100)];
        for (let d = 0; d <= 365; d += 2) {
            const c = popE2(dose, d * DAY);
            expect(Number.isFinite(c)).toBe(true);
            expect(c).toBeGreaterThanOrEqual(0);
        }
    });

    it('heavier body weight lowers the concentration for the same dose (Vd scaling)', () => {
        const light = [{ ...euEvent(0, 100), weightKG: 55 }];
        const heavy = [{ ...euEvent(0, 100), weightKG: 95 }];
        expect(popE2(heavy, 1 * DAY)).toBeLessThan(popE2(light, 1 * DAY));
    });

    it('feeds the E2 channel of runSimulation (not the anti-androgen byCompound map)', () => {
        const sim = runSimulation([euEvent(0, 100), euEvent(30 * DAY, 100)])!;
        expect(sim).toBeTruthy();
        expect(isAntiandrogen(Ester.EU)).toBe(false);
        expect(sim.byCompound[Ester.EU]).toBeUndefined();
        expect(Math.max(...sim.concPGmL_E2)).toBeGreaterThan(0);
        expect(sim.auc).toBeGreaterThan(0);
    });

    it('an E2 lab after an EU dose DOES unlock the E2 EKF (treated as an estradiol ester)', () => {
        const evs = [euEvent(0, 100)];
        const labs: LabResult[] = [{ id: 'l1', timeH: 7 * DAY, concValue: 420, unit: 'pg/ml' }];
        const state = replayPersonalModel(evs, labs);
        // Mirror of the BICA case above: EU is an estradiol ester, so a post-dose
        // lab must register as an E2 observation and personalize the curve.
        expect(state.postDoseObservationCount).toBeGreaterThan(0);
    });

    it('responds to the shared E2 theta parameters, including kScale on k3', () => {
        const evs = [euEvent(0, 100)];
        const base = popE2(evs, 14 * DAY);
        expect(computeE2AtTimeWithTheta(evs, 14 * DAY, [Math.log(1.5), 0])).toBeCloseTo(base * 1.5, 6);
        expect(computeE2AtTimeWithTheta(evs, 14 * DAY, [0, Math.log(0.5)])).toBeGreaterThan(base);
    });
});

describe('causal vs retrospective personalization (time causality)', () => {
    const e2Inj = (timeH: number, doseMG = 5): DoseEvent => ({
        id: `ev-${timeH}`, route: Route.injection, timeH, doseMG, ester: Ester.EV, weightKG: 70, extras: {},
    });

    // E2 doses spanning ~3 weeks so labs land inside the simulated horizon.
    const events = [e2Inj(0), e2Inj(7 * DAY), e2Inj(14 * DAY)];
    const labEarly: LabResult = { id: 'l1', timeH: 5 * DAY, concValue: 220, unit: 'pg/ml' };
    const labLate: LabResult = { id: 'l2', timeH: 12 * DAY, concValue: 55, unit: 'pg/ml' };

    const resolveAt = (timeline: ReturnType<typeof replayPersonalModelTimeline>, t: number) => {
        let chosen = timeline[0].state;
        for (const snap of timeline) {
            if (snap.timeH <= t) chosen = snap.state;
            else break;
        }
        return chosen;
    };

    it('causal: a later lab does NOT change the snapshot used before it; it DOES change the final params', () => {
        const tlEarly = replayPersonalModelTimeline(events, [labEarly]);
        const tlBoth = replayPersonalModelTimeline(events, [labEarly, labLate]);

        // At day 8 (after labEarly, before labLate) both timelines resolve to the
        // exact same state — the future lab cannot rewrite the past.
        const sEarly = resolveAt(tlEarly, 8 * DAY);
        const sBoth = resolveAt(tlBoth, 8 * DAY);
        expect(sBoth.thetaMean).toEqual(sEarly.thetaMean);
        expect(sBoth.thetaCov).toEqual(sEarly.thetaCov);

        // But the FINAL learned params (what retrospective applies everywhere) do
        // change once the later lab is incorporated.
        const finalEarly = tlEarly[tlEarly.length - 1].state.thetaMean;
        const finalBoth = tlBoth[tlBoth.length - 1].state.thetaMean;
        expect(finalBoth).not.toEqual(finalEarly);
    });

    it('causal curve: adding a later lab leaves the pre-lab E2 estimate untouched', () => {
        const sim = runSimulation(events)!;
        const modelEarly = replayPersonalModel(events, [labEarly]);
        const modelBoth = replayPersonalModel(events, [labEarly, labLate]);

        const causalEarly = computeSimulationWithCI(sim, events, modelEarly, true, [labEarly], 'ekf', false, 'causal');
        const causalBoth = computeSimulationWithCI(sim, events, modelBoth, true, [labEarly, labLate], 'ekf', false, 'causal');

        // The curve is computed exactly per grid point. Day 7 sits after labEarly
        // but before labLate (day 12), so causal mode must produce an identical
        // estimate with or without the later lab.
        const i7 = sim.timeH.findIndex((t) => t >= 7 * DAY);
        expect(i7).toBeGreaterThan(0);
        expect(causalBoth.e2Adjusted[i7]).toBeCloseTo(causalEarly.e2Adjusted[i7], 6);
    });

    it('retrospective curve: adding a later lab DOES rewrite the pre-lab E2 estimate', () => {
        const sim = runSimulation(events)!;
        const modelEarly = replayPersonalModel(events, [labEarly]);
        const modelBoth = replayPersonalModel(events, [labEarly, labLate]);

        const retroEarly = computeSimulationWithCI(sim, events, modelEarly, true, [labEarly], 'ekf', false, 'retrospective');
        const retroBoth = computeSimulationWithCI(sim, events, modelBoth, true, [labEarly, labLate], 'ekf', false, 'retrospective');

        const i7 = sim.timeH.findIndex((t) => t >= 7 * DAY);
        expect(i7).toBeGreaterThan(0);
        // The later (low) lab pulls the final amplitude down, reshaping the past.
        expect(Math.abs(retroBoth.e2Adjusted[i7] - retroEarly.e2Adjusted[i7])).toBeGreaterThan(1);
    });
});

describe('dose-causality: a dose logged after all labs never moves the past', () => {
    const e2Inj = (timeH: number, doseMG = 5): DoseEvent => ({
        id: `ev-${timeH}`, route: Route.injection, timeH, doseMG, ester: Ester.EV, weightKG: 70, extras: {},
    });
    const baseEvents = [e2Inj(0), e2Inj(7 * DAY)];
    const labs: LabResult[] = [{ id: 'l1', timeH: 5 * DAY, concValue: 180, unit: 'pg/ml' }];

    it('a dose after the last lab leaves the learned parameters unchanged', () => {
        const modelA = replayPersonalModel(baseEvents, labs);
        const modelB = replayPersonalModel([...baseEvents, e2Inj(20 * DAY)], labs);
        // A dose can only influence calibration through a lab AFTER it; here there
        // is none, so theta/baseline must be identical.
        expect(modelB.thetaMean).toEqual(modelA.thetaMean);
        expect(modelB.thetaCov).toEqual(modelA.thetaCov);
        expect(modelB.baselinePGmL).toEqual(modelA.baselinePGmL);
    });

    it('retrospective curve value at past times is unchanged after adding a future dose', () => {
        const moreEvents = [...baseEvents, e2Inj(20 * DAY)];
        const simA = runSimulation(baseEvents)!;
        const simB = runSimulation(moreEvents)!;
        const modelA = replayPersonalModel(baseEvents, labs);
        const modelB = replayPersonalModel(moreEvents, labs);

        const ciA = computeSimulationWithCI(simA, baseEvents, modelA, true, labs, 'ekf', false, 'retrospective');
        const ciB = computeSimulationWithCI(simB, moreEvents, modelB, true, labs, 'ekf', false, 'retrospective');

        // runSimulation rescales the grid when events change, so compare via linear
        // interpolation at the SAME real times in the region before the new dose.
        const interp = (timeHArr: number[], values: number[], t: number) => {
            if (t <= timeHArr[0]) return values[0];
            if (t >= timeHArr[timeHArr.length - 1]) return values[values.length - 1];
            let lo = 0, hi = timeHArr.length - 1;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (timeHArr[m] <= t) lo = m; else hi = m; }
            const f = (t - timeHArr[lo]) / (timeHArr[hi] - timeHArr[lo]);
            return values[lo] + (values[hi] - values[lo]) * f;
        };

        for (const t of [2 * DAY, 4 * DAY, 6 * DAY, 10 * DAY]) {
            const va = interp(simA.timeH, ciA.e2Adjusted, t);
            const vb = interp(simB.timeH, ciB.e2Adjusted, t);
            // Exact-per-point curves differ only by sub-grid interpolation error.
            expect(Math.abs(vb - va) / Math.max(va, 1)).toBeLessThan(0.02);
        }
    });
});

// Silence unused-import noise for HOUR in case future tests use it.
void HOUR;

describe('getToE2Factor — non-E2-ester fallback', () => {
    // Regression for the 黄体酮 (PROG) preset-click bug: the modal's
    // handleRawChange calls getToE2Factor(Ester.PROG); since PROG isn't in
    // the EsterInfo table (no PK model), the unguarded helper would throw
    // `Cannot read property 'mw' of undefined`. Returning 1 makes the
    // compound ↔ E2-equivalent field handshake symmetric (PROG is its own
    // drug with no molar-mass equivalence to E2, so identity is correct).
    it('returns 1 for PROG (no PK model, no molar-mass conversion)', () => {
        expect(getToE2Factor(Ester.PROG)).toBe(1);
    });

    it('returns 1 for any future / unknown ester value rather than throwing', () => {
        // Cast through Ester to simulate a stale enum value coming from
        // serialized legacy data; the helper must not blow up.
        const ghost = 'NOT_A_REAL_ESTER' as unknown as Ester;
        expect(() => getToE2Factor(ghost)).not.toThrow();
        expect(getToE2Factor(ghost)).toBe(1);
    });
});

describe('isE2Family', () => {
    // The home screen's "上一次雌二醇" card and any future "E2 dose log"
    // must use the same allow-list — otherwise a progesterone or
    // anti-androgen entry (which share the same UI route/ester selects)
    // would silently leak into an "E2 last dose" display. Regression
    // for the 黄体酮 preset-save bug: previously lastE2Dose only filtered
    // anti-androgens, so IM / rectal PROG was counted as the user's last
    // estradiol dose.

    it('returns true for E2 and every published estradiol ester', () => {
        for (const e of [Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU]) {
            expect(isE2Family(e), `expected ${e} to be E2 family`).toBe(true);
        }
    });

    it('returns false for progesterone (PROG has no PK model entry)', () => {
        expect(isE2Family(Ester.PROG)).toBe(false);
    });

    it('returns false for tracked anti-androgens (CPA, BICA) — EsterInfo has mw but E2_FAMILY still excludes them', () => {
        // CPA / BICA both live in EsterInfo (their mw is needed by other
        // helpers even though no E2-equivalence exists), so the previous
        // "hasOwnProperty in EsterInfo" implementation accidentally counted
        // them as E2 family. The allow-list makes the boundary explicit.
        expect(isE2Family(Ester.CPA)).toBe(false);
        expect(isE2Family(Ester.BICA)).toBe(false);
    });

    it('returns false for an unknown / future ester value', () => {
        const ghost = 'NOT_A_REAL_ESTER' as unknown as Ester;
        expect(() => isE2Family(ghost)).not.toThrow();
        expect(isE2Family(ghost)).toBe(false);
    });
});

