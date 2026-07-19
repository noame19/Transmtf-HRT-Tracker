import React from 'react';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from '../contexts/LanguageContext';
import { getRouteIcon } from '../utils/helpers';
import { Ester, Route as RouteEnum } from '../../types';
import { Plan } from '../../types';
import { planSubtitle, findConflicts } from '../utils/planSchedule';
import { ComplianceMismatch } from '../utils/planCompliance';
import { CalendarClock, Plus, Pencil, Trash2, AlertTriangle, Check } from 'lucide-react';

interface PlanListProps {
    plans: Plan[];
    onAddPlan: () => void;
    onEditPlan: (p: Plan) => void;
    onDeletePlan: (id: string) => void;
    onTogglePlan: (id: string, enabled: boolean) => void;
    /**
     * Per-plan compliance mismatches from `analyzePlanCompliance`. Each plan
     * whose id appears here gets a red "与最近用药历史不符" tag beneath its
     * enable toggle. Same data source as the top-level ComplianceBanner so the
     * two stay in sync without re-running the analysis.
     */
    mismatches?: ComplianceMismatch[];
    /** Whether the parent view is currently in multi-select mode. When true,
     *  each card renders a leading ✓ checkbox and the inline enable toggle +
     *  edit/delete buttons are HIDDEN. */
    selectionMode?: boolean;
    /** Currently selected plan ids. */
    selectedIds?: string[];
    /** Toggle a single plan's selection state. */
    onToggleSelected?: (id: string) => void;
}

const PlanList: React.FC<PlanListProps> = ({
    plans, onAddPlan, onEditPlan, onDeletePlan, onTogglePlan, mismatches = [],
    selectionMode = false, selectedIds = [], onToggleSelected,
}) => {
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

    // O(1) planId → mismatch lookup built once per render so the card loop
    // doesn't have to scan the mismatches array for every row.
    const mismatchedPlanIds = new Set(mismatches.map((m) => m.plan.id));

    // O(1) selection lookup for the multi-select mode (set rendered on parent).
    const selectedSet = new Set(selectedIds);
    const isSelected = (id: string) => selectedSet.has(id);

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
                const isMismatch = mismatchedPlanIds.has(plan.id);
                // 路线单独走中文-only key（plan.route.*），跟详情卡片 / 弹窗
                // 里的双语 route.* 区分开 —— 用户要求卡片标题只显示中文。
                const routeLabel = t(`plan.route.${plan.route}`) || t(`route.${plan.route}`) || plan.route;
                return (
                    <div
                        key={plan.id}
                        className="mx-4 rounded-2xl glass-card overflow-hidden transition-all"
                        style={{
                            opacity: plan.enabled || selectionMode ? 1 : 0.7,
                            background: isSelected(plan.id) ? 'var(--bg-card-hover)' : undefined,
                            border: isSelected(plan.id) ? '1px solid var(--accent-500)' : undefined,
                        }}
                        onClick={() => {
                            if (selectionMode) onToggleSelected?.(plan.id);
                        }}
                    >
                        <div className="p-4 flex items-start gap-4">
                            {selectionMode && (
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onToggleSelected?.(plan.id); }}
                                    aria-label={isSelected(plan.id) ? '取消选中' : '选中'}
                                    data-testid={`plan-checkbox-${plan.id}`}
                                    className="w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 btn-press-glass"
                                    style={{
                                        borderColor: isSelected(plan.id) ? 'var(--accent-500)' : 'var(--border-primary)',
                                        background: isSelected(plan.id) ? 'var(--accent-500)' : 'transparent',
                                    }}
                                >
                                    {isSelected(plan.id) && (
                                        <Check size={14} color="#fff" strokeWidth={3} />
                                    )}
                                </button>
                            )}
                            <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border"
                                style={{
                                    background: plan.route === RouteEnum.injection ? 'var(--bg-soft-rose)' : 'var(--bg-card-hover)',
                                    borderColor: plan.route === RouteEnum.injection ? 'var(--border-soft-rose)' : 'var(--border-primary)',
                                }}>
                                {getRouteIcon(plan.route)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                                        {`${t(`ester.${plan.ester}`)} · ${routeLabel}`}
                                    </span>
                                    {/* Enable toggle — hidden in selection mode */}
                                    {!selectionMode && (
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
                                    )}
                                </div>
                                {/* Compliance mismatch tag — sits directly under the
                                 * toggle, right-aligned. Hidden when the plan is in
                                 * compliance OR was dismissed-but-not-yet-expired. */}
                                {isMismatch && (
                                    <div className="flex justify-end -mt-1 mb-1">
                                        <span
                                            className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border"
                                            style={{
                                                color: '#dc2626',
                                                background: 'var(--bg-card-hover)',
                                                borderColor: 'var(--border-secondary)',
                                            }}
                                            title={t('plan.compliance_mismatch') || '与最近用药历史不符'}
                                        >
                                            <AlertTriangle size={11} />
                                            <span>{t('plan.compliance_mismatch') || '与最近用药历史不符'}</span>
                                        </span>
                                    </div>
                                )}
                                <div className="text-xs font-medium space-y-1" style={{ color: 'var(--text-secondary)' }}>
                                    <div>
                                        <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border mr-2"
                                            style={{ color: 'var(--text-primary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                            {`${t('plan.card.dose_unit') || '剂量'} ${plan.doseMG} mg`}
                                        </span>
                                        <span>{planSubtitle(plan, (k, fb) => t(k as any) || fb || k)}</span>
                                    </div>
                                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                        {`${t('plan.card.lead_label') || '提前提醒'} ${plan.leadMinutes} ${t('plan.minutes') || '分钟'}`}
                                    </div>
                                </div>
                                {replacement && (
                                    <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border"
                                        style={{
                                            color: 'var(--text-soft-amber)',
                                            background: 'var(--bg-soft-amber)',
                                            borderColor: 'var(--border-soft-amber)',
                                        }}>
                                        <AlertTriangle size={12} />
                                        <span>
                                            {t('plan.disabled_replaced_by') || '已停用 — 被替代'} {replacement.label}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                        {!selectionMode && (
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
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default PlanList;
