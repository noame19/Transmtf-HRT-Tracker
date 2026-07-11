import React, { useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, Check, FastForward, SkipForward, X } from 'lucide-react';
import { Plan } from '../../types';
import { useDialog } from '../contexts/DialogContext';
import type { PendingReminder } from './ReminderBanner';

interface ReminderModalProps {
    isOpen: boolean;
    pending: PendingReminder | null;
    plan: Plan | null;
    /** "已服用" — write the DoseEvent directly (1-tap). */
    onConfirm: () => void;
    /** "跳过本次" — late only. Marks this due as ignored and clears the
     *  modal; the next due still fires on schedule. */
    onSkip: () => void;
    /** "计划推迟 N 天" — shifts plan.startDateH by N days. */
    onDelay1d: () => void;
    onDelay2d: () => void;
    /** "该吃药了"右上角 X 关闭. Does NOT touch the Android notification;
     *  only dismisses this in-app modal + adds the due to the ignored set
     *  so neither the modal nor the virtual record reappears. */
    onClose: () => void;
}

/**
 * Full-screen blocking modal that mirrors the announcement modal's visual
 * pattern (fixed overlay + backdrop-blur + centered glass card).
 *
 * Footer is **state-dependent**:
 *   - on_time: [已服用] + 右上角 X 关闭
 *               (用户还可以去 history 页用虚拟记录补打，所以不需要推迟按钮)
 *   - late:    [已服用 / 跳过本次 / 计划推迟 1 天 / 计划推迟 2 天] (无 X)
 *               强提醒：必须四选一，不允许忽视
 *
 * This is the single source of truth for the in-app medication reminder UI,
 * rendered at the layout level (MainLayout) so it overrides any route.
 */
const ReminderModal: React.FC<ReminderModalProps> = ({
    isOpen,
    pending,
    plan,
    onConfirm,
    onSkip,
    onDelay1d,
    onDelay2d,
    onClose,
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();

    // While the modal is open, block body scroll so the rest of the app
    // (which is dimmed behind the backdrop) can't be scrolled away.
    useEffect(() => {
        if (!isOpen) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [isOpen]);

    if (!isOpen || !pending || !plan) return null;

    const scheduled = new Date(pending.scheduledAtMs);
    const hh = scheduled.getHours().toString().padStart(2, '0');
    const mm = scheduled.getMinutes().toString().padStart(2, '0');
    const timeLabel = `${hh}:${mm}`;

    const isLate = pending.state === 'late';
    const drugLabel = `${t(`ester.${plan.ester}`)} · ${plan.doseMG} mg · ${t(`route.${plan.route}`)}`;

    const handleSkipClick = () => {
        const title = t('reminder.banner.skip_confirm.title') || '确认跳过本次？';
        const body = t('reminder.banner.skip_confirm.body') || '跳过今日原有计划且原计划将不会顺延，强烈影响身体激素状态，您确定吗？';
        showDialog('confirm', `${title}\n\n${body}`, () => {
            onSkip();
        });
    };

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
                {/* Header — bell + drug/time title */}
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
                            {isLate
                                ? (t('reminder.banner.late.title') || '已过服药时间')
                                : (t('reminder.banner.on_time.title') || '该吃药了')}
                        </h2>
                        <p
                            className="text-xs mt-0.5 truncate"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {drugLabel}
                        </p>
                    </div>
                    {/* Close X — on_time only. late 状态不允许关闭。 */}
                    {!isLate && (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={t('reminder.modal.close') || '关闭'}
                            className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center btn-press-glass transition"
                            style={{
                                background: 'var(--bg-card)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-primary)',
                            }}
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>

                {/* Body — when + (optional) overdue */}
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
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-white rounded-2xl transition btn-press-glass glass-btn-primary"
                        aria-label={t('reminder.banner.confirm_on_time') || '已服用'}
                    >
                        <Check size={18} />
                        <span>{t('reminder.banner.confirm_on_time') || '已服用'}</span>
                    </button>

                    {isLate && (
                        <>
                            <button
                                type="button"
                                onClick={handleSkipClick}
                                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-2xl transition btn-press-glass"
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text-soft-rose)',
                                    border: '1px solid var(--border-soft-rose)',
                                }}
                                aria-label={t('reminder.banner.skip') || '跳过本次'}
                            >
                                <SkipForward size={18} />
                                <span>{t('reminder.banner.skip') || '跳过本次'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={onDelay1d}
                                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-2xl transition btn-press-glass"
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-primary)',
                                }}
                                aria-label={t('reminder.banner.delay_1d') || '计划推迟 1 天'}
                            >
                                <FastForward size={18} />
                                <span>{t('reminder.banner.delay_1d') || '计划推迟 1 天'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={onDelay2d}
                                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-2xl transition btn-press-glass"
                                style={{
                                    background: 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-primary)',
                                }}
                                aria-label={t('reminder.banner.delay_2d') || '计划推迟 2 天'}
                            >
                                <FastForward size={18} />
                                <span>{t('reminder.banner.delay_2d') || '计划推迟 2 天'}</span>
                            </button>
                        </>
                    )}
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