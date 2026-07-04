import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Info, Camera, Syringe, Pill, Droplet, Sticker } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import ResultChart from '../components/ResultChart';
import MedicationHeatmap from '../components/MedicationHeatmap';
import ShareImageModal from '../components/ShareImageModal';
import { formatTime } from '../utils/helpers';
import { DoseEvent, SimulationResult, LabResult, Route, Ester, ExtraKey, SL_TIER_ORDER, interpolateConcentration_E2, interpolateCompoundConcentration, isAntiandrogen, pickPrimaryAntiandrogen, ANTIANDROGENS, formatAntiandrogenConc, convertToPgMl } from '../../logic';
import { Plan } from '../../types';
import { drugCategoryOf, formatNextDue, nextDueAfter, pickPrimaryEnabledPlan } from '../utils/planSchedule';

/** Convert hex color string to "r,g,b" for use in rgba() */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

interface SimCI {
    timeH: number[];
    e2Adjusted: number[];
    ci95Low: number[];
    ci95High: number[];
    ci68Low: number[];
    ci68High: number[];
    antiandrogen: Partial<Record<string, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>>;
}

interface OverviewViewProps {
  events: DoseEvent[];
  labResults: LabResult[];
  simulation: SimulationResult | null;
  currentTime: Date;
  simCI?: SimCI | null;
  baselineE2PGmL?: number | null;
  /** Optional — when supplied, the side cards show the next scheduled dose. */
  plans?: Plan[];
  onEditEvent: (event: DoseEvent) => void;
}

function interpAt(timeH: number[], values: number[], h: number): number {
  if (!timeH.length || !values.length) return 0;
  if (h <= timeH[0]) return values[0];
  if (h >= timeH[timeH.length - 1]) return values[values.length - 1];
  let lo = 0, hi = timeH.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeH[mid] <= h) lo = mid; else hi = mid;
  }
  const frac = (timeH[hi] - timeH[lo]) > 0
    ? (h - timeH[lo]) / (timeH[hi] - timeH[lo])
    : 0;
  const v = values[lo] + frac * (values[hi] - values[lo]);
  return isFinite(v) ? v : 0;
}

const OverviewView: React.FC<OverviewViewProps> = ({
  events,
  labResults,
  simulation,
  currentTime,
  simCI,
  baselineE2PGmL,
  plans,
  onEditEvent,
}) => {
  const { t, lang } = useTranslation();
  const { isDark, colors } = useTheme();
  const [shareImageOpen, setShareImageOpen] = useState(false);
  const h = currentTime.getTime() / 3600000;

  // xl 同栏横排断点（≥1280px）：把"宽窄信号"传给 MedicationHeatmap，让
  // 紧凑态切换到 KPI 列在网格下方的布局，避免在窄列里 3 KPI 横挤把网格挤压。
  // SSR/首屏用 false 兜底（服务端没 window），useEffect 首跑再校正。
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(min-width: 1280px)');
    const update = () => setIsXl(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  const hasPersonalModel = !!simCI && simCI.e2Adjusted.length > 0;
  const hasDoseHistory = events.length > 0;

  // The "primary" anti-androgen shown in the headline / side tile = the most
  // recently dosed one (CPA and BICA are clinical alternatives).
  const primaryAA = useMemo<Ester | null>(
    () => pickPrimaryAntiandrogen(events, h),
    [events, h]
  );
  const primaryAASpec = primaryAA ? ANTIANDROGENS[primaryAA]! : null;
  const aaCI = (primaryAA && simCI) ? simCI.antiandrogen[primaryAA] : undefined;
  const hasPersonalAaModel = !!aaCI && aaCI.adjusted.length === (simCI?.timeH.length ?? -1) && aaCI.adjusted.length > 0;

  // Format a stored dose (mg) for display: show the exact value the user
  // entered instead of rounding it. Trailing zeros are stripped so 12.5 → "12.5",
  // 25 → "25", 6.25 → "6.25". Capped at 3 decimals to drop floating-point noise,
  // matching the precision the dose editor persists (DoseFormModal uses toFixed(3)).
  // Declared here (not lower in the file) because lastE2DoseStr's useMemo below
  // references it — `const` arrow functions are hoisted into the TDZ until their
  // definition runs, so a useMemo defined earlier would throw at first render.
  const formatDoseMG = (mg: number): string => `${parseFloat(mg.toFixed(3))}`;

  const rawLevel = useMemo(() => {
    if (!simulation) return 0;
    const drugE2 = interpolateConcentration_E2(simulation, h) || 0;
    const shift = (!hasPersonalModel && baselineE2PGmL && baselineE2PGmL > 0)
      ? baselineE2PGmL
      : 0;
    return drugE2 + shift;
  }, [simulation, h, hasPersonalModel, baselineE2PGmL]);

  const baselineLevel = useMemo(() => {
    if (!hasDoseHistory && labResults.length > 0) {
      const latest = [...labResults].sort((a, b) => b.timeH - a.timeH)[0];
      const v = convertToPgMl(latest.concValue, latest.unit);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    if (hasDoseHistory && !hasPersonalModel && baselineE2PGmL && baselineE2PGmL > 0) {
      return baselineE2PGmL;
    }
    return null;
  }, [hasDoseHistory, hasPersonalModel, baselineE2PGmL, labResults]);

  const personalLevel = useMemo(() => {
    if (!hasPersonalModel) return null;
    const v = interpAt(simCI!.timeH, simCI!.e2Adjusted, h);
    return (v > 0 && v < 5000) ? v : null;
  }, [hasPersonalModel, simCI, h]);

  const currentLevel = personalLevel ?? (rawLevel || baselineLevel || 0);

  const currentCI = useMemo(() => {
    if (!hasPersonalModel) return null;
    const lo = interpAt(simCI!.timeH, simCI!.ci95Low, h);
    const hi = interpAt(simCI!.timeH, simCI!.ci95High, h);
    if (lo > 0 && hi > 0 && hi > lo) return { lo, hi };
    return null;
  }, [hasPersonalModel, simCI, h]);

  // Anti-androgen current level (native ng/mL) for the primary compound.
  const rawAA = useMemo(() => {
    if (!simulation || !primaryAA) return 0;
    return interpolateCompoundConcentration(simulation, primaryAA, h) || 0;
  }, [simulation, primaryAA, h]);

  const personalAA = useMemo(() => {
    if (!hasPersonalAaModel || !aaCI || !primaryAASpec) return null;
    const v = interpAt(simCI!.timeH, aaCI.adjusted, h);
    return (v > 0 && v <= primaryAASpec.ciMaxNative) ? v : null;
  }, [hasPersonalAaModel, aaCI, primaryAASpec, simCI, h]);

  const currentAA = personalAA ?? rawAA;

  const currentAACI = useMemo(() => {
    if (!hasPersonalAaModel || !aaCI) return null;
    if (aaCI.ci95Low.length !== simCI!.timeH.length || aaCI.ci95High.length !== simCI!.timeH.length) {
      return null;
    }
    const lo = interpAt(simCI!.timeH, aaCI.ci95Low, h);
    const hi = interpAt(simCI!.timeH, aaCI.ci95High, h);
    if (lo > 0 && hi > 0 && hi > lo) return { lo, hi };
    return null;
  }, [hasPersonalAaModel, aaCI, simCI, h]);

  const currentCI68 = useMemo(() => {
    if (!hasPersonalModel) return null;
    if (!simCI!.ci68Low?.length || simCI!.ci68Low.length !== simCI!.timeH.length) return null;
    const lo = interpAt(simCI!.timeH, simCI!.ci68Low, h);
    const hi = interpAt(simCI!.timeH, simCI!.ci68High, h);
    if (lo > 0 && hi > 0 && hi > lo) return { lo, hi };
    return null;
  }, [hasPersonalModel, simCI, h]);

  // Latest anti-androgen dose (any route, ester ∈ {CPA, BICA}). Skips events
  // scheduled in the future so a batch-imported plan or a manually post-dated
  // entry doesn't pretend to be "the last dose" on the homepage.
  const lastAntiandrogenDose = useMemo<DoseEvent | null>(() => {
    let latest: DoseEvent | null = null;
    for (const ev of events) {
      if (!isAntiandrogen(ev.ester)) continue;
      if (ev.timeH > h) continue;
      if (!latest || ev.timeH > latest.timeH) latest = ev;
    }
    return latest;
  }, [events, h]);

  // Latest non-oral estradiol dose (injection / sublingual / gel / patch
  // apply). Patch-remove events are excluded because they represent removal,
  // not an administration the user would think of as "the last dose". Future
  // events are also excluded (see lastCPADose).
  const lastE2Dose = useMemo<DoseEvent | null>(() => {
    let latest: DoseEvent | null = null;
    for (const ev of events) {
      if (isAntiandrogen(ev.ester)) continue;
      if (ev.route === Route.oral) continue;
      if (ev.route === Route.patchRemove) continue;
      if (ev.timeH > h) continue;
      if (!latest || ev.timeH > latest.timeH) latest = ev;
    }
    return latest;
  }, [events, h]);

  // Pre-format the E2 dose display string for the meta row. Patch route shows
  // µg/d, all others show plain mg — same convention the DoseEvent list uses.
  const lastE2DoseStr = useMemo<string>(() => {
    if (!lastE2Dose) return '';
    const rate = lastE2Dose.extras?.[ExtraKey.releaseRateUGPerDay];
    if (lastE2Dose.route === Route.patchApply && rate) {
      return `${rate} µg/d`;
    }
    return `${formatDoseMG(lastE2Dose.doseMG)} mg`;
  }, [lastE2Dose]);

  /**
   * Compute "next due" for the two side cards.
   *
   * Pick the "primary" enabled plan in each drug category (most-recently-
   * updated wins on ties) and resolve its earliest upcoming moment against
   * `currentTime`. The plan category invariant ("one enabled plan per drug
   * category") is enforced at write time by setPlans + re-validated on every
   * load by sanitizePlansForConflict. pickPrimaryEnabledPlan additionally
   * defends against dirty localStorage / cloud-sync races at compute time —
   * if multiple enabled plans slipped through, it picks deterministically and
   * console.warns so the inconsistency surfaces to devs.
   *
   * Null when:
   *   - no plans supplied
   *   - no enabled plan in this category
   *   - the chosen plan has ended or has no remaining due moments
   */
  const nextAntiandrogenDue = useMemo<Date | null>(() => {
    if (!plans) return null;
    const primary = pickPrimaryEnabledPlan(plans, 'anti_androgen');
    return primary ? nextDueAfter(primary, currentTime) : null;
  }, [plans, currentTime]);

  const nextE2Due = useMemo<Date | null>(() => {
    if (!plans) return null;
    const primary = pickPrimaryEnabledPlan(plans, 'estrogen');
    return primary ? nextDueAfter(primary, currentTime) : null;
  }, [plans, currentTime]);

  /** Localized "下次 本周三" / "Next Mon" / etc. for the side-card subtitle. */
  const nextAntiandrogenDueStr = useMemo<string | null>(
    () => nextAntiandrogenDue ? formatNextDue(nextAntiandrogenDue, currentTime, t, lang) : null,
    [nextAntiandrogenDue, currentTime, t, lang],
  );
  const nextE2DueStr = useMemo<string | null>(
    () => nextE2Due ? formatNextDue(nextE2Due, currentTime, t, lang) : null,
    [nextE2Due, currentTime, t, lang],
  );

  // Relative-time formatter ("3h 前", "2d ago"). Falls back to absolute date
  // when older than ~30 days so old-record context stays readable.
  const formatTimeAgo = (eventTimeH: number): string => {
    const nowMs = currentTime.getTime();
    const evMs = eventTimeH * 3600000;
    const diffMin = Math.max(0, (nowMs - evMs) / 60000);
    if (diffMin < 1) return t('overview.just_now');
    if (diffMin < 60) return t('overview.min_ago').replace('{n}', String(Math.floor(diffMin)));
    const diffH = diffMin / 60;
    if (diffH < 24) return t('overview.hour_ago').replace('{n}', String(Math.floor(diffH)));
    const diffD = diffH / 24;
    if (diffD < 30) {
      // Keep hour precision past the one-day mark so "2d" reads as "2d 5h"
      // instead of silently dropping the remaining hours. Fall back to the
      // plain day form on an exact day boundary to avoid a dangling "0h".
      const days = Math.floor(diffH / 24);
      const hours = Math.floor(diffH % 24);
      if (hours === 0) return t('overview.day_ago').replace('{n}', String(days));
      return t('overview.day_hour_ago').replace('{d}', String(days)).replace('{h}', String(hours));
    }
    const d = new Date(evMs);
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : lang === 'zh-TW' ? 'zh-TW' : lang === 'ja' ? 'ja-JP' : 'en-US',
      { month: 'short', day: 'numeric' });
  };

  const getLevelStatus = (conc: number) => {
    if (conc > 300) return { label: 'status.level.high', color: 'var(--accent-600)', bg: 'var(--accent-50)', border: 'var(--accent-200)' };
    if (conc >= 100 && conc <= 200) return { label: 'status.level.mtf', color: isDark ? '#34d399' : '#059669', bg: isDark ? 'rgba(5,150,105,0.15)' : '#ecfdf5', border: isDark ? 'rgba(5,150,105,0.3)' : '#a7f3d0' };
    if (conc >= 70 && conc <= 300) return { label: 'status.level.luteal', color: isDark ? '#60a5fa' : '#2563eb', bg: isDark ? 'rgba(37,99,235,0.15)' : '#eff6ff', border: isDark ? 'rgba(37,99,235,0.3)' : '#bfdbfe' };
    if (conc >= 30 && conc < 70) return { label: 'status.level.follicular', color: isDark ? '#818cf8' : '#4f46e5', bg: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', border: isDark ? 'rgba(79,70,229,0.3)' : '#c7d2fe' };
    if (conc >= 8 && conc < 30) return { label: 'status.level.male', color: 'var(--text-secondary)', bg: 'var(--bg-card-hover)', border: 'var(--border-primary)' };
    return { label: 'status.level.low', color: isDark ? '#fbbf24' : '#d97706', bg: isDark ? 'rgba(217,119,6,0.15)' : '#fffbeb', border: isDark ? 'rgba(217,119,6,0.3)' : '#fde68a' };
  };

  const currentStatus = useMemo(() => {
    if (currentLevel > 0) return getLevelStatus(currentLevel);
    return null;
  }, [currentLevel, isDark]);

  const formatHeadlineE2 = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  // Format an anti-androgen value for the headline, auto-scaling ng/mL → µg/mL.
  const formatHeadlineAA = (ngml: number, spec: typeof primaryAASpec) => {
    if (!spec) return { value: '--', unit: 'ng/mL' };
    const { value, unit } = formatAntiandrogenConc(ngml, spec);
    const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return { value: text, unit };
  };

  return (
    <>
      <header className="relative overflow-x-hidden px-3 md:px-8 pt-4 md:pt-6 pb-3 md:pb-4">
        <div className="grid md:grid-cols-3 gap-2.5 md:gap-4 md:items-stretch">
          {/* Main level card */}
          <div className="md:col-span-2 glass-card glass-highlight glass-accent rounded-2xl px-4 md:px-5 py-4 md:py-5 relative overflow-hidden"
            style={{
              background: isDark
                ? `linear-gradient(135deg, rgba(${hexToRgb(colors[500])},0.12), var(--bg-card))`
                : `linear-gradient(135deg, rgba(${hexToRgb(colors[500])},0.06), var(--bg-card))`,
            }}>
            <div className="flex items-center mb-3">
              <h1 className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] md:text-xs font-semibold border"
                style={{
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  borderColor: 'var(--border-primary)',
                }}>
                <Activity size={14} style={{ color: 'var(--text-tertiary)' }} />
                {t('status.estimate')}
                {hasPersonalModel && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                    style={{
                      background: 'var(--accent-50)',
                      color: 'var(--accent-500)',
                      border: `1px solid var(--accent-200)`,
                    }}>
                    {t('chart.personal_model')}
                  </span>
                )}
              </h1>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {/* E2 Display */}
              <div className="space-y-1">
                <div className="text-[10px] md:text-xs font-bold uppercase tracking-wider"
                  style={{ color: 'var(--accent-400)' }}>
                  E2
                </div>
                <div className="flex items-end gap-2">
                  {currentLevel > 0 ? (
                    <>
                      <span className="text-4xl md:text-5xl font-black tracking-tight"
                        style={{ color: 'var(--accent-500)' }}>
                        {formatHeadlineE2(currentLevel)}
                      </span>
                      <span className="text-sm md:text-base font-bold mb-1"
                        style={{ color: 'var(--accent-300)' }}>pg/mL</span>
                    </>
                  ) : (
                    <span className="text-4xl md:text-5xl font-black tracking-tight"
                      style={{ color: 'var(--text-tertiary)' }}>
                      --
                    </span>
                  )}
                </div>
                {currentCI && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: 'var(--accent-300)' }}>95% CI</span>
                    <span className="text-[11px] font-semibold"
                      style={{ color: 'var(--accent-400)' }}>
                      {currentCI.lo.toFixed(0)} – {currentCI.hi.toFixed(0)}
                      <span className="text-[9px] font-normal ml-0.5" style={{ color: 'var(--accent-300)' }}>pg/mL</span>
                    </span>
                  </div>
                )}
                {currentCI68 && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: 'var(--accent-300)' }}>{t('chart.ci68_band')}</span>
                    <span className="text-[11px] font-semibold"
                      style={{ color: 'var(--accent-400)' }}>
                      {currentCI68.lo.toFixed(0)} – {currentCI68.hi.toFixed(0)}
                      <span className="text-[9px] font-normal ml-0.5" style={{ color: 'var(--accent-300)' }}>pg/mL</span>
                    </span>
                  </div>
                )}
                {personalLevel !== null && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: 'var(--accent-300)' }}>
                      {t('chart.personal_model')}
                    </span>
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-500)' }}>
                      {personalLevel.toFixed(1)} pg/mL
                    </span>
                  </div>
                )}
                {hasPersonalModel && rawLevel > 0 && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Raw</span>
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                      {rawLevel.toFixed(1)} pg/mL
                    </span>
                  </div>
                )}
                {!hasDoseHistory && baselineLevel !== null && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold text-teal-400 uppercase tracking-wide">Baseline</span>
                    <span className="text-[10px] font-semibold text-teal-500">
                      {baselineLevel.toFixed(1)} pg/mL
                    </span>
                  </div>
                )}
                {hasDoseHistory && !hasPersonalModel && baselineE2PGmL != null && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold text-teal-400 uppercase tracking-wide">Endogenous</span>
                    <span className="text-[10px] font-semibold text-teal-500">
                      {baselineE2PGmL.toFixed(1)} pg/mL
                    </span>
                  </div>
                )}
                {currentStatus && (
                  <div className="px-2.5 py-1 rounded-lg border flex items-center gap-1.5 mt-1 w-fit"
                    style={{
                      background: currentStatus.bg,
                      borderColor: currentStatus.border,
                    }}>
                    <Info size={10} style={{ color: currentStatus.color }} />
                    <span className="text-[9px] md:text-[10px] font-bold" style={{ color: currentStatus.color }}>
                      {t(currentStatus.label)}
                    </span>
                  </div>
                )}
              </div>

              {/* Anti-androgen Display (CPA / bicalutamide, auto-unit) */}
              {(() => {
                const aaLabel = primaryAA ?? 'CPA';
                const aaColor = primaryAASpec?.color ?? (isDark ? '#c084fc' : '#9333ea');
                const headline = formatHeadlineAA(currentAA, primaryAASpec);
                const fmt = (v: number) => primaryAASpec
                  ? formatAntiandrogenConc(v, primaryAASpec)
                  : { value: v, unit: 'ng/mL' as const };
                const fmtText = (v: number) => {
                  const { value } = fmt(v);
                  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
                };
                const noteKey = primaryAA === Ester.BICA ? 'chart.bica_note' : 'chart.cpa_note';
                return (
              <div className="space-y-1">
                <div className="text-[10px] md:text-xs font-bold uppercase tracking-wider"
                  style={{ color: aaColor }}>
                  {aaLabel}
                </div>
                <div className="flex items-end gap-2">
                  {currentAA > 0 ? (
                    <>
                      <span className="text-4xl md:text-5xl font-black tracking-tight"
                        style={{ color: aaColor }}>
                        {headline.value}
                      </span>
                      <span className="text-sm md:text-base font-bold mb-1"
                        style={{ color: aaColor, opacity: 0.7 }}>{headline.unit}</span>
                    </>
                  ) : (
                    <span className="text-4xl md:text-5xl font-black tracking-tight"
                      style={{ color: 'var(--text-tertiary)' }}>
                      --
                    </span>
                  )}
                </div>
                {hasPersonalAaModel && currentAA > 0 && (
                  <>
                    {currentAACI && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold uppercase tracking-wide"
                          style={{ color: aaColor, opacity: 0.8 }}>{t('chart.cpa_pop_range')}</span>
                        <span className="text-[11px] font-semibold"
                          style={{ color: aaColor }}>
                          {fmtText(currentAACI.lo)} – {fmtText(currentAACI.hi)}
                          <span className="text-[9px] font-normal ml-0.5"
                            style={{ color: aaColor, opacity: 0.8 }}>{fmt(currentAACI.hi).unit}</span>
                        </span>
                      </div>
                    )}
                    {primaryAASpec?.adherenceFromE2 && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold uppercase tracking-wide"
                          style={{ color: aaColor, opacity: 0.8 }}>
                          {t('chart.cpa_adherence')}
                        </span>
                        {personalAA !== null && (
                          <span className="text-[10px] font-semibold"
                            style={{ color: aaColor }}>
                            {fmtText(personalAA)} {fmt(personalAA).unit}
                          </span>
                        )}
                      </div>
                    )}
                    {rawAA > 0 && rawAA !== personalAA && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Base</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                          {fmtText(rawAA)} {fmt(rawAA).unit}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {currentAA > 0 && (
                  <div className="mt-1 text-[9px] leading-tight italic" style={{ color: 'var(--text-tertiary)' }}>
                    {t(noteKey)}
                  </div>
                )}
              </div>
                );
              })()}
            </div>
          </div>

          {/* Side cards */}
          <div className="flex flex-row gap-2 md:flex-col md:gap-3 md:h-full">

            {/* Last anti-androgen dose (CPA / bicalutamide) — full row width now.
                Showing "下次" date when at least one enabled anti-androgen plan exists. */}
            <div className="flex items-start gap-2 p-3 md:p-4 glass-card card-lift-glass min-w-0 flex-1 md:flex-none">
              <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center border shrink-0"
                style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                <Pill size={16} style={{ color: '#3b82f6' }} />
              </div>
              <div className="leading-tight min-w-0 flex-1">
                <p className="text-[10px] md:text-xs font-semibold truncate" style={{ color: 'var(--text-secondary)' }}>
                  {t('overview.last_antiandrogen')}
                </p>
                {lastAntiandrogenDose ? (
                  <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0 mt-0.5 min-w-0">
                    <p className="text-sm md:text-base font-bold font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      {`${formatDoseMG(lastAntiandrogenDose.doseMG)} mg`}
                    </p>
                    <span className="text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded"
                      style={{ background: 'var(--bg-card-hover)', color: 'var(--text-tertiary)' }}>
                      {lastAntiandrogenDose.ester}
                    </span>
                    <span className="text-[10px] font-medium whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                      {formatTimeAgo(lastAntiandrogenDose.timeH)}
                    </span>
                  </div>
                ) : (
                  <p className="text-base md:text-lg font-bold" style={{ color: 'var(--text-tertiary)' }}>--</p>
                )}
                {nextAntiandrogenDueStr && (
                  <p className="text-[10px] md:text-xs font-semibold mt-1 truncate"
                    style={{ color: '#3b82f6' }}>
                    {`${t('overview.next_due')} ${nextAntiandrogenDueStr} ${nextAntiandrogenDue ? formatTime(nextAntiandrogenDue) : ''}`}
                  </p>
                )}
              </div>
            </div>

            {/* Last estradiol dose (non-oral) — full width, content redistributes when stretched on desktop */}
            <div className="flex flex-col p-3 md:p-4 glass-card card-lift-glass flex-1 min-h-0">
              {/* Top row: icon + label + route badge + time-ago */}
              <div className="flex items-start gap-3 shrink-0">
                <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center border shrink-0"
                  style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                  {lastE2Dose
                    ? (
                      lastE2Dose.route === Route.injection ? <Syringe size={16} className="text-pink-400 md:w-5 md:h-5" />
                      : lastE2Dose.route === Route.sublingual ? <Pill size={16} className="text-teal-500 md:w-5 md:h-5" />
                      : lastE2Dose.route === Route.gel ? <Droplet size={16} className="text-cyan-500 md:w-5 md:h-5" />
                      : lastE2Dose.route === Route.patchApply ? <Sticker size={16} className="text-orange-500 md:w-5 md:h-5" />
                      : <Syringe size={16} style={{ color: 'var(--text-tertiary)' }} />
                    )
                    : <Syringe size={16} style={{ color: 'var(--text-tertiary)' }} />
                  }
                </div>
                <div className="leading-tight min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-[11px] md:text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                      {t('overview.last_e2')}
                    </p>
                    {lastE2Dose && (
                      <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--accent-50)', color: 'var(--accent-500)' }}>
                        {t(`route.${lastE2Dose.route}`)}
                      </span>
                    )}
                  </div>
                  {lastE2Dose ? (
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0 mt-0.5 min-w-0">
                      <p className="text-sm md:text-base font-bold font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                        {lastE2DoseStr}
                      </p>
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-tertiary)' }}>
                        {lastE2Dose.ester}
                      </span>
                      <span className="text-[10px] font-medium whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                        {`${formatTimeAgo(lastE2Dose.timeH)} ${formatTime(new Date(lastE2Dose.timeH * 3600000))}`}
                      </span>
                    </div>
                  ) : (
                    <p className="text-base md:text-lg font-bold" style={{ color: 'var(--text-tertiary)' }}>--</p>
                  )}
                  {nextE2DueStr && (
                    <p className="text-[10px] md:text-xs font-semibold mt-1 truncate"
                      style={{ color: 'var(--accent-500)' }}>
                      {`${t('overview.next_due')} ${nextE2DueStr} ${nextE2Due ? formatTime(nextE2Due) : ''}`}
                    </p>
                  )}
                </div>
              </div>

              {/* Bottom-aligned extra info (sublingual hold time / θ).
                  Priority mirrors DoseFormModal: if both fields exist on stale
                  data, tier wins so the on-screen value matches what the edit
                  form will display. */}
              {lastE2Dose && lastE2Dose.route === Route.sublingual && (() => {
                const theta = lastE2Dose.extras?.[ExtraKey.sublingualTheta];
                const tierRaw = lastE2Dose.extras?.[ExtraKey.sublingualTier];
                let extraText: string | null = null;
                if (tierRaw !== undefined) {
                  const idx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(tierRaw)));
                  extraText = t(`sl.mode.${SL_TIER_ORDER[idx]}`);
                } else if (theta !== undefined && Number.isFinite(theta)) {
                  extraText = `θ ${theta.toFixed(2)}`;
                }
                if (!extraText) return null;
                return (
                  <div className="mt-2 md:mt-3 pt-2 md:pt-3 border-t shrink-0"
                    style={{ borderColor: 'var(--border-secondary)' }}>
                    <p className="text-[10px] md:text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                      {t('field.sl_duration')}: <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{extraText}</span>
                    </p>
                  </div>
                );
              })()}
            </div>

          </div>
        </div>
      </header>

      <main className="w-full overflow-x-hidden px-3 md:px-4 pt-0 pb-4 md:pb-6 rounded-t-3xl"
        style={{ overscrollBehaviorX: 'none' }}>
        {/*
         * 桌面端（xl 断点 ≥1280px）把血药浓度图（2/3 宽）和用药日历热力图
         * （1/3 宽）排到同一行；窄屏恢复为上下堆叠。
         * 热力图在窄列里启用 compact=KPI 列在网格下方而非右侧，避免 3 张
         * KPI 把 1/3 宽的网格挤到不可读。
         */}
        <div className="flex flex-col xl:flex-row xl:items-stretch gap-4 md:gap-6">
          <div className="xl:flex-[2] min-w-0">
            <ResultChart
              sim={simulation}
              events={events}
              onPointClick={onEditEvent}
              labResults={labResults}
              simCI={simCI}
              baselineE2PGmL={baselineE2PGmL}
              nowH={h}
              onShareImage={() => setShareImageOpen(true)}
            />
          </div>

          {/* Medication calendar heatmap — rendered after the blood-concentration
           *  chart so the visual narrative goes "concentration now → history
           *  of when doses actually landed". Pure client-side, no data fetch. */}
          <div className="xl:flex-[1] min-w-0">
            <MedicationHeatmap
              events={events}
              plans={plans}
              today={currentTime}
              compact={isXl}
            />
          </div>
        </div>
      </main>

      <ShareImageModal
        isOpen={shareImageOpen}
        onClose={() => setShareImageOpen(false)}
        events={events}
        labResults={labResults}
        simulation={simulation}
        simCI={simCI}
        baselineE2PGmL={baselineE2PGmL}
      />
    </>
  );
};

export default OverviewView;
