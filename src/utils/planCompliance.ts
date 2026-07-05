import { DoseEvent, Ester, Plan, Route } from '../../types';
import { DrugCategory, drugCategoryOf } from './planSchedule';
import { isPatchRemove } from './patch';

// ── Defaults ──────────────────────────────────────────────────────────────

/** Look-back window for compliance sampling, in days. Records older than this
 *  are ignored when computing the dominant (ester, route). */
export const COMPLIANCE_WINDOW_DAYS = 30;

/** Minimum number of recent records (per drug category) required before any
 *  result is surfaced. Smaller samples aren't statistically meaningful for
 *  detecting a "user's preferred way". */
export const COMPLIANCE_MIN_SAMPLES = 4;

/** Minimum fraction of records that must share one (ester, route) combination
 *  for it to qualify as "the user's preferred way". 0.75 = at least 3-of-4. */
export const COMPLIANCE_MATCH_RATIO = 0.75;

/** How many most-recent records to include in the report for UI detail panels. */
export const COMPLIANCE_DETAIL_SAMPLE_COUNT = 4;

// ── Route canonicalisation ───────────────────────────────────────────────

/**
 * Route alias used ONLY by the compliance check.
 *
 * `oral` and `sublingual` are treated as equivalent for plan-vs-history
 * comparison, because in practice a user designated "sublingual" might
 * occasionally swallow or vice versa, and a 4-record sample is too coarse
 * to meaningfully distinguish them. All other routes pass through unchanged.
 */
export function canonicalComplianceRoute(r: Route): Route {
    if (r === Route.sublingual) return Route.oral;
    return r;
}

// ── Report types ─────────────────────────────────────────────────────────

export interface ComplianceSample {
    /** Source DoseEvent.timeH. */
    timeH: number;
    ester: Ester;
    /** ORIGINAL (non-canonicalised) Route — the UI shows real labels here. */
    route: Route;
    /** Local-date key, YYYY-MM-DD, for human-readable copy in the banner. */
    dateKey: string;
    /** True iff this record matches the plan's (ester, canonical route). */
    matchesPlan: boolean;
}

export interface ComplianceMismatch {
    category: DrugCategory;
    plan: Plan;
    /** Canonical (ester, route) tuple extracted from the plan. */
    planSpec: { ester: Ester; route: Route };
    /** Dominant (ester, route) in recent history, or null when no single
     *  combination reaches `matchRatio`. `count` is the absolute number. */
    historyMain: { ester: Ester; route: Route; count: number } | null;
    sampleSize: number;
    /** Newest-first list of up to COMPLIANCE_DETAIL_SAMPLE_COUNT records. */
    samples: ComplianceSample[];
}

export interface PlanComplianceReport {
    /** Mismatches the UI should surface in a banner. */
    mismatches: ComplianceMismatch[];
    /** Match information, kept for debug / future telemetry. Not rendered by
     *  default — a matching plan has no news. */
    matches: ComplianceMismatch[];
}

export interface AnalyzeOpts {
    windowDays?: number;
    minSamples?: number;
    matchRatio?: number;
}

// ── Date helpers (local; consistent with DoseEvent.timeH / buildHeatmapRange) ──

function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Plan-vs-history compliance check.
 *
 * For each `DrugCategory` that has BOTH an enabled plan AND at least
 * `minSamples` recent records, decides whether the user's recent medication
 * habit matches the plan. Surfaces per-category mismatches the UI can render
 * as a top-of-page banner.
 *
 * Algorithm:
 *   1. Bucket events by `drugCategoryOf(ester)`, dropping patch-removes and
 *      records older than `todayMid - windowDays`.
 *   2. For each category, pick the latest-updated ENABLED plan (defensive
 *      against multi-plan sync-restore edge cases — AppDataContext's setter
 *      normally prevents ≥2 enabled plans of the same category).
 *   3. Tally (ester, canonicalRoute(route)) pairs. The dominant pair reaches
 *      `matchRatio` of total → qualifies as "the user's preferred way".
 *   4. Match = same (ester, canonical route) as plan; mismatch = either no
 *      dominant or dominant ≠ plan. Each sample is annotated individually
 *      for the banner's detail list.
 *
 * Cross-category: a category with no plan is skipped (no banner for a missing
 * plan); a category with a plan but not enough history is also skipped (don't
 * act on insufficient data).
 *
 * Pure function — no DOM, no React. Safe to call from anywhere in the tree.
 */
export function analyzePlanCompliance(
    events: DoseEvent[],
    plans: Plan[],
    today: Date,
    opts?: AnalyzeOpts,
): PlanComplianceReport {
    const windowDays = opts?.windowDays ?? COMPLIANCE_WINDOW_DAYS;
    const minSamples = opts?.minSamples ?? COMPLIANCE_MIN_SAMPLES;
    const matchRatio = opts?.matchRatio ?? COMPLIANCE_MATCH_RATIO;

    const todayMid = startOfLocalDay(today);
    const cutoffMs = todayMid.getTime() - windowDays * 86400000;

    // (1) Bucket events by category, filtered by window + patchRemove drop.
    const eventsByCategory = new Map<DrugCategory, DoseEvent[]>();
    for (const e of events) {
        if (isPatchRemove(e)) continue;
        if (e.timeH * 3600000 < cutoffMs) continue;
        const cat = drugCategoryOf(e.ester);
        const arr = eventsByCategory.get(cat);
        if (arr) arr.push(e);
        else eventsByCategory.set(cat, [e]);
    }

    // (2) Pick latest-updated enabled plan per category.
    const plansByCategory = new Map<DrugCategory, Plan>();
    for (const p of plans) {
        if (!p.enabled) continue;
        const cat = drugCategoryOf(p.ester);
        const existing = plansByCategory.get(cat);
        if (!existing || p.updatedAtH > existing.updatedAtH) {
            plansByCategory.set(cat, p);
        }
    }

    // (3 + 4) Decide match vs mismatch per category.
    const mismatches: ComplianceMismatch[] = [];
    const matches: ComplianceMismatch[] = [];
    const seen = new Set<DrugCategory>([
        ...eventsByCategory.keys(),
        ...plansByCategory.keys(),
    ]);

    for (const cat of seen) {
        const plan = plansByCategory.get(cat);
        if (!plan) continue;                                   // no plan → skip
        const eventsInCat = eventsByCategory.get(cat) ?? [];
        if (eventsInCat.length < minSamples) continue;         // insufficient history

        // Tally (ester, canonical route) pairs.
        const counts = new Map<string, { ester: Ester; route: Route; count: number }>();
        for (const e of eventsInCat) {
            const canon = canonicalComplianceRoute(e.route);
            const key = `${e.ester}|${canon}`;
            const cur = counts.get(key);
            if (cur) cur.count++;
            else counts.set(key, { ester: e.ester, route: canon, count: 1 });
        }
        const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
        const dominant = sorted[0] ?? null;
        const dominantRatio = dominant ? dominant.count / eventsInCat.length : 0;
        const dominantStrong = dominant !== null && dominantRatio >= matchRatio;

        const planCanRoute = canonicalComplianceRoute(plan.route);
        const planSpec = { ester: plan.ester, route: planCanRoute };

        const isMatch = dominantStrong
            && dominant!.ester === planSpec.ester
            && dominant!.route === planSpec.route;

        // Detail samples: newest first, capped at COMPLIANCE_DETAIL_SAMPLE_COUNT.
        const recent = eventsInCat
            .slice()
            .sort((a, b) => b.timeH - a.timeH)
            .slice(0, COMPLIANCE_DETAIL_SAMPLE_COUNT);
        const samples: ComplianceSample[] = recent.map((e) => ({
            timeH: e.timeH,
            ester: e.ester,
            route: e.route,
            dateKey: dateKey(new Date(e.timeH * 3600000)),
            matchesPlan: e.ester === planSpec.ester
                && canonicalComplianceRoute(e.route) === planSpec.route,
        }));

        const result: ComplianceMismatch = {
            category: cat,
            plan,
            planSpec,
            historyMain: dominantStrong
                ? { ester: dominant!.ester, route: dominant!.route, count: dominant!.count }
                : null,
            sampleSize: eventsInCat.length,
            samples,
        };
        if (isMatch) matches.push(result);
        else mismatches.push(result);
    }

    return { mismatches, matches };
}
