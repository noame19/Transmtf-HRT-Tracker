/**
 * Shared domain types for the HRT tracker.
 *
 * This file is intentionally limited to enums, interfaces, and other
 * "shape-only" definitions that describe the data model used across the app.
 * Keeping these definitions in one place makes later refactors safer because
 * UI code, persistence code, and PK logic can all agree on the same contract.
 */

/**
 * Supported administration routes for tracked medication events.
 *
 * Notes:
 * - `patchApply` and `patchRemove` are modeled as separate event kinds so the
 *   timeline can represent both applying and removing a patch explicitly.
 * - Route names are serialized to storage, so they should remain stable.
 */
export enum Route {
    injection = "injection",
    patchApply = "patchApply",
    patchRemove = "patchRemove",
    gel = "gel",
    oral = "oral",
    sublingual = "sublingual"
}

/**
 * Compounds / esters currently supported by the pharmacokinetic model.
 *
 * The enum values are also persisted in exported data, so keeping them short
 * and stable helps preserve backwards compatibility.
 */
export enum Ester {
    E2 = "E2",
    EB = "EB",
    EV = "EV",
    EC = "EC",
    EN = "EN",
    // Estradiol undecylate (十一酸雌二醇). A long-chain (undecanoate) IM depot ester
    // distinct from estradiol valerate (EV / 戊酸雌二醇); its much longer duration of
    // action is an absorption (flip-flop) effect, not slow clearance. See EU_DEPOT_PK.
    EU = "EU",
    CPA = "CPA",
    BICA = "BICA"
}

/**
 * Concentration unit tags used by non-E2 compound component series.
 *
 * Anti-androgens are stored internally in ng/mL; the display layer may scale
 * a value up to µg/mL ("ug/mL") when it grows large (e.g. bicalutamide).
 */
export type ConcUnit = 'pg/mL' | 'ng/mL' | 'ug/mL';

/**
 * A single non-E2 compound concentration curve on the shared simulation grid,
 * tagged with the unit its `values` are expressed in.
 */
export interface CompoundSeries {
    unit: ConcUnit;
    values: number[];
}

/**
 * Optional per-event metadata keys stored inside `DoseEvent.extras`.
 *
 * These remain numeric so they are easy to serialize, validate, and pass into
 * the PK formulas without additional parsing layers.
 */
export enum ExtraKey {
    concentrationMGmL = "concentrationMGmL",
    areaCM2 = "areaCM2",
    releaseRateUGPerDay = "releaseRateUGPerDay",
    sublingualTheta = "sublingualTheta",
    sublingualTier = "sublingualTier",
    gelSite = "gelSite",
    // Transdermal-gel event fields. The event references a gel product by id and
    // records only the per-application site / area / wash; the product's intrinsic
    // kinetics live in the GEL_PRODUCTS registry (pk.ts) and are resolved at
    // simulation time, so editing a custom product updates all of its records.
    gelProductId = "gelProductId",      // stable id of the selected gel product
    gelWashAfterH = "gelWashAfterH",    // wash-off time after application (h); 0/absent = no wash
    // Body-surface coverage template index (into GEL_COVERAGE_TEMPLATES, pk.ts).
    // UI convenience so users pick a recognizable extent ("~2 palms", "one arm")
    // instead of guessing a raw cm²; the RESOLVED area is what the engine reads
    // from `areaCM2`. Absent = legacy record entered as a raw cm² (shown as "manual").
    gelCoverage = "gelCoverage",
    // Co-applied topical product index (into GEL_COAPPLICATION_ORDER, pk.ts):
    // 0 none / 1 sunscreen (−16% AUC) / 2 moisturizer (+38% AUC). Absent/0 = none.
    gelCoApplied = "gelCoApplied"
}

/**
 * A single medication event entered by the user.
 *
 * `doseMG` stores the administered compound amount in mg. For esterified forms
 * this is the ester/compound dose, not the estradiol-equivalent dose. Any
 * route-specific settings live in `extras`.
 */
export interface DoseEvent {
    id: string;
    route: Route;
    timeH: number; // Hours since 1970
    doseMG: number; // Dose in mg (of the ester/compound), NOT E2-equivalent
    ester: Ester;
    weightKG: number; // Body weight at time of administration, in kg
    extras: Partial<Record<ExtraKey, number>>;
}

/**
 * Raw simulation output on the shared time grid.
 *
 * The engine keeps total concentration plus route-specific E2 / CPA component
 * curves so the UI can display combined or separated views without re-running
 * the full simulation.
 */
/**
 * Raw simulation output on the shared time grid.
 *
 * The engine keeps total concentration plus the E2 component curve, and a
 * generic `byCompound` map for every non-E2 compound (anti-androgens such as
 * CPA / bicalutamide), so the UI can display combined or separated views
 * without re-running the full simulation. `concPGmL_CPA` is retained as a
 * backwards-compatible mirror of `byCompound[Ester.CPA]` (it is, despite the
 * legacy name, in ng/mL).
 */
export interface SimulationResult {
    timeH: number[];
    concPGmL: number[];
    concPGmL_E2: number[];
    concPGmL_CPA: number[];
    byCompound: Partial<Record<Ester, CompoundSeries>>;
    auc: number;
}

/**
 * A laboratory measurement entered by the user.
 *
 * The value is stored in the unit originally entered by the user so the app
 * can preserve display intent, while conversion helpers can normalize it for
 * modeling when needed.
 */
export interface LabResult {
    id: string;
    timeH: number;
    concValue: number; // Value in the user's unit
    unit: 'pg/ml' | 'pmol/l';
}

// ─────────────────────────────────────────────────────────────────────────────
// Medication plans (recurring schedules) + reminders
// ─────────────────────────────────────────────────────────────────────────────

/** Numeric route-specific metadata, mirrored from DoseEvent.extras for future
 *  "auto-create record from plan" reuse (gel site, sublingual tier, etc.). */
export type PlanExtras = Partial<Record<ExtraKey, number>>;

/**
 * Schedule for a recurring medication plan. Discriminated union so adding
 * new kinds later (e.g. 'monthly') is non-breaking for persisted JSON.
 *
 * `times` are wall-clock `HH:MM` strings in the user's local timezone. A plan
 * can have up to 4 daily times (mirroring `BatchDoseModal.timesPerDay`).
 */
export type PlanSchedule =
    | { kind: 'daily'; times: string[] }
    | { kind: 'every_n_days'; intervalDays: number; times: string[] }
    | { kind: 'weekly'; weekdays: number[]; times: string[] }; // 0=Sun..6=Sat (matches Date.getDay())

/** Drug-class grouping — derived from ester, used for UI grouping/colors. */
export type DrugCategory = 'estrogen' | 'anti_androgen' | 'progestin' | 'other';

/**
 * A recurring medication plan. The smart "新增" flow uses these to pre-fill
 * DoseFormModal / batch-confirm; the Android-side NotificationScheduler uses
 * `dueMomentsInRange(plan, ...)` to register AlarmManager alarms.
 */
export interface Plan {
    id: string;
    ester: Ester;
    route: Route;
    doseMG: number;
    schedule: PlanSchedule;
    /** Wall-clock hours since 1970 — same convention as DoseEvent.timeH. */
    startDateH: number;
    /** Optional end. Absent = open-ended. */
    endDateH?: number;
    enabled: boolean;        // soft-disable toggle (hard-delete is a separate op)
    /** "Remind N minutes BEFORE scheduled time" — 0 = at-time. */
    leadMinutes: number;
    /** Per-plan label shown in the notification body (e.g. "EV 5mg/5d IM"). */
    label?: string;
    extras: PlanExtras;
    createdAtH: number;
    updatedAtH: number;
}
