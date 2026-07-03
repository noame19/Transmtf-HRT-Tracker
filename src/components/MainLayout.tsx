import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { Settings, Plus, Activity, Calendar, FlaskConical } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAppData, PER_DOSE_WEIGHT_MIGRATION_EVENT } from '../contexts/AppDataContext';
import { formatDate, formatTime } from '../utils/helpers';
import { DoseEvent, LabResult } from '../../logic';
import { Plan } from '../../types';
import { findConflicts, matchPlansForNow } from '../utils/planSchedule';
import ReminderBanner, { PendingReminder } from './ReminderBanner';

import DoseFormModal from './DoseFormModal';
import BatchDoseModal from './BatchDoseModal';
import LabResultModal from './LabResultModal';
import PlanEditModal from './PlanEditModal';
import BatchPlanConfirmModal from './BatchPlanConfirmModal';

type ViewKey = 'home' | 'history' | 'lab' | 'settings';

const MainLayout: React.FC = () => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const navigate = useNavigate();
    const location = useLocation();
    const { events, setEvents, labResults, setLabResults, currentTime, plans, setPlans, remindersEnabled } = useAppData();

    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);
    const [isLabModalOpen, setIsLabModalOpen] = useState(false);
    const [editingLab, setEditingLab] = useState<LabResult | null>(null);
    const [isBatchOpen, setIsBatchOpen] = useState(false);

    // Plan CRUD state — managed at layout level so the PlanEditModal can be
    // opened from either the "plans" tab on /history or future surfaces.
    const [isPlanEditOpen, setIsPlanEditOpen] = useState(false);
    const [editingPlan, setEditingPlan] = useState<Plan | null>(null);

    // Smart-add flow: a new dose record can come from manual add, a single
    // matched plan (prefill + confirm), or multiple matched plans (batch).
    const [prefillFromPlan, setPrefillFromPlan] = useState<Plan | null>(null);
    const [prefillTimeOverride, setPrefillTimeOverride] = useState<Date | null>(null);
    const [batchMatches, setBatchMatches] = useState<Array<{ plan: Plan; scheduledAt: Date }> | null>(null);
    // Tolerance window for "smart match" — the plan module's matchPlansForNow
    // already uses this for its ±window, but we make it explicit here too.
    const SMART_MATCH_TOLERANCE_MIN = 15;

    // Reminder deep-link state. The Android AlarmManager writes the fired
    // notification's planId + scheduledAtMs into SharedPreferences; we poll
    // it here on a timer (so we don't need a WebSocket / push channel).
    const [pendingReminder, setPendingReminder] = useState<PendingReminder | null>(null);
    const [permissionDenied, setPermissionDenied] = useState(false);

    const mainScrollRef = useRef<HTMLDivElement>(null);

    const currentView = useMemo<ViewKey | null>(() => {
        const { pathname } = location;
        if (pathname === '/') return 'home';
        if (pathname.startsWith('/history')) return 'history';
        if (pathname.startsWith('/lab')) return 'lab';
        if (pathname.startsWith('/settings')) return 'settings';
        return null;
    }, [location.pathname]);

    const handleViewChange = (view: ViewKey) => {
        const routes: Record<ViewKey, string> = {
            home: '/',
            history: '/history',
            lab: '/lab',
            settings: '/settings',
        };
        navigate(routes[view]);
    };

    useEffect(() => {
        const handler = () => {
            showDialog('alert', t('migration.per_dose_weight'));
        };
        window.addEventListener(PER_DOSE_WEIGHT_MIGRATION_EVENT, handler);
        return () => window.removeEventListener(PER_DOSE_WEIGHT_MIGRATION_EVENT, handler);
    }, [showDialog, t]);

    /**
     * Poll the Kotlin `get_pending_reminders` bridge every 1.5s so a
     * notification that fires while the app is foregrounded surfaces as a
     * green "one-tap confirm" banner almost immediately. Web preview (no
     * `__TAURI_INTERNALS__`) is a no-op.
     */
    useEffect(() => {
        const invoke = (typeof window !== 'undefined'
            ? (window as any).__TAURI_INTERNALS__?.invoke
            : null);
        if (typeof invoke !== 'function') return;
        let cancelled = false;
        const tick = async () => {
            if (cancelled) return;
            try {
                const json = await invoke('get_pending_reminders');
                if (cancelled) return;
                if (typeof json === 'string' && json.length > 0) {
                    try {
                        const obj = JSON.parse(json);
                        if (obj && typeof obj.planId === 'string' && typeof obj.scheduledAtMs === 'number') {
                            setPendingReminder({
                                planId: obj.planId,
                                scheduledAtMs: obj.scheduledAtMs,
                                firedAtMs: obj.firedAtMs ?? Date.now(),
                            });
                        }
                    } catch { /* malformed JSON, ignore */ }
                }
            } catch { /* command not wired yet on web preview */ }
        };
        tick();
        const id = setInterval(tick, 1500);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    /**
     * Whenever the reminder permission becomes denied, flip the banner
     * flag so the amber "permission denied" hint is shown on /history. We
     * only re-check when `remindersEnabled` flips, since the user has to
     * explicitly re-toggle to retrigger the runtime permission flow.
     */
    useEffect(() => {
        const invoke = (typeof window !== 'undefined'
            ? (window as any).__TAURI_INTERNALS__?.invoke
            : null);
        if (typeof invoke !== 'function' || !remindersEnabled) {
            setPermissionDenied(false);
            return;
        }
        let cancelled = false;
        const check = async () => {
            try {
                const granted = await invoke('request_notification_permission');
                if (!cancelled) setPermissionDenied(granted === false);
            } catch {
                if (!cancelled) setPermissionDenied(false);
            }
        };
        check();
        return () => { cancelled = true; };
    }, [remindersEnabled]);

    const matchedPendingPlan = useMemo(() => {
        if (!pendingReminder) return null;
        return plans.find(p => p.id === pendingReminder.planId) ?? null;
    }, [pendingReminder, plans]);

    /**
     * Confirm the pending reminder. We bypass `matchPlansForNow` (which uses
     * the current clock) and instead target the scheduledAt from the
     * deep-link, so the saved record lines up exactly with what was
     * scheduled — even if the user tapped "confirm" an hour late.
     */
    const handleConfirmPendingReminder = (scheduledAt: Date) => {
        const plan = matchedPendingPlan;
        setPendingReminder(null);
        if (!plan) {
            // Plan was deleted since the notification fired — fall back to
            // plain smart-add so the user can still log something.
            handleSmartAddEvent(scheduledAt);
            return;
        }
        // Open the dose form directly, pre-targeting the scheduled time and
        // the matched plan. Skipping the batch confirm modal because we
        // already know exactly which plan this reminder is for.
        setEditingEvent(null);
        setPrefillFromPlan(plan);
        setPrefillTimeOverride(scheduledAt);
        setIsFormOpen(true);
    };

    useEffect(() => {
        const shouldLock = isFormOpen || isLabModalOpen || isBatchOpen || isPlanEditOpen || batchMatches !== null;
        document.body.style.overflow = shouldLock ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [isFormOpen, isLabModalOpen, isBatchOpen]);

    useEffect(() => {
        const el = mainScrollRef.current;
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
        const notifyLayout = () => window.dispatchEvent(new Event('resize'));
        const rafIds: number[] = [];
        const raf1 = requestAnimationFrame(() => {
            notifyLayout();
            rafIds.push(requestAnimationFrame(notifyLayout));
        });
        rafIds.push(raf1);
        const timers = [100, 300, 600].map(delay => setTimeout(notifyLayout, delay));
        return () => {
            rafIds.forEach(cancelAnimationFrame);
            timers.forEach(clearTimeout);
        };
    }, [location.pathname]);

    const navItems = useMemo(() => [
        { id: 'home' as ViewKey, label: t('nav.home'), icon: Activity },
        { id: 'history' as ViewKey, label: t('nav.history'), icon: Calendar },
        { id: 'lab' as ViewKey, label: t('nav.lab'), icon: FlaskConical },
        { id: 'settings' as ViewKey, label: t('nav.settings'), icon: Settings },
    ], [t]);

    const handleAddEvent = () => { setEditingEvent(null); setIsFormOpen(true); };
    const handleEditEvent = (e: DoseEvent) => { setEditingEvent(e); setIsFormOpen(true); };

    /**
     * "Smart" version of the add-event flow. Detects plans that are due
     * right now (±15 min) and either pre-fills the modal with a single match
     * or opens a batch-confirm modal when multiple plans collide.
     * `timeOverride` lets the notification deep-link pass the scheduled time
     * so the saved event lines up with what was actually scheduled.
     */
    const handleSmartAddEvent = (timeOverride?: Date | null) => {
        const refTime = timeOverride ?? currentTime;
        const matches = matchPlansForNow(plans, refTime, SMART_MATCH_TOLERANCE_MIN);
        if (matches.length === 0) {
            setEditingEvent(null);
            setPrefillFromPlan(null);
            setPrefillTimeOverride(timeOverride ?? null);
            setIsFormOpen(true);
        } else if (matches.length === 1) {
            setEditingEvent(null);
            setPrefillFromPlan(matches[0].plan);
            setPrefillTimeOverride(matches[0].scheduledAt);
            setIsFormOpen(true);
        } else {
            setBatchMatches(matches);
        }
    };
    const handleAddLabResult = () => { setEditingLab(null); setIsLabModalOpen(true); };
    const handleEditLabResult = (r: LabResult) => { setEditingLab(r); setIsLabModalOpen(true); };
    const handleClearLabResults = () => {
        if (!labResults.length) return;
        showDialog('confirm', t('lab.clear_confirm'), () => setLabResults([]));
    };
    const handleSaveEvent = (e: DoseEvent) => {
        setEvents(prev => {
            const exists = prev.find(p => p.id === e.id);
            return exists ? prev.map(p => p.id === e.id ? e : p) : [...prev, e];
        });
    };
    const handleDeleteEvent = (id: string) => {
        showDialog('confirm', t('timeline.delete_confirm'), () => {
            setEvents(prev => prev.filter(e => e.id !== id));
        });
    };
    const handleSaveBatch = (newEvents: DoseEvent[]) => {
        setEvents(prev => [...prev, ...newEvents]);
    };

    // Plan CRUD — wired through the same outlet context the records tab uses,
    // so HistoryView doesn't need to know about modals/storage directly.
    const handleAddPlan = () => { setEditingPlan(null); setIsPlanEditOpen(true); };
    const handleEditPlan = (p: Plan) => { setEditingPlan(p); setIsPlanEditOpen(true); };
    const handleSavePlan = (plan: Plan) => {
        // Conflict-rule auto-disable: if the saved plan is enabled and shares a
        // key with another enabled plan, flip the older one off so the save
        // succeeds. PlanEditModal already prompted the user about this.
        setPlans(prev => {
            const others = prev.filter(p2 => p2.id !== plan.id);
            let nextOthers = others;
            if (plan.enabled) {
                const conflicts = findConflicts(others, plan);
                if (conflicts.length > 0) {
                    const conflictIds = new Set(conflicts.map(c => c.id));
                    nextOthers = others.map(p2 => conflictIds.has(p2.id) ? { ...p2, enabled: false, updatedAtH: plan.updatedAtH } : p2);
                }
            }
            const exists = prev.some(p2 => p2.id === plan.id);
            return exists
                ? prev.map(p2 => p2.id === plan.id ? plan : (nextOthers.find(p3 => p3.id === p2.id) ?? p2))
                : [...prev, plan];
        });
        setIsPlanEditOpen(false);
        setEditingPlan(null);
    };
    const handleDeletePlan = (id: string) => {
        setPlans(prev => prev.filter(p => p.id !== id));
        setIsPlanEditOpen(false);
        setEditingPlan(null);
    };
    const handleTogglePlan = (id: string, enabled: boolean) => {
        setPlans(prev => prev.map(p => p.id === id ? { ...p, enabled, updatedAtH: Date.now() / 3600000 } : p));
    };

    return (
        <div className="h-screen w-full overflow-x-hidden flex flex-col select-none font-sans"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', overscrollBehaviorX: 'none' }}>

            {/* ── Desktop top bar ── */}
            <header className="hidden md:flex shrink-0 items-center justify-between px-6 h-16 sticky top-0 z-20 glass"
                style={{
                    boxShadow: 'var(--shadow-sm)',
                }}
            >
                <div className="flex items-center gap-3 min-w-[220px]">
                    <div className="h-9 w-9 rounded-xl border overflow-hidden"
                        style={{ borderColor: 'var(--border-primary)' }}>
                        <img src="/favicon.ico" alt="logo" className="h-full w-full object-cover" />
                    </div>
                    <p className="text-sm font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>HRT Tracker</p>
                </div>

                <nav aria-label={t('nav.aria_primary')} className="flex items-center gap-1">
                    {navItems.map(({ id, label, icon: Icon }) => {
                        const active = currentView === id;
                        return (
                            <button
                                key={id}
                                onClick={() => handleViewChange(id)}
                                aria-current={active ? 'page' : undefined}
                                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold btn-press-glass transition-all duration-200 ${
                                    active
                                        ? 'glass-btn-primary text-white'
                                        : 'glass-btn hover:bg-[var(--glass-bg-default)]'
                                }`}
                                style={active ? {} : {
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <Icon size={15} />
                                <span>{label}</span>
                            </button>
                        );
                    })}
                </nav>

                <div className="flex items-center gap-3 min-w-[260px] justify-end">
                    <div className="flex items-center gap-2 rounded-full glass-subtle px-3 py-1.5 text-xs font-semibold"
                        style={{
                            color: 'var(--text-secondary)',
                        }}>
                        <span>{formatDate(currentTime, lang)}</span>
                        <span style={{ color: 'var(--accent-300)' }}>·</span>
                        <span className="font-mono">{formatTime(currentTime)}</span>
                    </div>
                    <button
                        onClick={handleAddEvent}
                        className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold text-white glass-btn-primary btn-press-glass transition"
                    >
                        <Plus size={15} />
                        <span>{t('btn.add')}</span>
                    </button>
                </div>
            </header>

            {/* ── Scrollable content ── */}
            <main
                ref={mainScrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden"
                style={{ background: 'var(--bg-secondary)', overscrollBehaviorX: 'none', touchAction: 'pan-y' }}
            >
                <div
                    key={location.pathname}
                    className="min-h-full max-w-full overflow-x-hidden"
                    style={{ animation: 'fadeSlideIn 0.25s ease-out' }}
                >
                    <Outlet context={{
                        onEditEvent: handleEditEvent,
                        onAddEvent: handleSmartAddEvent,
                        onBatchAdd: () => setIsBatchOpen(true),
                        onAddLabResult: handleAddLabResult,
                        onEditLabResult: handleEditLabResult,
                        onClearLabResults: handleClearLabResults,
                        onAddPlan: handleAddPlan,
                        onEditPlan: handleEditPlan,
                        onDeletePlan: handleDeletePlan,
                        onTogglePlan: handleTogglePlan,
                        pendingReminder,
                        matchedPendingPlan,
                        onConfirmPendingReminder: handleConfirmPendingReminder,
                        onDismissPendingReminder: () => setPendingReminder(null),
                        permissionDenied,
                        onOpenNotificationSettings: async () => {
                            const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
                            if (!invoke) return;
                            try { await invoke('request_notification_permission'); } catch { /* ignore */ }
                        },
                    }} />
                    {/* bottom padding so content isn't hidden behind the mobile nav */}
                    <div className="h-24 md:h-4" />
                </div>
            </main>

            {/* ── Mobile bottom nav — Glass Pill ── */}
            <nav aria-label={t('nav.aria_mobile')} className="fixed bottom-0 left-0 right-0 z-40 md:hidden px-3 pt-1 pb-3"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)', background: 'linear-gradient(to top, var(--bg-secondary) 75%, transparent)' }}>
                <div
                    className="rounded-3xl px-1.5 py-1.5 glass"
                    style={{
                        boxShadow: 'var(--shadow-md)',
                    }}
                >
                    <div className="grid grid-cols-4">
                        {navItems.map(({ id, label, icon: Icon }) => {
                            const active = currentView === id;
                            return (
                                <button
                                    key={id}
                                    onClick={() => handleViewChange(id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={`relative flex flex-col items-center gap-0.5 py-2.5 px-1 rounded-2xl transition-all duration-200 btn-press-glass ${
                                        active ? 'glass-btn' : ''
                                    }`}
                                >
                                    <Icon
                                        size={22}
                                        style={{
                                            color: active ? 'var(--accent-500)' : 'var(--text-tertiary)',
                                            transition: 'color 0.2s',
                                        }}
                                    />
                                    <span
                                        className="text-[10px] font-semibold leading-none"
                                        style={{
                                            color: active ? 'var(--accent-500)' : 'var(--text-tertiary)',
                                            transition: 'color 0.2s',
                                        }}
                                    >
                                        {label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </nav>

            <style>{`
                @keyframes fadeSlideIn {
                    from { opacity: 0; transform: translateY(6px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>

            {/* ── Modals ── */}
            <DoseFormModal
                isOpen={isFormOpen}
                onClose={() => {
                    setIsFormOpen(false);
                    setPrefillFromPlan(null);
                    setPrefillTimeOverride(null);
                }}
                eventToEdit={editingEvent}
                prefillFromPlan={prefillFromPlan}
                prefillTimeOverride={prefillTimeOverride}
                onSave={handleSaveEvent}
                onDelete={handleDeleteEvent}
            />
            <LabResultModal
                isOpen={isLabModalOpen}
                onClose={() => setIsLabModalOpen(false)}
                onSave={(result) => {
                    setLabResults(prev => {
                        const exists = prev.find(r => r.id === result.id);
                        return exists ? prev.map(r => r.id === result.id ? result : r) : [...prev, result];
                    });
                }}
                onDelete={(id) => {
                    showDialog('confirm', t('lab.delete_confirm'), () => {
                        setLabResults(prev => prev.filter(r => r.id !== id));
                    });
                }}
                resultToEdit={editingLab}
            />
            <BatchDoseModal
                isOpen={isBatchOpen}
                onClose={() => setIsBatchOpen(false)}
                onSaveBatch={handleSaveBatch}
            />
            <PlanEditModal
                isOpen={isPlanEditOpen}
                onClose={() => { setIsPlanEditOpen(false); setEditingPlan(null); }}
                planToEdit={editingPlan}
                onSave={handleSavePlan}
                onDelete={editingPlan ? handleDeletePlan : undefined}
            />
            <BatchPlanConfirmModal
                isOpen={batchMatches !== null}
                matches={batchMatches ?? []}
                events={events}
                onClose={() => setBatchMatches(null)}
                onConfirm={(newEvents) => {
                    handleSaveBatch(newEvents);
                    setBatchMatches(null);
                }}
            />
        </div>
    );
};

export default MainLayout;
