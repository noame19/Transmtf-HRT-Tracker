import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { getRouteIcon, formatTime } from '../utils/helpers';
import { DoseEvent } from '../../logic';
import { Plan, Route as RouteEnum } from '../../types';
import { prefillWeightKG } from '../utils/weight';
import { X, ListChecks, Check } from 'lucide-react';

interface BatchPlanConfirmModalProps {
    isOpen: boolean;
    /** Plans + their scheduled moments matched against the user's clock. */
    matches: Array<{ plan: Plan; scheduledAt: Date }>;
    /** All existing events (used to default the body weight to the most recent). */
    events: DoseEvent[];
    onConfirm: (events: DoseEvent[]) => void;
    onClose: () => void;
}

const BatchPlanConfirmModal: React.FC<BatchPlanConfirmModalProps> = ({
    isOpen, matches, events, onConfirm, onClose,
}) => {
    const { t } = useTranslation();

    if (!isOpen) return null;

    const handleConfirm = () => {
        const defaultWeight = prefillWeightKG(events);
        const nowH = Date.now() / 3600000;
        const newEvents: DoseEvent[] = matches.map(({ plan, scheduledAt }) => {
            const timeH = scheduledAt.getTime() / 3600000;
            return {
                id: `event-${uuidv4()}`,
                route: plan.route,
                timeH,
                doseMG: plan.doseMG,
                ester: plan.ester,
                weightKG: defaultWeight,
                // Carry the plan's extras into the event so downstream PK code
                // sees the same per-route settings the user configured.
                extras: { ...plan.extras },
            };
        });
        onConfirm(newEvents);
    };

    return (
        <div
            className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="batch-plan-modal-title"
                className="relative rounded-3xl w-full max-w-lg md:max-w-2xl h-[90vh] md:max-h-[80vh] flex flex-col overflow-hidden modal-spring-glass glass-modal"
            >
                {/* Header */}
                <div className="p-6 md:p-8 border-b flex justify-between items-center shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <h3 id="batch-plan-modal-title" className="text-xl font-semibold flex items-center gap-3"
                        style={{ color: 'var(--text-primary)' }}>
                        <ListChecks size={22} style={{ color: 'var(--accent-300)' }} />
                        {t('plan.confirm.batch') || '批量确认'}
                    </h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Body — preview list */}
                <div className="p-6 space-y-3 flex-1 overflow-y-auto">
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('plan.confirm.batch_desc') || '下列计划与当前时间匹配，将一次性记录为多条用药记录：'}
                    </p>
                    {matches.map(({ plan, scheduledAt }, idx) => (
                        <div key={`${plan.id}-${idx}`} className="flex items-center gap-3 p-3 rounded-xl"
                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}>
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                style={{
                                    background: plan.route === RouteEnum.injection ? 'var(--accent-50)' : 'var(--bg-card)',
                                    border: '1px solid var(--border-primary)',
                                }}>
                                {getRouteIcon(plan.route)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                                    {t(`ester.${plan.ester}`)} · {plan.doseMG} mg · {t(`route.${plan.route}`)}
                                </div>
                                <div className="text-[11px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                                    {formatTime(scheduledAt)}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="p-4 md:p-6 border-t flex items-center justify-end gap-2 shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 h-11 rounded-xl text-sm font-bold transition btn-press-glass"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                    >
                        {t('btn.cancel') || '取消'}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className="inline-flex items-center gap-1.5 px-4 py-2 h-11 rounded-xl text-white text-sm font-bold btn-press-glass transition glass-btn-primary"
                    >
                        <Check size={16} />
                        <span>
                            {t('plan.confirm.confirm_all') || `全部记录 (${matches.length})`}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BatchPlanConfirmModal;