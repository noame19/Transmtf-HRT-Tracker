import React from 'react';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from '../contexts/LanguageContext';
import { getRouteIcon } from '../utils/helpers';
import { Ester, Route as RouteEnum } from '../../types';
import { Plan } from '../../types';
import { planSubtitle, findConflicts } from '../utils/planSchedule';
import { CalendarClock, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';

interface PlanListProps {
    plans: Plan[];
    onAddPlan: () => void;
    onEditPlan: (p: Plan) => void;
    onDeletePlan: (id: string) => void;
    onTogglePlan: (id: string, enabled: boolean) => void;
}

const PlanList: React.FC<PlanListProps> = ({ plans, onAddPlan, onEditPlan, onDeletePlan, onTogglePlan }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();

    const handleDeleteClick = async (e: React.MouseEvent, plan: Plan) => {
        // Defensive: stop bubbling so a future parent onClick (e.g. inline-edit)
        // can't swallow the click before the dialog runs.
        e.stopPropagation();
        e.preventDefault();
        const ok = await showDialog('confirm', t('plan.confirm.delete') || '确定删除这条用药计划吗？');
        if (ok === 'confirm') {
            onDeletePlan(plan.id);
        }
    };

    // A plan is "replaced" when it's disabled AND another enabled plan shares
    // its (ester, route). Used to surface an amber subtitle so the user knows
    // the older entry is intentionally shelved rather than deleted.
    const replacedByLabel = (plan: Plan): { id: string; label: string } | null => {
        if (plan.enabled) return null;
        const conflicts = findConflicts(plans, plan);
        if (conflicts.length === 0) return null;
        const winner = conflicts[0];
        const enabledConflict = plans.find(
            (p) => p.id === winner.id && p.enabled,
        );
        if (!enabledConflict) return null;
        return {
            id: winner.id,
            label: `${t(`ester.${enabledConflict.ester}`)} · ${enabledConflict.doseMG} mg · ${t(`route.${enabledConflict.route}`)}`,
        };
    };

    return (
        <div className="space-y-4">
            {plans.length === 0 && (
                <div className="mx-4 text-center py-12 rounded-3xl border border-dashed"
                    style={{ color: 'var(--text-tertiary)', background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                    <CalendarClock size={32} className="mx-auto mb-3" style={{ color: 'var(--text-tertiary)' }} />
                    <p className="text-sm font-medium mb-4" style={{ color: 'var(--text-secondary)' }}>
                        {t('plan.empty') || '还没有用药计划'}
                    </p>
                    <button
                        onClick={onAddPlan}
                        className="inline-flex items-center gap-2 px-4 py-2 h-11 rounded-xl text-white text-sm font-bold btn-press-glass transition glass-btn-primary"
                    >
                        <Plus size={16} />
                        <span>{t('plan.new') || '新增计划'}</span>
                    </button>
                </div>
            )}

            {plans.map((plan) => {
                const replacement = replacedByLabel(plan);
                return (
                    <div key={plan.id} className="mx-4 rounded-2xl glass-card overflow-hidden transition-all"
                        style={{ opacity: plan.enabled ? 1 : 0.7 }}>
                        <div className="p-4 flex items-start gap-4">
                            <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border"
                                style={{
                                    background: plan.route === RouteEnum.injection ? 'var(--accent-50)' : 'var(--bg-card-hover)',
                                    borderColor: plan.route === RouteEnum.injection ? 'var(--accent-200)' : 'var(--border-primary)',
                                }}>
                                {getRouteIcon(plan.route)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                                        {t(`ester.${plan.ester}`)} · {plan.doseMG} mg · {t(`route.${plan.route}`)}
                                    </span>
                                    {/* Enable toggle */}
                                    <label className="inline-flex items-center cursor-pointer shrink-0 ml-2">
                                        <input
                                            type="checkbox"
                                            className="sr-only peer"
                                            checked={plan.enabled}
                                            onChange={(e) => onTogglePlan(plan.id, e.target.checked)}
                                            aria-label={t('plan.field.enabled') || '启用'}
                                        />
                                        <div className="relative w-10 h-6 rounded-full transition-colors"
                                            style={{ background: plan.enabled ? 'var(--accent-500)' : 'var(--bg-card-hover)' }}>
                                            <span
                                                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
                                                style={{ transform: plan.enabled ? 'translateX(16px)' : 'translateX(0)' }}
                                            />
                                        </div>
                                    </label>
                                </div>
                                <div className="text-xs font-medium space-y-1" style={{ color: 'var(--text-secondary)' }}>
                                    <div>{planSubtitle(plan, (k, fb) => t(k as any) || fb || k)}</div>
                                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('plan.field.lead_minutes') || '提前提醒'} {plan.leadMinutes} {t('plan.minutes') || '分钟'}
                                    </div>
                                </div>
                                {replacement && (
                                    <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border"
                                        style={{
                                            color: 'var(--accent-700, #92400e)',
                                            background: 'var(--accent-50)',
                                            borderColor: 'var(--accent-200, #fcd34d)',
                                        }}>
                                        <AlertTriangle size={12} />
                                        <span>
                                            {t('plan.disabled_replaced_by') || '已停用 — 被替代'} {replacement.label}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="px-4 py-2 border-t flex items-center justify-end gap-2"
                            style={{ borderColor: 'var(--border-secondary)' }}>
                            <button
                                onClick={() => onEditPlan(plan)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition btn-press-glass"
                                style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                            >
                                <Pencil size={12} />
                                <span>{t('plan.edit') || '编辑'}</span>
                            </button>
                            <button
                                onClick={(e) => handleDeleteClick(e, plan)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition btn-press-glass"
                                style={{ background: 'var(--bg-card-hover)', color: '#dc2626' }}
                            >
                                <Trash2 size={12} />
                                <span>{t('plan.delete') || '删除'}</span>
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default PlanList;