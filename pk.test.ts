import { describe, it, expect } from 'vitest';
import { Route, Ester, type DoseEvent, type LabResult } from './types';
import {
    bicalutamideConcNgML,
    runSimulation,
    isAntiandrogen,
    ANTIANDROGENS,
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

// Silence unused-import noise for HOUR in case future tests use it.
void HOUR;
