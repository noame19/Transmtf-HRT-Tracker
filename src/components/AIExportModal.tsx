import React, { useEffect, useMemo, useState } from 'react';
import { X, Bot, Calendar, Clipboard, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { DoseEvent, LabResult, Plan } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from './BasicInfoModal';
import { buildAITextExport, type SupportedLang } from '../utils/aiExport';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    events: DoseEvent[];
    labResults: LabResult[];
    plans: Plan[];
    basicInfo: BasicInfo;
    postponeLog: PostponeLogEntry[];
    dueLog: DueLogEntry[];
    lang: SupportedLang;
}

// YYYY-MM-DD local helpers
function msToDateKey(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateKeyToMs(s: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
}

type Preset = 7 | 30 | 90 | 'all';

const AIExportModal: React.FC<Props> = ({
    isOpen, onClose, events, labResults, plans, basicInfo,
    postponeLog, dueLog, lang,
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const dialogRef = useFocusTrap(isOpen, onClose);
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [activePreset, setActivePreset] = useState<Preset | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

    // Initialize defaults on open: today - 30d ~ today, preset 30 highlighted.
    useEffect(() => {
        if (!isOpen) return;
        const now = new Date();
        const todayKey = msToDateKey(now.getTime());
        const thirtyDaysAgoKey = msToDateKey(now.getTime() - 30 * 86_400_000);
        setStartDate(thirtyDaysAgoKey);
        setEndDate(todayKey);
        setActivePreset(30);
        setPreviewOpen(false);
        setCopyState('idle');
    }, [isOpen]);

    const setPreset = (preset: Preset) => {
        const now = new Date();
        const todayKey = msToDateKey(now.getTime());
        if (preset === 'all') {
            // For 'all', use earliest event/lab date as start (or 1 year ago as fallback)
            let startMs = now.getTime() - 365 * 86_400_000;
            for (const e of events) {
                const ms = e.timeH * 3600_000;
                if (isFinite(ms) && ms < startMs) startMs = ms;
            }
            for (const l of labResults) {
                const ms = l.timeH * 3600_000;
                if (isFinite(ms) && ms < startMs) startMs = ms;
            }
            setStartDate(msToDateKey(startMs));
            setEndDate(todayKey);
            setActivePreset('all');
            return;
        }
        const days = preset;
        const endMs = now.getTime();
        const startMs = endMs - days * 86_400_000;
        setStartDate(msToDateKey(startMs));
        setEndDate(todayKey);
        setActivePreset(preset);
    };

    const dateRangeInvalid = !!startDate && !!endDate
        && isFinite(dateKeyToMs(startDate))
        && isFinite(dateKeyToMs(endDate))
        && dateKeyToMs(startDate) > dateKeyToMs(endDate);

    const hasData = events.length > 0 || labResults.length > 0;

    // Generate text — memoized on every relevant input.
    const generated = useMemo(() => {
        if (!startDate || !endDate) return null;
        if (dateRangeInvalid) return null;
        return buildAITextExport({
            events, labResults, plans, basicInfo, postponeLog, dueLog,
            rangeStart: startDate, rangeEnd: endDate, lang,
            exportedAt: new Date(),
        });
    }, [events, labResults, plans, basicInfo, postponeLog, dueLog, startDate, endDate, lang, dateRangeInvalid]);

    const handleCopy = async () => {
        if (!generated) return;
        if (generated.tooLarge) {
            await showDialog('alert', t('aiExport.tooLarge'));
            return;
        }
        try {
            if (!isTauri) {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(generated.text);
                } else {
                    throw new Error('clipboard not supported');
                }
            } else {
                await invoke('clipboard_write_text', { text: generated.text });
            }
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 2000);
        } catch (err: unknown) {
            let msg = 'unknown';
            if (err instanceof Error) msg = err.message;
            else if (typeof err === 'string') msg = err;
            else msg = JSON.stringify(err);
            await showDialog('alert', `${t('aiExport.error')}: ${msg}`);
        }
    };

    if (!isOpen) return null;

    const canCopy = hasData && !dateRangeInvalid && !!generated && !generated.tooLarge;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="ai-export-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                {/* Header */}
                <div className="flex justify-between items-center mb-5 shrink-0">
                    <h3 id="ai-export-modal-title" className="text-xl font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <Bot size={20} style={{ color: 'var(--accent-500)' }} />
                        {t('aiExport.title')}
                    </h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
                    {t('aiExport.desc')}
                </p>

                <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-4">
                    {/* Date range card */}
                    <div className="rounded-2xl p-4 flex flex-col gap-3"
                        style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                        <div className="flex items-center gap-2">
                            <Calendar size={16} style={{ color: 'var(--accent-500)' }} />
                            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                                {t('aiExport.rangeLabel')}
                            </span>
                        </div>

                        <div className="flex gap-3 items-end flex-wrap">
                            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                                <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('aiExport.rangeFrom')}
                                </label>
                                <input
                                    type="date"
                                    value={startDate}
                                    onChange={(e) => { setStartDate(e.target.value); setActivePreset(null); }}
                                    className="rounded-lg px-3 py-2 text-sm font-medium outline-none transition"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: `1px solid ${dateRangeInvalid ? '#ef4444' : 'var(--border-primary)'}`,
                                        colorScheme: 'light dark',
                                    }}
                                />
                            </div>
                            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                                <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('aiExport.rangeTo')}
                                </label>
                                <input
                                    type="date"
                                    value={endDate}
                                    onChange={(e) => { setEndDate(e.target.value); setActivePreset(null); }}
                                    className="rounded-lg px-3 py-2 text-sm font-medium outline-none transition"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: `1px solid ${dateRangeInvalid ? '#ef4444' : 'var(--border-primary)'}`,
                                        colorScheme: 'light dark',
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex gap-2 flex-wrap">
                            {([7, 30, 90, 'all'] as Preset[]).map(p => (
                                <button
                                    key={String(p)}
                                    type="button"
                                    onClick={() => setPreset(p)}
                                    data-testid={`preset-${p}`}
                                    className="px-2.5 py-1 rounded-md text-xs font-semibold transition btn-press-glass"
                                    style={{
                                        background: activePreset === p ? 'var(--accent-500)' : 'var(--bg-card)',
                                        color: activePreset === p ? 'white' : 'var(--text-secondary)',
                                        border: `1px solid ${activePreset === p ? 'var(--accent-500)' : 'var(--border-primary)'}`,
                                    }}
                                >
                                    {p === 'all'
                                        ? t('aiExport.rangeAll')
                                        : t(`aiExport.range${p}d` as 'aiExport.range7d' | 'aiExport.range30d' | 'aiExport.range90d')}
                                </button>
                            ))}
                        </div>

                        {dateRangeInvalid && (
                            <p className="text-xs" style={{ color: '#ef4444' }}>
                                {t('aiExport.rangeInvalid')}
                            </p>
                        )}
                    </div>

                    {/* Preview card */}
                    {generated && (
                        <div className="rounded-2xl p-4 flex flex-col gap-2"
                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                            <button
                                type="button"
                                onClick={() => setPreviewOpen(v => !v)}
                                className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider w-full justify-between"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                <span>{t('aiExport.previewLabel')}</span>
                                {previewOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                            {previewOpen && (
                                <pre
                                    data-testid="ai-export-preview"
                                    className="text-[11px] leading-relaxed overflow-auto max-h-64 p-3 rounded-lg whitespace-pre-wrap break-words"
                                    style={{
                                        background: 'var(--bg-card)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--border-primary)',
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                    }}
                                >
                                    {generated.text}
                                </pre>
                            )}
                        </div>
                    )}

                    {/* Too-large warning */}
                    {generated?.tooLarge && (
                        <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm"
                            style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                            <AlertTriangle size={16} />
                            {t('aiExport.tooLarge')}
                        </div>
                    )}

                    {/* Empty data notice */}
                    {!hasData && (
                        <p className="text-center text-sm py-2" style={{ color: 'var(--text-tertiary)' }}>
                            {t('aiExport.empty')}
                        </p>
                    )}
                </div>

                {/* Footer */}
                <div className="mt-5 shrink-0">
                    <button
                        type="button"
                        onClick={handleCopy}
                        disabled={!canCopy}
                        data-testid="ai-export-copy-btn"
                        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-bold transition glass-btn-primary btn-press-glass disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Clipboard size={18} />
                        {copyState === 'copied' ? t('aiExport.copied') : t('aiExport.copy')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AIExportModal;