import React, { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';

const PasswordInputModal = ({ isOpen, onClose, onConfirm }: { isOpen: boolean, onClose: () => void, onConfirm: (pw: string) => void }) => {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");

    useEffect(() => {
        if (isOpen) setPassword("");
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-[60] animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div className="rounded-3xl w-full max-w-lg md:max-w-xl p-6 md:p-8 modal-spring-glass safe-area-pb glass-modal">
                <h3 className="text-xl font-semibold mb-2 text-center" style={{ color: 'var(--text-primary)' }}>{t('import.password_title')}</h3>
                <p className="text-sm mb-6 text-center" style={{ color: 'var(--text-secondary)' }}>{t('import.password_desc')}</p>

                <input
                    type="text"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono text-center text-lg mb-6"
                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                    placeholder="..."
                    autoFocus
                />

                <div className="flex gap-3">
                    <button onClick={onClose} className="flex-1 py-3.5 font-bold rounded-xl transition"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}>{t('btn.cancel')}</button>
                    <button
                        onClick={() => onConfirm(password)}
                        disabled={!password}
                        className="flex-1 py-3.5 text-white font-bold rounded-xl transition disabled:opacity-50 glass-btn-primary btn-press-glass"
                    >
                        {t('btn.ok')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PasswordInputModal;
