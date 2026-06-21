import { describe, it, expect } from 'vitest';
import { runBenchmark, formatMetricsTable } from './syntheticEval';
import type { CalibrationModel } from '../calibration';

/**
 * Leave-one-lab-out benchmark over a synthetic single-patient cohort. This is
 * the objective yard-stick for "is the new model actually better": it predicts
 * held-out points through the real production path and scores point accuracy +
 * interval calibration for every calibration model.
 *
 * The synthetic ground truth includes per-patient absorption variability, which
 * the EKF/OU models cannot represent but Hybrid-MIPD can — so Hybrid-MIPD is
 * expected to match or beat them here. (On real data the edge depends on whether
 * the user samples enough phases to identify absorption; see the harness notes.)
 */
describe('synthetic self-data benchmark (no real patient data)', () => {
    const MODELS: CalibrationModel[] = ['ekf', 'ou-kalman', 'hybrid-mipd'];
    const COHORT = 6;

    it('Hybrid-MIPD is at least competitive with EKF on held-out accuracy', () => {
        const rows = runBenchmark(MODELS, COHORT, 20260618);

        // Surface the full comparison so the numbers are visible in test output.
        // eslint-disable-next-line no-console
        console.log('\nLeave-one-lab-out benchmark (synthetic cohort = ' + COHORT + ')\n' + formatMetricsTable(rows) + '\n');

        const byModel = new Map(rows.map((r) => [r.model, r]));
        const ekf = byModel.get('ekf')!;
        const ou = byModel.get('ou-kalman')!;
        const mipd = byModel.get('hybrid-mipd')!;

        // Every model produced finite metrics over a non-trivial number of folds.
        for (const r of rows) {
            expect(r.n).toBeGreaterThan(10);
            expect(Number.isFinite(r.rmseLog)).toBe(true);
            expect(Number.isFinite(r.maeLog)).toBe(true);
        }

        // Intervals are not absurdly mis-calibrated (broad sanity, not a hard
        // calibration guarantee — held-out points can be far from any lab).
        expect(mipd.coverage95).toBeGreaterThan(0.4);

        // Hybrid-MIPD should match or beat EKF on log-scale RMSE, given the data
        // contains absorption structure EKF cannot represent. Small tolerance to
        // keep the deterministic-but-noisy benchmark from being brittle.
        expect(mipd.rmseLog).toBeLessThanOrEqual(ekf.rmseLog * 1.1);
        expect(mipd.maeLog).toBeLessThanOrEqual(ekf.maeLog * 1.1);

        // And it should be in the same ballpark as (or better than) OU-Kalman.
        expect(mipd.rmseLog).toBeLessThanOrEqual(ou.rmseLog * 1.25);
    }, 120000);
});
