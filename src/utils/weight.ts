import type { DoseEvent } from '../../logic';

export const DEFAULT_WEIGHT_KG = 70;
const LEGACY_WEIGHT_STORAGE_KEY = 'hrt-weight';

/**
 * Return the weight of the most recent event that carries a positive numeric
 * weightKG, or null when no such event exists. Tolerates null/non-object
 * entries that may sneak in through corrupted localStorage / cloud snapshots.
 * Exported so callers (e.g. BasicInfoModal's read-only body-stats display) can
 * distinguish "no measurement" from "fallback to default".
 */
export function findLatestWeight(events: DoseEvent[]): number | null {
    if (!Array.isArray(events) || events.length === 0) return null;
    let latest: DoseEvent | null = null;
    for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const w = (ev as { weightKG?: unknown }).weightKG;
        if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue;
        if (!latest || ev.timeH > latest.timeH) latest = ev;
    }
    return latest ? latest.weightKG : null;
}

/**
 * Weight (kg) of the most recent dose event, used to compute a legacy-compat
 * top-level `weight` field for export. Falls back to DEFAULT_WEIGHT_KG when no
 * event has a positive numeric weight.
 */
export function latestEventWeight(events: DoseEvent[]): number {
    return findLatestWeight(events) ?? DEFAULT_WEIGHT_KG;
}

/**
 * Best prefill for a brand-new dose form. Prefers the most recent dose's
 * weight; if no event has a usable weight (empty array OR all events lack a
 * positive weight), falls back to the legacy `hrt-weight` localStorage value
 * so users who set a global weight before recording any doses don't see the
 * default jump back to 70.
 */
export function prefillWeightKG(events: DoseEvent[]): number {
    const fromEvents = findLatestWeight(events);
    if (fromEvents !== null) return fromEvents;
    try {
        const raw = localStorage.getItem(LEGACY_WEIGHT_STORAGE_KEY);
        if (raw !== null) {
            const parsed = parseFloat(raw);
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
    } catch { /* ignore (SSR / private mode) */ }
    return DEFAULT_WEIGHT_KG;
}

/**
 * Per-dose weight migration check: returns true if any event lacks a positive
 * numeric weightKG and therefore needs to be backfilled. Null / non-object
 * entries are also considered needing migration so the caller flags them for
 * sanitization.
 */
export function eventsNeedWeightMigration(events: unknown): boolean {
    if (!Array.isArray(events)) return false;
    return events.some((e) => {
        if (!e || typeof e !== 'object') return true;
        const w = (e as { weightKG?: unknown }).weightKG;
        return typeof w !== 'number' || !Number.isFinite(w) || w <= 0;
    });
}

/**
 * Apply the legacy single weight to every event that lacks a positive one.
 * Drops null / non-object entries instead of crashing on them — those can
 * appear in corrupted localStorage or stale cloud snapshots and have no
 * meaningful DoseEvent representation to preserve.
 */
export function backfillEventWeights(events: DoseEvent[], legacyWeight: number): DoseEvent[] {
    const w = (Number.isFinite(legacyWeight) && legacyWeight > 0) ? legacyWeight : DEFAULT_WEIGHT_KG;
    const result: DoseEvent[] = [];
    for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const ew = (ev as { weightKG?: unknown }).weightKG;
        const ok = typeof ew === 'number' && Number.isFinite(ew) && ew > 0;
        result.push(ok ? ev : { ...ev, weightKG: w });
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Height (cm) helpers — symmetric to weight above. Added 2026-07-21 when
// body-height input migrated from BasicInfoModal to DoseFormModal.
//
// File naming is historical (weight.ts existed long before height joined) —
// both body-stats are managed here. If we ever add a third metric (BF%, etc.)
// this should probably split into bodyStats.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Default height (cm) when nothing else is available. Matches the
 *  placeholder shown on DoseFormModal's empty height input. */
export const DEFAULT_HEIGHT_CM = 160;

function findLatestPositiveHeight(events: DoseEvent[]): number | null {
    if (!Array.isArray(events) || events.length === 0) return null;
    let latest: DoseEvent | null = null;
    for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const h = (ev as { heightCm?: unknown }).heightCm;
        if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) continue;
        if (!latest || ev.timeH > latest.timeH) latest = ev;
    }
    return latest ? latest.heightCm! : null;
}

/** Most recent positive height across all events, or null. Use this when
 *  you want a clean absence signal (vs latestEventHeight which substitutes a
 *  default). */
export function findLatestHeight(events: DoseEvent[]): number | null {
    return findLatestPositiveHeight(events);
}

/** Best prefill for a brand-new dose form. Prefers the most recent dose's
 *  height; falls back to DEFAULT_HEIGHT_CM (160) when no event carries one.
 *  No legacy localStorage fallback exists yet — height was never stored
 *  globally before per-event migration. */
export function prefillHeightCM(events: DoseEvent[]): number {
    return findLatestPositiveHeight(events) ?? DEFAULT_HEIGHT_CM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Height migration — the weight counterpart above existed since day one, but
// height had no equivalent. Events produced by the plan/reminder one-tap
// confirm paths (MainLayout ×3, BatchPlanConfirmModal ×1) simply omitted
// `heightCm`, so months of history ended up with a weight on every row and a
// height on only some of them. Backfill is deliberately conservative: it only
// fills events that have NO usable height, and takes the nearest earlier
// measurement (falling forward to the nearest later one for events that
// predate the user's first height entry). It never overwrites a real value.
// ─────────────────────────────────────────────────────────────────────────────

/** True when any event is missing a positive numeric heightCm. */
export function eventsNeedHeightMigration(events: unknown): boolean {
    if (!Array.isArray(events)) return false;
    return events.some((e) => {
        if (!e || typeof e !== 'object') return false; // weight migration drops those
        const h = (e as { heightCm?: unknown }).heightCm;
        return typeof h !== 'number' || !Number.isFinite(h) || h <= 0;
    });
}

/**
 * Fill in missing per-event heights using the nearest measured height in time.
 * Height barely changes over months, so nearest-neighbour is a better estimate
 * than a global constant — and unlike `backfillEventWeights` it must not write
 * DEFAULT_HEIGHT_CM into every gap, because that silently turns "never
 * recorded" into a fake 160 cm measurement.
 *
 * `fallbackHeight` (optional) is used only for events with no measured height
 * on either side — typically an entirely fresh log. Pass undefined to leave
 * those untouched so the UI can keep showing the honest "not recorded" state.
 */
export function backfillEventHeights(events: DoseEvent[], fallbackHeight?: number): DoseEvent[] {
    const clean = (events || []).filter((ev) => ev && typeof ev === 'object');
    const fb = (typeof fallbackHeight === 'number' && Number.isFinite(fallbackHeight) && fallbackHeight > 0)
        ? fallbackHeight
        : undefined;

    // Collect measured heights, sorted by time, for nearest-neighbour lookup.
    const measured = clean
        .map((ev, idx) => ({ idx, timeH: ev.timeH, h: (ev as { heightCm?: unknown }).heightCm }))
        .filter((x): x is { idx: number; timeH: number; h: number } =>
            typeof x.h === 'number' && Number.isFinite(x.h) && x.h > 0)
        .sort((a, b) => a.timeH - b.timeH);

    if (measured.length === 0) {
        return fb === undefined ? clean : clean.map(ev => ({ ...ev, heightCm: fb }));
    }

    const nearest = (timeH: number): number => {
        // Binary search for the first measurement at/after timeH.
        let lo = 0, hi = measured.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (measured[mid].timeH < timeH) lo = mid + 1; else hi = mid;
        }
        const after = measured[lo];
        const before = lo > 0 ? measured[lo - 1] : undefined;
        if (!before) return after.h;
        if (!after) return before.h;
        return (timeH - before.timeH) <= (after.timeH - timeH) ? before.h : after.h;
    };

    return clean.map((ev) => {
        const h = (ev as { heightCm?: unknown }).heightCm;
        const ok = typeof h === 'number' && Number.isFinite(h) && h > 0;
        if (ok) return ev;
        const estimate = measured.length > 0 ? nearest(ev.timeH) : fb;
        return estimate === undefined ? ev : { ...ev, heightCm: estimate };
    });
}

/**
 * Single source of truth for "what body stats should this record carry".
 * Every write path that creates a DoseEvent outside the full dose form (plan
 * one-tap confirm, batch plan confirm, patch remove) should use this instead
 * of hand-picking `prefillWeightKG` — that habit is exactly what dropped
 * heightCm from those paths in the first place.
 */
export function resolveBodyStats(events: DoseEvent[]): { weightKG: number; heightCm: number } {
    return { weightKG: prefillWeightKG(events), heightCm: prefillHeightCM(events) };
}
