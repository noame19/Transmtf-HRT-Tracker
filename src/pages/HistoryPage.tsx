import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAppData } from '../contexts/AppDataContext';
import { DoseEvent } from '../../logic';
import { Plan } from '../../types';
import HistoryView from '../views/HistoryView';
import type { PendingReminder } from '../components/ReminderBanner';

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
        permissionDenied, onOpenNotificationSettings,
    } = useOutletContext<OutletContext>();
    const { events, plans } = useAppData();

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
            permissionDenied={permissionDenied}
            onOpenNotificationSettings={onOpenNotificationSettings}
        />
    );
};

export default HistoryPage;