import React, { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { Info } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const WeightEditorModal = ({ isOpen, onClose, currentWeight, onSave }: any) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const [weightStr, setWeightStr] = useState(currentWeight.toString());
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => setWeightStr(currentWeight.toString()), [currentWeight, isOpen]);

    const handleSave = () => {
        if (isSaving) return;
        setIsSaving(true);
        const val = parseFloat(weightStr);
        if (!isNaN(val) && val > 0) {
            onSave(val);
            onClose();
        } else {
            showDialog('alert', t('error.nonPositive'));
            setIsSaving(false);
        }
        setIsSaving(false);
    };

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-end md:items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(16px) saturate(180%)', WebkitBackdropFilter: 'blur(16px) saturate(180%)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="weight-modal-title"
                className="rounded-t-3xl md:rounded-3xl w-full max-w-lg md:max-w-xl p-6 md:p-8 modal-slide-up-glass md:modal-spring-glass md:animate-none safe-area-pb glass-modal glass-noise glass-highlight"
            >
                <div className="flex justify-between items-center mb-6">
                    <h3 id="weight-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{t('modal.weight.title')}</h3>
                </div>

                <div className="flex justify-center mb-8">
                    <div className="relative flex flex-col items-center">
                        <input
                            type="number"
                            inputMode="decimal"
                            value={weightStr}
                            onChange={(e) => setWeightStr(e.target.value)}
                            className="text-5xl font-black tabular-nums w-48 text-center bg-transparent border-b-2 outline-none transition-colors pb-2"
                            style={{ color: 'var(--accent-400)', borderColor: 'var(--accent-200)' }}
                            onFocus={e => e.target.style.borderColor = 'var(--accent-400)'}
                            onBlur={e => e.target.style.borderColor = 'var(--accent-200)'}
                            placeholder="0.0"
                            autoFocus
                        />
                        <div className="text-sm font-medium mt-2" style={{ color: 'var(--text-tertiary)' }}>kg</div>
                    </div>
                </div>

                <div className="p-4 rounded-xl mb-6 flex gap-3 items-start"
                    style={{ background: 'var(--accent-50)', border: '1px solid var(--accent-200)' }}>
                    <Info className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--accent-500)' }} />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--accent-600)' }}>
                        {t('modal.weight.desc')}
                    </p>
                </div>
                <div className="flex gap-3">
                    <button onClick={onClose} className="flex-1 py-3.5 font-bold rounded-xl btn-press-glass transition"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>{t('btn.cancel')}</button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        aria-busy={isSaving}
                        className={`flex-1 py-3.5 text-white font-bold rounded-xl btn-press-glass transition glass-btn-primary ${isSaving ? 'opacity-70 cursor-not-allowed' : ''}`}
                    >
                        {isSaving ? (
                            <span className="flex items-center justify-center gap-2">
                                <span className="accent-spinner" />
                                {t('btn.save')}
                            </span>
                        ) : (
                            t('btn.save')
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default WeightEditorModal;
