import React, { useState, useEffect, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAppData } from '../contexts/AppDataContext';
import { prefillWeightKG } from '../utils/weight';
import CustomSelect from './CustomSelect';
import QuickDosePanel from './QuickDosePanel';
import { getRouteIcon } from '../utils/helpers';
import {
    ROUTE_DISPLAY_ORDER, getAvailableEsters,
    isPresetDose, hasQuickDosePanel,
    drugKeyOf, readDoseByDrug, writeDoseMemo, readLastDrug,
} from '../utils/doseForm';
import { Route, Ester, ExtraKey, DoseEvent, SL_TIER_ORDER, SublingualTierParams, getToE2Factor, isAntiandrogen } from '../../logic';
import { Calendar, X, Clock, Info, Save, Trash2, Bookmark, Check, Pencil } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface DoseTemplate {
    id: string;
    name: string;
    route: Route;
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    patchMode: "dose" | "rate";
    patchRate: string;
    gelSite: number;
    slTier: number;
    useCustomTheta: boolean;
    customTheta: string;
}

type DoseLevelKey = 'low' | 'medium' | 'high' | 'very_high' | 'above';

type DoseGuideConfig = {
    unitKey: 'mg_day' | 'ug_day' | 'mg_week';
    thresholds: [number, number, number, number];
    requiresRate?: boolean;
};

const DOSE_GUIDE_CONFIG: Partial<Record<Route, DoseGuideConfig>> = {
    [Route.oral]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    [Route.sublingual]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    [Route.patchApply]: { unitKey: 'ug_day', thresholds: [100, 200, 400, 600], requiresRate: true },
    [Route.gel]: { unitKey: 'mg_day', thresholds: [1.5, 3, 6, 9] },
    [Route.injection]: { unitKey: 'mg_week', thresholds: [1, 2, 4, 6] },
};

const LEVEL_BADGE_STYLES: Record<DoseLevelKey, string> = {
    low: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    medium: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    high: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    very_high: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    above: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
};

const LEVEL_CONTAINER_STYLES: Record<DoseLevelKey | 'neutral', string> = {
    low: 'bg-emerald-50 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800/40',
    medium: 'bg-sky-50 border-sky-100 dark:bg-sky-900/20 dark:border-sky-800/40',
    high: 'bg-amber-50 border-amber-100 dark:bg-amber-900/20 dark:border-amber-800/40',
    very_high: 'bg-rose-50 border-rose-100 dark:bg-rose-900/20 dark:border-rose-800/40',
    above: 'bg-red-50 border-red-100 dark:bg-red-900/20 dark:border-red-800/40',
    neutral: 'bg-gray-50 border-gray-200 dark:bg-gray-800/40 dark:border-gray-700'
};

const formatGuideNumber = (val: number) => {
    if (Number.isInteger(val)) return val.toString();
    const rounded = val < 1 ? val.toFixed(2) : val.toFixed(1);
    return rounded.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

export interface DoseFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    eventToEdit?: DoseEvent | null;
    onSave: (event: DoseEvent) => void;
    onDelete?: (id: string) => void;
}

const DoseFormModal: React.FC<DoseFormModalProps> = ({ isOpen, onClose, eventToEdit, onSave, onDelete }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const { events: allEvents } = useAppData();
    const dateInputRef = useRef<HTMLInputElement>(null);

    // Form State
    const [dateStr, setDateStr] = useState("");
    const [route, setRoute] = useState<Route>(Route.injection);
    const [ester, setEster] = useState<Ester>(Ester.EV);

    const [rawDose, setRawDose] = useState("");
    const [e2Dose, setE2Dose] = useState("");

    const [patchMode, setPatchMode] = useState<"dose" | "rate">("dose");
    const [patchRate, setPatchRate] = useState("");

    const [gelSite, setGelSite] = useState(0); // Index in GEL_SITE_ORDER

    const [slTier, setSlTier] = useState(2);
    const [useCustomTheta, setUseCustomTheta] = useState(false);
    const [customTheta, setCustomTheta] = useState("");
    const [useCustomDose, setUseCustomDose] = useState(false);
    const [lastEditedField, setLastEditedField] = useState<'raw' | 'bio'>('bio');
    const [weightStr, setWeightStr] = useState("");

    // Tracks the drug key the per-drug dose memory was last loaded for, so the
    // memory-restore effect only fires when the user actually switches compounds.
    const prevDrugKeyRef = useRef<string | null>(null);

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

    useEffect(() => {
        if (isOpen) {
            if (eventToEdit) {
                const d = new Date(eventToEdit.timeH * 3600000);
                const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
                setDateStr(iso);
                setRoute(eventToEdit.route);
                setEster(eventToEdit.ester);
                // Quick-dose panel: open manual entry when the event's dose isn't
                // one of the presets, so a non-preset dose stays visible/editable.
                setUseCustomDose(
                    hasQuickDosePanel(eventToEdit.route, eventToEdit.ester) &&
                    !isPresetDose(eventToEdit.ester, eventToEdit.doseMG)
                );

                if (eventToEdit.route === Route.patchApply && eventToEdit.extras[ExtraKey.releaseRateUGPerDay]) {
                    setPatchMode("rate");
                    setPatchRate(eventToEdit.extras[ExtraKey.releaseRateUGPerDay].toString());
                    setE2Dose("");
                    setRawDose("");
                    setLastEditedField('bio');
                } else {
                    setPatchMode("dose");
                    // Fix: Show E2 Equivalent (MW only), not Bioavailable dose
                    const factor = getToE2Factor(eventToEdit.ester);
                    const e2Val = eventToEdit.doseMG * factor;
                    setE2Dose(e2Val.toFixed(3));

                    if (eventToEdit.ester !== Ester.E2) {
                        setRawDose(eventToEdit.doseMG.toFixed(3));
                        setLastEditedField('raw');
                    } else {
                        setRawDose(eventToEdit.doseMG.toFixed(3));
                        setLastEditedField('bio');
                    }
                }

                if (eventToEdit.route === Route.sublingual) {
                    if (eventToEdit.extras[ExtraKey.sublingualTier] !== undefined) {
                         setSlTier(eventToEdit.extras[ExtraKey.sublingualTier]);
                         setUseCustomTheta(false);
                         setCustomTheta("");
                    } else if (eventToEdit.extras[ExtraKey.sublingualTheta] !== undefined) {
                        setUseCustomTheta(true);
                        setCustomTheta(eventToEdit.extras[ExtraKey.sublingualTheta].toString());
                    } else {
                        setUseCustomTheta(false);
                        setCustomTheta("");
                    }
                } else {
                    setUseCustomTheta(false);
                    setCustomTheta("");
                }

                if (eventToEdit.route === Route.gel) {
                    setGelSite(eventToEdit.extras[ExtraKey.gelSite] ?? 0);
                } else {
                    setGelSite(0);
                }

                setWeightStr((eventToEdit.weightKG ?? prefillWeightKG(allEvents)).toString());

            } else {
                const now = new Date();
                const iso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
                setDateStr(iso);

                // Land on the last drug used (sublingual + estradiol valerate as
                // the cold-start default). The per-drug dose memory restore is
                // handled by the dedicated effect below, keyed on route/ester.
                const last = readLastDrug();
                const initRoute: Route = last?.route ?? Route.sublingual;
                const initEster: Ester = last?.ester ?? Ester.EV;

                setRoute(initRoute);
                setEster(initEster);
                setGelSite(0);
                setWeightStr(prefillWeightKG(allEvents).toString());
                // patchMode/patchRate + dose fields are restored per-drug by the
                // dedicated effect below (keyed on route/ester).
            }
        }
    }, [isOpen, eventToEdit]);

    // `activeEster` lets callers in the quick-dose path pass `safeEster`, so the
    // mg<->E2 conversion uses the same compound the panel is displaying even in
    // the brief window where `ester` hasn't been re-validated yet.
    const handleRawChange = (val: string, activeEster: Ester = ester) => {
        setRawDose(val);
        setLastEditedField('raw');
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(activeEster) || 1;
            const e2Equivalent = v * factor; // convert compound mg -> E2 equivalent (pre-bio)
            setE2Dose(e2Equivalent.toFixed(3));
        } else {
            setE2Dose("");
        }
    };

    const handleE2Change = (val: string, activeEster: Ester = ester) => {
        setE2Dose(val);
        setLastEditedField('bio');
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(activeEster) || 1;
            if (activeEster === Ester.E2) {
                setRawDose(v.toFixed(3));
            } else {
                setRawDose((v / factor).toFixed(3));
            }
        } else {
            setRawDose("");
        }
    };

    // A quick-panel preset is the dose of the compound itself (mg). For plain E2
    // the visible field is the E2-equivalent (== compound), so route through
    // handleE2Change; every other compound enters via the raw-dose field.
    const applyQuickDose = (mg: number, activeEster: Ester) => {
        const val = String(mg);
        if (activeEster === Ester.E2) {
            handleE2Change(val, activeEster);
        } else {
            handleRawChange(val, activeEster);
        }
    };

    // Toggle between preset chips and manual entry. When leaving manual entry,
    // clear any value that isn't one of the presets so a now-hidden custom dose
    // can't be silently saved (the chips would show nothing selected).
    const toggleCustomDose = (activeEster: Ester) => {
        const next = !useCustomDose;
        if (!next) {
            const current = parseFloat(activeEster === Ester.E2 ? e2Dose : rawDose);
            if (!isPresetDose(activeEster, current)) {
                setRawDose("");
                setE2Dose("");
            }
        }
        setUseCustomDose(next);
    };

    useEffect(() => {
        if (lastEditedField === 'raw' && rawDose) {
            handleRawChange(rawDose);
        }
    }, [ester]);

    useEffect(() => {
        if (lastEditedField === 'bio' && e2Dose) {
            handleE2Change(e2Dose);
        }
    }, [ester]);

    // Restore the per-drug remembered dose whenever the active compound changes
    // (new-record mode only). Declared after the ester-sync effects so its loaded
    // value is authoritative. Switching to a never-used compound clears the dose
    // rather than carrying the previous compound's value over — this is the fix
    // for doses leaking across drugs.
    useEffect(() => {
        if (!isOpen || eventToEdit) {
            if (!isOpen) prevDrugKeyRef.current = null;
            return;
        }
        const key = drugKeyOf(route, ester);
        if (prevDrugKeyRef.current === key) return;
        prevDrugKeyRef.current = key;

        const memo = readDoseByDrug()[key];
        if (memo) {
            setRawDose(memo.rawDose ?? "");
            setE2Dose(memo.e2Dose ?? "");
            setPatchMode(memo.patchMode ?? "dose");
            setPatchRate(memo.patchRate ?? "");
            setSlTier(memo.slTier ?? 2);
            setUseCustomTheta(memo.useCustomTheta ?? false);
            setCustomTheta(memo.customTheta ?? "");
            setUseCustomDose(memo.customDose ?? false);
            setLastEditedField(ester === Ester.E2 ? 'bio' : 'raw');
        } else {
            setRawDose("");
            setE2Dose("");
            setPatchMode("dose");
            setPatchRate("");
            setSlTier(2);
            setUseCustomTheta(false);
            setCustomTheta("");
            setUseCustomDose(false);
            setLastEditedField(ester === Ester.E2 ? 'bio' : 'raw');
        }
    }, [isOpen, eventToEdit, route, ester]);

    const [isSaving, setIsSaving] = useState(false);
    const [templates, setTemplates] = useState<DoseTemplate[]>(() => {
        try {
            const saved = localStorage.getItem('hrt-dose-templates');
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });
    const [showPanel, setShowPanel] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");

    const applyTemplate = (tpl: DoseTemplate) => {
        // Claim the target drug key up-front so the per-drug restore effect does
        // not overwrite the template's dose when route/ester change below.
        prevDrugKeyRef.current = drugKeyOf(tpl.route, tpl.ester);
        setRoute(tpl.route);
        setEster(tpl.ester);
        setRawDose(tpl.rawDose);
        setE2Dose(tpl.e2Dose);
        setPatchMode(tpl.patchMode);
        setPatchRate(tpl.patchRate);
        setGelSite(tpl.gelSite);
        setSlTier(tpl.slTier);
        setUseCustomTheta(tpl.useCustomTheta);
        setCustomTheta(tpl.customTheta);
        // Match the quick-panel mode to the template dose (custom if it isn't a tier).
        const tplDose = parseFloat(tpl.ester === Ester.E2 ? tpl.e2Dose : tpl.rawDose);
        setUseCustomDose(hasQuickDosePanel(tpl.route, tpl.ester) && !isPresetDose(tpl.ester, tplDose));
        setLastEditedField('raw');
        setShowPanel(false);
    };

    const saveTemplate = () => {
        const name = newTemplateName.trim();
        if (!name) return;
        const tpl: DoseTemplate = {
            id: uuidv4(), name,
            route, ester, rawDose, e2Dose,
            patchMode, patchRate, gelSite,
            slTier, useCustomTheta, customTheta,
        };
        const updated = [...templates, tpl];
        setTemplates(updated);
        localStorage.setItem('hrt-dose-templates', JSON.stringify(updated));
        setNewTemplateName("");
    };

    const deleteTemplate = (id: string) => {
        const updated = templates.filter(t => t.id !== id);
        setTemplates(updated);
        localStorage.setItem('hrt-dose-templates', JSON.stringify(updated));
    };

    const handleSave = () => {
        if (isSaving) return;
        setIsSaving(true);
        let timeH = new Date(dateStr).getTime() / 3600000;
        if (isNaN(timeH)) {
            timeH = new Date().getTime() / 3600000;
        }

        // Route-determined esters always store as E2; otherwise use the outer
        // `safeEster` (computed once per render at component scope).
        const effectiveEster =
            (route === Route.patchRemove || route === Route.patchApply || route === Route.gel)
                ? Ester.E2
                : safeEster;

        let e2Equivalent = parseFloat(e2Dose);
        if (isNaN(e2Equivalent)) e2Equivalent = 0;
        // For EV injection/sublingual/oral, derive E2-equivalent from raw dose (hidden field) to avoid drift
        if (effectiveEster === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) {
            const rawVal = parseFloat(rawDose);
            if (Number.isFinite(rawVal)) {
                const factor = getToE2Factor(effectiveEster) || 1;
                e2Equivalent = rawVal * factor;
            }
        }
        let finalDose = 0;

        const extras: any = {};
        const nonPositiveMsg = t('error.nonPositive');

        if (route === Route.patchApply && patchMode === "rate") {
            const rateVal = parseFloat(patchRate);
            if (!Number.isFinite(rateVal) || rateVal <= 0) {
                showDialog('alert', nonPositiveMsg);
                setIsSaving(false);
                return;
            }
            finalDose = 0;
            extras[ExtraKey.releaseRateUGPerDay] = rateVal;
        } else if (route === Route.patchApply && patchMode === "dose") {
            const raw = parseFloat(rawDose);
            if (!Number.isFinite(raw) || raw <= 0) {
                showDialog('alert', nonPositiveMsg);
                setIsSaving(false);
                return;
            }
            finalDose = raw; // patch input is compound dose on patch
        } else if (route !== Route.patchRemove) {
            if (isAntiandrogen(effectiveEster)) {
                const rawVal = parseFloat(rawDose);
                if (!Number.isFinite(rawVal) || rawVal <= 0) {
                    showDialog('alert', nonPositiveMsg);
                    setIsSaving(false);
                    return;
                }
                finalDose = rawVal;
            } else {
                if (!Number.isFinite(e2Equivalent) || e2Equivalent <= 0) {
                    showDialog('alert', nonPositiveMsg);
                    setIsSaving(false);
                    return;
                }
                const factor = getToE2Factor(effectiveEster) || 1;
                finalDose = (effectiveEster === Ester.E2) ? e2Equivalent : e2Equivalent / factor; // store compound mg
            }
        }

        if (route === Route.sublingual && slExtras) {
            Object.assign(extras, slExtras);
        }

        if (route === Route.gel) {
            extras[ExtraKey.gelSite] = gelSite;
        }

        const parsedWeight = parseFloat(weightStr);
        const weightKG = (Number.isFinite(parsedWeight) && parsedWeight > 0)
            ? parsedWeight
            : prefillWeightKG(allEvents);

        const newEvent: DoseEvent = {
            id: eventToEdit?.id || uuidv4(),
            route,
            ester: effectiveEster,
            timeH,
            doseMG: finalDose,
            weightKG,
            extras
        };

        // Silently remember the last-used dose *per drug* (keyed by route+ester)
        // so one compound's dose never prefills onto another, plus which drug was
        // used last so the modal re-opens on it.
        if (!eventToEdit) {
            // Key the memo by the compound actually saved (effectiveEster), so the
            // memory can never disagree with the stored event.
            writeDoseMemo(route, effectiveEster, {
                rawDose, e2Dose,
                patchMode, patchRate,
                slTier, useCustomTheta, customTheta,
                customDose: useCustomDose,
            });
        }

        onSave(newEvent);
        setIsSaving(false);
        onClose();
    };

    // Calculate availableEsters unconditionally (shared with BatchDoseModal)
    const availableEsters = useMemo(() => getAvailableEsters(route), [route]);

    // Ensure ester is valid when route changes (e.g. switching from Injection to Gel should force E2)
    useEffect(() => {
        if (!availableEsters.includes(ester)) {
            setEster(availableEsters[0]);
        }
    }, [availableEsters, ester]);

    // Mirror handleSave's safeEster so UI gating (canGenerate/doseGuide) and
    // data write paths read the same value even mid-route-transition.
    const safeEster = availableEsters.includes(ester) ? ester : availableEsters[0];

    const doseGuide = useMemo(() => {
        // 抗雄药物 (CPA / BICA) 没有剂量提示，因为参考范围不同
        if (isAntiandrogen(safeEster)) return null;

        const cfg = DOSE_GUIDE_CONFIG[route];
        if (!cfg) return null;
        if (route === Route.patchApply && patchMode === "dose" && cfg.requiresRate) {
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

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    const tierKey = SL_TIER_ORDER[slTier] || "standard";
    const currentTheta = SublingualTierParams[tierKey]?.theta || 0.11;

    const activeTheta = useCustomTheta
        ? (slExtras && slExtras[ExtraKey.sublingualTheta] !== undefined
            ? slExtras[ExtraKey.sublingualTheta]!
            : 0.11)
        : currentTheta;

    const guideUnitLabel = doseGuide?.config ? t(`dose.guide.unit.${doseGuide.config.unitKey}`) : "";
    const guideRangeText = doseGuide?.config
        ? [
            `${t('dose.guide.level.low')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[0])} ${guideUnitLabel}`,
            `${t('dose.guide.level.medium')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[1])} ${guideUnitLabel}`,
            `${t('dose.guide.level.high')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[2])} ${guideUnitLabel}`,
            `${t('dose.guide.level.very_high')} ≤ ${formatGuideNumber(doseGuide.config.thresholds[3])} ${guideUnitLabel}`,
        ].join(' · ')
        : "";
    const guideContainerClass = doseGuide
        ? (
            doseGuide.level
                ? LEVEL_CONTAINER_STYLES[doseGuide.level]
                : (doseGuide.showRateHint ? LEVEL_CONTAINER_STYLES.high : LEVEL_CONTAINER_STYLES.neutral)
        )
        : LEVEL_CONTAINER_STYLES.neutral;
    const guideBadgeClass = doseGuide?.level ? LEVEL_BADGE_STYLES[doseGuide.level] : "";

    return (
        <div
            className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="dose-modal-title"
                className="relative rounded-3xl w-full max-w-lg md:max-w-2xl h-[90vh] md:max-h-[85vh] flex flex-col overflow-hidden modal-spring-glass glass-modal"
            >
                <div className="p-6 md:p-8 border-b flex justify-between items-center shrink-0"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    <h3 id="dose-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {eventToEdit ? t('modal.dose.edit_title') : t('modal.dose.add_title')}
                    </h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6 flex-1 overflow-y-auto">
                    {/* Time */}
                    <div className="space-y-2">
                        <label className="block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('field.time')}</label>
                        <div className="flex items-center gap-3">
                            <input
                                ref={dateInputRef}
                                type="datetime-local"
                                value={dateStr}
                                onChange={e => setDateStr(e.target.value)}
                                className="text-xl font-bold font-mono bg-transparent border-none p-0 focus:ring-0 focus:outline-none"
                                style={{ color: 'var(--text-primary)' }}
                            />
                            <button
                                onClick={() => dateInputRef.current?.focus()}
                                aria-label={t('field.time')}
                                className="p-2 rounded-lg transition-colors"
                                style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                            >
                                <Calendar size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Body weight */}
                    <div className="space-y-2">
                        <label className="block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('field.weight')}</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                inputMode="decimal"
                                min="20"
                                max="300"
                                step="0.1"
                                value={weightStr}
                                onChange={e => setWeightStr(e.target.value)}
                                className="flex-1 p-3 rounded-xl text-base font-bold font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                placeholder="70"
                            />
                            <span className="text-sm font-bold" style={{ color: 'var(--text-tertiary)' }}>{t('field.weight_unit')}</span>
                        </div>
                    </div>

                    {/* Route */}
                    <CustomSelect
                        label={t('field.route')}
                        value={route}
                        onChange={(val) => setRoute(val as Route)}
                        options={ROUTE_DISPLAY_ORDER.map(r => ({
                            value: r,
                            label: t(`route.${r}`),
                            icon: getRouteIcon(r)
                        }))}
                    />

                    {route === Route.patchRemove && (
                        <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40 p-3 rounded-xl">
                            {t('beta.patch_remove')}
                        </div>
                    )}

                    {route !== Route.patchRemove && (
                        <>
                            {/* Ester Selection */}
                            {availableEsters.length > 1 && (
                                <CustomSelect
                                    label={t('field.ester')}
                                    value={ester}
                                    onChange={(val) => setEster(val as Ester)}
                                    options={availableEsters.map(e => ({
                                        value: e,
                                        label: t(`ester.${e}`),
                                    }))}
                                />
                            )}

                            {/* Gel Site Selector */}
                            {route === Route.gel && (
                                <div className="mb-4 space-y-2">
                                    <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{t('field.gel_site')}</label>
                                    <div className="p-4 border border-dashed rounded-xl text-sm font-medium select-none" style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }}>
                                        {t('gel.site_disabled')}
                                    </div>
                                    <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40 p-3 rounded-xl">
                                        {t('beta.gel')}
                                    </div>
                                </div>
                            )}

                            {/* Patch Mode */}
                            {route === Route.patchApply && (
                                <div className="space-y-2">
                                    <div className="p-1 rounded-xl flex" style={{ background: 'var(--bg-card-hover)' }}>
                                        <button
                                            onClick={() => setPatchMode("dose")}
                                            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all`}
                                            style={patchMode === "dose" ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--text-tertiary)' }}
                                        >
                                            {t('field.patch_total')}
                                        </button>
                                        <button
                                            onClick={() => setPatchMode("rate")}
                                            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all`}
                                            style={patchMode === "rate" ? { background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--text-tertiary)' }}
                                        >
                                            {t('field.patch_rate')}
                                        </button>
                                    </div>
                                    <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40 p-3 rounded-xl">
                                        {t('beta.patch')}
                                    </div>
                                </div>
                            )}

                            {/* Dose Inputs */}
                            {(route !== Route.patchApply || patchMode === "dose") && (
                                hasQuickDosePanel(route, safeEster) ? (
                                    <QuickDosePanel
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
                                        {(ester !== Ester.E2) && (
                                            <div className={`space-y-2 ${ (ester === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) || isAntiandrogen(ester) ? 'col-span-2' : '' }`}>
                                                <label className="block text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('field.dose_raw')}</label>
                                                <input
                                                    type="number" inputMode="decimal"
                                                    min="0"
                                                    step="0.001"
                                                    value={rawDose} onChange={e => handleRawChange(e.target.value)}
                                                    className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono"
                                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                                    placeholder="0.0"
                                                />
                                            </div>
                                        )}
                                        {!(ester === Ester.EV && (route === Route.injection || route === Route.sublingual || route === Route.oral)) && !isAntiandrogen(ester) && (
                                            <div className={`space-y-2 ${(ester === Ester.E2 && route !== Route.gel && route !== Route.oral && route !== Route.sublingual) ? "col-span-2" : ""}`}>
                                                <label className="block text-xs font-bold text-pink-400 uppercase tracking-wider">
                                                    {route === Route.patchApply ? t('field.dose_raw') : t('field.dose_e2')}
                                                </label>
                                                <input
                                                    type="number" inputMode="decimal"
                                                    min="0"
                                                    step="0.001"
                                                    value={e2Dose} onChange={e => handleE2Change(e.target.value)}
                                                    className="w-full p-4 rounded-xl focus:ring-2 outline-none font-bold font-mono"
                                                    style={{ background: 'var(--accent-50)', border: '1px solid var(--accent-200)', color: 'var(--accent-500)' }}
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

                            {route === Route.patchApply && patchMode === "rate" && (
                                <div className="space-y-2">
                                    <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{t('field.patch_rate')}</label>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        min="0"
                                        step="1"
                                        value={patchRate}
                                        onChange={e => setPatchRate(e.target.value)}
                                        className="w-full p-4 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none"
                                        style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                        placeholder="e.g. 50"
                                    />
                                </div>
                            )}

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
                                            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                                                {t('dose.guide.patch_rate_hint')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Sublingual Specifics */}
                            {route === Route.sublingual && (
                                <div className="bg-teal-50 dark:bg-teal-900/20 p-4 rounded-2xl border border-teal-100 dark:border-teal-800/40 space-y-4">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-bold text-teal-800 dark:text-teal-300 flex items-center gap-2">
                                            <Clock size={16} /> {t('field.sl_duration')}
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-teal-600 dark:text-teal-400">{t('field.sl_custom')}</span>
                                            <div className={`w-10 h-6 rounded-full p-1 cursor-pointer transition-colors ${useCustomTheta ? 'bg-teal-500' : 'bg-gray-300 dark:bg-gray-600'}`} onClick={() => setUseCustomTheta(!useCustomTheta)}>
                                                <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${useCustomTheta ? 'translate-x-4' : ''}`} />
                                            </div>
                                        </div>
                                    </div>

                                    {!useCustomTheta ? (
                                        <div className="space-y-3">
                                            <input
                                                type="range" min="0" max="3" step="1"
                                                value={slTier} onChange={e => setSlTier(parseInt(e.target.value))}
                                                className="w-full h-2 bg-teal-200 dark:bg-teal-700 rounded-lg appearance-none cursor-pointer accent-teal-600"
                                            />
                                            <div className="flex justify-between text-xs font-medium text-teal-700 dark:text-teal-400">
                                                <span>{t('sl.mode.quick')}</span>
                                                <span>{t('sl.mode.casual')}</span>
                                                <span>{t('sl.mode.standard')}</span>
                                                <span>{t('sl.mode.strict')}</span>
                                            </div>
                                            <div className="text-xs text-teal-600 dark:text-teal-400 bg-white/50 dark:bg-teal-900/30 p-2 rounded-lg flex justify-between items-center">
                                                <span>Absorption θ ≈ {currentTheta.toFixed(2)}</span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <input type="number" step="0.01" max="1" min="0" value={customTheta} onChange={e => setCustomTheta(e.target.value)} className="w-full p-3 border border-teal-200 dark:border-teal-700 rounded-xl focus:ring-2 focus:ring-teal-500 outline-none" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }} placeholder="0.0 - 1.0" />
                                            <div className="text-xs text-teal-600 dark:text-teal-400 bg-white/50 dark:bg-teal-900/30 p-2 rounded-lg flex justify-between items-center">
                                                <span>Absorption θ ≈ {activeTheta.toFixed(2)}</span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex gap-3 items-start p-3 bg-white dark:bg-teal-900/30 rounded-xl border border-teal-100 dark:border-teal-800/40">
                                        <Info className="w-5 h-5 text-teal-500 shrink-0 mt-0.5" />
                                        <p className="text-xs text-teal-700 dark:text-teal-300 leading-relaxed text-justify">
                                            {t('sl.instructions')}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>

                    {/* Template panel (new-record mode only) */}
                {!eventToEdit && showPanel && (
                    <div className="absolute inset-x-0 bottom-[88px] border-t shadow-lg rounded-b-none z-10 flex flex-col max-h-72"
                        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-secondary)' }}>
                            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('template.title')}</span>
                            <button onClick={() => setShowPanel(false)} className="p-1 rounded-full" style={{ color: 'var(--text-tertiary)' }}>
                                <X size={16} />
                            </button>
                        </div>
                        <div className="overflow-y-auto flex-1 px-4 py-2 space-y-1">
                            {templates.length === 0 ? (
                                <p className="text-xs text-center py-4" style={{ color: 'var(--text-tertiary)' }}>{t('template.empty')}</p>
                            ) : templates.map(tpl => renamingId === tpl.id ? (
                                <div key={tpl.id} className="flex items-center gap-2 py-1.5 px-2">
                                    <input
                                        autoFocus
                                        type="text"
                                        value={renameValue}
                                        onChange={e => setRenameValue(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                const v = renameValue.trim();
                                                if (v) {
                                                    const updated = templates.map(t => t.id === tpl.id ? { ...t, name: v } : t);
                                                    setTemplates(updated);
                                                    localStorage.setItem('hrt-dose-templates', JSON.stringify(updated));
                                                }
                                                setRenamingId(null);
                                            } else if (e.key === 'Escape') {
                                                setRenamingId(null);
                                            }
                                        }}
                                        className="flex-1 text-sm px-2 py-1 rounded-lg focus:outline-none focus:ring-2"
                                        style={{ border: '1px solid var(--accent-200)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                                    />
                                    <button
                                        onClick={() => {
                                            const v = renameValue.trim();
                                            if (v) {
                                                const updated = templates.map(t => t.id === tpl.id ? { ...t, name: v } : t);
                                                setTemplates(updated);
                                                localStorage.setItem('hrt-dose-templates', JSON.stringify(updated));
                                            }
                                            setRenamingId(null);
                                        }}
                                        className="p-1.5 rounded-lg transition-colors"
                                        style={{ color: 'var(--accent-400)' }}
                                    >
                                        <Check size={14} />
                                    </button>
                                    <button
                                        onClick={() => setRenamingId(null)}
                                        className="p-1.5 rounded-lg transition-colors"
                                        style={{ color: 'var(--text-tertiary)' }}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ) : (
                                <button
                                    key={tpl.id}
                                    onClick={() => applyTemplate(tpl)}
                                    className="w-full flex items-center gap-2 py-1.5 px-2 rounded-lg group text-left transition-colors"
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    <span className="flex-1 text-sm truncate" style={{ color: 'var(--text-secondary)' }}>{tpl.name}</span>
                                    <span
                                        role="button"
                                        onClick={e => { e.stopPropagation(); setRenamingId(tpl.id); setRenameValue(tpl.name); }}
                                        className="p-1.5 rounded-lg transition-colors"
                                        style={{ color: 'var(--text-tertiary)' }}
                                    >
                                        <Pencil size={14} />
                                    </span>
                                    <span
                                        role="button"
                                        onClick={e => { e.stopPropagation(); deleteTemplate(tpl.id); }}
                                        className="p-1.5 rounded-lg transition-colors hover:text-red-400"
                                        style={{ color: 'var(--text-tertiary)' }}
                                    >
                                        <X size={14} />
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className="flex gap-2 px-4 py-3 border-t shrink-0" style={{ borderColor: 'var(--border-secondary)' }}>
                            <input
                                type="text"
                                value={newTemplateName}
                                onChange={e => setNewTemplateName(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && saveTemplate()}
                                placeholder={t('template.name_placeholder')}
                                className="flex-1 text-sm px-3 py-2 rounded-lg focus:outline-none focus:ring-2"
                                style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}
                            />
                            <button
                                onClick={saveTemplate}
                                disabled={!newTemplateName.trim()}
                                className="px-3 py-2 text-white text-sm font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1 glass-btn-primary btn-press-glass"
                            >
                                <Check size={14} /> {t('template.confirm')}
                            </button>
                        </div>
                    </div>
                )}

                <div className="p-6 border-t shrink-0 flex gap-3 safe-area-pb"
                    style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-card-hover)' }}>
                    {eventToEdit && (
                        <button
                            onClick={() => {
                                onClose();
                                if (onDelete) onDelete(eventToEdit.id);
                            }}
                            aria-label={t('btn.delete')}
                            className="w-16 h-14 flex items-center justify-center bg-red-50 text-red-500 rounded-xl hover:bg-red-100 border border-red-100 transition-colors"
                        >
                            <Trash2 size={20} />
                        </button>
                    )}
                    {!eventToEdit && (
                        <button
                            onClick={() => setShowPanel(p => !p)}
                            aria-label={t('template.title')}
                            aria-expanded={showPanel}
                            className="w-14 h-14 flex items-center justify-center rounded-xl border transition-colors shrink-0"
                            style={showPanel
                                ? { background: 'var(--accent-50)', borderColor: 'var(--accent-200)', color: 'var(--accent-400)' }
                                : { background: 'var(--bg-card-hover)', borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }
                            }
                        >
                            <Bookmark size={18} fill={showPanel ? 'currentColor' : 'none'} />
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className={`flex-1 h-14 text-white text-lg font-bold rounded-xl transition-all flex items-center justify-center gap-2 glass-btn-primary btn-press-glass ${isSaving ? 'opacity-70 cursor-not-allowed' : ''}`}
                    >
                        {isSaving ? (
                            <>
                                <span className="accent-spinner" />
                                <span>{t('btn.save')}</span>
                            </>
                        ) : (
                            <>
                                <Save size={20} /> {t('btn.save')}
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DoseFormModal;
