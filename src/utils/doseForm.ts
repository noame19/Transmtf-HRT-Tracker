/**
 * Shared helpers for the dose-entry forms (DoseFormModal + BatchDoseModal).
 *
 * Centralizing the route ordering, per-route compound lists, quick-dose presets
 * and the per-drug "last dose" memory keeps the single-add and batch-add modals
 * from drifting apart (they previously diverged on route order and defaults).
 */
import {
    Route, Ester, ExtraKey, GEL_PRODUCTS, GEL_DEFAULT_PRODUCT_ID, GEL_CUSTOM_ID_BASE,
    sanitizeGelProducts,
    type DoseEvent, type GelProductSpec,
} from '../../logic';

/**
 * Display order for the route selector. Decoupled from the `Route` enum
 * declaration order (which is serialized to storage and must stay stable) so we
 * can surface the most-used routes — sublingual then oral — at the top.
 *
 * Note: `Route.patchRemove` is intentionally NOT surfaced here. The
 * DoseFormModal exposes a single "贴片" entry (= `Route.patchApply`) and
 * handles patch removal via an optional "摘下时间" field on the form OR via
 * the "贴片移除" button on the /history list — both code paths write a
 * separate `Route.patchRemove` event linked by `companionGroupId`. The PK
 * engine still pairs apply↔remove by scanning the time axis, so legacy data
 * with two un-grouped events continues to work.
 */

/** 给药方式 + 药物 复合 key — 用于「上次用药」「档位」「剂量参考」等所有 per-(route,ester) 索引 */
export const drugKeyOf = (route: Route, ester: Ester) => `${route}:${ester}`;

export const ROUTE_DISPLAY_ORDER: Route[] = [
    Route.sublingual,
    Route.oral,
    Route.injection,
    Route.patchApply,
    Route.gel,
    // 直肠 (rectal) — 黄体酮的典型睡前给药途径。放在末尾：使用频率最低。
    Route.rectal,
];

/**
 * Compounds available per route. Sublingual lists EV first so estradiol valerate
 * is the default sublingual compound.
 */
export const getAvailableEsters = (route: Route): Ester[] => {
    switch (route) {
        // EU (estradiol undecylate) sits next to EV (valerate) so the two
        // similarly-named depot esters are easy to tell apart at selection time.
        // 黄体酮 (PROG) 放在肌注的最后 — 临床上肌注黄体酮用得少，主要靠直肠。
        case Route.injection:
            return [Ester.EB, Ester.EV, Ester.EU, Ester.EC, Ester.EN, Ester.PROG];
        case Route.oral:
            return [Ester.E2, Ester.EV, Ester.CPA, Ester.BICA];
        case Route.sublingual:
            return [Ester.EV, Ester.E2];
        // 直肠只支持黄体酮 — 这是它的「主流」给药方式（睡前栓剂）。
        case Route.rectal:
            return [Ester.PROG];
        default:
            return [Ester.E2];
    }
};

/**
 * 快速选剂量档位按键值 (route, ester) 索引 — 不同 (给药方式, 药物) 组合可以
 * 有完全不同的预设档位（黄体酮直肠 50/100/150/200、肌注 25/50/75 等）。
 *
 * 单位：药物本身的 mg（口服药片 mg/片、肌注 mg/支），不是 E2 当量。
 * 仅在「有档位的 route+药物」组合下显示档位按钮；其他组合走普通输入框。
 */
export const DOSE_QUICK_PRESETS: Partial<Record<`${Route}:${Ester}`, number[]>> = {
    // 舌下：E2 / EV 共用 1/2/3/4 mg
    [`${Route.sublingual}:${Ester.E2}`]: [1, 2, 3, 4],
    [`${Route.sublingual}:${Ester.EV}`]: [1, 2, 3, 4],
    // 口服：E2 / EV 共用 1/2/3/4 mg；CPA 6.25/12.5/25；BICA 20/25/50
    [`${Route.oral}:${Ester.E2}`]: [1, 2, 3, 4],
    [`${Route.oral}:${Ester.EV}`]: [1, 2, 3, 4],
    [`${Route.oral}:${Ester.CPA}`]: [6.25, 12.5, 25],
    [`${Route.oral}:${Ester.BICA}`]: [20, 25, 50],
    // 直肠：黄体酮典型档位（睡前栓剂）
    [`${Route.rectal}:${Ester.PROG}`]: [50, 100, 150, 200],
    // 肌注黄体酮：少见但仍支持
    [`${Route.injection}:${Ester.PROG}`]: [25, 50, 75],
};

/** True when `mg` matches one of the compound's quick-select presets. */
export const isPresetDose = (route: Route, ester: Ester, mg: number): boolean => {
    const presets = DOSE_QUICK_PRESETS[drugKeyOf(route, ester)];
    return !!presets && Number.isFinite(mg) && presets.some(p => Math.abs(p - mg) < 1e-6);
};

/** Whether the quick-dose panel applies to this route+compound combination. */
export const hasQuickDosePanel = (route: Route, ester: Ester): boolean =>
    !!DOSE_QUICK_PRESETS[drugKeyOf(route, ester)];

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

// --- Custom transdermal-gel products ----------------------------------------
//
// Preset gels live in `GEL_PRODUCTS` (code). User-created products are stored
// here and CLOUD-SYNCED via AppDataContext (SYNC_FIELDS 'gelProducts'), so a
// custom gel follows the user across devices. Validation reuses the single
// canonical `sanitizeGelProduct(s)` from pk.ts so every entry point agrees.
export const GEL_PRODUCTS_KEY = 'hrt-gel-products';

const asNum = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

/** Re-exported so callers (SettingsPage import) keep a single import surface. */
export { sanitizeGelProducts };

/** Read the user's custom gel products (validated). Presets are NOT included. */
export const readCustomGelProducts = (): GelProductSpec[] => {
    try {
        const saved = localStorage.getItem(GEL_PRODUCTS_KEY);
        if (!saved) return [];
        return sanitizeGelProducts(JSON.parse(saved));
    } catch {
        return [];
    }
};

/** Persist the custom gel products list (caller passes the full custom array). */
export const writeCustomGelProducts = (products: GelProductSpec[]) => {
    try {
        localStorage.setItem(GEL_PRODUCTS_KEY, JSON.stringify(sanitizeGelProducts(products)));
    } catch {
        /* ignore */
    }
};

/** Presets followed by the user's custom products, for the product selector. */
export const getAllGelProducts = (custom: GelProductSpec[] = readCustomGelProducts()): GelProductSpec[] =>
    [...GEL_PRODUCTS, ...custom];

/** Next free custom id (monotonic above any existing custom product). */
export const nextGelProductId = (custom: GelProductSpec[]): number =>
    custom.reduce((max, p) => Math.max(max, p.id), GEL_CUSTOM_ID_BASE - 1) + 1;

export interface LastGelPrefill {
    productId: number;
    gelSite: number;
    areaCM2: number;
    doseMG: number;
    washAfterH: number;
    coverage: number;   // coverage-template index; -1 if the record predates the feature
    coApplied: number;  // co-applied product index; 0 = none
}

/**
 * Pull the most recent gel administration out of the saved events so the form
 * can pre-fill the same product / site / area / wash. The numeric gel params are
 * read straight from the event's `extras` JSON, matching the per-event storage.
 */
export const readLastGelEvent = (events: DoseEvent[]): LastGelPrefill | null => {
    let latest: DoseEvent | null = null;
    for (const e of events) {
        if (e.route === Route.gel && (!latest || e.timeH > latest.timeH)) latest = e;
    }
    if (!latest) return null;
    const ex = latest.extras ?? {};
    return {
        productId: asNum(ex[ExtraKey.gelProductId], GEL_DEFAULT_PRODUCT_ID),
        gelSite: asNum(ex[ExtraKey.gelSite], 0),
        areaCM2: asNum(ex[ExtraKey.areaCM2], 0),
        doseMG: latest.doseMG,
        washAfterH: asNum(ex[ExtraKey.gelWashAfterH], 0),
        coverage: ex[ExtraKey.gelCoverage] != null ? asNum(ex[ExtraKey.gelCoverage], -1) : -1,
        coApplied: asNum(ex[ExtraKey.gelCoApplied], 0),
    };
};
