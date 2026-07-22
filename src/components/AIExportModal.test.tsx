// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string) => k,
        lang: 'zh',
    }),
}));

const showDialogMock = vi.fn(async () => 'alert' as const);
vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({ showDialog: showDialogMock }),
}));

const invokeMock = vi.fn(async () => true);
beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
});
afterEach(() => {
    cleanup();
    invokeMock.mockClear();
    showDialogMock.mockClear();
    delete (window as any).__TAURI_INTERNALS__;
    vi.useRealTimers();
});

import AIExportModal from './AIExportModal';
import type { BasicInfo } from './BasicInfoModal';
import type { DoseEvent, LabResult, Plan } from '../../types';

const basicInfo: BasicInfo = {
    route: 'MtF', birth: '1998-05', heightCm: 168, allergies: '', hrtStart: '2024-03-15',
};

const events: DoseEvent[] = [
    { id: 'e1', timeH: 469800.5, route: 'injection', ester: 'EV', doseMG: 5, weightKG: 55 } as DoseEvent,
];
const labResults: LabResult[] = [
    { id: 'l1', timeH: 469720, metric: 'E2', concValue: 156, unit: 'pg/ml' },
];
const plans: Plan[] = [
    { id: 'p1', ester: 'EV', route: 'injection', doseMG: 5, enabled: true, schedule: { kind: 'every_n_days', intervalDays: 5, times: ['20:30'] } } as unknown as Plan,
];

function fixNow() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T10:00:00'));
}

describe('AIExportModal', () => {
    it('initializes with Last 30d highlighted and date inputs filled', () => {
        fixNow();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const preset30 = screen.getByTestId('preset-30') as HTMLButtonElement;
        // Verify it has a non-empty background style set (highlighted)
        expect(preset30.style.background).not.toBe('');
        // Verify dates are filled (any non-empty value)
        const dateInputs = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/);
        expect(dateInputs.length).toBeGreaterThanOrEqual(2);
    });

    it('clicking Last 7d updates date range', () => {
        fixNow();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const before = (screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0] as HTMLInputElement).value;
        fireEvent.click(screen.getByTestId('preset-7'));
        const after = (screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/)[0] as HTMLInputElement).value;
        expect(before).not.toBe(after);
    });

    it('disables copy button when no data', () => {
        fixNow();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={[]} labResults={[]} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const btn = screen.getByTestId('ai-export-copy-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it('disables copy button when startDate > endDate', () => {
        fixNow();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        const dateInputs = screen.getAllByDisplayValue(/\d{4}-\d{2}-\d{2}/);
        fireEvent.change(dateInputs[0], { target: { value: '2026-12-31' } });
        fireEvent.change(dateInputs[1], { target: { value: '2026-01-01' } });
        const btn = screen.getByTestId('ai-export-copy-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it('clicking preview toggle reveals the generated text', () => {
        fixNow();
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        // Preview hidden initially
        expect(screen.queryByTestId('ai-export-preview')).toBeNull();
        // Find the toggle button by aria or role
        const toggleBtn = screen.getByRole('button', { name: /aiExport\.previewLabel/ });
        fireEvent.click(toggleBtn);
        const preview = screen.getByTestId('ai-export-preview');
        expect(preview).not.toBeNull();
        expect(preview.textContent).toContain('Patient Profile');
    });

    it('clicking copy invokes clipboard with non-empty text', async () => {
        // Use real timers so the 2s setTimeout in handleCopy doesn't block
        // and so async invoke resolves naturally.
        render(
            <AIExportModal
                isOpen
                onClose={() => {}}
                events={events} labResults={labResults} plans={plans}
                basicInfo={basicInfo} postponeLog={[]} dueLog={[]} lang="zh"
            />,
        );
        fireEvent.click(screen.getByTestId('ai-export-copy-btn'));
        // Flush microtasks
        await new Promise(r => setTimeout(r, 10));
        expect(invokeMock).toHaveBeenCalled();
        const firstCall = invokeMock.mock.calls[0];
        expect(firstCall[0]).toBe('clipboard_write_text');
        expect(typeof firstCall[1]?.text).toBe('string');
        expect(firstCall[1].text.length).toBeGreaterThan(0);
    });
});