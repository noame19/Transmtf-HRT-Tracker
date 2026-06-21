/**
 * Synthetic self-data evaluation harness for the calibration models.
 *
 * IMPORTANT: this harness uses ONLY synthetic, machine-generated single-patient
 * data — never anyone's real medication records. Each "patient" has a known true
 * individual parameter vector drawn from the population prior; we simulate their
 * dosing + sparse noisy labs, then measure how well each calibration model
 * (`ekf`, `ou-kalman`, `hybrid-mipd`) predicts HELD-OUT points using only the
 * remaining labs. This is the on-device analogue of leave-one-out / prequential
 * Bayesian-forecasting evaluation, and it is what lets us claim a new model is
 * "better" with numbers instead of vibes.
 *
 * Because the ground-truth curves are generated from the richer Hybrid-MIPD
 * forward model (which includes absorption variability), this harness naturally
 * favours models that can represent absorption. That is the point — it shows the
 * added value of individualising absorption — but it is NOT a substitute for
 * validating against the user's own accumulating real labs over time.
 */

import { Route, Ester, type DoseEvent, type LabResult } from '../types';
import { runSimulation, interpolateConcentration_E2 } from '../pk';
import {
    computeSimulationWithCI,
    initPersonalModel,
    replayPersonalModel,
} from '../personalModel';
import { mipdDrugE2AtTimeSorted } from '../mipd';
import type { CalibrationModel } from '../calibration';

// ---------------------------------------------------------------------------
// Deterministic RNG (so benchmarks are reproducible — no Math.random())
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rng: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Synthetic single patient
// ---------------------------------------------------------------------------

export interface SyntheticPatient {
    events: DoseEvent[];
    trueEta: [number, number, number];
    /** Lab observations (with realistic noise + occasional outliers). */
    labs: LabResult[];
    /** Ground-truth drug-derived E2 (pg/mL) at each lab time, baseline=0. */
    trueAtLab: number[];
}

const DAY = 24;

/**
 * Build one synthetic patient: weekly estradiol-valerate injections plus a few
 * sparsely-sampled, phase-varied labs, with a true [η_s, η_k, η_a] drawn from
 * the population prior.
 */
export function makePatient(seed: number): SyntheticPatient {
    const rng = mulberry32(seed);
    const weightKG = 60 + Math.round(gaussian(rng) * 8);

    // True individual parameters drawn from the prior (amplitude, clearance,
    // absorption). Absorption gets the widest spread (least identifiable).
    const trueEta: [number, number, number] = [
        gaussian(rng) * 0.30,
        gaussian(rng) * 0.35,
        gaussian(rng) * 0.50,
    ];

    // 12 weekly EV 4 mg IM injections.
    const events: DoseEvent[] = [];
    const nDoses = 12;
    const doseMG = 4;
    for (let i = 0; i < nDoses; i++) {
        events.push({
            id: `ev-${seed}-${i}`,
            route: Route.injection,
            timeH: i * 7 * DAY,
            doseMG,
            ester: Ester.EV,
            weightKG,
            extras: {},
        });
    }
    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);

    // Sample ~6 labs at varied phases (mix of near-peak and trough) across the
    // middle of the course so absorption + clearance are both observable.
    const offsetsDays = [2, 6.5, 1.5, 6.8, 3, 6.2];
    const doseIdx = [2, 3, 5, 6, 8, 9];
    const labs: LabResult[] = [];
    const trueAtLab: number[] = [];
    for (let k = 0; k < offsetsDays.length; k++) {
        const t = doseIdx[k] * 7 * DAY + offsetsDays[k] * DAY;
        const trueE2 = mipdDrugE2AtTimeSorted(sorted, t, trueEta);
        // Proportional log-normal assay/timing noise (σ_log ≈ 0.15) + rare outlier.
        const noisy = trueE2 * Math.exp(gaussian(rng) * 0.15);
        const isOutlier = rng() < 0.08;
        const obs = isOutlier ? noisy * (rng() < 0.5 ? 0.4 : 2.5) : noisy;
        labs.push({
            id: `lab-${seed}-${k}`,
            timeH: t,
            concValue: Math.max(1, obs),
            unit: 'pg/ml',
        });
        trueAtLab.push(trueE2);
    }

    return { events, trueEta, labs, trueAtLab };
}

// ---------------------------------------------------------------------------
// Prediction via the production path (one model, held-out lab)
// ---------------------------------------------------------------------------

function interpAt(xs: number[], ys: number[], x: number): number {
    if (xs.length === 0) return 0;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid;
        else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
}

export interface FoldPrediction {
    mean: number;
    lo95: number;
    hi95: number;
    lo68: number;
    hi68: number;
    truth: number;
}

/**
 * Predict the held-out lab time for one model using only the training labs,
 * through the exact production path (`computeSimulationWithCI`). The truth is
 * the noise-free ground-truth concentration at that time.
 */
export function predictHeldOut(
    patient: SyntheticPatient,
    heldOutIdx: number,
    model: CalibrationModel
): FoldPrediction | null {
    const { events, labs, trueAtLab } = patient;
    const trainLabs = labs.filter((_, i) => i !== heldOutIdx);
    const tHeld = labs[heldOutIdx].timeH;

    const sim = runSimulation(events);
    if (!sim.timeH.length) return null;

    const state = replayPersonalModel(events, trainLabs);
    const ci = computeSimulationWithCI(
        sim,
        events,
        state ?? initPersonalModel(),
        false,
        trainLabs,
        model,
        false,
        'retrospective'
    );
    if (!ci.e2Adjusted.length) return null;

    return {
        mean: interpAt(ci.timeH, ci.e2Adjusted, tHeld),
        lo95: interpAt(ci.timeH, ci.ci95Low, tHeld),
        hi95: interpAt(ci.timeH, ci.ci95High, tHeld),
        lo68: interpAt(ci.timeH, ci.ci68Low, tHeld),
        hi68: interpAt(ci.timeH, ci.ci68High, tHeld),
        truth: trueAtLab[heldOutIdx],
    };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ModelMetrics {
    model: CalibrationModel;
    n: number;
    rmseLog: number;
    maeLog: number;
    mdape: number;
    coverage68: number;
    coverage95: number;
    meanCi95Width: number;
}

const EPS = 0.1;

export function scoreModel(model: CalibrationModel, preds: FoldPrediction[]): ModelMetrics {
    const logErrs: number[] = [];
    const apes: number[] = [];
    let cover68 = 0;
    let cover95 = 0;
    let widthSum = 0;
    for (const p of preds) {
        const pred = Math.max(p.mean, EPS);
        const truth = Math.max(p.truth, EPS);
        const le = Math.log(pred) - Math.log(truth);
        logErrs.push(le);
        apes.push(Math.abs(pred - truth) / truth);
        if (p.truth >= p.lo68 && p.truth <= p.hi68) cover68 += 1;
        if (p.truth >= p.lo95 && p.truth <= p.hi95) cover95 += 1;
        widthSum += Math.max(0, p.hi95 - p.lo95);
    }
    const n = preds.length || 1;
    const rmseLog = Math.sqrt(logErrs.reduce((s, e) => s + e * e, 0) / n);
    const maeLog = logErrs.reduce((s, e) => s + Math.abs(e), 0) / n;
    const sortedApe = [...apes].sort((a, b) => a - b);
    const mdape = sortedApe.length ? sortedApe[Math.floor(sortedApe.length / 2)] : 0;
    return {
        model,
        n: preds.length,
        rmseLog,
        maeLog,
        mdape,
        coverage68: cover68 / n,
        coverage95: cover95 / n,
        meanCi95Width: widthSum / n,
    };
}

/**
 * Run the full leave-one-lab-out benchmark over a synthetic cohort for every
 * model and return one {@link ModelMetrics} per model.
 */
export function runBenchmark(
    models: CalibrationModel[],
    cohortSize: number,
    seed0 = 1234
): ModelMetrics[] {
    const predsByModel = new Map<CalibrationModel, FoldPrediction[]>();
    for (const m of models) predsByModel.set(m, []);

    for (let p = 0; p < cohortSize; p++) {
        const patient = makePatient(seed0 + p * 7919);
        for (let k = 0; k < patient.labs.length; k++) {
            for (const m of models) {
                const pred = predictHeldOut(patient, k, m);
                if (pred && Number.isFinite(pred.mean) && pred.mean > 0) {
                    predsByModel.get(m)!.push(pred);
                }
            }
        }
    }

    return models.map((m) => scoreModel(m, predsByModel.get(m)!));
}

export function formatMetricsTable(rows: ModelMetrics[]): string {
    const header = ['model', 'n', 'RMSE_log', 'MAE_log', 'MdAPE', 'cov68', 'cov95', 'CI95w'];
    const lines = [header.join('\t')];
    for (const r of rows) {
        lines.push([
            r.model,
            String(r.n),
            r.rmseLog.toFixed(4),
            r.maeLog.toFixed(4),
            (r.mdape * 100).toFixed(1) + '%',
            (r.coverage68 * 100).toFixed(0) + '%',
            (r.coverage95 * 100).toFixed(0) + '%',
            r.meanCi95Width.toFixed(1),
        ].join('\t'));
    }
    return lines.join('\n');
}

// Re-export so a non-test runner / future CLI can avoid pulling pk internals.
export { interpolateConcentration_E2 };
