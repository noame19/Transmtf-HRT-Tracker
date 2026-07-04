import { DoseEvent, Ester, Route } from '../../types';
import { drugCategoryOf, DrugCategory } from './planSchedule';
import { isPatchApply, isPatchRemove, findPatchRemoveForApply } from './patch';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the medication calendar heatmap. No DOM / no React.
// All times use the user's local Date (no timezone math) — consistent with the
// existing `parseLocalDate` / `toLocalDateStr` convention used elsewhere.
//
// The heatmap aggregates "what happened on each local-day" from a flat list of
// DoseEvents. Patches are special-cased: an apply+remove pair becomes a
// *continuous* segment of days, so a multi-day patch reads as one colour band
// instead of a single dot. Mid-wear days carry the apply event synthetically
// (via `events`) so callers can render them like any other day.
// ─────────────────────────────────────────────────────────────────────────────

export type { DrugCategory };

/** Per-day view model. */
export interface HeatmapDayCell {
    /** Local-midnight Date for this day. */
    date: Date;
    /** `YYYY-MM-DD` in the user's local timezone. */
    dateKey: string;
    /** All DoseEvents contributing to this day. For patch mid-wear days the
     *  apply event is included (synthetic) so the cell renders the same route
     *  icon + colour as the apply day itself, keeping the segment continuous. */
    events: DoseEvent[];
    /** Marks "this is today" so the view layer can outline the cell. */
    isToday: boolean;
    /** True when this day is strictly after today (within the future-pad window).
     *  Events in the future should not be rendered the same as past doses. */
    isFuture: boolean;
}

/** A column = one ISO week (Mon..Sun). */
export interface HeatmapWeekColumn {
    /** Monday at local midnight — the column's anchor date. */
    startDate: Date;
    /** Always length 7 (Mon..Sun). The last column in the range may have fewer
     *  than 7 cells if the range ends mid-week, but we always pad to 7. */
    days: HeatmapDayCell[];
    /** Optional month label, set on the column where the month first appears. */
    monthLabel?: string;
    /** Optional year label, set on the column where the year first appears. */
    yearLabel?: string;
}

/** The full heatmap layout for the current data window. */
export interface HeatmapRange {
    weeks: HeatmapWeekColumn[];
    /** First Monday (local midnight) of the rendered window. */
    startDate: Date;
    /** Last day rendered (local midnight). May not be a Sunday if the data
     *  fits exactly into a partial week — column padding handles that. */
    endDate: Date;
    /** Local-midnight of "today". */
    today: Date;
    todayKey: string;
    futurePadDays: number;
}

/** (ester → drug class → primary colour) — the on-screen palette. Tailwind
 *  picks high-saturation hues that survive both light/dark themes and are
 *  distinguishable for common colour-vision deficiencies. */
export const HEATMAP_COLOR_BY_CATEGORY: Record<DrugCategory, string> = {
    estrogen: '#EC4899',      // Tailwind pink-500 — estradiol family
    anti_androgen: '#A855F7', // Tailwind purple-500 — CPA / bica (was blue-500; purple reads as a distinct family from estrogen's pink)
    progestin: '#F59E0B',     // Tailwind amber-500 — progesterone / PRL
    other: '#64748B',         // Tailwind slate-500 — fallback
};

/** Pick the on-screen colour for any ester. */
export function heatmapColorForEster(ester: Ester): string {
    return HEATMAP_COLOR_BY_CATEGORY[drugCategoryOf(ester)];
}

// ── Date helpers ──────────────────────────────────────────────────────────

/** Strip time-of-day, leaving local-midnight Date (idempotent). */
function startOfLocalDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** `YYYY-MM-DD` in local time. */
function dateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday of the week containing `d` (JS getDay: 0=Sun..6=Sat). */
function startOfWeekMon(d: Date): Date {
    const day = d.getDay();
    const offsetToMon = day === 0 ? -6 : 1 - day;
    const ms = d.getTime() + offsetToMon * 86400000;
    return startOfLocalDay(new Date(ms));
}

/** Inclusive day count between two local-midnights (positive if b > a). */
function daysBetween(a: Date, b: Date): number {
    return Math.round((startOfLocalDay(b).getTime() - startOfLocalDay(a).getTime()) / 86400000);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Localised month abbreviation. Accepts a translation callback for i18n. */
export function monthLabelFor(start: Date, t?: (k: string) => string): string {
    if (t) {
        // The translations file already has overview.month_jan etc.; fall back
        // to the English short label if the translation is missing.
        const keys = [
            'overview.month_jan', 'overview.month_feb', 'overview.month_mar',
            'overview.month_apr', 'overview.month_may', 'overview.month_jun',
            'overview.month_jul', 'overview.month_aug', 'overview.month_sep',
            'overview.month_oct', 'overview.month_nov', 'overview.month_dec',
        ];
        const translated = t(keys[start.getMonth()]);
        if (translated && translated !== keys[start.getMonth()]) return translated;
    }
    return MONTH_LABELS[start.getMonth()];
}

// ── Patch pairing ─────────────────────────────────────────────────────────

interface PatchPair { apply: DoseEvent; remove: DoseEvent | null }

/** Build an O(N) index keyed by apply.id. Uses the existing findPatchRemoveForApply
 *  helper which handles both companionGroupId and time-axis fallback pairing. */
function indexPatchPairs(events: DoseEvent[]): Map<string, PatchPair> {
    const pairMap = new Map<string, PatchPair>();
    const seen = new Set<string>();
    for (const e of events) {
        if (!isPatchApply(e)) continue;
        if (seen.has(e.id)) continue;
        const remove = findPatchRemoveForApply(e, events);
        pairMap.set(e.id, { apply: e, remove });
        seen.add(e.id);
    }
    return pairMap;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build the heatmap layout from a flat list of DoseEvents.
 *
 * Range selection:
 *   - First day rendered: earliest event day, snapped back to the nearest
 *     Monday; if the user has no events at all, fall back to 60 days before
 *     today so the cell grid is never empty (otherwise an empty store would
 *     have no surface area for the "+新增" CTA to point at).
 *   - Last day rendered: max(today + futurePadDays, latestEventDay), snapped
 *     forward to the nearest Sunday.
 *
 * @param events        All known DoseEvents (mixed routes / esters).
 * @param today         "Now" reference; normalized to local midnight.
 * @param futurePadDays Blank days reserved after today (default 21 = ~3 weeks,
 *                      leaves room for upcoming planned doses once that lands).
 */
export function buildHeatmapRange(
    events: DoseEvent[],
    today: Date,
    futurePadDays: number = 21,
): HeatmapRange {
    const todayMid = startOfLocalDay(today);
    const todayKeyStr = dateKey(todayMid);

    // First / last event day.
    let firstEventDay: Date | null = null;
    let lastEventDay: Date | null = null;
    for (const e of events) {
        const d = startOfLocalDay(new Date(e.timeH * 3600000));
        if (!firstEventDay || d < firstEventDay) firstEventDay = d;
        if (!lastEventDay || d > lastEventDay) lastEventDay = d;
    }

    // Snap start back to Monday. If no events, use 60 days before today.
    const fallbackStart = new Date(todayMid.getTime() - 60 * 86400000);
    const startDate = startOfWeekMon(firstEventDay ?? fallbackStart);

    // Snap end forward to Sunday. The "pad" only matters when there's no recent
    // event — otherwise latestEventDay wins so an old history still renders.
    const padEnd = new Date(todayMid.getTime() + futurePadDays * 86400000);
    const endCandidate = (lastEventDay && lastEventDay > padEnd) ? lastEventDay : padEnd;
    const endDayOfWeek = endCandidate.getDay();
    const offsetToSun = endDayOfWeek === 0 ? 0 : 7 - endDayOfWeek;
    const endDate = startOfLocalDay(new Date(endCandidate.getTime() + offsetToSun * 86400000));

    const totalDays = daysBetween(startDate, endDate) + 1;
    if (totalDays <= 0) {
        return { weeks: [], startDate, endDate, today: todayMid, todayKey: todayKeyStr, futurePadDays };
    }

    // Bucket admin events by dateKey (skip patchRemove — bookkeeping only).
    const byDay = new Map<string, DoseEvent[]>();
    for (const e of events) {
        if (isPatchRemove(e)) continue;
        const d = startOfLocalDay(new Date(e.timeH * 3600000));
        const k = dateKey(d);
        const arr = byDay.get(k);
        if (arr) arr.push(e);
        else byDay.set(k, [e]);
    }

    // Patch pairs (apply → optional remove) for mid-wear propagation.
    const patchPairs = indexPatchPairs(events);

    // Day-by-day construction.
    const allDays: HeatmapDayCell[] = [];
    for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate.getTime() + i * 86400000);
        const k = dateKey(d);
        const cellEvents: DoseEvent[] = [];

        // Admin events landing on this day.
        const own = byDay.get(k);
        if (own) cellEvents.push(...own);

        // Patch wear propagation: each pair whose apply..remove span spans
        // today contributes the apply event. Mid-wear days thus reuse the
        // apply event's metadata (route=patchApply, doseMG, µg/d if any).
        for (const { apply, remove } of patchPairs.values()) {
            if (!remove) continue;  // apply-only: handled via own-day admin above
            const applyDay = startOfLocalDay(new Date(apply.timeH * 3600000));
            const removeDay = startOfLocalDay(new Date(remove.timeH * 3600000));
            // Inclusive both ends — apply day AND remove day are part of the
            // wear segment, matching the user's "整段连续" expectation.
            if (d >= applyDay && d <= removeDay) {
                cellEvents.push(apply);
            }
        }

        allDays.push({
            date: d,
            dateKey: k,
            events: cellEvents,
            isToday: k === todayKeyStr,
            isFuture: d > todayMid,
        });
    }

    // Group into 7-day columns and stamp month / year labels on the column
    // where each new month / year first appears.
    const weeks: HeatmapWeekColumn[] = [];
    for (let i = 0; i < allDays.length; i += 7) {
        const slice = allDays.slice(i, i + 7);
        while (slice.length < 7) {
            const last = slice[slice.length - 1];
            const next = new Date(last.date.getTime() + 86400000);
            slice.push({
                date: next,
                dateKey: dateKey(next),
                events: [],
                isToday: false,
                isFuture: true,
            });
        }
        const start = slice[0].date;
        const col: HeatmapWeekColumn = { startDate: start, days: slice };
        const prev = weeks[weeks.length - 1];
        if (!prev) {
            col.monthLabel = MONTH_LABELS[start.getMonth()];
            col.yearLabel = String(start.getFullYear());
        } else {
            if (start.getMonth() !== prev.startDate.getMonth()) {
                col.monthLabel = MONTH_LABELS[start.getMonth()];
                if (start.getFullYear() !== prev.startDate.getFullYear()) {
                    col.yearLabel = String(start.getFullYear());
                }
            }
        }
        weeks.push(col);
    }

    return { weeks, startDate, endDate, today: todayMid, todayKey: todayKeyStr, futurePadDays };
}

// ── Cell-content helpers (used by both the view layer and the tooltip) ────

/** Distinct admin routes present in a day (de-duplicated, original order). */
export function routesOfCell(cell: HeatmapDayCell): Route[] {
    const seen = new Set<Route>();
    const out: Route[] = [];
    for (const e of cell.events) {
        if (isPatchRemove(e)) continue;
        if (!seen.has(e.route)) { seen.add(e.route); out.push(e.route); }
    }
    return out;
}

/** Sorted-by-time list of (route, timeH, ester, doseMG) for tooltip rendering.
 *  Excludes bookkeeping (patchRemove) entries. */
export interface CellEventRow {
    timeH: number;
    route: Route;
    ester: Ester;
    doseMG: number;
    releaseRateUGPerDay?: number;
}

export function timeSortedCellRows(cell: HeatmapDayCell): CellEventRow[] {
    return cell.events
        .filter((e) => !isPatchRemove(e))
        .map((e) => ({
            timeH: e.timeH,
            route: e.route,
            ester: e.ester,
            doseMG: e.doseMG,
            releaseRateUGPerDay: e.extras?.[
                // Lazy import would create a circular dep — the ExtraKey key
                // is the small string 'release_rate_ug_per_day'. Keeping it
                // inline avoids pulling types into this pure module.
                'release_rate_ug_per_day' as any
            ] as number | undefined,
        }))
        .sort((a, b) => a.timeH - b.timeH);
}
