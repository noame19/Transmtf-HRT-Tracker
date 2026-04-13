import React, { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { LabResult } from '../logic';
import { X, Calendar, Activity, TestTube, FileText, Trash2, Check, FlaskConical } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface LabResultModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (result: LabResult) => void;
    onDelete?: (id: string) => void;
    resultToEdit?: LabResult | null;
}

const LabResultModal = ({ isOpen, onClose, onSave, onDelete, resultToEdit }: LabResultModalProps) => {
    const { t } = useTranslation();
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const [value, setValue] = useState("");
    const [unit, setUnit] = useState<'pg/ml' | 'pmol/l'>('pmol/l');
    const [note, setNote] = useState("");

    useEffect(() => {
        if (isOpen) {
            const toLocalDate = (d: Date) => {
                const pad = (n: number) => n.toString().padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            };
            const toLocalTime = (d: Date) => {
                const pad = (n: number) => n.toString().padStart(2, '0');
                return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            };

            if (resultToEdit) {
                const d = new Date(resultToEdit.timeH * 3600000);
                setDate(toLocalDate(d));
                setTime(toLocalTime(d));
                setValue(resultToEdit.concValue.toString());
                setUnit(resultToEdit.unit);
            } else {
                const now = new Date();
                setDate(toLocalDate(now));
                setTime(toLocalTime(now));
                setValue("");
                setUnit('pmol/l');
                setNote("");
            }
        }
    }, [isOpen, resultToEdit]);

    const handleSave = () => {
        if (!date || !time || !value) return;
        
        const dateTimeStr = `${date}T${time}`;
        const timeH = new Date(dateTimeStr).getTime() / 3600000;
        const numValue = parseFloat(value);

        if (isNaN(numValue) || numValue < 0) return;

        const newResult: LabResult = {
            id: resultToEdit?.id || uuidv4(),
            timeH,
            concValue: numValue,
            unit
        };

        onSave(newResult);
        onClose();
    };

    const handleDelete = () => {
        if (resultToEdit && onDelete) {
            onDelete(resultToEdit.id);
            onClose();
        }
    };

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-end md:items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="lab-modal-title"
                className="rounded-t-3xl md:rounded-3xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] md:max-h-[85vh] modal-slide-up md:modal-spring md:animate-none"
                style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border-primary)' }}
            >
                {/* Header */}
                <div className="px-6 py-4 border-b flex items-center justify-between shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <h2 id="lab-modal-title" className="text-lg font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <FlaskConical className="text-teal-500" size={20} />
                        {resultToEdit ? t('lab.edit_title') : t('lab.add_title')}
                    </h2>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition-colors"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 overflow-y-auto space-y-6">
                    {/* Date & Time */}
                    <div className="space-y-3">
                        <label className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <Calendar size={16} style={{ color: 'var(--text-tertiary)' }} />
                            {t('lab.date')}
                        </label>
                        <div className="flex gap-3">
                            <input
                                type="date"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                className="flex-1 text-sm rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent block w-full p-3 font-medium"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                            <input
                                type="time"
                                value={time}
                                onChange={(e) => setTime(e.target.value)}
                                className="w-32 text-sm rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent block p-3 font-medium text-center"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                        </div>
                    </div>

                    {/* Value & Unit */}
                    <div className="space-y-3">
                        <label className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                            <Activity size={16} style={{ color: 'var(--text-tertiary)' }} />
                            {t('lab.value')}
                        </label>
                        <div className="flex gap-3">
                            <div className="relative flex-1">
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    placeholder="0.0"
                                    value={value}
                                    onChange={(e) => setValue(e.target.value)}
                                    className="text-lg rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-transparent block w-full p-3 font-bold"
                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                />
                            </div>
                            <div className="flex rounded-xl p-1" style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                                <button
                                    onClick={() => setUnit('pmol/l')}
                                    className={`px-3 py-2 rounded-lg text-xs font-bold transition-all`}
                                    style={unit === 'pmol/l' ? { background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', color: 'var(--accent-500)' } : { color: 'var(--text-tertiary)' }}
                                >
                                    pmol/L
                                </button>
                                <button
                                    onClick={() => setUnit('pg/ml')}
                                    className={`px-3 py-2 rounded-lg text-xs font-bold transition-all`}
                                    style={unit === 'pg/ml' ? { background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', color: 'var(--accent-500)' } : { color: 'var(--text-tertiary)' }}
                                >
                                    pg/mL
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t flex gap-3 shrink-0 safe-area-pb"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    {resultToEdit && onDelete && (
                        <button
                            onClick={handleDelete}
                            aria-label={t('btn.delete')}
                            className="p-4 text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-xl transition-colors"
                        >
                            <Trash2 size={20} />
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={!value || !date || !time}
                        className="flex-1 text-white font-bold py-4 rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:scale-100 accent-bg-gradient"
                    >
                        <Check size={20} />
                        {t('btn.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LabResultModal;

