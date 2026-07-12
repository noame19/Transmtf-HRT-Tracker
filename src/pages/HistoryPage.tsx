import React, { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAppData } from '../contexts/AppDataContext';
import { DoseEvent } from '../../logic';
import { Plan } from '../../types';
import HistoryView from '../views/HistoryView';
import type { PendingReminder } from '../components/ReminderBanner';
import { analyzePlanCompliance } from '../utils/planCompliance';

interface OutletContext {
    onAddEvent: () => void;
    onEditEvent: (event: DoseEvent) => void;
    onBatchAdd: () => void;
    onAddPlan: () => void;
    onEditPlan: (p: Plan) => void;
    onDeletePlan: (id: string) => void;
    onTogglePlan: (id: string, enabled: boolean) => void;
    onRemovePatch: (applyId: string) => void;
    /** Modal deep-link state (1-tap confirm via heads-up notification).
     *  Currently the /history view does not surface the modal — it lives at
     *  MainLayout level so it overrides any route. We still pass these down
     *  so a future edit-modal integration can pre-fill from the same payload. */
    pendingReminder: PendingReminder | null;
    matchedPendingPlan: Plan | null;
    onConfirmPendingReminder: (scheduledAt: Date) => void;
    /** In-page banner state. Drives the ReminderBanner at the top of
     *  /history AND the red-dot on the bottom-nav "用药" tab. Survives
     *  modal dismissal (X) — only the user's own action (已服用/跳过/推迟)
     *  on the banner clears it. */
    bannerDue: PendingReminder | null;
    matchedBannerPlan: Plan | null;
    onConfirmBanner: (scheduledAt: Date) => void;
    onSkipBanner: () => void;
    onDelay1d: (planId: string) => void;
    onDelay2d: (planId: string) => void;
    permissionDenied: boolean;
    onOpenNotificationSettings?: () => void;
}

const HistoryPage: React.FC = () => {
    const {
        onAddEvent, onEditEvent, onBatchAdd,
        onAddPlan, onEditPlan, onDeletePlan, onTogglePlan,
        onRemovePatch,
        pendingReminder, matchedPendingPlan, onConfirmPendingReminder,
        bannerDue, matchedBannerPlan,
        onConfirmBanner, onSkipBanner,
        onDelay1d, onDelay2d,
        permissionDenied, onOpenNotificationSettings,
    } = useOutletContext<OutletContext>();
    const { events, plans, currentTime } = useAppData();

    // Plan-vs-history compliance check. Re-runs whenever events / plans / the
    // minute-tick currentTime change so the banner reacts to new doses, plan
    // edits, and the day-rollover window. `mismatches` only — the banner
    // re-reads localStorage for its own dismiss state.
    const complianceMismatches = useMemo(
        () => analyzePlanCompliance(events, plans, currentTime).mismatches,
        [events, plans, currentTime],
    );

    return (
        <HistoryView
            events={events}
            onAddEvent={onAddEvent}
            onEditEvent={onEditEvent}
            onBatchAdd={onBatchAdd}
            plans={plans}
            onAddPlan={onAddPlan}
            onEditPlan={onEditPlan}
            onDeletePlan={onDeletePlan}
            onTogglePlan={onTogglePlan}
            onRemovePatch={onRemovePatch}
            pendingReminder={pendingReminder}
            matchedPendingPlan={matchedPendingPlan}
            onConfirmPendingReminder={onConfirmPendingReminder}
            bannerDue={bannerDue}
            matchedBannerPlan={matchedBannerPlan}
            onConfirmBanner={onConfirmBanner}
            onSkipBanner={onSkipBanner}
            onDelay1d={onDelay1d}
            onDelay2d={onDelay2d}
            permissionDenied={permissionDenied}
            onOpenNotificationSettings={onOpenNotificationSettings}
            complianceMismatches={complianceMismatches}
        />
    );
};

export default HistoryPage;