import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, AlertTriangle, Check, FastForward, SkipForward } from 'lucide-react';
import { Plan } from '../../types';

export type PendingReminderState = 'on_time' | 'late';

/**
 * Drives the ReminderBanner from in-app state only (plan + history + current
 * time). The old `firedAtMs` from the Android notification's pending payload
 * is gone — we don't read from the notification bridge anymore.
 */
export interface PendingReminder {
    planId: string;
    /** Scheduled due moment this reminder is about. */
    scheduledAtMs: number;
    /** 'on_time' = within ±1h of due; 'late' = past due by >1h but ≤5h. */
    state: PendingReminderState;
}

interface ReminderBannerProps {
    /** When non-null, render the banner. */
    pending: PendingReminder | null;
    /** Plan that matched the pending reminder (used to render the label). */
    matchedPlan: Plan | null;
    /** "已服用" — writes a DoseEvent at the click time. */
    onConfirm: (scheduledAt: Date) => void;
    /** "跳过本次" (late only). Callers wrap this with a destructive confirm
     *  dialog before flipping the reminder to handled. */
    onSkip?: () => void;
    /** "计划推迟 1 天" (late only) — shifts plan.startDateH by 1 day. */
    onDelay1d?: (planId: string) => void;
    /** "计划推迟 2 天" (late only) — shifts plan.startDateH by 2 days. */
    onDelay2d?: (planId: string) => void;
    /** Show the amber "permission denied" banner — only when reminders are
     *  globally enabled but Android notification permission was denied. */
    permissionDenied: boolean;
    onOpenPermissionSettings?: () => void;
}

function fmtHHMM(d: Date): string {
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
}

const ReminderBanner: React.FC<ReminderBannerProps> = ({
    pending, matchedPlan,
    onConfirm, onSkip,
    onDelay1d, onDelay2d,
    permissionDenied, onOpenPermissionSettings,
}) => {
    const { t } = useTranslation();

    // 1. Permission denied — informational amber banner.
    if (permissionDenied) {
        return (
            <div className="mx-4 rounded-2xl p-4 flex items-center gap-3"
                style={{
                    background: 'var(--bg-soft-rose)',
                    border: '1px solid var(--border-soft-rose)',
                }}>
                <AlertTriangle size={20} style={{ color: 'var(--text-soft-rose)' }} />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {t('reminder.banner.permission_denied') || '通知权限未开启'}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('reminder.banner.permission_desc') || '请到系统设置 → 应用 → HRT Tracker → 通知 中开启。'}
                    </p>
                </div>
                {onOpenPermissionSettings && (
                    <button
                        onClick={onOpenPermissionSettings}
                        className="px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                        }}
                    >
                        {t('reminder.banner.open_settings') || '去设置'}
                    </button>
                )}
            </div>
        );
    }

    // 2. Due moment — render in either on_time or late variant.
    if (!pending || !matchedPlan) return null;

    const when = new Date(pending.scheduledAtMs);
    const isLate = pending.state === 'late';

    // Shared header content.
    const headerLabel = `${t(`ester.${matchedPlan.ester}`)} · ${matchedPlan.doseMG} mg · ${t(`route.${matchedPlan.route}`)} · ${fmtHHMM(when)}`;
    const title = isLate
        ? (t('reminder.banner.late.title') || '已过服药时间')
        : (t('reminder.banner.on_time.title') || '该吃药了');
    const sub = isLate
        ? headerLabel
        : headerLabel;

    return (
        <div className="mx-4 rounded-2xl p-4 flex flex-col gap-3"
            style={{
                background: isLate
                    ? 'var(--bg-soft-rose)'
                    : 'linear-gradient(135deg, var(--bg-soft-rose) 0%, var(--bg-card-hover) 100%)',
                border: '1px solid var(--border-soft-rose)',
            }}>
            {/* Header row */}
            <div className="flex items-center gap-3">
                {isLate
                    ? <Bell size={20} style={{ color: 'var(--text-soft-rose)' }} />
                    : <Bell size={20} style={{ color: 'var(--accent-500)' }} />}
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {title}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                        {sub}
                    </p>
                </div>
            </div>

            {/* Action buttons — the in-page banner is a "主动处理" surface,
              *  so unlike the modal (which interrupts and should be quick
              *  to dismiss) we expose the full 4-action set in BOTH states.
              *  Modal still gates by state because it pops up uninvited and
              *  shouldn't ask the user to make a 4-way decision before
              *  they've even seen the notification. */}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    onClick={() => onConfirm(when)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-white text-xs font-bold btn-press-glass glass-btn-primary"
                    aria-label={t('reminder.banner.confirm_on_time') || '已服用'}
                >
                    <Check size={14} />
                    <span>{t('reminder.banner.confirm_on_time') || '已服用'}</span>
                </button>

                {onSkip && (
                    <button
                        onClick={onSkip}
                        className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            // Soft-rose border for visual warning — "skip" is
                            // a destructive action and shouldn't blend in.
                            border: '1px solid var(--border-soft-rose)',
                        }}
                        aria-label={t('reminder.banner.skip') || '跳过本次'}
                    >
                        <SkipForward size={14} />
                        <span>{t('reminder.banner.skip') || '跳过本次'}</span>
                    </button>
                )}

                {onDelay1d && (
                    <button
                        onClick={() => onDelay1d(matchedPlan.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                        }}
                        aria-label={t('reminder.banner.delay_1d') || '计划推迟 1 天'}
                    >
                        <FastForward size={14} />
                        <span>{t('reminder.banner.delay_1d') || '计划推迟 1 天'}</span>
                    </button>
                )}

                {onDelay2d && (
                    <button
                        onClick={() => onDelay2d(matchedPlan.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                        }}
                        aria-label={t('reminder.banner.delay_2d') || '计划推迟 2 天'}
                    >
                        <FastForward size={14} />
                        <span>{t('reminder.banner.delay_2d') || '计划推迟 2 天'}</span>
                    </button>
                )}
            </div>
        </div>
    );
};

export default ReminderBanner;