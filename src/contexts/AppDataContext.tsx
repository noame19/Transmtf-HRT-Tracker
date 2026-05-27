import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode, useRef, useCallback } from 'react';
import {
    DoseEvent, LabResult, SimulationResult,
    PersonalModelState, EKFDiagnostics, CalibrationModel,
    runSimulation, createCalibrationInterpolator,
    replayPersonalModel, computeSimulationWithCI, initPersonalModel,
    ekfUpdatePersonalModel,
} from '../../logic';
import { computeDataHash } from '../utils/dataHash';
import { backfillEventWeights, eventsNeedWeightMigration, latestEventWeight, DEFAULT_WEIGHT_KG } from '../utils/weight';

const PERSONAL_MODEL_KEY = 'hrt-personal-model';
const APPLY_E2_LEARNING_TO_CPA_KEY = 'hrt-apply-e2-learning-to-cpa';
const CALIBRATION_MODEL_KEY = 'hrt-calibration-model';
const APPLY_CPA_INHIBITION_TO_E2_KEY = 'hrt-apply-cpa-inhibition-to-e2';
const THEME_COLOR_KEY = 'hrt-theme-color';
const DARK_MODE_KEY = 'hrt-dark-mode';
const WEIGHT_MIGRATION_FLAG = 'hrt-weight-per-dose-migrated';
const LEGACY_WEIGHT_KEY = 'hrt-weight';

export const PER_DOSE_WEIGHT_MIGRATION_EVENT = 'hrt-per-dose-weight-migrated';

interface SimCI {
    timeH: number[];
    e2Adjusted: number[];
    ci95Low: number[];
    ci95High: number[];
    ci68Low: number[];
    ci68High: number[];
    cpaAdjusted: number[];
    cpaCi95Low: number[];
    cpaCi95High: number[];
}

interface AppDataContextType {
    events: DoseEvent[];
    setEvents: React.Dispatch<React.SetStateAction<DoseEvent[]>>;
    labResults: LabResult[];
    setLabResults: React.Dispatch<React.SetStateAction<LabResult[]>>;
    simulation: SimulationResult | null;
    calibrationFn: (h: number) => number;
    currentTime: Date;
    personalModel: PersonalModelState | null;
    simCI: SimCI | null;
    lastDiagnostics: EKFDiagnostics | null;
    applyE2LearningToCPA: boolean;
    setApplyE2LearningToCPA: React.Dispatch<React.SetStateAction<boolean>>;
    applyCPAInhibitionToE2: boolean;
    setApplyCPAInhibitionToE2: React.Dispatch<React.SetStateAction<boolean>>;
    calibrationModel: CalibrationModel;
    setCalibrationModel: React.Dispatch<React.SetStateAction<CalibrationModel>>;
    resetPersonalModel: () => void;
    /**
     * Endogenous baseline E2 in pg/mL derived from pre-dose lab results.
     * Non-null when the personal model has accumulated at least one pre-dose
     * observation. Used to offset the simulated curve even before any post-dose
     * data is available.
     */
    baselineE2PGmL: number | null;
}

const AppDataContext = createContext<AppDataContextType | undefined>(undefined);

function loadPersonalModel(): PersonalModelState | null {
    try {
        const raw = localStorage.getItem(PERSONAL_MODEL_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // Validate shape AND value ranges before trusting stored data.
        // Theta values outside ±4 (log-space) indicate a corrupted/stale model;
        // reject and let the replay effect recompute from lab results.
        if (
            parsed?.modelVersion === 'pk-ekf-v1' &&
            Array.isArray(parsed.thetaMean) && parsed.thetaMean.length === 2 &&
            typeof parsed.thetaMean[0] === 'number' && Math.abs(parsed.thetaMean[0]) <= 4 &&
            typeof parsed.thetaMean[1] === 'number' && Math.abs(parsed.thetaMean[1]) <= 4 &&
            Array.isArray(parsed.thetaCov) && parsed.thetaCov.length === 2 &&
            typeof parsed.Rlog === 'number' &&
            typeof parsed.observationCount === 'number' &&
            Array.isArray(parsed.anchors)
        ) {
            // Backward-compat: old stored models lack postDoseObservationCount.
            // Fall back to observationCount so existing calibrated models keep
            // their CI bands rather than silently resetting to uncalibrated state.
            if (typeof parsed.postDoseObservationCount !== 'number') {
                parsed.postDoseObservationCount = parsed.observationCount;
            }
            return parsed as PersonalModelState;
        }
    } catch { /* ignore */ }
    return null;
}

function savePersonalModel(state: PersonalModelState | null) {
    if (state) {
        localStorage.setItem(PERSONAL_MODEL_KEY, JSON.stringify(state));
    } else {
        localStorage.removeItem(PERSONAL_MODEL_KEY);
    }
}

export const AppDataProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [events, setEvents] = useState<DoseEvent[]>(() => {
        const saved = localStorage.getItem('hrt-events');
        const parsed: DoseEvent[] = saved ? JSON.parse(saved) : [];
        // One-shot per-dose-weight migration: backfill events that predate the
        // schema change so every PK call has a real weight to work with.
        if (eventsNeedWeightMigration(parsed)) {
            const legacyRaw = localStorage.getItem(LEGACY_WEIGHT_KEY);
            const legacyW = legacyRaw ? parseFloat(legacyRaw) : DEFAULT_WEIGHT_KG;
            const migrated = backfillEventWeights(parsed, legacyW);
            localStorage.setItem('hrt-events', JSON.stringify(migrated));
            if (!localStorage.getItem(WEIGHT_MIGRATION_FLAG)) {
                localStorage.setItem(WEIGHT_MIGRATION_FLAG, '1');
                // Defer dispatch until after the provider mounts so listeners exist.
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent(PER_DOSE_WEIGHT_MIGRATION_EVENT));
                }, 0);
            }
            return migrated;
        }
        return parsed;
    });

    const [labResults, setLabResults] = useState<LabResult[]>(() => {
        const saved = localStorage.getItem('hrt-lab-results');
        return saved ? JSON.parse(saved) : [];
    });

    const [simulation, setSimulation] = useState<SimulationResult | null>(null);
    const [currentTime, setCurrentTime] = useState(new Date());
    const [personalModel, setPersonalModel] = useState<PersonalModelState | null>(loadPersonalModel);
    const [simCI, setSimCI] = useState<SimCI | null>(null);
    const [lastDiagnostics, setLastDiagnostics] = useState<EKFDiagnostics | null>(null);
    const [applyE2LearningToCPA, setApplyE2LearningToCPA] = useState<boolean>(() => {
        const raw = localStorage.getItem(APPLY_E2_LEARNING_TO_CPA_KEY);
        if (raw === null) return false;
        return raw === '1' || raw.toLowerCase() === 'true';
    });
    const [calibrationModel, setCalibrationModel] = useState<CalibrationModel>(() => {
        const raw = localStorage.getItem(CALIBRATION_MODEL_KEY);
        return (raw === 'ou-kalman') ? 'ou-kalman' : 'ekf';
    });
    const [applyCPAInhibitionToE2, setApplyCPAInhibitionToE2] = useState<boolean>(() => {
        const raw = localStorage.getItem(APPLY_CPA_INHIBITION_TO_E2_KEY);
        if (raw === null) return false;
        return raw === '1' || raw.toLowerCase() === 'true';
    });

    const suppressLocalUpdateRef = useRef({
        events: false,
        labResults: false,
        calibrationModel: false,
        applyE2LearningToCPA: false,
        applyCPAInhibitionToE2: false,
    });
    const isInitialLoadRef = useRef({
        events: true,
        labResults: true,
        calibrationModel: true,
        applyE2LearningToCPA: true,
        applyCPAInhibitionToE2: true,
    });

    const markExternalUpdate = (key: keyof typeof suppressLocalUpdateRef.current) => {
        suppressLocalUpdateRef.current[key] = true;
    };

    const finalizeLocalUpdate = (key: keyof typeof suppressLocalUpdateRef.current, updateKey: string) => {
        if (suppressLocalUpdateRef.current[key]) {
            suppressLocalUpdateRef.current[key] = false;
            return;
        }
        if (isInitialLoadRef.current[key]) {
            isInitialLoadRef.current[key] = false;
            return;
        }
        const lastModified = new Date().toISOString();
        localStorage.setItem('hrt-last-modified', lastModified);
        localStorage.setItem('hrt-last-data-updated', lastModified);
        window.dispatchEvent(new CustomEvent('hrt-local-data-updated', { detail: { key: updateKey, lastModified } }));
    };

    // Persist to localStorage
    useEffect(() => {
        const value = JSON.stringify(events);
        localStorage.setItem('hrt-events', value);
        // Legacy compat: keep top-level weight in sync with most recent event
        // so older clients / cloud snapshots still see a meaningful value.
        // Guard on events.length > 0 so a user who set a global weight before
        // recording any doses doesn't lose it the first time this effect runs.
        if (events.length > 0) {
            localStorage.setItem(LEGACY_WEIGHT_KEY, latestEventWeight(events).toString());
        }
        finalizeLocalUpdate('events', 'hrt-events');
    }, [events]);
    useEffect(() => {
        const value = JSON.stringify(labResults);
        localStorage.setItem('hrt-lab-results', value);
        finalizeLocalUpdate('labResults', 'hrt-lab-results');
    }, [labResults]);
    useEffect(() => {
        localStorage.setItem(APPLY_E2_LEARNING_TO_CPA_KEY, applyE2LearningToCPA ? '1' : '0');
        finalizeLocalUpdate('applyE2LearningToCPA', APPLY_E2_LEARNING_TO_CPA_KEY);
    }, [applyE2LearningToCPA]);
    useEffect(() => {
        localStorage.setItem(APPLY_CPA_INHIBITION_TO_E2_KEY, applyCPAInhibitionToE2 ? '1' : '0');
        finalizeLocalUpdate('applyCPAInhibitionToE2', APPLY_CPA_INHIBITION_TO_E2_KEY);
    }, [applyCPAInhibitionToE2]);
    useEffect(() => {
        localStorage.setItem(CALIBRATION_MODEL_KEY, calibrationModel);
        finalizeLocalUpdate('calibrationModel', CALIBRATION_MODEL_KEY);
    }, [calibrationModel]);

    useEffect(() => {
        const lang = localStorage.getItem('hrt-lang') || 'en';
        const themeColor = localStorage.getItem('hrt-theme-color') || 'sakura';
        const darkModeRaw = localStorage.getItem('hrt-dark-mode');
        const darkMode = darkModeRaw === '1' || darkModeRaw === 'true';
        const hash = computeDataHash({ events, weight: latestEventWeight(events), labResults, lang, calibrationModel, applyE2LearningToCPA, applyCPAInhibitionToE2, themeColor, darkMode });
        localStorage.setItem('hrt-data-hash', hash);
    }, [events, labResults, calibrationModel, applyE2LearningToCPA, applyCPAInhibitionToE2]);

    // Update current time every minute
    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const handleStorageChange = (e: StorageEvent) => {
            const syncKeys = ['hrt-events', 'hrt-lab-results', 'hrt-calibration-model', APPLY_E2_LEARNING_TO_CPA_KEY, APPLY_CPA_INHIBITION_TO_E2_KEY, THEME_COLOR_KEY, DARK_MODE_KEY];
            const isCloudSync = e.key === 'hrt-data-synced';
            const isOtherTabSync = e.storageArea === localStorage && e.key && syncKeys.includes(e.key);
            if (!isCloudSync && !isOtherTabSync) {
                return;
            }

            if (e.key === 'hrt-events' || isCloudSync) {
                if (isCloudSync || isOtherTabSync) {
                    markExternalUpdate('events');
                }
                const saved = localStorage.getItem('hrt-events');
                const parsed: DoseEvent[] = saved ? JSON.parse(saved) : [];
                if (eventsNeedWeightMigration(parsed)) {
                    const legacyRaw = localStorage.getItem(LEGACY_WEIGHT_KEY);
                    const legacyW = legacyRaw ? parseFloat(legacyRaw) : DEFAULT_WEIGHT_KG;
                    const migrated = backfillEventWeights(parsed, legacyW);
                    setEvents(migrated);
                } else {
                    setEvents(parsed);
                }
            }

            if (e.key === 'hrt-lab-results' || isCloudSync) {
                if (isCloudSync || isOtherTabSync) {
                    markExternalUpdate('labResults');
                }
                const saved = localStorage.getItem('hrt-lab-results');
                setLabResults(saved ? JSON.parse(saved) : []);
            }

            if (e.key === 'hrt-calibration-model' && isOtherTabSync) {
                markExternalUpdate('calibrationModel');
                const saved = localStorage.getItem(CALIBRATION_MODEL_KEY);
                if (saved === 'ou-kalman' || saved === 'ekf') {
                    setCalibrationModel(saved);
                }
            }

            if (e.key === APPLY_E2_LEARNING_TO_CPA_KEY && isOtherTabSync) {
                markExternalUpdate('applyE2LearningToCPA');
                const saved = localStorage.getItem(APPLY_E2_LEARNING_TO_CPA_KEY);
                if (saved !== null) setApplyE2LearningToCPA(saved === '1' || saved.toLowerCase() === 'true');
            }

            if (e.key === APPLY_CPA_INHIBITION_TO_E2_KEY && isOtherTabSync) {
                markExternalUpdate('applyCPAInhibitionToE2');
                const saved = localStorage.getItem(APPLY_CPA_INHIBITION_TO_E2_KEY);
                if (saved !== null) setApplyCPAInhibitionToE2(saved === '1' || saved.toLowerCase() === 'true');
            }

            if (isCloudSync) {
                markExternalUpdate('calibrationModel');
                const saved = localStorage.getItem(CALIBRATION_MODEL_KEY);
                if (saved === 'ou-kalman' || saved === 'ekf') {
                    setCalibrationModel(saved);
                }
                markExternalUpdate('applyE2LearningToCPA');
                const savedE2 = localStorage.getItem(APPLY_E2_LEARNING_TO_CPA_KEY);
                if (savedE2 !== null) setApplyE2LearningToCPA(savedE2 === '1' || savedE2.toLowerCase() === 'true');
                markExternalUpdate('applyCPAInhibitionToE2');
                const savedCPA = localStorage.getItem(APPLY_CPA_INHIBITION_TO_E2_KEY);
                if (savedCPA !== null) setApplyCPAInhibitionToE2(savedCPA === '1' || savedCPA.toLowerCase() === 'true');

                // Notify ThemeContext about cloud-synced theme/dark mode changes
                const savedTheme = localStorage.getItem(THEME_COLOR_KEY);
                if (savedTheme) {
                    window.dispatchEvent(new StorageEvent('storage', {
                        key: THEME_COLOR_KEY,
                        newValue: savedTheme,
                        storageArea: localStorage,
                    }));
                }
                const savedDark = localStorage.getItem(DARK_MODE_KEY);
                if (savedDark !== null) {
                    window.dispatchEvent(new StorageEvent('storage', {
                        key: DARK_MODE_KEY,
                        newValue: savedDark,
                        storageArea: localStorage,
                    }));
                }
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);

    // Run simulation when events change (per-event weight is read from events).
    useEffect(() => {
        if (events.length > 0) {
            const res = runSimulation(events);
            setSimulation(res);
        } else {
            setSimulation(null);
        }
    }, [events]);

    // Rebuild personal model whenever events or labResults change.
    useEffect(() => {
        if (labResults.length === 0) {
            setPersonalModel(null);
            setLastDiagnostics(null);
            setSimCI(null);
            savePersonalModel(null);
            return;
        }

        // Replay EKF from the prior using all sorted lab results
        const newModel = replayPersonalModel(events, labResults);

        // Derive last diagnostics from the most recent lab point
        const sorted = [...labResults].sort((a, b) => a.timeH - b.timeH);
        const lastLab = sorted[sorted.length - 1];

        // Build prior state (n-1 replayed) to get the update diagnostics
        const priorModel = labResults.length > 1
            ? replayPersonalModel(events, sorted.slice(0, -1))
            : initPersonalModel();

        const { diagnostics } = ekfUpdatePersonalModel(
            events, priorModel, lastLab,
            labResults.length > 1 ? sorted[sorted.length - 2].timeH : undefined
        );
        setLastDiagnostics(diagnostics);

        setPersonalModel(newModel);
        savePersonalModel(newModel);
    }, [events, labResults]);

    // Recompute CI bands whenever relevant state changes.
    // CI bands require at least one post-dose lab result — pre-dose labs only
    // provide a baseline offset and carry no PK parameter information.
    useEffect(() => {
        if (!simulation || !personalModel || personalModel.postDoseObservationCount === 0 || labResults.length === 0) {
            setSimCI(null);
            return;
        }
        const ci = computeSimulationWithCI(simulation, events, personalModel, applyE2LearningToCPA, labResults, calibrationModel, applyCPAInhibitionToE2);
        setSimCI(ci);
    }, [simulation, personalModel, events, applyE2LearningToCPA, labResults, calibrationModel, applyCPAInhibitionToE2]);

    // Expose baseline from pre-dose labs so UI can offset the raw sim curve
    // even when no post-dose learning has occurred yet.
    const baselineE2PGmL = useMemo<number | null>(() => {
        if (!personalModel) return null;
        const v = personalModel.baselinePGmL;
        if (v === undefined || !Number.isFinite(v) || v <= 0) return null;
        return v;
    }, [personalModel]);

    // Create calibration function (legacy ratio-based, still used for current-scale display)
    const calibrationFn = useMemo(() => {
        return createCalibrationInterpolator(simulation, labResults);
    }, [simulation, labResults]);

    const resetPersonalModel = useCallback(() => {
        setPersonalModel(null);
        setLastDiagnostics(null);
        setSimCI(null);
        savePersonalModel(null);
    }, []);

    const value = {
        events,
        setEvents,
        labResults,
        setLabResults,
        simulation,
        calibrationFn,
        currentTime,
        personalModel,
        simCI,
        lastDiagnostics,
        applyE2LearningToCPA,
        setApplyE2LearningToCPA,
        applyCPAInhibitionToE2,
        setApplyCPAInhibitionToE2,
        calibrationModel,
        setCalibrationModel,
        resetPersonalModel,
        baselineE2PGmL,
    };

    return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
};

export const useAppData = () => {
    const context = useContext(AppDataContext);
    if (context === undefined) {
        throw new Error('useAppData must be used within an AppDataProvider');
    }
    return context;
};
