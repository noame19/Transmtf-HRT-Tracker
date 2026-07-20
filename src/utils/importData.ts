/**
 * Pure parsing/merge logic for the Settings "import JSON" flow, extracted from
 * the React component so it can be unit-tested in the node environment.
 *
 * Schema version is read from `meta.version`. v2 (the original export shape)
 * continues to flow through the legacy parser so any backup made by older
 * builds still imports losslessly. v3 adds prefs / calibration / plans /
 * reminderLog so a clean install can fully reconstruct the user's setup.
 *
 * Key rule shared by both versions: a section that is ABSENT from the file
 * is returned as `null` ("keep the existing data"); a section present but
 * EMPTY (`labResults: []`, `gelProducts: []`) is returned as `[]`
 * ("clear it").
 */
import { v4 as uuidv4 } from 'uuid';
import { Ester, Route, type DoseEvent, type LabResult, type Plan, type PlanExtras } from '../../types';
import { sanitizeGelProducts, type GelProductSpec } from '../../pk';
import {
    BACKUP_SCHEMA_VERSION_V2,
    BACKUP_SCHEMA_VERSION_V3,
    type DueLogEntry,
    type PostponeLogEntry,
} from '../contexts/AppDataContext';

// ─────────────────────────────────────────────────────────────────────────────
// Public types — what the Settings page consumes after parsing.
// ─────────────────────────────────────────────────────────────────────────────

/** Compact bundle of user-facing prefs that live OUTSIDE dose / lab / gel
 *  history. Absent fields fall back to whatever the user already has set on
 *  the device, so a partial v3 backup still imports cleanly. */
export interface UserPrefsBackup {
    lang?: string;            // 'zh' | 'zh-TW' | 'en' | 'ja' — validated below
    themeColor?: string;
    darkMode?: boolean;
    remindersEnabled?: boolean;
}

/** Calibration knobs that drive the personalised curve. Defaults land
 *  somewhere safe for users who never touched the toggle. */
export interface CalibrationBackup {
    model?: 'ekf' | 'ou-kalman' | 'hybrid-mipd';
    mode?: 'retrospective' | 'causal';
    applyE2LearningToCPA?: boolean;
    applyCPAInhibitionToE2?: boolean;
}

export interface ParsedImport {
    /** Recognized events array — [] when the file carried no events. */
    events: DoseEvent[];
    labResults: LabResult[] | null;            // null = section absent → keep existing
    gelProducts: GelProductSpec[] | null;
    plans: Plan[] | null;
    postponeLog: PostponeLogEntry[] | null;
    dueLog: DueLogEntry[] | null;
    prefs: UserPrefsBackup | null;
    calibration: CalibrationBackup | null;
    migratedCount: number;
    /** Schema version actually detected in the file, so the importer knows
     *  whether to apply the v3-specific sections. */
    schemaVersion: typeof BACKUP_SCHEMA_VERSION_V2 | typeof BACKUP_SCHEMA_VERSION_V3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | null => {
    const next = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(next) ? next : null;
};

const isRoute = (value: unknown): value is Route =>
    typeof value === 'string' && (Object.values(Route) as string[]).includes(value);

const isEster = (value: unknown): value is Ester =>
    typeof value === 'string' && (Object.values(Ester) as string[]).includes(value);

/** Allowlist of every user-facing UI/translation we explicitly support.
 *  Any other string would silently break `t()` lookups down the line. */
const VALID_LANGS = ['zh', 'zh-TW', 'en', 'ja'] as const;
const VALID_THEMES = [
    'sakura', 'ocean', 'lavender', 'mint', 'sunset',
    'berry', 'coral', 'sky', 'rose', 'teal',
] as const;
const VALID_CALIBRATION_MODELS = ['ekf', 'ou-kalman', 'hybrid-mipd'] as const;
const VALID_CALIBRATION_MODES = ['retrospective', 'causal'] as const;

/** Strict Wall-clock HH:MM validation — used by every schedule `times` slot
 *  in a Plan so a corrupted backup can't smuggle nonsense into AlarmManager. */
const isHHmm = (value: unknown): value is string =>
    typeof value === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value);

const isPlanSchedule = (value: unknown): value is Plan['schedule'] => {
    if (!isRecord(value)) return false;
    const times = (value as { times?: unknown }).times;
    const timesOk = Array.isArray(times) && times.length > 0 && times.every(isHHmm);
    if (!timesOk) return false;
    if (value.kind === 'daily') return true;
    if (value.kind === 'every_n_days') {
        const n = toNumber((value as { intervalDays?: unknown }).intervalDays);
        return n !== null && n > 0;
    }
    if (value.kind === 'weekly') {
        const wd = (value as { weekdays?: unknown }).weekdays;
        return Array.isArray(wd) && wd.length > 0 && wd.every((w) => {
            const n = toNumber(w);
            return n !== null && n >= 0 && n <= 6;
        });
    }
    return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Section sanitizers
// ─────────────────────────────────────────────────────────────────────────────

export const sanitizeImportedEvents = (raw: unknown, fallbackWeight: number): { events: DoseEvent[]; migratedCount: number } => {
    if (!Array.isArray(raw)) throw new Error('Invalid format');
    let migratedCount = 0;
    const events = raw
        .map((entry): DoseEvent | null => {
            if (!isRecord(entry)) return null;
            // We deliberately do NOT enforce a route+ester whitelist here: import
            // validity should track "is this well-formed data", not the current
            // dose-entry dropdown — otherwise tightening a UI list later would
            // silently reject older, legitimately-stored backups.
            if (!isRoute(entry.route) || !isEster(entry.ester)) return null;
            const timeNum = toNumber(entry.timeH);
            if (timeNum === null) return null;
            const doseNum = toNumber(entry.doseMG) ?? 0;
            const extras = isRecord(entry.extras) ? entry.extras : {};
            const weightNum = toNumber((entry as { weightKG?: unknown }).weightKG);
            let weightKG: number;
            if (weightNum !== null && weightNum > 0) {
                weightKG = weightNum;
            } else {
                weightKG = fallbackWeight;
                migratedCount += 1;
            }
            return {
                id: typeof entry.id === 'string' ? entry.id : uuidv4(),
                route: entry.route,
                timeH: timeNum,
                doseMG: doseNum,
                ester: entry.ester,
                weightKG,
                extras: extras as DoseEvent['extras'],
            };
        })
        .filter((entry): entry is DoseEvent => entry !== null);
    return { events, migratedCount };
};

export const sanitizeImportedLabResults = (raw: unknown): LabResult[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry): LabResult | null => {
            if (!isRecord(entry)) return null;
            const timeNum = toNumber(entry.timeH);
            const valueNum = toNumber(entry.concValue);
            if (timeNum === null || valueNum === null) return null;
            const unit = entry.unit === 'pg/ml' || entry.unit === 'pmol/l' ? entry.unit : 'pmol/l';
            return { id: typeof entry.id === 'string' ? entry.id : uuidv4(), timeH: timeNum, concValue: valueNum, unit };
        })
        .filter((entry): entry is LabResult => entry !== null);
};

export const sanitizeImportedPlans = (raw: unknown): Plan[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry): Plan | null => {
            if (!isRecord(entry)) return null;
            if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
            if (!isEster(entry.ester) || !isRoute(entry.route)) return null;
            const doseMG = toNumber((entry as { doseMG?: unknown }).doseMG);
            if (doseMG === null || doseMG < 0) return null;
            if (!isPlanSchedule(entry.schedule)) return null;
            const startDateH = toNumber((entry as { startDateH?: unknown }).startDateH);
            const createdAtH = toNumber((entry as { createdAtH?: unknown }).createdAtH);
            const updatedAtH = toNumber((entry as { updatedAtH?: unknown }).updatedAtH);
            if (startDateH === null || createdAtH === null || updatedAtH === null) return null;
            const leadMinutes = toNumber((entry as { leadMinutes?: unknown }).leadMinutes);
            if (leadMinutes === null) return null;
            const enabled = (entry as { enabled?: unknown }).enabled;
            if (typeof enabled !== 'boolean') return null;
            // notifyEnabled 缺省 true（旧 plan 没有此字段时按"通知照常发"处理），
            // 这样旧数据导入不会因为新增字段而变成不通知。
            const notifyEnabledRaw = (entry as { notifyEnabled?: unknown }).notifyEnabled;
            const notifyEnabled = typeof notifyEnabledRaw === 'boolean' ? notifyEnabledRaw : true;
            const endDateH = (entry as { endDateH?: unknown }).endDateH;
            const label = (entry as { label?: unknown }).label;
            const extras = isRecord(entry.extras) ? entry.extras as PlanExtras : {};
            const plan: Plan = {
                id: entry.id,
                ester: entry.ester,
                route: entry.route,
                doseMG,
                schedule: entry.schedule,
                startDateH,
                enabled,
                notifyEnabled,
                leadMinutes,
                extras,
                createdAtH,
                updatedAtH,
            };
            if (typeof endDateH === 'number' && Number.isFinite(endDateH)) plan.endDateH = endDateH;
            if (typeof label === 'string') plan.label = label;
            return plan;
        })
        .filter((p): p is Plan => p !== null);
};

export const sanitizeImportedPostponeLog = (raw: unknown): PostponeLogEntry[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry): PostponeLogEntry | null => {
            if (!isRecord(entry)) return null;
            if (typeof entry.id !== 'string' || typeof entry.planId !== 'string') return null;
            const yearMonth = (entry as { yearMonth?: unknown }).yearMonth;
            if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) return null;
            const days = toNumber((entry as { days?: unknown }).days);
            const tsMs = toNumber((entry as { tsMs?: unknown }).tsMs);
            if (days === null || tsMs === null) return null;
            return { id: entry.id, planId: entry.planId, yearMonth, days, tsMs };
        })
        .filter((e): e is PostponeLogEntry => e !== null);
};

export const sanitizeImportedDueLog = (raw: unknown): DueLogEntry[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry): DueLogEntry | null => {
            if (!isRecord(entry)) return null;
            if (typeof entry.id !== 'string' || typeof entry.planId !== 'string') return null;
            const dateKey = (entry as { dateKey?: unknown }).dateKey;
            if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
            const status = (entry as { status?: unknown }).status;
            if (status !== 'taken' && status !== 'skipped' && status !== 'postponed') return null;
            const tsMs = toNumber((entry as { tsMs?: unknown }).tsMs);
            if (tsMs === null) return null;
            return { id: entry.id, planId: entry.planId, dateKey, status, tsMs };
        })
        .filter((e): e is DueLogEntry => e !== null);
};

export const sanitizeImportedPrefs = (raw: unknown): UserPrefsBackup | null => {
    if (!isRecord(raw)) return null;
    const out: UserPrefsBackup = {};
    const lang = (raw as { lang?: unknown }).lang;
    if (typeof lang === 'string' && (VALID_LANGS as readonly string[]).includes(lang)) out.lang = lang;
    const themeColor = (raw as { themeColor?: unknown }).themeColor;
    if (typeof themeColor === 'string' && (VALID_THEMES as readonly string[]).includes(themeColor)) out.themeColor = themeColor;
    const darkMode = (raw as { darkMode?: unknown }).darkMode;
    if (typeof darkMode === 'boolean') out.darkMode = darkMode;
    const remindersEnabled = (raw as { remindersEnabled?: unknown }).remindersEnabled;
    if (typeof remindersEnabled === 'boolean') out.remindersEnabled = remindersEnabled;
    return (out.lang === undefined
        && out.themeColor === undefined
        && out.darkMode === undefined
        && out.remindersEnabled === undefined) ? null : out;
};

export const sanitizeImportedCalibration = (raw: unknown): CalibrationBackup | null => {
    if (!isRecord(raw)) return null;
    const out: CalibrationBackup = {};
    const model = (raw as { model?: unknown }).model;
    if (typeof model === 'string' && (VALID_CALIBRATION_MODELS as readonly string[]).includes(model)) {
        out.model = model as CalibrationBackup['model'];
    }
    const mode = (raw as { mode?: unknown }).mode;
    if (typeof mode === 'string' && (VALID_CALIBRATION_MODES as readonly string[]).includes(mode)) {
        out.mode = mode as CalibrationBackup['mode'];
    }
    const e2 = (raw as { applyE2LearningToCPA?: unknown }).applyE2LearningToCPA;
    if (typeof e2 === 'boolean') out.applyE2LearningToCPA = e2;
    const cpa = (raw as { applyCPAInhibitionToE2?: unknown }).applyCPAInhibitionToE2;
    if (typeof cpa === 'boolean') out.applyCPAInhibitionToE2 = cpa;
    return (out.model === undefined
        && out.mode === undefined
        && out.applyE2LearningToCPA === undefined
        && out.applyCPAInhibitionToE2 === undefined) ? null : out;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public parsers
// ─────────────────────────────────────────────────────────────────────────────

/** Pick the fallback weight (for legacy rows missing per-dose weight). */
export const importFallbackWeight = (parsed: unknown, dflt: number): number => {
    if (isRecord(parsed)) {
        const w = toNumber(parsed.weight);
        if (w !== null && w > 0) return w;
    }
    return dflt;
};

/** Detect which schema version a parsed JSON object conforms to. v3 is the
 *  only one that carries `meta.version === 3`; everything else falls back to
 *  v2 semantics so older backups (even bare arrays) keep importing. */
const detectSchemaVersion = (parsed: unknown): typeof BACKUP_SCHEMA_VERSION_V2 | typeof BACKUP_SCHEMA_VERSION_V3 => {
    if (isRecord(parsed) && isRecord((parsed as { meta?: unknown }).meta)) {
        const v = (parsed as { meta: { version?: unknown } }).meta.version;
        if (v === BACKUP_SCHEMA_VERSION_V3) return BACKUP_SCHEMA_VERSION_V3;
    }
    return BACKUP_SCHEMA_VERSION_V2;
};

const parseV2 = (parsed: unknown, fallbackWeight: number): ParsedImport => {
    let events: DoseEvent[] = [];
    let labResults: LabResult[] | null = null;
    let gelProducts: GelProductSpec[] | null = null;
    let migratedCount = 0;

    if (Array.isArray(parsed)) {
        const r = sanitizeImportedEvents(parsed, fallbackWeight);
        events = r.events;
        migratedCount = r.migratedCount;
    } else if (isRecord(parsed)) {
        if (Array.isArray(parsed.events)) {
            const r = sanitizeImportedEvents(parsed.events, fallbackWeight);
            events = r.events;
            migratedCount = r.migratedCount;
        }
        if (Array.isArray(parsed.labResults)) labResults = sanitizeImportedLabResults(parsed.labResults);
        if (Array.isArray(parsed.gelProducts)) gelProducts = sanitizeGelProducts(parsed.gelProducts);
    }
    return {
        events,
        labResults,
        gelProducts,
        plans: null,
        postponeLog: null,
        dueLog: null,
        prefs: null,
        calibration: null,
        migratedCount,
        schemaVersion: BACKUP_SCHEMA_VERSION_V2,
    };
};

const parseV3 = (parsed: JsonRecord, fallbackWeight: number): ParsedImport => {
    let events: DoseEvent[] = [];
    let labResults: LabResult[] | null = null;
    let gelProducts: GelProductSpec[] | null = null;
    let migratedCount = 0;

    if (Array.isArray(parsed.events)) {
        const r = sanitizeImportedEvents(parsed.events, fallbackWeight);
        events = r.events;
        migratedCount = r.migratedCount;
    }
    if (Array.isArray(parsed.labResults)) labResults = sanitizeImportedLabResults(parsed.labResults);
    if (Array.isArray(parsed.gelProducts)) gelProducts = sanitizeGelProducts(parsed.gelProducts);

    const plans = Array.isArray(parsed.plans) ? sanitizeImportedPlans(parsed.plans) : null;
    const reminderLog = isRecord(parsed.reminderLog) ? parsed.reminderLog as JsonRecord : null;
    const postponeLog = reminderLog && Array.isArray(reminderLog.postponeLog)
        ? sanitizeImportedPostponeLog(reminderLog.postponeLog)
        : null;
    const dueLog = reminderLog && Array.isArray(reminderLog.dueLog)
        ? sanitizeImportedDueLog(reminderLog.dueLog)
        : null;
    const prefs = sanitizeImportedPrefs(parsed.prefs);
    const calibration = sanitizeImportedCalibration(parsed.calibration);

    return {
        events,
        labResults,
        gelProducts,
        plans: plans !== null ? plans : null,  // v3 may omit plans entirely → null
        postponeLog,
        dueLog,
        prefs,
        calibration,
        migratedCount,
        schemaVersion: BACKUP_SCHEMA_VERSION_V3,
    };
};

export const parseImportedBackup = (parsed: unknown, fallbackWeight: number): ParsedImport => {
    const version = detectSchemaVersion(parsed);
    if (version === BACKUP_SCHEMA_VERSION_V3 && isRecord(parsed)) {
        return parseV3(parsed, fallbackWeight);
    }
    return parseV2(parsed, fallbackWeight);
};

/**
 * Valid when the file carried ANY recognized section — including an empty
 * `labResults: []` / `gelProducts: []` whose intent is to clear that section.
 * For v3 backups, the v3-specific sections (plans / dueLog / prefs / ...)
 * also count, so a prefs-only backup isn't silently ignored. (Clearing all
 * events is done via the dedicated Clear button, not import.)
 */
export const importHasContent = (p: ParsedImport): boolean =>
    p.events.length > 0
    || p.labResults !== null
    || p.gelProducts !== null
    || p.plans !== null
    || p.postponeLog !== null
    || p.dueLog !== null
    || p.prefs !== null
    || p.calibration !== null;
