import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, RotateCcw } from 'lucide-react';
import { DoseEvent, Route, Ester, Plan } from '../../types';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { formatTime } from '../utils/helpers';
import { isPatchRemove } from '../utils/patch';
import { drugCategoryOf, dueMomentsInRange } from '../utils/planSchedule';
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
//   • today outlined; future cells faded
//   • weekday labels are sticky-left so 一-日 stay visible while scrolling
// ─────────────────────────────────────────────────────────────────────────────

interface MedicationHeatmapProps {
    events: DoseEvent[];
    /** Active plans. When provided, each plan's `startDateH` is rendered as a
     *  light-yellow cell with the day-of-month number inside (so the user can
     *  spot plan-launch dates at a glance without leaving the heatmap). */
    plans?: Plan[];
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
    // (so we never waste cycles computing fires the user can't see). Used to
    // paint the magenta "scheduled" highlight + white day number on cells
    // whose planned dose is coming up.
    const planFireKeys: Set<string> = useMemo(() => {
        if (!plans || plans.length === 0) return new Set();
        const todayMid = new Date(
            todayRef.getFullYear(),
            todayRef.getMonth(),
            todayRef.getDate(),
        );
        const horizon = new Date(range.endDate);
        horizon.setDate(horizon.getDate() + 7); // small safety margin past the rendered end
        const out = new Set<string>();
        for (const p of plans) {
            try {
                const moments = dueMomentsInRange(p, todayMid, horizon);
                for (const m of moments) {
                    // dueMomentsInRange is already filtered to ≥ from (= todayMid),
                    // so everything left is a future (or today) plan-fire Date.
                    const k = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
                    out.add(k);
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
    const cellSize = ZOOM_LEVELS[zoomLevel].cellSize;
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Crop the full range to the last N weeks dictated by the current zoom
    // level so 2M / 3M / 6M actually show that many months of history. KPI
    // stats continue to be computed from the full `events` list (see
    // `computeStats` below) so the count of "累计用药 / 活跃天数" doesn't
    // jump around as the user toggles zoom.
    const visibleWeeksCount = ZOOM_LEVELS[zoomLevel].weeks;
    const visibleRange: HeatmapRange = useMemo(() => {
        const all = range.weeks;
        if (all.length <= visibleWeeksCount) return range;
        const start = all.length - visibleWeeksCount;
        const weeks = all.slice(start);
        // Anchor startDate to the first visible week's Monday so the grid's
        // sticky weekday column still aligns with the cropped cells.
        return { ...range, weeks };
    }, [range, visibleWeeksCount]);
    const totalWeeks = visibleRange.weeks.length;

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
    }, [visibleRange.weeks, cellSize]);

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
    const stats = useMemo(() => computeStats(events, todayRef), [events, todayRef]);

    // ── Tooltip state ─────────────────────────────────────────────────────
    const [tooltip, setTooltip] = useState<{
        cell: HeatmapDayCell;
        x: number;
        y: number;
    } | null>(null);

    if (totalWeeks === 0) return null;

    return (
        <div className="glass-card rounded-2xl relative overflow-hidden" ref={containerRef}>
            {/* Title row — icon + title on left, zoom buttons on the right.
             *  Visually mirrors ResultChart's chart card header so the two
             *  sections read as a matched pair. */}
            <div className="flex justify-between items-center px-3 md:px-4 py-2.5 md:py-3 border-b border-[var(--border-secondary)]">
                <h4
                    className="text-sm md:text-base font-semibold tracking-tight m-0 flex items-center gap-2"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <span className="inline-flex items-center justify-center w-8 h-8 md:w-10 md:h-10 rounded-xl bg-pink-50 dark:bg-pink-950/30 border border-pink-100 dark:border-pink-800/30">
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
            <div className="px-3 md:px-4 py-3 md:py-4">
                <div className={compact
                    ? 'flex flex-col gap-3'
                    : 'flex flex-col md:flex-row md:items-stretch gap-3'
                }>
                <div className="w-full md:flex-[4] min-w-0">
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
                            className="scrollbar-hide w-full overflow-x-auto overflow-y-hidden select-none"
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
                                    {visibleRange.weeks.map((w, idx) =>
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
                                        {visibleRange.weeks.map((w, wIdx) => {
                                            const d = w.days[dayIdx];
                                            if (!d) return <div key={`${wIdx}-${dayIdx}`} />;
                                                const cats = categoriesOfCell(d);
                                                const routes = routesOfCell(d);
                                                const isPatchOnly =
                                                    routes.length > 0 && routes.every((r) => r === Route.patchApply);
                                                const isPlanFireFuture = !d.isToday && planFireKeys.has(d.dateKey);
                                                // White day-number renders on any "signal" day:
                                                // a real admin event landed, today, or a future
                                                // plan-fire day. Past empty days stay blank so
                                                // the colour bands read as the primary signal.
                                                const hasEvents = d.events.some((e) => !isPatchRemove(e));
                                                const showDayNum = d.isToday || isPlanFireFuture || hasEvents;
                                                return (
                                                    <button
                                                        key={`${wIdx}-${dayIdx}`}
                                                        type="button"
                                                        aria-label={d.dateKey}
                                                        className="relative rounded-[2px] aspect-square w-full cursor-pointer transition-opacity hover:opacity-80 btn-press-glass"
                                                        style={{
                                                            background: cellBackground(cats, d, isDark, isPlanFireFuture),
                                                            opacity: 1,
                                                            outline: d.isToday ? '1.5px solid var(--accent-300)' : 'none',
                                                            outlineOffset: d.isToday ? '-1.5px' : 0,
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
                    ? 'grid grid-cols-3 gap-2 w-full'
                    : 'grid grid-cols-3 md:flex md:flex-col gap-2 w-full md:flex-[1] md:min-w-[144px] md:self-stretch'
                }>
                    <KpiCard
                        value={String(stats.totalEvents)}
                        label={t('heatmap.kpi.total') || '累计用药'}
                    />
                    <KpiCard
                        value={String(stats.activeDays)}
                        label={t('heatmap.kpi.active_days') || '活跃天数'}
                    />
                    <KpiCard
                        value={String(stats.currentStreak)}
                        label={t('heatmap.kpi.streak') || '当前连续'}
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

/** Magenta highlight for "today + future plan-fire" days. Solid colour that
 *  wins over every category palette — the whole point is to make upcoming
 *  scheduled doses pop visually against the past-dose colour bands. */
const PLAN_FIRE_BG = 'rgb(245, 164, 255)';

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
 *  - Plan-fire day (today + future, plan scheduled) → solid magenta highlight
 *  - 0 → empty (theme-aware grey)
 *  - 1 → solid category colour
 *  - 2 → wavy split
 *  - 3 → 3 vertical stripes
 *  - 4+ → transparent (rare; the per-event detail is in the tooltip). */
function cellBackground(
    cats: DrugCategory[],
    cell: HeatmapDayCell,
    isDark: boolean,
    isPlanFireFuture: boolean,
): string {
    // Plan-fire highlight always wins — even on cells with recorded events,
    // because the magenta indicates "your plan says you'll dose here" which
    // is the more actionable signal for the user.
    if (isPlanFireFuture) return PLAN_FIRE_BG;
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

/** Tiny inline route icons. We can't use `getRouteIcon` because that returns
 *  20px icons — too big for a heatmap cell. */
function routeIconSmall(route: Route | null) {
    if (!route) return null;
    const common = 'w-[10px] h-[10px]';
    switch (route) {
        case Route.injection:
            return (
                <svg viewBox="0 0 16 16" className={common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 2 L14 6 L11 9 L7 5 Z" /><path d="M7 5 L3 9" /><path d="M3 9 L2 12 L5 11 Z" />
                </svg>
            );
        case Route.oral:
        case Route.sublingual:
            return (
                <svg viewBox="0 0 16 16" className={common} fill="currentColor">
                    <rect x="3" y="5" width="10" height="6" rx="3" />
                </svg>
            );
        case Route.gel:
            return (
                <svg viewBox="0 0 16 16" className={common} fill="currentColor">
                    <path d="M8 2 C 5 5 5 9 8 14 C 11 9 11 5 8 2 Z" />
                </svg>
            );
        case Route.patchApply:
            return (
                <svg viewBox="0 0 16 16" className={common} fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="10" height="10" rx="2" />
                </svg>
            );
        case Route.patchRemove:
            return (
                <svg viewBox="0 0 16 16" className={common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4 4 L12 12 M12 4 L4 12" />
                </svg>
            );
    }
}

// ── KPI card (right-side stack) ──────────────────────────────────────────

const KpiCard: React.FC<{ value: string; label: string }> = ({ value, label }) => (
    <div
        className="min-w-0 flex flex-col justify-center rounded-lg px-3 py-2 md:flex-1 md:min-h-0"
        style={{ background: 'var(--bg-card-hover)' }}
    >
        <div className="flex items-center gap-1.5 min-w-0">
            <span
                className="text-xl font-semibold tabular-nums tracking-tight leading-tight truncate"
                style={{ color: 'var(--text-primary)' }}
            >
                {value}
            </span>
        </div>
        <div
            className="text-[12px] mt-0.5 truncate w-full"
            style={{ color: 'var(--text-tertiary)' }}
        >
            {label}
        </div>
    </div>
);

// ── KPI computation ──────────────────────────────────────────────────────

interface KpiStats {
    totalEvents: number;
    activeDays: number;
    currentStreak: number;
}

function computeStats(events: DoseEvent[], today: Date): KpiStats {
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const adminEvents = events.filter((e) => !isPatchRemove(e));
    const totalEvents = adminEvents.length;

    // Active days = distinct local days with ≥1 admin event in the FULL
    // history (not the visible/cropped range). The KPI numbers represent
    // the user's total usage, not "what's on screen right now" — otherwise
    // toggling 2M/3M/6M would cause the count to jump around and confuse.
    const dayKeys = new Set<string>();
    for (const e of adminEvents) {
        const d = new Date(e.timeH * 3600000);
        dayKeys.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const activeDays = dayKeys.size;

    // Current streak = consecutive days ending today (or yesterday) with ≥1 event.
    // Walk backwards from today; if today itself has no event, start from yesterday.
    let streak = 0;
    const cursor = new Date(todayMid);
    // Step 1: peek at today — if empty, step back 1 day first (the streak is
    // "still alive" if the user just hasn't logged today yet).
    const todayHas = dayKeys.has(toDateKey(cursor));
    if (!todayHas) cursor.setDate(cursor.getDate() - 1);
    while (dayKeys.has(toDateKey(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }

    // Reference to suppress unused warning when not used.
    void totalEvents;
    void adminEvents;
    return { totalEvents, activeDays, currentStreak: streak };
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
                            <span style={{ color: heatmapColorForEster(r.ester) }}>
                                {routeIconSmall(route)}
                            </span>
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