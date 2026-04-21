import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { AlertTriangle } from 'lucide-react';

const DisclaimerModal = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
    const { t } = useTranslation();

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-[60] animate-in fade-in duration-200 p-4"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div className="rounded-3xl w-full max-w-lg p-6 md:p-8 modal-spring-glass glass-modal">
                <div className="flex flex-col items-center mb-4">
                    <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                        <AlertTriangle className="text-amber-500" size={24} />
                    </div>
                    <h3 className="text-xl font-bold text-center" style={{ color: 'var(--text-primary)' }}>{t('disclaimer.title')}</h3>
                </div>

                <div className="text-sm space-y-3 mb-8 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    <p>{t('disclaimer.text.intro')}</p>
                    <ul className="list-disc pl-5 space-y-2">
                         <li>{t('disclaimer.text.point1')}</li>
                         <li>{t('disclaimer.text.point2')}</li>
                         <li>{t('disclaimer.text.point3')}</li>
                    </ul>
                </div>

                <button
                    onClick={onClose}
                    className="w-full py-3.5 text-white font-bold rounded-xl btn-press-glass transition glass-btn-primary"
                >
                    {t('btn.ok')}
                </button>
            </div>
        </div>
    );
};

export default DisclaimerModal;

