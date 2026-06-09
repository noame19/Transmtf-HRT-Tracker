/**
 * Pure parsing/merge logic for the Settings "import JSON" flow, extracted from
 * the React component so it can be unit-tested in the node environment.
 *
 * Key rule: a section that is ABSENT from the file is returned as `null`, meaning
 * "keep the existing data". A section present but EMPTY (`labResults: []`,
 * `gelProducts: []`) is returned as `[]`, meaning "clear it". This is what lets a
 * gel-only / events-only backup avoid wiping unrelated sections.
 */
import { v4 as uuidv4 } from 'uuid';
import { Ester, Route, type DoseEvent, type LabResult } from '../../types';
import { sanitizeGelProducts, type GelProductSpec } from '../../pk';

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === 'object' && value !== null;

export const toNumber = (value: unknown): number | null => {
    const next = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(next) ? next : null;
};

export const isRoute = (value: unknown): value is Route =>
    typeof value === 'string' && (Object.values(Route) as string[]).includes(value);

export const isEster = (value: unknown): value is Ester =>
    typeof value === 'string' && (Object.values(Ester) as string[]).includes(value);

export const sanitizeImportedEvents = (raw: unknown, fallbackWeight: number): { events: DoseEvent[]; migratedCount: number } => {
    if (!Array.isArray(raw)) throw new Error('Invalid format');
    let migratedCount = 0;
    const events = raw
        .map((entry): DoseEvent | null => {
            if (!isRecord(entry)) return null;
            // Validate that route/ester are real enum members (replacing a blind
            // `as` cast) so a corrupt backup can't smuggle in an unknown compound.
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

export interface ParsedImport {
    events: DoseEvent[];                 // [] when the file carried no events
    labResults: LabResult[] | null;      // null = section absent → keep existing
    gelProducts: GelProductSpec[] | null;
    migratedCount: number;
}

/** Pick the fallback weight (for legacy rows missing per-dose weight). */
export const importFallbackWeight = (parsed: unknown, dflt: number): number => {
    if (isRecord(parsed)) {
        const w = toNumber(parsed.weight);
        if (w !== null && w > 0) return w;
    }
    return dflt;
};

export const parseImportedBackup = (parsed: unknown, fallbackWeight: number): ParsedImport => {
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
    return { events, labResults, gelProducts, migratedCount };
};

/**
 * Valid when the file carried ANY recognized section — including an empty
 * `labResults: []` / `gelProducts: []` whose intent is to clear that section.
 * (Clearing all events is done via the dedicated Clear button, not import.)
 */
export const importHasContent = (p: ParsedImport): boolean =>
    p.events.length > 0 || p.labResults !== null || p.gelProducts !== null;
