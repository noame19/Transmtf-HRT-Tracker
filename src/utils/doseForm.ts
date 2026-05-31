/**
 * Shared helpers for the dose-entry forms (DoseFormModal + BatchDoseModal).
 *
 * Centralizing the route ordering, per-route compound lists, quick-dose presets
 * and the per-drug "last dose" memory keeps the single-add and batch-add modals
 * from drifting apart (they previously diverged on route order and defaults).
 */
import { Route, Ester } from '../../logic';

/**
 * Display order for the route selector. Decoupled from the `Route` enum
 * declaration order (which is serialized to storage and must stay stable) so we
 * can surface the most-used routes — sublingual then oral — at the top.
 */
export const ROUTE_DISPLAY_ORDER: Route[] = [
    Route.sublingual,
    Route.oral,
    Route.injection,
    Route.patchApply,
    Route.patchRemove,
    Route.gel,
];

/**
 * Compounds available per route. Sublingual lists EV first so estradiol valerate
 * is the default sublingual compound.
 */
export const getAvailableEsters = (route: Route): Ester[] => {
    switch (route) {
        case Route.injection:
            return [Ester.EB, Ester.EV, Ester.EC, Ester.EN];
        case Route.oral:
            return [Ester.E2, Ester.EV, Ester.CPA, Ester.BICA];
        case Route.sublingual:
            return [Ester.EV, Ester.E2];
        default:
            return [Ester.E2];
    }
};

/**
 * Quick-select dose tiers per compound, expressed in mg of the compound itself
 * (the tablet/dose taken), NOT the estradiol-equivalent. Only surfaced for the
 * oral / sublingual routes.
 */
export const DOSE_QUICK_PRESETS: Partial<Record<Ester, number[]>> = {
    [Ester.E2]: [1, 2, 3, 4],
    [Ester.EV]: [1, 2, 3, 4],
    [Ester.CPA]: [6.25, 12.5, 25],
    [Ester.BICA]: [20, 25, 50],
};

/** True when `mg` matches one of the compound's quick-select presets. */
export const isPresetDose = (ester: Ester, mg: number): boolean => {
    const presets = DOSE_QUICK_PRESETS[ester];
    return !!presets && Number.isFinite(mg) && presets.some(p => Math.abs(p - mg) < 1e-6);
};

/** Whether the quick-dose panel applies to this route+compound combination. */
export const hasQuickDosePanel = (route: Route, ester: Ester): boolean =>
    (route === Route.sublingual || route === Route.oral) && !!DOSE_QUICK_PRESETS[ester];

/**
 * Per-drug remembered dose, keyed by `${route}:${ester}` so one compound's last
 * entered dose never leaks onto another.
 */
export interface DrugMemo {
    rawDose: string;
    e2Dose: string;
    patchMode?: 'dose' | 'rate';
    patchRate?: string;
    slTier?: number;
    useCustomTheta?: boolean;
    customTheta?: string;
    customDose?: boolean; // quick panel: was the manual-input mode active
}

// These two keys are intentionally device-local (not cloud-synced), matching the
// existing `hrt-dose-templates` behavior: they only prefill the form for
// convenience. The medication records themselves (`hrt-events`) are the synced
// source of truth, so a per-device "last dose" preference is acceptable drift.
const DOSE_BY_DRUG_KEY = 'hrt-dose-by-drug';
const DOSE_LAST_DRUG_KEY = 'hrt-dose-last-drug';

export const drugKeyOf = (route: Route, ester: Ester) => `${route}:${ester}`;

// --- Validation helpers so corrupt / stale localStorage can never poison state ---
const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

export const isRoute = (v: unknown): v is Route =>
    typeof v === 'string' && (Object.values(Route) as string[]).includes(v);

export const isEster = (v: unknown): v is Ester =>
    typeof v === 'string' && (Object.values(Ester) as string[]).includes(v);

const isPatchMode = (v: unknown): v is 'dose' | 'rate' => v === 'dose' || v === 'rate';

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asOptStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asOptBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asOptNum = (v: unknown): number | undefined =>
    (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Normalize one stored entry: every field is coerced to its expected type so a
// hand-edited / older-version blob can't push an illegal value (e.g. a bogus
// patchMode) into React state. Non-object entries are dropped.
const normalizeMemo = (v: unknown): DrugMemo | null => {
    if (!isRecord(v)) return null;
    return {
        rawDose: asStr(v.rawDose),
        e2Dose: asStr(v.e2Dose),
        patchMode: isPatchMode(v.patchMode) ? v.patchMode : undefined,
        patchRate: asOptStr(v.patchRate),
        slTier: asOptNum(v.slTier),
        useCustomTheta: asOptBool(v.useCustomTheta),
        customTheta: asOptStr(v.customTheta),
        customDose: asOptBool(v.customDose),
    };
};

export const readDoseByDrug = (): Record<string, DrugMemo> => {
    try {
        const saved = localStorage.getItem(DOSE_BY_DRUG_KEY);
        if (!saved) return {};
        const parsed = JSON.parse(saved);
        if (!isRecord(parsed)) return {};
        const out: Record<string, DrugMemo> = {};
        for (const [key, val] of Object.entries(parsed)) {
            const memo = normalizeMemo(val);
            if (memo) out[key] = memo;
        }
        return out;
    } catch {
        return {};
    }
};

export const writeDoseMemo = (route: Route, ester: Ester, memo: DrugMemo) => {
    try {
        const byDrug = readDoseByDrug();
        byDrug[drugKeyOf(route, ester)] = memo;
        localStorage.setItem(DOSE_BY_DRUG_KEY, JSON.stringify(byDrug));
        localStorage.setItem(DOSE_LAST_DRUG_KEY, JSON.stringify({ route, ester }));
    } catch {
        /* ignore */
    }
};

export const readLastDrug = (): { route: Route; ester: Ester } | null => {
    try {
        const saved = localStorage.getItem(DOSE_LAST_DRUG_KEY);
        if (!saved) return null;
        const last = JSON.parse(saved);
        // Only accept a real enum route + a compound that is actually valid for it.
        if (isRecord(last) && isRoute(last.route) && isEster(last.ester) &&
            getAvailableEsters(last.route).includes(last.ester)) {
            return { route: last.route, ester: last.ester };
        }
        return null;
    } catch {
        return null;
    }
};
