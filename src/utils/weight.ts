import type { DoseEvent } from '../../logic';

export const DEFAULT_WEIGHT_KG = 70;
const LEGACY_WEIGHT_STORAGE_KEY = 'hrt-weight';

/**
 * Internal: return the weight of the most recent event that carries a positive
 * numeric weightKG, or null when no such event exists. Tolerates null/non-object
 * entries that may sneak in through corrupted localStorage / cloud snapshots.
 */
function findLatestPositiveWeight(events: DoseEvent[]): number | null {
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
    return findLatestPositiveWeight(events) ?? DEFAULT_WEIGHT_KG;
}

/**
 * Best prefill for a brand-new dose form. Prefers the most recent dose's
 * weight; if no event has a usable weight (empty array OR all events lack a
 * positive weight), falls back to the legacy `hrt-weight` localStorage value
 * so users who set a global weight before recording any doses don't see the
 * default jump back to 70.
 */
export function prefillWeightKG(events: DoseEvent[]): number {
    const fromEvents = findLatestPositiveWeight(events);
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
