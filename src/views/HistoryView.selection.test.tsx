// @vitest-environment happy-dom
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// Mock contexts so the component doesn't need full provider tree
vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string, vars?: Record<string, unknown>) => {
            if (vars && typeof k === 'string') {
                return k.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
            }
            return k;
        },
        lang: 'zh',
    }),
}));

vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({
        showDialog: vi.fn(async () => 'confirm' as const),
    }),
}));

import HistoryView from './HistoryView';
import type { DoseEvent, Plan } from '../../types';

// Build a minimal DoseEvent with the fields HistoryView reads
const mkEvent = (id: string, timeH: number, route: DoseEvent['route'] = 'injection' as any): DoseEvent => ({
    id,
    timeH,
    route,
    ester: 'EB' as any,
    doseMG: 1,
    weightKG: 60,
    extras: {},
});

// PlanList stub — selection tests run on the 'records' tab so plans aren't rendered.
vi.mock('../components/PlanList', () => ({
    default: () => <div data-testid="plan-list-stub" />,
}));

const baseProps = {
    events: [] as DoseEvent[],
    onAddEvent: vi.fn(),
    onEditEvent: vi.fn(),
    onBatchAdd: vi.fn(),
    plans: [] as Plan[],
    onAddPlan: vi.fn(),
    onEditPlan: vi.fn(),
    onDeletePlan: vi.fn(),
    onTogglePlan: vi.fn(),
    onRemovePatch: vi.fn(),
    pendingReminder: null,
    matchedPendingPlan: null,
    onConfirmPendingReminder: vi.fn(),
    bannerEntries: [],
    onConfirmBanner: vi.fn(),
    onSkipBanner: vi.fn(),
    onDelay1d: vi.fn(),
    onDelay2d: vi.fn(),
    permissionDenied: false,
    complianceMismatches: [],
    onBulkDeleteEvents: vi.fn(),
    onBulkDeletePlans: vi.fn(),
};

afterEach(() => cleanup());

describe('HistoryView — selection mode', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('long-press 500ms enters selection mode and selects the item', () => {
        const events = [mkEvent('a', 100), mkEvent('b', 200)];
        render(<HistoryView {...baseProps} events={events} />);

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });

        // Before 500ms — should not be in selection mode
        act(() => { vi.advanceTimersByTime(499); });
        expect(screen.queryByTestId('bulk-action-bar')).toBeNull();

        // After 500ms — enters selection mode with item a selected
        act(() => { vi.advanceTimersByTime(1); });
        expect(screen.getByTestId('bulk-action-bar')).toBeTruthy();
    });

    it('long-press + move >10px cancels the long-press', () => {
        const events = [mkEvent('a', 100)];
        render(<HistoryView {...baseProps} events={events} />);

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        fireEvent.pointerMove(aRow, { clientX: 25, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(600); });

        expect(screen.queryByTestId('bulk-action-bar')).toBeNull();
    });

    it('clicking in selection mode toggles selection (not edit)', () => {
        const onEditEvent = vi.fn();
        const events = [mkEvent('a', 100), mkEvent('b', 200)];
        render(
            <HistoryView {...baseProps} events={events} onEditEvent={onEditEvent} />,
        );

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(500); });
        // Now in selection mode with 'a' selected.

        fireEvent.click(screen.getByTestId('event-row-b'));
        expect(onEditEvent).not.toHaveBeenCalled();
        // Both a and b should now be selected — check via delete button label
        expect(screen.getByTestId('btn-delete').getAttribute('aria-label')).toContain('2');
    });

    it('clicking outside selection mode triggers onEditEvent', () => {
        const onEditEvent = vi.fn();
        const events = [mkEvent('a', 100)];
        render(
            <HistoryView {...baseProps} events={events} onEditEvent={onEditEvent} />,
        );
        fireEvent.click(screen.getByTestId('event-row-a'));
        expect(onEditEvent).toHaveBeenCalledWith(events[0]);
    });

    it('range select: idle → awaitingAnchor → armed → range tick', () => {
        const events = [
            mkEvent('a', 100),
            mkEvent('b', 200),
            mkEvent('c', 300),
            mkEvent('d', 400),
            mkEvent('e', 500),
        ];
        render(<HistoryView {...baseProps} events={events} />);

        // Enter selection mode by long-pressing a
        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(500); });

        // Click range button → awaitingAnchor
        fireEvent.click(screen.getByTestId('btn-range'));
        // Click event-row-c → anchor becomes c, state becomes armed
        fireEvent.click(screen.getByTestId('event-row-c'));
        // Click event-row-e → range c..e ticked (3 items)
        fireEvent.click(screen.getByTestId('event-row-e'));

        // After range tick: a(1 from long-press) + c,d,e(3 from range) = 4
        expect(screen.getByTestId('btn-delete').getAttribute('aria-label')).toContain('4');
    });
});
