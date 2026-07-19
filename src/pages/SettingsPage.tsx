import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAuth } from '../contexts/AuthContext';
import { useAppData } from '../contexts/AppDataContext';
import { useTheme } from '../contexts/ThemeContext';
import { API_ORIGIN } from '../api/config';
import {
    Languages,
    Upload,
    Download,
    Copy,
    Trash2,
    Info,
    Github,
    AlertTriangle,
    AtSign,
    BarChart2,
    Settings as SettingsIcon,
    Palette,
    Moon,
    Sun,
    Bug,
    FileDown,
    User,
    ChevronRight,
    Send,
    Bell,
    BellOff,
} from 'lucide-react';

import { decryptData } from '../../logic';
import { computeDataHash } from '../utils/dataHash';
import { writeCustomGelProducts } from '../utils/doseForm';
import { isRecord, parseImportedBackup, importHasContent, importFallbackWeight } from '../utils/importData';
import { DEFAULT_WEIGHT_KG, latestEventWeight } from '../utils/weight';
import { APP_VERSION } from '../constants';
import CustomSelect from '../components/CustomSelect';
import CustomGelManager from '../components/CustomGelManager';
import ImportModal from '../components/ImportModal';
import PasswordInputModal from '../components/PasswordInputModal';
import ModelInfoModal from '../components/ModelInfoModal';
import DisclaimerModal from '../components/DisclaimerModal';
import StatisticsModal from '../components/StatisticsModal';
import AnnouncementModal from '../components/AnnouncementModal';
import ThemePicker from '../components/ui/ThemePicker';
import Toggle from '../components/ui/Toggle';
import type { Lang } from '../i18n/translations';
import flagCN from '../flag_svg/🇨🇳.svg';
import flagTW from '../flag_svg/🇹🇼.svg';
import flagUS from '../flag_svg/🇺🇸.svg';
import flagJP from '../flag_svg/🇯🇵.svg';

// The remaining synced settings (read from localStorage) so a locally-written
// data hash matches CloudSync's full snapshot hash and is never固化 incomplete.
const readExtraSyncFields = () => {
    const applyE2Raw = localStorage.getItem('hrt-apply-e2-learning-to-cpa');
    const applyCPARaw = localStorage.getItem('hrt-apply-cpa-inhibition-to-e2');
    const darkRaw = localStorage.getItem('hrt-dark-mode');
    return {
        calibrationModel: localStorage.getItem('hrt-calibration-model') || 'ekf',
        calibrationMode: localStorage.getItem('hrt-calibration-mode') || 'retrospective',
        applyE2LearningToCPA: applyE2Raw === '1' || applyE2Raw?.toLowerCase() === 'true',
        applyCPAInhibitionToE2: applyCPARaw === '1' || applyCPARaw?.toLowerCase() === 'true',
        themeColor: localStorage.getItem('hrt-theme-color') || 'sakura',
        darkMode: darkRaw === '1' || darkRaw === 'true',
    };
};

const SettingsPage: React.FC = () => {
    const [debugMode, setDebugMode] = useState<boolean>(
        () => localStorage.getItem('hrt-debug-mode') === '1'
    );
    const [logCount, setLogCount] = useState<number>(0);
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

    useEffect(() => {
        if (!isTauri || !debugMode) return;
        const id = setInterval(async () => {
            try {
                const invoke = window.__TAURI_INTERNALS__?.invoke;
                if (!invoke) return;
                const n = await invoke('get_log_count');
                setLogCount(typeof n === 'number' ? n : 0);
            } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(id);
    }, [debugMode, isTauri]);

    const handleToggleDebug = async (enabled: boolean) => {
        setDebugMode(enabled);
        localStorage.setItem('hrt-debug-mode', enabled ? '1' : '0');
        if (isTauri) {
            const invoke = window.__TAURI_INTERNALS__?.invoke;
            if (invoke) {
                try { await invoke('set_debug_mode', { enabled }); } catch { /* ignore */ }
            }
        }
    };

    const handleExportLogs = async () => {
        if (!isTauri) {
            showDialog('alert', t('settings.debug.web_unsupported') || 'Log export is only available in the Android APK.');
            return;
        }
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return;
        try {
            const path = await invoke('export_logs_to_download');
            showDialog('alert', `${t('settings.debug.exported_prefix') || 'Exported to'}: ${path}`);
        } catch (err) {
            showDialog('alert', `${err}`);
        }
    };

    /**
     * Toggle the Android notification channel. When the user enables
     * reminders we:
     *   1. Make sure the notification channel exists.
     *   2. Ask for POST_NOTIFICATIONS permission (Android 13+) — this is
     *      a runtime permission and only triggers a dialog the first time.
     *   3. Refresh the in-page permission state so the inline hint under
     *      the toggle can update.
     */
    const handleToggleReminders = async (enabled: boolean) => {
        setRemindersEnabled(enabled);
        if (!enabled) return;
        if (!isTauri) return; // web preview: just store the preference
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return;
        try {
            await invoke('ensure_notification_channel');
            const granted = await invoke<boolean>('request_notification_permission');
            setRemindersPermissionGranted(granted);
        } catch {
            /* command may not exist yet on web/dev — fail silently */
        }
    };

    /**
     * Re-check Android notification permission whenever reminders flip on
     * (or on mount, so users landing here from /history see the same hint).
     * We also expose a manual "open system settings" button for the case
     * where the user dismissed the system dialog and needs a deeper route
     * — invoking `request_notification_permission` on Android re-shows the
     * dialog when possible and is a no-op once it's permanently denied.
     */
    const [remindersPermissionGranted, setRemindersPermissionGranted] = useState<boolean | null>(null);
    useEffect(() => {
        if (!isTauri) {
            setRemindersPermissionGranted(null);
            return;
        }
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            setRemindersPermissionGranted(null);
            return;
        }
        let cancelled = false;
        const check = async () => {
            try {
                const granted = await invoke<boolean>('request_notification_permission');
                if (!cancelled) setRemindersPermissionGranted(granted);
            } catch {
                if (!cancelled) setRemindersPermissionGranted(null);
            }
        };
        check();
        return () => { cancelled = true; };
    }, [remindersEnabled]);

    const openNotificationSettings = async () => {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') return;
        try {
            const granted = await invoke<boolean>('request_notification_permission');
            setRemindersPermissionGranted(granted);
        } catch { /* ignore */ }
    };

    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const { remindersEnabled, setRemindersEnabled } = useAppData();
    const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
    const { events, setEvents, labResults, setLabResults, gelProducts, setGelProducts } = useAppData();
    const { isDark, setIsDark } = useTheme();
    const navigate = useNavigate();

    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
    const [isStatisticsOpen, setIsStatisticsOpen] = useState(false);
    const [isModelInfoOpen, setIsModelInfoOpen] = useState(false);
    const [isAnnouncementOpen, setIsAnnouncementOpen] = useState(false);
    const [pendingImportText, setPendingImportText] = useState<string | null>(null);

    const languageOptions = useMemo(() => ([
        { value: 'zh', label: '简体中文', icon: <img src={flagCN} alt="CN" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'zh-TW', label: '正體中文（台湾）', icon: <img src={flagTW} alt="TW" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'en', label: 'English', icon: <img src={flagUS} alt="US" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'ja', label: '日本語', icon: <img src={flagJP} alt="JP" className="w-5 h-5 rounded-sm object-contain" /> },
    ]), []);

    const processImportedData = (parsed: unknown): boolean => {
        try {
            const fallbackWeight = importFallbackWeight(parsed, DEFAULT_WEIGHT_KG);
            const { events: newEvents, labResults: newLabResults, gelProducts: newGelProducts, migratedCount } =
                parseImportedBackup(parsed, fallbackWeight);

            if (!importHasContent({ events: newEvents, labResults: newLabResults, gelProducts: newGelProducts, migratedCount })) {
                throw new Error('No valid entries');
            }

            const nextEvents = newEvents.length > 0 ? newEvents : events;
            const nextLabResults = newLabResults ?? labResults;

            if (newEvents.length > 0) {
                setEvents(newEvents);
                localStorage.setItem('hrt-events', JSON.stringify(newEvents));
                localStorage.setItem('hrt-weight', latestEventWeight(newEvents).toString());
            }

            // Only overwrite labs when the file actually carried a labResults
            // section; a gel-only / events-only backup leaves existing labs intact.
            if (newLabResults !== null) {
                setLabResults(newLabResults);
                localStorage.setItem('hrt-lab-results', JSON.stringify(newLabResults));
            }

            // Restore custom gel products so imported gel events resolve their real
            // kinetics instead of silently falling back to the default product.
            if (newGelProducts !== null) {
                setGelProducts(newGelProducts);
                writeCustomGelProducts(newGelProducts);
            }

            const lastModified = new Date().toISOString();
            localStorage.setItem('hrt-last-modified', lastModified);
            localStorage.setItem('hrt-last-data-updated', lastModified);
            const langValue = localStorage.getItem('hrt-lang') || lang;
            const dataHash = computeDataHash({
                events: nextEvents,
                weight: latestEventWeight(nextEvents),
                labResults: nextLabResults,
                lang: langValue,
                gelProducts: newGelProducts ?? gelProducts,
                ...readExtraSyncFields(),
            });
            localStorage.setItem('hrt-data-hash', dataHash);
            window.dispatchEvent(new CustomEvent('hrt-local-data-updated', { detail: { key: 'hrt-import', lastModified } }));

            if (migratedCount > 0) {
                showDialog('alert', t('migration.per_dose_weight'));
            } else {
                showDialog('alert', t('drawer.import_success'));
            }
            return true;
        } catch (error) {
            console.error(error);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const importEventsFromJson = async (text: string): Promise<boolean> => {
        try {
            const parsed: unknown = JSON.parse(text);
            const confirmKey = (isAuthenticated && !isAuthLoading) ? 'import.overwrite_confirm' : 'import.overwrite_confirm_local';
            const confirmation = await showDialog('confirm', t(confirmKey));
            if (confirmation !== 'confirm') {
                return false;
            }

            if (
                isRecord(parsed) &&
                Boolean(parsed.encrypted) &&
                typeof parsed.iv === 'string' &&
                typeof parsed.salt === 'string' &&
                typeof parsed.data === 'string'
            ) {
                setPendingImportText(text);
                setIsPasswordInputOpen(true);
                return true;
            }

            return processImportedData(parsed);
        } catch (error) {
            console.error(error);
            showDialog('alert', t('drawer.import_error'));
            return false;
        }
    };

    const handlePasswordSubmit = async (passwordInput: string) => {
        if (!pendingImportText) return;

        const decrypted = await decryptData(pendingImportText, passwordInput);
        if (!decrypted) {
            showDialog('alert', t('import.decrypt_error'));
            return;
        }

        setIsPasswordInputOpen(false);
        setPendingImportText(null);

        try {
            const parsed: unknown = JSON.parse(decrypted);
            processImportedData(parsed);
        } catch (error) {
            console.error(error);
            showDialog('alert', t('import.decrypt_error'));
        }
    };

    const handleQuickExport = () => {
        if (events.length === 0 && labResults.length === 0 && gelProducts.length === 0) {
            showDialog('alert', t('drawer.empty_export'));
            return;
        }

        const exportData = {
            meta: { version: 2, exportedAt: new Date().toISOString() },
            weight: latestEventWeight(events),
            events,
            labResults,
            gelProducts,
        };

        invoke('clipboard_write_text', { text: JSON.stringify(exportData, null, 2) }).then(() => {
            showDialog('alert', t('drawer.export_copied'));
        }).catch((error: any) => {
            const msg = error?.message || String(error);
            showDialog('alert', `${t('drawer.export_failed') || 'Copy failed'}: ${msg}`);
        });
    };

    const downloadFile = async (data: string, filename: string) => {
        try {
            // text 走 base64 编码（btoa + unescape(encodeURIComponent) 是 UTF-8 → base64 的老 trick，
            // 跨 Android WebView 兼容性最好）
            const b64 = btoa(unescape(encodeURIComponent(data)));
            const path = await invoke<string>('save_data_to_download', {
                subdir: 'HRT Tracker',
                filename,
                contentB64: b64,
            });
            showDialog('alert', t('drawer.export_saved').replace('{path}', path) || `已保存到 ${path}`);
        } catch (err: any) {
            console.error('Failed to save file:', err);
            // 透出真实错误（来自 Rust → JNI → Kotlin 链路），下次失败能直接定位根因
            const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'unknown';
            showDialog('alert', `${t('drawer.export_failed')}: ${msg}`);
        }
    };

    const handleExport = async () => {
        if (events.length === 0 && labResults.length === 0 && gelProducts.length === 0) {
            showDialog('alert', t('drawer.empty_export'));
            return;
        }
        const exportData = {
            meta: { version: 2, exportedAt: new Date().toISOString() },
            weight: latestEventWeight(events),
            events,
            labResults,
            gelProducts,
        };
        await downloadFile(JSON.stringify(exportData, null, 2), `hrt-dosages-${new Date().toISOString().split('T')[0]}.json`);
    };

    const handleClearAllEvents = () => {
        if (!events.length) return;

        showDialog('confirm', t('drawer.clear_confirm'), () => {
            setEvents([]);
            localStorage.setItem('hrt-events', JSON.stringify([]));
            const lastModified = new Date().toISOString();
            localStorage.setItem('hrt-last-modified', lastModified);
            localStorage.setItem('hrt-last-data-updated', lastModified);
            const langValue = localStorage.getItem('hrt-lang') || lang;
            const dataHash = computeDataHash({
                events: [],
                weight: DEFAULT_WEIGHT_KG,
                labResults,
                lang: langValue,
                gelProducts,
                ...readExtraSyncFields(),
            });
            localStorage.setItem('hrt-data-hash', dataHash);
            window.dispatchEvent(new CustomEvent('hrt-local-data-updated', { detail: { key: 'hrt-events', lastModified } }));
        });
    };

    const sectionTitleClass = "px-1 text-xs font-bold uppercase tracking-wider";

    return (
        <div className="min-h-full px-4 md:px-6 safe-area-pt md:pt-6 pb-6">
            <div className="mx-auto w-full max-w-2xl space-y-6">
                {/* Page title */}
                <div className="rounded-2xl glass-card glass-highlight relative overflow-hidden p-5">
                    <h1 className="flex items-center gap-2 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        <SettingsIcon size={24} style={{ color: 'var(--accent-500)' }} />
                        {t('nav.settings') || 'Settings'}
                    </h1>
                </div>

                {/* Appearance Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.appearance') || 'Appearance'}
                    </h2>
                    <div className="rounded-2xl glass-card p-5 space-y-5">
                        {/* Theme Color */}
                        <div>
                            <div className="flex items-start gap-3 mb-4">
                                <Palette size={20} style={{ color: 'var(--accent-500)' }} />
                                <div>
                                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.theme.title')}</p>
                                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.theme.desc')}</p>
                                </div>
                            </div>
                            <ThemePicker />
                        </div>

                        {/* Dark Mode */}
                        <div className="border-t pt-4" style={{ borderColor: 'var(--border-secondary)' }}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-start gap-3">
                                    {isDark ? <Moon size={20} style={{ color: 'var(--accent-500)' }} /> : <Sun size={20} style={{ color: 'var(--accent-500)' }} />}
                                    <div>
                                        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.theme.dark_mode')}</p>
                                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.theme.dark_mode_desc')}</p>
                                    </div>
                                </div>
                                <Toggle checked={isDark} onChange={setIsDark} />
                            </div>
                        </div>

                        {/* Language */}
                        <div className="border-t pt-4" style={{ borderColor: 'var(--border-secondary)' }}>
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-start gap-3 min-w-0">
                                    <Languages className="text-blue-500 shrink-0" size={20} />
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('drawer.lang')}</p>
                                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.lang_hint')}</p>
                                    </div>
                                </div>
                                <div className="w-28 shrink-0">
                                    <CustomSelect
                                        value={lang}
                                        onChange={(value) => setLang(value as Lang)}
                                        options={languageOptions}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Reminders */}
                        <div className="border-t pt-4" style={{ borderColor: 'var(--border-secondary)' }}>
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-start gap-3 min-w-0">
                                    {remindersEnabled
                                        ? <Bell className="text-amber-500 shrink-0" size={20} />
                                        : <BellOff className="text-slate-400 shrink-0" size={20} />}
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                            {t('settings.reminders.title') || '用药提醒'}
                                        </p>
                                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                            {t('settings.reminders.desc') || '到点时在 Android 通知栏弹出提示，点击可一键确认。'}
                                        </p>
                                    </div>
                                </div>
                                <Toggle checked={remindersEnabled} onChange={handleToggleReminders} />
                            </div>
                            {/* Permission hint — sits UNDER the toggle, not as a
                             *  full-width banner. Only shown when reminders are
                             *  toggled on AND the OS notification permission is
                             *  denied. We deliberately do NOT block the toggle
                             *  itself: users can still flip the switch and we
                             *  re-check on every render of this page. The
                             *  "去设置" button re-invokes the runtime permission
                             *  flow; on permanently-denied devices this reopens
                             *  the system app-info screen via the platform
                             *  shim. */}
                            {remindersEnabled && remindersPermissionGranted === false && (
                                <div
                                    role="alert"
                                    className="mt-3 rounded-xl px-3 py-2.5 flex items-start gap-2"
                                    style={{
                                        background: 'var(--bg-soft-rose)',
                                        border: '1px solid var(--border-soft-rose)',
                                    }}
                                >
                                    <AlertTriangle
                                        size={16}
                                        className="shrink-0 mt-0.5"
                                        style={{ color: 'var(--text-soft-rose)' }}
                                    />
                                    <div className="flex-1 min-w-0">
                                        <p
                                            className="text-xs leading-snug"
                                            style={{ color: 'var(--text-secondary)' }}
                                        >
                                            {t('settings.reminders.permission_denied') ||
                                                '通知权限未开启，提醒无法在通知栏弹出。请到系统设置中开启。'}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={openNotificationSettings}
                                        className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-bold btn-press-glass"
                                        style={{
                                            background: 'var(--bg-card)',
                                            color: 'var(--text-primary)',
                                            border: '1px solid var(--border-primary)',
                                        }}
                                    >
                                        {t('reminder.banner.open_settings') || '去设置'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Custom gels Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.gels') || 'Custom gels'}
                    </h2>
                    <CustomGelManager />
                </section>

                {/* Data Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.data') || 'Data Management'}
                    </h2>
                    <div className="overflow-hidden rounded-2xl glass-card divide-y divide-[var(--border-secondary)]">
                        <button
                            onClick={() => setIsImportModalOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-soft-rose)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Upload className="text-teal-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('import.title')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.import_hint')}</p>
                            </div>
                        </button>

                        <button
                            onClick={handleExport}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-soft-rose)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Download style={{ color: 'var(--accent-500)' }} size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('export.title')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.save_hint')}</p>
                            </div>
                        </button>

                        <button
                            onClick={handleQuickExport}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Copy className="text-blue-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.export_quick')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.export_quick_hint')}</p>
                            </div>
                        </button>

                        <button
                            onClick={handleClearAllEvents}
                            disabled={!events.length}
                            className={`flex w-full items-center gap-3 px-4 py-4 text-left transition ${
                                events.length ? 'btn-press-glass hover:bg-[var(--hover-bg-red)]' : 'cursor-not-allowed opacity-60'
                            }`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <Trash2 className="text-red-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.clear')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.clear_confirm')}</p>
                            </div>
                        </button>
                    </div>
                </section>

                {/* Account Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.account') || 'Account'}
                    </h2>
                    <div className="overflow-hidden rounded-2xl glass-card">
                        <button
                            onClick={() => navigate('/profile')}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-soft-rose)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <div className="h-12 w-12 rounded-full border-2 overflow-hidden flex-shrink-0"
                                style={{ borderColor: 'var(--border-primary)' }}>
                                {isAuthenticated && user?.avatarUrl ? (
                                    <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                                ) : isAuthenticated && user?.username ? (
                                    <img src={`${API_ORIGIN}/api/avatars/${user.username}`} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center"
                                        style={{ background: 'var(--bg-card-hover)' }}>
                                        <User size={22} style={{ color: 'var(--text-tertiary)' }} />
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold truncate">
                                    {isAuthenticated
                                        ? (user?.username || t('account.title') || 'Profile')
                                        : (t('account.notLoggedIn') || 'Not logged in')}
                                </p>
                                <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                                    {isAuthenticated
                                        ? (t('settings.account.manage') || 'Manage account, devices & sync')
                                        : (t('auth.loginPrompt') || 'Login to use cloud sync')}
                                </p>
                            </div>
                            <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} />
                        </button>
                    </div>
                </section>

                {/* Debug Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.debug') || 'Debug'}
                    </h2>
                    <div className="overflow-hidden rounded-2xl glass-card divide-y divide-[var(--border-secondary)]">
                        <div className="flex w-full items-center gap-3 px-4 py-4">
                            <Bug className="text-amber-500" size={20} />
                            <div className="flex-1">
                                <p className="text-sm font-bold">{t('settings.debug.title') || 'Debug mode'}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {t('settings.debug.desc') || 'Capture Rust + JS console + logcat; export to Download.'}
                                </p>
                            </div>
                            <Toggle checked={debugMode} onChange={handleToggleDebug} />
                        </div>
                        <button
                            onClick={handleExportLogs}
                            disabled={!debugMode || logCount === 0}
                            className={`flex w-full items-center gap-3 px-4 py-4 text-left transition ${
                                debugMode && logCount > 0 ? 'btn-press-glass' : 'cursor-not-allowed opacity-60'
                            }`}
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => { if (debugMode && logCount > 0) e.currentTarget.style.background = 'var(--bg-card-hover)'; }}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <FileDown className="text-emerald-500" size={20} />
                            <div className="flex-1">
                                <p className="text-sm font-bold">{t('settings.debug.export') || 'Export logs to Download'}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {(t('settings.debug.count_label') || '已捕获')} {logCount} {(t('settings.debug.count_unit') || '行')}
                                </p>
                            </div>
                        </button>
                    </div>
                </section>

                {/* About Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.about') || 'About'}
                    </h2>
                    <div className="overflow-hidden rounded-2xl glass-card divide-y divide-[var(--border-secondary)]">
                        <button
                            onClick={() => setIsModelInfoOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Info className="text-purple-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.model_title')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.model_desc')}</p>
                            </div>
                        </button>

                        <button
                            onClick={() => {
                                showDialog('confirm', t('drawer.github_confirm'), () => {
                                    window.open('https://github.com/TransmtfTeam/Transmtf-HRT-Tracker', '_blank');
                                });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Github size={20} style={{ color: 'var(--text-secondary)' }} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.github')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.github_desc')}</p>
                            </div>
                        </button>

                        <button
                            onClick={() => {
                                showDialog('confirm', t('drawer.contact_confirm'), () => {
                                    window.open('https://x.com/axzamyzed', '_blank');
                                });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <AtSign size={20} style={{ color: 'var(--text-secondary)' }} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.contact')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.contact_desc')}</p>
                            </div>
                        </button>

                        <button
                            onClick={() => setIsStatisticsOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <BarChart2 className="text-blue-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('statistics.title')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('statistics.desc')}</p>
                            </div>
                        </button>

                        <button
                            onClick={() => setIsDisclaimerOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <AlertTriangle className="text-amber-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.disclaimer')}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('drawer.disclaimer_desc')}</p>
                            </div>
                        </button>

                        <button
                            onClick={() => setIsAnnouncementOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <Send className="text-sky-500" size={20} />
                            <div>
                                <p className="text-sm font-bold">{t('drawer.community') || 'Telegram Community'}</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {t('drawer.community_desc') || 'Join notification channel & discussion group'}
                                </p>
                            </div>
                        </button>
                    </div>
                </section>

                <div className="pb-4 pt-2 text-center">
                    <p className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>{APP_VERSION}</p>
                </div>
            </div>

            <ImportModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onImportJson={importEventsFromJson}
            />

            <PasswordInputModal
                isOpen={isPasswordInputOpen}
                onClose={() => setIsPasswordInputOpen(false)}
                onConfirm={handlePasswordSubmit}
            />

            <DisclaimerModal
                isOpen={isDisclaimerOpen}
                onClose={() => setIsDisclaimerOpen(false)}
            />

            <ModelInfoModal
                isOpen={isModelInfoOpen}
                onClose={() => setIsModelInfoOpen(false)}
            />

            <StatisticsModal
                isOpen={isStatisticsOpen}
                onClose={() => setIsStatisticsOpen(false)}
            />

            <AnnouncementModal
                isOpen={isAnnouncementOpen}
                onClose={() => setIsAnnouncementOpen(false)}
            />
        </div>
    );
};

export default SettingsPage;
