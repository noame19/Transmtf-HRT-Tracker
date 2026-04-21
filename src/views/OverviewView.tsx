import React, { useMemo, useState } from 'react';
import { Activity, Settings, Info, Camera } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import ResultChart from '../components/ResultChart';
import ShareImageModal from '../components/ShareImageModal';
import { DoseEvent, SimulationResult, LabResult, interpolateConcentration_E2, interpolateConcentration_CPA, convertToPgMl } from '../../logic';

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
    cpaAdjusted: number[];
    cpaCi95Low: number[];
    cpaCi95High: number[];
}

interface OverviewViewProps {
  events: DoseEvent[];
  weight: number;
  labResults: LabResult[];
  simulation: SimulationResult | null;
  currentTime: Date;
  simCI?: SimCI | null;
  baselineE2PGmL?: number | null;
  onEditEvent: (event: DoseEvent) => void;
  onOpenWeightModal: () => void;
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
  weight,
  labResults,
  simulation,
  currentTime,
  simCI,
  baselineE2PGmL,
  onEditEvent,
  onOpenWeightModal,
}) => {
  const { t, lang } = useTranslation();
  const { isDark, colors } = useTheme();
  const [shareImageOpen, setShareImageOpen] = useState(false);
  const h = currentTime.getTime() / 3600000;

  const hasPersonalModel = !!simCI && simCI.e2Adjusted.length > 0;
  const hasPersonalCpaModel = !!simCI && simCI.cpaAdjusted.length === simCI.timeH.length && simCI.cpaAdjusted.length > 0;
  const hasDoseHistory = events.length > 0;

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

  const rawCPA = useMemo(() => {
    if (!simulation) return 0;
    return interpolateConcentration_CPA(simulation, h) || 0;
  }, [simulation, h]);

  const personalCPA = useMemo(() => {
    if (!hasPersonalCpaModel) return null;
    const v = interpAt(simCI!.timeH, simCI!.cpaAdjusted, h);
    return (v > 0 && v < 5000) ? v : null;
  }, [hasPersonalCpaModel, simCI, h]);

  const currentCPA = personalCPA ?? rawCPA;

  const currentCPACI = useMemo(() => {
    if (!hasPersonalCpaModel) return null;
    if (simCI!.cpaCi95Low.length !== simCI!.timeH.length || simCI!.cpaCi95High.length !== simCI!.timeH.length) {
      return null;
    }
    const lo = interpAt(simCI!.timeH, simCI!.cpaCi95Low, h);
    const hi = interpAt(simCI!.timeH, simCI!.cpaCi95High, h);
    if (lo > 0 && hi > 0 && hi > lo) return { lo, hi };
    return null;
  }, [hasPersonalCpaModel, simCI, h]);

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
  const formatHeadlineCPA = (v: number) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

  return (
    <>
      <header className="relative px-4 md:px-8 pt-6 pb-4">
        <div className="grid md:grid-cols-3 gap-3 md:gap-4">
          {/* Main level card */}
          <div className="md:col-span-2 glass-card glass-highlight glass-accent rounded-2xl px-5 py-5 relative overflow-hidden"
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

              {/* CPA Display */}
              <div className="space-y-1">
                <div className="text-[10px] md:text-xs font-bold uppercase tracking-wider"
                  style={{ color: isDark ? '#c084fc' : '#a855f7' }}>
                  CPA
                </div>
                <div className="flex items-end gap-2">
                  {currentCPA > 0 ? (
                    <>
                      <span className="text-4xl md:text-5xl font-black tracking-tight"
                        style={{ color: isDark ? '#c084fc' : '#9333ea' }}>
                        {formatHeadlineCPA(currentCPA)}
                      </span>
                      <span className="text-sm md:text-base font-bold mb-1"
                        style={{ color: isDark ? '#a78bfa' : '#d8b4fe' }}>ng/mL</span>
                    </>
                  ) : (
                    <span className="text-4xl md:text-5xl font-black tracking-tight"
                      style={{ color: 'var(--text-tertiary)' }}>
                      --
                    </span>
                  )}
                </div>
                {hasPersonalCpaModel && currentCPA > 0 && (
                  <>
                    {currentCPACI && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold uppercase tracking-wide"
                          style={{ color: isDark ? '#a78bfa' : '#d8b4fe' }}>{t('chart.cpa_pop_range')}</span>
                        <span className="text-[11px] font-semibold"
                          style={{ color: isDark ? '#c084fc' : '#a855f7' }}>
                          {currentCPACI.lo.toFixed(2)} – {currentCPACI.hi.toFixed(2)}
                          <span className="text-[9px] font-normal ml-0.5"
                            style={{ color: isDark ? '#a78bfa' : '#d8b4fe' }}>ng/mL</span>
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[9px] font-bold uppercase tracking-wide"
                        style={{ color: isDark ? '#a78bfa' : '#d8b4fe' }}>
                        {t('chart.cpa_adherence')}
                      </span>
                      {personalCPA !== null && (
                        <span className="text-[10px] font-semibold"
                          style={{ color: isDark ? '#c084fc' : '#a855f7' }}>
                          {personalCPA.toFixed(2)} ng/mL
                        </span>
                      )}
                    </div>
                    {rawCPA > 0 && rawCPA !== personalCPA && (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Base</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                          {rawCPA.toFixed(2)} ng/mL
                        </span>
                      </div>
                    )}
                  </>
                )}
                {currentCPA > 0 && (
                  <div className="mt-1 text-[9px] leading-tight italic" style={{ color: 'var(--text-tertiary)' }}>
                    {t('chart.cpa_note')}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Side cards */}
          <div className="grid grid-cols-2 md:grid-cols-1 gap-3">
            <div className="flex items-center gap-3 p-4 glass-card card-lift-glass">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center border"
                style={{
                  background: 'var(--accent-50)',
                  borderColor: 'var(--accent-200)',
                }}>
                <Activity size={18} style={{ color: 'var(--accent-500)' }} />
              </div>
              <div className="leading-tight">
                <p className="text-[11px] md:text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('timeline.title')}</p>
                <p className="text-lg md:text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{events.length || 0}</p>
              </div>
            </div>
            <button
              onClick={onOpenWeightModal}
              className="flex items-center gap-3 p-4 glass-card card-lift-glass btn-press-glass text-left"
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center border"
                style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)' }}>
                <Settings size={18} style={{ color: 'var(--text-secondary)' }} />
              </div>
              <div className="leading-tight">
                <p className="text-[11px] md:text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('status.weight')}</p>
                <p className="text-lg md:text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{weight} kg</p>
              </div>
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-6 rounded-t-3xl"
        style={{ background: 'var(--bg-card)' }}>
        <ResultChart
          sim={simulation}
          events={events}
          onPointClick={onEditEvent}
          labResults={labResults}
          simCI={simCI}
          baselineE2PGmL={baselineE2PGmL}
          onShareImage={() => setShareImageOpen(true)}
        />
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
