import { beforeEach, describe, expect, it } from 'vitest';
import { DoseEvent, Ester, Plan, Route } from '../../types';
import {
    analyzePlanCompliance,
    canonicalComplianceRoute,
    COMPLIANCE_DETAIL_SAMPLE_COUNT,
} from './planCompliance';

// Reference "now" — pinned so the tests don't drift with real wall-clock time.
const TODAY = new Date(2026, 6, 5, 12, 0, 0, 0);  // 2026-07-05 noon (local).

let evId = 0;
let planId = 0;

/** Build a DoseEvent `offsetDays` days before TODAY, at `hour` local. */
function mkEvent(
    ester: Ester,
    route: Route,
    offsetDays: number,
    hour = 20,
): DoseEvent {
    const ms = new Date(2026, 6, 5 + offsetDays, hour, 0, 0, 0).getTime();
    return {
        id: `ev-${evId++}`,
        ester,
        route,
        timeH: ms / 3600000,
        doseMG: 5,
        weightKG: 60,
        extras: {},
    };
}

/** Build a Plan with sensible defaults for the compliance tests. */
function mkPlan(
    ester: Ester,
    route: Route,
    overrides: Partial<Plan> = {},
): Plan {
    return {
        id: `plan-${planId++}`,
        ester,
        route,
        doseMG: 5,
        schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] },
        startDateH: (TODAY.getTime() - 30 * 86400000) / 3600000,
        enabled: true,
        leadMinutes: 5,
        extras: {},
        createdAtH: (TODAY.getTime() - 30 * 86400000) / 3600000,
        updatedAtH: (TODAY.getTime() - 86400000) / 3600000,
        ...overrides,
    };
}

beforeEach(() => {
    evId = 0;
    planId = 0;
});

// ── canonicalComplianceRoute ─────────────────────────────────────────────

describe('canonicalComplianceRoute', () => {
    it('maps sublingual to oral', () => {
        expect(canonicalComplianceRoute(Route.sublingual)).toBe(Route.oral);
    });
    it('keeps oral as oral', () => {
        expect(canonicalComplianceRoute(Route.oral)).toBe(Route.oral);
    });
    it('leaves other routes unchanged', () => {
        expect(canonicalComplianceRoute(Route.injection)).toBe(Route.injection);
        expect(canonicalComplianceRoute(Route.gel)).toBe(Route.gel);
        expect(canonicalComplianceRoute(Route.patchApply)).toBe(Route.patchApply);
        expect(canonicalComplianceRoute(Route.patchRemove)).toBe(Route.patchRemove);
    });
});

// ── analyzePlanCompliance ────────────────────────────────────────────────

describe('analyzePlanCompliance', () => {
    it('returns empty when there are no plans and no events', () => {
        const report = analyzePlanCompliance([], [], TODAY);
        expect(report.mismatches).toHaveLength(0);
        expect(report.matches).toHaveLength(0);
    });

    it('returns empty when plan exists but events are empty', () => {
        // New-user-with-a-plan edge: skip rather than alarm on insufficient data.
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance([], plans, TODAY);
        expect(report.mismatches).toHaveLength(0);
        expect(report.matches).toHaveLength(0);
    });

    it('returns empty when sample size is below threshold', () => {
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(0);
        expect(report.matches).toHaveLength(0);
    });

    it('reports a match when all 4 samples share the plan (ester, route)', () => {
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(1);
        expect(report.mismatches).toHaveLength(0);
        expect(report.matches[0].category).toBe('estrogen');
        expect(report.matches[0].historyMain?.count).toBe(4);
    });

    it('reports a mismatch when the dominant route differs from the plan', () => {
        // 3 EV/gel + 1 EV/injection. Dominant = 3/4 = 75% = EV/gel.
        // Plan = EV/injection → mismatch.
        const events = [
            mkEvent(Ester.EV, Route.gel, -1),
            mkEvent(Ester.EV, Route.gel, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(1);
        expect(report.matches).toHaveLength(0);
        expect(report.mismatches[0].historyMain?.route).toBe(Route.gel);
        expect(report.mismatches[0].historyMain?.count).toBe(3);
    });

    it('reports a mismatch when no combination reaches 75%', () => {
        // 2 EV/injection + 2 EV/gel. 50/50 — no dominant qualifies.
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.gel, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(1);
        expect(report.mismatches[0].historyMain).toBeNull();
    });

    it('reports a mismatch when the ester differs from the plan', () => {
        const events = [
            mkEvent(Ester.E2, Route.injection, -1),
            mkEvent(Ester.E2, Route.injection, -3),
            mkEvent(Ester.E2, Route.injection, -5),
            mkEvent(Ester.E2, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(1);
        expect(report.mismatches[0].historyMain?.ester).toBe(Ester.E2);
        expect(report.mismatches[0].planSpec.ester).toBe(Ester.EV);
    });

    it('skips disabled plans', () => {
        const events = [
            mkEvent(Ester.EV, Route.gel, -1),
            mkEvent(Ester.EV, Route.gel, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.gel, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection, { enabled: false })];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(0);
        expect(report.matches).toHaveLength(0);
    });

    it('treats oral/sublingual as equivalent (plan=oral, history=sublingual)', () => {
        const events = [
            mkEvent(Ester.EV, Route.sublingual, -1),
            mkEvent(Ester.EV, Route.sublingual, -3),
            mkEvent(Ester.EV, Route.sublingual, -5),
            mkEvent(Ester.EV, Route.sublingual, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.oral)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(1);
    });

    it('treats oral/sublingual as equivalent (plan=sublingual, history=oral)', () => {
        const events = [
            mkEvent(Ester.EV, Route.oral, -1),
            mkEvent(Ester.EV, Route.oral, -3),
            mkEvent(Ester.EV, Route.oral, -5),
            mkEvent(Ester.EV, Route.oral, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.sublingual)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(1);
    });

    it('treats oral/sublingual mixed-history as match', () => {
        // 3 oral + 1 sublingual. Both canonicalise to oral → match.
        const events = [
            mkEvent(Ester.EV, Route.oral, -1),
            mkEvent(Ester.EV, Route.oral, -3),
            mkEvent(Ester.EV, Route.oral, -5),
            mkEvent(Ester.EV, Route.sublingual, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.oral)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(1);
    });

    it('skips patchRemove events', () => {
        // 4 patchApply + 4 patchRemove → after filter only patchApply
        // remains and matches the plan.
        const events: DoseEvent[] = [];
        for (let i = 1; i <= 4; i++) {
            events.push(mkEvent(Ester.EV, Route.patchApply, -i * 2));
            events.push(mkEvent(Ester.EV, Route.patchRemove, -i * 2 + 1, 6));
        }
        const plans = [mkPlan(Ester.EV, Route.patchApply)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(1);
    });

    it('skips events older than the look-back window', () => {
        const events = [
            mkEvent(Ester.EV, Route.injection, -35),
            mkEvent(Ester.EV, Route.injection, -37),
            mkEvent(Ester.EV, Route.injection, -39),
            mkEvent(Ester.EV, Route.injection, -41),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(0);
        expect(report.mismatches).toHaveLength(0);
    });

    it('does not cross drug categories', () => {
        // Plan = CPA/oral. History = 4 EV/injection. Different category → no flag.
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.CPA, Route.oral)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(0);
        expect(report.mismatches).toHaveLength(0);
    });

    it('detail samples are ordered newest-first', () => {
        const events = [
            mkEvent(Ester.EV, Route.gel, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.gel, -7),
            mkEvent(Ester.EV, Route.gel, -10),
            mkEvent(Ester.EV, Route.gel, -15),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.mismatches).toHaveLength(1);
        const samples = report.mismatches[0].samples;
        expect(samples).toHaveLength(COMPLIANCE_DETAIL_SAMPLE_COUNT);
        expect(samples[0].timeH).toBeGreaterThan(samples[samples.length - 1].timeH);
    });

    it('tags each sample with matchesPlan (per-record boolean)', () => {
        // 3 EV/gel + 1 EV/injection. Plan = EV/injection → mismatch.
        // Detail: 1 injection entry matches plan; 3 gel entries do not.
        const events = [
            mkEvent(Ester.EV, Route.gel, -1),
            mkEvent(Ester.EV, Route.gel, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        const report = analyzePlanCompliance(events, plans, TODAY);
        const samples = report.mismatches[0].samples;
        const matched = samples.filter((s) => s.matchesPlan);
        const mismatched = samples.filter((s) => !s.matchesPlan);
        expect(matched).toHaveLength(1);
        expect(mismatched).toHaveLength(3);
        expect(matched[0].route).toBe(Route.injection);
    });

    it('picks the latest-updated enabled plan when two share a category', () => {
        // Defensive — AppDataContext setter normally prevents this.
        const planA = mkPlan(Ester.EV, Route.injection, {
            id: 'plan-a',
            updatedAtH: (TODAY.getTime() - 2 * 86400000) / 3600000,
        });
        const planB = mkPlan(Ester.EV, Route.gel, {
            id: 'plan-b',
            updatedAtH: (TODAY.getTime() - 1 * 86400000) / 3600000,  // newer
        });
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const report = analyzePlanCompliance(events, [planA, planB], TODAY);
        expect(report.mismatches).toHaveLength(1);
        expect(report.mismatches[0].plan.id).toBe('plan-b');
    });

    it('handles multiple categories independently', () => {
        // Plan A: estrogen (EV/injection). Plan B: anti-androgen (CPA/oral).
        // History: 4 EV/injection + 4 CPA/oral. Both should match.
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
            mkEvent(Ester.EV, Route.injection, -7),
            mkEvent(Ester.CPA, Route.oral, -1),
            mkEvent(Ester.CPA, Route.oral, -3),
            mkEvent(Ester.CPA, Route.oral, -5),
            mkEvent(Ester.CPA, Route.oral, -7),
        ];
        const plans = [
            mkPlan(Ester.EV, Route.injection),
            mkPlan(Ester.CPA, Route.oral),
        ];
        const report = analyzePlanCompliance(events, plans, TODAY);
        expect(report.matches).toHaveLength(2);
        expect(report.mismatches).toHaveLength(0);
    });

    it('opts.windowDays narrows the look-back', () => {
        // 4 records inside 30d but outside 14d.
        const events = [
            mkEvent(Ester.EV, Route.injection, -25),
            mkEvent(Ester.EV, Route.injection, -27),
            mkEvent(Ester.EV, Route.injection, -29),
            mkEvent(Ester.EV, Route.injection, -23),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        // Default 30d → match.
        expect(analyzePlanCompliance(events, plans, TODAY).matches).toHaveLength(1);
        // 14d window → none inside → empty.
        expect(
            analyzePlanCompliance(events, plans, TODAY, { windowDays: 14 }).matches,
        ).toHaveLength(0);
    });

    it('opts.minSamples lowers the sample floor', () => {
        const events = [
            mkEvent(Ester.EV, Route.injection, -1),
            mkEvent(Ester.EV, Route.injection, -3),
            mkEvent(Ester.EV, Route.injection, -5),
        ];
        const plans = [mkPlan(Ester.EV, Route.injection)];
        // Default 4 → 3 < 4, no result.
        expect(analyzePlanCompliance(events, plans, TODAY).matches).toHaveLength(0);
        // 3 → 3 ≥ 3, match.
        expect(
            analyzePlanCompliance(events, plans, TODAY, { minSamples: 3 }).matches,
        ).toHaveLength(1);
    });

    it('opts.matchRatio raises the dominance threshold', () => {
        // 3 EV/gel + 1 EV/injection. Dominant = 3/4 = 75% = EV/gel. Plan = gel.
        const events = [
            mkEvent(Ester.EV, Route.gel, -1),
            mkEvent(Ester.EV, Route.gel, -3),
            mkEvent(Ester.EV, Route.gel, -5),
            mkEvent(Ester.EV, Route.injection, -7),
        ];
        const plans = [mkPlan(Ester.EV, Route.gel)];
        // 0.75 default → 75% ≥ 75% → match.
        expect(analyzePlanCompliance(events, plans, TODAY).matches).toHaveLength(1);
        // 0.80 → 75% < 80% → no dominant → mismatch with null historyMain.
        const r2 = analyzePlanCompliance(events, plans, TODAY, { matchRatio: 0.8 });
        expect(r2.matches).toHaveLength(0);
        expect(r2.mismatches).toHaveLength(1);
        expect(r2.mismatches[0].historyMain).toBeNull();
    });
});
