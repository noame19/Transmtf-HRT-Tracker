// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';

// Mock both contexts the banner touches.
vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string) => k,
        lang: 'zh',
    }),
}));

const showDialogMock = vi.fn(async () => 'confirm' as const);
vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({ showDialog: showDialogMock }),
}));

// Stub the Tauri invoke on window.
const invokeMock = vi.fn(async () => true);
beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
});
afterEach(() => {
    cleanup();
    invokeMock.mockClear();
    showDialogMock.mockClear();
    delete (window as any).__TAURI_INTERNALS__;
});

import WhitelistBanner from './WhitelistBanner';

describe('WhitelistBanner', () => {
    it('renders nothing when battery is ignored AND not on aggressive OEM', () => {
        const { container } = render(
            <WhitelistBanner batteryIgnored onAggressiveOem={false} onDismiss={() => {}} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders both steps when on aggressive OEM with battery not ignored', () => {
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem onDismiss={() => {}} />,
        );
        expect(screen.getByTestId('whitelist-banner')).toBeTruthy();
        expect(screen.getByTestId('whitelist-btn-battery')).toBeTruthy();
        expect(screen.getByTestId('whitelist-btn-autostart')).toBeTruthy();
    });

    it('hides the auto-start step on AOSP-like devices', () => {
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem={false} onDismiss={() => {}} />,
        );
        expect(screen.queryByTestId('whitelist-btn-autostart')).toBeNull();
        expect(screen.getByTestId('whitelist-btn-battery')).toBeTruthy();
    });

    it('shows shield icon when battery is already ignored (step 1 done)', () => {
        const { container } = render(
            <WhitelistBanner batteryIgnored onAggressiveOem onDismiss={() => {}} />,
        );
        // Battery step is done — button replaced by the ShieldCheck icon.
        expect(screen.queryByTestId('whitelist-btn-battery')).toBeNull();
        expect(container.querySelector('.text-emerald-500')).toBeTruthy();
    });

    it('clicking battery button invokes the Rust command', async () => {
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem={false} onDismiss={() => {}} />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('whitelist-btn-battery'));
        });
        expect(invokeMock).toHaveBeenCalledWith('request_ignore_battery_optimization');
    });

    it('clicking autostart button invokes the Rust command', async () => {
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem onDismiss={() => {}} />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('whitelist-btn-autostart'));
        });
        expect(invokeMock).toHaveBeenCalledWith('open_manufacturer_auto_start_settings');
    });

    it('dismiss button: shows confirm dialog and calls onDismiss only on confirm', async () => {
        const onDismiss = vi.fn();
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem={false} onDismiss={onDismiss} />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('whitelist-btn-dismiss'));
        });
        expect(showDialogMock).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('dismiss button: cancel in dialog does NOT call onDismiss', async () => {
        showDialogMock.mockResolvedValueOnce('cancel' as any);
        const onDismiss = vi.fn();
        render(
            <WhitelistBanner batteryIgnored={false} onAggressiveOem={false} onDismiss={onDismiss} />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('whitelist-btn-dismiss'));
        });
        expect(showDialogMock).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
    });
});
