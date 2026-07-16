import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { formatDate, formatTime } from '../utils/helpers';
import { SimulationResult, DoseEvent, interpolateConcentration_E2, interpolateCompoundConcentration, isAntiandrogen, isE2Family, pickPrimaryAntiandrogen, ANTIANDROGENS, Ester, LabResult, convertToPgMl } from '../../logic';
import { Activity, RotateCcw, Info, FlaskConical, Camera } from 'lucide-react';
import {
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot, Area, ComposedChart, Scatter
} from 'recharts';
import {
    clampDomain as clampDomainUtil,
    panDomain,
    zoomDomainAt,
    hitTestCurves,
    nearestPoint,
    pixelXAtTime,
    timeAtPixel,
    type CurveSeries,
    type CurvePoint,
    type PlotRect,
} from '../utils/chartGesture';

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

    // Keep up to two representative points (min/max) per bucket.
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

const CustomTooltip = ({ active, payload, label, t, lang, aaLabel = 'CPA', aaUnit = 'ng/mL', aaColor = '#8b5cf6', aaShowPersonal = true }: any) => {
    if (active && payload && payload.length) {
        // If it's a lab result point
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
                {/* Population CI for non-personalized compounds (BICA): no "personal" label. */}
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

const ResultChart = ({ sim, events, labResults = [], simCI, baselineE2PGmL, nowH, onPointClick, onShareImage }: {
    sim: SimulationResult | null;
    events: DoseEvent[];
    labResults?: LabResult[];
    simCI?: SimCI | null;
    baselineE2PGmL?: number | null;
    nowH?: number;
    onPointClick: (e: DoseEvent) => void;
    onShareImage?: () => void;
}) => {
    // The single anti-androgen plotted on the right axis = the most recently
    // dosed one (CPA and BICA are alternatives with ~1000× different scales).
    // `nowH` is passed reactively so the choice updates as planned doses cross
    // the current time; falls back to render-time clock if not provided.
    const primaryAA = useMemo<Ester | null>(
        () => pickPrimaryAntiandrogen(events, nowH ?? Date.now() / 3600000),
        [events, nowH]
    );
    const aaSpec = primaryAA ? ANTIANDROGENS[primaryAA]! : null;
    const hasCPADoses = !!primaryAA; // "has anti-androgen on right axis"
    // Display unit + scale: native is ng/mL; bicalutamide (large) shows as µg/mL.
    const aaUnit: 'ng/mL' | 'ug/mL' = primaryAA === Ester.BICA ? 'ug/mL' : 'ng/mL';
    const aaScale = aaUnit === 'ug/mL' ? 1 / 1000 : 1;
    const aaColor = aaSpec?.color ?? '#8b5cf6';
    const aaLabel = primaryAA ?? 'CPA';
    // Only compounds that inherit E2 adherence (CPA) get an individualized
    // "personal" curve/label. BICA is population-only, so it shows its raw curve
    // plus a population CI band, never a "personal model" dashed line.
    const aaPersonalized = !!aaSpec?.adherenceFromE2;
    // "E2 personal model active" = a real post-dose calibration exists. This is
    // distinct from `!!simCI`: simCI may be present purely to carry the
    // anti-androgen population CI (E2 arrays empty) when there are no E2 labs.
    const hasE2Personal = !!simCI && simCI.e2Adjusted.length > 0;
    const { t, lang } = useTranslation();
    const [xDomain, setXDomain] = useState<[number, number] | null>(null);
    const initializedRef = useRef(false);
    const pendingDomainRef = useRef<[number, number] | null>(null);
    const rafUpdateRef = useRef<number | null>(null);
    const chartContainerRef = useRef<HTMLDivElement | null>(null);
    const dragStateRef = useRef<{ startX: number; plotRect: PlotRect } | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    // Touch gesture state machine: idle → {pan | inspect} → pinch → idle.
    const touchStateRef = useRef<{
        mode: 'idle' | 'pan' | 'inspect' | 'pinch';
        panLastX?: number;
        inspectLastX?: number;
        inspectLastY?: number;
        inspectLastTime?: number;
        pinchInitialDistance?: number;
        pinchInitialDomain?: [number, number];
        pinchAnchorTime?: number;
    }>({ mode: 'idle' });
    const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const [touchOverlay, setTouchOverlay] = useState<{
        time: number;
        touchX: number;
        touchY: number;
    } | null>(null);
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

    const formatAxisTick = (raw: any): string => {
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

    // Build CI lookup map for fast time-based access
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
        // Apply endogenous baseline offset to the raw E2 curve when no personal
        // model is active (i.e. no post-dose lab results processed yet). This
        // makes the chart visually consistent with the "drug + endogenous" value
        // shown in the headline card.
        const hasPersonalModelCurve = hasE2Personal;
        const baseShift = (!hasPersonalModelCurve && baselineE2PGmL && baselineE2PGmL > 0)
            ? baselineE2PGmL
            : 0;

        return sim.timeH.map((t, i) => {
            const timeMs = t * 3600000;
            // E2: raw simulation (no calibrationFn; personal model curve shows the calibrated view)
            const baseE2 = sim.concPGmL_E2[i] + baseShift; // pg/mL (+ endogenous if no personal model)
            const aaSeries = primaryAA ? sim.byCompound?.[primaryAA] : undefined;
            const rawCPA_ngmL = (aaSeries ? aaSeries.values[i] : 0) * aaScale; // display unit

            // Personal model CI data (from OU-Kalman calibration)
            const ciEntry = ciMap?.get(t);
            const ci95Low = ciEntry?.ci95Low;
            const ci95High = ciEntry?.ci95High;
            const ci68Low = ciEntry?.ci68Low;
            const ci68High = ciEntry?.ci68High;
            const concPersonal = ciEntry?.e2Adj;
            const concPersonalCPA = ciEntry?.cpaAdj;
            const cpaCi95Low = ciEntry?.cpaCi95Low;
            const cpaCi95High = ciEntry?.cpaCi95High;
            // ci95Band = ci95High - ci95Low for stacked Area rendering
            const ci95Band = (ci95Low !== undefined && ci95High !== undefined)
                ? Math.max(0, ci95High - ci95Low)
                : undefined;
            // ci68Band = ci68High - ci68Low (inner, tighter band)
            const ci68Band = (ci68Low !== undefined && ci68High !== undefined)
                ? Math.max(0, ci68High - ci68Low)
                : undefined;
            const cpaCi95Band = (cpaCi95Low !== undefined && cpaCi95High !== undefined)
                ? Math.max(0, cpaCi95High - cpaCi95Low)
                : undefined;

            return {
                time: timeMs,
                concE2: baseE2,          // pg/mL, raw (reference curve)
                concCPA: rawCPA_ngmL,    // ng/mL, raw (reference curve)
                concPersonal,            // personal model E2 (pg/mL)
                concPersonalCPA,         // personal model CPA (ng/mL)
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

    // Build dose event scatter points for marking on the chart
    const dosePoints = useMemo(() => {
        if (!sim || !events || events.length === 0) return [];
        // Only E2-family doses are plotted on the E2 concentration curve.
        // Anti-androgens (CPA / BICA) carry their own byCompound track and a
        // dedicated primaryAA series; plotting them as pink E2 dots would
        // mislead. PROG has no validated E2 mapping — it must not be drawn
        // here at all.
        return events.filter(e => isE2Family(e.ester)).map(e => {
            const timeMs = e.timeH * 3600000;
            // Interpolate E2 at dose time for y-position
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

    // Compute left-axis Y domain from visible E2-related series in current viewport.
    // CI is included but bounded relative to the base curve, to avoid squeezing curves to the floor.
    const yDomainLeft = useMemo((): [number, number | string] => {
        const visibleMin = xDomain ? xDomain[0] : minTime;
        const visibleMax = xDomain ? xDomain[1] : maxTime;
        // Use downsampled data during interactive sliding to reduce per-frame cost.
        const source = data;
        let basePeak = 0;
        let baseMin = Number.POSITIVE_INFINITY;
        let ciPeakRaw = 0;
        let hasBase = false;

        const includeBase = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            hasBase = true;
            if (v > basePeak) basePeak = v;
            if (v < baseMin) baseMin = v;
        };

        const includeCi = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            if (v > ciPeakRaw) ciPeakRaw = v;
        };

        for (const d of source) {
            if (d.time < visibleMin || d.time > visibleMax) continue;
            includeBase(d.concE2);
            includeBase(d.concPersonal);
            includeCi(d.ci95High);
        }
        for (const l of labPoints) {
            if (l.time >= visibleMin && l.time <= visibleMax) includeBase(l.conc);
        }
        // Ensure the endogenous baseline reference line is always within the axis range.
        if (!hasE2Personal && baselineE2PGmL && baselineE2PGmL > 0) {
            includeBase(baselineE2PGmL);
        }

        const minVal = hasBase ? baseMin : 0;
        const ciCap = basePeak > 0 ? Math.max(basePeak * 1.5, basePeak + 20) : E2_AXIS_FALLBACK_MAX;
        const ciPeak = Math.min(ciPeakRaw, ciCap);
        const peak = Math.max(basePeak, ciPeak, E2_AXIS_FALLBACK_MAX);
        const padded = Math.max(E2_AXIS_FALLBACK_MAX, peak * 1.12); // 12% headroom
        const lower = minVal > 0 ? niceFloor(minVal * 0.85, 0) : 0;
        let upper = niceCeil(padded, E2_AXIS_FALLBACK_MAX);
        if (upper - lower < 1) upper = lower + 1;
        return [lower, upper];
    }, [data, labPoints, xDomain, minTime, maxTime, simCI, baselineE2PGmL]);

    // Compute right-axis Y domain from visible CPA-related series in current viewport.
    const yDomainRight = useMemo((): [number, number | string] => {
        const visibleMin = xDomain ? xDomain[0] : minTime;
        const visibleMax = xDomain ? xDomain[1] : maxTime;
        const source = data;
        let basePeak = 0;
        let ciPeakRaw = 0;

        const includeBase = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            if (v > basePeak) basePeak = v;
        };

        const includeCi = (v: number | undefined) => {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
            if (v > ciPeakRaw) ciPeakRaw = v;
        };

        for (const d of source) {
            if (d.time < visibleMin || d.time > visibleMax) continue;
            includeBase(d.concCPA);
            includeBase(d.concPersonalCPA);
            includeCi(d.cpaCi95High);
        }
        const ciCap = basePeak > 0 ? Math.max(basePeak * 1.5, basePeak + 0.2) : CPA_AXIS_FALLBACK_MAX;
        const ciPeak = Math.min(ciPeakRaw, ciCap);
        const peak = Math.max(basePeak, ciPeak, CPA_AXIS_FALLBACK_MAX);
        const padded = Math.max(CPA_AXIS_FALLBACK_MAX, peak * 1.12); // 12% headroom
        return [0, niceCeil(padded, CPA_AXIS_FALLBACK_MAX)];
    }, [data, xDomain, minTime, maxTime]);

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

        // Apply the same baseline shift used in rawData so the "now" dot is
        // consistent with the underlying curve.
        const baseShift = (!hasE2Personal && baselineE2PGmL && baselineE2PGmL > 0)
            ? baselineE2PGmL
            : 0;
        const concE2 = hasE2 ? (concE2Raw! + baseShift) : 0;

        return {
            time: now,
            concE2,                            // pg/mL, raw (+ endogenous offset if needed)
            concCPA: hasCPA ? concCPA * aaScale : 0,     // display unit (ng/mL or µg/mL)
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

    // Slider helpers for quick panning (helps mobile users)
    // Initialize view: center on "now" with a reasonable window (e.g. 14 days)
    useEffect(() => {
        if (!initializedRef.current && data.length > 0) {
            const initialWindow = 7 * 24 * 3600 * 1000; // 1 week
            const start = Math.max(minTime, now - initialWindow / 2);
            const end = Math.min(maxTime, start + initialWindow);

            // Adjust if end is clamped
            const finalStart = Math.max(minTime, end - initialWindow);

            setXDomain([finalStart, end]);
            initializedRef.current = true;
        }
    }, [data, minTime, maxTime, now]);

    const clampDomain = useCallback((domain: [number, number]): [number, number] => {
        return clampDomainUtil(domain, {
            minTime,
            maxTime,
            minZoom: 24 * 3600 * 1000, // 1 day
        });
    }, [minTime, maxTime]);

    const commitDomain = useCallback((next: [number, number]) => {
        setXDomain(prev => {
            if (prev && prev[0] === next[0] && prev[1] === next[1]) return prev;
            return next;
        });
    }, []);

    const scheduleDomainUpdate = useCallback((next: [number, number]) => {
        pendingDomainRef.current = next;
        if (rafUpdateRef.current !== null) return;
        rafUpdateRef.current = window.requestAnimationFrame(() => {
            rafUpdateRef.current = null;
            const pending = pendingDomainRef.current;
            pendingDomainRef.current = null;
            if (!pending) return;
            commitDomain(pending);
        });
    }, [commitDomain]);

    useEffect(() => {
        return () => {
            if (rafUpdateRef.current !== null) {
                window.cancelAnimationFrame(rafUpdateRef.current);
                rafUpdateRef.current = null;
            }
        };
    }, []);

    // Shared bounds for chart-gesture utilities (pan, zoom, hit-test).
    const domainBounds = useMemo(() => ({
        minTime,
        maxTime,
        minZoom: 24 * 3600 * 1000, // 1 day
    }), [minTime, maxTime]);

    // Resolve the actual plotting rectangle from the rendered Recharts SVG.
    // Using the cartesian grid's bounding box avoids hand-estimated axis widths.
    const getPlotRect = useCallback((): PlotRect | null => {
        const container = chartContainerRef.current;
        if (!container) return null;
        const grid = container.querySelector('.recharts-cartesian-grid');
        const rect = (grid as SVGGraphicsElement | null)?.getBoundingClientRect?.();
        const containerRect = container.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
            return {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            };
        }
        // Fallback when grid isn't laid out yet (first render / no data).
        return {
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height,
        };
    }, []);

    // Visible curves for hit-testing (E2 left axis, CPA right axis when present).
    const curveSeries = useMemo<CurveSeries[]>(() => {
        const yLeft = yDomainLeft;
        const yRight = yDomainRight;
        const series: CurveSeries[] = [];
        if (typeof yLeft[0] === 'number' && typeof yLeft[1] === 'number') {
            const yd: [number, number] = [yLeft[0] as number, yLeft[1] as number];
            const e2Pts = data
                .filter((p) => typeof p.concE2 === 'number' && Number.isFinite(p.concE2))
                .map((p) => ({ time: p.time, value: p.concE2 as number }));
            if (e2Pts.length > 0) series.push({ points: e2Pts, yDomain: yd });
            if (hasE2Personal) {
                const personalPts = data
                    .filter((p) => typeof p.concPersonal === 'number' && Number.isFinite(p.concPersonal))
                    .map((p) => ({ time: p.time, value: p.concPersonal as number }));
                if (personalPts.length > 0) series.push({ points: personalPts, yDomain: yd });
            }
        }
        if (hasCPADoses && typeof yRight[0] === 'number' && typeof yRight[1] === 'number') {
            const yd: [number, number] = [yRight[0] as number, yRight[1] as number];
            const cpaPts = data
                .filter((p) => typeof p.concCPA === 'number' && Number.isFinite(p.concCPA))
                .map((p) => ({ time: p.time, value: p.concCPA as number }));
            if (cpaPts.length > 0) series.push({ points: cpaPts, yDomain: yd });
            if (hasPersonalCpaModel && aaPersonalized) {
                const personalCpaPts = data
                    .filter((p) => typeof p.concPersonalCPA === 'number' && Number.isFinite(p.concPersonalCPA))
                    .map((p) => ({ time: p.time, value: p.concPersonalCPA as number }));
                if (personalCpaPts.length > 0) series.push({ points: personalCpaPts, yDomain: yd });
            }
        }
        return series;
    }, [data, yDomainLeft, yDomainRight, hasE2Personal, hasCPADoses, hasPersonalCpaModel, aaPersonalized]);

    // Mouse wheel — anchored zoom around cursor time.
    const handleWheel = useCallback((e: WheelEvent) => {
        if (!xDomain) return;
        // Don't hijack ctrl/cmd + wheel (browser zoom).
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        const plotRect = getPlotRect();
        if (!plotRect || plotRect.width <= 0) return;
        const anchorTime = timeAtPixel(e.clientX, plotRect, xDomain);
        // Wheel up (negative deltaY) zooms in (smaller domain), wheel down zooms out.
        const zoomFactor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
        scheduleDomainUpdate(zoomDomainAt(xDomain, anchorTime, zoomFactor, domainBounds));
    }, [xDomain, domainBounds, getPlotRect, scheduleDomainUpdate]);

    // Bind wheel listener natively so we can use passive: false and preventDefault.
    useEffect(() => {
        const node = chartContainerRef.current;
        if (!node) return;
        node.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            node.removeEventListener('wheel', handleWheel);
        };
    }, [handleWheel]);

    // Mouse drag — pan when the cursor starts on blank space, leave hover-tooltip
    // intact when it starts on (or very near) a visible curve.
    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!xDomain || e.button !== 0) return;
        const plotRect = getPlotRect();
        if (!plotRect || plotRect.width <= 0) return;
        // If the press lands on a curve, defer to the Recharts hover tooltip.
        const hit = hitTestCurves(e.clientX, e.clientY, plotRect, xDomain, curveSeries, 16);
        if (hit) return;
        dragStateRef.current = { startX: e.clientX, plotRect };
        setIsDragging(true);
        e.preventDefault();
    }, [xDomain, curveSeries, getPlotRect]);

    useEffect(() => {
        if (!isDragging) return;
        const onMove = (e: MouseEvent) => {
            const state = dragStateRef.current;
            if (!state || !xDomain) return;
            const dx = e.clientX - state.startX;
            state.startX = e.clientX;
            scheduleDomainUpdate(panDomain(xDomain, dx, state.plotRect.width, domainBounds));
        };
        const onUp = () => {
            setIsDragging(false);
            dragStateRef.current = null;
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [isDragging, xDomain, domainBounds, scheduleDomainUpdate]);

    // -------- Touch gestures --------
    // Single-finger on a curve → inspect (vertical line + tooltip that follows).
    // Single-finger on blank → pan.
    // Two fingers → pinch zoom anchored at the midpoint time. After the second
    // finger lifts we deliberately do NOT reinterpret the remaining finger as a
    // pan/inspect gesture; the user must lift all fingers and start over.
    const TOUCH_TOLERANCE_PX = 24;

    const updateTouchesFromList = (list: TouchList, remove: boolean) => {
        for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (remove) {
                activeTouchesRef.current.delete(t.identifier);
            } else {
                activeTouchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
        }
    };

    const handleTouchStart = useCallback((e: TouchEvent) => {
        updateTouchesFromList(e.changedTouches, false);
        e.preventDefault();
        const touches = [...activeTouchesRef.current.values()];
        const plotRect = getPlotRect();
        if (!plotRect || touches.length === 0 || !xDomain) return;

        if (touches.length === 1) {
            const t0 = touches[0];
            const hit = hitTestCurves(t0.x, t0.y, plotRect, xDomain, curveSeries, TOUCH_TOLERANCE_PX);
            if (hit) {
                touchStateRef.current = {
                    mode: 'inspect',
                    inspectLastX: t0.x,
                    inspectLastY: t0.y,
                    inspectLastTime: hit.time,
                };
                setTouchOverlay({ time: hit.time, touchX: t0.x, touchY: t0.y });
            } else {
                touchStateRef.current = {
                    mode: 'pan',
                    panLastX: t0.x,
                };
                setTouchOverlay(null);
            }
        } else if (touches.length >= 2) {
            // Second finger arrived — switch to pinch and drop any inspect overlay.
            const [p0, p1] = touches;
            const distance = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            if (distance <= 0 || !xDomain) return;
            const midX = (p0.x + p1.x) / 2;
            const anchorTime = timeAtPixel(midX, plotRect, xDomain);
            touchStateRef.current = {
                mode: 'pinch',
                pinchInitialDistance: distance,
                pinchInitialDomain: [xDomain[0], xDomain[1]],
                pinchAnchorTime: anchorTime,
            };
            setTouchOverlay(null);
        }
    }, [xDomain, curveSeries, domainBounds, getPlotRect]);

    const handleTouchMove = useCallback((e: TouchEvent) => {
        // Sync the moved fingers' current positions back into the active set so
        // pinch distance / pan delta stay accurate.
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const existing = activeTouchesRef.current.get(t.identifier);
            if (existing) {
                existing.x = t.clientX;
                existing.y = t.clientY;
            }
        }
        e.preventDefault();
        const state = touchStateRef.current;
        const touches = [...activeTouchesRef.current.values()];
        const plotRect = getPlotRect();
        if (!plotRect || touches.length === 0) return;

        if (state.mode === 'inspect' && touches.length === 1 && xDomain) {
            const t0 = touches[0];
            const hit = hitTestCurves(t0.x, t0.y, plotRect, xDomain, curveSeries, TOUCH_TOLERANCE_PX);
            if (hit) {
                touchStateRef.current.inspectLastTime = hit.time;
                touchStateRef.current.inspectLastX = t0.x;
                touchStateRef.current.inspectLastY = t0.y;
                setTouchOverlay({ time: hit.time, touchX: t0.x, touchY: t0.y });
            }
        } else if (state.mode === 'pan' && touches.length === 1 && state.panLastX != null && xDomain) {
            const t0 = touches[0];
            const dx = t0.x - state.panLastX;
            state.panLastX = t0.x;
            scheduleDomainUpdate(panDomain(xDomain, dx, plotRect.width, domainBounds));
        } else if (state.mode === 'pinch' && touches.length >= 2) {
            const [p0, p1] = touches;
            const distance = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            if (
                distance <= 0
                || !state.pinchInitialDistance
                || !state.pinchInitialDomain
                || state.pinchAnchorTime == null
            ) return;
            const factor = distance / state.pinchInitialDistance;
            const next = zoomDomainAt(state.pinchInitialDomain, state.pinchAnchorTime, factor, domainBounds);
            scheduleDomainUpdate(next);
            // Make pinch continuous: treat each frame as the new baseline so the
            // chart follows the fingers smoothly instead of snapping back.
            state.pinchInitialDistance = distance;
            state.pinchInitialDomain = next;
            const midX = (p0.x + p1.x) / 2;
            state.pinchAnchorTime = timeAtPixel(midX, plotRect, next);
        }
    }, [xDomain, curveSeries, domainBounds, getPlotRect, scheduleDomainUpdate]);

    const handleTouchEnd = useCallback((e: TouchEvent) => {
        updateTouchesFromList(e.changedTouches, true);
        const state = touchStateRef.current;
        const remaining = activeTouchesRef.current.size;

        if (state.mode === 'pinch') {
            // Per design: do NOT reinterpret the remaining finger. Stay frozen in
            // pinch (effectively no-op) until every finger lifts, then go idle.
            if (remaining === 0) {
                touchStateRef.current = { mode: 'idle' };
            }
        } else if (state.mode === 'inspect') {
            // Keep the last overlay on screen so the user can still read it after
            // releasing. Only new touches / explicit clear will dismiss it.
            touchStateRef.current = { mode: 'idle' };
        } else if (state.mode === 'pan') {
            touchStateRef.current = { mode: 'idle' };
            setTouchOverlay(null);
        }
    }, []);

    const handleTouchCancel = useCallback(() => {
        activeTouchesRef.current.clear();
        touchStateRef.current = { mode: 'idle' };
        setTouchOverlay(null);
    }, []);

    // Bind touch listeners natively so we can use passive: false and preventDefault.
    useEffect(() => {
        const node = chartContainerRef.current;
        if (!node) return;
        const opts = { passive: false } as const;
        node.addEventListener('touchstart', handleTouchStart, opts);
        node.addEventListener('touchmove', handleTouchMove, opts);
        node.addEventListener('touchend', handleTouchEnd, opts);
        node.addEventListener('touchcancel', handleTouchCancel, opts);
        return () => {
            node.removeEventListener('touchstart', handleTouchStart);
            node.removeEventListener('touchmove', handleTouchMove);
            node.removeEventListener('touchend', handleTouchEnd);
            node.removeEventListener('touchcancel', handleTouchCancel);
        };
    }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel]);

    const zoomToDuration = (days: number) => {
        const duration = days * 24 * 3600 * 1000;
        const currentCenter = xDomain ? (xDomain[0] + xDomain[1]) / 2 : now;
        const targetCenter = (now >= minTime && now <= maxTime) ? now : currentCenter;

        const start = targetCenter - duration / 2;
        const end = targetCenter + duration / 2;
        commitDomain(clampDomain([start, end]));
    };

    if (!sim || sim.timeH.length === 0) return (
        <div className="h-72 md:h-96 flex flex-col items-center justify-center glass-card rounded-2xl p-8" style={{ color: 'var(--text-tertiary)' }}>
            <Activity className="w-12 h-12 mb-4" style={{ color: 'var(--text-tertiary)' }} strokeWidth={1.5} />
            <p className="text-sm font-medium">{t('timeline.empty')}</p>
        </div>
    );

    const hasPersonalModel = hasE2Personal;

    // Geometry for the touch overlay: vertical line + tooltip box anchored to
    // the curve time (not the finger x). Recomputed on xDomain / touch change.
    const touchOverlayGeom = useMemo(() => {
        if (!touchOverlay) return null;
        const containerRect = chartContainerRef.current?.getBoundingClientRect();
        if (!containerRect) return null;
        const grid = chartContainerRef.current?.querySelector('.recharts-cartesian-grid') as SVGGraphicsElement | null;
        const gridRect = grid?.getBoundingClientRect?.();
        const plotRect: PlotRect = gridRect && gridRect.width > 0 && gridRect.height > 0
            ? { left: gridRect.left, top: gridRect.top, width: gridRect.width, height: gridRect.height }
            : { left: containerRect.left, top: containerRect.top, width: containerRect.width, height: containerRect.height };
        const visibleDomain: [number, number] = xDomain ?? [plotRect.left, plotRect.left + plotRect.width];
        const lineX = pixelXAtTime(touchOverlay.time, plotRect, visibleDomain) - containerRect.left;
        return {
            time: touchOverlay.time,
            relTouchX: touchOverlay.touchX - containerRect.left,
            relTouchY: touchOverlay.touchY - containerRect.top,
            lineX,
            lineTop: plotRect.top - containerRect.top,
            lineHeight: plotRect.height,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [touchOverlay, xDomain]);

    // Chart data point nearest to the overlay time (used for the tooltip payload).
    const touchOverlayDataPoint = useMemo(() => {
        if (!touchOverlayGeom || data.length === 0) return null;
        const target = touchOverlayGeom.time;
        let low = 0;
        let high = data.length - 1;
        while (high - low > 1) {
            const mid = (low + high) >> 1;
            if (data[mid].time <= target) low = mid;
            else high = mid;
        }
        const lowDist = Math.abs(data[low].time - target);
        const highDist = Math.abs(data[high].time - target);
        return data[highDist < lowDist ? high : low];
    }, [touchOverlayGeom, data]);

    return (
        <div className="glass-card rounded-2xl relative overflow-hidden flex flex-col">
            <div className="flex justify-between items-center px-4 md:px-6 py-3 md:py-4 border-b border-[var(--border-secondary)]">
                <h2 className="text-sm md:text-base font-semibold tracking-tight flex items-center gap-2" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif', color: 'var(--text-primary)' }}>
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
                            onClick={() => {
                                zoomToDuration(7);
                            }}
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

            <div
                ref={chartContainerRef}
                className="h-[36vh] min-h-[200px] max-h-[420px] md:h-80 lg:h-96 w-full touch-none relative select-none px-2 pb-2"
                style={{ touchAction: 'none', overscrollBehavior: 'contain', cursor: isDragging ? 'grabbing' : 'crosshair' }}
                onMouseDown={handleMouseDown}
            >
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data} margin={{ top: 28, right: 10, bottom: 0, left: 10 }}>
                        <defs>
                            <linearGradient id="colorConc" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f6c4d7" stopOpacity={0.18}/>
                                <stop offset="95%" stopColor="#f6c4d7" stopOpacity={0}/>
                            </linearGradient>
                            <linearGradient id="colorPersonal" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.12}/>
                                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-secondary)" />
                        <XAxis
                            dataKey="time"
                            type="number"
                            domain={xDomain || ['auto', 'auto']}
                            allowDataOverflow={true}
                            tickFormatter={(ms) => formatDate(new Date(ms), lang)}
                            tick={{fontSize: 10, fill: 'var(--text-tertiary)', fontWeight: 600}}
                            minTickGap={48}
                            axisLine={false}
                            tickLine={false}
                            dy={10}
                        />
                        <YAxis
                            yAxisId="left"
                            dataKey="concE2"
                            domain={yDomainLeft}
                            allowDataOverflow={false}
                            allowDecimals={false}
                            tickFormatter={formatAxisTick}
                            tick={{fontSize: 10, fill: '#ec4899', fontWeight: 600}}
                            axisLine={false}
                            tickLine={false}
                            width={50}
                            label={{ value: 'E2 (pg/mL)', angle: -90, position: 'left', offset: 0, style: { fontSize: 11, fill: '#ec4899', fontWeight: 700, textAnchor: 'middle' } }}
                        />
                        {hasCPADoses && (
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            dataKey="concCPA"
                            domain={yDomainRight}
                            tickFormatter={formatAxisTick}
                            tick={{fontSize: 10, fill: aaColor, fontWeight: 600}}
                            axisLine={false}
                            tickLine={false}
                            width={50}
                            label={{ value: `${aaLabel} (${aaUnit})`, angle: 90, position: 'right', offset: 0, style: { fontSize: 11, fill: aaColor, fontWeight: 700, textAnchor: 'middle' } }}
                        />
                        )}
                        {/* Hidden right axis when no CPA data — Recharts requires at least one yAxisId="right" */}
                        {!hasCPADoses && (
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            hide={true}
                            domain={[0, 1]}
                        />
                        )}
                        <Tooltip
                            content={<CustomTooltip t={t} lang={lang} aaLabel={aaLabel} aaUnit={aaUnit} aaColor={aaColor} aaShowPersonal={aaPersonalized} />}
                            cursor={{ stroke: '#f6c4d7', strokeWidth: 1, strokeDasharray: '4 4' }}
                            trigger="hover"
                        />
                        <ReferenceLine x={now} stroke="#f6c4d7" strokeDasharray="3 3" strokeWidth={1.2} yAxisId="left" />
                        {/* Endogenous baseline reference line — shown when a pre-dose baseline is
                            known but no personal model (post-dose learning) is active yet. */}
                        {!hasPersonalModel && baselineE2PGmL != null && baselineE2PGmL > 0 && (
                            <ReferenceLine
                                y={baselineE2PGmL}
                                yAxisId="left"
                                stroke="#14b8a6"
                                strokeDasharray="4 3"
                                strokeWidth={1.2}
                                label={{ value: `Endogenous ${baselineE2PGmL.toFixed(1)}`, position: 'insideTopLeft', fontSize: 9, fill: '#14b8a6', fontWeight: 600 }}
                            />
                        )}

                        {/* 95% CI band (stacked area: ci95Low base + ci95Band on top) */}
                        {hasPersonalModel && (
                            <>
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="ci95Low"
                                    yAxisId="left"
                                    stroke="none"
                                    fill="none"
                                    stackId="ci"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="ci95Band"
                                    yAxisId="left"
                                    stroke="none"
                                    fill="rgba(244,63,94,0.09)"
                                    fillOpacity={1}
                                    stackId="ci"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                            </>
                        )}
                        {/* 68% CI band (inner band, darker — rendered above 95%) */}
                        {hasPersonalModel && (
                            <>
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="ci68Low"
                                    yAxisId="left"
                                    stroke="none"
                                    fill="none"
                                    stackId="ci68"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="ci68Band"
                                    yAxisId="left"
                                    stroke="none"
                                    fill="rgba(244,63,94,0.17)"
                                    fillOpacity={1}
                                    stackId="ci68"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                            </>
                        )}
                        {hasPersonalCpaModel && hasPersonalCpaCI && hasCPADoses && (
                            <>
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="cpaCi95Low"
                                    yAxisId="right"
                                    stroke="none"
                                    fill="none"
                                    stackId="cpaCi"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                                <Area
                                    data={data}
                                    type="monotone"
                                    dataKey="cpaCi95Band"
                                    yAxisId="right"
                                    stroke="none"
                                    fill={`${aaColor}1A`}
                                    fillOpacity={1}
                                    stackId="cpaCi"
                                    isAnimationActive={false}
                                    dot={false}
                                    activeDot={false}
                                    legendType="none"
                                />
                            </>
                        )}

                        <Area
                            data={data}
                            type="monotone"
                            dataKey="concE2"
                            yAxisId="left"
                            stroke="#f6c4d7"
                            strokeWidth={2.2}
                            fillOpacity={0.95}
                            fill="url(#colorConc)"
                            isAnimationActive={false}
                            activeDot={{ r: 6, strokeWidth: 3, stroke: '#fff', fill: '#ec4899' }}
                        />
                        {hasCPADoses && (
                        <Area
                            data={data}
                            type="monotone"
                            dataKey="concCPA"
                            yAxisId="right"
                            stroke={aaColor}
                            strokeWidth={2.2}
                            fillOpacity={0.12}
                            fill={aaColor}
                            isAnimationActive={false}
                            activeDot={{ r: 6, strokeWidth: 3, stroke: '#fff', fill: aaColor }}
                        />
                        )}

                        {/* Personal model E2 curve (dashed rose line) */}
                        {hasPersonalModel && (
                            <Area
                                data={data}
                                type="monotone"
                                dataKey="concPersonal"
                                yAxisId="left"
                                stroke="#f43f5e"
                                strokeWidth={1.8}
                                strokeDasharray="5 3"
                                fill="none"
                                isAnimationActive={false}
                                dot={false}
                                activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: '#f43f5e' }}
                            />
                        )}

                        {/* Personal model anti-androgen curve (dashed line) —
                            only for adherence-coupled compounds (CPA), not BICA. */}
                        {hasPersonalCpaModel && hasCPADoses && aaPersonalized && (
                            <Area
                                data={data}
                                type="monotone"
                                dataKey="concPersonalCPA"
                                yAxisId="right"
                                stroke={aaColor}
                                strokeWidth={1.8}
                                strokeDasharray="5 3"
                                fill="none"
                                isAnimationActive={false}
                                dot={false}
                                activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: aaColor }}
                            />
                        )}

                        <Scatter
                            data={nowPoint ? [nowPoint] : []}
                            yAxisId="left"
                            isAnimationActive={false}
                            shape={({ cx, cy }: any) => {
                                return (
                                    <g className="group">
                                        <circle cx={cx} cy={cy} r={1} fill="transparent" />
                                        <circle
                                            cx={cx} cy={cy}
                                            r={4}
                                            fill="#bfdbfe"
                                            stroke="white"
                                            strokeWidth={1.5}
                                        />
                                    </g>
                                );
                            }}
                        />
                        {hasCPADoses && (
                        <Scatter
                            data={nowPoint ? [nowPoint] : []}
                            yAxisId="right"
                            isAnimationActive={false}
                            shape={({ cx, cy }: any) => {
                                return (
                                    <g className="group">
                                        <circle cx={cx} cy={cy} r={1} fill="transparent" />
                                        <circle
                                            cx={cx} cy={cy}
                                            r={4}
                                            fill={aaColor}
                                            stroke="white"
                                            strokeWidth={1.5}
                                        />
                                    </g>
                                );
                            }}
                        />
                        )}
                        {labPoints.map((point) => (
                            <ReferenceDot
                                key={`lab-visible-${point.id}`}
                                x={point.time}
                                y={point.conc}
                                yAxisId="left"
                                ifOverflow="extendDomain"
                                isFront={true}
                                r={9}
                                shape={({ cx, cy }: any) => {
                                    const x = cx ?? 0;
                                    const y = cy ?? 0;
                                    const iconSize = 10;
                                    const iconY = y - iconSize / 2 + 1;
                                    return (
                                        <g style={{ overflow: 'visible' }}>
                                            <circle cx={x} cy={y} r={9} fill="#14b8a6" stroke="white" strokeWidth={2} />
                                            <svg
                                                x={x - iconSize / 2}
                                                y={iconY}
                                                width={iconSize}
                                                height={iconSize}
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="white"
                                                strokeWidth={2.25}
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                overflow="visible"
                                            >
                                                <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
                                                <path d="M8.5 2h7" />
                                                <path d="M7 16h10" />
                                            </svg>
                                        </g>
                                    );
                                }}
                            />
                        ))}
                        {labPoints.length > 0 && (
                            <Scatter
                                data={labPoints}
                                dataKey="conc"
                                yAxisId="left"
                                isAnimationActive={false}
                                shape={({ cx, cy }: any) => (
                                    <circle cx={cx} cy={cy} r={10} fill="transparent" />
                                )}
                            />
                        )}
                        {/* Dose event markers — small dots on the E2 curve */}
                        {dosePoints.length > 0 && (
                            <Scatter
                                data={dosePoints}
                                dataKey="concE2"
                                yAxisId="left"
                                isAnimationActive={false}
                                shape={({ cx, cy, payload }: any) => (
                                    <g>
                                        <circle
                                            cx={cx}
                                            cy={cy}
                                            r={3}
                                            fill={payload?.ester && isAntiandrogen(payload.ester) ? (ANTIANDROGENS[payload.ester as Ester]?.color ?? '#8b5cf6') : '#ec4899'}
                                            stroke="white"
                                            strokeWidth={1.5}
                                        />
                                    </g>
                                )}
                            />
                        )}
                    </ComposedChart>
                </ResponsiveContainer>
                {touchOverlayGeom && (
                    <>
                        <div
                            aria-hidden
                            className="absolute pointer-events-none"
                            style={{
                                left: touchOverlayGeom.lineX,
                                top: touchOverlayGeom.lineTop,
                                width: 1,
                                height: touchOverlayGeom.lineHeight,
                                background: 'repeating-linear-gradient(to bottom, #f6c4d7 0 4px, transparent 4px 8px)',
                            }}
                        />
                        {touchOverlayDataPoint && (
                            <div
                                className="absolute pointer-events-none z-10"
                                style={{
                                    left: touchOverlayGeom.relTouchX + 12,
                                    top: Math.max(0, touchOverlayGeom.relTouchY - 8),
                                    transform: touchOverlayGeom.relTouchX > (chartContainerRef.current?.clientWidth ?? 0) - 160
                                        ? 'translateX(-100%)'
                                        : undefined,
                                }}
                            >
                                <CustomTooltip
                                    active={true}
                                    payload={[{ payload: touchOverlayDataPoint }]}
                                    label={touchOverlayGeom.time}
                                    t={t}
                                    lang={lang}
                                    aaLabel={aaLabel}
                                    aaUnit={aaUnit}
                                    aaColor={aaColor}
                                    aaShowPersonal={aaPersonalized}
                                />
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default ResultChart;
