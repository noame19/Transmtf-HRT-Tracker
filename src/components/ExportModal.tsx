import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { QRCodeCanvas } from 'qrcode.react';
import { encryptData, DoseEvent, LabResult } from '../../logic';
import { X, QrCode, Download, Lock, Copy } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

const ExportModal = ({ isOpen, onClose, onExport, events, labResults, weight }: { isOpen: boolean, onClose: () => void, onExport: (encrypt: boolean) => void, events: DoseEvent[], labResults: LabResult[], weight: number }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<'qr' | 'json'>('qr');
    const [isEncrypted, setIsEncrypted] = useState(false);
    const [displayData, setDisplayData] = useState("");
    const [password, setPassword] = useState("");
    const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

    const hasData = events.length > 0 || labResults.length > 0;
    const rawDataString = useMemo(() => hasData ? JSON.stringify({ weight, events, labResults }) : '', [events, weight, labResults, hasData]);
    const QR_CHAR_LIMIT = 1500; // guard against oversized payloads that crash QR generator
    const isTooLargeForQr = displayData.length > QR_CHAR_LIMIT;

    useEffect(() => {
                if (!isOpen) {
            setIsEncrypted(false);
            setActiveTab('qr');
        }
    }, [isOpen]);

    useEffect(() => {
        let active = true;
        const update = async () => {
            if (!isOpen || !rawDataString) {
                if (active) setDisplayData("");
                return;
            }
            if (isEncrypted) {
                const { data, password: pw } = await encryptData(rawDataString);
                if (active) {
                    setDisplayData(data);
                    setPassword(pw);
                }
            } else {
                if (active) {
                    setDisplayData(rawDataString);
                    setPassword("");
                }
            }
        };
        update();
        return () => { active = false; };
    }, [isOpen, isEncrypted, rawDataString]);

    const handleCopy = async () => {
        if (!displayData) return;
        try {
            await navigator.clipboard.writeText(displayData);
            setCopyState('copied');
            setTimeout(() => setCopyState('idle'), 2000);
        } catch (err) {
            console.error(err);
        }
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
                aria-labelledby="export-modal-title"
                className="rounded-t-3xl md:rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-slide-up-glass md:modal-spring-glass md:animate-none safe-area-pb glass-modal glass-noise glass-highlight"
            >
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 id="export-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{t('export.title')}</h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <div className="flex p-1 rounded-xl mb-6 shrink-0" style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-secondary)' }}>
                    <button
                        onClick={() => setActiveTab('qr')}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-2 ${activeTab === 'qr' ? 'shadow-sm' : ''}`}
                        style={activeTab === 'qr' ? { background: 'var(--bg-card)', color: 'var(--text-primary)' } : { color: 'var(--text-tertiary)' }}
                    >
                        <QrCode size={16} />
                        QR Code
                    </button>
                    <button
                        onClick={() => setActiveTab('json')}
                        className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-2 ${activeTab === 'json' ? 'shadow-sm' : ''}`}
                        style={activeTab === 'json' ? { background: 'var(--bg-card)', color: 'var(--text-primary)' } : { color: 'var(--text-tertiary)' }}
                    >
                        <Download size={16} />
                        JSON
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                    {activeTab === 'qr' && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'var(--bg-card-hover)' }}>
                                <label id="encrypt-label" className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{t('qr.encrypt_label')}</label>
                                <button
                                    role="switch"
                                    aria-checked={isEncrypted}
                                    aria-labelledby="encrypt-label"
                                    onClick={() => setIsEncrypted(!isEncrypted)}
                                    className={`w-10 h-6 rounded-full p-1 cursor-pointer transition-colors border-0 outline-none focus:ring-2 focus:ring-pink-300 ${isEncrypted ? 'bg-pink-400' : 'bg-gray-300'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${isEncrypted ? 'translate-x-4' : ''}`} aria-hidden="true" />
                                </button>
                            </div>

                            {displayData && !isTooLargeForQr ? (
                                <div className="flex flex-col items-center gap-4">
                                    <div className="p-4 rounded-2xl border relative" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-secondary)' }}>
                                        <QRCodeCanvas value={displayData} size={200} includeMargin level="M" />
                                        {isEncrypted && (
                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                <Lock className="text-pink-400/20 w-24 h-24" />
                                            </div>
                                        )}
                                    </div>
                                    
                                    {isEncrypted && password && (
                                        <div className="w-full p-3 rounded-xl text-center" style={{ background: 'var(--accent-50)', border: '1px solid var(--accent-200)' }}>
                                            <p className="text-xs font-bold uppercase mb-1" style={{ color: 'var(--accent-400)' }}>{t('export.password_title')}</p>
                                            <p className="font-mono font-bold text-lg select-all" style={{ color: 'var(--text-primary)' }}>{password}</p>
                                        </div>
                                    )}

                                    <div aria-live="polite" aria-atomic="true" className="sr-only">
                                        {copyState === 'copied' ? t('qr.copied') : ''}
                                    </div>

                                    <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-2">
                                        <button
                                            onClick={handleCopy}
                                            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white text-sm font-bold transition glass-btn-primary btn-press-glass"
                                        >
                                            <Copy size={16} /> {copyState === 'copied' ? t('qr.copied') : t('qr.copy')}
                                        </button>
                                        <button
                                            onClick={() => onExport(isEncrypted)}
                                            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border text-sm font-bold transition btn-press-glass"
                                            style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
                                        >
                                            <Download size={16} /> {t('export.title')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-8 space-y-3" style={{ color: 'var(--text-secondary)' }}>
                                    {isTooLargeForQr ? (
                                        <div className="mx-auto max-w-md text-sm rounded-xl p-4 space-y-3"
                                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }}>
                                            <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t('qr.too_large')}</p>
                                            <p className="text-sm">{t('qr.too_large_desc') || t('drawer.save_hint')}</p>
                                            <div className="flex flex-col gap-2">
                                                <button
                                                    onClick={handleCopy}
                                                    className="inline-flex items-center justify-center px-3.5 py-2.5 rounded-lg text-white text-sm font-bold transition glass-btn-primary btn-press-glass"
                                                >
                                                    <Copy size={16} /> {copyState === 'copied' ? t('qr.copied') : t('qr.copy')}
                                                </button>
                                                <button
                                                    onClick={() => setActiveTab('json')}
                                                    className="inline-flex items-center justify-center px-3.5 py-2.5 rounded-lg text-sm font-bold transition"
                                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                                >
                                                    {t('qr.go_json')}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <p>{t('qr.export.empty')}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'json' && (
                        <div className="space-y-3">
                            <button onClick={() => onExport(false)} className="w-full py-4 border font-bold rounded-xl transition flex items-center justify-center gap-2 btn-press-glass"
                                style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                                <Download size={20} />
                                JSON
                            </button>
                            <button onClick={() => onExport(true)} className="w-full py-4 border font-bold rounded-xl transition flex items-center justify-center gap-2 btn-press-glass"
                                style={{ background: 'var(--accent-50)', borderColor: 'var(--accent-200)', color: 'var(--accent-600)' }}>
                                <Lock size={20} />
                                JSON ({t('qr.encrypt_label')})
                            </button>
                            <p className="text-xs text-center mt-4 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                                {t('drawer.save_hint')}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ExportModal;
