import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, RotateCcw } from 'lucide-react';
import { DoseEvent, Route, Ester, Plan } from '../../types';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { formatTime } from '../utils/helpers';
import { isPatchRemove } from '../utils/patch';
import { drugCategoryOf, dueMomentsInRange } from '../utils/planSchedule';
import { isE2Family } from '../../logic';
import type { PostponeLogEntry, DueLogEntry } from '../contexts/AppDataContext';
import {
    buildHeatmapRange,
    HEATMAP_COLOR_BY_CATEGORY,
    heatmapColorForEster,
    monthLabelFor,
    routesOfCell,
    timeSortedCellRows,
    upcomingPlanRowsForCell,
    type HeatmapDayCell,
    type HeatmapWeekColumn,
    type HeatmapRange,
    type DrugCategory,
} from '../utils/heatmapData';

// ─────────────────────────────────────────────────────────────────────────────
// Pure view layer for the medication calendar heatmap. Data model + range
// selection live in `heatmapData.ts`; this file is purely React + CSS.
//
// Layout (matches the reference heatmap):
//   • title row at top — plain text, no card chrome
//   • body = flex row:
//       left  (md:flex-[4]) — heatmap grid + bottom legend
//       right (md:flex-[1]) — 3 stacked KPI cards
//   • grid = 1 sticky weekday-label col + N week cols (fixed-pixel width, so
//     the whole grid overflows the card horizontally and the user can drag
//     the scrollbar to see older history — e.g. 2024 records alongside 2026)
//   • cells = aspect-square at the configured cell size (zoom = 8–32 px)
//   • month labels absolutely positioned above their first-appearance column
//
// Constraints (kept identical to v1):
//   • colour encodes drug category
//   • 1=mono, 2=diagonal, 3=L+M+R, 4=2×2 cross, 5+=cross + "+N" badge
//   • patches propagate apply→remove as one continuous band
//   • tooltip = day date + per-event rows (HH:MM, route icon, ester, dose)
//   • today is ALWAYS a fixed purple fill (#cb64ff) that overrides every
//     other rule — events, plan-fire, empty, dark/light. The day-of-month
//     number is always rendered (white on purple) so the user can read the
//     date at a glance. Past / future cells fade to whatever the data says.
//   • weekday labels are sticky-left so 一-日 stay visible while scrolling
// ─────────────────────────────────────────────────────────────────────────────

interface MedicationHeatmapProps {
    events: DoseEvent[];
    /** Active plans. When provided, each plan's `startDateH` is rendered as a
     *  light-yellow cell with the day-of-month number inside (so the user can
     *  spot plan-launch dates at a glance without leaving the heatmap). */
    plans?: Plan[];
    /** Per-postpone log entries. Used to compute "本月推迟数" KPI.
     *  Optional — when omitted, KPI shows "—". */
    postponeLog?: PostponeLogEntry[];
    /** Frozen per-due-day compliance record (口径 C source of truth for
     *  "计划达成率"). Optional — when omitted, KPI shows "—". */
    dueLog?: DueLogEntry[];
    /** Override "now" for tests / previews. */
    today?: Date;
    /** Future pad appended after today (default 21d). */
    futurePadDays?: number;
    /** Compact mode (used when the heatmap is rendered in a narrow column,
     *  e.g. side-by-side with the blood-concentration chart on desktop).
     *  Stacks the KPI sidebar BELOW the grid instead of on the right, and
     *  uses a smaller default cell-size so 6M fits without horizontal scroll. */
    compact?: boolean;
}

/** Gap between grid cells. The grid renders ALL weeks in the data range
 *  and uses a fixed pixel column width (driven by the chosen ZOOM_LEVELS
 *  entry), so the user can drag horizontally to see older history — e.g.
 *  2024 entries alongside 2026 ones. */
const DEFAULT_GAP_PX = 5;
/** Width of the sticky weekday-label column on the left. Must match the
 *  `gridTemplateColumns` first track + the sticky weekday labels. */
const WEEKDAY_COL_PX = 36;

/** Three discrete zoom levels, modelled on ResultChart's 2M / 3M / 6M /
 *  reset pattern. Each level maps to BOTH a per-cell pixel size (used in
 *  the column width) AND a "weeks visible" count (used to crop the data
 *  range so 6M literally means "last 6 months", not "6 months worth of
 *  cells squeezed into the screen").
 *  The default is picked per-device (mobile = 2M, iPad = 3M, desktop = 6M)
 *  via `defaultZoomForWidth` below. */
const ZOOM_LEVELS = {
    '2M': { cellSize: 18, weeks: 9 },   // ~9 weeks  ≈ 2 months
    '3M': { cellSize: 14, weeks: 13 },  // ~13 weeks ≈ 3 months
    '6M': { cellSize: 10, weeks: 26 },  // ~26 weeks ≈ 6 months
} as const;
type ZoomLevel = keyof typeof ZOOM_LEVELS;

/** Pick the default zoom level for the current viewport width. Mobile (sm,
 *  Tailwind <768px) → 2M, iPad (md <1024px) → 3M, desktop (≥1024px) → 6M. */
function defaultZoomForWidth(width: number): ZoomLevel {
    if (width < 768) return '2M';
    if (width < 1024) return '3M';
    return '6M';
}

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Distinct drug categories present in a day's events (de-duped, original
 *  order). Patch mid-wear synthetic events reuse their apply event's category,
 *  so a multi-day patch shows as a single-colour band by construction. */
function categoriesOfCell(cell: HeatmapDayCell): DrugCategory[] {
    const seen = new Set<DrugCategory>();
    const out: DrugCategory[] = [];
    for (const e of cell.events) {
        if (isPatchRemove(e)) continue;
        const cat = drugCategoryOf(e.ester);
        if (!seen.has(cat)) {
            seen.add(cat);
            out.push(cat);
        }
    }
    return out;
}

const MedicationHeatmap: React.FC<MedicationHeatmapProps> = ({
    events,
    plans,
    postponeLog,
    dueLog,
    today,
    futurePadDays = 21,
    compact = false,
}) => {
    const { t, lang } = useTranslation();
    const { isDark } = useTheme();
    const containerRef = useRef<HTMLDivElement | null>(null);

    // ── Range + zoom state ────────────────────────────────────────────────
    const todayRef = today ?? new Date();
    const range: HeatmapRange = useMemo(
        () => buildHeatmapRange(events, todayRef, futurePadDays),
        [events, todayRef, futurePadDays],
    );

    // Plan-fire lookup: collect every local-day ≥ today on which at least one
    // enabled plan will fire medication, between today and the visible horizon
    // (so we never waste cycles computing fires the user can't see). The map
    // value is the LIST of distinct drug categories firing that day (deduped
    // by category — two E2 plans on the same day still count as one entry).
    // Used to paint the CATEGORY-AWARE highlight + white day number on plan
    // -fire cells: estradiol → magenta, anti-androgen → light blue, both on
    // the same day → wavy-split (same shape as the historical 2-category
    // cells).
    const planFireCategoriesByDate: Map<string, DrugCategory[]> = useMemo(() => {
        const out = new Map<string, DrugCategory[]>();
        if (!plans || plans.length === 0) return out;
        const todayMid = new Date(
            todayRef.getFullYear(),
            todayRef.getMonth(),
            todayRef.getDate(),
        );
        const horizon = new Date(range.endDate);
        horizon.setDate(horizon.getDate() + 7); // small safety margin past the rendered end
        for (const p of plans) {
            // Defensive belt-and-suspenders: dueMomentsInRange already returns
            // [] for disabled plans (`if (!plan.enabled) return []` is its very
            // first line), but a future refactor of that helper must NEVER
            // silently re-introduce disabled plans into the heatmap. Failing
            // closed at the call site keeps this invariant local to the view.
            if (!p.enabled) continue;
            try {
                const moments = dueMomentsInRange(p, todayMid, horizon);
                if (moments.length === 0) continue;
                const cat = drugCategoryOf(p.ester);
                for (const m of moments) {
                    // dueMomentsInRange is already filtered to ≥ from (= todayMid),
                    // so every emitted Date is today or future.
                    const k = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
                    const existing = out.get(k);
                    if (existing) {
                        if (!existing.includes(cat)) existing.push(cat);
                    } else {
                        out.set(k, [cat]);
                    }
                }
            } catch {
                // Defensive: bad plan data must never crash the heatmap.
            }
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plans, todayRef, range.endDate]);

    // Zoom = one of three discrete levels (2M / 3M / 6M). Each level maps to a
    // per-cell pixel size via ZOOM_LEVELS; bigger cells = fewer weeks visible
    // at once. The full range is still rendered so the user can drag back to
    // see older history after picking a tighter zoom.
    const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(() => {
        if (typeof window === 'undefined') return '6M';
        return defaultZoomForWidth(window.innerWidth);
    });
    const cellSize = compact
        // Compact (e.g. 1/3 width under xl breakpoint) bumps the cell size
        // up so the grid actually overflows the constrained column and the
        // drag-to-pan handler has somewhere to go. Without this, 6M (10px ×
        // 26 weeks ≈ 426px) lands just inside the ~429px column — no overflow
        // triggers, the hidden scrollbar never appears, and click-drag pan
        // is effectively dead. 14px is the size of the 3M tier and the
        // maximum across all current 2M / 3M tiers, so only 6M is affected.
        ? Math.max(ZOOM_LEVELS[zoomLevel].cellSize, 14)
        : ZOOM_LEVELS[zoomLevel].cellSize;
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Render ALL weeks from the data range (not just the last N weeks) so the
    // user can drag back to view history that's older than the 2M / 3M / 6M
    // zoom labels. Cropping to a slice here would make the older history
    // completely invisible — the grid only renders what we hand it, so any
    // weeks outside the slice can't be reached by scrolling. KPI stats are
    // computed from the full `events` list (see `computeStats` below) so the
    // "累计用药 / 活跃天数" counts don't jump when the zoom level changes.
    //
    // The 2M / 3M / 6M labels now describe the *cell density* (cells per
    // week's screen area) rather than a hard render cap, which mirrors the
    // user expectation of "zoom button = bigger / smaller cells".
    const totalWeeks = range.weeks.length;

    /** Snap the scroll container all the way to the right so "today" and the
     *  future plan-fire days sit at the right edge of the viewport. Used by
     *  the 2M/3M/6M buttons and the reset button (which restores the device
     *  default then re-snaps to the right end). */
    const scrollToRightEnd = () => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    };

    // Track the current device-default zoom so the reset button can restore
    // it (and re-apply it on window resize, in case the user rotates their
    // tablet or drags the window between desktop / mobile widths).
    const defaultZoomRef = useRef<ZoomLevel>(zoomLevel);
    useEffect(() => {
        const update = () => {
            defaultZoomRef.current = defaultZoomForWidth(window.innerWidth);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    // Auto-scroll to the right end on first mount + after every zoom / data
    // change. The right end of the heatmap is "today + 21-day future pad",
    // which is the most relevant view (shows today AND upcoming plan-fires
    // without requiring the user to drag). The user can still drag back to
    // see older history after the snap.
    useEffect(() => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }, [range.weeks, cellSize]);

    // Drag-to-pan: the scrollbar is hidden (`.scrollbar-hide` className) so the
    // user has no native handle to grab. This listener lets them click + drag
    // anywhere on the heatmap to pan horizontally. We don't pan on every move
    // — only after the cursor has moved > 4px from the mousedown point, so a
    // quick click on a cell still fires its onClick / tooltip.
    const panRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const p = panRef.current;
            if (!p.active || !scrollRef.current) {
                // Not in a pan — but the first idle mousemove after a pan
                // ends is also where we clear the `moved` flag, so the next
                // cell hover can show the tooltip again. (We can't reset on
                // mouseup alone, because the cursor is still over whatever
                // cell the pan ended on and its onMouseEnter won't re-fire.)
                if (p.moved) p.moved = false;
                return;
            }
            const dx = e.clientX - p.startX;
            if (!p.moved && Math.abs(dx) < 4) return;
            p.moved = true;
            scrollRef.current.scrollLeft = p.startScroll - dx;
        };
        const onUp = () => {
            panRef.current.active = false;
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, []);

    // ── KPI stats (right side card stack) ─────────────────────────────────
    const stats = useMemo(
        () => computeStats(events, todayRef, plans, postponeLog, dueLog),
        [events, todayRef, plans, postponeLog, dueLog]
    );

    // ── Tooltip state ─────────────────────────────────────────────────────
    const [tooltip, setTooltip] = useState<{
        cell: HeatmapDayCell;
        x: number;
        y: number;
    } | null>(null);

    if (totalWeeks === 0) return null;

    return (
        <div className="glass-card rounded-2xl relative overflow-hidden md:flex md:flex-col md:h-80 xl:h-[340px] xl:overflow-hidden" ref={containerRef}>
            {/* Title row — icon + title on left, zoom buttons on the right.
             *  Visually mirrors ResultChart's chart card header so the two
             *  sections read as a matched pair. */}
            <div className="flex justify-between items-center px-3 md:px-4 py-2.5 md:py-3 border-b border-[var(--border-secondary)]">
                <h4
                    className="text-sm md:text-base font-semibold tracking-tight m-0 flex items-center gap-2"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <span className="inline-flex items-center justify-center w-8 h-8 md:w-10 md:h-10 rounded-xl border border-[var(--border-icon-pink)]">
                        <CalendarDays size={16} className="text-[#f6c4d7] md:w-5 md:h-5" />
                    </span>
                    {t('heatmap.title') || '用药日历'}
                </h4>
                <div className="ml-auto flex bg-[var(--bg-secondary)] rounded-xl p-1 gap-1 border border-[var(--border-primary)]">
                    {(['2M', '3M', '6M'] as const).map((level) => {
                        const isActive = zoomLevel === level;
                        return (
                            <button
                                key={level}
                                type="button"
                                onClick={() => {
                                    setZoomLevel(level);
                                    // Defer the scroll so the new cellSize is
                                    // applied to the layout first; otherwise
                                    // scrollWidth still reflects the old size
                                    // and we land on the wrong column.
                                    requestAnimationFrame(scrollToRightEnd);
                                }}
                                className="px-3 py-1.5 text-xs md:text-sm font-bold rounded-lg transition-all"
                                style={{
                                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                                    background: isActive ? 'var(--bg-card)' : 'transparent',
                                }}
                            >
                                {level}
                            </button>
                        );
                    })}
                    <div
                        className="w-px h-4 self-center mx-1"
                        style={{ background: 'var(--border-primary)' }}
                    />
                    <button
                        type="button"
                        onClick={() => {
                            setZoomLevel(defaultZoomRef.current);
                            requestAnimationFrame(scrollToRightEnd);
                        }}
                        title="重置缩放"
                        aria-label="重置缩放"
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-card)] transition-all"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <RotateCcw size={14} className="md:w-4 md:h-4" />
                    </button>
                </div>
            </div>

            {/* Body row: heatmap (left/top) + KPI stack (right/bottom).
             *  In compact mode (e.g. side-by-side with ResultChart on desktop)
             *  the KPI stack lives BELOW the grid because there's no horizontal
             *  room for both. */}
            <div className="px-3 md:px-4 pt-3 md:pt-4 pb-2 md:pb-3 md:flex-1 md:min-h-0 md:flex md:flex-col">
                <div className={compact
                    ? 'flex-1 min-h-0 flex flex-col gap-3'
                    : 'flex-1 min-h-0 flex flex-col md:flex-row md:items-stretch gap-3'
                }>
                <div className="w-full md:flex-[4] xl:flex-none min-w-0">
                    <div className="h-full flex flex-col justify-between">
                        {/* Heatmap area — scrollbar hidden; user pans by
                         *  click-drag (handled by panRef in the useEffect above). */}
                        <div
                            ref={scrollRef}
                            onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                panRef.current = {
                                    active: true,
                                    startX: e.clientX,
                                    startScroll: scrollRef.current?.scrollLeft ?? 0,
                                    moved: false,
                                };
                            }}
                            className="scrollbar-hide w-full min-w-0 overflow-x-auto overflow-y-hidden select-none"
                            style={{ cursor: panRef.current.moved ? 'grabbing' : 'grab' }}
                        >
                            <div
                                className="grid"
                                style={{
                                    gridTemplateColumns: `${WEEKDAY_COL_PX}px repeat(${totalWeeks}, ${cellSize}px)`,
                                    gap: `${DEFAULT_GAP_PX}px`,
                                    width: 'max-content',
                                }}
                            >
                                {/* Top-left empty cell — sticky so the month row's
                                 *  left edge stays anchored to the weekday column
                                 *  while the user scrolls. */}
                                <div
                                    className="sticky left-0 z-10"
                                    style={{
                                        width: `${WEEKDAY_COL_PX}px`,
                                        minWidth: `${WEEKDAY_COL_PX}px`,
                                        background: 'var(--bg-card)',
                                    }}
                                />
                                {/* Month / year header row — absolute-positioned
                                 *  labels above their first-appearance column */}
                                <div
                                    className="relative h-4"
                                    style={{ gridColumn: `2 / span ${totalWeeks}` }}
                                >
                                    {range.weeks.map((w, idx) =>
                                        w.monthLabel ? (
                                            <span
                                                key={`mh-${idx}`}
                                                className="absolute top-0 text-[11px] whitespace-nowrap pointer-events-none"
                                                style={{
                                                    left: `${(idx / totalWeeks) * 100}%`,
                                                    color: 'var(--text-tertiary)',
                                                }}
                                            >
                                                {monthLabelFor(w.startDate, undefined, lang)}
                                                {w.yearLabel ? (
                                                    <span className="opacity-70 ml-0.5">{w.yearLabel}</span>
                                                ) : null}
                                            </span>
                                        ) : null,
                                    )}
                                </div>

                                {/* 7 weekday rows × N columns */}
                                {WEEKDAY_KEYS.map((dayKey, dayIdx) => (
                                    <React.Fragment key={`row-${dayIdx}`}>
                                        <div
                                            className="text-[11px] text-right pr-2 flex items-center justify-end leading-none whitespace-nowrap sticky left-0 z-10"
                                            style={{
                                                width: `${WEEKDAY_COL_PX}px`,
                                                minWidth: `${WEEKDAY_COL_PX}px`,
                                                color: 'var(--text-tertiary)',
                                                background: 'var(--bg-card)',
                                            }}
                                        >
                                            {t(`heatmap.weekday_${dayKey}`) || ''}
                                        </div>
                                        {range.weeks.map((w, wIdx) => {
                                            const d = w.days[dayIdx];
                                            if (!d) return <div key={`${wIdx}-${dayIdx}`} />;
                                                const cats = categoriesOfCell(d);
                                                const routes = routesOfCell(d);
                                                const isPatchOnly =
                                                    routes.length > 0 && routes.every((r) => r === Route.patchApply);
                                                // Plan-fire state per day. Today ALWAYS wins —
                                                // it forces the fixed purple background and day
                                                // number regardless of plan-fire / events / empty.
                                                // Past / future cells follow the normal rules.
                                                const planFireCats = planFireCategoriesByDate.get(d.dateKey) ?? null;
                                                const isPlanFireFuture = planFireCats !== null;
                                                // Day-number always renders on today (fixed purple
                                                // fill needs a label so the date is readable at a
                                                // glance); on past / future cells it renders only
                                                // on signal days (events or plan-fire).
                                                const hasEvents = d.events.some((e) => !isPatchRemove(e));
                                                const showDayNum = d.isToday || hasEvents || isPlanFireFuture;
                                                return (
                                                    <button
                                                        key={`${wIdx}-${dayIdx}`}
                                                        type="button"
                                                        aria-label={d.dateKey}
                                                        className="relative rounded-[2px] aspect-square w-full cursor-pointer transition-opacity hover:opacity-80 btn-press-glass"
                                                        style={{
                                                            background: cellBackground(cats, d, isDark, planFireCats),
                                                            opacity: 1,
                                                            // Today gets a fixed purple fill that
                                                            // overrides every other colour rule —
                                                            // events, plan-fire, empty, light/dark all
                                                            // yield the same purple cell so the user
                                                            // can always spot today at a glance.
                                                            outline: 'none',
                                                            outlineOffset: 0,
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            // Skip tooltip while the user is panning — the
                                                            // mouseenter fires as the cursor sweeps across cells.
                                                            if (panRef.current.moved) return;
                                                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                            setTooltip({
                                                                cell: d,
                                                                x: rect.left + rect.width / 2,
                                                                y: rect.top,
                                                            });
                                                        }}
                                                        onMouseLeave={() => setTooltip(null)}
                                                    >
                                                        {showDayNum && (
                                                            <span
                                                                className="absolute inset-0 flex items-center justify-center text-[8px] font-bold leading-none pointer-events-none tabular-nums"
                                                                style={{ color: '#fff' }}
                                                            >
                                                                {d.date.getDate()}
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </React.Fragment>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                {/* Right-side KPI card stack — stacked vertically on the right
                 *  in normal mode (≥md), or a 3-column row below the grid in
                 *  compact mode (heatmap rendered in a narrow column). */}
                <div className={compact
                    ? 'grid grid-cols-2 gap-2 w-full md:mt-auto md:flex-none'
                    : 'grid grid-cols-2 md:flex md:flex-col gap-2 w-full md:flex-[1] md:min-w-[144px] md:self-stretch'
                }>
                    <KpiCard
                        value={stats.hrtStartLabel || '—'}
                        label={t('heatmap.kpi.hrt_start') || '开始HRT'}
                    />
                    <KpiCard
                        value={String(stats.e2DoseCount)}
                        label={t('heatmap.kpi.e2_count') || 'E2用药次数'}
                    />
                    <KpiCard
                        value={stats.achievementRate > 0 ? `${Math.round(stats.achievementRate * 100)}%` : '—'}
                        label={t('heatmap.kpi.achievement') || '计划达成率'}
                    />
                    <KpiCard
                        value={String(stats.monthPostponeCount)}
                        label={t('heatmap.kpi.month_postpone') || '本月推迟数'}
                    />
                </div>
                </div>
            </div>

            {/* Tooltip — fixed-positioned using the cell's bounding box.
             *  Rendered OUTSIDE the .glass-card so its `overflow-hidden`
             *  doesn't clip the popover when a cell is near the top edge. */}
            {tooltip && (
                <HeatmapTooltip
                    cell={tooltip.cell}
                    x={tooltip.x}
                    y={tooltip.y}
                    lang={lang}
                    t={t}
                    plans={plans ?? []}
                />
            )}
        </div>
    );
};

// ── Cell background helpers ───────────────────────────────────────────────

// Future plan-fire days render with CATEGORY-AWARE colours instead of one
// catch-all magenta. The conflict rule (planSchedule.findConflicts +
// sanitizePlansForConflict) guarantees at most one enabled plan per drug
// category, so the three cases below cover every realistic state:
//   - estradiol / E2 family              → magenta  (same hue the historical
//                                          estrogen band already uses, so the
//                                          schedule reads as a visual
//                                          continuation of the user's history)
//   - anti-androgen (CPA / BICA)         → light blue (user-requested hue;
//                                          visually distinct from the
//                                          historical anti-androgen purple
//                                          so a future dose doesn't get
//                                          mistaken for a past dose)
//   - E2 + anti-androgen firing same day → the SAME wavy-split shape used
//                                          by the historical 2-category
//                                          cells, just with the two future
//                                          colours above instead of the
//                                          historical pink + purple
const PLAN_FIRE_ESTRADIOL    = 'rgb(245, 164, 255)';
const PLAN_FIRE_ANTIANDROGEN = 'rgb(149, 208, 246)';

/** Resolve the on-screen colour for a single plan-fire category. Today (and
 *  anything past / not-a-plan-fire-day) should fall through to the historical
 *  branches below — callers must not pass invalid categories here. */
function planFireColor(cat: DrugCategory): string {
    return cat === 'estrogen'      ? PLAN_FIRE_ESTRADIOL
         : cat === 'anti_androgen' ? PLAN_FIRE_ANTIANDROGEN
         // The conflict rule keeps this branch unreachable in practice
         // (one enabled plan per category), but keeping fall-through colours
         // here means a future schema migration to multi-category plans
         // won't render blank cells.
         : HEATMAP_COLOR_BY_CATEGORY[cat];
}

/** Build an SVG data-URI for a 2-category wavy split. The wave runs horizontally
 *  across the cell so the two colours are separated by a sinusoidal boundary
 *  (instead of a hard diagonal). `preserveAspectRatio='none'` lets the SVG
 *  stretch to whatever the cell's pixel size ends up being. */
function wavySplitSvg(colorA: string, colorB: string): string {
    // Two sine-wave segments produce a smoother wave than one — the boundary
    // crosses the vertical centre twice (top-mid + bottom-mid), which reads
    // as a clean "~" at small cell sizes (~14px) without aliasing artefacts.
    const wave = 'M0,50 C16.67,25 33.33,75 50,50 C66.67,25 83.33,75 100,50';
    const top = `${wave} L100,0 L0,0 Z`;
    const bottom = `${wave} L100,100 L0,100 Z`;
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>` +
        `<path d='${top}' fill='${colorA}'/>` +
        `<path d='${bottom}' fill='${colorB}'/>` +
        `</svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

/** Map the distinct categories in a day to a CSS background. Layout strategy:
 *  - Plan-fire day with 1 plan firing → category-aware solid colour
 *    (estradiol = magenta, anti-androgen = light blue)
 *  - Plan-fire day with 2 plans firing → wavy split of the two future hues
 *  - 0 (non-plan-fire) → empty (theme-aware grey)
 *  - 1 → solid category colour
 *  - 2 → wavy split
 *  - 3 → 3 vertical stripes
 *  - 4+ → transparent (rare; the per-event detail is in the tooltip). */
function cellBackground(
    cats: DrugCategory[],
    cell: HeatmapDayCell,
    isDark: boolean,
    planFireCats: DrugCategory[] | null,
): string {
    // Today ALWAYS wins — solid purple fill that overrides plan-fire,
    // events, empty, dark/light. The user wants today to be visually
    // unmistakable regardless of what data is on it.
    if (cell.isToday) return '#cb64ff';
    // Plan-fire day: render by enabled-plan category, not by recorded events.
    // (Today is short-circuited above so this branch never fires for today.)
    if (planFireCats && planFireCats.length > 0) {
        if (planFireCats.length === 1) {
            // Single plan firing that day → solid colour matching its category.
            return planFireColor(planFireCats[0]);
        }
        // 2+ categories firing the same day. In practice this caps at
        // "estradiol + anti-androgen" (the conflict rule keeps enabled plans
        // to one per category). Render with the SAME wavy-split shape the
        // historical 2-category cells use so the visual language stays
        // consistent across past and future doses.
        return `${wavySplitSvg(PLAN_FIRE_ESTRADIOL, PLAN_FIRE_ANTIANDROGEN)} 0 0 / 100% 100% no-repeat`;
    }
    if (cats.length === 0) {
        // Dark theme: subtle white tint (preserves the original low-contrast
        // look on near-black backgrounds). Light theme: a very pale grey so
        // empty cells stay visible against the white card background without
        // distracting from the coloured days.
        if (isDark) return cell.isFuture ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.10)';
        return cell.isFuture ? 'rgb(248, 248, 248)' : 'rgb(244, 244, 244)';
    }
    if (cats.length === 1) {
        return HEATMAP_COLOR_BY_CATEGORY[cats[0]];
    }
    if (cats.length === 2) {
        const [a, b] = cats;
        return `${wavySplitSvg(HEATMAP_COLOR_BY_CATEGORY[a], HEATMAP_COLOR_BY_CATEGORY[b])} 0 0 / 100% 100% no-repeat`;
    }
    if (cats.length === 3) {
        const [a, b, c] = cats;
        return `linear-gradient(90deg, ${HEATMAP_COLOR_BY_CATEGORY[a]} 0 33.33%, ${HEATMAP_COLOR_BY_CATEGORY[b]} 33.33% 66.66%, ${HEATMAP_COLOR_BY_CATEGORY[c]} 66.66% 100%)`;
    }
    // 4+ categories: collapsed (background-only cell, the per-event detail is
    // already in the tooltip).
    return 'transparent';
}

/** Date format for the heatmap tooltip header.
 *  zh:  "26年6月2日周二"  (2-digit year, no leading zeros, 周 + weekday digit)
 *  ja:  "2026年6月2日(火)" (locale native)
 *  en:  "Tue, Jun 2, 2026"
 *  No external locale lookup — we hard-format zh to keep the year-2-digit
 *  style the user asked for. */
function formatHeatmapTooltipDate(date: Date, lang: string): string {
    if (lang === 'zh' || lang === 'zh-TW') {
        const yy = String(date.getFullYear()).slice(-2);
        const m = date.getMonth() + 1;
        const d = date.getDate();
        const wd = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
        return `${yy}年${m}月${d}日周${wd}`;
    }
    const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}

/** Short route labels for tooltip rows. Compact Chinese / English / Japanese
 *  single-word forms — distinct from `route.injection` (which includes the
 *  parenthetical English). e.g. zh "肌肉注射", en "Injection", ja "注射". */
const ROUTE_SHORT: Record<Route, { zh: string; en: string; ja: string }> = {
    [Route.injection]: { zh: '肌肉注射', en: 'Injection', ja: '注射' },
    [Route.oral]: { zh: '口服', en: 'Oral', ja: '経口' },
    [Route.sublingual]: { zh: '舌下', en: 'Sublingual', ja: '舌下' },
    [Route.gel]: { zh: '凝胶', en: 'Gel', ja: 'ジェル' },
    [Route.patchApply]: { zh: '贴片', en: 'Patch', ja: 'パッチ' },
    [Route.patchRemove]: { zh: '摘下贴片', en: 'Patch off', ja: 'パッチ除去' },
};

function routeShortLabel(route: Route, lang: string): string {
    const k = lang === 'ja' ? 'ja' : (lang === 'zh' || lang === 'zh-TW' ? 'zh' : 'en');
    return ROUTE_SHORT[route]?.[k] ?? String(route);
}


// ── KPI card (right-side stack) ──────────────────────────────────────────

const KpiCard: React.FC<{ value: string; label: string }> = ({ value, label }) => (
    <div
        className="min-w-0 flex flex-col justify-center rounded-lg px-3 py-2 md:flex-1 md:min-h-0"
        style={{ background: 'var(--bg-card-hover)' }}
    >
        <div className="flex items-center justify-center gap-1.5 min-w-0">
            <span
                className="text-base font-semibold tabular-nums tracking-tight leading-tight truncate text-center"
                style={{ color: 'var(--text-primary)' }}
            >
                {value}
            </span>
        </div>
        <div
            className="text-[12px] mt-0.5 truncate w-full text-center"
            style={{ color: 'var(--text-tertiary)' }}
        >
            {label}
        </div>
    </div>
);

// ── KPI computation ──────────────────────────────────────────────────────

interface KpiStats {
    /** Localised "starting HRT" duration string. Format examples:
     *   days < 60         → "第30天"
     *   60 ≤ days < 365   → "2个月15天"   (fixed 30-day month)
     *   days ≥ 365        → "1年60天" / "2年230天"  (fixed 365-day year)
     * Empty string when there's no history yet. */
    hrtStartLabel: string;
    /** Total E2-family dose events, with patch apply↔remove paired into 1. */
    e2DoseCount: number;
    /** Plan achievement rate (0..1). Computed from CURRENT plan state — a
     *  postponed dose rolls the plan forward and disappears from the
     *  denominator, so postpone is "neutral" (see computeStats below). */
    achievementRate: number;
    /** Number of postpone actions in the current calendar month. */
    monthPostponeCount: number;
}

/** Format a days-since-start duration using the three-bucket scheme:
 *  <60 days → days only, ≥60 → months+days, ≥365 → years+days. */
function formatHrtStart(days: number): string {
    if (days < 0) return '';
    if (days < 60) return `第${days}天`;
    if (days < 365) {
        const months = Math.floor(days / 30);
        const rem = days - months * 30;
        return rem === 0 ? `${months}个月` : `${months}个月${rem}天`;
    }
    const years = Math.floor(days / 365);
    const rem = days - years * 365;
    return rem === 0 ? `${years}年` : `${years}年${rem}天`;
}

function computeStats(
    events: DoseEvent[],
    today: Date,
    plans?: Plan[],
    postponeLog?: PostponeLogEntry[],
    dueLog?: DueLogEntry[],
): KpiStats {
    // Filter out patch remove events so apply↔remove pairs count as 1 dose.
    const adminEvents = events.filter((e) => !isPatchRemove(e));

    // KPI #1: starting HRT — earliest admin event → today, in days.
    let hrtStartLabel = '';
    if (adminEvents.length > 0) {
        const earliestMs = adminEvents.reduce((min, e) => Math.min(min, e.timeH * 3600000), Infinity);
        const earliest = new Date(earliestMs);
        const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const days = Math.max(0, Math.round((todayMid.getTime() - earliest.getTime()) / 86400000));
        hrtStartLabel = formatHrtStart(days);
    }

    // KPI #2: E2 dose count — E2-family admin events only.
    const e2DoseCount = adminEvents.filter((e) => isE2Family(e.ester)).length;

    // KPI #3: plan achievement rate (口径 C — frozen dueLog).
    // Source of truth is the persisted dueLog (one entry per past due-day),
    // NOT a re-computation against current plan state. Each dueLog entry has
    // already been classified as taken / skipped / postponed at the time the
    // due-day passed (via reminder interaction OR the AppDataProvider startup
    // scan). Edits / disables to plans can therefore NEVER rewrite past.
    //   numerator   = taken entries
    //   denominator = taken + skipped (postponed excluded — user chose to
    //                 roll forward; the day is "not applicable" rather than
    //                 "missed")
    let achievementRate = 0;
    if (dueLog && dueLog.length > 0) {
        let taken = 0;
        let applicable = 0;
        for (const e of dueLog) {
            if (e.status === 'taken') {
                taken += 1;
                applicable += 1;
            } else if (e.status === 'skipped') {
                applicable += 1;
            }
            // 'postponed' intentionally excluded from denominator.
        }
        achievementRate = applicable > 0 ? taken / applicable : 0;
    }

    // KPI #4: postpone actions in the current calendar month.
    let monthPostponeCount = 0;
    if (postponeLog && postponeLog.length > 0) {
        const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        monthPostponeCount = postponeLog.filter((e) => e.yearMonth === ym).length;
    }

    return { hrtStartLabel, e2DoseCount, achievementRate, monthPostponeCount };
}

function toDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Tooltip ──────────────────────────────────────────────────────────────

interface TooltipProps {
    cell: HeatmapDayCell;
    x: number;
    y: number;
    lang: string;
    t: (k: string) => string;
    plans: Plan[];
}

const HeatmapTooltip: React.FC<TooltipProps> = ({ cell, x, y, lang, t, plans }) => {
    // Past / today-with-events shows the actual records (event rows). Today
    // without events + future plan-fire days show what's scheduled — built
    // from Plan objects via the same row shape so styling stays uniform.
    const eventRows = timeSortedCellRows(cell);
    const plannedRows = eventRows.length === 0 ? upcomingPlanRowsForCell(cell, plans) : [];
    const rows = eventRows.length > 0 ? eventRows : plannedRows;
    const isPlannedOnly = rows.length > 0 && eventRows.length === 0 && plannedRows.length > 0;
    const dateStr = formatHeatmapTooltipDate(cell.date, lang);

    return (
        <div
            className="fixed z-50 pointer-events-none rounded-xl glass-card px-3 py-2 text-[11px] space-y-1 max-w-[260px]"
            style={{
                left: Math.min(window.innerWidth - 280, x),
                top: Math.max(8, y - 8),
                transform: 'translate(-50%, -100%)',
            }}
        >
            <div className="font-bold text-[12px]" style={{ color: 'var(--text-primary)' }}>
                {dateStr}
                {cell.isToday && (
                    <span
                        className="ml-1 text-[10px] font-semibold px-1 py-0.5 rounded"
                        style={{ background: 'var(--accent-300)', color: 'var(--text-inverse, #fff)' }}
                    >
                        {t('heatmap.today') || '今天'}
                    </span>
                )}
                {isPlannedOnly && (
                    <span
                        className="ml-1 text-[10px] font-semibold px-1 py-0.5 rounded"
                        style={{ background: 'rgb(245, 164, 255)', color: 'rgb(80, 0, 110)' }}
                    >
                        {t('heatmap.planned') || '计划'}
                    </span>
                )}
            </div>
            {rows.length === 0 ? (
                <div style={{ color: 'var(--text-tertiary)' }}>
                    {t('heatmap.no_events') || '无记录'}
                </div>
            ) : (
                rows.map((r, idx) => {
                    const route = r.route;
                    const isPatch = route === Route.patchApply;
                    return (
                        <div key={idx} className="flex items-center gap-1.5 leading-tight whitespace-nowrap">
                            {/* Drug-category coloured dot — replaces the
                             *  per-route SVG icon set (syringe / pill /
                             *  brain / sticker / …) so the visual signal is
                             *  "which drug class" instead of "which route".
                             *  Patch / gel are still estradiol family at
                             *  colour-resolution time; progesterone is
                             *  amber; anti-androgen is light-blue. The route
                             *  is still readable from `routeShortLabel` on
                             *  the same row. */}
                            <span
                                aria-hidden="true"
                                className="inline-block w-2 h-2 rounded-full shrink-0"
                                style={{ background: heatmapColorForEster(r.ester) }}
                            />
                            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                                {formatTime(new Date(r.timeH * 3600000))}
                            </span>
                            <span className="font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                                {String(r.ester)}
                            </span>
                            <span style={{ color: 'var(--text-secondary)' }}>
                                {routeShortLabel(route, lang)}
                            </span>
                            {!isPatch && (
                                <span className="ml-auto font-mono" style={{ color: 'var(--text-secondary)' }}>
                                    {r.doseMG.toFixed(2)}mg
                                </span>
                            )}
                        </div>
                    );
                })
            )}
        </div>
    );
};

export default MedicationHeatmap;