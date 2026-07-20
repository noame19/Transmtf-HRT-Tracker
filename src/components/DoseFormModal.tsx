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
    getAllGelProducts, readLastGelEvent,
    LEVEL_BADGE_STYLES, LEVEL_CONTAINER_STYLES, formatGuideNumber, computeDoseGuide,
} from '../utils/doseForm';
import { findPatchRemoveForApply } from '../utils/patch';
import { buildGelExtras, resolveGelAreaToStore } from '../utils/gelForm';
import {
    Route, Ester, ExtraKey, DoseEvent, SL_TIER_ORDER, SublingualTierParams,
    getToE2Factor, isAntiandrogen,
    GelSite, GEL_SITE_ORDER, GEL_PRODUCTS, GEL_DEFAULT_PRODUCT_ID,
    GEL_COVERAGE_TEMPLATES, GEL_COVERAGE_DEFAULT_IDX, GEL_COVERAGE_MANUAL_IDX,
    resolveGelCoverageArea, GEL_COAPPLICATION_ORDER,
    type GelProductSpec,
} from '../../logic';
import { Plan } from '../../types';
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

// 剂量参考档位 / 颜色 token / 数字格式化已在 2026-07-20 提取到 utils/doseForm.ts，
// 让「新建用药计划」弹窗也能复用同一份档位定义。两个表单现在从同处 import。

export interface DoseFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    eventToEdit?: DoseEvent | null;
    /**
     * Optional smart-prefill source. When opening for a new record and a plan
     * is matched against the current time (or a notification deep-link), we
     * pre-populate route / ester / dose / time from the plan. The plan's
     * `extras` are also mirrored into the event's per-route settings (gel site,
     * sublingual tier, etc.) so the user only has to confirm.
     */
    prefillFromPlan?: Plan | null;
    /**
     * Optional explicit time to use for the new record. When omitted (the
     * common case), the form falls back to `new Date()`. The Android
     * notification deep-link sets this to the scheduled-time of the reminder
     * so the saved record lines up exactly with what was scheduled.
     */
    prefillTimeOverride?: Date | null;
    onSave: (event: DoseEvent) => void;
    /**
     * Optional callback for a "paired save" — fires when the patch form has
     * an optional "摘下时间" (remove time) filled in. The parent receives both
     * events (apply + remove) sharing a fresh `companionGroupId` so the
     * /history list can render them as one logical record and hide the
     * "贴片移除" button on the apply card. When the form is used to edit an
     * existing single event (or save a non-patch / patch-without-remove-time
     * record), `onSave` is called instead.
     */
    onSavePatch?: (apply: DoseEvent, remove: DoseEvent) => void;
    onDelete?: (id: string) => void;
}

const DoseFormModal: React.FC<DoseFormModalProps> = ({ isOpen, onClose, eventToEdit, prefillFromPlan, prefillTimeOverride, onSave, onSavePatch, onDelete }) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const { events: allEvents, gelProducts } = useAppData();
    const dateInputRef = useRef<HTMLInputElement>(null);

    // Presets + the user's custom gel products, for the gel product selector.
    const allGelProducts = useMemo(() => getAllGelProducts(gelProducts), [gelProducts]);
    const findGelProduct = (id: number): GelProductSpec =>
        allGelProducts.find(p => p.id === id) ?? GEL_PRODUCTS[0];
    const gelProductLabel = (p: GelProductSpec): string => p.name || t(p.nameKey);

    // Form State
    const [dateStr, setDateStr] = useState("");
    const [route, setRoute] = useState<Route>(Route.injection);
    const [ester, setEster] = useState<Ester>(Ester.EV);

    const [rawDose, setRawDose] = useState("");
    const [e2Dose, setE2Dose] = useState("");

    const [patchMode, setPatchMode] = useState<"dose" | "rate">("dose");
    const [patchRate, setPatchRate] = useState("");

    // Optional patch remove time. When set, saving a "贴片" record writes
    // a paired (apply, remove) event pair with a shared companionGroupId.
    // Only meaningful for `route === Route.patchApply`; the form clears it
    // for any other route via the effect below.
    const [removeTimeStr, setRemoveTimeStr] = useState("");

    const [gelSite, setGelSite] = useState(0); // Index in GEL_SITE_ORDER
    const [gelProductId, setGelProductId] = useState<number>(GEL_DEFAULT_PRODUCT_ID);
    const [gelArea, setGelArea] = useState("");     // manual application area, cm² (only when coverage = manual)
    const [gelCoverage, setGelCoverage] = useState<number>(GEL_COVERAGE_DEFAULT_IDX); // body-surface coverage template
    const [gelCoApplied, setGelCoApplied] = useState<number>(0); // 0 none / 1 sunscreen / 2 moisturizer
    const [gelWash, setGelWash] = useState("");     // wash-off after N hours; "" = no wash

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
                    !isPresetDose(eventToEdit.route, eventToEdit.ester, eventToEdit.doseMG)
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

                // Patch prefill: if the event being edited is a patch "apply"
                // with a paired remove, surface that remove's time in the
                // "摘下时间" field so the user can adjust it. Editing a
                // "remove" event by itself just clears the field (the form's
                // dateStr is the remove time in that case).
                if (eventToEdit.route === Route.patchApply) {
                    const pairedRemove = findPatchRemoveForApply(eventToEdit, allEvents);
                    if (pairedRemove && Number.isFinite(pairedRemove.timeH)) {
                        const rd = new Date(pairedRemove.timeH * 3600000);
                        const rIso = new Date(rd.getTime() - (rd.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
                        setRemoveTimeStr(rIso);
                    } else {
                        setRemoveTimeStr('');
                    }
                } else {
                    setRemoveTimeStr('');
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
                    const ex = eventToEdit.extras;
                    setGelSite(ex[ExtraKey.gelSite] ?? 0);
                    setGelProductId(ex[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
                    const areaRaw = ex[ExtraKey.areaCM2];
                    setGelArea(typeof areaRaw === 'number' && areaRaw > 0 ? String(areaRaw) : "");
                    // A record without a coverage tag predates the templates → show it
                    // as "manual" so its stored cm² stays visible and unchanged.
                    const covRaw = ex[ExtraKey.gelCoverage];
                    setGelCoverage(typeof covRaw === 'number' && Number.isFinite(covRaw) ? Math.round(covRaw) : GEL_COVERAGE_MANUAL_IDX);
                    const coAppRaw = ex[ExtraKey.gelCoApplied];
                    setGelCoApplied(typeof coAppRaw === 'number' && Number.isFinite(coAppRaw) ? Math.round(coAppRaw) : 0);
                    const washRaw = ex[ExtraKey.gelWashAfterH];
                    setGelWash(typeof washRaw === 'number' && washRaw > 0 ? String(washRaw) : "");
                } else {
                    setGelSite(0);
                    setGelCoverage(GEL_COVERAGE_DEFAULT_IDX);
                    setGelCoApplied(0);
                }

                setWeightStr((eventToEdit.weightKG ?? prefillWeightKG(allEvents)).toString());

            } else {
                const nowRaw = prefillTimeOverride ?? new Date();
                // Defensive: prefillTimeOverride should always be a Date, but
                // a stale HMR closure or a future caller can land here with a
                // non-Date value. Coerce so .getTime() is safe and the modal
                // opens instead of crashing the React tree.
                const now = nowRaw instanceof Date
                    ? nowRaw
                    : new Date(nowRaw ?? Date.now());
                const iso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
                setDateStr(iso);

                if (prefillFromPlan) {
                    // Plan-driven prefill: route + ester + dose come from the
                    // matched plan, and any route-specific extras (gel site,
                    // sublingual tier, patch rate, etc.) flow into the same
                    // per-route fields the manual-entry path uses.
                    const p = prefillFromPlan;
                    setRoute(p.route);
                    setEster(p.ester);
                    const factor = getToE2Factor(p.ester) || 1;
                    if (p.ester === Ester.E2) {
                        setE2Dose((p.doseMG).toFixed(3));
                        setRawDose((p.doseMG).toFixed(3));
                        setLastEditedField('bio');
                    } else {
                        setRawDose(p.doseMG.toFixed(3));
                        setE2Dose((p.doseMG * factor).toFixed(3));
                        setLastEditedField('raw');
                    }
                    // Quick-dose panel: open manual entry when the dose isn't
                    // a preset, mirroring the edit-record branch above.
                    setUseCustomDose(
                        hasQuickDosePanel(p.route, p.ester) &&
                        !isPresetDose(p.route, p.ester, p.doseMG)
                    );
                    if (p.route === Route.sublingual) {
                        const tier = p.extras[ExtraKey.sublingualTier];
                        const theta = p.extras[ExtraKey.sublingualTheta];
                        if (typeof tier === 'number') {
                            setSlTier(tier);
                            setUseCustomTheta(false);
                            setCustomTheta('');
                        } else if (typeof theta === 'number') {
                            setUseCustomTheta(true);
                            setCustomTheta(theta.toString());
                        } else {
                            setSlTier(2);
                            setUseCustomTheta(false);
                            setCustomTheta('');
                        }
                    } else {
                        setUseCustomTheta(false);
                        setCustomTheta('');
                    }
                    if (p.route === Route.gel) {
                        setGelSite(p.extras[ExtraKey.gelSite] ?? 0);
                        setGelProductId(p.extras[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
                        const area = p.extras[ExtraKey.areaCM2];
                        setGelArea(typeof area === 'number' && area > 0 ? String(area) : '');
                        const cov = p.extras[ExtraKey.gelCoverage];
                        setGelCoverage(typeof cov === 'number' && Number.isFinite(cov) ? Math.round(cov) : GEL_COVERAGE_DEFAULT_IDX);
                        const coApp = p.extras[ExtraKey.gelCoApplied];
                        setGelCoApplied(typeof coApp === 'number' && Number.isFinite(coApp) ? Math.round(coApp) : 0);
                        const wash = p.extras[ExtraKey.gelWashAfterH];
                        setGelWash(typeof wash === 'number' && wash > 0 ? String(wash) : '');
                    }
                    if (p.route === Route.patchApply && p.extras[ExtraKey.releaseRateUGPerDay]) {
                        setPatchMode('rate');
                        setPatchRate(p.extras[ExtraKey.releaseRateUGPerDay].toString());
                        setE2Dose('');
                        setRawDose('');
                        setLastEditedField('bio');
                    } else {
                        setPatchMode('dose');
                        setPatchRate('');
                    }
                    // New records start with no scheduled remove time; the
                    // user can opt in by typing one in the "摘下时间" field.
                    setRemoveTimeStr('');
                } else {
                    // Land on the last drug used (sublingual + estradiol valerate as
                    // the cold-start default). The per-drug dose memory restore is
                    // handled by the dedicated effect below, keyed on route/ester.
                    const last = readLastDrug();
                    const initRoute: Route = last?.route ?? Route.sublingual;
                    const initEster: Ester = last?.ester ?? Ester.EV;

                    setRoute(initRoute);
                    setEster(initEster);
                    setPatchMode('dose');
                    setPatchRate('');
                    setGelSite(0);
                    setGelCoverage(GEL_COVERAGE_DEFAULT_IDX);
                    setGelCoApplied(0);
                    setRemoveTimeStr('');
                    // patchMode/patchRate + dose fields are restored per-drug by the
                    // dedicated effect below (keyed on route/ester).
                }
                setWeightStr(prefillWeightKG(allEvents).toString());
            }
        }
    }, [isOpen, eventToEdit, prefillFromPlan, prefillTimeOverride]);

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
            if (!isPresetDose(route, activeEster, current)) {
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

    // Pre-fill the gel product / site / area / wash from the most recent gel
    // administration (read straight from the saved events JSON), so re-entering a
    // gel dose starts from "what I used last time". New-record mode only; the
    // dose itself is restored by the per-drug memo effect above ('gel:E2').
    const gelPrefilledRef = useRef(false);
    useEffect(() => {
        if (!isOpen || eventToEdit || route !== Route.gel) {
            if (!isOpen || route !== Route.gel) gelPrefilledRef.current = false;
            return;
        }
        if (gelPrefilledRef.current) return;
        gelPrefilledRef.current = true;
        const last = readLastGelEvent(allEvents);
        if (last) {
            // Prefill the last product verbatim. If it was deleted, the selector's
            // "missing product" warning prompts a re-pick — we don't auto-reset
            // here (that misfired during the cloud-sync race and dragged the old
            // application area onto the default product).
            setGelProductId(last.productId);
            setGelSite(last.gelSite);
            const prod = findGelProduct(last.productId);
            setGelArea(last.areaCM2 > 0 ? String(last.areaCM2) : String(prod.defaultAreaCM2));
            // A legacy last-gel (coverage -1) reuses its raw area as "manual".
            setGelCoverage(last.coverage >= 0 ? last.coverage : GEL_COVERAGE_MANUAL_IDX);
            setGelCoApplied(last.coApplied > 0 ? last.coApplied : 0);
            setGelWash(last.washAfterH > 0 ? String(last.washAfterH) : "");
        } else {
            setGelProductId(GEL_DEFAULT_PRODUCT_ID);
            setGelSite(0);
            setGelArea(String(GEL_PRODUCTS[0].defaultAreaCM2));
            setGelCoverage(GEL_COVERAGE_DEFAULT_IDX);
            setGelCoApplied(0);
            setGelWash("");
        }
    }, [isOpen, eventToEdit, route, allEvents]);

    // Keep the manual-area field meaningful when the product changes: re-derive it
    // from the current coverage template (product default for the "label" coverage).
    const handleGelProductSelect = (val: string) => {
        const id = parseInt(val, 10);
        if (!Number.isFinite(id)) return;
        setGelProductId(id);
        const manual = parseFloat(gelArea);
        setGelArea(String(resolveGelCoverageArea(gelCoverage, findGelProduct(id), manual)));
    };

    // Switching coverage template back-derives the application area (except for the
    // manual template, where the user keeps typing a raw cm²).
    const handleGelCoverageSelect = (val: string) => {
        const idx = parseInt(val, 10) || 0;
        setGelCoverage(idx);
        const tpl = GEL_COVERAGE_TEMPLATES[idx];
        if (tpl && tpl.kind !== 'manual') {
            setGelArea(String(resolveGelCoverageArea(idx, findGelProduct(gelProductId), parseFloat(gelArea))));
        }
    };

    // Human label for a coverage option, with the resolved cm² for non-manual ones.
    const gelCoverageLabel = (tpl: typeof GEL_COVERAGE_TEMPLATES[number], idx: number): string => {
        const base = t(`gel.coverage.${tpl.key}`);
        if (tpl.kind === 'manual') return base;
        const area = Math.round(resolveGelCoverageArea(idx, findGelProduct(gelProductId), 0));
        return `${base} (~${area} cm²)`;
    };

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
        setUseCustomDose(hasQuickDosePanel(tpl.route, tpl.ester) && !isPresetDose(tpl.route, tpl.ester, tplDose));
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
        // (Route.patchRemove is no longer reachable from the route selector —
        // paired patch saves go through the onSavePatch branch below.)
        const effectiveEster =
            (route === Route.patchApply || route === Route.gel)
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
        } else {
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
            // Store only the product reference + per-application site/area/wash;
            // kinetics resolve from the registry at simulation time. buildGelExtras
            // persists the SELECTED product id verbatim (never a fallback). The area
            // is derived from the coverage template (manual cm² only for the manual
            // template), so the engine still consumes a plain `areaCM2`.
            // Persist a STABLE area: fixed templates store their constant; manual
            // stores the typed value; the "product" template and scrotal store NO area
            // so the engine follows the product's current default (no silent rewrite
            // of an old event when a custom product's default later changes).
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
        }

        const parsedWeight = parseFloat(weightStr);
        const weightKG = (Number.isFinite(parsedWeight) && parsedWeight > 0)
            ? parsedWeight
            : prefillWeightKG(allEvents);

        // ── Paired save for "贴片" with an optional remove time ─────────────
        // When the user filled in the optional "摘下时间" field on a patch
        // record, emit TWO events sharing a fresh companionGroupId. The
        // /history list uses that id to render a single "贴片" card and hide
        // the "贴片移除" button on the apply side. Without a remove time we
        // fall back to a plain single-event save so existing behavior
        // (PK engine time-axis pairing) is preserved for legacy callers.
        if (route === Route.patchApply && removeTimeStr.trim() !== '' && onSavePatch) {
            const removeTimeMs = new Date(removeTimeStr).getTime();
            if (isNaN(removeTimeMs)) {
                showDialog('alert', t('error.invalidDate') || t('error.nonPositive'));
                setIsSaving(false);
                return;
            }
            const removeTimeH = removeTimeMs / 3600000;
            if (removeTimeH <= timeH) {
                // Remove must be strictly after apply; show a localized
                // validation message.
                showDialog('alert', t('error.patch_remove_before_apply') || t('error.nonPositive'));
                setIsSaving(false);
                return;
            }
            const groupId = uuidv4();
            const applyEvent: DoseEvent = {
                id: eventToEdit?.id || uuidv4(),
                route: Route.patchApply,
                ester: Ester.E2,
                timeH,
                doseMG: finalDose,
                weightKG,
                extras,
                companionGroupId: groupId,
            };
            const removeEvent: DoseEvent = {
                id: uuidv4(),
                route: Route.patchRemove,
                ester: Ester.E2,
                timeH: removeTimeH,
                doseMG: 0,
                weightKG,
                extras: {},
                companionGroupId: groupId,
            };
            if (!eventToEdit) {
                writeDoseMemo(Route.patchApply, Ester.E2, {
                    rawDose, e2Dose,
                    patchMode, patchRate,
                    slTier, useCustomTheta, customTheta,
                    customDose: useCustomDose,
                });
            }
            onSavePatch(applyEvent, removeEvent);
            setIsSaving(false);
            onClose();
            return;
        }

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

    // The "摘下时间" field is only meaningful on the "贴片" entry. Switching
    // away from Route.patchApply must wipe it so the next save can't
    // accidentally write a paired event for a non-patch route.
    useEffect(() => {
        if (route !== Route.patchApply && removeTimeStr !== '') {
            setRemoveTimeStr('');
        }
    }, [route, removeTimeStr]);

    // Mirror handleSave's safeEster so UI gating (canGenerate/doseGuide) and
    // data write paths read the same value even mid-route-transition.
    const safeEster = availableEsters.includes(ester) ? ester : availableEsters[0];

    const doseGuide = useMemo(
        () => computeDoseGuide(route, safeEster, isAntiandrogen, patchMode, patchRate, e2Dose),
        [route, safeEster, patchMode, patchRate, e2Dose],
    );

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

                    {/* (Route.patchRemove is no longer selectable from the route
                     *  dropdown — paired patch saves go through the unified
                     *  "贴片" entry, so the old "贴片移除"-only banner is dead.) */}

                    {route !== Route.patchRemove && (
                        <>
                            {/* Ester Selection — ALWAYS rendered (even when
                             *  the route has only one valid compound, e.g.
                             *  Route.rectal → [PROG]) so the user can SEE that
                             *  "药物类型" is a deliberate, fixed choice and not
                             *  a missing form control. The CustomSelect renders
                             *  fine with a single option; on the few routes
                             *  where the list could legitimately be empty we
                             *  still fall through (length >= 1 only — never 0).
                             */}
                            {availableEsters.length >= 1 && (
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

                            {/* Estradiol undecylate is easily confused with valerate and rests on
                                sparse public PK; surface that caveat at selection time. */}
                            {route === Route.injection && ester === Ester.EU && (
                                <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                    {t('ester.EU_note')}
                                </div>
                            )}

                            {/* Gel: product + site + area + wash */}
                            {route === Route.gel && (
                                <div className="mb-4 space-y-3">
                                    {/* Product selector (custom products are managed in Settings) */}
                                    <CustomSelect
                                        label={t('field.gel_product')}
                                        value={String(gelProductId)}
                                        onChange={handleGelProductSelect}
                                        options={[
                                            // Surface a missing/deleted product so editing an old record
                                            // doesn't silently masquerade as the default gel.
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

                                    {/* Site selector (display order: arm, thigh, abdomen, scrotal) */}
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

                                    {/* Application coverage (area is derived from a body-surface
                                        template so users don't guess a raw cm²). Hidden for
                                        scrotal: genital uptake is area-invariant, so there is
                                        nothing meaningful to enter — the scrotal note explains it. */}
                                    {GEL_SITE_ORDER[gelSite] !== GelSite.scrotal && (<>
                                        <CustomSelect
                                            label={t('field.gel_coverage')}
                                            value={String(gelCoverage)}
                                            onChange={handleGelCoverageSelect}
                                            options={GEL_COVERAGE_TEMPLATES.map((tpl, idx) => ({
                                                value: String(idx),
                                                label: gelCoverageLabel(tpl, idx),
                                            }))}
                                        />
                                        {GEL_COVERAGE_TEMPLATES[gelCoverage]?.kind === 'manual' ? (
                                            <div className="space-y-1">
                                                <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{t('field.gel_area')}</label>
                                                <input value={gelArea} onChange={e => setGelArea(e.target.value)} inputMode="decimal" placeholder={String(findGelProduct(gelProductId).defaultAreaCM2)} className="w-full p-3 rounded-xl glass-input outline-none" />
                                            </div>
                                        ) : (
                                            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                {t('gel.coverage.derived')}: ~{Math.round(resolveGelCoverageArea(gelCoverage, findGelProduct(gelProductId), 0))} cm²
                                            </div>
                                        )}
                                    </>)}

                                    {/* Co-applied topical product (sunscreen / moisturizer) */}
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

                                    {/* Optional wash-off */}
                                    <div className="space-y-1">
                                        <label className="block text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{t('field.gel_wash')}</label>
                                        <input value={gelWash} onChange={e => setGelWash(e.target.value)} inputMode="decimal" placeholder={t('gel.wash_none')} className="w-full p-3 rounded-xl glass-input outline-none" />
                                    </div>

                                    <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
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
                                    <div className="text-xs text-[var(--text-soft-amber)] bg-[var(--bg-soft-amber)] border border-[var(--border-soft-amber)] p-3 rounded-xl">
                                        {t('beta.patch')}
                                    </div>
                                </div>
                            )}

                            {/* Dose Inputs */}
                            {(route !== Route.patchApply || patchMode === "dose") && (
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

                            {/* Patch: optional 摘下时间 (remove time).
                             *
                             * Saving a "贴片" record with this field set writes TWO
                             * events (apply + remove) sharing a companionGroupId so
                             * the /history list can render them as a single record
                             * and the "贴片移除" button on the apply card vanishes
                             * once the remove is logged. Leave it blank to fall back
                             * to a plain single-event save (the "贴片移除" button on
                             * /history is the escape hatch for late removal). The
                             * handleSave validator enforces removeTime > applyTime. */}
                            {route === Route.patchApply && (
                                <div className="space-y-2">
                                    <label className="block text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('field.patch_remove_time')}
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="datetime-local"
                                            value={removeTimeStr}
                                            onChange={e => setRemoveTimeStr(e.target.value)}
                                            className="flex-1 p-3 rounded-xl text-base font-mono outline-none focus:ring-2 focus:ring-[var(--accent-300)]"
                                            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                            placeholder={t('field.patch_remove_time_placeholder') || ''}
                                        />
                                        {removeTimeStr !== '' && (
                                            <button
                                                type="button"
                                                onClick={() => setRemoveTimeStr('')}
                                                aria-label={t('btn.clear') || t('btn.close')}
                                                className="p-2 rounded-lg"
                                                style={{ background: 'var(--bg-card-hover)', color: 'var(--text-secondary)' }}
                                            >
                                                <X size={16} />
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('hint.patch_remove_time')}
                                    </p>
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
                                            <p className="text-xs text-[var(--text-soft-amber)] leading-relaxed">
                                                {t('dose.guide.patch_rate_hint')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Sublingual Specifics */}
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
                                                <span>Absorption θ ≈ {currentTheta.toFixed(2)}</span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <input type="number" step="0.01" max="1" min="0" value={customTheta} onChange={e => setCustomTheta(e.target.value)} className="w-full p-3 border border-[var(--border-med-teal)] rounded-xl focus:ring-2 focus:ring-teal-500 outline-none" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }} placeholder="0.0 - 1.0" />
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
                                        style={{ border: '1px solid var(--border-soft-rose)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
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
                                ? { background: 'var(--bg-soft-rose)', borderColor: 'var(--border-soft-rose)', color: 'var(--accent-400)' }
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
