import React, { useState } from 'react';
import { Battery, Power, X, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';

interface WhitelistBannerProps {
    /** Whether the app is currently in the battery optimization whitelist.
     *  false = banner shows the "disable battery optimization" step un-greyed. */
    batteryIgnored: boolean;
    /** Whether we're on a known aggressive-OEM ROM (MIUI/EMUI/ColorOS/VIVO/etc).
     *  Detected at boot via Build.MANUFACTURER + a static list. Pure-AOSP
     *  devices pass false here to skip the auto-start step. */
    onAggressiveOem: boolean;
    /** "已设置" click — persist a 'skipped-whitelist' flag so we don't pester
     *  the user again on every cold start. */
    onDismiss: () => void;
}

const WhitelistBanner: React.FC<WhitelistBannerProps> = ({
    batteryIgnored,
    onAggressiveOem,
    onDismiss,
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    const [busy, setBusy] = useState(false);

    // If everything is already in order, the banner should not be visible
    // at all — the parent is responsible for unmounting. Defensive guard
    // here in case the parent forgets (avoids the "all green, but still
    // showing the banner" footgun).
    if (batteryIgnored && !onAggressiveOem) return null;

    const invoke = (cmd: string) => {
        const fn = (window as any).__TAURI_INTERNALS__?.invoke;
        if (typeof fn === 'function') return fn(cmd);
        return Promise.reject(new Error('Tauri invoke not available'));
    };

    const handleBattery = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await invoke('request_ignore_battery_optimization');
            // We can't detect whether the user actually toggled it without
            // re-checking on next mount, so we just close the button. The
            // parent component re-evaluates `batteryIgnored` on next focus
            // and hides the banner if it's now true.
        } catch { /* ignore — user can try again */ }
        setBusy(false);
    };

    const handleAutostart = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await invoke('open_manufacturer_auto_start_settings');
        } catch { /* ignore */ }
        setBusy(false);
    };

    const handleDismiss = async () => {
        if (busy) return;
        const ok = await showDialog(
            'confirm',
            `${t('whitelist.skip_title')}\n\n${t('whitelist.skip_body')}`,
        );
        if (ok === 'confirm') {
            onDismiss();
        }
    };

    return (
        <div className="mx-4 rounded-2xl p-3 flex flex-col gap-2"
            style={{
                background: 'rgba(245,158,11,0.10)',
                border: '1px solid rgba(245,158,11,0.25)',
            }}
            data-testid="whitelist-banner">
            <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {t('whitelist.banner_title')}
                    </p>
                    <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {t('whitelist.banner_body')}
                    </p>
                </div>
            </div>

            {/* Step 1 — battery optimization */}
            <div className="flex items-center gap-2 mt-1">
                <Battery size={14} className={batteryIgnored ? 'text-emerald-500 shrink-0' : 'text-amber-500 shrink-0'} />
                <span className="text-[11px] flex-1"
                    style={{ color: batteryIgnored ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                    {t('whitelist.step1')}
                </span>
                {batteryIgnored ? (
                    <ShieldCheck size={14} className="text-emerald-500 shrink-0" />
                ) : (
                    <button
                        onClick={handleBattery}
                        disabled={busy}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold btn-press-glass transition"
                        style={{
                            background: 'var(--bg-card-hover)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-primary)',
                        }}
                        data-testid="whitelist-btn-battery"
                    >
                        {t('whitelist.btn_battery')}
                    </button>
                )}
            </div>

            {/* Step 2 — auto-start (only on aggressive-OEM ROMs) */}
            {onAggressiveOem && (
                <div className="flex items-center gap-2">
                    <Power size={14} className="text-amber-500 shrink-0" />
                    <span className="text-[11px] flex-1" style={{ color: 'var(--text-primary)' }}>
                        {t('whitelist.step2')}
                    </span>
                    <button
                        onClick={handleAutostart}
                        disabled={busy}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold btn-press-glass transition"
                        style={{
                            background: 'var(--bg-card-hover)',
                            color: 'var(--text-secondary)',
                            border: '1px solid var(--border-primary)',
                        }}
                        data-testid="whitelist-btn-autostart"
                    >
                        {t('whitelist.btn_autostart')}
                    </button>
                </div>
            )}

            <div className="flex justify-end mt-1">
                <button
                    onClick={handleDismiss}
                    disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold btn-press-glass transition"
                    style={{ color: 'var(--text-tertiary)' }}
                    data-testid="whitelist-btn-dismiss"
                >
                    <X size={12} />
                    <span>{t('whitelist.btn_dismiss')}</span>
                </button>
            </div>
        </div>
    );
};

export default WhitelistBanner;
