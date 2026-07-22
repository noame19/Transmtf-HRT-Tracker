// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildAITextExport, type AIExportInput } from './aiExport';
import type { DoseEvent, LabResult, Plan } from '../../types';
import type { BasicInfo, PostponeLogEntry, DueLogEntry } from '../components/BasicInfoModal';

// ── Test fixtures ─────────────────────────────────────────────────────

const today = new Date('2026-07-23T10:00:00');

function eventH(dateStr: string): number {
    return new Date(dateStr).getTime() / 3600_000;
}

const basicInfo: BasicInfo = {
    route: 'MtF',
    birth: '1998-05',
    heightCm: 168,
    allergies: '',
    hrtStart: '2024-03-15',
};

const emptyBasicInfo: BasicInfo = {
    route: null,
    birth: null,
    heightCm: null,
    allergies: '',
    hrtStart: null,
};

const sampleEvents: DoseEvent[] = [
    {
        id: 'e1', timeH: eventH('2026-07-22T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
    {
        id: 'e2', timeH: eventH('2026-07-06T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
    {
        id: 'e3', timeH: eventH('2026-06-01T20:30:00'),
        route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
    } as DoseEvent,
];

const sampleLabs: LabResult[] = [
    { id: 'l1', timeH: eventH('2026-07-05T09:00:00'), metric: 'E2', concValue: 156, unit: 'pg/ml' as LabResult['unit'] },
    { id: 'l2', timeH: eventH('2026-04-01T09:00:00'), metric: 'T', concValue: 0.42, unit: 'ng/mL' as unknown as LabResult['unit'] },
];

const samplePlans: Plan[] = [
    { id: 'p1', ester: 'EV', route: 'injection', doseMG: 5, intervalDays: 5, enabled: true, schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:30'] } } as unknown as Plan,
    { id: 'p2', ester: 'CPA', route: 'oral', doseMG: 12.5, intervalDays: 2, enabled: true, schedule: { kind: 'every_n_days', intervalDays: 2, times: ['20:00'] } } as unknown as Plan,
    { id: 'p3', ester: 'EEn', route: 'injection', doseMG: 8, intervalDays: 7, enabled: false, schedule: { kind: 'every_n_days', intervalDays: 7, times: ['10:00'] } } as unknown as Plan,
];

const emptyInput: AIExportInput = {
    events: [], labResults: [], plans: [], basicInfo: emptyBasicInfo,
    postponeLog: [], dueLog: [],
    rangeStart: '2026-06-23', rangeEnd: '2026-07-23',
    lang: 'zh', exportedAt: today,
};

const fullInput: AIExportInput = {
    events: sampleEvents,
    labResults: sampleLabs,
    plans: samplePlans,
    basicInfo,
    postponeLog: [],
    dueLog: [],
    rangeStart: '2026-06-23',
    rangeEnd: '2026-07-23',
    lang: 'zh',
    exportedAt: today,
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('buildAITextExport — Patient Profile', () => {
    it('computes age correctly with cross-month handling', () => {
        // Birth May 1998, today July 23 2026 → age 28 (birthday already passed)
        const out = buildAITextExport({ ...fullInput, basicInfo });
        expect(out.text).toMatch(/Age: 28/);
    });

    it('subtracts 1 when birthday has not occurred this year', () => {
        const futureBirthday: BasicInfo = { ...basicInfo, birth: '1998-12' };
        const out = buildAITextExport({ ...fullInput, basicInfo: futureBirthday });
        // Dec birthday hasn't come yet in July → age 27
        expect(out.text).toMatch(/Age: 27/);
    });

    it('shows Not recorded when birth is null', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: emptyBasicInfo });
        expect(out.text).toMatch(/Age: Not recorded/);
    });

    it('shows Not recorded when birth is malformed', () => {
        const malformed: BasicInfo = { ...basicInfo, birth: '1998-13' };
        const out = buildAITextExport({ ...fullInput, basicInfo: malformed });
        expect(out.text).toMatch(/Age: Not recorded/);
    });

    it('shows hrtStart when set', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo });
        expect(out.text).toMatch(/HRT Start Date: 2024-03-15/);
    });

    it('shows Not recorded when hrtStart is null', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: emptyBasicInfo });
        expect(out.text).toMatch(/HRT Start Date: Not recorded/);
    });

    it('shows None recorded when allergies is empty', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: { ...basicInfo, allergies: '' } });
        expect(out.text).toMatch(/Allergies \/ Contraindications: None recorded/);
    });

    it('shows allergies text when set', () => {
        const out = buildAITextExport({ ...fullInput, basicInfo: { ...basicInfo, allergies: 'Peanut allergy' } });
        expect(out.text).toMatch(/Allergies \/ Contraindications: Peanut allergy/);
    });
});

describe('buildAITextExport — Active Dosing Plans', () => {
    it('lists only enabled plans', () => {
        const out = buildAITextExport({ ...fullInput });
        expect(out.text).toContain('EV');
        expect(out.text).toContain('CPA');
        expect(out.text).not.toContain('EEn');
    });

    it('shows No active plans when all disabled', () => {
        const out = buildAITextExport({ ...fullInput, plans: [] });
        expect(out.text).toContain('No active plans.');
    });
});

describe('buildAITextExport — Medication Log', () => {
    it('filters events to the requested range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-07-01', rangeEnd: '2026-07-31' });
        // 2026-07-22 in range → contains "2026-07-22"
        expect(out.text).toContain('2026-07-22');
        // 2026-07-06 in range
        expect(out.text).toContain('2026-07-06');
        // 2026-06-01 out of range
        expect(out.text).not.toContain('2026-06-01');
    });

    it('sorts events by timeH ascending', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-06-01', rangeEnd: '2026-07-31' });
        const e2Idx = out.text.indexOf('2026-07-06');
        const e1Idx = out.text.indexOf('2026-07-22');
        expect(e2Idx).toBeGreaterThan(0);
        expect(e1Idx).toBeGreaterThan(e2Idx);
    });

    it('shows No doses recorded when empty', () => {
        const out = buildAITextExport({ ...fullInput, events: [] });
        expect(out.text).toContain('No doses recorded in this date range.');
    });

    it('shows No doses recorded when all events out of range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-05-01', rangeEnd: '2026-05-15' });
        expect(out.text).toContain('No doses recorded in this date range.');
    });
});

describe('buildAITextExport — Lab Results', () => {
    it('filters labs to the requested range', () => {
        const out = buildAITextExport({ ...fullInput, rangeStart: '2026-06-01', rangeEnd: '2026-07-31' });
        // E2 lab on 2026-07-05 in range
        expect(out.text).toContain('E2');
        // T lab on 2026-04-01 out of range
        expect(out.text).not.toContain('2026-04-01');
    });

    it('shows No lab results when empty', () => {
        const out = buildAITextExport({ ...fullInput, labResults: [] });
        expect(out.text).toContain('No lab results in this date range.');
    });
});

describe('buildAITextExport — Adherence KPIs', () => {
    // 90-day window from today (2026-07-23): [2026-04-25, 2026-07-23]
    it('computes 100% when all dueLog entries are taken', () => {
        const dueLog: DueLogEntry[] = [];
        for (let i = 0; i < 10; i++) {
            const dateMs = today.getTime() - i * 5 * 86_400_000;
            const d = new Date(dateMs);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dueLog.push({ id: `d${i}`, planId: 'p1', dateKey: key, status: 'taken', tsMs: dateMs });
        }
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toMatch(/90-day Achievement Rate: 100% \(10\/10 due days taken\)/);
    });

    it('computes partial rate with mixed taken/skipped', () => {
        const dueLog: DueLogEntry[] = [];
        for (let i = 0; i < 10; i++) {
            const dateMs = today.getTime() - i * 5 * 86_400_000;
            const d = new Date(dateMs);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dueLog.push({ id: `d${i}`, planId: 'p1', dateKey: key, status: i < 7 ? 'taken' : 'skipped', tsMs: dateMs });
        }
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toMatch(/90-day Achievement Rate: 70% \(7\/10 due days taken\)/);
    });

    it('excludes postponed from both numerator and denominator', () => {
        const dueLog: DueLogEntry[] = [
            { id: 'd1', planId: 'p1', dateKey: '2026-07-20', status: 'taken', tsMs: 1 },
            { id: 'd2', planId: 'p1', dateKey: '2026-07-15', status: 'taken', tsMs: 1 },
            { id: 'd3', planId: 'p1', dateKey: '2026-07-10', status: 'postponed', tsMs: 1 },
            { id: 'd4', planId: 'p1', dateKey: '2026-07-05', status: 'skipped', tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, dueLog });
        // 2 taken / (2 taken + 1 skipped) = 2/3 = 67%
        expect(out.text).toMatch(/90-day Achievement Rate: 67% \(2\/3 due days taken\)/);
    });

    it('shows Insufficient data when dueLog is empty', () => {
        const out = buildAITextExport({ ...fullInput, dueLog: [] });
        expect(out.text).toContain('Insufficient data (no dueLog entries yet)');
    });

    it('shows Insufficient data when no due days in 90-day window', () => {
        const dueLog: DueLogEntry[] = [
            { id: 'd1', planId: 'p1', dateKey: '2020-01-01', status: 'taken', tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, dueLog });
        expect(out.text).toContain('Insufficient data (no due days in last 90 days)');
    });

    it('counts this-month postpone events', () => {
        const postponeLog: PostponeLogEntry[] = [
            { id: 'p1', planId: 'p1', yearMonth: '2026-07', days: 2, tsMs: 1 },
            { id: 'p2', planId: 'p2', yearMonth: '2026-07', days: 1, tsMs: 1 },
            { id: 'p3', planId: 'p1', yearMonth: '2026-06', days: 5, tsMs: 1 }, // last month, ignore
        ];
        const out = buildAITextExport({ ...fullInput, postponeLog });
        expect(out.text).toContain("This Month's Postpone Count: 3 events");
    });

    it('uses singular event when count is 1', () => {
        const postponeLog: PostponeLogEntry[] = [
            { id: 'p1', planId: 'p1', yearMonth: '2026-07', days: 1, tsMs: 1 },
        ];
        const out = buildAITextExport({ ...fullInput, postponeLog });
        expect(out.text).toMatch(/Postpone Count: 1 event(?!s)/);
    });

    it('shows 0 events when no this-month postpones', () => {
        const out = buildAITextExport({ ...fullInput, postponeLog: [] });
        expect(out.text).toContain("This Month's Postpone Count: 0 events");
    });
});

describe('buildAITextExport — prompt language injection', () => {
    it('injects 简体中文 for lang=zh', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'zh' });
        expect(out.text).toContain('Respond in 简体中文 (zh)');
    });

    it('injects 正體中文 for lang=zh-TW', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'zh-TW' });
        expect(out.text).toContain('Respond in 正體中文 (zh-TW)');
    });

    it('injects 日本語 for lang=ja', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'ja' });
        expect(out.text).toContain('Respond in 日本語 (ja)');
    });

    it('injects English for lang=en', () => {
        const out = buildAITextExport({ ...fullInput, lang: 'en' });
        expect(out.text).toContain("Respond in English (matches the user's app language)");
    });

    it('prompt 5 instructions are in English across all langs', () => {
        for (const lang of ['zh', 'zh-TW', 'ja', 'en'] as const) {
            const out = buildAITextExport({ ...fullInput, lang });
            expect(out.text).toContain('1. Evaluate the current dosing regimen');
            expect(out.text).toContain('5. Keep your tone objective, professional, empathetic');
        }
    });
});

describe('buildAITextExport — overall structure', () => {
    it('starts with the standard header', () => {
        const out = buildAITextExport({ ...emptyInput });
        expect(out.text.startsWith('# HRT Medication Data Export — AI Analysis Request')).toBe(true);
    });

    it('contains all 6 sections', () => {
        const out = buildAITextExport({ ...fullInput });
        expect(out.text).toContain('## Patient Profile');
        expect(out.text).toContain('## Active Dosing Plans');
        expect(out.text).toContain('## Recent Medication Log');
        expect(out.text).toContain('## Lab Results');
        expect(out.text).toContain('## Recent Adherence KPIs');
        expect(out.text).toContain('## Notes');
    });

    it('marks tooLarge=true when text exceeds 100KB', () => {
        const hugeEvents: DoseEvent[] = [];
        for (let i = 0; i < 5000; i++) {
            hugeEvents.push({
                id: `e${i}`, timeH: eventH('2024-01-01T00:00:00') + i,
                route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55,
            } as DoseEvent);
        }
        const out = buildAITextExport({
            ...fullInput,
            events: hugeEvents,
            rangeStart: '2023-01-01',
            rangeEnd: '2027-12-31',
        });
        expect(out.tooLarge).toBe(true);
    });

    it('handles empty inputs without throwing', () => {
        expect(() => buildAITextExport({ ...emptyInput })).not.toThrow();
        const out = buildAITextExport({ ...emptyInput });
        expect(out.tooLarge).toBe(false);
        expect(out.text.length).toBeGreaterThan(0);
    });
});