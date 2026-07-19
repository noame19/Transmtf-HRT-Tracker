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
    /** In-page banner stack — one entry per pending due. Users with
     *  multiple drugs (E2 + CPA + PRL) get one banner per drug so each
     *  can be addressed independently. Empty array → no banner rendered. */
    bannerEntries: { plan: Plan; pending: PendingReminder }[];
    /** Banner action handlers. Each takes `scheduledAtMs` so the handler
     *  can disambiguate which banner is acting (the modal's source is
     *  always implied by `pendingReminder`, but the banner has many). */
    onConfirmBanner: (scheduledAtMs: number) => void;
    onSkipBanner: (scheduledAtMs: number) => void;
    onDelay1d: (planId: string, scheduledAtMs: number) => void;
    onDelay2d: (planId: string, scheduledAtMs: number) => void;
    permissionDenied: boolean;
    onOpenNotificationSettings?: () => void;
    onBulkDeleteEvents: (ids: string[]) => void;
    onBulkDeletePlans: (ids: string[]) => void;
}

const HistoryPage: React.FC = () => {
    const {
        onAddEvent, onEditEvent, onBatchAdd,
        onAddPlan, onEditPlan, onDeletePlan, onTogglePlan,
        onRemovePatch,
        pendingReminder, matchedPendingPlan, onConfirmPendingReminder,
        bannerEntries,
        onConfirmBanner, onSkipBanner,
        onDelay1d, onDelay2d,
        permissionDenied, onOpenNotificationSettings,
        onBulkDeleteEvents, onBulkDeletePlans,
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
            bannerEntries={bannerEntries}
            onConfirmBanner={onConfirmBanner}
            onSkipBanner={onSkipBanner}
            onDelay1d={onDelay1d}
            onDelay2d={onDelay2d}
            permissionDenied={permissionDenied}
            onOpenNotificationSettings={onOpenNotificationSettings}
            complianceMismatches={complianceMismatches}
            onBulkDeleteEvents={onBulkDeleteEvents}
            onBulkDeletePlans={onBulkDeletePlans}
        />
    );
};

export default HistoryPage;