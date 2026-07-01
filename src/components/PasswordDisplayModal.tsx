import React, { useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { invoke } from '@tauri-apps/api/core';
import { Copy } from 'lucide-react';

const PasswordDisplayModal = ({ isOpen, onClose, password }: { isOpen: boolean, onClose: () => void, password: string }) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await invoke('clipboard_write_text', { text: password });
        } catch (err) {
            console.error('clipboard write failed:', err);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-[60] animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div className="rounded-3xl w-full max-w-lg md:max-w-xl p-6 md:p-8 modal-spring-glass safe-area-pb glass-modal">
                <h3 className="text-xl font-semibold mb-2 text-center" style={{ color: 'var(--text-primary)' }}>{t('export.password_title')}</h3>
                <p className="text-sm mb-6 text-center" style={{ color: 'var(--text-secondary)' }}>{t('export.password_desc')}</p>

                <div className="p-4 rounded-xl mb-6 flex items-center justify-between"
                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                    <span className="font-mono text-lg font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>{password}</span>
                    <button onClick={handleCopy} className="p-2 rounded-lg transition" style={{ color: 'var(--text-secondary)' }}>
                        {copied ? <span className="text-xs font-bold text-green-600 dark:text-green-400">{t('qr.copied')}</span> : <Copy size={20} />}
                    </button>
                </div>

                <button onClick={onClose} className="w-full py-3.5 text-white font-bold rounded-xl transition glass-btn-primary btn-press-glass">
                    {t('btn.ok')}
                </button>
            </div>
        </div>
    );
};

export default PasswordDisplayModal;
