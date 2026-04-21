import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { X, Upload } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const ImportModal = ({ isOpen, onClose, onImportJson }: { isOpen: boolean; onClose: () => void; onImportJson: (text: string) => Promise<boolean> }) => {
    const { t } = useTranslation();
    const [text, setText] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setText("");
        }
    }, [isOpen]);

    const handleJsonFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const content = reader.result as string;
            if (await onImportJson(content)) {
                onClose();
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    const handleTextImport = async () => {
        if (await onImportJson(text)) {
            onClose();
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
                aria-labelledby="import-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 id="import-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{t('import.title')}</h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>{t('import.text')}</label>
                            <textarea
                                className="w-full h-32 p-3 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono text-xs"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                placeholder={t('import.paste_hint')}
                                value={text}
                                onChange={e => setText(e.target.value)}
                            />
                            <button
                                onClick={handleTextImport}
                                disabled={!text.trim()}
                                className="mt-2 w-full py-3 text-white font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition glass-btn-primary btn-press-glass"
                            >
                                {t('drawer.import')}
                            </button>
                        </div>

                        <div className="relative flex py-2 items-center">
                            <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
                            <span className="flex-shrink-0 mx-4 text-xs uppercase font-bold" style={{ color: 'var(--text-tertiary)' }}>OR</span>
                            <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
                        </div>

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full py-3 border-2 border-dashed font-bold rounded-xl transition flex items-center justify-center gap-2"
                            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                        >
                            <Upload size={20} />
                            {t('import.file_btn')}
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/json"
                            className="hidden"
                            onChange={handleJsonFileChange}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ImportModal;
