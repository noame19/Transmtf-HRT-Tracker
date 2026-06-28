import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('consoleBridge', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is a no-op when debug mode is OFF', async () => {
        const invoke = vi.fn();
        vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
        localStorage.setItem('hrt-debug-mode', '0');
        await import('./consoleBridge');
        // @ts-expect-error
        console.log('hello');
        // @ts-expect-error
        console.error('boom');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('forwards to invoke when debug mode is ON', async () => {
        const invoke = vi.fn();
        vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
        localStorage.setItem('hrt-debug-mode', '1');
        await import('./consoleBridge');
        // @ts-expect-error
        console.log('hello');
        expect(invoke).toHaveBeenCalledWith('append_log', { level: 'INFO', msg: expect.stringContaining('hello') });
    });
});
