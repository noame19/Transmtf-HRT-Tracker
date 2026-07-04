import React, { useMemo, useState } from 'react';
import { Activity, Plus, Layers, CalendarClock, Sticker } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { formatDate, formatDateTime, formatTime, getRouteIcon } from '../utils/helpers';
import { DoseEvent, Route as RouteEnum, Ester, ExtraKey, getToE2Factor, isAntiandrogen } from '../../logic';
import { Plan } from '../../types';
import PlanList from '../components/PlanList';
import ReminderBanner, { PendingReminder } from '../components/ReminderBanner';
import { isPatchApply, isPatchRemove, findPatchRemoveForApply } from '../utils/patch';

type HistoryTab = 'records' | 'plans';

interface HistoryViewProps {
  events: DoseEvent[];
  onAddEvent: () => void;
  onEditEvent: (event: DoseEvent) => void;
  onBatchAdd: () => void;
  plans: Plan[];
  onAddPlan: () => void;
  onEditPlan: (p: Plan) => void;
  onDeletePlan: (id: string) => void;
  onTogglePlan: (id: string, enabled: boolean) => void;
  /**
   * One-tap "贴片移除" handler. Receives the apply event's id; the parent
   * appends a `Route.patchRemove` event stamped with the same
   * `companionGroupId` and `timeH = Date.now()`. The button is only shown
   * for apply events with no paired remove (so this callback is only ever
   * invoked when a remove is genuinely missing).
   */
  onRemovePatch: (applyId: string) => void;
  // Reminder deep-link state + handlers (passed through from MainLayout).
  pendingReminder: PendingReminder | null;
  matchedPendingPlan: Plan | null;
  onConfirmPendingReminder: (scheduledAt: Date) => void;
  onDismissPendingReminder: () => void;
  permissionDenied: boolean;
  onOpenNotificationSettings?: () => void;
}

const HistoryView: React.FC<HistoryViewProps> = ({
  events, onAddEvent, onEditEvent, onBatchAdd,
  plans, onAddPlan, onEditPlan, onDeletePlan, onTogglePlan,
  onRemovePatch,
  pendingReminder, matchedPendingPlan,
  onConfirmPendingReminder, onDismissPendingReminder,
  permissionDenied, onOpenNotificationSettings,
}) => {
  const { t, lang } = useTranslation();
  const [activeTab, setActiveTab] = useState<HistoryTab>('records');

  const groupedEvents = useMemo(() => {
    const sorted = [...events].sort((a, b) => b.timeH - a.timeH);
    const groups: Record<string, DoseEvent[]> = {};
    sorted.forEach(e => {
      const d = formatDate(new Date(e.timeH * 3600000), lang);
      if (!groups[d]) groups[d] = [];
      groups[d].push(e);
    });
    return groups;
  }, [events, lang]);

  return (
    <div className="relative space-y-5 pt-6 pb-16">
      {/* Reminder banner — sits above the tab strip so a fired notification
       *  is impossible to miss on the /history route. */}
      <ReminderBanner
        pending={pendingReminder}
        matchedPlan={matchedPendingPlan}
        onConfirm={onConfirmPendingReminder}
        onDismiss={onDismissPendingReminder}
        permissionDenied={permissionDenied}
        onOpenPermissionSettings={onOpenNotificationSettings}
      />
      <div className="px-4">
        <div className="w-full p-4 rounded-2xl glass-card glass-highlight relative overflow-hidden flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-3"
            style={{ color: 'var(--text-primary)' }}>
            <Activity size={22} style={{ color: 'var(--accent-300)' }} /> {activeTab === 'plans' ? t('timeline.plans_tab') : t('timeline.records_tab')}
          </h2>
          <div className="flex items-center gap-2">
            {activeTab === 'records' ? (
              <>
                <button
                  onClick={() => onBatchAdd()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 h-11 rounded-xl text-sm font-bold btn-press-glass transition"
                  style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                >
                  <Layers size={15} />
                  <span>{t('batch.title')}</span>
                </button>
                <button
                  onClick={() => onAddEvent()}
                  className="inline-flex items-center justify-center gap-2 px-3.5 py-2 h-11 rounded-xl text-white text-sm font-bold btn-press-glass transition glass-btn-primary"
                >
                  <Plus size={16} />
                  <span>{t('btn.add')}</span>
                </button>
              </>
            ) : (
              <button
                onClick={() => onAddPlan()}
                className="inline-flex items-center justify-center gap-2 px-3.5 py-2 h-11 rounded-xl text-white text-sm font-bold btn-press-glass transition glass-btn-primary"
              >
                <Plus size={16} />
                <span>{t('plan.new') || '新增计划'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div className="px-4">
        <div className="flex gap-1 p-1 rounded-xl glass-card">
          <button
            onClick={() => setActiveTab('records')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition btn-press-glass ${activeTab === 'records' ? 'glass-btn-primary text-white' : ''}`}
            style={activeTab !== 'records' ? { color: 'var(--text-secondary)' } : undefined}
          >
            <Activity size={14} />
            <span>{t('timeline.records_tab') || '用药记录'}</span>
          </button>
          <button
            onClick={() => setActiveTab('plans')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition btn-press-glass ${activeTab === 'plans' ? 'glass-btn-primary text-white' : ''}`}
            style={activeTab !== 'plans' ? { color: 'var(--text-secondary)' } : undefined}
          >
            <CalendarClock size={14} />
            <span>{t('timeline.plans_tab') || '用药计划'}</span>
          </button>
        </div>
      </div>

      {/* Records tab */}
      {activeTab === 'records' && (
        <>
          {Object.keys(groupedEvents).length === 0 && (
            <div className="mx-4 text-center py-12 rounded-3xl border border-dashed"
              style={{ color: 'var(--text-tertiary)', background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
              <p>{t('timeline.empty')}</p>
            </div>
          )}

          {Object.entries(groupedEvents).map(([date, items]) => (
            <div key={date} className="relative mx-4 rounded-2xl glass-card overflow-hidden">
              <div className="sticky top-0 py-3 px-4 z-0 flex items-center gap-2 border-b glass"
                style={{ borderColor: 'var(--border-secondary)' }}>
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent-300)' }}></div>
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{date}</span>
              </div>
              <div className="divide-y" style={{ divideColor: 'var(--border-secondary)' }}>
                {(items as DoseEvent[])
                  .filter(ev => !isPatchRemove(ev))
                  .map(ev => {
                  // Patch-apply cards get an inline "贴片移除" button when
                  // there's no paired remove. Resolving the pair at render
                  // time means the button vanishes automatically the moment
                  // a new remove event is appended (re-render reads the
                  // updated `events` prop).
                  const pairedRemove = isPatchApply(ev) ? findPatchRemoveForApply(ev, events) : null;
                  const showRemoveBtn = isPatchApply(ev) && !pairedRemove;
                  return (
                  <div
                    key={ev.id}
                    onClick={() => onEditEvent(ev)}
                    className="p-4 flex items-center gap-4 transition-all cursor-pointer group relative btn-press-glass"
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border`}
                      style={{
                        background: ev.route === RouteEnum.injection ? 'var(--accent-50)' : 'var(--bg-card-hover)',
                        borderColor: ev.route === RouteEnum.injection ? 'var(--accent-200)' : 'var(--border-primary)',
                      }}>
                      {getRouteIcon(ev.route)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                          {isPatchRemove(ev) ? t('route.patchRemove') : t(`ester.${ev.ester}`)}
                        </span>
                        <span className="font-mono text-[11px] font-medium px-2 py-1 rounded-md border"
                          style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                          {formatTime(new Date(ev.timeH * 3600000))}
                        </span>
                      </div>
                      <div className="text-xs font-medium space-y-1" style={{ color: 'var(--text-secondary)' }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="truncate">{t(`route.${ev.route}`)}</span>
                          {ev.extras[ExtraKey.releaseRateUGPerDay] && (
                            <>
                              <span style={{ color: 'var(--text-tertiary)' }}>•</span>
                              <span style={{ color: 'var(--text-primary)' }}>{`${ev.extras[ExtraKey.releaseRateUGPerDay]} µg/d`}</span>
                            </>
                          )}
                          <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border ml-auto" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                            {`${ev.weightKG} ${t('field.weight_unit')}`}
                          </span>
                        </div>
                        {!isPatchRemove(ev) && !ev.extras[ExtraKey.releaseRateUGPerDay] && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: 'var(--text-primary)' }}>
                            <span>{`${t('timeline.dose_label')}: ${ev.doseMG.toFixed(2)} mg`}</span>
                            {ev.ester !== Ester.E2 && !isAntiandrogen(ev.ester) && (
                              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                {`(${ (ev.doseMG * getToE2Factor(ev.ester)).toFixed(2) } mg E2)`}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Patch pairing: when an apply has a paired remove,
                         * surface the FULL date+time of the remove as a subtle
                         * line so the user sees both ends of the wear window
                         * without scrolling. The remove event itself is hidden
                         * from the list (it's a bookkeeping event, not a
                         * distinct dose). The year is included to keep the hint
                         * unambiguous across year boundaries. */}
                        {isPatchApply(ev) && pairedRemove && (
                          <div className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-tertiary)' }}>
                            <Sticker size={11} />
                            <span>
                              {t('overview.patch_removed_at')
                                ? t('overview.patch_removed_at').replace('{dateTime}', formatDateTime(new Date(pairedRemove.timeH * 3600000), lang))
                                : `${t('route.patchRemove')} ${formatDateTime(new Date(pairedRemove.timeH * 3600000), lang)}`}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* One-tap "贴片移除" button. We use stopPropagation so
                     *  tapping the button records the remove NOW and never
                     *  opens the edit modal — that's the entire UX point. */}
                    {showRemoveBtn && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemovePatch(ev.id);
                        }}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 h-9 rounded-xl text-xs font-bold btn-press-glass transition"
                        style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
                        aria-label={t('btn.patch_remove') || '贴片移除'}
                      >
                        <Sticker size={13} />
                        <span>{t('btn.patch_remove') || '贴片移除'}</span>
                      </button>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Plans tab */}
      {activeTab === 'plans' && (
        <PlanList
          plans={plans}
          onAddPlan={onAddPlan}
          onEditPlan={onEditPlan}
          onDeletePlan={onDeletePlan}
          onTogglePlan={onTogglePlan}
        />
      )}
    </div>
  );
};

export default HistoryView;