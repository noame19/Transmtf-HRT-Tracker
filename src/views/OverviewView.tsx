import React, { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import ResultChart from '../components/ResultChart';
import MedicationHeatmap from '../components/MedicationHeatmap';
import ShareImageModal from '../components/ShareImageModal';
import { formatTime } from '../utils/helpers';
import { DoseEvent, SimulationResult, LabResult, Route, Ester, ExtraKey, SL_TIER_ORDER, interpolateConcentration_E2, interpolateCompoundConcentration, isAntiandrogen, isE2Family, pickPrimaryAntiandrogen, ANTIANDROGENS, formatAntiandrogenConc, convertToPgMl } from '../../logic';
import { Plan } from '../../types';
import { drugCategoryOf, formatNextDue, nextDueAfter, pickPrimaryEnabledPlan } from '../utils/planSchedule';

/** Convert hex color string to "r,g,b" for use in rgba() */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// 顶部两卡按药物分类的配色（用户在 DevTools 微调后定稿）。
// 左栏 当前浓度：
const E2_CONC_COLOR = '#F1405D';   // E2 浓度主文字(标签/副标题/数值/CI)
const E2_CONC_SOFT  = '#FF7C80';   // E2 浓度弱化(单位 + 卡片渐变底)
const AA_CONC_COLOR = '#00B0F0';   // 抗雄浓度(全部文字 + 渐变底)
// 右栏 用药时间/下次计划（两卡统一）：
const PLAN_MAIN = '#8A61E6';       // 计划主文字(下次计划/药名/大号时间/相对日)
const PLAN_SOFT = '#9999FF';       // 上次用药行 + 顶部分隔线
const PLAN_BADGE = '#02CB90';      // 途径徽章(绿)
const PLAN_HOLD_GRAY = '#868686';  // 含服时长(灰)

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
  postponeLog,
  dueLog,
  onEditEvent,
}) => {
  const { t, lang } = useTranslation();
  const { isDark } = useTheme();
  const [shareImageOpen, setShareImageOpen] = useState(false);
  const h = currentTime.getTime() / 3600000;

  // 同栏横排断点（≥768px，与顶部 header 的 md:grid-cols-2 对齐）：把"宽窄
  // 信号"传给 MedicationHeatmap，让紧凑态切换到 KPI 列在网格下方的布局，
  // 避免在窄列里 3 KPI 横挤把网格挤压。平板与大屏因此呈现一致的"上下左右
  // 四块"布局。SSR/首屏用 false 兜底（服务端没 window），useEffect 首跑再校正。
  const [isTwoCol, setIsTwoCol] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const update = () => setIsTwoCol(mql.matches);
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
  // Declared early so callers above the return (renderDoseTime 等) can reference it.
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
      // PROG (and any future non-E2 non-anti-androgen) MUST be excluded: a
      // progesterone dose via injection or rectal route is its own drug and
      // does not contribute to the "上一次雌二醇" headline. isE2Family is the
      // allow-list (E2 / EB / EV / EC / EN / EU); the anti-androgen check is
      // kept for symmetry / readability but is subsumed by the inverse.
      if (!isE2Family(ev.ester)) continue;
      if (ev.route === Route.oral) continue;
      if (ev.route === Route.patchRemove) continue;
      if (ev.timeH > h) continue;
      if (!latest || ev.timeH > latest.timeH) latest = ev;
    }
    return latest;
  }, [events, h]);

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

  // 主启用计划(每个药物分类一条)——右栏「下次计划」要显示药名/剂量/途径。
  const primaryE2Plan = useMemo<Plan | null>(
    () => (plans ? pickPrimaryEnabledPlan(plans, 'estrogen') : null),
    [plans],
  );
  const primaryAntiandrogenPlan = useMemo<Plan | null>(
    () => (plans ? pickPrimaryEnabledPlan(plans, 'anti_androgen') : null),
    [plans],
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
    if (conc > 300) return { label: 'status.level.high', color: 'var(--accent-600)', bg: 'var(--bg-soft-rose)', border: 'var(--border-soft-rose)' };
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

  // E2 舌下含服时长(标准档 / θ)——迁到 E2 卡右栏底部。仅舌下时显示。
  const e2HoldExtra: React.ReactNode = (() => {
    if (!(lastE2Dose && lastE2Dose.route === Route.sublingual)) return null;
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
      <p className="text-[9px] italic truncate mt-1" style={{ color: PLAN_HOLD_GRAY }}>
        {t('field.sl_duration')}：<span className="font-semibold italic">{extraText}</span>
      </p>
    );
  })();

  // 右栏「用药时间」：下次计划(药名+剂量+途径) → 大号时间 → 上次用药。
  // 两卡统一配色：主文字 PLAN_MAIN(紫)、途径徽章 PLAN_BADGE(绿)、上次行
  // PLAN_SOFT(浅紫)、含服时长 PLAN_HOLD_GRAY(灰)。holdExtra 仅 E2 舌下时传入。
  const renderDoseTime = (
    plan: Plan | null,
    nextDue: Date | null,
    nextDueStr: string | null,
    lastDose: DoseEvent | null,
    holdExtra?: React.ReactNode,
  ): React.ReactNode => {
    const drugName = plan
      ? t(`ester.${plan.ester}`).replace(/\s*[（(][^）)]*[)）]\s*/g, '')
      : null;
    const routeText = plan ? (t(`plan.route.${plan.route}`) || t(`route.${plan.route}`)) : null;
    return (
      <div className="flex flex-col min-w-0 h-full">
        {/* 上块:下次计划 + 药名 + 大号时间 — flex-1 让它占满中间空白,justify-center 垂直居中 */}
        <div className="flex-1 flex flex-col justify-center min-h-0">
          {/* 下次计划标题 + 途径徽章 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] md:text-xs font-bold kpi-stat-title" style={{ color: PLAN_MAIN }}>
              {t('overview.next_plan', '下次计划')}
            </span>
            {routeText && (
              <span className="text-[9px] font-bold px-1 py-0.5 rounded"
                style={{ background: `rgba(${hexToRgb(PLAN_BADGE)},0.14)`, color: PLAN_BADGE }}>
                {routeText}
              </span>
            )}
          </div>
          {/* 药名 + 剂量 */}
          {plan ? (
            <p className="text-[11px] md:text-xs font-semibold mt-0.5 truncate" style={{ color: PLAN_MAIN, opacity: 0.9 }}>
              {drugName} {formatDoseMG(plan.doseMG)}mg
            </p>
          ) : (
            <p className="text-[11px] md:text-xs font-medium mt-0.5" style={{ color: PLAN_MAIN, opacity: 0.6 }}>—</p>
          )}
          {/* 大号时间 + 相对日 */}
          <div className="flex items-end gap-1.5 mt-1">
            {nextDue ? (
              <>
                <span className="text-4xl md:text-5xl font-medium tracking-tight leading-none" style={{ color: PLAN_MAIN }}>
                  {formatTime(nextDue)}
                </span>
                {nextDueStr && (
                  <span className="text-sm md:text-base font-bold mb-0.5" style={{ color: PLAN_MAIN, opacity: 0.85 }}>
                    {nextDueStr}
                  </span>
                )}
              </>
            ) : (
              <span className="text-4xl md:text-5xl font-medium tracking-tight leading-none" style={{ color: PLAN_MAIN, opacity: 0.45 }}>
                --:--
              </span>
            )}
          </div>
        </div>
        {/* 底部：上次用药 + 含服时长 — 独立块,自然贴卡片底(无 mt-auto) */}
        <div className="pt-[0.2rem] md:pt-2">
          {lastDose && (
            <p className="text-[10px] md:text-xs font-medium pt-2 border-t truncate"
              style={{ color: PLAN_SOFT, opacity: 0.9, borderColor: `rgba(${hexToRgb(PLAN_SOFT)},0.6)` }}>
              {t('overview.last_short', '上次')} {formatTimeAgo(lastDose.timeH)} {formatTime(new Date(lastDose.timeH * 3600000))}
            </p>
          )}
          {holdExtra}
        </div>
      </div>
    );
  };

  return (
    <>
      <header className="relative overflow-x-hidden px-3 md:px-8 safe-area-pt md:pt-6 pb-3 md:pb-4">
        {/* 按药物分类的两张卡：E2 卡 + 抗雄卡。每卡左栏=当前浓度、右栏=
          *  用药时间(下次计划+大号时间+上次用药)。桌面并排,md:items-stretch
          *  两卡等高;窄屏堆叠。 */}
        <div className="grid md:grid-cols-2 gap-2.5 md:gap-4 md:items-stretch">

          {/* ── E2 卡：左栏=当前浓度(沿用原排布,重新配色)，右栏=用药时间
            *  (下次计划+大号时间+上次用药)。按药物分类合并「现值」与「计划」。 */}
          <div className="glass-card glass-highlight rounded-2xl px-4 md:px-5 py-4 md:py-5 relative overflow-hidden flex flex-col"
            style={{
              background: isDark
                ? `linear-gradient(135deg, rgba(${hexToRgb(E2_CONC_SOFT)},0.14), var(--bg-card))`
                : `linear-gradient(135deg, rgba(${hexToRgb(E2_CONC_SOFT)},0.09), var(--bg-card))`,
            }}>
            <div className="grid grid-cols-2 gap-3 md:gap-4 flex-1 min-h-0">
              {/* 左栏 — E2 当前浓度(排布沿用原卡,重新配色) */}
              <div className="space-y-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center gap-1.5 flex-wrap text-xs font-medium leading-tight"
                  style={{ color: E2_CONC_COLOR }}>
                  <span className="kpi-stat-title">{t('status.estimate_prefix')} E2 {t('status.estimate')}</span>
                  {hasPersonalModel && (
                    <span className="px-1 py-0.5 rounded-full text-[8px] font-bold"
                      style={{ background: `rgba(${hexToRgb(E2_CONC_COLOR)},0.14)`, color: E2_CONC_COLOR }}>
                      {t('chart.personal_model')}
                    </span>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  {currentLevel > 0 ? (
                    <>
                      <span className="text-4xl md:text-5xl font-medium tracking-tight"
                        style={{ color: E2_CONC_COLOR }}>
                        {formatHeadlineE2(currentLevel)}
                      </span>
                      <span className="text-sm md:text-base font-bold mb-1"
                        style={{ color: 'rgb(254, 57, 63)', opacity: 0.7 }}>pg/mL</span>
                    </>
                  ) : (
                    <span className="text-4xl md:text-5xl font-medium tracking-tight"
                      style={{ color: 'var(--text-tertiary)' }}>
                      --
                    </span>
                  )}
                </div>
                {currentCI && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: E2_CONC_COLOR, opacity: 0.75 }}>95% CI</span>
                    <span className="text-[11px] font-semibold"
                      style={{ color: E2_CONC_COLOR }}>
                      {currentCI.lo.toFixed(0)} – {currentCI.hi.toFixed(0)}
                      <span className="text-[9px] font-normal ml-0.5" style={{ color: E2_CONC_COLOR, opacity: 0.75 }}>pg/mL</span>
                    </span>
                  </div>
                )}
                {currentCI68 && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: E2_CONC_COLOR, opacity: 0.75 }}>{t('chart.ci68_band')}</span>
                    <span className="text-[11px] font-semibold"
                      style={{ color: E2_CONC_COLOR }}>
                      {currentCI68.lo.toFixed(0)} – {currentCI68.hi.toFixed(0)}
                      <span className="text-[9px] font-normal ml-0.5" style={{ color: E2_CONC_COLOR, opacity: 0.75 }}>pg/mL</span>
                    </span>
                  </div>
                )}
                {personalLevel !== null && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide"
                      style={{ color: E2_CONC_COLOR, opacity: 0.75 }}>
                      {t('chart.personal_model')}
                    </span>
                    <span className="text-[10px] font-semibold" style={{ color: E2_CONC_COLOR }}>
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
                      marginTop: '0.5rem !important',
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

              {/* 右栏 — E2 用药时间 */}
              {renderDoseTime(primaryE2Plan, nextE2Due, nextE2DueStr, lastE2Dose, e2HoldExtra)}
            </div>
          </div>

          {/* ── 抗雄卡：左栏=当前浓度(沿用原排布,重新配色)，右栏=用药时间 ── */}
          <div className="glass-card glass-highlight rounded-2xl px-4 md:px-5 py-4 md:py-5 relative overflow-hidden flex flex-col"
            style={{
              background: isDark
                ? `linear-gradient(135deg, rgba(${hexToRgb(AA_CONC_COLOR)},0.14), var(--bg-card))`
                : `linear-gradient(135deg, rgba(${hexToRgb(AA_CONC_COLOR)},0.09), var(--bg-card))`,
            }}>
            <div className="grid grid-cols-2 gap-3 md:gap-4 flex-1 min-h-0">
              {/* 左栏 — 抗雄当前浓度 */}
              {(() => {
                const aaLabel = primaryAA ?? 'CPA';
                const aaColor = AA_CONC_COLOR;
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
              <div className="space-y-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center gap-1.5 flex-wrap text-xs font-medium leading-tight"
                  style={{ color: aaColor }}>
                  <span className="kpi-stat-title">{t('status.estimate_prefix')} {aaLabel} {t('status.estimate')}</span>
                </div>
                <div className="flex items-end gap-2">
                  {currentAA > 0 ? (
                    <>
                      <span className="text-4xl md:text-5xl font-medium tracking-tight"
                        style={{ color: aaColor }}>
                        {headline.value}
                      </span>
                      <span className="text-sm md:text-base font-bold mb-1"
                        style={{ color: aaColor, opacity: 0.7 }}>{headline.unit}</span>
                    </>
                  ) : (
                    <span className="text-4xl md:text-5xl font-medium tracking-tight"
                      style={{ color: 'var(--text-tertiary)' }}>
                      --
                    </span>
                  )}
                </div>
                {/* 3 行 sub-stat + note 全部包进 mt-auto wrapper:
                    - mt-auto 把整组推至卡片底部,与上方大数字自然留出空间
                    - mobile 行距 1px(space-y-px),desktop 2px(space-y-0.5)
                      桌面保留原视觉密度,mobile 紧凑到几乎贴在一起 */}
                <div className="mt-auto space-y-px md:space-y-0.5 opacity-80">
                  {hasPersonalAaModel && currentAA > 0 && (
                    <>
                      {currentAACI && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-bold uppercase tracking-wide"
                            style={{ color: aaColor, opacity: 0.8 }}>{t('chart.cpa_pop_range')}</span>
                          <span className="text-[11px] font-semibold"
                            style={{ color: aaColor }}>
                            {fmtText(currentAACI.lo)} – {fmtText(currentAACI.hi)}
                            <span className="text-[9px] ml-0.5"
                              style={{ color: aaColor }}>{fmt(currentAACI.hi).unit}</span>
                          </span>
                        </div>
                      )}
                      {primaryAASpec?.adherenceFromE2 && (
                        <div className="flex items-center gap-1.5">
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
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Base</span>
                          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                            {fmtText(rawAA)} {fmt(rawAA).unit}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {currentAA > 0 && (
                    <div className="text-[9px] leading-tight italic" style={{ color: 'var(--text-tertiary)' }}>
                      {t(noteKey)}
                    </div>
                  )}
                </div>
              </div>
                );
              })()}
              {/* 右栏 — 抗雄用药时间 */}
              {renderDoseTime(primaryAntiandrogenPlan, nextAntiandrogenDue, nextAntiandrogenDueStr, lastAntiandrogenDose)}
            </div>
          </div>

        </div>
      </header>

      <main className="w-full overflow-x-hidden px-3 md:px-8 pt-0 pb-4 md:pb-6 rounded-t-3xl"
        style={{ overscrollBehaviorX: 'none' }}>
        {/*
         * md 断点（≥768px，与顶部 header 对齐）把血药浓度图（2/3 宽）和用药
         * 日历热力图（1/3 宽）排到同一行；窄屏（手机）恢复为上下堆叠。平板与
         * 大屏因此呈现一致的"上下左右四块"布局。
         * 热力图在窄列里启用 compact=KPI 列在网格下方而非右侧，避免 3 张
         * KPI 把 1/3 宽的网格挤到不可读。
         */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 min-w-0">
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
          <div className="md:col-span-1 min-w-0">
            <MedicationHeatmap
              events={events}
              plans={plans}
              postponeLog={postponeLog}
              dueLog={dueLog}
              today={currentTime}
              compact={isTwoCol}
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
