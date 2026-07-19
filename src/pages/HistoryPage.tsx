import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAppData } from '../contexts/AppDataContext';
import { DoseEvent } from '../../logic';
import { Plan } from '../../types';
import HistoryView from '../views/HistoryView';
import WhitelistBanner from '../components/WhitelistBanner';
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

const WHITELIST_DISMISS_KEY = 'hrt-whitelist-dismissed-v1';
// ROM vendor names that aggressively kill background apps and require the
// user to manually enable auto-start in their custom settings page.
// Matched case-insensitively against Build.MANUFACTURER on the Android side,
// but here we just detect non-AOSP via userAgent sniffing for the web preview.
const AGGRESSIVE_OEM_RE = /(xiaomi|redmi|poco|huawei|honor|oppo|realme|vivo|iqoo|oneplus|letv|samsung)/i;

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

    // ── Background-whitelist banner state ──────────────────────────────
    // We surface a banner when (a) we're on Android, (b) battery optimization
    // is NOT ignored (i.e. our alarms may be deferred to maintenance windows
    // by Doze), or (c) we're on a known aggressive-OEM ROM where the user
    // has to manually toggle auto-start in their custom settings page.
    // The banner auto-hides once both checks come back green, or once the
    // user explicitly dismisses it (persisted in localStorage so we don't
    // pester them every cold start).
    const [batteryIgnored, setBatteryIgnored] = useState<boolean>(true);
    const [onAggressiveOem, setOnAggressiveOem] = useState<boolean>(false);
    const [whitelistDismissed, setWhitelistDismissed] = useState<boolean>(() => {
        try {
            return localStorage.getItem(WHITELIST_DISMISS_KEY) === '1';
        } catch { return false; }
    });

    const recheckWhitelist = useCallback(async () => {
        const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            // Web preview — no banner.
            setBatteryIgnored(true);
            setOnAggressiveOem(false);
            return;
        }
        try {
            const ignored = await invoke('is_battery_optimization_ignored');
            setBatteryIgnored(ignored === true);
        } catch {
            // If the command fails, assume worst case so the banner shows.
            setBatteryIgnored(false);
        }
        // Rough OEM sniff: in Tauri on Android, the user agent typically
        // contains the model hint (e.g. "Xiaomi/Redmi..."). On web, no
        // banner needed (no auto-start toggle to chase).
        try {
            const ua = (navigator?.userAgent || '');
            setOnAggressiveOem(AGGRESSIVE_OEM_RE.test(ua));
        } catch {
            setOnAggressiveOem(false);
        }
    }, []);

    useEffect(() => {
        recheckWhitelist();
        // Re-check when the tab regains focus — the user just came back from
        // the battery / auto-start settings page and may have toggled it.
        const onFocus = () => recheckWhitelist();
        const onVisible = () => { if (document.visibilityState === 'visible') recheckWhitelist(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [recheckWhitelist]);

    const handleDismissWhitelist = () => {
        try { localStorage.setItem(WHITELIST_DISMISS_KEY, '1'); } catch { /* ignore */ }
        setWhitelistDismissed(true);
    };

    const showWhitelistBanner =
        !whitelistDismissed && (!batteryIgnored || onAggressiveOem);

    return (
        <>
            {showWhitelistBanner && (
                <WhitelistBanner
                    batteryIgnored={batteryIgnored}
                    onAggressiveOem={onAggressiveOem}
                    onDismiss={handleDismissWhitelist}
                />
            )}
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
        </>
    );
};

export default HistoryPage;