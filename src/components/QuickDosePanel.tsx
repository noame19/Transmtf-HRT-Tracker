import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Ester, Route } from '../../logic';
import { DOSE_QUICK_PRESETS, drugKeyOf } from '../utils/doseForm';

interface QuickDosePanelProps {
    /** Compound whose presets/units drive the panel. */
    ester: Ester;
    /** 给药方式 — 和 ester 一起查档位预设（不同 route 同一药物档位不同，例如黄体酮直肠 50/100/150/200 vs 肌注 25/50/75） */
    route: Route;
    /** Compound (raw) dose string — used for EV / CPA / BICA. */
    rawDose: string;
    /** Estradiol-equivalent dose string — the displayed value for plain E2. */
    e2Dose: string;
    /** Whether manual entry is active instead of the preset chips. */
    useCustomDose: boolean;
    /** Toggle preset chips <-> manual entry. */
    onToggleCustom: () => void;
    /** A preset chip (compound mg) was tapped. */
    onSelectPreset: (mg: number) => void;
    /** The manual-entry field changed. */
    onCustomChange: (val: string) => void;
}

/**
 * Toggle-style quick dose selector shared by the single-add and batch-add
 * modals. Mirrors the sublingual time-table interaction: preset chips by default
 * with a top-right "custom" switch revealing a manual input. Presets are in mg of
 * the compound itself; for plain E2 the visible/compared value is the
 * E2-equivalent field (which equals the compound mg).
 */
const QuickDosePanel: React.FC<QuickDosePanelProps> = ({
    ester, route, rawDose, e2Dose, useCustomDose, onToggleCustom, onSelectPreset, onCustomChange,
}) => {
    const { t } = useTranslation();
    const presets = DOSE_QUICK_PRESETS[drugKeyOf(route, ester)];
    if (!presets) return null;

    const currentStr = ester === Ester.E2 ? e2Dose : rawDose;
    const current = parseFloat(currentStr);

    return (
        <div className="space-y-3">
            <div className="flex justify-between items-center">
                <label className="block text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                    {t('field.dose_raw')}
                </label>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('dose.quick.custom')}</span>
                    <div
                        className={`w-10 h-6 rounded-full p-1 cursor-pointer transition-colors ${useCustomDose ? 'bg-pink-500' : 'bg-[var(--toggle-track-off)]'}`}
                        onClick={onToggleCustom}
                    >
                        <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${useCustomDose ? 'translate-x-4' : ''}`} />
                    </div>
                </div>
            </div>

            {!useCustomDose ? (
                <div className={`grid gap-2 ${presets.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
                    {presets.map(mg => {
                        const selected = Number.isFinite(current) && Math.abs(current - mg) < 1e-6;
                        return (
                            <button
                                key={mg}
                                type="button"
                                onClick={() => onSelectPreset(mg)}
                                className="py-3 rounded-xl text-sm font-bold font-mono transition-all border"
                                style={selected
                                    ? { background: 'var(--bg-soft-rose)', borderColor: 'var(--border-soft-rose)', color: 'var(--accent-500)', boxShadow: 'var(--shadow-sm)' }
                                    : { background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                            >
                                {mg} mg
                            </button>
                        );
                    })}
                </div>
            ) : (
                <input
                    type="number" inputMode="decimal"
                    min="0"
                    step="0.001"
                    value={currentStr}
                    onChange={e => onCustomChange(e.target.value)}
                    className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono"
                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                    placeholder="0.0"
                />
            )}

            {ester === Ester.EV && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('field.dose_e2')}: {e2Dose ? `${e2Dose} mg` : '--'}
                </p>
            )}
        </div>
    );
};

export default QuickDosePanel;
