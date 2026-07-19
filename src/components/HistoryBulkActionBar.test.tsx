// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import HistoryBulkActionBar from './HistoryBulkActionBar';

afterEach(() => cleanup());

describe('HistoryBulkActionBar', () => {
    it('renders nothing when visible is false', () => {
        const { container } = render(
            <HistoryBulkActionBar
                visible={false}
                selectedCount={0}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders 4 buttons when visible', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(screen.getByTestId('btn-select-all')).toBeTruthy();
        expect(screen.getByTestId('btn-range')).toBeTruthy();
        expect(screen.getByTestId('btn-cancel')).toBeTruthy();
        expect(screen.getByTestId('btn-delete')).toBeTruthy();
    });

    it('disables delete button when selectedCount is 0', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={0}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const deleteBtn = screen.getByTestId('btn-delete') as HTMLButtonElement;
        expect(deleteBtn.disabled).toBe(true);
    });

    it('disables delete button when range is armed or awaiting anchor', () => {
        const { rerender } = render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="awaitingAnchor"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect((screen.getByTestId('btn-delete') as HTMLButtonElement).disabled).toBe(true);

        rerender(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="armed"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect((screen.getByTestId('btn-delete') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables delete when idle and selectedCount > 0', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect((screen.getByTestId('btn-delete') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows selected count in delete button label', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={7}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const deleteBtn = screen.getByTestId('btn-delete');
        expect(deleteBtn.getAttribute('aria-label')).toContain('7');
    });

    it('invokes handlers on click', () => {
        const onSelectAll = vi.fn();
        const onArmRange = vi.fn();
        const onCancel = vi.fn();
        const onDelete = vi.fn();
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={2}
                rangeButtonState="idle"
                onSelectAll={onSelectAll}
                onArmRange={onArmRange}
                onCancel={onCancel}
                onDelete={onDelete}
            />,
        );
        fireEvent.click(screen.getByTestId('btn-select-all'));
        fireEvent.click(screen.getByTestId('btn-range'));
        fireEvent.click(screen.getByTestId('btn-cancel'));
        fireEvent.click(screen.getByTestId('btn-delete'));
        expect(onSelectAll).toHaveBeenCalledTimes(1);
        expect(onArmRange).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('applies animate-pulse class when awaitingAnchor', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={1}
                rangeButtonState="awaitingAnchor"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const rangeBtn = screen.getByTestId('btn-range');
        expect(rangeBtn.className).toContain('animate-pulse');
    });
});
