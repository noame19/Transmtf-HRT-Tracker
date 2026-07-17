import React, { useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, Check, X, FastForward, SkipForward } from 'lucide-react';
import { Plan } from '../../types';
import type { PendingReminder } from './ReminderBanner';
import { ConfirmButton } from './ConfirmButton';
import { useConfirmButton } from '../hooks/useConfirmButton';

interface ReminderModalProps {
    isOpen: boolean;
    pending: PendingReminder | null;
    plan: Plan | null;
    /** "已服用" — write the DoseEvent directly (1-tap). */
    onConfirm: () => void;
    /** "跳过本次" (late state only). Callers usually wrap this with a
     *  destructive "are you sure?" confirm dialog before adding the due
     *  moment to the handled set. */
    onSkip?: () => void;
    /** "X" close button (on_time state only). Closes the modal WITHOUT
     *  resolving the reminder — the banner stays up on /history until
     *  the user picks an action there. */
    onClose?: () => void;
    /** "计划推迟 1 天" — shift plan.startDateH by 1 day. Available in BOTH
     *  states (on_time + late): the user might be about to take the dose
     *  but want to push the whole schedule, or might be late and decide
     *  to give up today + restart tomorrow. */
    onDelay1d: () => void;
    /** "计划推迟 2 天" — shift plan.startDateH by 2 days. Same rationale
     *  as `onDelay1d`. */
    onDelay2d: () => void;
}

/**
 * Full-screen blocking modal that mirrors the announcement modal's visual
 * pattern (fixed overlay + backdrop-blur + centered glass card).
 *
 * State-dependent behaviour:
 *   - on_time  → 3 actions: [已服用] (primary) + [计划推迟 1 天] + [计划
 *               推迟 2 天] + X (top-right close, keeps banner alive on
 *               /history so the user can still confirm). NO "跳过本次"
 *               — at on_time the dose is "current", not past, so skipping
 *               would be self-defeating.
 *   - late     → 4 actions: [已服用 / 跳过本次 / 计划推迟 1 天 /
 *               计划推迟 2 天]. No X — late state is action-required.
 *               "跳过本次" delegates to the parent which shows a destructive
 *               confirm dialog before flipping the reminder to handled.
 *
 * Like `AnnouncementModal`, the only ways to dismiss are the action buttons
 * (or X for on_time). No click-outside, no ESC — the user must pick.
 *
 * This is the single source of truth for the in-app medication reminder UI,
 * rendered at the layout level (MainLayout) so it overrides any route.
 */
const ReminderModal: React.FC<ReminderModalProps> = ({
    isOpen, pending, plan,
    onConfirm, onSkip, onClose,
    onDelay1d, onDelay2d,
}) => {
    const { t } = useTranslation();
    const { pending: confirmPending, request, reset } = useConfirmButton();

    // While the modal is open, block body scroll so the rest of the app
    // (which is dimmed behind the backdrop) can't be scrolled away.
    useEffect(() => {
        if (!isOpen) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [isOpen]);

    // Clear any "再点一次确认" pending state when the modal closes, so a
    // reopened modal always starts fresh.
    useEffect(() => {
        if (!isOpen) reset();
    }, [isOpen, reset]);

    if (!isOpen || !pending || !plan) return null;

    const scheduled = new Date(pending.scheduledAtMs);
    const isLate = pending.state === 'late';

    const hh = scheduled.getHours().toString().padStart(2, '0');
    const mm = scheduled.getMinutes().toString().padStart(2, '0');
    const timeLabel = `${hh}:${mm}`;

    const drugLabel = `${t(`ester.${plan.ester}`)} · ${plan.doseMG} mg · ${t(`route.${plan.route}`)}`;

    const title = isLate
        ? (t('reminder.banner.late.title') || '已过服药时间')
        : (t('reminder.banner.on_time.title') || '该吃药了');

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reminder-modal-title"
            className="fixed inset-0 z-[9999] flex items-center justify-center px-4 py-6 overflow-y-auto"
            style={{
                background: 'var(--bg-overlay)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
            }}
        >
            <div
                className="relative w-full max-w-md mx-auto my-auto rounded-3xl overflow-hidden animate-announcement-in glass-modal"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — bell + drug/time title (+ X close button for on_time) */}
                <div
                    className="flex items-center gap-3 px-6 py-4 border-b"
                    style={{
                        background: 'linear-gradient(135deg, var(--bg-soft-rose), var(--bg-card))',
                        borderColor: 'var(--border-secondary)',
                    }}
                >
                    <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 accent-bg-gradient"
                    >
                        <Bell size={20} className="text-white" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2
                            id="reminder-modal-title"
                            className="text-base font-bold leading-tight"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {title}
                        </h2>
                        <p
                            className="text-xs mt-0.5 truncate"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {drugLabel}
                        </p>
                    </div>
                    {/* X close button — on_time only. Late state is "you must
                     *  pick an action", so no escape hatch is offered. */}
                    {!isLate && onClose && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center btn-press-glass transition"
                            style={{
                                background: 'var(--bg-card)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-primary)',
                            }}
                            aria-label={t('reminder.modal.close') || '关闭'}
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>

                {/* Body — when (no overdue label per UX decision) */}
                <div
                    className="px-6 py-5 text-sm leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <p className="font-mono text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                        {timeLabel}
                    </p>
                    <p>
                        {t('reminder.modal.scheduled_at') || `计划服药时间 · ${timeLabel}`}
                    </p>
                </div>

                {/* Footer — state-dependent action buttons */}
                <div className="px-6 pb-6 pt-2 flex flex-col gap-2.5">
                    <ConfirmButton
                        label={t('reminder.banner.confirm_on_time') || '已服用'}
                        onClick={() => request('confirm', { onTrigger: onConfirm })}
                        pending={confirmPending === 'confirm'}
                        icon={<Check size={18} />}
                        className="w-full px-4 py-3 text-sm"
                    />
                    {isLate && onSkip && (
                        <ConfirmButton
                            label={t('reminder.banner.skip') || '跳过本次'}
                            onClick={() => request('skip', { onTrigger: onSkip })}
                            pending={confirmPending === 'skip'}
                            icon={<SkipForward size={18} />}
                            className="w-full px-4 py-3 text-sm"
                        />
                    )}
                    {isLate && onSkip && confirmPending === 'skip' && (
                        <div
                            className="text-sm leading-relaxed px-2 py-2 rounded-xl"
                            style={{
                                background: 'rgba(244, 63, 94, 0.06)',
                                color: 'var(--text-soft-rose)',
                                animation: 'skipWarnIn 200ms ease-out',
                            }}
                            role="note"
                        >
                            {t('reminder.banner.skip_confirm.body') || '将跳过今日原有计划,原计划不会顺延。强烈影响身体激素状态,您确定吗?'}
                            <style>{`
                                @keyframes skipWarnIn {
                                    from { opacity: 0; transform: translateY(-6px); }
                                    to   { opacity: 1; transform: translateY(0); }
                                }
                            `}</style>
                        </div>
                    )}
                    {/* Delay buttons render in BOTH states (on_time + late):
                      *  the user might be ready to take the dose but want
                      *  to push the whole schedule (on_time), or have given
                      *  up on today and want to restart from tomorrow (late).
                      *  "跳过本次" stays late-only because skipping within
                      *  the on_time window would be self-defeating. */}
                    <ConfirmButton
                        label={t('reminder.banner.delay_1d') || '计划推迟 1 天'}
                        onClick={() => request('delay1d', { onTrigger: onDelay1d })}
                        pending={confirmPending === 'delay1d'}
                        icon={<FastForward size={18} />}
                        className="w-full px-4 py-3 text-sm"
                    />
                    <ConfirmButton
                        label={t('reminder.banner.delay_2d') || '计划推迟 2 天'}
                        onClick={() => request('delay2d', { onTrigger: onDelay2d })}
                        pending={confirmPending === 'delay2d'}
                        icon={<FastForward size={18} />}
                        className="w-full px-4 py-3 text-sm"
                    />
                </div>
            </div>

            {/* Same entrance animation as the announcement modal so the
              * visual rhythm matches across the app. */}
            <style>{`
                @keyframes announcement-in {
                    from { opacity: 0; transform: scale(0.96) translateY(16px); }
                    to   { opacity: 1; transform: scale(1)    translateY(0); }
                }
                .animate-announcement-in {
                    animation: announcement-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                }
            `}</style>
        </div>
    );
};

export default ReminderModal;