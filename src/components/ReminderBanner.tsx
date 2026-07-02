import React from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, AlertTriangle, Check } from 'lucide-react';
import { Plan } from '../../types';

export interface PendingReminder {
    planId: string;
    scheduledAtMs: number;
    firedAtMs: number;
}

interface ReminderBannerProps {
    /** When non-null, render the green "ready to confirm" banner. */
    pending: PendingReminder | null;
    /** Plan that matched the pending reminder (used to render the label). */
    matchedPlan: Plan | null;
    /** When the user taps the green banner we open the smart-add flow
     *  pre-targeted at the scheduled time. */
    onConfirm: (scheduledAt: Date) => void;
    /** Dismiss the pending reminder (it has been handled). */
    onDismiss: () => void;
    /** Show the amber "permission denied" banner — only when reminders are
     *  globally enabled but Android notification permission was denied. */
    permissionDenied: boolean;
    onOpenPermissionSettings?: () => void;
}

const ReminderBanner: React.FC<ReminderBannerProps> = ({
    pending, matchedPlan, onConfirm, onDismiss, permissionDenied, onOpenPermissionSettings,
}) => {
    const { t } = useTranslation();

    // 1. Green "ready to confirm" — highest priority when a deep-link is pending.
    if (pending && matchedPlan) {
        const when = new Date(pending.scheduledAtMs);
        const hh = when.getHours().toString().padStart(2, '0');
        const mm = when.getMinutes().toString().padStart(2, '0');
        return (
            <div className="mx-4 rounded-2xl p-4 flex items-center gap-3"
                style={{
                    background: 'linear-gradient(135deg, var(--accent-50) 0%, var(--bg-card-hover) 100%)',
                    border: '1px solid var(--accent-200)',
                }}>
                <Bell size={20} style={{ color: 'var(--accent-500)' }} />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {t('reminder.banner.title') || '用药提醒'}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                        {`${t(`ester.${matchedPlan.ester}`)} · ${matchedPlan.doseMG} mg · ${t(`route.${matchedPlan.route}`)} · ${hh}:${mm}`}
                    </p>
                </div>
                <button
                    onClick={() => onConfirm(when)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-white text-xs font-bold btn-press-glass glass-btn-primary"
                >
                    <Check size={14} />
                    <span>{t('reminder.banner.action') || '一键记录'}</span>
                </button>
                <button
                    onClick={onDismiss}
                    aria-label={t('btn.close')}
                    className="p-2 rounded-lg"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                >
                    ×
                </button>
            </div>
        );
    }

    // 2. Amber "permission denied" — informational only.
    if (permissionDenied) {
        return (
            <div className="mx-4 rounded-2xl p-4 flex items-center gap-3"
                style={{
                    background: 'var(--accent-50)',
                    border: '1px solid var(--accent-200)',
                }}>
                <AlertTriangle size={20} style={{ color: 'var(--accent-700, #92400e)' }} />
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

    return null;
};

export default ReminderBanner;