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
    pendingReminder: PendingReminder | null;
    matchedPendingPlan: Plan | null;
    onConfirmPendingReminder: (scheduledAt: Date) => void;
    onDismissPendingReminder: () => void;
    onDelay1d?: (planId: string) => void;
    onDelay2d?: (planId: string) => void;
    onDelayNext?: (planId: string) => void;
    permissionDenied: boolean;
    onOpenNotificationSettings?: () => void;
}

const HistoryPage: React.FC = () => {
    const {
        onAddEvent, onEditEvent, onBatchAdd,
        onAddPlan, onEditPlan, onDeletePlan, onTogglePlan,
        onRemovePatch,
        pendingReminder, matchedPendingPlan,
        onConfirmPendingReminder, onDismissPendingReminder,
        onDelay1d, onDelay2d, onDelayNext,
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
            onDismissPendingReminder={onDismissPendingReminder}
            onDelay1d={onDelay1d}
            onDelay2d={onDelay2d}
            onDelayNext={onDelayNext}
            permissionDenied={permissionDenied}
            onOpenNotificationSettings={onOpenNotificationSettings}
            complianceMismatches={complianceMismatches}
        />
    );
};

export default HistoryPage;