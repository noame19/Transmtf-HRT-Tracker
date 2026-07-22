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
        // 直肠 (rectal) — 黄体酮栓剂是当前唯一的临床主流给药方式。
        // 单选项会让 DoseFormModal 的 ester selector 走 length===1 分支
        // 渲染成只读徽标（见 getEsterSelectorRenderMode）。
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

// --- User-saved "dose entry templates" --------------------------------------
//
// 用户在 DoseFormModal 里手动"另存为模板"创建的快捷录入模板。
// 形状只暴露在 DoseFormModal 里；这里只做"原样读写 + 坏数据静默丢弃"。
// v4 备份用这套 read/write 函数读 / 还原，SettingsPage 和 DoseFormModal
// 共用同一份 localStorage 序列化逻辑，避免两份维护漂移。
const DOSE_TEMPLATES_KEY = 'hrt-dose-templates';

export const readDoseTemplates = <T = unknown>(): T[] => {
    try {
        const saved = localStorage.getItem(DOSE_TEMPLATES_KEY);
        if (!saved) return [];
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
};

export const writeDoseTemplates = <T = unknown>(templates: T[]) => {
    try {
        localStorage.setItem(DOSE_TEMPLATES_KEY, JSON.stringify(templates));
    } catch {
        /* quota / private mode — silently drop */
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

// ─────────────────────────────────────────────────────────────────────────────
// 剂量档位参考（dose guide）
//
// 原始定义在 DoseFormModal.tsx 顶部（line 58-78），2026-07-20 提取到此处让
// 「新建用药计划」弹窗也能消费同一份档位定义，从而两个表单在
// (给药方式, 药物) 下的视觉档位徽章 / 颜色 / 单位保持完全一致。
//
// 抗雄药物 (CPA / BICA) 不在这里写阈值——computeDoseGuide 里 `isAntiandrogen`
// 会先 return null。`mg_dose` 用于「不分昼夜、单次剂量」的黄体酮（直肠 / 肌注）。
// ─────────────────────────────────────────────────────────────────────────────

export type DoseLevelKey = 'low' | 'medium' | 'high' | 'very_high' | 'above';

export type DoseGuideConfig = {
    unitKey: 'mg_day' | 'ug_day' | 'mg_week' | 'mg_dose';
    thresholds: [number, number, number, number];
    /** 贴片专用：true 时 dose 模式下不计算 level，改成提示切到 release-rate 模式 */
    requiresRate?: boolean;
};

/** 按 (给药方式, 药物) 索引的剂量档位阈值 */
export const DOSE_GUIDE_CONFIG: Partial<Record<`${Route}:${Ester}`, DoseGuideConfig>> = {
    // 口服 E2/EV 共用 2/4/8/12 mg/天
    [`${Route.oral}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    [`${Route.oral}:${Ester.EV}`]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    // 舌下 E2/EV 共用 1/2/4/6 mg/天（舌下吸收快，参考剂量比口服低）
    [`${Route.sublingual}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    [`${Route.sublingual}:${Ester.EV}`]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    // 贴片：µg/天，需要先填释放速率
    [`${Route.patchApply}:${Ester.E2}`]: { unitKey: 'ug_day', thresholds: [100, 200, 400, 600], requiresRate: true },
    // 凝胶：mg/天
    [`${Route.gel}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [1.5, 3, 6, 9] },
    // 肌注：5 种 E2 酯共用 mg/周
    [`${Route.injection}:${Ester.EB}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EV}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EU}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EC}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EN}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    // 黄体酮：mg/次（不分昼夜，按单次剂量）
    [`${Route.rectal}:${Ester.PROG}`]: { unitKey: 'mg_dose', thresholds: [50, 100, 150, 200] },
    [`${Route.injection}:${Ester.PROG}`]: { unitKey: 'mg_dose', thresholds: [12.5, 25, 50, 75] },
};

/** 档位徽章（chip）颜色 token，与 index.html 的 --bg-bold-* / --text-bold-* 一致 */
export const LEVEL_BADGE_STYLES: Record<DoseLevelKey, string> = {
    low: 'bg-[var(--bg-bold-emerald)] text-[var(--text-bold-emerald)]',
    medium: 'bg-[var(--bg-bold-sky)] text-[var(--text-bold-sky)]',
    high: 'bg-[var(--bg-bold-amber)] text-[var(--text-bold-amber)]',
    very_high: 'bg-[var(--bg-bold-rose)] text-[var(--text-bold-rose)]',
    above: 'bg-[var(--bg-bold-red)] text-[var(--text-bold-red)]',
};

/** 档位卡片（容器）颜色 token */
export const LEVEL_CONTAINER_STYLES: Record<DoseLevelKey | 'neutral', string> = {
    low: 'bg-[var(--bg-soft-emerald)] border-[var(--border-soft-emerald)]',
    medium: 'bg-[var(--bg-soft-sky)] border-[var(--border-soft-sky)]',
    high: 'bg-[var(--bg-soft-amber)] border-[var(--border-soft-amber)]',
    very_high: 'bg-[var(--bg-soft-rose)] border-[var(--border-soft-rose)]',
    above: 'bg-[var(--bg-soft-red)] border-[var(--border-soft-red)]',
    neutral: 'bg-[var(--bg-soft-gray)] border-[var(--border-med-gray)]',
};

/** 数字格式化（剂量参考卡片用）：整数直显；小数去尾零 */
export const formatGuideNumber = (val: number): string => {
    if (Number.isInteger(val)) return val.toString();
    const rounded = val < 1 ? val.toFixed(2) : val.toFixed(1);
    return rounded.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

export type DoseGuideResult = {
    config: DoseGuideConfig;
    level: DoseLevelKey | null;
    value: number | null;
    /** 贴片 dose 模式下命中 cfg.requiresRate：提示切到 rate 模式 */
    showRateHint: boolean;
} | null;

/**
 * 计算当前 (route, ester, 输入剂量) 对应的剂量档位。
 *
 * - 抗雄 (CPA / BICA) → null（参考范围不同，不在本档位体系内）
 * - (route, ester) 没在 DOSE_GUIDE_CONFIG 里 → null
 * - 贴片 + dose 模式 + requiresRate → { level: null, value: null, showRateHint: true }
 * - 其它：value = 当前剂量（数字或 null），level 按 thresholds 落到 5 档
 */
export const computeDoseGuide = (
    route: Route,
    ester: Ester,
    isAntiandrogenEster: (e: Ester) => boolean,
    patchMode: 'dose' | 'rate',
    patchRate: string,
    e2Dose: string,
): DoseGuideResult => {
    if (isAntiandrogenEster(ester)) return null;

    const cfg = DOSE_GUIDE_CONFIG[drugKeyOf(route, ester)];
    if (!cfg) return null;

    if (route === Route.patchApply && patchMode === 'dose' && cfg.requiresRate) {
        return { config: cfg, level: null, value: null, showRateHint: true };
    }

    const rawVal = route === Route.patchApply ? parseFloat(patchRate) : parseFloat(e2Dose);
    const value = Number.isFinite(rawVal) && rawVal > 0 ? rawVal : null;

    let level: DoseLevelKey | null = null;
    if (value !== null) {
        const [low, medium, high, veryHigh] = cfg.thresholds;
        if (value <= low) level = 'low';
        else if (value <= medium) level = 'medium';
        else if (value <= high) level = 'high';
        else if (value <= veryHigh) level = 'very_high';
        else level = 'above';
    }

    return { config: cfg, level, value, showRateHint: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// (给药方式, 药物) 推荐默认剂量
//
// 2026-07-20 新增：让 PlanEditModal 在新计划首次进入某个 (route, ester) 组合
// 时落到的医学推荐默认（中等等级，参考 shizu cheatsheet）。优先级：
//   1) DoseFormModal 已写入的 per-drug memo（hrt-dose-by-drug）
//   2) DEFAULT_DOSE_MAP[drugKeyOf(route, ester)]
//   3) '' 空字符串（让用户手填）
//
// 单位与该 route 自身的单位约定一致（mg/天、mg/周、µg/天、mg/次）。
// ─────────────────────────────────────────────────────────────────────────────

/** 医学推荐默认剂量（中等档位）。patchApply 默认 µg/天（释放速率），其它 mg。 */
export const DEFAULT_DOSE_MAP: Partial<Record<`${Route}:${Ester}`, number>> = {
    // 舌下：1-4 mg，取中 = 2
    [`${Route.sublingual}:${Ester.E2}`]: 2,
    [`${Route.sublingual}:${Ester.EV}`]: 2,
    // 口服：E2/EV 4-8 mg 取 4；CPA 12.5；BICA 50
    [`${Route.oral}:${Ester.E2}`]: 4,
    [`${Route.oral}:${Ester.EV}`]: 4,
    [`${Route.oral}:${Ester.CPA}`]: 12.5,
    [`${Route.oral}:${Ester.BICA}`]: 50,
    // 肌注：5 种 E2 酯 5 mg（保留原 PlanEditModal 硬编码值）；PROG 25/50/75 取中 = 50
    [`${Route.injection}:${Ester.EB}`]: 5,
    [`${Route.injection}:${Ester.EV}`]: 5,
    [`${Route.injection}:${Ester.EU}`]: 5,
    [`${Route.injection}:${Ester.EC}`]: 5,
    [`${Route.injection}:${Ester.EN}`]: 5,
    [`${Route.injection}:${Ester.PROG}`]: 50,
    // 直肠：50/100/150/200 取中 = 100
    [`${Route.rectal}:${Ester.PROG}`]: 100,
    // 贴片：µg/天，100-200 取低 = 100
    [`${Route.patchApply}:${Ester.E2}`]: 100,
    // 凝胶：3-6 mg 取低 = 3
    [`${Route.gel}:${Ester.E2}`]: 3,
};

/**
 * 取 (route, ester) 的默认剂量。优先 per-drug memo，其次 DEFAULT_DOSE_MAP，再次空。
 * 调用者负责提供 memo（从 `readDoseByDrug()` 读出）；传 `undefined` 表示不查 memo。
 */
export const getDefaultDoseFor = (
    route: Route,
    ester: Ester,
    memo?: { rawDose: string },
): string => {
    const memoVal = memo?.rawDose?.trim();
    if (memoVal && Number.isFinite(parseFloat(memoVal))) return memoVal;
    const fallback = DEFAULT_DOSE_MAP[drugKeyOf(route, ester)];
    return fallback !== undefined ? String(fallback) : '';
};
