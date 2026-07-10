import React, { useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { Bell, Check, FastForward } from 'lucide-react';
import { Plan } from '../../types';
import type { PendingReminder } from './ReminderBanner';

interface ReminderModalProps {
    isOpen: boolean;
    pending: PendingReminder | null;
    plan: Plan | null;
    /** "已服用" — write the DoseEvent directly (1-tap). */
    onConfirm: () => void;
    /** "推迟 1 天" — shift plan.startDateH by 1 day (1-tap). */
    onDelay1d: () => void;
    /** "推迟 2 天" — shift plan.startDateH by 2 days (1-tap). */
    onDelay2d: () => void;
}

/**
 * Full-screen blocking modal that mirrors the announcement modal's visual
 * pattern (fixed overlay + backdrop-blur + centered glass card). Unlike
 * `AnnouncementModal`, the only ways to dismiss it are the three primary
 * buttons — no X, no click-outside, no ESC — so the user is forced to
 * actively choose an action (or wait it out / clear via system notification).
 *
 * This is the single source of truth for the in-app medication reminder UI,
 * rendered at the layout level (MainLayout) so it overrides any route.
 *
 * Action semantics (regardless of whether the user tapped the button on a
 * heads-up OR clicked it inside this modal):
 *   - "已服用"   → `onConfirm`, writes the DoseEvent directly with the
 *                  plan's data and the scheduled due time. No second form
 *                  to fill — the heads-up already showed drug + amount +
 *                  time, so one tap is enough.
 *   - "推迟 1 天" → `onDelay1d`, shifts plan.startDateH by 1 day. The
 *                   Android scheduler reschedules automatically when plans
 *                   change in AppDataContext.
 *   - "推迟 2 天" → `onDelay2d`, same shape, +2 days.
 */
const ReminderModal: React.FC<ReminderModalProps> = ({
    isOpen, pending, plan,
    onConfirm, onDelay1d, onDelay2d,
}) => {
    const { t } = useTranslation();

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
    const now = new Date();
    const overdueMs = now.getTime() - scheduled.getTime();
    const isLate = overdueMs > 0;

    const hh = scheduled.getHours().toString().padStart(2, '0');
    const mm = scheduled.getMinutes().toString().padStart(2, '0');
    const timeLabel = `${hh}:${mm}`;

    let overdueLabel = '';
    if (isLate) {
        const hours = Math.floor(overdueMs / (60 * 60 * 1000));
        const minutes = Math.round((overdueMs % (60 * 60 * 1000)) / (60 * 1000));
        overdueLabel = hours >= 1
            ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
            : `${Math.max(1, minutes)}m`;
    }

    const drugLabel = `${t(`ester.${plan.ester}`)} · ${plan.doseMG} mg · ${t(`route.${plan.route}`)}`;

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
                </div>

                {/* Body — when + (optional) overdue */}
                <div
                    className="px-6 py-5 text-sm leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <p className="font-mono text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                        {timeLabel}
                    </p>
                    {isLate ? (
                        <p style={{ color: 'var(--text-soft-rose)' }}>
                            {t('reminder.banner.late.sub') || `已过期 ${overdueLabel}，请选择下一步`}
                        </p>
                    ) : (
                        <p>
                            {t('reminder.modal.scheduled_at') || `计划服药时间 · ${timeLabel}`}
                        </p>
                    )}
                </div>

                {/* Footer — three vertical action buttons (force choice) */}
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
                    <button
                        type="button"
                        onClick={onDelay1d}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-2xl transition btn-press-glass"
                        style={{
                            background: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                        }}
                        aria-label={t('reminder.banner.delay_1d') || '推迟 1 天'}
                    >
                        <FastForward size={18} />
                        <span>{t('reminder.banner.delay_1d') || '推迟 1 天'}</span>
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
                        aria-label={t('reminder.banner.delay_2d') || '推迟 2 天'}
                    >
                        <FastForward size={18} />
                        <span>{t('reminder.banner.delay_2d') || '推迟 2 天'}</span>
                    </button>
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
