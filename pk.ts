import { Route, Ester, ExtraKey, type DoseEvent, type SimulationResult, type ConcUnit } from './types';

/**
 * Route-specific metadata for transdermal gel absorption.
 *
 * These definitions live in the PK module because they directly affect
 * bioavailability calculations and are not useful outside the simulation layer.
 */
enum GelSite {
    arm = "arm",
    thigh = "thigh",
    scrotal = "scrotal"
}

const GEL_SITE_ORDER = ["arm", "thigh", "scrotal"] as const;

const GelSiteParams = {
    [GelSite.arm]: 0.05,
    [GelSite.thigh]: 0.05,
    [GelSite.scrotal]: 0.40
};

/**
 * Shared PK constants used by the population model.
 *
 * These are exported because the personal-model code in `logic.ts` still builds
 * on top of the same physiological assumptions and needs direct access to them.
 */
export const CorePK = {
    vdPerKG: 2.0,
    /** @deprecated Use CPA_2COMP_PK.V1_per_kg (central Vc) instead of this apparent Vd */
    vdPerKG_CPA: 14.0,
    kClear: 0.41,
    kClearInjection: 0.041,
    depotK1Corr: 1.0
};

/**
 * CPA 2-compartment oral PK constants calibrated to high-dose oral tablet SmPC
 * data (e.g. Androcur / Cyprostat 50 mg tablets), which better matches the
 * tablet regimens used in this app than the much earlier-peaking 2 mg
 * Diane-35 formulation.
 *
 * Targets used for the calibration:
 * - absolute bioavailability F ≈ 88%
 * - single-dose Cmax ≈ 285 ng/mL at Tmax ≈ 3 h after 100 mg oral
 * - terminal half-life t1/2 ≈ 43.9 h
 * - total clearance ≈ 3.5 mL/min/kg
 *
 * Exported so higher-level calibration code can reuse the same population
 * variance and central-compartment assumptions without duplicating numbers.
 */
export const CPA_2COMP_PK = {
    F: 0.88,
    ka: 0.60,
    alpha: 0.20,
    beta: 0.01579,
    k21: 0.04,
    V1_per_kg: 2.666,
    popLogVar: 0.09,
};

/**
 * Bicalutamide apparent one-compartment oral PK constants ("chronic calibration"
 * default set). Bicalutamide's clinically relevant activity comes from the
 * (R)-enantiomer; we model that directly with apparent first-order absorption /
 * elimination rather than splitting enantiomers or first-pass.
 *
 * Targets used for the calibration (FDA Casodex label, Table 3; SmPC):
 * - single-dose Tmax ≈ 31 h, Cmax ≈ 0.77 µg/mL
 * - terminal half-life ≈ 5.8 d
 * - 50 mg once-daily steady state ≈ 9 µg/mL
 *
 * `vOverF` is an ABSOLUTE apparent volume (L), not per-kg, so the concentration
 * conversion for bicalutamide does not scale with body weight.
 */
export const BICA_PK = {
    ka: 0.10,                       // h^-1  (Tmax ≈ 31 h)
    ke: Math.log(2) / (5.8 * 24),   // h^-1  (t½ ≈ 5.8 d)
    vOverF: 50.2,                   // L (apparent V/F)
    popLogVar: 0.10,                // ≈ 30% CV population PK uncertainty
};

/**
 * Specification for a non-E2 anti-androgen compound. The registry below drives
 * the PK engine, the personal-model CI layer, and the UI so that adding another
 * anti-androgen later only requires registering one more entry here.
 */
export interface AntiandrogenSpec {
    ester: Ester;
    /** Unit the concentration values are stored in (always ng/mL today). */
    nativeUnit: ConcUnit;
    /** Chart / UI accent color. */
    color: string;
    /** Population PK log-variance used for the confidence band. */
    popLogVar: number;
    /** Upper clamp for adjusted value & CI bounds, in the native unit. */
    ciMaxNative: number;
    /** Whether the compound inherits the E2-inferred adherence amplitude. */
    adherenceFromE2: boolean;
    /** Convert a precomputed central-compartment amount (mg) to native conc. */
    concFromAmountMG: (amountMG: number, weightKG: number) => number;
}

export const ANTIANDROGENS: Partial<Record<Ester, AntiandrogenSpec>> = {
    [Ester.CPA]: {
        ester: Ester.CPA,
        nativeUnit: 'ng/mL',
        color: '#8b5cf6',
        popLogVar: CPA_2COMP_PK.popLogVar,
        ciMaxNative: 500,
        adherenceFromE2: true,
        concFromAmountMG: (amountMG, weightKG) => {
            const v1mL = CPA_2COMP_PK.V1_per_kg * weightKG * 1000;
            return v1mL > 0 ? Math.max(0, (amountMG * 1e6) / v1mL) : 0;
        },
    },
    [Ester.BICA]: {
        ester: Ester.BICA,
        nativeUnit: 'ng/mL',
        color: '#f59e0b',
        popLogVar: BICA_PK.popLogVar,
        ciMaxNative: 20000,
        adherenceFromE2: false,
        // amount (mg) / V/F (L) -> mg/L; ×1000 -> ng/mL
        concFromAmountMG: (amountMG) => Math.max(0, (amountMG / BICA_PK.vOverF) * 1000),
    },
};

export const ANTIANDROGEN_ESTERS = Object.keys(ANTIANDROGENS) as Ester[];

/** True when the ester is a tracked non-E2 anti-androgen (CPA / BICA / …). */
export function isAntiandrogen(ester: Ester): boolean {
    return Object.prototype.hasOwnProperty.call(ANTIANDROGENS, ester);
}

/**
 * Pick which anti-androgen "owns" the shared right axis / headline: the most
 * recently dosed anti-androgen. CPA and bicalutamide are clinical alternatives
 * with ~1000× different scales, so only one is shown at a time — whichever the
 * user took last.
 *
 * When `nowH` is given, doses already taken (timeH ≤ now) win; if every
 * anti-androgen dose is still in the future, the soonest upcoming one is used.
 * When `nowH` is omitted, the latest dose by time is chosen.
 *
 * Tie-break: when two anti-androgen doses share the winning timeH, the one
 * appearing later in `events` wins (i.e. the most recently recorded), so the
 * result is deterministic for a given input order.
 */
export function pickPrimaryAntiandrogen(events: DoseEvent[], nowH?: number): Ester | null {
    const aa = events.filter(e => isAntiandrogen(e.ester));
    if (aa.length === 0) return null;
    if (nowH === undefined) {
        return aa.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    const past = aa.filter(e => e.timeH <= nowH);
    if (past.length > 0) {
        return past.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    return aa.reduce((a, b) => (b.timeH < a.timeH ? b : a)).ester;
}

/**
 * Scale a native (ng/mL) anti-androgen concentration into a display unit,
 * auto-promoting to µg/mL once the value reaches 1000 ng/mL so large compounds
 * (bicalutamide) don't render as "9000 ng/mL".
 */
export function formatAntiandrogenConc(
    ngml: number,
    spec: AntiandrogenSpec
): { value: number; unit: ConcUnit } {
    if (spec.nativeUnit === 'ng/mL' && ngml >= 1000) {
        return { value: ngml / 1000, unit: 'ug/mL' };
    }
    return { value: ngml, unit: spec.nativeUnit };
}

const EsterInfo = {
    [Ester.E2]: { name: "Estradiol", mw: 272.38 },
    [Ester.EB]: { name: "Estradiol Benzoate", mw: 376.50 },
    [Ester.EV]: { name: "Estradiol Valerate", mw: 356.50 },
    [Ester.EC]: { name: "Estradiol Cypionate", mw: 396.58 },
    [Ester.EN]: { name: "Estradiol Enanthate", mw: 384.56 },
    [Ester.CPA]: { name: "Cyproterone Acetate", mw: 416.94 },
    [Ester.BICA]: { name: "Bicalutamide", mw: 430.37 }
};

/**
 * Convert a compound / ester dose into estradiol-equivalent molar mass scaling.
 */
export function getToE2Factor(ester: Ester): number {
    if (ester === Ester.E2) return 1.0;
    return EsterInfo[Ester.E2].mw / EsterInfo[ester].mw;
}

const TwoPartDepotPK = {
    Frac_fast: { [Ester.EB]: 0.90, [Ester.EV]: 0.40, [Ester.EC]: 0.229164549, [Ester.EN]: 0.05, [Ester.E2]: 1.0 },
    k1_fast: { [Ester.EB]: 0.144, [Ester.EV]: 0.0216, [Ester.EC]: 0.005035046, [Ester.EN]: 0.0010, [Ester.E2]: 0.5 },
    k1_slow: { [Ester.EB]: 0.114, [Ester.EV]: 0.0138, [Ester.EC]: 0.004510574, [Ester.EN]: 0.0050, [Ester.E2]: 0 }
};

const InjectionPK = {
    formationFraction: { [Ester.EB]: 0.1092, [Ester.EV]: 0.0623, [Ester.EC]: 0.1173, [Ester.EN]: 0.12, [Ester.E2]: 1.0 }
};

const EsterPK = {
    k2: { [Ester.EB]: 0.090, [Ester.EV]: 0.070, [Ester.EC]: 0.045, [Ester.EN]: 0.015, [Ester.E2]: 0 }
};

const OralPK = {
    kAbsE2: 0.32,
    kAbsEV: 0.05,
    bioavailability: 0.03,
    kAbsSL: 1.8
};

// Deterministic ordering keeps the serialized tier index stable across UI and PK code.
export const SL_TIER_ORDER = ["quick", "casual", "standard", "strict"] as const;

export const SublingualTierParams = {
    quick: { theta: 0.01, hold: 2 },
    casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 },
    strict: { theta: 0.18, hold: 15 }
};

/**
 * Route-specific bioavailability multiplier used to map recorded dose to
 * systemically available hormone amount.
 *
 * This function is intentionally exported because both UI helpers and PK logic
 * need to agree on the same route-specific conversion rules.
 */
export function getBioavailabilityMultiplier(
    route: Route,
    ester: Ester,
    extras: Partial<Record<ExtraKey, number>> = {}
): number {
    const mwFactor = getToE2Factor(ester);

    switch (route) {
        case Route.injection: {
            const formation = InjectionPK.formationFraction[ester] ?? 0.08;
            return formation * mwFactor;
        }
        case Route.oral:
            return OralPK.bioavailability * mwFactor;
        case Route.sublingual: {
            let theta = 0.11;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.sublingualTier]!)));
                const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                theta = SublingualTierParams[tierKey]?.theta ?? 0.11;
            }
            return (theta + (1 - theta) * OralPK.bioavailability) * mwFactor;
        }
        case Route.gel: {
            const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.gelSite] ?? 0)));
            const siteKey = GEL_SITE_ORDER[siteIdx] ?? GelSite.arm;
            const bio = GelSiteParams[siteKey] ?? 0.05;
            return bio * mwFactor;
        }
        case Route.patchApply:
            return 1.0 * mwFactor;
        case Route.patchRemove:
        default:
            return 0;
    }
}

interface PKParams {
    Frac_fast: number;
    k1_fast: number;
    k1_slow: number;
    k2: number;
    k3: number;
    F: number;
    rateMGh: number;
    F_fast: number;
    F_slow: number;
}

/**
 * Resolve one dose event into the low-level PK parameters used by the solvers.
 *
 * Exported because the EKF layer reuses the same route-specific model, but with
 * a learned clearance scaling applied on top.
 */
export function resolveParams(event: DoseEvent): PKParams {
    const defaultK3 = event.route === Route.injection ? CorePK.kClearInjection : CorePK.kClear;
    const toE2 = getToE2Factor(event.ester);
    const extras = event.extras ?? {};

    switch (event.route) {
        case Route.injection: {
            const Frac_fast = TwoPartDepotPK.Frac_fast[event.ester] ?? 0.5;
            const k1_fast = (TwoPartDepotPK.k1_fast[event.ester] ?? 0.1) * CorePK.depotK1Corr;
            const k1_slow = (TwoPartDepotPK.k1_slow[event.ester] ?? 0.01) * CorePK.depotK1Corr;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F = getBioavailabilityMultiplier(Route.injection, event.ester, extras);
            return { Frac_fast, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.sublingual: {
            let theta = 0.11;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierRaw = extras[ExtraKey.sublingualTier];
                if (typeof tierRaw === 'number' && Number.isFinite(tierRaw)) {
                    const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(tierRaw)));
                    const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                    theta = SublingualTierParams[tierKey]?.theta ?? theta;
                }
            }
            const k1_fast = OralPK.kAbsSL;
            const k1_slow = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F_fast = toE2;
            const F_slow = OralPK.bioavailability * toE2;
            const F = theta * F_fast + (1 - theta) * F_slow;
            return { Frac_fast: theta, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast, F_slow };
        }

        case Route.gel: {
            const F = getBioavailabilityMultiplier(Route.gel, event.ester, extras);
            const k1 = 0.022;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchApply: {
            const F = getBioavailabilityMultiplier(Route.patchApply, event.ester, extras);
            const releaseRateUGPerDay = extras[ExtraKey.releaseRateUGPerDay];
            const rateMGh = (typeof releaseRateUGPerDay === 'number' && Number.isFinite(releaseRateUGPerDay) && releaseRateUGPerDay > 0)
                ? (releaseRateUGPerDay / 24 / 1000) * F
                : 0;
            if (rateMGh > 0) {
                return { Frac_fast: 1.0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh, F_fast: F, F_slow: F };
            }
            const k1 = 0.0075;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchRemove:
            return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };

        case Route.oral: {
            if (isAntiandrogen(event.ester)) {
                // Anti-androgens (CPA / bicalutamide) are dosed as raw compound
                // mg and their amount is produced by their own model in
                // PrecomputedEventModel; these params are not used for them.
                return {
                    Frac_fast: 1.0,
                    k1_fast: 1.0,
                    k1_slow: 0,
                    k2: 0,
                    k3: 0.017,
                    F: 0.7,
                    rateMGh: 0,
                    F_fast: 0.7,
                    F_slow: 0.7
                };
            }

            const k1Value = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;
            const F = OralPK.bioavailability * toE2;
            return { Frac_fast: 1.0, k1_fast: k1Value, k1_slow: 0, k2: k2Value, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }
    }

    return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
}

/**
 * Analytical single-dose oral CPA solution for the central compartment.
 *
 * Exported so the individualized CPA prediction in `logic.ts` can reuse the
 * exact same population model as the baseline simulation.
 */
export function compute2CompCPACentralAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { F, ka, alpha, beta, k21 } = CPA_2COMP_PK;
    const eps = 1e-8;
    if (Math.abs(alpha - ka) < eps || Math.abs(beta - ka) < eps || Math.abs(alpha - beta) < eps) {
        if (Math.abs(ka - beta) < eps) return Math.max(0, doseMG * F * ka * tau * Math.exp(-beta * tau));
        return Math.max(0, doseMG * F * ka / (ka - beta) * (Math.exp(-beta * tau) - Math.exp(-ka * tau)));
    }
    const A = (k21 - ka) / ((alpha - ka) * (beta - ka));
    const B = (k21 - alpha) / ((ka - alpha) * (beta - alpha));
    const C = (k21 - beta) / ((ka - beta) * (alpha - beta));
    const val = doseMG * F * ka * (
        A * Math.exp(-ka * tau) +
        B * Math.exp(-alpha * tau) +
        C * Math.exp(-beta * tau)
    );
    return Math.max(0, val);
}

/**
 * Analytical single-dose oral bicalutamide central-compartment amount (mg) at
 * elapsed time `tau` hours, using apparent one-compartment first-order
 * absorption / elimination. Dividing this by `BICA_PK.vOverF` (and ×1000)
 * yields ng/mL — see `ANTIANDROGENS[Ester.BICA].concFromAmountMG`.
 */
export function computeBicalutamideAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { ka, ke } = BICA_PK;
    if (Math.abs(ka - ke) < 1e-9) {
        return Math.max(0, doseMG * ka * tau * Math.exp(-ke * tau));
    }
    return Math.max(0, doseMG * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau)));
}

/**
 * Bicalutamide plasma concentration in ng/mL at a single time point, summed
 * over all past oral BICA doses. Independent of the simulation grid (no time
 * bound), so it is also used directly by unit tests.
 */
export function bicalutamideConcNgML(events: DoseEvent[], timeH: number): number {
    const spec = ANTIANDROGENS[Ester.BICA]!;
    let totalAmountMG = 0;
    for (const ev of events) {
        if (ev.ester !== Ester.BICA || ev.route !== Route.oral) continue;
        if (ev.timeH > timeH) continue;
        totalAmountMG += computeBicalutamideAmount(ev.doseMG, timeH - ev.timeH);
    }
    return spec.concFromAmountMG(totalAmountMG, 0);
}

/**
 * Closed-form 3-compartment amount model used by the injectable and EV routes.
 */
export function _analytic3C(tau: number, doseMG: number, F: number, k1: number, k2: number, k3: number): number {
    if (k1 <= 0 || doseMG <= 0) return 0;
    const k1_k2 = k1 - k2;
    const k1_k3 = k1 - k3;
    const k2_k3 = k2 - k3;

    if (Math.abs(k1_k2) < 1e-9 || Math.abs(k1_k3) < 1e-9 || Math.abs(k2_k3) < 1e-9) return 0;

    const term1 = Math.exp(-k1 * tau) / (k1_k2 * k1_k3);
    const term2 = Math.exp(-k2 * tau) / (-k1_k2 * k2_k3);
    const term3 = Math.exp(-k3 * tau) / (k1_k3 * k2_k3);

    return doseMG * F * k1 * k2 * (term1 + term2 + term3);
}

/**
 * Standard one-compartment first-order absorption / elimination solution.
 */
export function oneCompAmount(tau: number, doseMG: number, p: PKParams): number {
    const k1 = p.k1_fast;
    if (Math.abs(k1 - p.k3) < 1e-9) {
        return doseMG * p.F * k1 * tau * Math.exp(-p.k3 * tau);
    }
    return doseMG * p.F * k1 / (k1 - p.k3) * (Math.exp(-p.k3 * tau) - Math.exp(-k1 * tau));
}

/**
 * Precomputed per-event model wrapper.
 *
 * The class is kept local to this file because it is only an implementation
 * detail of `runSimulation` and does not need to leak into the rest of the app.
 */
class PrecomputedEventModel {
    private model: (t: number) => number;

    constructor(event: DoseEvent, allEvents: DoseEvent[]) {
        const params = resolveParams(event);
        const startTime = event.timeH;
        const dose = event.doseMG;

        switch (event.route) {
            case Route.injection:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    const doseFast = dose * params.Frac_fast;
                    const doseSlow = dose * (1.0 - params.Frac_fast);

                    return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, params.k3) +
                        _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, params.k3);
                };
                break;
            case Route.gel:
            case Route.oral:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (event.ester === Ester.CPA) {
                        return compute2CompCPACentralAmount(dose, tau);
                    }
                    if (event.ester === Ester.BICA) {
                        return computeBicalutamideAmount(dose, tau);
                    }
                    return oneCompAmount(tau, dose, params);
                };
                break;
            case Route.sublingual:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (params.k2 > 0) {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);
                        return _analytic3C(tau, doseF, params.F_fast, params.k1_fast, params.k2, params.k3) +
                            _analytic3C(tau, doseS, params.F_slow, params.k1_slow, params.k2, params.k3);
                    } else {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);

                        const branch = (d: number, F: number, ka: number, ke: number, t: number) => {
                            if (Math.abs(ka - ke) < 1e-9) return d * F * ka * t * Math.exp(-ke * t);
                            return d * F * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
                        };
                        return branch(doseF, params.F_fast, params.k1_fast, params.k3, tau) +
                            branch(doseS, params.F_slow, params.k1_slow, params.k3, tau);
                    }
                };
                break;
            case Route.patchApply: {
                const remove = allEvents.find(e => e.route === Route.patchRemove && e.timeH > startTime);
                const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;

                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;

                    if (params.rateMGh > 0) {
                        if (tau <= wearH) {
                            return params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * tau));
                        } else {
                            const amtRemoval = params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * wearH));
                            return amtRemoval * Math.exp(-params.k3 * (tau - wearH));
                        }
                    }

                    const amtUnderPatch = oneCompAmount(tau, dose, params);
                    if (tau > wearH) {
                        const amtAtRemoval = oneCompAmount(wearH, dose, params);
                        return amtAtRemoval * Math.exp(-params.k3 * (tau - wearH));
                    }
                    return amtUnderPatch;
                };
                break;
            }
            default:
                this.model = () => 0;
        }
    }

    amount(timeH: number): number {
        return this.model(timeH);
    }
}

/**
 * Body weight in kg at simulation time `t`, derived from per-event weight as a
 * step function. The earliest dose's weight is extended backward so points
 * before the first event still get a meaningful Vd. When multiple events share
 * the same `timeH`, the LAST one (most-recently-added under stable sort) wins
 * — this yields a single deterministic value across the whole `t` axis,
 * including the boundary `t === sortedEvents[0].timeH`. Assumes `sortedEvents`
 * is already sorted ascending by `timeH`.
 */
export function weightAtTimeH(sortedEvents: DoseEvent[], t: number): number {
    if (sortedEvents.length === 0) return 70;
    let result = sortedEvents[0].weightKG;
    for (let i = 0; i < sortedEvents.length; i++) {
        if (sortedEvents[i].timeH <= t) {
            result = sortedEvents[i].weightKG;
        } else {
            break;
        }
    }
    return result;
}

/**
 * Main deterministic population simulation engine.
 *
 * This function is kept pure: it only depends on the recorded events (each of
 * which carries its own body weight), which makes it a stable foundation for
 * later calibration layers.
 */
export function runSimulation(events: DoseEvent[]): SimulationResult | null {
    if (events.length === 0) return null;

    const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
    const precomputed = sortedEvents
        .filter(e => e.route !== Route.patchRemove)
        .map(e => ({ model: new PrecomputedEventModel(e, sortedEvents), ester: e.ester }));

    const startTime = sortedEvents[0].timeH - 24;
    const endTime = sortedEvents[sortedEvents.length - 1].timeH + (24 * 14);

    // Determine the finest time resolution needed based on the routes present.
    // Sublingual peaks are narrow (~1–2 h wide) and need a small step to be
    // captured accurately; slow routes like injection tolerate coarser grids.
    const routes = new Set(sortedEvents.map(e => e.route));
    const maxStepH = routes.has(Route.sublingual) ? 0.25
        : routes.has(Route.oral) ? 0.5
        : routes.has(Route.gel) ? 1.0
        : 2.0;
    const steps = Math.max(1000, Math.ceil((endTime - startTime) / maxStepH) + 1);

    const timeH: number[] = [];
    const concPGmL: number[] = [];
    const concPGmL_E2: number[] = [];
    const concPGmL_CPA: number[] = [];
    // Generic per-compound concentration series for every anti-androgen that
    // actually appears in the event list (CPA / bicalutamide / …).
    const presentAntiandrogens = ANTIANDROGEN_ESTERS.filter(
        e => sortedEvents.some(ev => ev.ester === e)
    );
    const byCompound: Partial<Record<Ester, { unit: 'ng/mL'; values: number[] }>> = {};
    for (const e of presentAntiandrogens) {
        byCompound[e] = { unit: 'ng/mL', values: [] };
    }
    let auc = 0;

    const stepSize = (endTime - startTime) / (steps - 1);

    for (let i = 0; i < steps; i++) {
        const t = startTime + i * stepSize;
        let totalAmountMG_E2 = 0;
        const amountByCompound: Partial<Record<Ester, number>> = {};

        for (const { model, ester } of precomputed) {
            const amount = model.amount(t);
            if (isAntiandrogen(ester)) {
                amountByCompound[ester] = (amountByCompound[ester] ?? 0) + amount;
            } else {
                totalAmountMG_E2 += amount;
            }
        }

        const bodyWeightKG = weightAtTimeH(sortedEvents, t);
        const plasmaVolumeML_E2 = CorePK.vdPerKG * bodyWeightKG * 1000;

        const currentConc_E2 = (totalAmountMG_E2 * 1e9) / plasmaVolumeML_E2;

        // Convert each present anti-androgen's amount to its native (ng/mL) conc.
        let currentConc_CPA = 0;
        for (const e of presentAntiandrogens) {
            const spec = ANTIANDROGENS[e]!;
            const conc = spec.concFromAmountMG(amountByCompound[e] ?? 0, bodyWeightKG);
            byCompound[e]!.values.push(conc);
            if (e === Ester.CPA) currentConc_CPA = conc;
        }

        // Total curve keeps the historical behavior: E2 plus CPA scaled into
        // pg/mL. Bicalutamide is intentionally NOT folded into the total.
        const currentConc = currentConc_E2 + (currentConc_CPA * 1000);

        timeH.push(t);
        concPGmL.push(currentConc);
        concPGmL_E2.push(currentConc_E2);
        concPGmL_CPA.push(currentConc_CPA);

        if (i > 0) {
            auc += 0.5 * (currentConc + concPGmL[i - 1]) * stepSize;
        }
    }

    return { timeH, concPGmL, concPGmL_E2, concPGmL_CPA, byCompound, auc };
}

/**
 * Shared linear interpolation helper for simulation curves.
 *
 * Keeping the search / interpolation logic in one place avoids subtle drift
 * between total, E2-only, and CPA-only views.
 */
function interpolateSeries(
    timeH: number[],
    conc: number[],
    hour: number
): number | null {
    if (!timeH.length) return null;
    if (hour <= timeH[0]) return conc[0];
    if (hour >= timeH[timeH.length - 1]) return conc[conc.length - 1];

    let low = 0;
    let high = timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (timeH[mid] === hour) return conc[mid];
        if (timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = timeH[low];
    const t1 = timeH[high];
    const c0 = conc[low];
    const c1 = conc[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

export function interpolateConcentration(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL, hour);
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL_E2, hour);
}

/**
 * Interpolate a non-E2 compound's component curve (native unit, ng/mL) at the
 * given hour. Returns null when the compound is not present in the simulation.
 */
export function interpolateCompoundConcentration(
    sim: SimulationResult,
    ester: Ester,
    hour: number
): number | null {
    const series = sim.byCompound?.[ester];
    if (!series) return null;
    return interpolateSeries(sim.timeH, series.values, hour);
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    return interpolateCompoundConcentration(sim, Ester.CPA, hour);
}
