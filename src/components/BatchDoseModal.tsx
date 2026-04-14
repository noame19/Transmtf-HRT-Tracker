import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import CustomSelect from './CustomSelect';
import { getRouteIcon } from '../utils/helpers';
import { Route, Ester, ExtraKey, DoseEvent, getToE2Factor } from '../../logic';
import { Layers, X, ChevronRight, ChevronLeft, AlertTriangle, Pencil, Check, Trash2, Plus, Calendar } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface BatchDoseModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveBatch: (events: DoseEvent[]) => void;
}

const DEFAULT_TIMES = ['09:00', '21:00', '14:00', '18:00'];

const toLocalDateStr = (d: Date) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const BatchDoseModal: React.FC<BatchDoseModalProps> = ({ isOpen, onClose, onSaveBatch }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();

    // Step: 'config' | 'preview'
    const [step, setStep] = useState<'config' | 'preview'>('config');

    // Drug params
    const [route, setRoute] = useState<Route>(Route.injection);
    const [ester, setEster] = useState<Ester>(Ester.EV);
    const [doseStr, setDoseStr] = useState('');

    // Schedule params
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [intervalDaysStr, setIntervalDaysStr] = useState('1');
    const [timesPerDayStr, setTimesPerDayStr] = useState('1');
    const intervalDays = Math.max(1, parseInt(intervalDaysStr) || 1);
    const timesPerDay = Math.max(1, Math.min(4, parseInt(timesPerDayStr) || 1));
    const [timeSlots, setTimeSlots] = useState<string[]>([DEFAULT_TIMES[0]]);

    // Preview state
    const [previewEvents, setPreviewEvents] = useState<DoseEvent[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editDate, setEditDate] = useState('');
    const [editTime, setEditTime] = useState('');
    const [editDose, setEditDose] = useState('');

    // Available esters based on route
    const availableEsters = useMemo(() => {
        switch (route) {
            case Route.injection: return [Ester.EB, Ester.EV, Ester.EC, Ester.EN];
            case Route.oral: return [Ester.E2, Ester.EV, Ester.CPA];
            case Route.sublingual: return [Ester.E2, Ester.EV];
            default: return [Ester.E2];
        }
    }, [route]);

    // Reset form when modal opens
    useEffect(() => {
        if (isOpen) {
            setStep('config');
            const now = new Date();
            const thirtyDaysAgo = new Date(now);
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            setStartDate(toLocalDateStr(thirtyDaysAgo));
            setEndDate(toLocalDateStr(now));
            setIntervalDaysStr('1');
            setTimesPerDayStr('1');
            setTimeSlots([DEFAULT_TIMES[0]]);
            setRoute(Route.injection);
            setEster(Ester.EV);
            setDoseStr('');
            setPreviewEvents([]);
            setEditingId(null);
        }
    }, [isOpen]);

    // Sync ester when route changes
    useEffect(() => {
        if (!availableEsters.includes(ester)) {
            setEster(availableEsters[0]);
        }
    }, [availableEsters, ester]);

    // Sync time slots count when timesPerDay changes
    useEffect(() => {
        setTimeSlots(prev => {
            const copy = [...prev];
            while (copy.length < timesPerDay) {
                copy.push(DEFAULT_TIMES[copy.length] || '12:00');
            }
            return copy.slice(0, timesPerDay);
        });
    }, [timesPerDay]);

    const updateTimeSlot = (index: number, value: string) => {
        setTimeSlots(prev => {
            const copy = [...prev];
            copy[index] = value;
            return copy;
        });
    };

    // Generate preview events
    const generatePreview = () => {
        const dose = parseFloat(doseStr);
        if (!Number.isFinite(dose) || dose <= 0) {
            showDialog('alert', t('error.nonPositive'));
            return;
        }
        if (!startDate || !endDate) return;

        const start = new Date(startDate);
        const end = new Date(endDate);
        if (start > end) return;

        // For EV injection/sublingual/oral, store compound dose; user enters compound dose
        const factor = getToE2Factor(ester) || 1;
        const finalDoseMG = ester === Ester.E2 ? dose : dose; // doseStr is compound dose

        const events: DoseEvent[] = [];
        const current = new Date(start);

        while (current <= end) {
            for (const slot of timeSlots) {
                const [hh, mm] = slot.split(':').map(Number);
                const eventDate = new Date(current);
                eventDate.setHours(hh, mm, 0, 0);

                const timeH = eventDate.getTime() / 3600000;
                events.push({
                    id: uuidv4(),
                    route,
                    ester: (route === Route.patchApply || route === Route.patchRemove || route === Route.gel) ? Ester.E2 : ester,
                    timeH,
                    doseMG: finalDoseMG,
                    extras: {},
                });
            }
            current.setDate(current.getDate() + intervalDays);
        }

        setPreviewEvents(events);
        setStep('preview');
    };

    // Start editing a preview event
    const startEdit = (ev: DoseEvent) => {
        const d = new Date(ev.timeH * 3600000);
        setEditingId(ev.id);
        setEditDate(toLocalDateStr(d));
        const pad = (n: number) => n.toString().padStart(2, '0');
        setEditTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
        setEditDose(ev.doseMG.toString());
    };

    // Confirm inline edit
    const confirmEdit = (id: string) => {
        const dose = parseFloat(editDose);
        if (!Number.isFinite(dose) || dose <= 0) return;
        const dateTime = new Date(`${editDate}T${editTime}`);
        if (isNaN(dateTime.getTime())) return;

        setPreviewEvents(prev => prev.map(ev => {
            if (ev.id !== id) return ev;
            return { ...ev, timeH: dateTime.getTime() / 3600000, doseMG: dose };
        }));
        setEditingId(null);
    };

    // Remove one preview event
    const removePreviewEvent = (id: string) => {
        setPreviewEvents(prev => prev.filter(ev => ev.id !== id));
    };

    // Final save
    const handleConfirm = async () => {
        if (previewEvents.length === 0) return;
        const result = await showDialog('confirm', t('batch.warning'));
        if (result === 'confirm') {
            onSaveBatch(previewEvents);
            onClose();
        }
    };

    // Group preview events by date for display
    const groupedPreview = useMemo(() => {
        const sorted = [...previewEvents].sort((a, b) => a.timeH - b.timeH);
        const groups: { date: string; events: DoseEvent[] }[] = [];
        let currentGroup: { date: string; events: DoseEvent[] } | null = null;

        sorted.forEach(ev => {
            const d = new Date(ev.timeH * 3600000);
            const dateStr = toLocalDateStr(d);
            if (!currentGroup || currentGroup.date !== dateStr) {
                currentGroup = { date: dateStr, events: [] };
                groups.push(currentGroup);
            }
            currentGroup.events.push(ev);
        });

        return groups;
    }, [previewEvents]);

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    const routeOptions = [Route.injection, Route.oral, Route.sublingual].map(r => ({
        value: r,
        label: t(`route.${r}`),
        icon: getRouteIcon(r),
    }));

    const esterOptions = availableEsters.map(e => ({
        value: e,
        label: t(`ester.${e}`),
    }));

    const inputStyle: React.CSSProperties = {
        background: 'var(--bg-card-hover)',
        border: '1px solid var(--border-primary)',
        color: 'var(--text-primary)',
    };

    const labelStyle: React.CSSProperties = {
        color: 'var(--text-secondary)',
    };

    return (
        <div
            className="fixed inset-0 flex items-end md:items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="batch-modal-title"
                className="relative rounded-t-3xl md:rounded-3xl w-full max-w-lg md:max-w-2xl h-[92vh] md:max-h-[85vh] flex flex-col overflow-hidden modal-slide-up md:modal-spring md:animate-none"
                style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border-primary)' }}
            >
                {/* Header */}
                <div className="p-5 md:p-6 border-b flex justify-between items-center shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center accent-bg-gradient">
                            <Layers size={16} className="text-white" />
                        </div>
                        <div>
                            <h3 id="batch-modal-title" className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                                {t('batch.title')}
                            </h3>
                            <div className="flex items-center gap-2 mt-0.5">
                                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${step === 'config' ? 'text-white' : ''}`}
                                    style={step === 'config' ? { background: 'var(--accent-500)' } : { color: 'var(--text-tertiary)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                                    1. {t('batch.step_config')}
                                </span>
                                <ChevronRight size={12} style={{ color: 'var(--text-tertiary)' }} />
                                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${step === 'preview' ? 'text-white' : ''}`}
                                    style={step === 'preview' ? { background: 'var(--accent-500)' } : { color: 'var(--text-tertiary)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                                    2. {t('batch.step_preview')}
                                </span>
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 md:p-6 space-y-5">
                    {step === 'config' && (
                        <>
                            {/* Drug params */}
                            <CustomSelect
                                label={t('field.route')}
                                value={route}
                                onChange={(val) => setRoute(val as Route)}
                                options={routeOptions}
                            />

                            {availableEsters.length > 1 && (
                                <CustomSelect
                                    label={t('field.ester')}
                                    value={ester}
                                    onChange={(val) => setEster(val as Ester)}
                                    options={esterOptions}
                                />
                            )}

                            <div className="space-y-2">
                                <label className="block text-sm font-bold" style={labelStyle}>
                                    {t('batch.dose')} (mg)
                                </label>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="0.001"
                                    value={doseStr}
                                    onChange={e => setDoseStr(e.target.value)}
                                    className="w-full p-4 rounded-xl focus:ring-2 focus:ring-[var(--accent-300)] outline-none font-mono"
                                    style={inputStyle}
                                    placeholder="0.0"
                                />
                            </div>

                            {/* Separator */}
                            <div className="relative flex items-center py-1">
                                <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }} />
                                <span className="mx-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                    <Calendar size={12} className="inline mr-1" />{t('batch.step_config')}
                                </span>
                                <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }} />
                            </div>

                            {/* Schedule params */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="block text-xs font-bold" style={labelStyle}>{t('batch.start_date')}</label>
                                    <input
                                        type="date"
                                        value={startDate}
                                        onChange={e => setStartDate(e.target.value)}
                                        className="w-full p-3 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={inputStyle}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="block text-xs font-bold" style={labelStyle}>{t('batch.end_date')}</label>
                                    <input
                                        type="date"
                                        value={endDate}
                                        onChange={e => setEndDate(e.target.value)}
                                        className="w-full p-3 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={inputStyle}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="block text-xs font-bold" style={labelStyle}>{t('batch.interval')}</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="365"
                                        value={intervalDaysStr}
                                        onChange={e => setIntervalDaysStr(e.target.value)}
                                        onBlur={() => setIntervalDaysStr(String(intervalDays))}
                                        className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={inputStyle}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="block text-xs font-bold" style={labelStyle}>{t('batch.times_per_day')}</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="4"
                                        value={timesPerDayStr}
                                        onChange={e => setTimesPerDayStr(e.target.value)}
                                        onBlur={() => setTimesPerDayStr(String(timesPerDay))}
                                        className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={inputStyle}
                                    />
                                </div>
                            </div>

                            {/* Time slots */}
                            <div className="space-y-3">
                                <label className="block text-xs font-bold" style={labelStyle}>{t('batch.time_slot')}</label>
                                <div className="grid grid-cols-2 gap-3">
                                    {timeSlots.map((slot, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold w-4 text-center" style={{ color: 'var(--text-tertiary)' }}>{i + 1}</span>
                                            <input
                                                type="time"
                                                value={slot}
                                                onChange={e => updateTimeSlot(i, e.target.value)}
                                                className="flex-1 p-3 rounded-xl text-sm font-medium text-center outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                style={inputStyle}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {step === 'preview' && (
                        <>
                            {/* Warning banner */}
                            <div className="flex items-start gap-3 p-4 rounded-2xl border"
                                style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.25)' }}>
                                <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
                                <p className="text-xs leading-relaxed font-medium" style={{ color: 'var(--text-secondary)' }}>
                                    {t('batch.warning')}
                                </p>
                            </div>

                            {/* Count */}
                            <div className="flex items-center justify-between px-1">
                                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                    {t('batch.total_count').replace('{n}', previewEvents.length.toString())}
                                </span>
                                <span className="text-xs px-2.5 py-1 rounded-full font-bold"
                                    style={{ background: 'var(--accent-50)', color: 'var(--accent-500)', border: '1px solid var(--accent-200)' }}>
                                    {t(`route.${route}`)} · {t(`ester.${ester}`)}
                                </span>
                            </div>

                            {previewEvents.length === 0 ? (
                                <div className="text-center py-12 rounded-2xl border border-dashed"
                                    style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                                    {t('batch.empty_preview')}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {groupedPreview.map(group => (
                                        <div key={group.date} className="rounded-2xl border overflow-hidden"
                                            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                                            {/* Date header */}
                                            <div className="px-4 py-2.5 flex items-center gap-2 border-b"
                                                style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                                                <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent-400)' }} />
                                                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                    {group.date}
                                                </span>
                                                <span className="text-[10px] font-medium ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                                                    {group.events.length}x
                                                </span>
                                            </div>

                                            {/* Events */}
                                            <div className="divide-y" style={{ borderColor: 'var(--border-secondary)' }}>
                                                {group.events.map(ev => {
                                                    const d = new Date(ev.timeH * 3600000);
                                                    const pad = (n: number) => n.toString().padStart(2, '0');
                                                    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                                                    const isEditing = editingId === ev.id;

                                                    if (isEditing) {
                                                        return (
                                                            <div key={ev.id} className="p-3 space-y-2" style={{ background: 'var(--bg-card-hover)' }}>
                                                                <div className="grid grid-cols-3 gap-2">
                                                                    <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                                                                        className="p-2 rounded-lg text-xs font-medium outline-none"
                                                                        style={inputStyle} />
                                                                    <input type="time" value={editTime} onChange={e => setEditTime(e.target.value)}
                                                                        className="p-2 rounded-lg text-xs font-medium text-center outline-none"
                                                                        style={inputStyle} />
                                                                    <div className="flex items-center gap-1">
                                                                        <input type="number" step="0.001" value={editDose} onChange={e => setEditDose(e.target.value)}
                                                                            className="flex-1 p-2 rounded-lg text-xs font-mono outline-none min-w-0"
                                                                            style={inputStyle} />
                                                                        <span className="text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>mg</span>
                                                                    </div>
                                                                </div>
                                                                <div className="flex gap-2 justify-end">
                                                                    <button onClick={() => setEditingId(null)}
                                                                        className="px-3 py-1.5 rounded-lg text-xs font-bold transition"
                                                                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}>
                                                                        {t('btn.cancel')}
                                                                    </button>
                                                                    <button onClick={() => confirmEdit(ev.id)}
                                                                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-white transition accent-bg-gradient">
                                                                        <Check size={12} className="inline mr-1" />{t('btn.save')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        );
                                                    }

                                                    return (
                                                        <div key={ev.id} className="px-4 py-3 flex items-center gap-3 group">
                                                            <span className="text-sm font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                                                                {timeStr}
                                                            </span>
                                                            <span className="text-xs font-bold" style={{ color: 'var(--accent-500)' }}>
                                                                {ev.doseMG.toFixed(2)} mg
                                                            </span>
                                                            <div className="flex items-center gap-1 ml-auto">
                                                                <button onClick={() => startEdit(ev)}
                                                                    className="p-1.5 rounded-lg transition opacity-50 hover:opacity-100"
                                                                    style={{ color: 'var(--text-tertiary)' }}>
                                                                    <Pencil size={14} />
                                                                </button>
                                                                <button onClick={() => removePreviewEvent(ev.id)}
                                                                    className="p-1.5 rounded-lg transition opacity-50 hover:opacity-100"
                                                                    style={{ color: '#ef4444' }}>
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="p-5 md:p-6 border-t shrink-0 flex gap-3 safe-area-pb"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    {step === 'config' && (
                        <button
                            onClick={generatePreview}
                            disabled={!doseStr || !startDate || !endDate}
                            className="flex-1 h-14 text-white text-base font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 accent-bg-gradient disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {t('batch.generate')}
                            <ChevronRight size={18} />
                        </button>
                    )}
                    {step === 'preview' && (
                        <>
                            <button
                                onClick={() => setStep('config')}
                                className="h-14 px-5 font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                                style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                            >
                                <ChevronLeft size={16} />
                                {t('batch.back')}
                            </button>
                            <button
                                onClick={handleConfirm}
                                disabled={previewEvents.length === 0}
                                className="flex-1 h-14 text-white text-base font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 accent-bg-gradient disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <Plus size={18} />
                                {t('batch.confirm_add')} ({previewEvents.length})
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BatchDoseModal;
