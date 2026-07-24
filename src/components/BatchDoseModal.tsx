import React, { useState, useEffect, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAppData } from '../contexts/AppDataContext';
import { prefillWeightKG, prefillHeightCM } from '../utils/weight';
import CustomSelect from './CustomSelect';
import QuickDosePanel from './QuickDosePanel';
import DoseFormModal from './DoseFormModal';
import { getRouteIcon } from '../utils/helpers';
import {
    ROUTE_DISPLAY_ORDER, getAvailableEsters,
    isPresetDose, hasQuickDosePanel,
    drugKeyOf, readDoseByDrug, writeDoseMemo, readLastDrug,
    getAllGelProducts, readLastGelEvent,
} from '../utils/doseForm';
import { buildGelExtras, resolveGelAreaToStore } from '../utils/gelForm';
import {
    Route, Ester, ExtraKey, DoseEvent,
    getToE2Factor, isAntiandrogen,
    SL_TIER_ORDER, SublingualTierParams,
    GelSite, GEL_SITE_ORDER, GEL_PRODUCTS, GEL_DEFAULT_PRODUCT_ID,
    GEL_COVERAGE_TEMPLATES, GEL_COVERAGE_DEFAULT_IDX, GEL_COVERAGE_MANUAL_IDX,
    resolveGelCoverageArea, GEL_COAPPLICATION_ORDER,
    type GelProductSpec,
} from '../../logic';
import {
    Layers, X, ChevronRight, ChevronLeft, AlertTriangle,
    Trash2, Plus, Calendar, Clock, Info, MousePointerClick,
} from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface BatchDoseModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveBatch: (events: DoseEvent[]) => void;
}

const DEFAULT_TIMES = ['09:00', '21:00', '14:00', '18:00'];

const toLocalDateStr = (d: Date) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Parse YYYY-MM-DD as a local-time midnight to avoid the UTC-shift footgun
// (new Date('2026-05-26') is UTC, which lands a day earlier in negative offsets).
const parseLocalDate = (s: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    return Number.isFinite(dt.getTime()) ? dt : null;
};

type DoseLevelKey = 'low' | 'medium' | 'high' | 'very_high' | 'above';

type DoseGuideConfig = {
    unitKey: 'mg_day' | 'ug_day' | 'mg_week' | 'mg_dose';
    thresholds: [number, number, number, number];
    requiresRate?: boolean;
};

/**
 * 剂量参考档位 — 按 (给药方式, 药物) 复合键索引。
 * 抗雄 (CPA/BICA) 不在这里写阈值：useMemo 里 `isAntiandrogen(safeEster)` 会先 return null。
 * `mg_dose` 用于「不分昼夜、单次剂量」的黄体酮（直肠 / 肌注）。
 */
const DOSE_GUIDE_CONFIG: Partial<Record<`${Route}:${Ester}`, DoseGuideConfig>> = {
    [`${Route.oral}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    [`${Route.oral}:${Ester.EV}`]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    [`${Route.sublingual}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    [`${Route.sublingual}:${Ester.EV}`]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    [`${Route.patchApply}:${Ester.E2}`]: { unitKey: 'ug_day', thresholds: [100, 200, 400, 600], requiresRate: true },
    [`${Route.gel}:${Ester.E2}`]: { unitKey: 'mg_day', thresholds: [1.5, 3, 6, 9] },
    [`${Route.injection}:${Ester.EB}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EV}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EU}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EC}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.injection}:${Ester.EN}`]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
    [`${Route.rectal}:${Ester.PROG}`]: { unitKey: 'mg_dose', thresholds: [50, 100, 150, 200] },
    [`${Route.injection}:${Ester.PROG}`]: { unitKey: 'mg_dose', thresholds: [12.5, 25, 50, 75] },
};

/* Colors drive from --bg-bold-* / --text-bold-* / --bg-soft-* / --border-soft-*
 * tokens in index.html. Keeping these inline as plain class strings would
 * re-introduce the Tailwind `dark:` media-query which fights with the
 * ThemeContext's class-based .dark toggle. */
const LEVEL_BADGE_STYLES: Record<DoseLevelKey, string> = {
    low: 'bg-[var(--bg-bold-emerald)] text-[var(--text-bold-emerald)]',
    medium: 'bg-[var(--bg-bold-sky)] text-[var(--text-bold-sky)]',
    high: 'bg-[var(--bg-bold-amber)] text-[var(--text-bold-amber)]',
    very_high: 'bg-[var(--bg-bold-rose)] text-[var(--text-bold-rose)]',
    above: 'bg-[var(--bg-bold-red)] text-[var(--text-bold-red)]',
};

const LEVEL_CONTAINER_STYLES: Record<DoseLevelKey | 'neutral', string> = {
    low: 'bg-[var(--bg-soft-emerald)] border-[var(--border-soft-emerald)]',
    medium: 'bg-[var(--bg-soft-sky)] border-[var(--border-soft-sky)]',
    high: 'bg-[var(--bg-soft-amber)] border-[var(--border-soft-amber)]',
    very_high: 'bg-[var(--bg-soft-rose)] border-[var(--border-soft-rose)]',
    above: 'bg-[var(--bg-soft-red)] border-[var(--border-soft-red)]',
    neutral: 'bg-[var(--bg-soft-gray)] border-[var(--border-med-gray)]',
};

const formatGuideNumber = (val: number) => {
    if (Number.isInteger(val)) return val.toString();
    const rounded = val < 1 ? val.toFixed(2) : val.toFixed(1);
    return rounded.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const BatchDoseModal: React.FC<BatchDoseModalProps> = ({ isOpen, onClose, onSaveBatch }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const { events: allEvents, gelProducts } = useAppData();

    const allGelProducts = useMemo(() => getAllGelProducts(gelProducts), [gelProducts]);
    const findGelProduct = (id: number): GelProductSpec =>
        allGelProducts.find(p => p.id === id) ?? GEL_PRODUCTS[0];
    const gelProductLabel = (p: GelProductSpec): string => p.name || t(p.nameKey);

    const [step, setStep] = useState<'config' | 'preview'>('config');

    // Drug params (mirrors DoseFormModal)
    const [route, setRoute] = useState<Route>(Route.injection);
    const [ester, setEster] = useState<Ester>(Ester.EV);
    const [rawDose, setRawDose] = useState('');
    const [e2Dose, setE2Dose] = useState('');
    const [patchMode, setPatchMode] = useState<'dose' | 'rate'>('dose');
    const [patchRate, setPatchRate] = useState('');
    const [gelSite, setGelSite] = useState(0);
    const [gelProductId, setGelProductId] = useState<number>(GEL_DEFAULT_PRODUCT_ID);
    const [gelArea, setGelArea] = useState("");
    const [gelCoverage, setGelCoverage] = useState<number>(GEL_COVERAGE_DEFAULT_IDX);
    const [gelCoApplied, setGelCoApplied] = useState<number>(0);
    const [gelWash, setGelWash] = useState("");
    const [slTier, setSlTier] = useState(2);
    const [useCustomTheta, setUseCustomTheta] = useState(false);
    const [customTheta, setCustomTheta] = useState('');
    const [useCustomDose, setUseCustomDose] = useState(false);
    const [lastEditedField, setLastEditedField] = useState<'raw' | 'bio'>('bio');

    // Tracks the drug key the per-drug dose memory was last loaded for, so the
    // memory-restore effect only fires when the user actually switches compounds.
    const prevDrugKeyRef = useRef<string | null>(null);

    // Schedule params
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    // 间隔 = 几天 + 几小时，内部统一存 hours
    const [intervalDaysStr, setIntervalDaysStr] = useState('1');
    const [intervalHoursStr, setIntervalHoursStr] = useState('0');
    const intervalDays = Math.max(1, parseInt(intervalDaysStr) || 1);
    // 「间隔小时」字段只对贴片路径生效：贴片需要小时级精度算撕下时间，
    // 其它路径（口服/注射/凝胶/植入）按整数天循环就够了，强行让用户填小时反而多余。
    const intervalHours = (route === Route.patchApply)
        ? Math.max(0, Math.min(23, parseInt(intervalHoursStr) || 0))
        : 0;
    const intervalTotalHours = intervalDays * 24 + intervalHours;
    // 「每日次数」：贴片必须写死 1 次（UI 把输入框隐起来，下面时间槽联动也只会出现 1 个）；
    // 其它路径按输入框解析，1-4 次，跟下面的「时间槽」useEffect 联动增减。
    const [timesPerDayStr, setTimesPerDayStr] = useState('1');
    const timesPerDay = (route === Route.patchApply)
        ? 1
        : Math.max(1, Math.min(4, parseInt(timesPerDayStr) || 1));
    const [timeSlots, setTimeSlots] = useState<string[]>([DEFAULT_TIMES[0]]);
    const [weightStr, setWeightStr] = useState('');
    const [heightStr, setHeightStr] = useState('');
    // 贴片佩戴时长：仅 patchApply 路径生效，几小时内部统一存 hours
    const [wearDaysStr, setWearDaysStr] = useState('3');
    const [wearHoursStr, setWearHoursStr] = useState('0');
    const wearDays = Math.max(0, parseInt(wearDaysStr) || 0);
    const wearHours = Math.max(0, Math.min(23, parseInt(wearHoursStr) || 0));
    const wearTotalHours = wearDays * 24 + wearHours;

    // Preview state
    const [previewEvents, setPreviewEvents] = useState<DoseEvent[]>([]);
    const [editingEvent, setEditingEvent] = useState<DoseEvent | null>(null);

    const availableEsters = useMemo(() => getAvailableEsters(route), [route]);

    const slExtras = useMemo(() => {
        if (route !== Route.sublingual) return null;
        if (useCustomTheta) {
            const parsed = parseFloat(customTheta);
            const theta = Number.isFinite(parsed) ? parsed : 0.11;
            const clamped = Math.max(0, Math.min(1, theta));
            return { [ExtraKey.sublingualTheta]: clamped } as Partial<Record<ExtraKey, number>>;
        }
        return { [ExtraKey.sublingualTier]: slTier } as Partial<Record<ExtraKey, number>>;
    }, [route, useCustomTheta, customTheta, slTier]);

    // Reset when modal opens. Land on the last drug used (sublingual + EV as the
    // cold-start default); dose fields are restored per-drug by the effect below.
    useEffect(() => {
        if (isOpen) {
            setStep('config');
            const now = new Date();
            const thirtyDaysAgo = new Date(now);
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            setStartDate(toLocalDateStr(thirtyDaysAgo));
            setEndDate(toLocalDateStr(now));
            setTimesPerDayStr('1');
            setTimeSlots([DEFAULT_TIMES[0]]);
            const last = readLastDrug();
            // 默认值由下面的 [route, isOpen] useEffect 接管（它会跑 applyRouteDefaults），
            // 这里只负责 setRoute，让新的 useEffect 拿到正确的 route 后再设默认值。
            setRoute(last?.route ?? Route.sublingual);
            setEster(last?.ester ?? Ester.EV);
            // Pre-fill gel from the most recent gel administration (events JSON).
            const lastGel = readLastGelEvent(allEvents);
            if (lastGel) {
                // Prefill verbatim; a deleted product surfaces via the missing-product
                // warning in the selector rather than an auto-reset (which misfired
                // during the cloud-sync race).
                setGelProductId(lastGel.productId);
                setGelSite(lastGel.gelSite);
                const prod = findGelProduct(lastGel.productId);
                setGelArea(lastGel.areaCM2 > 0 ? String(lastGel.areaCM2) : String(prod.defaultAreaCM2));
                setGelCoverage(lastGel.coverage >= 0 ? lastGel.coverage : GEL_COVERAGE_MANUAL_IDX);
                setGelCoApplied(lastGel.coApplied > 0 ? lastGel.coApplied : 0);
                setGelWash(lastGel.washAfterH > 0 ? String(lastGel.washAfterH) : "");
            } else {
                setGelProductId(GEL_DEFAULT_PRODUCT_ID);
                setGelSite(0);
                setGelArea(String(GEL_PRODUCTS[0].defaultAreaCM2));
                setGelCoverage(GEL_COVERAGE_DEFAULT_IDX);
                setGelCoApplied(0);
                setGelWash("");
            }
            setPreviewEvents([]);
            setEditingEvent(null);
            setWeightStr(prefillWeightKG(allEvents).toString());
            setHeightStr(prefillHeightCM(allEvents).toString());
        }
    }, [isOpen]);

    useEffect(() => {
        if (!availableEsters.includes(ester)) {
            setEster(availableEsters[0]);
        }
    }, [availableEsters, ester]);

    // Restore the per-drug remembered dose whenever the active compound changes.
    // Switching to a never-used compound clears the dose rather than carrying the
    // previous compound's value over (the fix for doses leaking across drugs).
    useEffect(() => {
        if (!isOpen) {
            prevDrugKeyRef.current = null;
            return;
        }
        const key = drugKeyOf(route, ester);
        if (prevDrugKeyRef.current === key) return;
        prevDrugKeyRef.current = key;

        const memo = readDoseByDrug()[key];
        if (memo) {
            setRawDose(memo.rawDose ?? '');
            setE2Dose(memo.e2Dose ?? '');
            setPatchMode(memo.patchMode ?? 'dose');
            setPatchRate(memo.patchRate ?? '');
            setSlTier(memo.slTier ?? 2);
            setUseCustomTheta(memo.useCustomTheta ?? false);
            setCustomTheta(memo.customTheta ?? '');
            setUseCustomDose(memo.customDose ?? false);
            setLastEditedField(ester === Ester.E2 ? 'bio' : 'raw');
        } else {
            setRawDose('');
            setE2Dose('');
            setPatchMode('dose');
            setPatchRate('');
            setSlTier(2);
            setUseCustomTheta(false);
            setCustomTheta('');
            setUseCustomDose(false);
            setLastEditedField(ester === Ester.E2 ? 'bio' : 'raw');
        }
    }, [isOpen, route, ester]);

    // 按 route 重置 interval / wear 默认值：modal 打开 + route 切换都触发
    // 贴片路径：3/12/3/12；其它路径：1/0/3/0
    useEffect(() => {
        if (!isOpen) return;
        if (route === Route.patchApply) {
            setIntervalDaysStr('3');
            setIntervalHoursStr('12');
            setWearDaysStr('3');
            setWearHoursStr('12');
        } else {
            setIntervalDaysStr('1');
            setIntervalHoursStr('0');
            setWearDaysStr('3');
            setWearHoursStr('0');
        }
    }, [route, isOpen]);

    useEffect(() => {
        setTimeSlots(prev => {
            const copy = [...prev];
            while (copy.length < timesPerDay) {
                copy.push(DEFAULT_TIMES[copy.length] || '12:00');
            }
            return copy.slice(0, timesPerDay);
        });
    }, [timesPerDay]);

    // `activeEster` lets the quick-dose path pass `safeEster`, so the mg<->E2
    // conversion uses the compound the panel is displaying even in the brief
    // window before `ester` is re-validated.
    const handleRawChange = (val: string, activeEster: Ester = ester) => {
        setRawDose(val);
        setLastEditedField('raw');
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(activeEster) || 1;
            setE2Dose((v * factor).toFixed(3));
        } else {
            setE2Dose('');
        }
    };

    const handleE2Change = (val: string, activeEster: Ester = ester) => {
        setE2Dose(val);
        setLastEditedField('bio');
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(activeEster) || 1;
            setRawDose(activeEster === Ester.E2 ? v.toFixed(3) : (v / factor).toFixed(3));
        } else {
            setRawDose('');
        }
    };

    // Quick-panel preset = compound mg; route plain E2 through the E2-equivalent
    // field, everything else through the raw-dose field.
    const applyQuickDose = (mg: number, activeEster: Ester) => {
        const val = String(mg);
        if (activeEster === Ester.E2) handleE2Change(val, activeEster);
        else handleRawChange(val, activeEster);
    };

    // Leaving manual entry clears a non-preset value so it can't be silently kept
    // while hidden behind the preset chips.
    const toggleCustomDose = (activeEster: Ester) => {
        const next = !useCustomDose;
        if (!next) {
            const current = parseFloat(activeEster === Ester.E2 ? e2Dose : rawDose);
            if (!isPresetDose(route, activeEster, current)) {
                setRawDose('');
                setE2Dose('');
            }
        }
        setUseCustomDose(next);
    };

    useEffect(() => {
        if (lastEditedField === 'raw' && rawDose) handleRawChange(rawDose);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ester]);

    useEffect(() => {
        if (lastEditedField === 'bio' && e2Dose) handleE2Change(e2Dose);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ester]);

    const updateTimeSlot = (index: number, value: string) => {
        setTimeSlots(prev => {
            const copy = [...prev];
            copy[index] = value;
            return copy;
        });
    };

    const buildExtrasForBatch = (): Partial<Record<ExtraKey, number>> => {
        const extras: Partial<Record<ExtraKey, number>> = {};
        switch (route) {
            case Route.patchApply: {
                if (patchMode === 'rate') {
                    const r = parseFloat(patchRate);
                    if (Number.isFinite(r) && r > 0) extras[ExtraKey.releaseRateUGPerDay] = r;
                }
                return extras;
            }
            case Route.sublingual: {
                if (useCustomTheta) {
                    const parsed = parseFloat(customTheta);
                    const theta = Number.isFinite(parsed) ? parsed : 0.11;
                    extras[ExtraKey.sublingualTheta] = Math.max(0, Math.min(1, theta));
                } else {
                    extras[ExtraKey.sublingualTier] = slTier;
                }
                return extras;
            }
            case Route.gel: {
                // Stable area: fixed templates store a constant, manual stores the typed
                // value, "product" template + scrotal store nothing (follow product default).
                const isScrotal = GEL_SITE_ORDER[gelSite] === GelSite.scrotal;
                const area = resolveGelAreaToStore(gelCoverage, isScrotal, parseFloat(gelArea));
                const washVal = parseFloat(gelWash);
                Object.assign(extras, buildGelExtras({
                    productId: gelProductId,
                    gelSite,
                    areaCM2: area,
                    coverage: isScrotal ? undefined : gelCoverage,
                    coApplied: gelCoApplied,
                    washAfterH: (Number.isFinite(washVal) && washVal > 0) ? washVal : undefined,
                }));
                return extras;
            }
            // injection / oral / patchRemove: no extras
            default:
                return extras;
        }
    };

    const resolveDoseMG = (): number | null => {
        const nonPositiveMsg = t('error.nonPositive');
        // safeEster (declared at component scope) guards against the brief
        // window where availableEsters has shrunk but the ester→default effect
        // hasn't run yet. Routes whose ester is fully determined by the route
        // force E2 regardless.
        const effectiveEster =
            (route === Route.patchApply || route === Route.patchRemove || route === Route.gel)
                ? Ester.E2
                : safeEster;
        if (route === Route.patchRemove) return 0;
        if (route === Route.patchApply && patchMode === 'rate') {
            const r = parseFloat(patchRate);
            if (!Number.isFinite(r) || r <= 0) {
                showDialog('alert', nonPositiveMsg);
                return null;
            }
            return 0;
        }
        if (route === Route.patchApply && patchMode === 'dose') {
            const raw = parseFloat(rawDose);
            if (!Number.isFinite(raw) || raw <= 0) {
                showDialog('alert', nonPositiveMsg);
                return null;
            }
            return raw;
        }
        // injection / oral / sublingual / gel: store compound mg
        let e2Equivalent = parseFloat(e2Dose);
        if (!Number.isFinite(e2Equivalent)) e2Equivalent = NaN;
        if (effectiveEster === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) {
            const rawVal = parseFloat(rawDose);
            if (Number.isFinite(rawVal)) {
                const factor = getToE2Factor(effectiveEster) || 1;
                e2Equivalent = rawVal * factor;
            }
        }
        if (isAntiandrogen(effectiveEster)) {
            const rawVal = parseFloat(rawDose);
            if (!Number.isFinite(rawVal) || rawVal <= 0) {
                showDialog('alert', nonPositiveMsg);
                return null;
            }
            return rawVal;
        }
        if (!Number.isFinite(e2Equivalent) || e2Equivalent <= 0) {
            showDialog('alert', nonPositiveMsg);
            return null;
        }
        const factor = getToE2Factor(effectiveEster) || 1;
        return effectiveEster === Ester.E2 ? e2Equivalent : e2Equivalent / factor;
    };

    const generatePreview = () => {
        const start = startDate ? parseLocalDate(startDate) : null;
        const end = endDate ? parseLocalDate(endDate) : null;
        if (!start || !end) return;
        if (start > end) {
            showDialog('alert', t('batch.invalid_range'));
            return;
        }

        const finalDoseMG = resolveDoseMG();
        if (finalDoseMG === null) return;

        const extrasTemplate = buildExtrasForBatch();

        // safeEster (component scope) keeps the stored ester safe even if
        // availableEsters just shrank.
        const finalEster =
            (route === Route.patchApply || route === Route.patchRemove || route === Route.gel)
                ? Ester.E2
                : safeEster;

        const events: DoseEvent[] = [];
        const parsedWeight = parseFloat(weightStr);
        const weightKG = (Number.isFinite(parsedWeight) && parsedWeight > 0)
            ? parsedWeight
            : prefillWeightKG(allEvents);

        const parsedHeight = parseFloat(heightStr);
        const heightCM = (Number.isFinite(parsedHeight) && parsedHeight > 0)
            ? parsedHeight
            : prefillHeightCM(allEvents);

        // 贴片：解析佩戴时长（仅 patchApply 时用）
        if (route === Route.patchApply) {
            if (wearTotalHours <= 0 || wearTotalHours > 14 * 24) {
                showDialog('alert', t('batch.wear_days_invalid') || '佩戴时长需要在 0.5–14 天之间');
                return;
            }
        }

        // 间隔用 totalHours 加到 timeH，避免 setDate 跨月跨年的小数/天数漂移。
        // ⚠️ 之前的实现用 `currentMs += intervalMs` + `setHours(slot.hh, slot.mm)`，
        //    setHours 会把小时部分覆盖掉，所以 interval 里的「小时」偏移（例如 3 天 12 小时里的 12h）
        //    永远丢了，apply 时间被卡死在 09:00。修法：以「start 日 + timeSlots[0] 时分」为锚点，
        //    外层每次 + intervalTotalHours（包含天数和小时），内层 slot 用相对偏移叠加，
        //    这样 timeSlots.length === 1（贴片）和 > 1（其它路径）都正确。
        const intervalMs = intervalTotalHours * 3600000;
        const startMs = start.getTime();
        const endMs = end.getTime();
        const firstSlot = timeSlots[0] ?? DEFAULT_TIMES[0];
        const [hh0, mm0] = firstSlot.split(':').map(Number);
        const firstSlotOffsetMs = hh0 * 3600000 + mm0 * 60000;
        let iterMs = startMs + firstSlotOffsetMs;
        let n = 0;
        while (iterMs <= endMs) {
            for (const slot of timeSlots) {
                const [hh, mm] = slot.split(':').map(Number);
                // slot 相对 timeSlots[0] 的偏移：贴片只 1 个 slot,这里 delta = 0
                // 其它路径多个 slot 时,delta 自动承载「一天内多个时刻」的语义
                const slotDeltaMs = (hh - hh0) * 3600000 + (mm - mm0) * 60000;
                const timeH = (iterMs + slotDeltaMs) / 3600000;

                if (route === Route.patchApply) {
                    // 同时生成 (apply, remove) 对，共享 groupId
                    const groupId = uuidv4();
                    events.push({
                        id: uuidv4(),
                        route: Route.patchApply,
                        ester: finalEster,
                        timeH,
                        doseMG: finalDoseMG,
                        weightKG,
                        heightCm: heightCM,
                        extras: { ...extrasTemplate },
                        companionGroupId: groupId,
                    });
                    events.push({
                        id: uuidv4(),
                        route: Route.patchRemove,
                        ester: Ester.E2,
                        timeH: timeH + wearTotalHours,
                        doseMG: 0,
                        weightKG,
                        heightCm: heightCM,
                        extras: {},
                        companionGroupId: groupId,
                    });
                } else {
                    events.push({
                        id: uuidv4(),
                        route,
                        ester: finalEster,
                        timeH,
                        doseMG: finalDoseMG,
                        weightKG,
                        heightCm: heightCM,
                        extras: { ...extrasTemplate },
                    });
                }
            }
            n += 1;
            iterMs = startMs + firstSlotOffsetMs + n * intervalMs;
        }

        setPreviewEvents(events);
        setStep('preview');
    };

    // 贴片删除：apply 和 remove 通过 companionGroupId 联动，删一个就把一对都删掉。
    // 非贴片事件按单条删。
    const removePreviewEvent = (id: string) => {
        setPreviewEvents(prev => {
            const target = prev.find(ev => ev.id === id);
            if (!target) return prev;
            if (target.route !== Route.patchApply && target.route !== Route.patchRemove) {
                return prev.filter(ev => ev.id !== id);
            }
            return prev.filter(ev => {
                if (ev.id === id) return false;
                if (target.companionGroupId && ev.companionGroupId === target.companionGroupId) return false;
                return true;
            });
        });
    };

    const handleEventEdit = (updatedEv: DoseEvent) => {
        setPreviewEvents(prev => prev.map(ev => (ev.id === updatedEv.id ? updatedEv : ev)));
        setEditingEvent(null);
    };

    const handleEventDelete = (id: string) => {
        removePreviewEvent(id);
        setEditingEvent(null);
    };

    const handleConfirm = async () => {
        if (previewEvents.length === 0) return;
        const result = await showDialog('confirm', t('batch.warning'));
        if (result === 'confirm') {
            // Remember this drug's dose config only once the batch is actually
            // committed (per-drug, device-local), mirroring the single-add modal.
            writeDoseMemo(route, safeEster, {
                rawDose, e2Dose,
                patchMode, patchRate,
                slTier, useCustomTheta, customTheta,
                customDose: useCustomDose,
            });
            onSaveBatch(previewEvents);
            onClose();
        }
    };

    // 贴片对：apply + 它的 remove。渲染时撕下挂 apply 下面。
    type PreviewPair = { apply: DoseEvent; remove: DoseEvent | null };
    const pairedPreview = useMemo<PreviewPair[]>(() => {
        const applies = previewEvents.filter(ev => ev.route === Route.patchApply);
        return applies.map(apply => {
            const remove = previewEvents.find(
                ev => ev.route === Route.patchRemove
                    && ev.companionGroupId
                    && ev.companionGroupId === apply.companionGroupId,
            ) ?? null;
            return { apply, remove };
        });
    }, [previewEvents]);

    // 分组：贴片按 apply 日期归组（撕下跨日仍挂在 apply 那一天下面）；
    // 非贴片按自己的时间归组；最终按日期排序。
    const groupedPreview = useMemo(() => {
        const groups: { date: string; pairs: PreviewPair[]; lone: DoseEvent[] }[] = [];
        const dateIndex = new Map<string, typeof groups[number]>();
        const ensureGroup = (dateStr: string) => {
            let g = dateIndex.get(dateStr);
            if (!g) {
                g = { date: dateStr, pairs: [], lone: [] };
                groups.push(g);
                dateIndex.set(dateStr, g);
            }
            return g;
        };
        pairedPreview.forEach(pair => {
            const d = new Date(pair.apply.timeH * 3600000);
            ensureGroup(toLocalDateStr(d)).pairs.push(pair);
        });
        const loneEvents = previewEvents.filter(
            ev => ev.route !== Route.patchApply && ev.route !== Route.patchRemove,
        );
        loneEvents.forEach(ev => {
            const d = new Date(ev.timeH * 3600000);
            ensureGroup(toLocalDateStr(d)).lone.push(ev);
        });
        return groups;
    }, [pairedPreview, previewEvents]);

    // 撕下相对时长 "X 天 Y 小时"，渲染时算即可
    const formatWearDuration = (applyH: number, removeH: number): { days: number; hours: number; key: 'days' | 'hours' | 'both' } => {
        const totalH = Math.max(0, removeH - applyH);
        const days = Math.floor(totalH / 24);
        const hours = totalH - days * 24;
        if (days === 0) return { days, hours, key: 'hours' };
        if (hours === 0) return { days, hours: 0, key: 'days' };
        return { days, hours, key: 'both' };
    };

    // Reflect what's actually in the preview, not the config form, so per-row
    // edits that change route/ester are honored in the header chip.
    // 贴片对只看 apply（route/ester），不再被配对的 patchRemove 误判 mixed。
    const previewSummary = useMemo(() => {
        if (previewEvents.length === 0) return null;
        const mains = previewEvents.filter(ev => ev.route !== Route.patchRemove);
        if (mains.length === 0) return { mixed: true, route: null, ester: null } as const;
        const first = mains[0];
        const allSameRoute = mains.every(ev => ev.route === first.route);
        if (!allSameRoute) return { mixed: true, route: null, ester: null } as const;
        const allSameEster = mains.every(ev => ev.ester === first.ester);
        return {
            mixed: false,
            route: first.route,
            ester: allSameEster ? first.ester : null,
        } as const;
    }, [previewEvents]);

    // useFocusTrap is modal-stack-aware: while editingEvent is open its trap
    // becomes topmost, so Escape only closes the sub-editor.
    const dialogRef = useFocusTrap(isOpen, onClose);

    // Single source of truth for "the ester that will actually be saved" — kept
    // in sync with the safeEster used by resolveDoseMG / generatePreview.
    const safeEster = availableEsters.includes(ester) ? ester : availableEsters[0];

    const doseGuide = useMemo(() => {
        if (isAntiandrogen(safeEster)) return null;
        const cfg = DOSE_GUIDE_CONFIG[drugKeyOf(route, safeEster)];
        if (!cfg) return null;
        if (route === Route.patchApply && patchMode === 'dose' && cfg.requiresRate) {
            return { config: cfg, level: null, value: null, showRateHint: true as const };
        }
        const rawVal = route === Route.patchApply ? parseFloat(patchRate) : parseFloat(e2Dose);
        const value = Number.isFinite(rawVal) && rawVal > 0 ? rawVal : null;
        let level: DoseLevelKey | null = null;
        if (value !== null) {
            const [low, medium, high, veryHigh] = cfg.thresholds;
            if (value <= low) level = 'low';
            else if (value <= medium) level = 'medium';
            else if (value <= high) level = 'high';
            else if (value <= veryHigh) level = 'very_high';
            else level = 'above';
        }
        return { config: cfg, level, value, showRateHint: false as const };
    }, [route, patchMode, patchRate, e2Dose, safeEster]);

    if (!isOpen) return null;

    const routeOptions = ROUTE_DISPLAY_ORDER.map(r => ({
        value: r,
        label: t(`route.${r}`),
        icon: getRouteIcon(r),
    }));

    const esterOptions = availableEsters.map(e => ({
        value: e,
        label: t(`ester.${e}`),
    }));

    const inputStyle: React.CSSProperties = {
        background: 'var(--bg-card-hover)',
        border: '1px solid var(--border-primary)',
        color: 'var(--text-primary)',
    };

    const labelStyle: React.CSSProperties = {
        color: 'var(--text-secondary)',
    };

    const tierKey = SL_TIER_ORDER[slTier] || 'standard';
    const currentTheta = SublingualTierParams[tierKey]?.theta || 0.11;
    const activeTheta = useCustomTheta
        ? (slExtras && slExtras[ExtraKey.sublingualTheta] !== undefined
            ? slExtras[ExtraKey.sublingualTheta]!
            : 0.11)
        : currentTheta;

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
        ? (doseGuide.level
            ? LEVEL_CONTAINER_STYLES[doseGuide.level]
            : (doseGuide.showRateHint ? LEVEL_CONTAINER_STYLES.high : LEVEL_CONTAINER_STYLES.neutral))
        : LEVEL_CONTAINER_STYLES.neutral;
    const guideBadgeClass = doseGuide?.level ? LEVEL_BADGE_STYLES[doseGuide.level] : '';

    const showDoseSection = route !== Route.patchRemove;
    const showRawInput = showDoseSection && (route !== Route.patchApply || patchMode === 'dose') && safeEster !== Ester.E2;
    const showE2Input = showDoseSection
        && (route !== Route.patchApply || patchMode === 'dose')
        && !(safeEster === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral))
        && !isAntiandrogen(safeEster);
    const rawColSpan2 = (safeEster === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) || isAntiandrogen(safeEster);
    const e2ColSpan2 = safeEster === Ester.E2 && route !== Route.gel && route !== Route.oral && route !== Route.sublingual;
    const canGenerate = (() => {
        if (!startDate || !endDate) return false;
        const s = parseLocalDate(startDate);
        const e = parseLocalDate(endDate);
        if (!s || !e || s > e) return false;
        if (route === Route.patchRemove) return true;
        if (route === Route.patchApply && patchMode === 'rate') return !!patchRate;
        if (isAntiandrogen(safeEster)) return !!rawDose;
        if (safeEster === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) return !!rawDose;
        return !!e2Dose;
    })();

    return (
        <>
            <div
                className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
                style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
                aria-hidden={editingEvent ? true : undefined}
                {...(editingEvent ? { inert: '' as any } : {})}
            >
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal={editingEvent ? undefined : true}
                    aria-labelledby="batch-modal-title"
                    className="relative rounded-3xl w-full max-w-lg md:max-w-2xl h-[92vh] md:max-h-[85vh] flex flex-col overflow-hidden modal-spring-glass glass-modal"
                >
                    {/* Header */}
                    <div className="p-5 md:p-6 border-b flex justify-between items-center shrink-0"
                        style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center accent-bg-gradient">
                                <Layers size={16} className="text-white" />
                            </div>
                            <div>
                                <h3 id="batch-modal-title" className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                                    {t('batch.title')}
                                </h3>
                                <div className="flex items-center gap-2 mt-0.5">
                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${step === 'config' ? 'text-white' : ''}`}
                                        style={step === 'config' ? { background: 'var(--accent-500)' } : { color: 'var(--text-tertiary)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                                        1. {t('batch.step_config')}
                                    </span>
                                    <ChevronRight size={12} style={{ color: 'var(--text-tertiary)' }} />
                                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${step === 'preview' ? 'text-white' : ''}`}
                                        style={step === 'preview' ? { background: 'var(--accent-500)' } : { color: 'var(--text-tertiary)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                                        2. {t('batch.step_preview')}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                            style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                            <X size={20} />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-y-auto p-5 md:p-6 space-y-5">
                        {step === 'config' && (
                            <>
                                {/* Route */}
                                <CustomSelect
                                    label={t('field.route')}
                                    value={route}
                                    onChange={(val) => setRoute(val as Route)}
                                    options={routeOptions}
                                />

                                {route === Route.patchRemove && (
                                    <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                        {t('beta.patch_remove')}
                                    </div>
                                )}

                                {route !== Route.patchRemove && availableEsters.length >= 1 && (
                                    <CustomSelect
                                        label={t('field.ester')}
                                        value={ester}
                                        onChange={(val) => setEster(val as Ester)}
                                        options={esterOptions}
                                    />
                                )}

                                {route === Route.injection && safeEster === Ester.EU && (
                                    <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                        {t('ester.EU_note')}
                                    </div>
                                )}

                                {/* Gel: product + site + area + wash (parity with DoseFormModal;
                                    custom products are created in the single-dose form) */}
                                {route === Route.gel && (
                                    <div className="space-y-3">
                                        <CustomSelect
                                            label={t('field.gel_product')}
                                            value={String(gelProductId)}
                                            onChange={(val) => {
                                                const id = parseInt(val, 10);
                                                if (!Number.isFinite(id)) return;
                                                setGelProductId(id);
                                                setGelArea(String(resolveGelCoverageArea(gelCoverage, findGelProduct(id), parseFloat(gelArea))));
                                            }}
                                            options={[
                                                ...(!allGelProducts.some(p => p.id === gelProductId)
                                                    ? [{ value: String(gelProductId), label: t('gel.product.missing') }]
                                                    : []),
                                                ...allGelProducts.map(p => ({ value: String(p.id), label: gelProductLabel(p) })),
                                            ]}
                                        />
                                        {!allGelProducts.some(p => p.id === gelProductId) && (
                                            <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-2 rounded-lg">
                                                {t('gel.product.missing_note')}
                                            </div>
                                        )}
                                        <CustomSelect
                                            label={t('field.gel_site')}
                                            value={String(gelSite)}
                                            onChange={(val) => setGelSite(parseInt(val, 10) || 0)}
                                            options={[0, 1, 3, 2].map(idx => ({
                                                value: String(idx),
                                                label: t(`gel.site.${GEL_SITE_ORDER[idx]}`),
                                            }))}
                                        />
                                        {GEL_SITE_ORDER[gelSite] === GelSite.scrotal && (
                                            <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-2 rounded-lg">
                                                {t('gel.site.scrotal_note')}
                                            </div>
                                        )}
                                        {/* Coverage template → derived application area.
                                            Hidden for scrotal (area-invariant; see note above). */}
                                        {GEL_SITE_ORDER[gelSite] !== GelSite.scrotal && (<>
                                            <CustomSelect
                                                label={t('field.gel_coverage')}
                                                value={String(gelCoverage)}
                                                onChange={(val) => {
                                                    const idx = parseInt(val, 10) || 0;
                                                    setGelCoverage(idx);
                                                    const tpl = GEL_COVERAGE_TEMPLATES[idx];
                                                    if (tpl && tpl.kind !== 'manual') {
                                                        setGelArea(String(resolveGelCoverageArea(idx, findGelProduct(gelProductId), parseFloat(gelArea))));
                                                    }
                                                }}
                                                options={GEL_COVERAGE_TEMPLATES.map((tpl, idx) => {
                                                    const base = t(`gel.coverage.${tpl.key}`);
                                                    const label = tpl.kind === 'manual'
                                                        ? base
                                                        : `${base} (~${Math.round(resolveGelCoverageArea(idx, findGelProduct(gelProductId), 0))} cm²)`;
                                                    return { value: String(idx), label };
                                                })}
                                            />
                                            {GEL_COVERAGE_TEMPLATES[gelCoverage]?.kind === 'manual' ? (
                                                <div className="space-y-1">
                                                    <label className="block text-sm font-bold" style={labelStyle}>{t('field.gel_area')}</label>
                                                    <input value={gelArea} onChange={e => setGelArea(e.target.value)} inputMode="decimal" placeholder={String(findGelProduct(gelProductId).defaultAreaCM2)} className="w-full p-3 rounded-xl glass-input outline-none" />
                                                </div>
                                            ) : (
                                                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                    {t('gel.coverage.derived')}: ~{Math.round(resolveGelCoverageArea(gelCoverage, findGelProduct(gelProductId), 0))} cm²
                                                </div>
                                            )}
                                        </>)}
                                        {/* Co-applied topical product */}
                                        <CustomSelect
                                            label={t('field.gel_coapplied')}
                                            value={String(gelCoApplied)}
                                            onChange={(val) => setGelCoApplied(parseInt(val, 10) || 0)}
                                            options={GEL_COAPPLICATION_ORDER.map((k, idx) => ({
                                                value: String(idx),
                                                label: t(`gel.coapplied.${k}`),
                                            }))}
                                        />
                                        {gelCoApplied > 0 && (
                                            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                {t(`gel.coapplied.note.${GEL_COAPPLICATION_ORDER[gelCoApplied] ?? 'none'}`)}
                                            </div>
                                        )}
                                        <div className="space-y-1">
                                            <label className="block text-sm font-bold" style={labelStyle}>{t('field.gel_wash')}</label>
                                            <input value={gelWash} onChange={e => setGelWash(e.target.value)} inputMode="decimal" placeholder={t('gel.wash_none')} className="w-full p-3 rounded-xl glass-input outline-none" />
                                        </div>
                                        <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                            {t('beta.gel')}
                                        </div>
                                    </div>
                                )}

                                {/* Patch mode toggle */}
                                {route === Route.patchApply && (
                                    <div className="space-y-2">
                                        <div className="p-1 rounded-xl flex" style={{ background: 'var(--bg-card-hover)' }}>
                                            <button
                                                onClick={() => setPatchMode('dose')}
                                                className="flex-1 py-2 text-sm font-bold rounded-lg transition-all"
                                                style={patchMode === 'dose'
                                                    ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' }
                                                    : { color: 'var(--text-tertiary)' }}>
                                                {t('field.patch_total')}
                                            </button>
                                            <button
                                                onClick={() => setPatchMode('rate')}
                                                className="flex-1 py-2 text-sm font-bold rounded-lg transition-all"
                                                style={patchMode === 'rate'
                                                    ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' }
                                                    : { color: 'var(--text-tertiary)' }}>
                                                {t('field.patch_rate')}
                                            </button>
                                        </div>
                                        <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                            {t('beta.patch')}
                                        </div>
                                    </div>
                                )}

                                {/* Dose inputs */}
                                {showDoseSection && (route !== Route.patchApply || patchMode === 'dose') && (
                                    hasQuickDosePanel(route, safeEster) ? (
                                        <QuickDosePanel
                                            route={route}
                                            ester={safeEster}
                                            rawDose={rawDose}
                                            e2Dose={e2Dose}
                                            useCustomDose={useCustomDose}
                                            onToggleCustom={() => toggleCustomDose(safeEster)}
                                            onSelectPreset={(mg) => applyQuickDose(mg, safeEster)}
                                            onCustomChange={(val) => safeEster === Ester.E2 ? handleE2Change(val, safeEster) : handleRawChange(val, safeEster)}
                                        />
                                    ) : (
                                    <>
                                        <div className="grid grid-cols-2 gap-4">
                                            {showRawInput && (
                                                <div className={`space-y-2 ${rawColSpan2 ? 'col-span-2' : ''}`}>
                                                    <label className="block text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('field.dose_raw')}</label>
                                                    <input
                                                        type="number" inputMode="decimal" min="0" step="0.001"
                                                        value={rawDose} onChange={e => handleRawChange(e.target.value)}
                                                        className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono"
                                                        style={inputStyle}
                                                        placeholder="0.0"
                                                    />
                                                </div>
                                            )}
                                            {showE2Input && (
                                                <div className={`space-y-2 ${e2ColSpan2 ? 'col-span-2' : ''}`}>
                                                    <label className="block text-xs font-bold text-pink-400 uppercase tracking-wider">
                                                        {route === Route.patchApply ? t('field.dose_raw') : t('field.dose_e2')}
                                                    </label>
                                                    <input
                                                        type="number" inputMode="decimal" min="0" step="0.001"
                                                        value={e2Dose} onChange={e => handleE2Change(e.target.value)}
                                                        className="w-full p-4 rounded-xl focus:ring-2 outline-none font-bold font-mono"
                                                        style={{ background: 'var(--bg-soft-rose)', border: '1px solid var(--border-soft-rose)', color: 'var(--accent-500)' }}
                                                        placeholder="0.0"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                        {(ester === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) && (
                                            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                                                {t('field.dose_e2')}: {e2Dose ? `${e2Dose} mg` : '--'}
                                            </p>
                                        )}
                                    </>
                                    )
                                )}

                                {/* Patch rate input */}
                                {route === Route.patchApply && patchMode === 'rate' && (
                                    <div className="space-y-2">
                                        <label className="block text-sm font-bold" style={labelStyle}>{t('field.patch_rate')}</label>
                                        <input
                                            type="number" inputMode="decimal" min="0" step="1"
                                            value={patchRate} onChange={e => setPatchRate(e.target.value)}
                                            className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none"
                                            style={inputStyle}
                                            placeholder="e.g. 50"
                                        />
                                    </div>
                                )}

                                {/* Dose guide */}
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

                                {/* Sublingual specifics */}
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
                                                <input type="range" min="0" max="3" step="1"
                                                    value={slTier} onChange={e => setSlTier(parseInt(e.target.value))}
                                                    className="w-full h-2 bg-[var(--track-teal)] rounded-lg appearance-none cursor-pointer accent-teal-600" />
                                                <div className="flex justify-between text-xs font-medium text-[var(--text-icon-teal)]">
                                                    <span>{t('sl.mode.quick')}</span>
                                                    <span>{t('sl.mode.casual')}</span>
                                                    <span>{t('sl.mode.standard')}</span>
                                                    <span>{t('sl.mode.strict')}</span>
                                                </div>
                                                <div className="text-xs text-[var(--text-icon-teal)] bg-[var(--bg-info-box)] p-2 rounded-lg flex justify-between items-center">
                                                    <span>Absorption θ ≈ {currentTheta.toFixed(2)}</span>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <input type="number" step="0.01" max="1" min="0" value={customTheta}
                                                    onChange={e => setCustomTheta(e.target.value)}
                                                    className="w-full p-3 border border-[var(--border-med-teal)] rounded-xl focus:ring-2 focus:ring-teal-500 outline-none"
                                                    style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                                                    placeholder="0.0 - 1.0" />
                                                <div className="text-xs text-[var(--text-icon-teal)] bg-[var(--bg-info-box)] p-2 rounded-lg flex justify-between items-center">
                                                    <span>Absorption θ ≈ {activeTheta.toFixed(2)}</span>
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

                                {/* Separator */}
                                <div className="relative flex items-center py-1">
                                    <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }} />
                                    <span className="mx-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                        <Calendar size={12} className="inline mr-1" />{t('batch.step_config')}
                                    </span>
                                    <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }} />
                                </div>

                                {/* Schedule */}
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>{t('batch.start_date')}</label>
                                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                                            className="w-full p-3 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={inputStyle} />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>{t('batch.end_date')}</label>
                                        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                                            className="w-full p-3 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={inputStyle} />
                                    </div>
                                </div>

                                {/* 身高 + 体重：同一行，先身高再体重 */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>{t('batch.height_label')}</label>
                                        <input
                                            type="number" inputMode="decimal" min="80" max="250" step="0.5"
                                            value={heightStr} onChange={e => setHeightStr(e.target.value)}
                                            className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={inputStyle}
                                            placeholder="165" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>{t('batch.weight_label')}</label>
                                        <input
                                            type="number" inputMode="decimal" min="20" max="300" step="0.1"
                                            value={weightStr} onChange={e => setWeightStr(e.target.value)}
                                            className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={inputStyle}
                                            placeholder="70" />
                                    </div>
                                </div>

                                {/* 间隔：贴片路径用「天 + 小时」双输入 + patch 版标签；其它路径只要「天」整数 + 通用标签 */}
                                <div className="space-y-2">
                                    <label className="block text-xs font-bold" style={labelStyle}>
                                        {route === Route.patchApply ? t('batch.interval_label_patch') : t('batch.interval')}
                                    </label>
                                    <div className={route === Route.patchApply ? "grid grid-cols-2 gap-3" : ""}>
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                {route === Route.patchApply ? t('batch.interval_days_label_patch') : t('batch.interval_days_label')}
                                            </label>
                                            <input type="number" min="1" max="365"
                                                value={intervalDaysStr}
                                                onChange={e => setIntervalDaysStr(e.target.value)}
                                                onBlur={() => setIntervalDaysStr(String(intervalDays))}
                                                className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                style={inputStyle} />
                                        </div>
                                        {route === Route.patchApply && (
                                            <div className="space-y-1">
                                                <label className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                    {t('batch.interval_hours_label')}
                                                </label>
                                                <input type="number" min="0" max="23"
                                                    value={intervalHoursStr}
                                                    onChange={e => setIntervalHoursStr(e.target.value)}
                                                    onBlur={() => setIntervalHoursStr(String(intervalHours))}
                                                    className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={inputStyle} />
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* 每日次数：贴片路径不渲染（贴片必须每日 1 次是预设硬约束，没必要提示用户）；
                                    其它路径显示输入框，跟下面「时间槽」useEffect 联动增减。 */}
                                {route !== Route.patchApply && (
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>{t('batch.times_per_day')}</label>
                                        <input type="number" min="1" max="4"
                                            value={timesPerDayStr}
                                            onChange={e => setTimesPerDayStr(e.target.value)}
                                            onBlur={() => setTimesPerDayStr(String(timesPerDay))}
                                            className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={inputStyle} />
                                    </div>
                                )}

                                {/* 时间槽：贴片路径只显示 1 个（每天贴一次），贴片标签改成「第一次用药开始时间」 */}
                                <div className="space-y-3">
                                    <label className="block text-xs font-bold" style={labelStyle}>
                                        {route === Route.patchApply ? t('batch.time_slot_label_patch') : t('batch.time_slot')}
                                    </label>
                                    <div className="grid grid-cols-2 gap-3">
                                        {timeSlots.map((slot, i) => (
                                            <div key={i} className="flex items-center gap-2">
                                                <span className="text-[10px] font-bold w-4 text-center" style={{ color: 'var(--text-tertiary)' }}>{i + 1}</span>
                                                <input type="time" value={slot} onChange={e => updateTimeSlot(i, e.target.value)}
                                                    className="flex-1 p-3 rounded-xl text-sm font-medium text-center outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={inputStyle} />
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* 贴片专属：贴片佩戴时间（天 + 小时）放在表单最底部，hint 文字已删 */}
                                {route === Route.patchApply && (
                                    <div className="space-y-2">
                                        <label className="block text-xs font-bold" style={labelStyle}>
                                            {t('batch.wear_days_label')}
                                        </label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="space-y-1">
                                                <label className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                    {t('batch.interval_days_label_patch')}
                                                </label>
                                                <input type="number" min="0" max="14"
                                                    value={wearDaysStr}
                                                    onChange={e => setWearDaysStr(e.target.value)}
                                                    onBlur={() => setWearDaysStr(String(wearDays))}
                                                    className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={inputStyle} />
                                            </div>
                                            <div className="space-y-1">
                                                <label className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                    {t('batch.interval_hours_label')}
                                                </label>
                                                <input type="number" min="0" max="23"
                                                    value={wearHoursStr}
                                                    onChange={e => setWearHoursStr(e.target.value)}
                                                    onBlur={() => setWearHoursStr(String(wearHours))}
                                                    className="w-full p-3 rounded-xl text-sm font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                                    style={inputStyle} />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}

                        {step === 'preview' && (
                            <>
                                <div className="flex items-start gap-3 p-4 rounded-2xl border"
                                    style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.25)' }}>
                                    <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
                                    <p className="text-xs leading-relaxed font-medium" style={{ color: 'var(--text-secondary)' }}>
                                        {t('batch.warning')}
                                    </p>
                                </div>

                                {/* Tap-to-edit hint */}
                                {previewEvents.length > 0 && (
                                    <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl"
                                        style={{ background: 'var(--bg-soft-rose)', border: '1px solid var(--border-soft-rose)' }}>
                                        <MousePointerClick size={15} className="shrink-0" style={{ color: 'var(--accent-500)' }} />
                                        <p className="text-xs leading-snug font-medium" style={{ color: 'var(--accent-500)' }}>
                                            {t('batch.tap_to_edit')}
                                        </p>
                                    </div>
                                )}

                                <div className="flex items-center justify-between gap-2 px-1">
                                    <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                        {t('batch.total_count').replace('{n}', previewEvents.length.toString())}
                                    </span>
                                    {previewSummary && (
                                        <span className="text-xs px-2.5 py-1 rounded-full font-bold shrink-0"
                                            style={{ background: 'var(--bg-soft-rose)', color: 'var(--accent-500)', border: '1px solid var(--border-soft-rose)' }}>
                                            {previewSummary.mixed
                                                ? t('batch.mixed')
                                                : `${t(`route.${previewSummary.route}`)}${previewSummary.ester && previewSummary.route !== Route.patchRemove && previewSummary.route !== Route.gel && previewSummary.route !== Route.patchApply ? ` · ${t(`ester.${previewSummary.ester}`)}` : ''}`}
                                        </span>
                                    )}
                                </div>

                                {previewEvents.length === 0 ? (
                                    <div className="text-center py-12 rounded-2xl border border-dashed"
                                        style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                                        {t('batch.empty_preview')}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {groupedPreview.map(group => {
                                            // 贴片对算 2 个事件；非贴片按 1 个
                                            const totalEv = group.pairs.length * 2 + group.lone.length;
                                            return (
                                                <div key={group.date} className="rounded-2xl border overflow-hidden"
                                                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                                                    <div className="px-4 py-2.5 flex items-center gap-2 border-b"
                                                        style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                                                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent-400)' }} />
                                                        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                            {group.date}
                                                        </span>
                                                        <span className="text-[10px] font-medium ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                                                            {totalEv}x
                                                        </span>
                                                    </div>
                                                    <div className="divide-y" style={{ borderColor: 'var(--border-secondary)' }}>
                                                        {/* 贴片对：apply 卡 + 撕下提示行（挂在 apply 下面） */}
                                                        {group.pairs.map(pair => {
                                                            const applyEv = pair.apply;
                                                            const removeEv = pair.remove;
                                                            const d = new Date(applyEv.timeH * 3600000);
                                                            const pad = (n: number) => n.toString().padStart(2, '0');
                                                            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                                                            const isPatchRate = (applyEv.extras?.[ExtraKey.releaseRateUGPerDay] ?? 0) > 0;
                                                            const rate = applyEv.extras?.[ExtraKey.releaseRateUGPerDay];
                                                            const doseLabel = isPatchRate
                                                                ? `${rate} µg/d`
                                                                : `${applyEv.doseMG.toFixed(2)} mg`;
                                                            return (
                                                                <React.Fragment key={applyEv.id}>
                                                                    {/* apply 卡（与之前一样，可点击编辑） */}
                                                                    <div
                                                                        role="button"
                                                                        tabIndex={0}
                                                                        aria-label={`${t('btn.edit') || 'Edit'} · ${timeStr} · ${doseLabel} · ${t(`route.${applyEv.route}`)}`}
                                                                        onClick={() => setEditingEvent(applyEv)}
                                                                        onKeyDown={(e) => {
                                                                            if (e.currentTarget !== e.target) return;
                                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                                e.preventDefault();
                                                                                setEditingEvent(applyEv);
                                                                            }
                                                                        }}
                                                                        className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)] active:bg-[var(--bg-card-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-300)]"
                                                                    >
                                                                        <span className="text-sm font-mono font-semibold min-w-[3.2em]" style={{ color: 'var(--text-primary)' }}>
                                                                            {timeStr}
                                                                        </span>
                                                                        <span className="text-xs font-bold" style={{ color: 'var(--accent-500)' }}>
                                                                            {doseLabel}
                                                                        </span>
                                                                        <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                                            {t(`route.${applyEv.route}`)}
                                                                        </span>
                                                                        <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                                                            {applyEv.weightKG} {t('field.weight_unit')}
                                                                        </span>
                                                                        {typeof applyEv.heightCm === 'number' && applyEv.heightCm > 0 && (
                                                                            <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                                                                {applyEv.heightCm} {t('field.height_unit')}
                                                                            </span>
                                                                        )}
                                                                        <button
                                                                            onClick={(e) => { e.stopPropagation(); removePreviewEvent(applyEv.id); }}
                                                                            aria-label={t('batch.delete_pair') || 'Delete this patch pair'}
                                                                            className="ml-auto min-w-11 min-h-11 flex items-center justify-center rounded-lg transition opacity-60 hover:opacity-100 active:opacity-100"
                                                                            style={{ color: '#ef4444' }}
                                                                        >
                                                                            <Trash2 size={16} />
                                                                        </button>
                                                                    </div>
                                                                    {/* 撕下提示行：挂在 apply 下面，显示「YYYY-MM-DD HH:MM」+ 「X 天 Y 小时摘下」。
                                                                        这里不放删除按钮：apply 行的删除按钮会联动删一对，多一个反而让用户担心会不会只删一半。 */}
                                                                    {removeEv && (() => {
                                                                        const rd = new Date(removeEv.timeH * 3600000);
                                                                        const rDateStr = toLocalDateStr(rd);
                                                                        const rTimeStr = `${pad(rd.getHours())}:${pad(rd.getMinutes())}`;
                                                                        const wear = formatWearDuration(applyEv.timeH, removeEv.timeH);
                                                                        const wearLabel = wear.key === 'days'
                                                                            ? t('batch.patch_removed_in_days_only').replace('{d}', String(wear.days))
                                                                            : wear.key === 'hours'
                                                                                ? t('batch.patch_removed_in_hours_only').replace('{h}', String(wear.hours))
                                                                                : t('batch.patch_removed_in_both')
                                                                                    .replace('{d}', String(wear.days))
                                                                                    .replace('{h}', String(wear.hours));
                                                                        return (
                                                                            <div
                                                                                className="px-3 sm:px-4 py-2 flex items-center gap-2 text-[11px]"
                                                                                style={{ color: 'var(--text-tertiary)' }}
                                                                            >
                                                                                <span className="font-mono font-semibold">{rDateStr} {rTimeStr}</span>
                                                                                <span>{wearLabel}</span>
                                                                            </div>
                                                                        );
                                                                    })()}
                                                                </React.Fragment>
                                                            );
                                                        })}
                                                        {/* 非贴片单事件：跟旧渲染一致 */}
                                                        {group.lone.map(ev => {
                                                            const d = new Date(ev.timeH * 3600000);
                                                            const pad = (n: number) => n.toString().padStart(2, '0');
                                                            const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                                                            const doseLabel = `${ev.doseMG.toFixed(2)} mg`;
                                                            return (
                                                                <div
                                                                    key={ev.id}
                                                                    role="button"
                                                                    tabIndex={0}
                                                                    aria-label={`${t('btn.edit') || 'Edit'} · ${timeStr} · ${doseLabel} · ${t(`route.${ev.route}`)}`}
                                                                    onClick={() => setEditingEvent(ev)}
                                                                    onKeyDown={(e) => {
                                                                        if (e.currentTarget !== e.target) return;
                                                                        if (e.key === 'Enter' || e.key === ' ') {
                                                                            e.preventDefault();
                                                                            setEditingEvent(ev);
                                                                        }
                                                                    }}
                                                                    className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)] active:bg-[var(--bg-card-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-300)]"
                                                                >
                                                                    <span className="text-sm font-mono font-semibold min-w-[3.2em]" style={{ color: 'var(--text-primary)' }}>
                                                                        {timeStr}
                                                                    </span>
                                                                    <span className="text-xs font-bold" style={{ color: 'var(--accent-500)' }}>
                                                                        {doseLabel}
                                                                    </span>
                                                                    <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                                                        {t(`route.${ev.route}`)}
                                                                    </span>
                                                                    <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                                                        {ev.weightKG} {t('field.weight_unit')}
                                                                    </span>
                                                                    {typeof ev.heightCm === 'number' && ev.heightCm > 0 && (
                                                                        <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card-hover)', borderColor: 'var(--border-secondary)' }}>
                                                                            {ev.heightCm} {t('field.height_unit')}
                                                                        </span>
                                                                    )}
                                                                    {ev.route === Route.gel && (() => {
                                                                        const gx = ev.extras ?? {};
                                                                        const prod = allGelProducts.find(p => p.id === gx[ExtraKey.gelProductId]);
                                                                        const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(gx[ExtraKey.gelSite] ?? 0)));
                                                                        const parts: string[] = [];
                                                                        if (prod) parts.push(prod.name || t(prod.nameKey));
                                                                        parts.push(t(`gel.site.${GEL_SITE_ORDER[siteIdx]}`));
                                                                        if (GEL_SITE_ORDER[siteIdx] !== GelSite.scrotal) {
                                                                            const ar = gx[ExtraKey.areaCM2];
                                                                            if (typeof ar === 'number' && ar > 0) parts.push(`~${Math.round(ar)} cm²`);
                                                                        }
                                                                        const co = gx[ExtraKey.gelCoApplied];
                                                                        if (typeof co === 'number' && co > 0 && co < GEL_COAPPLICATION_ORDER.length) parts.push(t(`gel.coapplied.${GEL_COAPPLICATION_ORDER[co]}`));
                                                                        const wsh = gx[ExtraKey.gelWashAfterH];
                                                                        if (typeof wsh === 'number' && wsh > 0) parts.push(`${t('gel.wash_short')} ${wsh}h`);
                                                                        return (
                                                                            <span className="basis-full text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                                                                                {parts.join(' · ')}
                                                                            </span>
                                                                        );
                                                                    })()}
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); removePreviewEvent(ev.id); }}
                                                                        aria-label={t('btn.delete') || 'Delete'}
                                                                        className="ml-auto min-w-11 min-h-11 flex items-center justify-center rounded-lg transition opacity-60 hover:opacity-100 active:opacity-100"
                                                                        style={{ color: '#ef4444' }}
                                                                    >
                                                                        <Trash2 size={16} />
                                                                    </button>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="p-5 md:p-6 border-t shrink-0 flex gap-3 safe-area-pb"
                        style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                        {step === 'config' && (
                            <button
                                onClick={generatePreview}
                                disabled={!canGenerate}
                                className="flex-1 h-14 text-white text-base font-bold rounded-xl transition-all flex items-center justify-center gap-2 glass-btn-primary btn-press-glass disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {t('batch.generate')}
                                <ChevronRight size={18} />
                            </button>
                        )}
                        {step === 'preview' && (
                            <>
                                <button onClick={() => setStep('config')}
                                    className="h-14 px-5 font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                                    style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}>
                                    <ChevronLeft size={16} />
                                    {t('batch.back')}
                                </button>
                                <button onClick={handleConfirm}
                                    disabled={previewEvents.length === 0}
                                    className="flex-1 h-14 text-white text-base font-bold rounded-xl transition-all flex items-center justify-center gap-2 glass-btn-primary btn-press-glass disabled:opacity-40 disabled:cursor-not-allowed">
                                    <Plus size={18} />
                                    {t('batch.confirm_add')} ({previewEvents.length})
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Per-row full editor: reuse DoseFormModal for parity with regular add */}
            {editingEvent && (
                <DoseFormModal
                    isOpen={!!editingEvent}
                    onClose={() => setEditingEvent(null)}
                    eventToEdit={editingEvent}
                    onSave={handleEventEdit}
                    onDelete={handleEventDelete}
                />
            )}
        </>
    );
};

export default BatchDoseModal;
