import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { formatDate, formatTime } from '../utils/helpers';
import {
    SimulationResult, DoseEvent, interpolateConcentration_E2,
    interpolateCompoundConcentration, isAntiandrogen, isE2Family,
    pickPrimaryAntiandrogen, ANTIANDROGENS, Ester, LabResult, convertToPgMl
} from '../../logic';
import { Activity, RotateCcw, Camera, FlaskConical } from 'lucide-react';
import * as echarts from 'echarts';
import { ECHART_THEME, LAB_FLASK_PATH, aaBandFill, resolveCssVar } from './ResultChart.theme';

// ============================================================
// Types (unchanged from Recharts version)
// ============================================================

interface SimCI {
    timeH: number[];
    e2Adjusted: number[];
    ci95Low: number[];
    ci95High: number[];
    ci68Low: number[];
    ci68High: number[];
    antiandrogen: Partial<Record<string, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>>;
}

interface ChartPoint {
    time: number;
    concE2?: number;
    concCPA?: number;
    concPersonal?: number;
    concPersonalCPA?: number;
    ci95Low?: number;
    ci95Band?: number;
    ci95High?: number;
    ci68Low?: number;
    ci68Band?: number;
    ci68High?: number;
    cpaCi95Low?: number;
    cpaCi95Band?: number;
    cpaCi95High?: number;
}

// ============================================================
// Series helpers (unchanged from Recharts version — still needed
// for downsampling and hover lookup)
// ============================================================

function pointExtrema(d: ChartPoint): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    const include = (v: number | undefined) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        if (v < min) min = v;
        if (v > max) max = v;
    };

    include(d.concE2);
    include(d.concPersonal);
    include(d.ci95Low);
    include(d.ci95High);
    include(d.ci68Low);
    include(d.ci68High);
    include(d.concCPA);
    include(d.concPersonalCPA);
    include(d.cpaCi95Low);
    include(d.cpaCi95High);

    if (min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) {
        return { min: 0, max: 0 };
    }
    return { min, max };
}

function downsampleSeries(series: ChartPoint[], maxPoints = 600): ChartPoint[] {
    if (series.length <= maxPoints) return series;
    if (maxPoints < 3) return [series[0], series[series.length - 1]];

    const first = series[0];
    const last = series[series.length - 1];
    const interiorStart = 1;
    const interiorCount = Math.max(0, series.length - 2);

    if (interiorCount === 0) return [first, last];

    const maxBuckets = Math.max(1, Math.floor((maxPoints - 2) / 2));
    const bucketCount = Math.min(maxBuckets, interiorCount);
    const sampled: ChartPoint[] = [first];

    for (let bucket = 0; bucket < bucketCount; bucket++) {
        const from = interiorStart + Math.floor((bucket * interiorCount) / bucketCount);
        const to = interiorStart + Math.floor(((bucket + 1) * interiorCount) / bucketCount) - 1;
        if (from > to) continue;

        let minIdx = from;
        let maxIdx = from;
        let minVal = Number.POSITIVE_INFINITY;
        let maxVal = Number.NEGATIVE_INFINITY;

        for (let i = from; i <= to; i++) {
            const { min, max } = pointExtrema(series[i]);
            if (min < minVal) {
                minVal = min;
                minIdx = i;
            }
            if (max > maxVal) {
                maxVal = max;
                maxIdx = i;
            }
        }

        if (minIdx === maxIdx) {
            sampled.push(series[minIdx]);
            continue;
        }

        if (minIdx < maxIdx) {
            sampled.push(series[minIdx], series[maxIdx]);
        } else {
            sampled.push(series[maxIdx], series[minIdx]);
        }
    }

    sampled.push(last);

    const deduped: ChartPoint[] = [];
    for (const point of sampled) {
        if (!deduped.length || deduped[deduped.length - 1].time !== point.time) {
            deduped.push(point);
        }
    }
    if (deduped.length <= maxPoints) return deduped;

    const compact: ChartPoint[] = [];
    const interval = (deduped.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.round(i * interval);
        const point = deduped[idx];
        if (!compact.length || compact[compact.length - 1].time !== point.time) {
            compact.push(point);
        }
    }
    if (compact.length > 0) {
        compact[compact.length - 1] = deduped[deduped.length - 1];
    }
    return compact;
}

function interpAt(timeH: number[], values: number[], h: number): number | undefined {
    if (!timeH.length || !values.length || timeH.length !== values.length) return undefined;
    if (h <= timeH[0]) return values[0];
    if (h >= timeH[timeH.length - 1]) return values[values.length - 1];
    let lo = 0;
    let hi = timeH.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (timeH[mid] <= h) lo = mid;
        else hi = mid;
    }
    const span = timeH[hi] - timeH[lo];
    const frac = span > 0 ? (h - timeH[lo]) / span : 0;
    const v = values[lo] + (values[hi] - values[lo]) * frac;
    return Number.isFinite(v) ? v : undefined;
}

/** Binary search for nearest data index by time (used for hover tooltip lookup). */
function nearestIndex(data: ChartPoint[], time: number): number {
    if (data.length === 0) return -1;
    if (time <= data[0].time) return 0;
    if (time >= data[data.length - 1].time) return data.length - 1;
    let lo = 0;
    let hi = data.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (data[mid].time <= time) lo = mid;
        else hi = mid;
    }
    const lowDist = Math.abs(data[lo].time - time);
    const highDist = Math.abs(data[hi].time - time);
    return highDist < lowDist ? hi : lo;
}

// ============================================================
// CustomTooltip (unchanged from Recharts version — React DOM floating card)
// ============================================================

const CustomTooltip = ({ active, payload, label, t, lang, aaLabel = 'CPA', aaUnit = 'ng/mL', aaColor = '#8b5cf6', aaShowPersonal = true }: any) => {
    if (active && payload && payload.length) {
        // Lab result point
        if (payload[0].payload.isLabResult) {
            const data = payload[0].payload;
            return (
                <div className="bg-[var(--bg-card)]/90 backdrop-blur-sm px-3 py-2 rounded-xl border border-[var(--border-tip-teal)] shadow-sm">
                    <p className="text-[10px] font-medium mb-0.5 flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                        <FlaskConical size={10} />
                        {formatDate(new Date(label), lang)} {formatTime(new Date(label))}
                    </p>
                    <div className="flex items-baseline gap-1">
                        <span className="text-base font-black text-teal-600 tracking-tight">
                            {data.originalValue}
                        </span>
                        <span className="text-[10px] font-bold text-teal-400">{data.originalUnit}</span>
                    </div>
                    {data.originalUnit === 'pmol/l' && (
                        <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                            ≈ {data.conc.toFixed(1)} pg/mL
                        </div>
                    )}
                </div>
            );
        }

        const dataPoint = payload[0].payload;
        const concE2 = dataPoint.concE2 || 0;
        const concCPA = dataPoint.concCPA || 0;
        const concPersonal = dataPoint.concPersonal;
        const concPersonalCPA = dataPoint.concPersonalCPA;
        const ciLow = dataPoint.ci95Low;
        const ciHigh = dataPoint.ci95High;
        const ci68Low = dataPoint.ci68Low;
        const ci68High = dataPoint.ci68High;
        const cpaCiLow = dataPoint.cpaCi95Low;
        const cpaCiHigh = dataPoint.cpaCi95High;

        return (
            <div className="bg-[var(--bg-card)]/90 backdrop-blur-sm px-3 py-2 rounded-xl border border-[var(--border-tip-pink)] shadow-sm">
                <p className="text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    {formatDate(new Date(label), lang)} {formatTime(new Date(label))}
                </p>
                {concE2 > 0 && (
                    <div className="flex items-baseline gap-1">
                        <span className="text-[9px] font-bold text-pink-400">E2:</span>
                        <span className="text-sm font-black text-pink-500 tracking-tight">
                            {concE2.toFixed(1)}
                        </span>
                        <span className="text-[10px] font-bold text-pink-300">pg/mL</span>
                    </div>
                )}
                {concPersonal !== undefined && concPersonal > 0 && (
                    <div className="mt-0.5">
                        <div className="flex items-baseline gap-1">
                            <span className="text-[9px] font-bold text-rose-400">{t('chart.personal_model')} E2:</span>
                            <span className="text-sm font-black text-rose-600 tracking-tight">
                                {concPersonal.toFixed(1)}
                            </span>
                            <span className="text-[10px] font-bold text-rose-300">pg/mL</span>
                        </div>
                        {ci68Low !== undefined && ci68High !== undefined && (
                            <div className="flex items-center gap-1 ml-1 mt-0.5">
                                <span className="text-[8px] font-bold text-rose-300 uppercase w-8">{t('chart.ci68_band')}</span>
                                <span className="text-[9px] text-rose-400 font-medium">
                                    {ci68Low.toFixed(0)} – {ci68High.toFixed(0)}
                                    <span className="text-[8px] font-normal text-rose-300 ml-0.5">pg/mL</span>
                                </span>
                            </div>
                        )}
                        {ciLow !== undefined && ciHigh !== undefined && (
                            <div className="flex items-center gap-1 ml-1 mt-0.5">
                                <span className="text-[8px] font-bold uppercase w-8" style={{ color: 'var(--text-tertiary)' }}>{t('chart.ci_band')}</span>
                                <span className="text-[9px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                                    {ciLow.toFixed(0)} – {ciHigh.toFixed(0)}
                                    <span className="text-[8px] font-normal ml-0.5" style={{ color: 'var(--text-tertiary)' }}>pg/mL</span>
                                </span>
                            </div>
                        )}
                    </div>
                )}
                {concCPA > 0 && (
                    <div className="flex items-baseline gap-1 mt-0.5">
                        <span className="text-[9px] font-bold" style={{ color: aaColor }}>{aaLabel}:</span>
                        <span className="text-sm font-black tracking-tight" style={{ color: aaColor }}>
                            {concCPA.toFixed(2)}
                        </span>
                        <span className="text-[10px] font-bold" style={{ color: aaColor, opacity: 0.7 }}>{aaUnit}</span>
                    </div>
                )}
                {!aaShowPersonal && concCPA > 0 && cpaCiLow !== undefined && cpaCiHigh !== undefined && (
                    <div className="flex items-center gap-1 ml-1 mt-0.5">
                        <span className="text-[8px] font-bold uppercase w-12" style={{ color: 'var(--text-tertiary)' }}>{t('chart.cpa_pop_range')}</span>
                        <span className="text-[9px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {cpaCiLow.toFixed(2)} – {cpaCiHigh.toFixed(2)}
                            <span className="text-[8px] font-normal ml-0.5" style={{ color: 'var(--text-tertiary)' }}>{aaUnit}</span>
                        </span>
                    </div>
                )}
                {aaShowPersonal && concPersonalCPA !== undefined && concPersonalCPA > 0 && (
                    <div className="mt-0.5">
                        <div className="flex items-baseline gap-1">
                            <span className="text-[9px] font-bold" style={{ color: aaColor }}>{t('chart.personal_model')} {aaLabel}:</span>
                            <span className="text-sm font-black tracking-tight" style={{ color: aaColor }}>
                                {concPersonalCPA.toFixed(2)}
                            </span>
                            <span className="text-[10px] font-bold" style={{ color: aaColor, opacity: 0.7 }}>{aaUnit}</span>
                        </div>
                        {cpaCiLow !== undefined && cpaCiHigh !== undefined && (
                            <div className="flex items-center gap-1 ml-1 mt-0.5">
                                <span className="text-[8px] font-bold uppercase w-8" style={{ color: 'var(--text-tertiary)' }}>{t('chart.ci_band')}</span>
                                <span className="text-[9px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                                    {cpaCiLow.toFixed(2)} – {cpaCiHigh.toFixed(2)}
                                    <span className="text-[8px] font-normal ml-0.5" style={{ color: 'var(--text-tertiary)' }}>{aaUnit}</span>
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }
    return null;
};

// ============================================================
// ResultChart (ECharts Canvas wrapper)
// ============================================================

interface ResultChartProps {
    sim: SimulationResult | null;
    events: DoseEvent[];
    labResults?: LabResult[];
    simCI?: SimCI | null;
    baselineE2PGmL?: number | null;
    nowH?: number;
    onPointClick: (e: DoseEvent) => void;
    onShareImage?: () => void;
}

const ResultChart = ({ sim, events, labResults = [], simCI, baselineE2PGmL, nowH, onPointClick, onShareImage }: ResultChartProps) => {
    // xZoomRange must be declared before any useMemo that depends on it.
    // React strict mode double-invokes useMemo factories, so if a downstream
    // useMemo (yDomainLeft/Right, buildChartOption) reads xZoomRange but the
    // declaration lives below them, the first invocation throws TDZ.
    // Current visible X-axis range (timestamp ms). null = full range / not yet known.
    // When the visible window is narrow enough (< 2 days), the X-axis labels switch
    // from "MMM d" to "MMM d HH:mm" so the user can read intra-day time, and the
    // Y-axis domain rescales to the visible window.
    const [xZoomRange, setXZoomRange] = useState<[number, number] | null>(null);

    const primaryAA = useMemo<Ester | null>(
        () => pickPrimaryAntiandrogen(events, nowH ?? Date.now() / 3600000),
        [events, nowH]
    );
    const aaSpec = primaryAA ? ANTIANDROGENS[primaryAA]! : null;
    const hasCPADoses = !!primaryAA;
    const aaUnit: 'ng/mL' | 'ug/mL' = primaryAA === Ester.BICA ? 'ug/mL' : 'ng/mL';
    const aaScale = aaUnit === 'ug/mL' ? 1 / 1000 : 1;
    const aaColor = aaSpec?.color ?? ECHART_THEME.aaFallback;
    const aaLabel = primaryAA ?? 'CPA';
    const aaPersonalized = !!aaSpec?.adherenceFromE2;
    const hasE2Personal = !!simCI && simCI.e2Adjusted.length > 0;
    const { t, lang } = useTranslation();

    const E2_AXIS_FALLBACK_MAX = 10;
    const CPA_AXIS_FALLBACK_MAX = 1;
    const MAX_RENDER_POINTS = 1200;

    const niceCeil = (value: number, fallback: number): number => {
        if (!Number.isFinite(value) || value <= 0) return fallback;
        const exp = Math.floor(Math.log10(value));
        const base = Math.pow(10, exp);
        const norm = value / base;
        const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
        return step * base;
    };

    const formatAxisTick = (raw: number | string): string => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return '0';
        if (n >= 100) return `${Math.round(n)}`;
        if (n >= 10) return `${Math.round(n)}`;
        if (n >= 1) return n.toFixed(1);
        return n.toFixed(2);
    };

    const niceFloor = (value: number, fallback: number): number => {
        if (!Number.isFinite(value)) return fallback;
        if (value <= 0) return 0;
        const exp = Math.floor(Math.log10(value));
        const base = Math.pow(10, exp);
        const norm = value / base;
        const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
        return step * base;
    };

    const aaCISeries = (primaryAA && simCI) ? simCI.antiandrogen[primaryAA] : undefined;
    const hasPersonalCpaModel = !!aaCISeries && !!simCI && aaCISeries.adjusted.length === simCI.timeH.length;
    const hasPersonalCpaCI = !!aaCISeries && !!simCI &&
        aaCISeries.ci95Low.length === simCI.timeH.length &&
        aaCISeries.ci95High.length === simCI.timeH.length;

    const ciMap = useMemo(() => {
        if (!simCI) return null;
        const m = new Map<number, {
            ci95Low: number;
            ci95High: number;
            ci68Low: number;
            ci68High: number;
            e2Adj: number;
            cpaAdj?: number;
            cpaCi95Low?: number;
            cpaCi95High?: number;
        }>();
        for (let i = 0; i < simCI.timeH.length; i++) {
            m.set(simCI.timeH[i], {
                ci95Low: simCI.ci95Low[i],
                ci95High: simCI.ci95High[i],
                ci68Low: simCI.ci68Low[i],
                ci68High: simCI.ci68High[i],
                e2Adj: simCI.e2Adjusted[i],
                cpaAdj: hasPersonalCpaModel ? aaCISeries!.adjusted[i] * aaScale : undefined,
                cpaCi95Low: hasPersonalCpaCI ? aaCISeries!.ci95Low[i] * aaScale : undefined,
                cpaCi95High: hasPersonalCpaCI ? aaCISeries!.ci95High[i] * aaScale : undefined,
            });
        }
        return m;
    }, [simCI, aaCISeries, hasPersonalCpaModel, hasPersonalCpaCI, aaScale]);

    const rawData = useMemo<ChartPoint[]>(() => {
        if (!sim || sim.timeH.length === 0) return [];
        const hasPersonalModelCurve = hasE2Personal;
        const baseShift = (!hasPersonalModelCurve && baselineE2PGmL && baselineE2PGmL > 0)
            ? baselineE2PGmL
            : 0;

        return sim.timeH.map((t, i) => {
            const timeMs = t * 3600000;
            const baseE2 = sim.concPGmL_E2[i] + baseShift;
            const aaSeries = primaryAA ? sim.byCompound?.[primaryAA] : undefined;
            const rawCPA_ngmL = (aaSeries ? aaSeries.values[i] : 0) * aaScale;

            const ciEntry = ciMap?.get(t);
            const ci95Low = ciEntry?.ci95Low;
            const ci95High = ciEntry?.ci95High;
            const ci68Low = ciEntry?.ci68Low;
            const ci68High = ciEntry?.ci68High;
            const concPersonal = ciEntry?.e2Adj;
            const concPersonalCPA = ciEntry?.cpaAdj;
            const cpaCi95Low = ciEntry?.cpaCi95Low;
            const cpaCi95High = ciEntry?.cpaCi95High;
            const ci95Band = (ci95Low !== undefined && ci95High !== undefined)
                ? Math.max(0, ci95High - ci95Low)
                : undefined;
            const ci68Band = (ci68Low !== undefined && ci68High !== undefined)
                ? Math.max(0, ci68High - ci68Low)
                : undefined;
            const cpaCi95Band = (cpaCi95Low !== undefined && cpaCi95High !== undefined)
                ? Math.max(0, cpaCi95High - cpaCi95Low)
                : undefined;

            return {
                time: timeMs,
                concE2: baseE2,
                concCPA: rawCPA_ngmL,
                concPersonal,
                concPersonalCPA,
                ci95Low,
                ci95Band,
                ci95High,
                ci68Low,
                ci68Band,
                ci68High,
                cpaCi95Low,
                cpaCi95Band,
                cpaCi95High,
            };
        });
    }, [sim, ciMap, simCI, baselineE2PGmL, primaryAA, aaScale]);

    const data = useMemo(() => downsampleSeries(rawData, MAX_RENDER_POINTS), [rawData]);

    const labPoints = useMemo(() => {
        if (!labResults || labResults.length === 0) return [];
        return labResults.map(l => ({
            time: l.timeH * 3600000,
            conc: convertToPgMl(l.concValue, l.unit),
            originalValue: l.concValue,
            originalUnit: l.unit,
            isLabResult: true,
            id: l.id
        }));
    }, [labResults]);

    const dosePoints = useMemo(() => {
        if (!sim || !events || events.length === 0) return [];
        return events.filter(e => isE2Family(e.ester)).map(e => {
            const timeMs = e.timeH * 3600000;
            const concE2Raw = interpolateConcentration_E2(sim, e.timeH);
            const hasPersonalModelCurve = hasE2Personal;
            const baseShift = (!hasPersonalModelCurve && baselineE2PGmL && baselineE2PGmL > 0)
                ? baselineE2PGmL
                : 0;
            const concE2 = concE2Raw !== null && !Number.isNaN(concE2Raw)
                ? concE2Raw + baseShift
                : 0;
            return {
                time: timeMs,
                concE2,
                isDoseEvent: true,
                ester: e.ester,
            };
        });
    }, [events, sim, simCI, baselineE2PGmL]);

    const { minTime, maxTime, now } = useMemo(() => {
        const series = rawData.length ? rawData : data;
        const n = new Date().getTime();
        if (series.length === 0) return { minTime: n, maxTime: n, now: n };
        return {
            minTime: series[0].time,
            maxTime: series[series.length - 1].time,
            now: n
        };
    }, [rawData, data]);

    // Y axis domains. When xZoomRange is non-null, we restrict the data scan to
    // the visible time window so the Y axis rescales with zoom — matching the
    // ECharts reference behavior of `min: 'dataMin'`.
    //
    // CI 95% band is INTENTIONALLY excluded from peak calculation: it can extend
    // past the Y axis at peaks (ECharts clips to grid), which gives a tighter,
    // curve-following axis range. The user explicitly chose this trade-off.
    // baselineE2PGmL is a fixed reference line (markLine across full X), so it
    // stays in the calculation regardless of zoom — otherwise zooming past
    // baseline would push it offscreen and the axis lower bound would still
    // reflect it via niceFloor.
    const yDomainLeft = useMemo((): [number, number] => {
        let basePeak = 0;
        let baseMin = Number.POSITIVE_INFINITY;
        let hasBase = false;

        const inRange = (t: number) =>
            !xZoomRange || (t >= xZoomRange[0] && t <= xZoomRange[1]);

        const includeBase = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            hasBase = true;
            if (v > basePeak) basePeak = v;
            if (v < baseMin) baseMin = v;
        };

        for (const d of data) {
            if (!inRange(d.time)) continue;
            includeBase(d.concE2);
            includeBase(d.concPersonal);
        }
        for (const l of labPoints) {
            if (!inRange(l.time)) continue;
            includeBase(l.conc);
        }
        if (!hasE2Personal && baselineE2PGmL && baselineE2PGmL > 0) {
            includeBase(baselineE2PGmL);
        }

        // Fixed padding (10% on each side) so the axis always tracks visible
        // data without niceFloor/niceCeil step jumps that previously clipped
        // troughs or pinned the upper bound to a far-away "nice" value.
        // ECharts auto-picks ticks; even when the bounds aren't round numbers,
        // it produces reasonable 50/100/150-style step labels.
        const minVal = hasBase ? baseMin : 0;
        const padded = basePeak > 0 ? basePeak * 1.1 : E2_AXIS_FALLBACK_MAX;
        const lower = minVal > 0 ? minVal * 0.9 : 0;
        let upper = padded;
        if (upper - lower < 1) upper = lower + 1;
        return [lower, upper];
    }, [data, labPoints, baselineE2PGmL, hasE2Personal, xZoomRange]);

    const yDomainRight = useMemo((): [number, number] => {
        let basePeak = 0;

        const inRange = (t: number) =>
            !xZoomRange || (t >= xZoomRange[0] && t <= xZoomRange[1]);

        const includeBase = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            if (v > basePeak) basePeak = v;
        };

        for (const d of data) {
            if (!inRange(d.time)) continue;
            includeBase(d.concCPA);
            includeBase(d.concPersonalCPA);
        }
        // Match yDomainLeft policy: fixed 10% upper padding instead of
        // niceCeil, so upper tracks the visible data smoothly.
        const padded = basePeak > 0 ? basePeak * 1.1 : CPA_AXIS_FALLBACK_MAX;
        return [0, padded];
    }, [data, xZoomRange]);

    const nowPoint = useMemo(() => {
        if (!sim || data.length === 0) return null;
        const h = now / 3600000;

        const concE2Raw = interpolateConcentration_E2(sim, h);
        const concCPA = primaryAA ? (interpolateCompoundConcentration(sim, primaryAA, h) ?? null) : null;
        const concPersonal = simCI ? interpAt(simCI.timeH, simCI.e2Adjusted, h) : undefined;
        const ci95Low = simCI ? interpAt(simCI.timeH, simCI.ci95Low, h) : undefined;
        const ci95High = simCI ? interpAt(simCI.timeH, simCI.ci95High, h) : undefined;
        const ci68Low = simCI ? interpAt(simCI.timeH, simCI.ci68Low, h) : undefined;
        const ci68High = simCI ? interpAt(simCI.timeH, simCI.ci68High, h) : undefined;
        const concPersonalCPA = (hasPersonalCpaModel && aaCISeries)
            ? interpAt(simCI!.timeH, aaCISeries.adjusted, h) * aaScale
            : undefined;
        const cpaCi95Low = (hasPersonalCpaCI && aaCISeries)
            ? interpAt(simCI!.timeH, aaCISeries.ci95Low, h) * aaScale
            : undefined;
        const cpaCi95High = (hasPersonalCpaCI && aaCISeries)
            ? interpAt(simCI!.timeH, aaCISeries.ci95High, h) * aaScale
            : undefined;

        const hasE2 = concE2Raw !== null && !Number.isNaN(concE2Raw);
        const hasCPA = concCPA !== null && !Number.isNaN(concCPA);

        if (!hasE2 && !hasCPA) return null;

        const baseShift = (!hasE2Personal && baselineE2PGmL && baselineE2PGmL > 0)
            ? baselineE2PGmL
            : 0;
        const concE2 = hasE2 ? (concE2Raw! + baseShift) : 0;

        return {
            time: now,
            concE2,
            concCPA: hasCPA ? concCPA * aaScale : 0,
            concPersonal,
            ci95Low,
            ci95High,
            ci68Low,
            ci68High,
            concPersonalCPA,
            cpaCi95Low,
            cpaCi95High,
        };
    }, [sim, simCI, data, now, hasPersonalCpaModel, hasPersonalCpaCI, baselineE2PGmL, primaryAA, aaCISeries, aaScale]);

    // ============================================================
    // ECharts integration
    // ============================================================

    const chartRef = useRef<HTMLDivElement>(null);
    const chartInstanceRef = useRef<echarts.ECharts | null>(null);
    const [hoverState, setHoverState] = useState<{
        time: number;
        relX: number;
        relY: number;
        dataPoint: ChartPoint;
        isLab: boolean;
        labPoint?: { time: number; conc: number; originalValue: number; originalUnit: string; id: string };
    } | null>(null);
    // Re-render trigger for CSS-var-dependent options (dark mode toggle).
    const [themeTick, setThemeTick] = useState(0);

    const isEmpty = !sim || sim.timeH.length === 0;

    // Init ECharts once on mount, dispose on unmount.
    useEffect(() => {
        if (!chartRef.current) return;
        const instance = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
        chartInstanceRef.current = instance;

        const onResize = () => instance.resize();
        window.addEventListener('resize', onResize);

        // Observe <html> class changes for dark-mode re-render of CSS-var colors.
        const observer = new MutationObserver(() => setThemeTick(t => t + 1));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        // Track current dataZoom range so the X-axis label formatter can switch
        // from "MMM d" to "MMM d HH:mm" when zoomed in to < 2 days visible.
        // ECharts' dataZoom event payload does NOT reliably expose startValue/
        // endValue (we didn't configure them on the dataZoom, and wheel zoom
        // may not write them back). Use the chart's grid rect + convertFromPixel
        // on the grid edges — this works for any zoom source (wheel, button,
        // dispatchAction).
        const onDataZoom = () => {
            const chart = chartInstanceRef.current;
            if (!chart) return;
            const opt = chart.getOption();
            const grid = (opt.grid as any[])?.[0] ?? { left: 60, right: 30, top: 30, bottom: 30 };
            const leftPx = typeof grid.left === 'number' ? grid.left : 60;
            const rightPx = chart.getWidth() - (typeof grid.right === 'number' ? grid.right : 30);
            const startMs = chart.convertFromPixel({ xAxisIndex: 0 }, leftPx);
            const endMs = chart.convertFromPixel({ xAxisIndex: 0 }, rightPx);
            if (typeof startMs === 'number' && typeof endMs === 'number'
                && Number.isFinite(startMs) && Number.isFinite(endMs)) {
                setXZoomRange([startMs, endMs]);
            }
        };
        instance.on('dataZoom', onDataZoom);

        return () => {
            window.removeEventListener('resize', onResize);
            observer.disconnect();
            instance.off('dataZoom', onDataZoom);
            instance.dispose();
            chartInstanceRef.current = null;
        };
    }, []);

    // Resolve CSS-var colors (re-runs on dark-mode toggle).
    const cssColors = useMemo(() => ({
        grid: resolveCssVar('--border-secondary', '#e5e7eb'),
        axisTick: resolveCssVar('--text-tertiary', '#9ca3af'),
        textPrimary: resolveCssVar('--text-primary', '#111827'),
        textSecondary: resolveCssVar('--text-secondary', '#4b5563'),
        textTertiary: resolveCssVar('--text-tertiary', '#9ca3af'),
        bgCard: resolveCssVar('--bg-card', '#ffffff'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [themeTick]);

    // Build the full ECharts option. Memoize on every visual dep.
    const option = useMemo(() => buildChartOption({
        data,
        labPoints,
        dosePoints,
        nowPoint,
        now,
        baselineE2PGmL: baselineE2PGmL ?? null,
        hasPersonalModel: hasE2Personal,
        hasCPADoses,
        hasPersonalCpaModel,
        hasPersonalCpaCI,
        aaPersonalized,
        aaColor,
        aaLabel,
        aaUnit,
        yDomainLeft,
        yDomainRight,
        minTime,
        maxTime,
        cssColors,
        lang,
        xZoomRange,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [data, labPoints, dosePoints, nowPoint, now, baselineE2PGmL, hasE2Personal, hasCPADoses, hasPersonalCpaModel, hasPersonalCpaCI, aaPersonalized, aaColor, aaLabel, aaUnit, yDomainLeft, yDomainRight, minTime, maxTime, cssColors, lang, xZoomRange]);

    // Apply option to chart instance.
    useEffect(() => {
        const chart = chartInstanceRef.current;
        if (!chart) return;
        chart.setOption(option, { notMerge: false, lazyUpdate: true });
    }, [option]);

    // Tooltip positioning is driven by a native React onMouseMove on the chart
    // container (see JSX below), NOT by ECharts' `updateAxisPointer` event.
    // Rationale: params.event.offsetX/Y on `updateAxisPointer` is unreliable
    // (zrender wraps and re-dispatches events), and TouchEvent has no
    // offsetX/Y at all. Reading native MouseEvent.offsetX/Y off the chartRef
    // div directly gives us the cursor pixel coordinates without ambiguity,
    // so the React DOM tooltip tracks the cursor smoothly in both X and Y.
    // ECharts' axisPointer configuration is still in place — it draws the
    // vertical dashed cursor line on its own.
    const updateHover = useCallback((offsetX: number, offsetY: number) => {
        if (isEmpty) {
            setHoverState(null);
            return;
        }
        const chart = chartInstanceRef.current;
        if (!chart) return;
        const time = chart.convertFromPixel({ xAxisIndex: 0 }, offsetX);
        if (typeof time !== 'number' || !Number.isFinite(time)) {
            setHoverState(null);
            return;
        }

        // Check if cursor is over a lab point (within tolerance).
        const LAB_HIT_TOLERANCE_MS = 24 * 3600 * 1000;
        let matchedLab: typeof labPoints[number] | undefined;
        for (const lp of labPoints) {
            if (Math.abs(lp.time - time) < LAB_HIT_TOLERANCE_MS) {
                matchedLab = lp;
                break;
            }
        }

        if (matchedLab) {
            setHoverState({
                time,
                relX: offsetX,
                relY: offsetY,
                dataPoint: { time: matchedLab.time, concE2: matchedLab.conc, isLabResult: true } as ChartPoint,
                isLab: true,
                labPoint: matchedLab,
            });
            return;
        }

        // Find nearest data point in `data` for the tooltip payload.
        const idx = nearestIndex(data, time);
        if (idx < 0) {
            setHoverState(null);
            return;
        }
        const point = data[idx];
        setHoverState({
            time,
            relX: offsetX,
            relY: offsetY,
            dataPoint: point,
            isLab: false,
        });
    }, [data, labPoints, isEmpty]);

    const handleChartMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        updateHover(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    }, [updateHover]);

    const handleChartMouseLeave = useCallback(() => {
        setHoverState(null);
    }, []);

    // Zoom helpers (1M / 1W / reset) — dispatch dataZoom action with start/end timestamps.
    const zoomToDuration = useCallback((days: number) => {
        const chart = chartInstanceRef.current;
        if (!chart || isEmpty) return;
        const duration = days * 24 * 3600 * 1000;
        const center = now;
        const start = Math.max(minTime, center - duration / 2);
        const end = Math.min(maxTime, start + duration);
        const finalStart = Math.max(minTime, end - duration);
        chart.dispatchAction({ type: 'dataZoom', startValue: finalStart, endValue: end });
    }, [now, minTime, maxTime, isEmpty]);

    const hasPersonalModel = hasE2Personal;

    // Compute tooltip placement: prefer right of cursor, flip left if near edge.
    const tooltipPlacement = useMemo(() => {
        if (!hoverState || !chartRef.current) return { left: 0, top: 0, flipX: false };
        const containerWidth = chartRef.current.clientWidth;
        const left = hoverState.relX + 12;
        const flipX = left + 160 > containerWidth;
        return {
            left: flipX ? Math.max(0, hoverState.relX - 12) : left,
            top: Math.max(0, hoverState.relY - 8),
            flipX,
        };
    }, [hoverState]);

    return (
        <div className="glass-card rounded-2xl relative overflow-hidden flex flex-col md:h-80 xl:h-[340px]">
            {/* Header (unchanged from Recharts version) */}
            <div className="flex justify-between items-center px-4 md:px-6 py-3 md:py-4 border-b border-[var(--border-secondary)]">
                <h2 className="text-sm md:text-base font-semibold tracking-tight flex items-center gap-2" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: 'var(--text-primary)' }}>
                    <span className="inline-flex items-center justify-center w-8 h-8 md:w-10 md:h-10 rounded-xl border border-[var(--border-icon-pink)]">
                        <Activity size={16} className="text-[#f6c4d7] md:w-5 md:h-5" />
                    </span>
                    {t('chart.title')}
                    {hasPersonalModel && (
                        <span className="ml-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-rose-50 text-rose-500 border border-rose-100">
                            {t('chart.personal_model')}
                        </span>
                    )}
                </h2>

                <div className="flex items-center gap-2">
                    <div className="flex bg-[var(--bg-secondary)] rounded-xl p-1 gap-1 border border-[var(--border-primary)]">
                        <button
                            onClick={() => zoomToDuration(30)}
                            className="px-3 py-1.5 text-xs md:text-sm font-bold rounded-lg hover:bg-[var(--bg-card)] transition-all" style={{ color: 'var(--text-secondary)' }}>
                            1M
                        </button>
                        <button
                            onClick={() => zoomToDuration(7)}
                            className="px-3 py-1.5 text-xs md:text-sm font-bold rounded-lg hover:bg-[var(--bg-card)] transition-all" style={{ color: 'var(--text-secondary)' }}>
                            1W
                        </button>
                        <div className="w-px h-4 self-center mx-1" style={{ background: 'var(--border-primary)' }}></div>
                        <button
                            onClick={() => { zoomToDuration(7); }}
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-card)] transition-all" style={{ color: 'var(--text-secondary)' }}
                        >
                            <RotateCcw size={14} className="md:w-4 md:h-4" />
                        </button>
                    </div>
                    {onShareImage && (
                        <button
                            onClick={onShareImage}
                            title="Share as Image"
                            aria-label="Share as Image"
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-card-hover)] transition-all"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            <Camera size={16} className="md:w-[18px] md:h-[18px]" />
                        </button>
                    )}
                </div>
            </div>

            {/* Chart container (always rendered to keep ECharts init working) */}
            <div className="relative h-[36vh] min-h-[200px] md:flex-1 md:min-h-0 w-full touch-none px-2 pb-2">
                <div
                    ref={chartRef}
                    className="w-full h-full"
                    onMouseMove={handleChartMouseMove}
                    onMouseLeave={handleChartMouseLeave}
                />

                {/* Empty state overlay */}
                {isEmpty && (
                    <div
                        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        <Activity className="w-12 h-12 mb-4" style={{ color: 'var(--text-tertiary)' }} strokeWidth={1.5} />
                        <p className="text-sm font-medium">{t('timeline.empty')}</p>
                    </div>
                )}

                {/* Hover tooltip overlay (replaces Recharts Tooltip) */}
                {hoverState && !isEmpty && (
                    <div
                        className="absolute pointer-events-none z-10"
                        style={{
                            left: tooltipPlacement.left,
                            top: tooltipPlacement.top,
                            transform: tooltipPlacement.flipX ? 'translateX(-100%)' : undefined,
                        }}
                    >
                        {hoverState.isLab && hoverState.labPoint ? (
                            <CustomTooltip
                                active={true}
                                payload={[{
                                    payload: {
                                        isLabResult: true,
                                        originalValue: hoverState.labPoint.originalValue,
                                        originalUnit: hoverState.labPoint.originalUnit,
                                        conc: hoverState.labPoint.conc,
                                    },
                                }]}
                                label={hoverState.time}
                                t={t}
                                lang={lang}
                                aaLabel={aaLabel}
                                aaUnit={aaUnit}
                                aaColor={aaColor}
                                aaShowPersonal={aaPersonalized}
                            />
                        ) : (
                            <CustomTooltip
                                active={true}
                                payload={[{ payload: hoverState.dataPoint }]}
                                label={hoverState.time}
                                t={t}
                                lang={lang}
                                aaLabel={aaLabel}
                                aaUnit={aaUnit}
                                aaColor={aaColor}
                                aaShowPersonal={aaPersonalized}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ============================================================
// buildChartOption — pure function that turns memo data into
// a full ECharts option object. All visual styling 1:1 with the
// previous Recharts implementation; values come from
// ResultChart.theme.ts (ECHART_THEME).
// ============================================================

interface BuildOptionInput {
    data: ChartPoint[];
    labPoints: { time: number; conc: number; originalValue: number; originalUnit: string; isLabResult: true; id: string }[];
    dosePoints: { time: number; concE2: number; isDoseEvent: true; ester: string }[];
    nowPoint: { time: number; concE2: number; concCPA: number; concPersonal?: number; ci95Low?: number; ci95High?: number; ci68Low?: number; ci68High?: number; concPersonalCPA?: number; cpaCi95Low?: number; cpaCi95High?: number } | null;
    now: number;
    baselineE2PGmL: number | null;
    hasPersonalModel: boolean;
    hasCPADoses: boolean;
    hasPersonalCpaModel: boolean;
    hasPersonalCpaCI: boolean;
    aaPersonalized: boolean;
    aaColor: string;
    aaLabel: string;
    aaUnit: 'ng/mL' | 'ug/mL';
    yDomainLeft: [number, number];
    yDomainRight: [number, number];
    minTime: number;
    maxTime: number;
    cssColors: { grid: string; axisTick: string; textPrimary: string; textSecondary: string; textTertiary: string; bgCard: string };
    lang: string;
    // Current visible X-axis range (timestamp ms). null = full range / not yet known.
    // When range < 2 days, X-axis labels switch from "MMM d" to "MMM d HH:mm".
    xZoomRange: [number, number] | null;
}

function buildChartOption(input: BuildOptionInput): echarts.EChartsCoreOption {
    const {
        data, labPoints, dosePoints, nowPoint, now, baselineE2PGmL,
        hasPersonalModel, hasCPADoses, hasPersonalCpaModel, hasPersonalCpaCI,
        aaPersonalized, aaColor, aaLabel, aaUnit, yDomainLeft, yDomainRight,
        minTime, maxTime, cssColors, lang, xZoomRange,
    } = input;

    const xAxisMin = minTime;
    const xAxisMax = maxTime;
    // Switch X-axis label format based on visible window:
    //   < 2 days  → "MMM d HH:mm" (intra-day precision)
    //   >= 2 days → "MMM d"       (date precision)
    const showTime = !!xZoomRange && (xZoomRange[1] - xZoomRange[0]) < 2 * 24 * 3600 * 1000;
    const dateFormatter = (val: number) => {
        const d = new Date(val);
        return showTime
            ? `${formatDate(d, lang)} ${formatTime(d)}`
            : formatDate(d, lang);
    };

    const series: any[] = [];

    // ----- 95% CI band (E2, left axis) — stacked area -----
    if (hasPersonalModel) {
        series.push({
            name: 'ci95Low',
            type: 'line',
            stack: 'ci95',
            yAxisIndex: 0,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            data: data.map(d => [d.time, d.ci95Low ?? 0]),
        });
        series.push({
            name: 'ci95Band',
            type: 'line',
            stack: 'ci95',
            yAxisIndex: 0,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { color: ECHART_THEME.ci95Fill },
            data: data.map(d => [d.time, d.ci95Band ?? 0]),
        });
        // 68% CI band — slightly darker, rendered above 95%
        series.push({
            name: 'ci68Low',
            type: 'line',
            stack: 'ci68',
            yAxisIndex: 0,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            data: data.map(d => [d.time, d.ci68Low ?? 0]),
        });
        series.push({
            name: 'ci68Band',
            type: 'line',
            stack: 'ci68',
            yAxisIndex: 0,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { color: ECHART_THEME.ci68Fill },
            data: data.map(d => [d.time, d.ci68Band ?? 0]),
        });
    }

    // ----- CPA 95% CI band (right axis, conditional) -----
    if (hasPersonalCpaModel && hasPersonalCpaCI && hasCPADoses) {
        series.push({
            name: 'cpaCi95Low',
            type: 'line',
            stack: 'cpaCi',
            yAxisIndex: 1,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            data: data.map(d => [d.time, d.cpaCi95Low ?? 0]),
        });
        series.push({
            name: 'cpaCi95Band',
            type: 'line',
            stack: 'cpaCi',
            yAxisIndex: 1,
            smooth: true,
            symbol: 'none',
            silent: true,
            animation: false,
            emphasis: { disabled: true },
            lineStyle: { opacity: 0 },
            areaStyle: { color: aaBandFill(aaColor) },
            data: data.map(d => [d.time, d.cpaCi95Band ?? 0]),
        });
    }

    // ----- Main E2 curve (left axis) -----
    series.push({
        name: 'E2',
        type: 'line',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        showSymbol: false,
        sampling: 'lttb',
        data: data.map(d => [d.time, d.concE2 ?? 0]),
        lineStyle: { color: ECHART_THEME.e2Stroke, width: ECHART_THEME.curveStrokeWidth },
        areaStyle: {
            color: {
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                    { offset: 0, color: ECHART_THEME.e2GradientTop },
                    { offset: 1, color: ECHART_THEME.e2GradientBottom },
                ],
            },
        },
        emphasis: {
            focus: 'series',
            itemStyle: { borderColor: ECHART_THEME.e2ActiveDotStroke, borderWidth: 3, color: ECHART_THEME.e2Accent },
        },
    });

    // ----- Main CPA curve (right axis, conditional) -----
    if (hasCPADoses) {
        series.push({
            name: aaLabel,
            type: 'line',
            yAxisIndex: 1,
            smooth: true,
            symbol: 'none',
            showSymbol: false,
            sampling: 'lttb',
            data: data.map(d => [d.time, d.concCPA ?? 0]),
            lineStyle: { color: aaColor, width: ECHART_THEME.curveStrokeWidth },
            areaStyle: {
                color: {
                    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                    colorStops: [
                        { offset: 0, color: aaBandFill(aaColor) },
                        { offset: 1, color: 'rgba(0,0,0,0)' },
                    ],
                },
            },
            emphasis: {
                focus: 'series',
                itemStyle: { borderColor: '#fff', borderWidth: 3, color: aaColor },
            },
        });
    }

    // ----- Personal model E2 curve (dashed) -----
    if (hasPersonalModel) {
        series.push({
            name: 'E2 Personal',
            type: 'line',
            yAxisIndex: 0,
            smooth: true,
            symbol: 'none',
            showSymbol: false,
            sampling: 'lttb',
            data: data.map(d => [d.time, d.concPersonal ?? 0]),
            lineStyle: { color: ECHART_THEME.personalStroke, width: ECHART_THEME.personalStrokeWidth, type: 'dashed' },
            areaStyle: {
                color: {
                    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                    colorStops: [
                        { offset: 0, color: ECHART_THEME.personalGradientTop },
                        { offset: 1, color: ECHART_THEME.personalGradientBottom },
                    ],
                },
            },
            emphasis: {
                focus: 'series',
                itemStyle: { borderColor: ECHART_THEME.personalActiveDotStroke, borderWidth: 2, color: ECHART_THEME.personalStroke },
            },
        });
    }

    // ----- Personal model AA curve (dashed, conditional) -----
    if (hasPersonalCpaModel && hasCPADoses && aaPersonalized) {
        series.push({
            name: `${aaLabel} Personal`,
            type: 'line',
            yAxisIndex: 1,
            smooth: true,
            symbol: 'none',
            showSymbol: false,
            sampling: 'lttb',
            data: data.map(d => [d.time, d.concPersonalCPA ?? 0]),
            lineStyle: { color: aaColor, width: ECHART_THEME.personalStrokeWidth, type: 'dashed' },
            emphasis: {
                focus: 'series',
                itemStyle: { borderColor: '#fff', borderWidth: 2, color: aaColor },
            },
        });
    }

    // ----- "now" marker dots (left + right axes, conditional) -----
    if (nowPoint) {
        if (typeof nowPoint.concE2 === 'number' && Number.isFinite(nowPoint.concE2) && nowPoint.concE2 > 0) {
            series.push({
                name: 'Now (E2)',
                type: 'scatter',
                yAxisIndex: 0,
                symbol: 'circle',
                symbolSize: ECHART_THEME.nowDotSize + 2, // 6 visible + 2 padding
                itemStyle: { color: ECHART_THEME.nowDotFill, borderColor: ECHART_THEME.nowDotStroke, borderWidth: ECHART_THEME.nowDotStrokeWidth },
                silent: true,
                data: [[nowPoint.time, nowPoint.concE2]],
            });
        }
        if (hasCPADoses && typeof nowPoint.concCPA === 'number' && Number.isFinite(nowPoint.concCPA) && nowPoint.concCPA > 0) {
            series.push({
                name: `Now (${aaLabel})`,
                type: 'scatter',
                yAxisIndex: 1,
                symbol: 'circle',
                symbolSize: ECHART_THEME.nowDotSize + 2,
                itemStyle: { color: aaColor, borderColor: ECHART_THEME.nowDotStroke, borderWidth: ECHART_THEME.nowDotStrokeWidth },
                silent: true,
                data: [[nowPoint.time, nowPoint.concCPA]],
            });
        }
    }

    // ----- Lab flask markers (left axis) -----
    if (labPoints.length > 0) {
        series.push({
            name: 'Lab',
            type: 'scatter',
            yAxisIndex: 0,
            symbol: 'circle',
            symbolSize: ECHART_THEME.labSymbolSize,
            symbolOffset: [0, 0],
            itemStyle: {
                color: ECHART_THEME.labFill,
                borderColor: ECHART_THEME.labStroke,
                borderWidth: ECHART_THEME.labStrokeWidth,
            },
            label: {
                show: true,
                position: 'inside',
                formatter: () => '⚗', // placeholder; real flask rendered below via markPoint symbol override
                color: 'transparent',
            },
            data: labPoints.map(lp => ({
                value: [lp.time, lp.conc],
                originalValue: lp.originalValue,
                originalUnit: lp.originalUnit,
                isLabResult: true,
                id: lp.id,
            })),
            z: 5,
        });
    }

    // ----- Dose event markers (left axis, E2-family only) -----
    if (dosePoints.length > 0) {
        series.push({
            name: 'Dose',
            type: 'scatter',
            yAxisIndex: 0,
            symbol: 'circle',
            symbolSize: 7, // 3px radius + 1.5px stroke x2 ≈ 7px overall
            itemStyle: {
                color: '#ec4899',
                borderColor: '#fff',
                borderWidth: 1.5,
            },
            data: dosePoints.map(dp => ({
                value: [dp.time, dp.concE2],
                ester: dp.ester,
            })),
            z: 4,
        });
    }

    // ----- "now" vertical line + baseline reference line + flask overlays -----
    // Use a hidden "ref" series to anchor markLine + markPoint for flask icons.
    const refSeries: any[] = [];
    refSeries.push({
        name: '__refs',
        type: 'line',
        yAxisIndex: 0,
        data: [],
        silent: true,
        animation: false,
        showInLegend: false,
        markLine: {
            symbol: 'none',
            silent: true,
            animation: false,
            label: { show: false },
            data: [
                {
                    xAxis: now,
                    lineStyle: {
                        color: ECHART_THEME.nowLineStroke,
                        type: 'dashed',
                        width: ECHART_THEME.nowLineWidth,
                    },
                },
                ...(hasPersonalModel || !baselineE2PGmL || baselineE2PGmL <= 0 ? [] : [{
                    yAxis: baselineE2PGmL,
                    lineStyle: {
                        color: ECHART_THEME.baselineStroke,
                        type: 'dashed',
                        width: ECHART_THEME.baselineWidth,
                    },
                    label: {
                        show: true,
                        position: 'insideStartTop',
                        formatter: `Endogenous ${baselineE2PGmL.toFixed(1)}`,
                        color: ECHART_THEME.baselineStroke,
                        fontSize: ECHART_THEME.baselineLabelFontSize,
                        fontWeight: ECHART_THEME.baselineLabelFontWeight,
                        backgroundColor: 'transparent',
                    },
                }]),
            ],
        },
        markPoint: labPoints.length > 0 ? {
            symbol: LAB_FLASK_PATH,
            symbolSize: ECHART_THEME.labSymbolSize,
            symbolOffset: [0, 0],
            itemStyle: {
                color: ECHART_THEME.labFill,
                borderColor: ECHART_THEME.labStroke,
                borderWidth: ECHART_THEME.labStrokeWidth,
            },
            label: { show: false },
            data: labPoints.map(lp => ({
                coord: [lp.time, lp.conc],
                value: '',
            })),
            silent: true,
            animation: false,
            z: 6,
        } : undefined,
    });
    series.push(...refSeries);

    // ----- Build Y axes -----
    // `axisPointer: { show: false }` on each yAxis disables the per-axis pointer line,
    // so axisPointer at the top level only renders the X-axis (vertical) cursor.
    // Without this, ECharts draws a horizontal dashed pointer line for EACH y-axis
    // (left E2 + right AA) — 2 extra horizontal lines that the Recharts version did
    // not have. Top-level `yAxisIndex: null` does NOT reliably suppress these.
    const yAxisLeft: any = {
        type: 'value',
        name: 'E2 (pg/mL)',
        nameLocation: 'middle',
        nameGap: 40,
        nameRotate: 90,
        nameTextStyle: { color: ECHART_THEME.e2Accent, fontSize: ECHART_THEME.axisLabelFontSize, fontWeight: ECHART_THEME.axisLabelFontWeight },
        min: yDomainLeft[0],
        max: yDomainLeft[1],
        position: 'left',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
            color: ECHART_THEME.e2Accent,
            fontSize: ECHART_THEME.axisTickFontSize,
            fontWeight: ECHART_THEME.axisTickFontWeight,
            formatter: formatAxisTickForECharts,
        },
        splitLine: { show: false },
        axisPointer: { show: false },
    };

    const yAxisRight: any = {
        type: 'value',
        name: `${aaLabel} (${aaUnit})`,
        nameLocation: 'middle',
        nameGap: 40,
        nameRotate: 90,
        nameTextStyle: { color: aaColor, fontSize: ECHART_THEME.axisLabelFontSize, fontWeight: ECHART_THEME.axisLabelFontWeight },
        min: hasCPADoses ? yDomainRight[0] : 0,
        max: hasCPADoses ? yDomainRight[1] : 1,
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: hasCPADoses ? {
            color: aaColor,
            fontSize: ECHART_THEME.axisTickFontSize,
            fontWeight: ECHART_THEME.axisTickFontWeight,
            formatter: formatAxisTickForECharts,
        } : { show: false },
        splitLine: { show: false },
        axisPointer: { show: false },
    };

    return {
        renderer: ECHART_THEME.renderer,
        animation: true,
        animationDuration: ECHART_THEME.animationDuration,
        animationEasing: ECHART_THEME.animationEasing,
        animationDurationUpdate: ECHART_THEME.animationDurationUpdate,
        animationEasingUpdate: ECHART_THEME.animationEasingUpdate,
        // disable hover animation for cleaner experience
        animationDelay: 0,

        grid: {
            left: 60,
            right: hasCPADoses ? 60 : 30,
            top: 30,
            bottom: 30,
            containLabel: false,
        },

        // We render our own React DOM tooltip; turn off the built-in one.
        tooltip: { show: false },

        xAxis: {
            type: 'time',
            min: xAxisMin,
            max: xAxisMax,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
                color: cssColors.axisTick,
                fontSize: ECHART_THEME.axisTickFontSize,
                fontWeight: ECHART_THEME.axisTickFontWeight,
                formatter: dateFormatter,
                hideOverlap: true,
            },
            splitLine: { show: false },
        },

        yAxis: [yAxisLeft, yAxisRight],

        // dataZoom 'inside' = wheel zoom + drag pan + pinch zoom all in one.
        // Two instances per axis so each axis can have its own config;
        // y-axis ones are disabled to keep auto-scaling behavior.
        dataZoom: [
            {
                type: 'inside',
                xAxisIndex: 0,
                zoomOnMouseWheel: true,
                moveOnMouseMove: true,
                moveOnMouseWheel: false,
                preventDefaultMouseMove: true,
                minValueSpan: 24 * 3600 * 1000,
            },
            { type: 'inside', yAxisIndex: 0, disabled: true },
            ...(hasCPADoses ? [{ type: 'inside', yAxisIndex: 1, disabled: true }] : []),
        ],

        // axisPointer replaces Recharts Tooltip cursor + custom touch overlay.
        // Per-axis `axisPointer: { show: false }` (set on each yAxis below) disables the
        // Y-axis pointer lines; the top-level config here only renders the X-axis vertical
        // cursor. Setting `yAxisIndex: null` on the top-level does NOT actually disable
        // Y-axis pointer in ECharts — the per-axis show:false is the only reliable way.
        axisPointer: {
            show: true,
            trigger: 'mousemove|click|touch',
            // snap: false → cursor line 平滑贴紧鼠标像素位置(与 ECharts 参考代码一致)。
            // 默认 true 会让 cursor 跳到最近 data point,体感"跟不上手"。
            snap: false,
            xAxisIndex: 0,
            label: { show: false },
            handle: { show: false },
            lineStyle: {
                color: ECHART_THEME.cursorStroke,
                type: 'dashed',
                width: ECHART_THEME.cursorWidth,
            },
        },

        series,
    };
}

function formatAxisTickForECharts(raw: number | string): string {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n >= 100) return `${Math.round(n)}`;
    if (n >= 10) return `${Math.round(n)}`;
    if (n >= 1) return n.toFixed(1);
    return n.toFixed(2);
}

export default ResultChart;