import React, { useEffect, useMemo, useState, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAppData } from '../contexts/AppDataContext';
import CustomSelect from './CustomSelect';
import QuickDosePanel from './QuickDosePanel';
import { getRouteIcon } from '../utils/helpers';
import {
    ROUTE_DISPLAY_ORDER, getAvailableEsters, getAllGelProducts,
    hasQuickDosePanel, isPresetDose, drugKeyOf,
    readDoseByDrug, readLastDrug, readLastGelEvent,
    LEVEL_BADGE_STYLES, LEVEL_CONTAINER_STYLES, formatGuideNumber,
    computeDoseGuide, getDefaultDoseFor,
    DoseLevelKey,
} from '../utils/doseForm';
import {
    Ester, ExtraKey, Plan, PlanSchedule, Route,
    GelSite, GEL_SITE_ORDER, GEL_PRODUCTS, GEL_DEFAULT_PRODUCT_ID,
    GEL_COVERAGE_TEMPLATES, GEL_COVERAGE_DEFAULT_IDX, GEL_COVERAGE_MANUAL_IDX,
    GEL_COAPPLICATION_ORDER, type GelProductSpec,
    resolveGelCoverageArea, isAntiandrogen,
    SL_TIER_ORDER, SublingualTierParams,
} from '../../logic';
import { findConflicts, validatePlan } from '../utils/planSchedule';
import { analyzePlanCompliance } from '../utils/planCompliance';
import { X, Save, Trash2, Calendar, Droplet, AlertTriangle, Info, Clock } from 'lucide-react';

interface PlanEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** When provided, modal is in "edit" mode; otherwise it creates a new plan. */
    planToEdit?: Plan | null;
    onSave: (plan: Plan) => void;
    onDelete?: (id: string) => void;
}

/** Build an ISO local date string (`YYYY-MM-DD`) from a Date, in user's tz. */
function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` string into a local-midnight Date. */
function parseLocalDate(s: string): Date {
    const [y, m, d] = s.split('-').map((v) => parseInt(v, 10));
    return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

const DEFAULT_SCHEDULE: PlanSchedule = { kind: 'every_n_days', intervalDays: 5, times: ['20:00'] };

const PlanEditModal: React.FC<PlanEditModalProps> = ({ isOpen, onClose, planToEdit, onSave, onDelete }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const { plans, gelProducts, events } = useAppData();

    // Form state
    const [route, setRoute] = useState<Route>(Route.injection);
    const [ester, setEster] = useState<Ester>(Ester.EV);
    // 初始为空 — isOpen effect 会按 (route, ester) + per-drug memo + DEFAULT_DOSE_MAP 填入。
    // 2026-07-20：以前硬编码 '5'，导致切到 CPA/黄体酮/凝胶时默认值全错。
    const [doseStr, setDoseStr] = useState('');
    const [useCustomDose, setUseCustomDose] = useState(false);

    // Patch-specific state — mirrors DoseFormModal so a plan's "贴片" entry
    // can express either a total mg per application or a µg/d release rate.
    // Both data sources coexist in `extras` so a generated DoseEvent can later
    // pick up whichever mode the user picked.
    const [patchMode, setPatchMode] = useState<'dose' | 'rate'>('dose');
    const [patchRate, setPatchRate] = useState('');

    // Sublingual tier / theta — 2026-07-20 补齐，让「用药计划」和「用药记录」
    // 在含服给药时 θ 参数完全一致。如果计划没设 → 默认 tier=2（standard, θ=0.11），
    // 而用户在 DoseFormModal 改了 tier=1 → record 用 tier=1。两条路径血药浓度会偏移。
    // DoseFormModal 同款字段，照搬以保持行为一致。
    const [slTier, setSlTier] = useState(2);
    const [useCustomTheta, setUseCustomTheta] = useState(false);
    const [customTheta, setCustomTheta] = useState('');

    // Gel-specific state — mirrors DoseFormModal so the plan's gel context
    // flows into auto-generated DoseEvents (smart-prefill reads these verbatim).
    const allGelProducts = useMemo(() => getAllGelProducts(gelProducts), [gelProducts]);
    const findGelProduct = (id: number): GelProductSpec =>
        allGelProducts.find((p) => p.id === id) ?? GEL_PRODUCTS[0];
    const [gelSite, setGelSite] = useState(0);
    const [gelProductId, setGelProductId] = useState<number>(GEL_DEFAULT_PRODUCT_ID);
    const [gelArea, setGelArea] = useState('');
    const [gelCoverage, setGelCoverage] = useState<number>(GEL_COVERAGE_DEFAULT_IDX);
    const [gelCoApplied, setGelCoApplied] = useState<number>(0);
    const [gelWash, setGelWash] = useState('');

    // 跟踪 drugKey，防止 route/ester 切换时 per-drug effect 重复触发
    // (DoseFormModal 同款写法)。空 ref = 未 hydrate。
    const prevDrugKeyRef = useRef<string | null>(null);
    // 跟踪 gel 是否已预填，避免 route 反复横跳时重复预填。
    const gelPrefilledRef = useRef(false);

    // slExtras 派生 — DoseFormModal 同款。route===sublingual 时根据 useCustomTheta
    // 决定写 sublingualTheta 还是 sublingualTier 到 extras。
    const slExtras = useMemo(() => {
        if (route !== Route.sublingual) return null;
        if (useCustomTheta) {
            const parsed = parseFloat(customTheta);
            const theta = Number.isFinite(parsed) ? parsed : 0.11;
            const clamped = Math.max(0, Math.min(1, theta));
            return { [ExtraKey.sublingualTheta]: clamped };
        }
        return { [ExtraKey.sublingualTier]: slTier };
    }, [route, useCustomTheta, customTheta, slTier]);

    const [scheduleKind, setScheduleKind] = useState<PlanSchedule['kind']>('every_n_days');
    const [intervalDays, setIntervalDays] = useState('5');
    const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]); // Mon Wed Fri
    const [times, setTimes] = useState<string[]>(['20:00']);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [leadMinutes, setLeadMinutes] = useState('5');
    const [enabled, setEnabled] = useState(true);

    // Hydrate from `planToEdit` whenever the modal opens. Reset all fields first
    // so a stale field doesn't leak across opens.
    useEffect(() => {
        if (!isOpen) return;
        if (planToEdit) {
            setRoute(planToEdit.route);
            setEster(planToEdit.ester);
            setDoseStr(String(planToEdit.doseMG));
            setScheduleKind(planToEdit.schedule.kind);
            if (planToEdit.schedule.kind === 'every_n_days') {
                setIntervalDays(String(planToEdit.schedule.intervalDays));
            }
            if (planToEdit.schedule.kind === 'weekly') {
                setWeekdays(planToEdit.schedule.weekdays);
            }
            setTimes(planToEdit.schedule.times.length > 0 ? planToEdit.schedule.times : ['20:00']);
            setStartDate(toLocalDateStr(new Date(planToEdit.startDateH * 3600000)));
            setEndDate(planToEdit.endDateH ? toLocalDateStr(new Date(planToEdit.endDateH * 3600000)) : '');
            setLeadMinutes(String(planToEdit.leadMinutes));
            setEnabled(planToEdit.enabled);

            // Patch extras: detect mode from which field is populated. A legacy
            // plan with only a total mg dose falls back to "dose" mode so the
            // edit form mirrors the original entry.
            const planExtras = planToEdit.extras ?? {};
            const rate = planExtras[ExtraKey.releaseRateUGPerDay];
            if (typeof rate === 'number' && rate > 0) {
                setPatchMode('rate');
                setPatchRate(String(rate));
            } else {
                setPatchMode('dose');
                setPatchRate('');
            }

            // Gel extras.
            setGelSite(planExtras[ExtraKey.gelSite] ?? 0);
            setGelProductId(planExtras[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
            const areaRaw = planExtras[ExtraKey.areaCM2];
            setGelArea(typeof areaRaw === 'number' && areaRaw > 0 ? String(areaRaw) : '');
            const covRaw = planExtras[ExtraKey.gelCoverage];
            setGelCoverage(typeof covRaw === 'number' && Number.isFinite(covRaw) ? Math.round(covRaw) : GEL_COVERAGE_DEFAULT_IDX);
            const coAppRaw = planExtras[ExtraKey.gelCoApplied];
            setGelCoApplied(typeof coAppRaw === 'number' && Number.isFinite(coAppRaw) ? Math.round(coAppRaw) : 0);
            const washRaw = planExtras[ExtraKey.gelWashAfterH];
            setGelWash(typeof washRaw === 'number' && washRaw > 0 ? String(washRaw) : '');

            // Sublingual tier / theta — 与 DoseFormModal 同款 hydrate。
            if (route === Route.sublingual) {
                if (planExtras[ExtraKey.sublingualTier] !== undefined) {
                    setSlTier(planExtras[ExtraKey.sublingualTier] as number);
                    setUseCustomTheta(false);
                    setCustomTheta('');
                } else if (planExtras[ExtraKey.sublingualTheta] !== undefined) {
                    setUseCustomTheta(true);
                    setCustomTheta(String(planExtras[ExtraKey.sublingualTheta]));
                } else {
                    setUseCustomTheta(false);
                    setCustomTheta('');
                }
            } else {
                setUseCustomTheta(false);
                setCustomTheta('');
            }
        } else {
            // 新建计划：默认 (route, ester) 按 readLastDrug()，与 DoseFormModal 一致，
            // 让用户接着上次用的东西继续（避免每次都从 EV 肌注 5mg 起步）。
            // doseStr / gel 字段由独立 effect 按 per-drug memo + DEFAULT_DOSE_MAP / 上次凝胶事件预填。
            const last = readLastDrug();
            const initRoute: Route = last?.route ?? Route.injection;
            const initEster: Ester = last?.ester ?? Ester.EV;
            setRoute(initRoute);
            setEster(initEster);
            setDoseStr('');
            setUseCustomDose(false);
            setPatchMode('dose');
            setPatchRate('');
            setGelSite(0);
            setGelProductId(GEL_DEFAULT_PRODUCT_ID);
            setGelArea('');
            setGelCoverage(GEL_COVERAGE_DEFAULT_IDX);
            setGelCoApplied(0);
            setGelWash('');
            setScheduleKind('every_n_days');
            setIntervalDays('5');
            setWeekdays([1, 3, 5]);
            setTimes(['20:00']);
            setStartDate(toLocalDateStr(new Date()));
            setEndDate('');
            setLeadMinutes('5');
            setEnabled(true);
        }
    }, [isOpen, planToEdit]);

    // Reset ester when route changes, if the new route doesn't support the
    // current ester (mirrors DoseFormModal's pattern).
    const availableEsters = useMemo(() => getAvailableEsters(route), [route]);
    useEffect(() => {
        if (!availableEsters.includes(ester) && availableEsters.length > 0) {
            setEster(availableEsters[0]);
        }
    }, [availableEsters, ester]);

    // Per-drug dose defaulting — 2026-07-20 改造。
    // 新计划首次进入某个 (route, ester) 时：优先 per-drug memo (DoseFormModal 已写入)，
    // 其次 DEFAULT_DOSE_MAP 医学推荐，再次回退到空。用户在 modal 内手动切换 (route, ester)
    // 时也走同一逻辑：让"用药计划"和"用药记录"两个表单在剂量默认值上完全一致。
    // 编辑模式跳过（planToEdit 已经携带了历史 dose）。
    useEffect(() => {
        if (!isOpen || planToEdit) {
            if (!isOpen) prevDrugKeyRef.current = null;
            return;
        }
        const key = drugKeyOf(route, ester);
        if (prevDrugKeyRef.current === key) return;
        prevDrugKeyRef.current = key;
        const memo = readDoseByDrug()[key];
        setDoseStr(getDefaultDoseFor(route, ester, memo));
        setUseCustomDose(hasQuickDosePanel(route, ester) && !isPresetDose(route, ester, parseFloat(getDefaultDoseFor(route, ester, memo))));
        // Sublingual tier / theta 跟随 per-drug memo（与 DoseFormModal 行为一致），
        // 确保计划生成的 record 和用户在 DoseFormModal 直接记录的 record 用同一个 θ。
        if (memo) {
            setSlTier(memo.slTier ?? 2);
            setUseCustomTheta(memo.useCustomTheta ?? false);
            setCustomTheta(memo.customTheta ?? '');
        } else {
            setSlTier(2);
            setUseCustomTheta(false);
            setCustomTheta('');
        }
    }, [isOpen, planToEdit, route, ester]);

    // 新计划首次进入凝胶 route 时，从最近一次凝胶用药记录预填所有凝胶字段。
    // 只读不写（计划不是真实用药记录，避免污染 hrt-dose-by-drug）。
    useEffect(() => {
        if (!isOpen || planToEdit || route !== Route.gel) {
            if (!isOpen || route !== Route.gel) gelPrefilledRef.current = false;
            return;
        }
        if (gelPrefilledRef.current) return;
        gelPrefilledRef.current = true;
        const last = readLastGelEvent(events);
        if (last) {
            setGelProductId(last.productId);
            setGelSite(last.gelSite);
            const prod = findGelProduct(last.productId);
            setGelArea(last.areaCM2 > 0 ? String(last.areaCM2) : String(prod.defaultAreaCM2));
            setGelCoverage(last.coverage >= 0 ? last.coverage : GEL_COVERAGE_DEFAULT_IDX);
            setGelCoApplied(last.coApplied > 0 ? last.coApplied : 0);
            setGelWash(last.washAfterH > 0 ? String(last.washAfterH) : '');
        }
    }, [isOpen, planToEdit, route, events]);

    const addTimeSlot = () => {
        if (times.length >= 4) return; // cap matches BatchDoseModal's timesPerDay
        setTimes([...times, '12:00']);
    };
    const removeTimeSlot = (idx: number) => {
        if (times.length <= 1) return;
        setTimes(times.filter((_, i) => i !== idx));
    };
    const updateTime = (idx: number, val: string) => {
        const next = [...times];
        next[idx] = val;
        setTimes(next);
    };
    const toggleWeekday = (day: number) => {
        setWeekdays(weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day].sort());
    };

    /** Drop the patch-mode overlay/area fields when the user navigates away
     *  from those routes, so a stale gel `areaCM2` can't accidentally leak
     *  into a freshly-edited E2-injection plan's extras. Mirrors the same
     *  hydration-only-if-necessary pattern DoseFormModal uses for its slExtras. */
    useEffect(() => {
        if (route !== Route.patchApply) {
            setPatchMode('dose');
            setPatchRate('');
        }
        if (route !== Route.gel) {
            // Don't reset product/site/co-applied — they may carry the user's
            // last gel input (mirrors DoseFormModal). We only zero out the
            // *values* specific to the gel route that would be wrong on other
            // routes (no-op since we never read these unless route===gel).
        }
    }, [route]);

    /** Coverage-template option label, mirroring DoseFormModal's gelCoverageLabel. */
    const gelCoverageLabel = (tpl: typeof GEL_COVERAGE_TEMPLATES[number], idx: number): string => {
        const base = t(`gel.coverage.${tpl.key}`);
        if (tpl.kind === 'manual') return base;
        const area = Math.round(resolveGelCoverageArea(idx, findGelProduct(gelProductId), 0));
        return `${base} (~${area} cm²)`;
    };

    /** Switching the product re-derives the manual-area placeholder to match
     *  its default; switching the coverage template does the same so the
     *  user doesn't have to retype cm² each time. */
    const handleGelProductSelect = (val: string) => {
        const id = parseInt(val, 10);
        if (!Number.isFinite(id)) return;
        setGelProductId(id);
        const manual = parseFloat(gelArea);
        setGelArea(String(resolveGelCoverageArea(gelCoverage, findGelProduct(id), manual)));
    };
    const handleGelCoverageSelect = (val: string) => {
        const idx = parseInt(val, 10) || 0;
        setGelCoverage(idx);
        const tpl = GEL_COVERAGE_TEMPLATES[idx];
        if (tpl && tpl.kind !== 'manual') {
            setGelArea(String(resolveGelCoverageArea(idx, findGelProduct(gelProductId), parseFloat(gelArea))));
        }
    };

    /** Build a Plan object from the current form state. Pure w.r.t. component
     *  state — used both by the compliance-preview useMemo and by handleSave.
     *  Centralising avoids drift between what we *preview* and what we *save*. */
    const buildDraft = (): Plan => {
        const dose = parseFloat(doseStr);
        const lead = parseInt(leadMinutes, 10);

        const startD = parseLocalDate(startDate);
        const startH = startD.getTime() / 3600000;
        const endH = endDate ? parseLocalDate(endDate).getTime() / 3600000 : undefined;

        const schedule: PlanSchedule =
            scheduleKind === 'daily'
                ? { kind: 'daily', times }
                : scheduleKind === 'every_n_days'
                    ? { kind: 'every_n_days', intervalDays: parseInt(intervalDays, 10) || 1, times }
                    : { kind: 'weekly', weekdays, times };

        // Build per-route extras so a plan with route=patchApply / route=gel
        // carries the same intent into DoseFormModal.prefillFromPlan when the
        // notification deep-link or "smart-add" path opens the dose form.
        // On non-patch / non-gel routes, extras stays `{}` so legacy plans
        // that never set these fields remain bit-identical.
        const extras: Plan['extras'] = { ...(planToEdit?.extras ?? {}) };
        if (route === Route.patchApply && patchMode === 'rate') {
            const rate = parseFloat(patchRate);
            if (Number.isFinite(rate) && rate > 0) {
                extras[ExtraKey.releaseRateUGPerDay] = rate;
            }
        } else if (route === Route.patchApply && patchMode === 'dose') {
            // Drop any stale rate carried over from a previous rate-mode save,
            // so the generated DoseEvent reads as "total dose, no rate" — same
            // invariant DoseFormModal respects on edit.
            delete extras[ExtraKey.releaseRateUGPerDay];
        }
        if (route === Route.gel) {
            extras[ExtraKey.gelSite] = gelSite;
            extras[ExtraKey.gelProductId] = gelProductId;
            const areaNum = parseFloat(gelArea);
            if (Number.isFinite(areaNum) && areaNum > 0) {
                extras[ExtraKey.areaCM2] = areaNum;
            }
            const cov = GEL_COVERAGE_TEMPLATES[gelCoverage];
            if (cov && cov.kind !== 'manual') {
                extras[ExtraKey.gelCoverage] = gelCoverage;
            }
            if (gelCoApplied > 0) {
                extras[ExtraKey.gelCoApplied] = gelCoApplied;
            }
            const washNum = parseFloat(gelWash);
            if (Number.isFinite(washNum) && washNum > 0) {
                extras[ExtraKey.gelWashAfterH] = washNum;
            }
        }
        // Sublingual tier / theta — 2026-07-20 补齐，与 DoseFormModal 同款写入策略：
        // useCustomTheta 写 sublingualTheta（覆盖），否则写 sublingualTier（覆盖）。
        // route 切走时清掉这两个 key，避免下一次保存的非 SL 计划携带 stale theta/tier。
        if (route === Route.sublingual && slExtras) {
            Object.assign(extras, slExtras);
        } else {
            delete extras[ExtraKey.sublingualTier];
            delete extras[ExtraKey.sublingualTheta];
        }

        const nowH = Date.now() / 3600000;
        return {
            id: planToEdit?.id ?? `plan-${uuidv4()}`,
            ester,
            route,
            doseMG: dose,
            schedule,
            startDateH: startH,
            endDateH: endH,
            enabled,
            leadMinutes: Number.isFinite(lead) ? lead : 5,
            extras,
            createdAtH: planToEdit?.createdAtH ?? nowH,
            updatedAtH: nowH,
        };
    };

    /** Compliance preview: substitute the current draft into `plans` and ask
     *  `analyzePlanCompliance` whether it would surface a mismatch. Renders a
     *  non-blocking amber hint at the top of the modal — we deliberately do
     *  NOT pop a confirm dialog here (the existing conflict confirm already
     *  handles "you're about to disable another plan", and stacking two
     *  dialogs on save is just noise). Only checks enabled drafts: a disabled
     *  plan doesn't participate in compliance, and the warning copy
     *  ("不建议启用") only makes sense when the toggle is on. */
    const complianceMismatch = useMemo(() => {
        if (!isOpen) return null;
        if (!enabled) return null;
        if (!startDate) return null;
        try {
            const draft = buildDraft();
            const replaced = plans.some(p => p.id === draft.id)
                ? plans.map(p => p.id === draft.id ? draft : p)
                : [...plans, draft];
            const report = analyzePlanCompliance(events, replaced, new Date());
            return report.mismatches.find(m => m.plan.id === draft.id) ?? null;
        } catch {
            return null;  // form has invalid inputs; let handleSave's validate show the proper error
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        isOpen, enabled, startDate,
        ester, route, doseStr,
        scheduleKind, intervalDays, weekdays, times,
        endDate, leadMinutes,
        patchMode, patchRate,
        gelSite, gelProductId, gelArea, gelCoverage, gelCoApplied, gelWash,
        planToEdit?.id, planToEdit?.createdAtH,
        plans, events, gelProducts,
    ]);

    /** Try to save; if the user enables a plan that conflicts with an existing
     *  enabled one, pop a confirm dialog before persisting. */
    const handleSave = async () => {
        const draft = buildDraft();

        // Validate first — reject early so we don't prompt the user about a
        // conflict for an obviously broken form.
        const errors = validatePlan(draft);
        if (errors.length > 0) {
            await showDialog('alert', `${t('plan.error.invalid') || '计划有误'}：${errors.map((e) => e.message).join('；')}`);
            return;
        }

        // Conflict rule: same (ester, route) cannot have two enabled plans.
        if (draft.enabled) {
            const conflicts = findConflicts(plans, draft);
            if (conflicts.length > 0) {
                const ok = await showDialog(
                    'confirm',
                    t('plan.conflict_disable_existing') ||
                    '同一药物的另一个计划当前已启用。保存将自动停用旧的计划。是否继续？',
                );
                if (ok !== 'confirm') return;
            }
        }

        onSave(draft);
    };

    const handleDelete = async () => {
        if (!planToEdit || !onDelete) return;
        const ok = await showDialog(
            'confirm',
            t('plan.confirm.delete') || '确定删除这条用药计划吗？',
        );
        if (ok === 'confirm') {
            onDelete(planToEdit.id);
        }
    };

    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // 剂量参考档位 — 与 DoseFormModal 同款卡片（低/中/高/超高/超出参考范围）。
    // 2026-07-20：从 utils/doseForm.computeDoseGuide 统一取，让两个表单在视觉档位上一致。
    const doseGuide = useMemo(
        () => computeDoseGuide(route, ester, isAntiandrogen, patchMode, patchRate, doseStr),
        [route, ester, patchMode, patchRate, doseStr],
    );
    const guideUnitLabel = doseGuide?.config ? t(`dose.guide.unit.${doseGuide.config.unitKey}`) : '';
    const guideRangeText = doseGuide?.config
        ? [
            `${t('dose.guide.level.low')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[0])} ${guideUnitLabel}`,
            `${t('dose.guide.level.medium')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[1])} ${guideUnitLabel}`,
            `${t('dose.guide.level.high')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[2])} ${guideUnitLabel}`,
            `${t('dose.guide.level.very_high')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[3])} ${guideUnitLabel}`,
        ].join(' · ')
        : '';
    const guideContainerClass = doseGuide
        ? (
            doseGuide.level
                ? LEVEL_CONTAINER_STYLES[doseGuide.level]
                : (doseGuide.showRateHint ? LEVEL_CONTAINER_STYLES.high : LEVEL_CONTAINER_STYLES.neutral)
        )
        : LEVEL_CONTAINER_STYLES.neutral;
    const guideBadgeClass = doseGuide?.level ? LEVEL_BADGE_STYLES[doseGuide.level] : '';

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="plan-modal-title"
                className="relative rounded-3xl w-full max-w-lg md:max-w-2xl h-[90vh] md:max-h-[85vh] flex flex-col overflow-hidden modal-spring-glass glass-modal"
            >
                {/* Header */}
                <div className="p-6 md:p-8 border-b flex justify-between items-center shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <h3 id="plan-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {planToEdit ? (t('plan.edit') || '编辑计划') : (t('plan.new') || '新增计划')}
                    </h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-6 flex-1 overflow-y-auto">
                    {/* Compliance preview hint — fires when the current draft
                     *  would surface a ComplianceBanner on /history once
                     *  saved. Non-blocking (no confirm dialog) so we don't
                     *  stack two dialogs on top of the existing
                     *  conflict-disable confirm. Hidden for disabled drafts
                     *  since compliance only checks enabled plans and the
                     *  "不建议启用" copy only applies when enabled. */}
                    {complianceMismatch && (
                        <div className="rounded-2xl p-3 flex items-start gap-2 -mb-2"
                            style={{
                                background: 'var(--bg-soft-rose)',
                                border: '1px solid var(--border-soft-rose)',
                            }}
                            role="status"
                            aria-live="polite">
                            <AlertTriangle size={16} style={{ color: 'var(--text-soft-rose)', marginTop: 2, flexShrink: 0 }} />
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                                {t('plan.compliance_warning') || '该计划与最近的用药历史不符，非换药/其他特殊情况不建议启用此计划'}
                            </p>
                        </div>
                    )}

                    {/* Drug */}
                    <div className="space-y-3">
                        <label className="block text-xs font-semibold uppercase tracking-wider"
                            style={{ color: 'var(--text-tertiary)' }}>
                            {t('plan.field.drug') || '药物'}
                        </label>
                        <CustomSelect
                            label={t('field.route')}
                            value={route}
                            onChange={(val) => setRoute(val as Route)}
                            options={ROUTE_DISPLAY_ORDER.map((r) => ({
                                value: r,
                                label: t(`route.${r}`),
                                icon: getRouteIcon(r),
                            }))}
                        />
                        {route !== Route.patchRemove && availableEsters.length >= 1 && (
                            <CustomSelect
                                label={t('field.ester')}
                                value={ester}
                                onChange={(val) => setEster(val as Ester)}
                                options={availableEsters.map((e) => ({
                                    value: e,
                                    label: t(`ester.${e}`),
                                }))}
                            />
                        )}
                        {route !== Route.patchRemove && (
                            <div className="space-y-3">
                                {/* Patch-specific: dose vs release-rate toggle, mirroring DoseFormModal */}
                                {route === Route.patchApply ? (
                                    <>
                                        <div className="p-1 rounded-xl flex" style={{ background: 'var(--bg-card-hover)' }}>
                                            <button
                                                type="button"
                                                onClick={() => setPatchMode('dose')}
                                                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all`}
                                                style={patchMode === 'dose' ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--text-tertiary)' }}
                                            >
                                                {t('field.patch_total') || '总剂量'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setPatchMode('rate')}
                                                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all`}
                                                style={patchMode === 'rate' ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--text-tertiary)' }}
                                            >
                                                {t('field.patch_rate') || '释放速率 (µg/d)'}
                                            </button>
                                        </div>
                                        {patchMode === 'dose' ? (
                                            <div className="space-y-1">
                                                <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>
                                                    {t('plan.field.dose') || '剂量'} (mg)
                                                </label>
                                                <input
                                                    type="number" inputMode="decimal" min="0.01" step="0.01"
                                                    value={doseStr}
                                                    onChange={(e) => setDoseStr(e.target.value)}
                                                    className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                                />
                                            </div>
                                        ) : (
                                            <div className="space-y-1">
                                                <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>
                                                    {t('field.patch_rate') || '释放速率'} (µg/d)
                                                </label>
                                                <input
                                                    type="number" inputMode="numeric" min="1" step="1"
                                                    value={patchRate}
                                                    onChange={(e) => setPatchRate(e.target.value)}
                                                    placeholder="e.g. 50"
                                                    className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                                />
                                                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                                    {t('hint.patch_rate_plan') || '贴片释放速率。生成用药记录时把该值写入 µ g/d。'}
                                                </p>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    /* Non-patch routes (incl. gel). 2026-07-20 改造：
                                     * 有档位预设的 (route, ester) 走 QuickDosePanel（与 DoseFormModal 同款按钮 + 手动切换），
                                     * 其它回退到简单数字输入框。剂量参考档位徽章按 (route, ester) 自动展示在下方。 */
                                    hasQuickDosePanel(route, ester) ? (
                                        <QuickDosePanel
                                            route={route}
                                            ester={ester}
                                            rawDose={doseStr}
                                            e2Dose={doseStr}
                                            useCustomDose={useCustomDose}
                                            onToggleCustom={() => setUseCustomDose(!useCustomDose)}
                                            onSelectPreset={(mg) => { setDoseStr(String(mg)); setUseCustomDose(false); }}
                                            onCustomChange={(val) => setDoseStr(val)}
                                        />
                                    ) : (
                                        <div className="space-y-1">
                                            <label className="block text-sm font-bold"
                                                style={{ color: 'var(--text-secondary)' }}>
                                                {route === Route.gel ? (t('plan.field.gel_dose') || '剂量') : (t('plan.field.dose') || '剂量')} (mg)
                                            </label>
                                            <input
                                                type="number"
                                                inputMode="decimal"
                                                min="0.01"
                                                step="0.01"
                                                value={doseStr}
                                                onChange={(e) => setDoseStr(e.target.value)}
                                                className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                style={{
                                                    background: 'var(--bg-card-hover)',
                                                    border: '1px solid var(--border-primary)',
                                                    color: 'var(--text-primary)',
                                                }}
                                            />
                                        </div>
                                    )
                                )}

                                {/* 剂量参考档位卡片 — 与 DoseFormModal 同款（低/中/高/超高/超出参考范围）。
                                 * 2026-07-20：从 utils/doseForm.computeDoseGuide 统一取值，
                                 * 贴片 dose 模式下命中 cfg.requiresRate 时提示切到释放速率模式。 */}
                                {doseGuide && (
                                    <div className={`p-4 rounded-2xl border ${guideContainerClass} flex gap-3`}>
                                        <Info className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('dose.guide.title')}</span>
                                                {doseGuide.level && (
                                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${guideBadgeClass}`}>
                                                        {t(`dose.guide.level.${doseGuide.level}`)}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                {t('dose.guide.current')}: {doseGuide.value !== null ? `${formatGuideNumber(doseGuide.value)} ${guideUnitLabel}` : t('dose.guide.current_blank')}
                                            </p>
                                            {guideRangeText && (
                                                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                                                    {t('dose.guide.reference')}: {guideRangeText}
                                                </p>
                                            )}
                                            {doseGuide.showRateHint && (
                                                <p className="text-xs text-[var(--text-soft-amber)] leading-relaxed">
                                                    {t('dose.guide.patch_rate_hint')}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Sublingual Specifics — 2026-07-20 补齐，让计划生成的 record
                                 * 用用户选择的 θ / tier，而不是默认 tier=2。镜像 DoseFormModal 1188-1236。 */}
                                {route === Route.sublingual && (
                                    <div className="bg-[var(--bg-soft-teal)] p-4 rounded-2xl border border-[var(--border-soft-teal)] space-y-4">
                                        <div className="flex justify-between items-center">
                                            <label className="text-sm font-bold text-[var(--text-bold-teal)] flex items-center gap-2">
                                                <Clock size={16} /> {t('field.sl_duration')}
                                            </label>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-medium text-[var(--text-icon-teal)]">{t('field.sl_custom')}</span>
                                                <div className={`w-10 h-6 rounded-full p-1 cursor-pointer transition-colors ${useCustomTheta ? 'bg-teal-500' : 'bg-[var(--toggle-track-off)]'}`} onClick={() => setUseCustomTheta(!useCustomTheta)}>
                                                    <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${useCustomTheta ? 'translate-x-4' : ''}`} />
                                                </div>
                                            </div>
                                        </div>

                                        {!useCustomTheta ? (
                                            <div className="space-y-3">
                                                <input
                                                    type="range" min="0" max="3" step="1"
                                                    value={slTier} onChange={e => setSlTier(parseInt(e.target.value))}
                                                    className="w-full h-2 bg-[var(--track-teal)] rounded-lg appearance-none cursor-pointer accent-teal-600"
                                                />
                                                <div className="flex justify-between text-xs font-medium text-[var(--text-icon-teal)]">
                                                    <span>{t('sl.mode.quick')}</span>
                                                    <span>{t('sl.mode.casual')}</span>
                                                    <span>{t('sl.mode.standard')}</span>
                                                    <span>{t('sl.mode.strict')}</span>
                                                </div>
                                                <div className="text-xs text-[var(--text-icon-teal)] bg-[var(--bg-info-box)] p-2 rounded-lg flex justify-between items-center">
                                                    <span>Absorption θ ≈ {SublingualTierParams[SL_TIER_ORDER[slTier] || "standard"]?.theta.toFixed(2) ?? '0.11'}</span>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <input type="number" step="0.01" max="1" min="0" value={customTheta} onChange={e => setCustomTheta(e.target.value)} className="w-full p-3 border border-[var(--border-med-teal)] rounded-xl focus:ring-2 focus:ring-teal-500 outline-none" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }} placeholder="0.0 - 1.0" />
                                                <div className="text-xs text-[var(--text-icon-teal)] bg-[var(--bg-info-box)] p-2 rounded-lg flex justify-between items-center">
                                                    <span>Absorption θ ≈ {(() => { const p = parseFloat(customTheta); const v = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0.11; return v.toFixed(2); })()}</span>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex gap-3 items-start p-3 bg-[var(--bg-tip-card)] rounded-xl border border-[var(--border-soft-teal)]">
                                            <Info className="w-5 h-5 text-teal-500 shrink-0 mt-0.5" />
                                            <p className="text-xs text-[var(--text-soft-teal)] leading-relaxed text-justify">
                                                {t('sl.instructions')}
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {/* Gel-specific: site / product / coverage / wash, mirroring DoseFormModal */}
                                {route === Route.gel && (
                                    <div className="space-y-3 pt-3 border-t" style={{ borderColor: 'var(--border-secondary)' }}>
                                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                            <Droplet size={12} />
                                            <span>{t('plan.field.gel_extras') || '凝胶详情'}</span>
                                        </div>
                                        <CustomSelect
                                            label={t('field.gel_product') || '产品'}
                                            value={String(gelProductId)}
                                            onChange={handleGelProductSelect}
                                            options={[
                                                ...(!allGelProducts.some((p) => p.id === gelProductId)
                                                    ? [{ value: String(gelProductId), label: t('gel.product.missing') || '已删除' }]
                                                    : []),
                                                ...allGelProducts.map((p) => ({
                                                    value: String(p.id),
                                                    label: p.name || t(p.nameKey),
                                                })),
                                            ]}
                                        />
                                        <CustomSelect
                                            label={t('field.gel_site') || '部位'}
                                            value={String(gelSite)}
                                            onChange={(val) => setGelSite(parseInt(val, 10) || 0)}
                                            options={[0, 1, 3, 2].map((idx) => ({
                                                value: String(idx),
                                                label: t(`gel.site.${GEL_SITE_ORDER[idx]}`),
                                            }))}
                                        />
                                        {GEL_SITE_ORDER[gelSite] !== GelSite.scrotal && (
                                            <>
                                                <CustomSelect
                                                    label={t('field.gel_coverage') || '涂抹面积'}
                                                    value={String(gelCoverage)}
                                                    onChange={handleGelCoverageSelect}
                                                    options={GEL_COVERAGE_TEMPLATES.map((tpl, idx) => ({
                                                        value: String(idx),
                                                        label: gelCoverageLabel(tpl, idx),
                                                    }))}
                                                />
                                                {GEL_COVERAGE_TEMPLATES[gelCoverage]?.kind === 'manual' && (
                                                    <div className="space-y-1">
                                                        <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>
                                                            {t('field.gel_area') || '面积'} (cm²)
                                                        </label>
                                                        <input
                                                            type="number" inputMode="decimal" min="1" step="1"
                                                            value={gelArea}
                                                            onChange={(e) => setGelArea(e.target.value)}
                                                            placeholder={String(findGelProduct(gelProductId).defaultAreaCM2)}
                                                            className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                                        />
                                                    </div>
                                                )}
                                            </>
                                        )}
                                        <CustomSelect
                                            label={t('field.gel_coapplied') || '混合护肤品'}
                                            value={String(gelCoApplied)}
                                            onChange={(val) => setGelCoApplied(parseInt(val, 10) || 0)}
                                            options={GEL_COAPPLICATION_ORDER.map((k, idx) => ({
                                                value: String(idx),
                                                label: t(`gel.coapplied.${k}`),
                                            }))}
                                        />
                                        <div className="space-y-1">
                                            <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>
                                                {t('field.gel_wash') || '清洗时间'} (h)
                                            </label>
                                            <input
                                                type="number" inputMode="decimal" min="0" step="0.5"
                                                value={gelWash}
                                                onChange={(e) => setGelWash(e.target.value)}
                                                placeholder={t('gel.wash_none') || '不洗'}
                                                className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Schedule */}
                    <div className="space-y-3">
                        <label className="block text-xs font-semibold uppercase tracking-wider"
                            style={{ color: 'var(--text-tertiary)' }}>
                            {t('plan.field.schedule') || '周期'}
                        </label>
                        <div className="flex gap-1 p-1 rounded-xl glass-card">
                            {(['daily', 'every_n_days', 'weekly'] as const).map((k) => (
                                <button
                                    key={k}
                                    onClick={() => setScheduleKind(k)}
                                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition btn-press-glass ${scheduleKind === k ? 'glass-btn-primary text-white' : ''}`}
                                    style={
                                        scheduleKind !== k
                                            ? { color: 'var(--text-secondary)' }
                                            : undefined
                                    }
                                >
                                    {t(`plan.schedule.${k}`) || k}
                                </button>
                            ))}
                        </div>

                        {scheduleKind === 'every_n_days' && (
                            <div className="space-y-1">
                                <label className="block text-sm font-bold"
                                    style={{ color: 'var(--text-secondary)' }}>
                                    {t('plan.field.interval') || '间隔（天）'}
                                </label>
                                <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={intervalDays}
                                    onChange={(e) => setIntervalDays(e.target.value)}
                                    className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                    style={{
                                        background: 'var(--bg-card-hover)',
                                        border: '1px solid var(--border-primary)',
                                        color: 'var(--text-primary)',
                                    }}
                                />
                            </div>
                        )}

                        {scheduleKind === 'weekly' && (
                            <div className="space-y-2">
                                <label className="block text-sm font-bold"
                                    style={{ color: 'var(--text-secondary)' }}>
                                    {t('plan.field.weekdays') || '星期'}
                                </label>
                                <div className="flex gap-1.5 flex-wrap">
                                    {weekdayLabels.map((label, idx) => {
                                        const selected = weekdays.includes(idx);
                                        return (
                                            <button
                                                key={idx}
                                                onClick={() => toggleWeekday(idx)}
                                                className="w-12 py-2 rounded-lg text-xs font-bold transition btn-press-glass"
                                                style={
                                                    selected
                                                        ? {
                                                            background: 'var(--accent-500)',
                                                            color: '#fff',
                                                        }
                                                        : {
                                                            background: 'var(--bg-card-hover)',
                                                            color: 'var(--text-secondary)',
                                                            border: '1px solid var(--border-primary)',
                                                        }
                                                }
                                            >
                                                {label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Time chips */}
                        <div className="space-y-2">
                            <label className="block text-sm font-bold"
                                style={{ color: 'var(--text-secondary)' }}>
                                {t('plan.field.times') || '时间'}
                            </label>
                            {times.map((tt, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                    <input
                                        type="time"
                                        value={tt}
                                        onChange={(e) => updateTime(idx, e.target.value)}
                                        className="flex-1 p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={{
                                            background: 'var(--bg-card-hover)',
                                            border: '1px solid var(--border-primary)',
                                            color: 'var(--text-primary)',
                                        }}
                                    />
                                    {times.length > 1 && (
                                        <button
                                            onClick={() => removeTimeSlot(idx)}
                                            className="p-2 rounded-lg"
                                            style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                                            aria-label={t('btn.remove') || '移除'}
                                        >
                                            <X size={16} />
                                        </button>
                                    )}
                                </div>
                            ))}
                            {times.length < 4 && (
                                <button
                                    onClick={addTimeSlot}
                                    className="w-full py-2 rounded-lg text-xs font-bold transition btn-press-glass"
                                    style={{
                                        background: 'var(--bg-card-hover)',
                                        color: 'var(--text-secondary)',
                                        border: '1px dashed var(--border-primary)',
                                    }}
                                >
                                    + {t('plan.field.add_time') || '添加时间'}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Date range */}
                    <div className="space-y-3">
                        <label className="block text-xs font-semibold uppercase tracking-wider"
                            style={{ color: 'var(--text-tertiary)' }}>
                            {t('plan.field.date_range') || '起止日期'}
                        </label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="block text-sm font-bold"
                                    style={{ color: 'var(--text-secondary)' }}>
                                    {t('plan.field.start_date') || '开始'}
                                </label>
                                <div className="relative">
                                    <input
                                        type="date"
                                        value={startDate}
                                        onChange={(e) => setStartDate(e.target.value)}
                                        className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={{
                                            background: 'var(--bg-card-hover)',
                                            border: '1px solid var(--border-primary)',
                                            color: 'var(--text-primary)',
                                        }}
                                    />
                                    <Calendar size={16} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                                        style={{ color: 'var(--text-tertiary)' }} />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <label className="block text-sm font-bold"
                                    style={{ color: 'var(--text-secondary)' }}>
                                    {t('plan.field.end_date') || '结束（可选）'}
                                </label>
                                <div className="relative">
                                    <input
                                        type="date"
                                        value={endDate}
                                        onChange={(e) => setEndDate(e.target.value)}
                                        className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                        style={{
                                            background: 'var(--bg-card-hover)',
                                            border: '1px solid var(--border-primary)',
                                            color: 'var(--text-primary)',
                                        }}
                                    />
                                    <Calendar size={16} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                                        style={{ color: 'var(--text-tertiary)' }} />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Lead minutes + enabled */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="block text-sm font-bold"
                                style={{ color: 'var(--text-secondary)' }}>
                                {t('plan.field.lead_minutes') || '提前提醒（分钟）'}
                            </label>
                            <input
                                type="number"
                                min="0"
                                step="1"
                                value={leadMinutes}
                                onChange={(e) => setLeadMinutes(e.target.value)}
                                className="w-full p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                style={{
                                    background: 'var(--bg-card-hover)',
                                    border: '1px solid var(--border-primary)',
                                    color: 'var(--text-primary)',
                                }}
                            />
                        </div>
                        <div className="flex items-center justify-between p-3 rounded-xl"
                            style={{
                                background: 'var(--bg-card-hover)',
                                border: '1px solid var(--border-primary)',
                            }}>
                            <div>
                                <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                    {t('plan.field.enabled') || '启用'}
                                </p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {t('plan.field.enabled_desc') || '启用后会在通知栏发送提醒'}
                                </p>
                            </div>
                            <label className="inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={enabled}
                                    onChange={(e) => setEnabled(e.target.checked)}
                                />
                                <div className="relative w-11 h-6 rounded-full transition-colors"
                                    style={{ background: enabled ? 'var(--accent-500)' : 'var(--bg-card)' }}>
                                    <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
                                        style={{ transform: enabled ? 'translateX(20px)' : 'translateX(0)' }} />
                                </div>
                            </label>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 md:p-6 border-t flex items-center justify-between gap-2 shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    {planToEdit && onDelete ? (
                        <button
                            onClick={handleDelete}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition btn-press-glass"
                            style={{ background: 'var(--bg-card)', color: '#dc2626' }}
                        >
                            <Trash2 size={14} />
                            <span>{t('plan.delete') || '删除'}</span>
                        </button>
                    ) : (
                        <span />
                    )}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 h-11 rounded-xl text-sm font-bold transition btn-press-glass"
                            style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                        >
                            {t('btn.cancel') || '取消'}
                        </button>
                        <button
                            onClick={handleSave}
                            className="inline-flex items-center gap-1.5 px-4 py-2 h-11 rounded-xl text-white text-sm font-bold btn-press-glass transition glass-btn-primary"
                        >
                            <Save size={14} />
                            <span>{t('btn.save') || '保存'}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PlanEditModal;