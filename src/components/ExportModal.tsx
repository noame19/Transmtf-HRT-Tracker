import React, { useState, useMemo } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { DoseEvent, LabResult } from '../../logic';
import { X, Download, Copy } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const ExportModal = ({ isOpen, onClose, onExport, events, labResults, weight }: { isOpen: boolean, onClose: () => void, onExport: (encrypt: boolean) => void, events: DoseEvent[], labResults: LabResult[], weight: number }) => {
    const { t } = useTranslation();
    const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

    const hasData = events.length > 0 || labResults.length > 0;
    const rawDataString = useMemo(() => hasData ? JSON.stringify({ weight, events, labResults }) : '', [events, weight, labResults, hasData]);

    const handleCopy = async () => {
        if (!rawDataString) return;
        try {
            await navigator.clipboard.writeText(rawDataString);
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 2000);
        } catch (err) {
            console.error(err);
        }
    };

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 id="export-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{t('export.title')}</h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                    <div className="space-y-3">
                        {hasData ? (
                            <>
                                <button onClick={() => onExport(false)} className="w-full py-4 border font-bold rounded-xl transition flex items-center justify-center gap-2 btn-press-glass"
                                    style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                                    <Download size={20} />
                                    {t('export.title')} JSON
                                </button>
                                <button onClick={handleCopy} className="w-full py-4 border font-bold rounded-xl transition flex items-center justify-center gap-2 btn-press-glass"
                                    style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                                    <Copy size={20} />
                                    {copyState === 'copied' ? t('qr.copied') : t('qr.copy')}
                                </button>
                            </>
                        ) : (
                            <p className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>{t('qr.export.empty')}</p>
                        )}
                        <p className="text-xs text-center mt-4 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                            {t('drawer.save_hint')}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ExportModal;
