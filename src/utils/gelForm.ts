/**
 * Pure helpers for the custom-gel editor form and for building a gel dose event's
 * extras. Extracted from the React components so they can be unit-tested in node.
 */
import { ExtraKey, type DoseEvent } from '../../types';
import { GEL_SITE_ORDER, type GelProductSpec } from '../../pk';

// Fast surface-depletion rate shared with the PK priors (pk.ts). The user-facing
// "reference bioavailability" only sets the penetration/loss SPLIT, not the
// timescale, so editing it never changes tmax.
export const LAMBDA_SURFACE = 1.4;

export interface GelForm {
    name: string;
    conc: string;       // mg/g
    area: string;       // cm²
    bio: string;        // reference bioavailability, %
    halflife: string;   // reservoir/terminal t½, h
}

export const EMPTY_GEL_FORM: GelForm = { name: '', conc: '1.0', area: '400', bio: '10', halflife: '31' };

// Plain decimal number only: rejects empty, "1abc", scientific ("1e3"), hex
// ("0x10"), "Infinity", etc. so a typo is never silently coerced to a default.
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
export const parseField = (raw: string, lo: number, hi: number): number | null => {
    const s = raw.trim();
    if (!DECIMAL_RE.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < lo || n > hi) return null;
    return n;
};

const clampDisplay = (x: number, lo: number, hi: number) =>
    Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

// Reverse a stored product back into the editable form. Values are clamped into
// the UI-valid range so an imported / out-of-range product can still be edited
// and saved instead of failing validation on an untouched field. Guards against
// corrupt specs (kPen+kLoss==0, kRel<=0) so the form never shows "NaN".
export const productToForm = (p: GelProductSpec): GelForm => {
    const denom = p.kPenBase + p.kLoss;
    const bioRaw = denom > 0 ? (p.kPenBase / denom) * 100 : 10;
    const halfLifeRaw = p.kRel > 0 ? Math.log(2) / p.kRel : 31;
    return {
        name: p.name || '',
        conc: String(clampDisplay(p.concentrationMGmL, 0.01, 100)),
        area: String(clampDisplay(p.defaultAreaCM2, 1, 5000)),
        bio: String(Math.round(clampDisplay(bioRaw, 0.5, 95) * 10) / 10),
        halflife: String(Math.round(clampDisplay(halfLifeRaw, 1, 240) * 10) / 10),
    };
};

// Validate the whole form. Returns a product on success or a field error key.
export const validateGelForm = (form: GelForm, id: number): { product: GelProductSpec } | { error: string } => {
    if (!form.name.trim()) return { error: 'gel.custom.name_required' };
    const conc = parseField(form.conc, 0.01, 100);
    const area = parseField(form.area, 1, 5000);
    const bio = parseField(form.bio, 0.5, 95);
    const tHalf = parseField(form.halflife, 1, 240);
    if (conc === null || area === null || bio === null || tHalf === null) {
        return { error: 'gel.custom.invalid' };
    }
    const kPenBase = (bio / 100) * LAMBDA_SURFACE;
    return {
        product: {
            id,
            nameKey: '',
            name: form.name.trim(),
            concentrationMGmL: conc,
            defaultAreaCM2: area,
            refDoseMG: area * 0.002,
            kPenBase,
            kLoss: LAMBDA_SURFACE - kPenBase,
            kRel: Math.log(2) / tHalf,
        },
    };
};

export const gelFormsEqual = (a: GelForm, b: GelForm): boolean =>
    (Object.keys(a) as (keyof GelForm)[]).every((k) => a[k] === b[k]);

/**
 * Build the extras for a gel dose event. The selected `productId` is stored
 * VERBATIM (never a resolved/fallback product id) so editing a record whose
 * product was deleted preserves its reference instead of silently rebinding to
 * the default gel. Kinetics are resolved from the registry at simulation time.
 */
export const buildGelExtras = (opts: {
    productId: number;
    gelSite: number;
    areaCM2: number;
    washAfterH?: number;
}): Partial<Record<ExtraKey, number>> => {
    const rawSite = Number.isFinite(opts.gelSite) ? Math.round(opts.gelSite) : 0;
    const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, rawSite));
    const extras: Partial<Record<ExtraKey, number>> = {
        [ExtraKey.gelSite]: siteIdx,
        [ExtraKey.gelProductId]: opts.productId,
        [ExtraKey.areaCM2]: opts.areaCM2,
    };
    if (typeof opts.washAfterH === 'number' && Number.isFinite(opts.washAfterH) && opts.washAfterH > 0) {
        extras[ExtraKey.gelWashAfterH] = opts.washAfterH;
    }
    return extras;
};

// Re-export for callers that want the event extras type without importing types.
export type GelExtras = DoseEvent['extras'];
