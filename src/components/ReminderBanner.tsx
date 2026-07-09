import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, AlertTriangle, Check, SkipForward, FastForward, Clock } from 'lucide-react';
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
    /** 'on_time' = now ≤ due; 'late' = now > due (within the 6h auto-dismiss). */
    state: PendingReminderState;
}

interface ReminderBannerProps {
    /** When non-null, render the banner. */
    pending: PendingReminder | null;
    /** Plan that matched the pending reminder (used to render the label). */
    matchedPlan: Plan | null;
    /** User pressed "已服用" / "补打" — open the form (or save directly). */
    onConfirm: (scheduledAt: Date) => void;
    /** User pressed "跳过" — clear the banner without recording anything. */
    onDismiss: () => void;
    /** User pressed "推迟到下次" (late state only). Phase-4 stub for now. */
    onDelayNext?: (planId: string) => void;
    /** User pressed "推迟 1 天 / 2 天" (on-time state only). Phase-4 stub. */
    onDelay1d?: (planId: string) => void;
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

function fmtOverdue(due: Date, now: Date): string {
    const diffMs = now.getTime() - due.getTime();
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    const minutes = Math.round((diffMs % (60 * 60 * 1000)) / (60 * 1000));
    if (hours >= 1) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
    return `${Math.max(1, minutes)}m`;
}

const ReminderBanner: React.FC<ReminderBannerProps> = ({
    pending, matchedPlan,
    onConfirm, onDismiss,
    onDelayNext, onDelay1d, onDelay2d,
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
    const now = new Date();
    const isLate = pending.state === 'late';
    const overdueLabel = isLate ? fmtOverdue(when, now) : '';

    // Shared header content.
    const headerLabel = `${t(`ester.${matchedPlan.ester}`)} · ${matchedPlan.doseMG} mg · ${t(`route.${matchedPlan.route}`)} · ${fmtHHMM(when)}`;
    const title = isLate
        ? (t('reminder.banner.late.title') || '已过服药时间')
        : (t('reminder.banner.on_time.title') || '该吃药了');
    const sub = isLate
        ? (t('reminder.banner.late.sub') || `已过期 ${overdueLabel}，请确认是否补打`)
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
                    ? <Clock size={20} style={{ color: 'var(--text-soft-rose)' }} />
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

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-2">
                {isLate ? (
                    <>
                        <button
                            onClick={() => onConfirm(when)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-white text-xs font-bold btn-press-glass glass-btn-primary"
                            aria-label={t('reminder.banner.confirm_late') || '补打'}
                        >
                            <Check size={14} />
                            <span>{t('reminder.banner.confirm_late') || '补打'}</span>
                        </button>
                        <button
                            onClick={onDismiss}
                            className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                            style={{
                                background: 'var(--bg-card)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border-primary)',
                            }}
                            aria-label={t('reminder.banner.skip') || '跳过'}
                        >
                            <SkipForward size={14} />
                            <span>{t('reminder.banner.skip') || '跳过'}</span>
                        </button>
                        {onDelayNext && (
                            <button
                                onClick={() => onDelayNext(matchedPlan.id)}
                                className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-primary)',
                                }}
                                aria-label={t('reminder.banner.delay_next') || '推迟到下次'}
                            >
                                <FastForward size={14} />
                                <span>{t('reminder.banner.delay_next') || '推迟到下次'}</span>
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button
                            onClick={() => onConfirm(when)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-white text-xs font-bold btn-press-glass glass-btn-primary"
                            aria-label={t('reminder.banner.confirm_on_time') || '已服用'}
                        >
                            <Check size={14} />
                            <span>{t('reminder.banner.confirm_on_time') || '已服用'}</span>
                        </button>
                        {onDelay1d && (
                            <button
                                onClick={() => onDelay1d(matchedPlan.id)}
                                className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-primary)',
                                }}
                                aria-label={t('reminder.banner.delay_1d') || '推迟 1 天'}
                            >
                                <FastForward size={14} />
                                <span>{t('reminder.banner.delay_1d') || '推迟 1 天'}</span>
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
                                aria-label={t('reminder.banner.delay_2d') || '推迟 2 天'}
                            >
                                <FastForward size={14} />
                                <span>{t('reminder.banner.delay_2d') || '推迟 2 天'}</span>
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default ReminderBanner;