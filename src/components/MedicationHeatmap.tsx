import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { DoseEvent, Route, Ester } from '../../logic';
import { useTranslation } from '../contexts/LanguageContext';
import { formatTime } from '../utils/helpers';
import { isPatchRemove } from '../utils/patch';
import {
    buildHeatmapRange,
    HEATMAP_COLOR_BY_CATEGORY,
    heatmapColorForEster,
    monthLabelFor,
    routesOfCell,
    timeSortedCellRows,
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
//   • grid = 1 label col + N week cols (all weeks equal-flex)
//   • cells = aspect-square w-full (size follows container, not fixed px)
//   • month labels absolutely positioned above their first-appearance column
//
// Constraints (kept identical to v1):
//   • colour encodes drug category
//   • 1=mono, 2=diagonal, 3=L+M+R, 4=2×2 cross, 5+=cross + "+N" badge
//   • patches propagate apply→remove as one continuous band
//   • tooltip = day date + per-event rows (HH:MM, route icon, ester, dose)
//   • today outlined; future cells faded
//   • zoom 1–26 weeks; default = how many weeks fit in container
// ─────────────────────────────────────────────────────────────────────────────

interface MedicationHeatmapProps {
    events: DoseEvent[];
    /** Override "now" for tests / previews. */
    today?: Date;
    /** Future pad appended after today (default 21d). */
    futurePadDays?: number;
}

const MIN_WEEKS = 1;
const MAX_WEEKS = 26;
/** Approx target cell size used to derive the default number of weeks to
 *  show on first mount. Once mounted, cells size via `aspect-square w-full`
 *  inside a flex-1 grid, so the actual size scales with container width. */
const TARGET_CELL_PX = 14;
const DEFAULT_GAP_PX = 5;

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Distinct drug categories present in a day's events (de-duped, original
 *  order). Patch mid-wear synthetic events reuse their apply event's category,
 *  so a multi-day patch shows as a single-colour band by construction. */
function categoriesOfCell(cell: HeatmapDayCell): DrugCategory[] {
    const seen = new Set<DrugCategory>();
    const out: DrugCategory[] = [];
    for (const e of cell.events) {
        if (isPatchRemove(e)) continue;
        const cat = categoryOfEsterLocal(e.ester);
        if (!seen.has(cat)) {
            seen.add(cat);
            out.push(cat);
        }
    }
    return out;
}

/** Tiny local re-derivation to avoid importing from planSchedule (which would
 *  drag schedule types into this view file). Must match
 *  `src/utils/planSchedule.ts → drugCategoryOf`. */
function categoryOfEsterLocal(ester: Ester): DrugCategory {
    const s = String(ester);
    if (s === 'CPA' || s === 'Bicalutamide' || s === 'Finasteride') return 'anti_androgen';
    if (s === 'PRL' || s === 'Progesterone') return 'progestin';
    if (s.startsWith('E')) return 'estrogen';
    return 'other';
}

const MedicationHeatmap: React.FC<MedicationHeatmapProps> = ({
    events,
    today,
    futurePadDays = 21,
}) => {
    const { t, lang } = useTranslation();
    const containerRef = useRef<HTMLDivElement | null>(null);

    // ── Range + zoom state ────────────────────────────────────────────────
    const todayRef = today ?? new Date();
    const range: HeatmapRange = useMemo(
        () => buildHeatmapRange(events, todayRef, futurePadDays),
        [events, todayRef, futurePadDays],
    );

    const totalWeeks = range.weeks.length;

    // Default weeks visible ≈ how many columns fit across the heatmap card
    // width (assumes ~36px for the weekday label col on the left).
    const computeDefaultWeeks = () =>
        Math.max(
            MIN_WEEKS,
            Math.min(
                MAX_WEEKS,
                Math.floor(window.innerWidth / (TARGET_CELL_PX + DEFAULT_GAP_PX)),
            ),
        );

    const [weeksShown, setWeeksShown] = useState<number>(computeDefaultWeeks);

    // Clamp on events / props change.
    useEffect(() => {
        setWeeksShown((w) => Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.min(w, totalWeeks))));
    }, [totalWeeks]);

    // Recompute default on resize so the user always sees "as many as fit".
    useEffect(() => {
        const onResize = () => {
            const fit = computeDefaultWeeks();
            setWeeksShown((prev) => (prev === fit ? prev : fit));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Anchor the visible window so "today" stays in view (centre it).
    const visibleWeeks: HeatmapWeekColumn[] = useMemo(() => {
        if (weeksShown >= totalWeeks) return range.weeks;
        const todayIdx = range.weeks.findIndex((w) => w.days.some((d) => d.isToday));
        const baseAnchor = todayIdx >= 0 ? todayIdx : Math.max(0, totalWeeks - weeksShown);
        const anchor = Math.max(
            Math.floor(weeksShown / 2),
            Math.min(totalWeeks - Math.ceil(weeksShown / 2), baseAnchor),
        );
        const start = Math.max(0, anchor - Math.floor(weeksShown / 2));
        const end = Math.min(totalWeeks, start + weeksShown);
        return range.weeks.slice(start, end);
    }, [range.weeks, weeksShown, totalWeeks]);

    // ── KPI stats (right side card stack) ─────────────────────────────────
    const stats = useMemo(() => computeStats(events, todayRef, range), [events, todayRef, range]);

    // ── Tooltip state ─────────────────────────────────────────────────────
    const [tooltip, setTooltip] = useState<{
        cell: HeatmapDayCell;
        x: number;
        y: number;
    } | null>(null);

    if (totalWeeks === 0) return null;

    return (
        <div className="w-full" ref={containerRef}>
            {/* Title row — plain text, optional zoom buttons on the right */}
            <div className="flex items-center mb-2 min-h-[28px]">
                <h4
                    className="text-[14px] font-semibold m-0"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {t('heatmap.title') || '用药日历'}
                </h4>
                <div className="ml-auto flex items-center gap-1">
                    <button
                        type="button"
                        aria-label="zoom-out"
                        disabled={weeksShown >= MAX_WEEKS}
                        onClick={() => setWeeksShown((w) => Math.min(MAX_WEEKS, w + 1))}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md btn-press-glass transition disabled:opacity-40"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                    >
                        <ZoomOut size={13} />
                    </button>
                    <button
                        type="button"
                        aria-label="zoom-in"
                        disabled={weeksShown <= MIN_WEEKS}
                        onClick={() => setWeeksShown((w) => Math.max(MIN_WEEKS, w - 1))}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md btn-press-glass transition disabled:opacity-40"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                    >
                        <ZoomIn size={13} />
                    </button>
                </div>
            </div>

            {/* Body row: heatmap (left, flex-4) + KPI stack (right, flex-1) */}
            <div className="flex flex-col md:flex-row md:items-stretch gap-3">
                <div className="w-full md:flex-[4] min-w-0">
                    <div className="h-full flex flex-col justify-between">
                        {/* Heatmap area */}
                        <div className="w-full overflow-x-auto overflow-y-hidden">
                            <div className="min-w-[380px]">
                                <div
                                    className="grid w-full"
                                    style={{
                                        gridTemplateColumns: `auto repeat(${visibleWeeks.length}, minmax(0px, 1fr))`,
                                        gap: `${DEFAULT_GAP_PX}px`,
                                    }}
                                >
                                    {/* Top-left empty cell (corner of the header row) */}
                                    <div />
                                    {/* Month / year header row — absolute-positioned
                                     *  labels above their first-appearance column */}
                                    <div
                                        className="relative h-4"
                                        style={{ gridColumn: `2 / span ${visibleWeeks.length}` }}
                                    >
                                        {visibleWeeks.map((w, idx) =>
                                            w.monthLabel ? (
                                                <span
                                                    key={`mh-${idx}`}
                                                    className="absolute top-0 text-[11px] whitespace-nowrap pointer-events-none"
                                                    style={{
                                                        left: `${(idx / visibleWeeks.length) * 100}%`,
                                                        color: 'var(--text-tertiary)',
                                                    }}
                                                >
                                                    {monthLabelFor(w.startDate)}
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
                                                className="text-[11px] text-right pr-2 flex items-center justify-end leading-none whitespace-nowrap"
                                                style={{
                                                    minWidth: '36px',
                                                    color: 'var(--text-tertiary)',
                                                }}
                                            >
                                                {t(`heatmap.weekday_${dayKey}`) || ''}
                                            </div>
                                            {visibleWeeks.map((w, wIdx) => {
                                                const d = w.days[dayIdx];
                                                if (!d) return <div key={`${wIdx}-${dayIdx}`} />;
                                                const cats = categoriesOfCell(d);
                                                const routes = routesOfCell(d);
                                                const isPatchOnly =
                                                    routes.length > 0 && routes.every((r) => r === Route.patchApply);
                                                return (
                                                    <button
                                                        key={`${wIdx}-${dayIdx}`}
                                                        type="button"
                                                        aria-label={d.dateKey}
                                                        className="relative rounded-[2px] aspect-square w-full cursor-pointer transition-opacity hover:opacity-80 btn-press-glass"
                                                        style={{
                                                            background: cellBackground(cats, d),
                                                            opacity: d.isFuture ? 0.35 : 1,
                                                            outline: d.isToday ? '1.5px solid var(--accent-300)' : 'none',
                                                            outlineOffset: d.isToday ? '-1.5px' : 0,
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                            setTooltip({
                                                                cell: d,
                                                                x: rect.left + rect.width / 2,
                                                                y: rect.top,
                                                            });
                                                        }}
                                                        onMouseLeave={() => setTooltip(null)}
                                                    >
                                                        {cats.length > 4 && (
                                                            <span
                                                                className="absolute bottom-0 right-0 text-[8px] font-bold leading-none px-[2px] rounded-tl-[2px]"
                                                                style={{
                                                                    background: 'rgba(0,0,0,0.55)',
                                                                    color: '#fff',
                                                                }}
                                                            >
                                                                +{cats.length - 4}
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
                </div>

                {/* Right-side KPI card stack */}
                <div className="grid grid-cols-3 md:flex md:flex-col gap-2 w-full md:flex-[1] md:min-w-[144px] md:self-stretch">
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

            {/* Tooltip — fixed-positioned using the cell's bounding box */}
            {tooltip && (
                <HeatmapTooltip
                    cell={tooltip.cell}
                    x={tooltip.x}
                    y={tooltip.y}
                    lang={lang}
                    t={t}
                />
            )}
        </div>
    );
};

// ── Cell background helpers ───────────────────────────────────────────────

/** Map the distinct categories in a day to a CSS background. The category
 *  count drives the layout strategy; falls back to a low-contrast empty bg
 *  for future / no-event days. */
function cellBackground(cats: DrugCategory[], cell: HeatmapDayCell): string {
    if (cats.length === 0) {
        return cell.isFuture ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.10)';
    }
    if (cats.length === 1) {
        return HEATMAP_COLOR_BY_CATEGORY[cats[0]];
    }
    if (cats.length === 2) {
        const [a, b] = cats;
        return `conic-gradient(from -45deg at 50% 50%, ${HEATMAP_COLOR_BY_CATEGORY[a]} 0deg 180deg, ${HEATMAP_COLOR_BY_CATEGORY[b]} 180deg 360deg)`;
    }
    if (cats.length === 3) {
        const [a, b, c] = cats;
        return `linear-gradient(90deg, ${HEATMAP_COLOR_BY_CATEGORY[a]} 0 33.33%, ${HEATMAP_COLOR_BY_CATEGORY[b]} 33.33% 66.66%, ${HEATMAP_COLOR_BY_CATEGORY[c]} 66.66% 100%)`;
    }
    // 4+: 2×2 cross via 4 stacked gradients (TL / TR / BL / BR quadrants).
    const [tl, tr, bl, br] = cats;
    return [
        `linear-gradient(0deg, ${HEATMAP_COLOR_BY_CATEGORY[bl]} 50%, transparent 50%)`,
        `linear-gradient(0deg, transparent 50%, ${HEATMAP_COLOR_BY_CATEGORY[br]} 50%)`,
        `linear-gradient(90deg, ${HEATMAP_COLOR_BY_CATEGORY[tl]} 50%, transparent 50%)`,
        `linear-gradient(90deg, transparent 50%, ${HEATMAP_COLOR_BY_CATEGORY[tr]} 50%)`,
    ].join(', ');
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

function computeStats(events: DoseEvent[], today: Date, range: HeatmapRange): KpiStats {
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const adminEvents = events.filter((e) => !isPatchRemove(e));
    const totalEvents = adminEvents.length;

    // Active days = distinct local days with ≥1 admin event in the visible range.
    const dayKeys = new Set<string>();
    for (const w of range.weeks) {
        for (const d of w.days) {
            if (d.events.some((e) => !isPatchRemove(e))) dayKeys.add(d.dateKey);
        }
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
}

const HeatmapTooltip: React.FC<TooltipProps> = ({ cell, x, y, lang, t }) => {
    const rows = timeSortedCellRows(cell);
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