import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Pill, Sticker, ShieldAlert } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import ResultChart from '../components/ResultChart';
import MedicationHeatmap from '../components/MedicationHeatmap';
import ShareImageModal from '../components/ShareImageModal';
import { formatTime } from '../utils/helpers';
import { DoseEvent, SimulationResult, LabResult, Route, Ester, ExtraKey, interpolateConcentration_E2, interpolateCompoundConcentration, isAntiandrogen, isE2Family, pickPrimaryAntiandrogen, ANTIANDROGENS, formatAntiandrogenConc, convertToPgMl } from '../../logic';
import { Plan } from '../../types';
import { formatNextDue, nextDueAfter, dueMomentsInRange, pickPrimaryEnabledPlan } from '../utils/planSchedule';

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

/** True iff two Dates fall on the same local calendar day. Used to drive
 *  the "due today" cute glow + corner ping animation on the reminder tile. */
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
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
  const { isDark } = useTheme();
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
   * Compute "next due" for the two reminder tiles.
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

  /** Localized "下次 本周三" / "Next Mon" / etc. for the reminder-tile headline. */
  const nextAntiandrogenDueStr = useMemo<string | null>(
    () => nextAntiandrogenDue ? formatNextDue(nextAntiandrogenDue, currentTime, t, lang) : null,
    [nextAntiandrogenDue, currentTime, t, lang],
  );
  const nextE2DueStr = useMemo<string | null>(
    () => nextE2Due ? formatNextDue(nextE2Due, currentTime, t, lang) : null,
    [nextE2Due, currentTime, t, lang],
  );

  /** Drives the "due today" cute-glow + corner ping on each reminder tile.
   *  Compares calendar day (not wall-clock instant) so a 23:55 due and a
   *  00:05 next moment correctly both count as "today" before midnight. */
  const isAADueToday = !!nextAntiandrogenDue && isSameDay(nextAntiandrogenDue, currentTime);
  const isE2DueToday = !!nextE2Due && isSameDay(nextE2Due, currentTime);

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

  // E2 status pill — same 6-state decision as the chart's reference band.
  // Each state maps to a `.status-pill.state-{key}` class in index.html so the
  // tint/border come from the design system (light/dark variants in CSS).
  const getLevelState = (conc: number): { key: string; label: string } | null => {
    if (conc <= 0) return null;
    if (conc > 300) return { key: 'state-high', label: 'status.level.high' };
    if (conc >= 100 && conc <= 200) return { key: 'state-mtf', label: 'status.level.mtf' };
    if (conc >= 70 && conc <= 300) return { key: 'state-luteal', label: 'status.level.luteal' };
    if (conc >= 30 && conc < 70) return { key: 'state-follicular', label: 'status.level.follicular' };
    if (conc >= 8 && conc < 30) return { key: 'state-male', label: 'status.level.male' };
    return { key: 'state-low', label: 'status.level.low' };
  };
  const currentStatus = useMemo(() => getLevelState(currentLevel), [currentLevel]);

  // Anti-androgen dynamic color (kept from the original KPI card) — varies by
  // primary compound + dark mode. Inline-styled on top of `.dynamic-aa` so the
  // CSS class still drives layout while the user gets the per-compound hue.
  const aaColor = primaryAASpec?.color ?? (isDark ? '#c084fc' : '#9333ea');

  const formatHeadlineE2 = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  // Format an anti-androgen value for the headline, auto-scaling ng/mL → µg/mL.
  const formatHeadlineAA = (ngml: number, spec: typeof primaryAASpec) => {
    if (!spec) return { value: '--', unit: 'ng/mL' };
    const { value, unit } = formatAntiandrogenConc(ngml, spec);
    const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return { value: text, unit };
  };
  const headline = formatHeadlineAA(currentAA, primaryAASpec);
  const fmt = (v: number) => primaryAASpec
    ? formatAntiandrogenConc(v, primaryAASpec)
    : { value: v, unit: 'ng/mL' as const };
  const fmtText = (v: number) => {
    const { value } = fmt(v);
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  };
  const aaLabel = primaryAA ?? 'CPA';
  const noteKey = primaryAA === Ester.BICA ? 'chart.bica_note' : 'chart.cpa_note';

  // ── Insight stats — drives the right-column "intelligent insights" card ──
  // 1) targetHitRate: fraction of last-30-days simulated E2 samples that
  //    landed inside the luteal reference band [70, 300] pg/mL. Prefers the
  //    personal-calibrated simCI when available so the metric reflects the
  //    user's lab-tuned PK rather than population PK. null when no sim.
  // 2) complianceRate: per-plan expected due moments in current month vs
  //    matching DoseEvents within ±60min of each due. Requires at least one
  //    enabled plan to compute — null otherwise.
  // 3) insightTip: dynamic 1-line message driven by currentLevel / currentAA.
  const { targetHitRate, complianceRate, insightTip } = useMemo(() => {
    // (1) target hit rate
    const useSimCI = !!simCI && simCI.e2Adjusted.length === simCI.timeH.length;
    const timeH = useSimCI ? simCI!.timeH : simulation?.timeH;
    const values = useSimCI ? simCI!.e2Adjusted : simulation?.e2Adjusted;
    let hitRate: number | null = null;
    if (timeH?.length && values?.length) {
      const windowStart = h - 30 * 24;
      let hit = 0, total = 0;
      for (let i = 0; i < timeH.length; i++) {
        if (timeH[i] < windowStart) continue;
        const v = values[i];
        if (v > 0 && v < 5000) {
          total++;
          if (v >= 70 && v <= 300) hit++;
        }
      }
      if (total > 0) hitRate = Math.round((hit / total) * 1000) / 10;
    }

    // (2) plan-based compliance
    let compl: number | null = null;
    if (plans && plans.length > 0) {
      const monthStart = new Date(currentTime.getFullYear(), currentTime.getMonth(), 1);
      const monthEnd = new Date(currentTime.getFullYear(), currentTime.getMonth() + 1, 1);
      let expected = 0, matched = 0;
      for (const p of plans) {
        if (!p.enabled) continue;
        const dues = dueMomentsInRange(p, monthStart, monthEnd);
        expected += dues.length;
        for (const d of dues) {
          const dMs = d.getTime();
          const satisfied = events.some((e) =>
            e.ester === p.ester
            && e.route === p.route
            && Math.abs(e.timeH * 3600000 - dMs) <= 60 * 60 * 1000
          );
          if (satisfied) matched++;
        }
      }
      if (expected > 0) compl = Math.round((matched / expected) * 1000) / 10;
    }

    // (3) dynamic tip
    let tip: string;
    if (currentLevel > 200) {
      tip = '💡 当前雌二醇浓度偏高，建议关注是否需要调整剂量或延长给药间隔。';
    } else if (currentLevel > 0 && currentLevel < 70) {
      tip = '💡 当前雌二醇浓度偏低，建议按时服药或与医师讨论剂量调整。';
    } else if (currentAA > 0) {
      tip = '💡 当前体内雌二醇稳态分布良好，抗雄靶点阻断处于深度覆盖阶段。';
    } else {
      tip = '💡 添加用药记录后将自动生成智能洞察分析。';
    }

    return { targetHitRate: hitRate, complianceRate: compl, insightTip: tip };
  }, [simulation, simCI, plans, events, currentTime, h, currentLevel, currentAA]);

  return (
    <>
      <div className="overview-container animate-in page-forward-glass">

        {/* ── Header — two-column grid: combined-reminder-card + KPI card ── */}
        <header className="overview-header">
          <div className="header-grid">

            {/* Combined reminder card — next AA + next E2. Drives the
              *  cute-glow + corner ping when its plan is due today. */}
            <div className="combined-reminder-card">
              <div className="reminder-sub-grid">

                {/* AA reminder tile (抗雄药下次用药) */}
                <div className={`reminder-tile ${isAADueToday ? 'due-today-active-aa' : ''}`}>
                  <div className="tile-icon-wrapper aa-accent">
                    <Pill size={18} />
                    {isAADueToday && <span className="cute-dot-ping-aa" />}
                  </div>
                  <div className="tile-content">
                    <span className="tile-label">{t('overview.last_antiandrogen')}</span>
                    {nextAntiandrogenDueStr ? (
                      <>
                        <div className="tile-main-time" style={{ color: '#3b82f6' }}>
                          {nextAntiandrogenDueStr} {nextAntiandrogenDue ? formatTime(nextAntiandrogenDue) : ''}
                        </div>
                        {lastAntiandrogenDose && (
                          <div className="tile-sub-info">
                            {t('overview.last_dose')}: <span>{formatDoseMG(lastAntiandrogenDose.doseMG)} mg</span> · {formatTimeAgo(lastAntiandrogenDose.timeH)}
                          </div>
                        )}
                      </>
                    ) : lastAntiandrogenDose ? (
                      <div className="tile-main-time" style={{ color: 'var(--text-primary)' }}>
                        {formatDoseMG(lastAntiandrogenDose.doseMG)} mg
                      </div>
                    ) : (
                      <div className="tile-main-time empty">--</div>
                    )}
                  </div>
                </div>

                {/* E2 reminder tile (雌二醇下次用药) */}
                <div className={`reminder-tile ${isE2DueToday ? 'due-today-active-e2' : ''}`}>
                  <div className="tile-icon-wrapper e2-accent">
                    <Sticker size={18} />
                    {isE2DueToday && <span className="cute-dot-ping-e2" />}
                  </div>
                  <div className="tile-content">
                    <span className="tile-label">{t('overview.last_e2')}</span>
                    {nextE2DueStr ? (
                      <>
                        <div className="tile-main-time" style={{ color: 'var(--accent-500)' }}>
                          {nextE2DueStr} {nextE2Due ? formatTime(nextE2Due) : ''}
                        </div>
                        {lastE2Dose && (
                          <div className="tile-sub-info">
                            {t('overview.last_dose')}: <span>{lastE2DoseStr}</span> · {formatTimeAgo(lastE2Dose.timeH)}
                          </div>
                        )}
                      </>
                    ) : lastE2Dose ? (
                      <div className="tile-main-time" style={{ color: 'var(--text-primary)' }}>
                        {lastE2DoseStr}
                      </div>
                    ) : (
                      <div className="tile-main-time empty">--</div>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* Concentration KPI card — E2 + AA headline + status pill.
              *  glass-highlight ::after overlay from the global glass system
              *  layers a soft 135° white sheen on top of the card. */}
            <div className="concentration-glass-kpi glass-highlight">
              <div className="kpi-top-row">
                <div className="kpi-badge">
                  <Activity size={12} className="icon" />
                  <span>{t('status.estimate')}</span>
                  {hasPersonalModel && (
                    <span className="personal-tag">{t('chart.personal_model')}</span>
                  )}
                </div>
              </div>
              <div className="kpi-main-body">
                <div className="kpi-col">
                  <span className="section-label theme-accent">E2</span>
                  <div className="headline-wrapper">
                    <span className={`headline-value e2 ${currentLevel > 0 ? '' : 'empty'}`}>
                      {currentLevel > 0 ? formatHeadlineE2(currentLevel) : '--'}
                    </span>
                    <span className="headline-unit e2">pg/mL</span>
                  </div>
                  {currentStatus && (
                    <div className={`status-pill ${currentStatus.key}`}>
                      <span className="label">{t(currentStatus.label)}</span>
                    </div>
                  )}
                </div>
                <div className="kpi-col">
                  <span className="section-label dynamic-aa" style={{ color: aaColor }}>{aaLabel}</span>
                  <div className="headline-wrapper">
                    <span className={`headline-value dynamic-aa ${currentAA > 0 ? '' : 'empty'}`}
                      style={{ color: aaColor }}>
                      {currentAA > 0 ? headline.value : '--'}
                    </span>
                    <span className="headline-unit dynamic-aa"
                      style={{ color: aaColor, opacity: 0.7 }}>{headline.unit}</span>
                  </div>
                  <div className="ci-row">
                    <span className="ci-label">{t('chart.cpa_pop_range')}</span>
                    {currentAACI && primaryAASpec ? (
                      <span className="ci-value" style={{ color: aaColor }}>
                        {fmtText(currentAACI.lo)} – {fmtText(currentAACI.hi)}
                        <span style={{ fontSize: '0.55rem', opacity: 0.7, marginLeft: '0.15rem' }}>
                          {fmt(currentAACI.hi).unit}
                        </span>
                      </span>
                    ) : (
                      <span className="ci-value">--</span>
                    )}
                  </div>
                  {currentAA > 0 && (
                    <div className="ci-row" style={{ marginTop: '0.25rem' }}>
                      <span className="ci-label" style={{ fontStyle: 'italic' }}>{t(noteKey)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        </header>

        {/* ── Main — chart + widgets column (heatmap + insights) ── */}
        <main className="overview-main">
          <div className="main-responsive-dashboard">
            <div className="chart-cell-container">
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
            <div className="widgets-column-container">
              <div className="heatmap-cell-container">
                <MedicationHeatmap
                  events={events}
                  plans={plans}
                  today={currentTime}
                  compact={isXl}
                />
              </div>
              <div className="insights-cell-container">
                <div className="insight-card-glass">
                  <div className="insight-header">
                    <span className="insight-title">
                      <ShieldAlert size={13} className="text-teal-400" />
                      {t('overview.insights.title')}
                    </span>
                    <span className="insight-tag">智能模型</span>
                  </div>
                  <div className="insight-stats-grid">
                    <div className="stat-box">
                      <span className="stat-lbl">{t('overview.insights.target_hit_rate')}</span>
                      <span className="stat-val text-emerald-400">
                        {targetHitRate !== null ? `${targetHitRate}%` : '--'}
                      </span>
                    </div>
                    <div className="stat-box">
                      <span className="stat-lbl">{t('overview.insights.compliance')}</span>
                      <span className="stat-val" style={{ color: 'var(--text-primary)' }}>
                        {complianceRate !== null ? `${complianceRate}%` : '--'}
                      </span>
                    </div>
                  </div>
                  <p className="insight-tip-text">{insightTip}</p>
                </div>
              </div>
            </div>
          </div>
        </main>

      </div>

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