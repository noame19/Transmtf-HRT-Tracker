import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useAuth } from '../contexts/AuthContext';
import { useAppData } from '../contexts/AppDataContext';
import { useTheme } from '../contexts/ThemeContext';
import { THEME_PRESETS, type ThemeColorId } from '../contexts/ThemeContext';
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
    ChevronDown,
    Send,
    Bell,
    BellOff,
    BatteryCharging,
    Power,
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
import BasicInfoModal, { loadBasicInfo, saveBasicInfo, earliestEventHrtDate, type BasicInfo } from '../components/BasicInfoModal';
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

/**
 * 基础信息设置项 — 点击后弹出 BasicInfoModal 编辑表单。
 * 列表副标题用静态描述(`settings.basic.desc`),与其它设置项风格一致,
 * 不在列表行直接暴露具体填写值(避免过敏文本溢出截断 / 隐私意外泄露)。
 */

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
            const result = await invoke<{ uri: string; displayPath: string; mime: string }>(
                'export_logs_to_download',
            );
            showDialog(
                'alert',
                `${t('settings.debug.exported_prefix') || 'Exported to'} ${result.displayPath}`,
                {
                    messageNode: (
                        <>
                            {`${t('settings.debug.exported_prefix') || 'Exported to'} `}
                            <a
                                role="button"
                                className="underline cursor-pointer break-all"
                                style={{ color: 'var(--accent-primary, #ec4899)' }}
                                onClick={() => {
                                    if (!isTauri) return;
                                    invoke('open_with_system', {
                                        uri: result.uri,
                                        mime: result.mime,
                                    }).catch((e) => {
                                        console.error('open_with_system failed', e);
                                    });
                                }}
                            >
                                {result.displayPath}
                            </a>
                        </>
                    ),
                },
            );
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
     *   3. If the user denies the permission, surface an alert so they
     *      know reminders won't fire even though the toggle is on.
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
            if (!granted) {
                showDialog(
                    'alert',
                    t('settings.reminders.permission_denied') ||
                    '通知权限未开启，提醒无法在通知栏弹出。请到系统设置中开启。',
                );
            }
        } catch {
            /* command may not exist yet on web/dev — fail silently */
        }
    };

    const { t, lang, setLang } = useTranslation();
    const { showDialog } = useDialog();
    const {
        events, setEvents,
        labResults, setLabResults,
        gelProducts, setGelProducts,
        plans, setPlans,
        remindersEnabled, setRemindersEnabled,
        postponeLog, setPostponeLog,
        dueLog, setDueLog,
        applyE2LearningToCPA, setApplyE2LearningToCPA,
        applyCPAInhibitionToE2, setApplyCPAInhibitionToE2,
        calibrationModel, setCalibrationModel,
        calibrationMode, setCalibrationMode,
    } = useAppData();

    /**
     * Battery-optimization row state. `null` = "haven't checked yet"
     * (loading or web preview); `true` = app is whitelisted / unrestricted;
     * `false` = still subject to doze, reminders may be delayed. We re-check
     * on mount and after the user returns from the system settings page,
     * because they could have flipped the toggle there.
     */
    const [batteryOptIgnored, setBatteryOptIgnored] = useState<boolean | null>(null);
    const [batteryOptBusy, setBatteryOptBusy] = useState(false);
    const refreshBatteryOptStatus = useCallback(async () => {
        if (!isTauri) {
            setBatteryOptIgnored(null);
            return;
        }
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            setBatteryOptIgnored(null);
            return;
        }
        try {
            const ignored = await invoke<boolean>('is_battery_optimization_ignored');
            setBatteryOptIgnored(ignored);
        } catch {
            setBatteryOptIgnored(null);
        }
    }, []);

    useEffect(() => {
        refreshBatteryOptStatus();
    }, [refreshBatteryOptStatus]);

    /**
     * Re-check battery-optimization status whenever the WebView regains
     * focus. This is the critical fallback for the "user changed the
     * toggle in the system settings and came back to the app" path —
     * the post-jump setTimeout() only covers an immediate back-press;
     * if the user lingers in system settings, switches apps, or even
     * kills+relaunches, this listener will still fire on the next
     * visible transition and update the Power icon colour.
     *
     * We skip the refresh while a jump is in flight (batteryOptBusy)
     * to avoid clobbering the busy state with stale data.
     */
    useEffect(() => {
        if (typeof document === 'undefined') return;
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (batteryOptBusy) return;
            refreshBatteryOptStatus();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [refreshBatteryOptStatus, batteryOptBusy]);

    /**
     * Open the system battery-optimization settings page, then refresh
     * the toggle when the page regains focus. Some OEM ROMs (MIUI/EMUI)
     * use a separate "auto-start" page that we ALSO open as a follow-up,
     * because doze alone isn't enough on those skins. Note: the
     * `visibilitychange` listener above is the durable fallback for
     * users who don't return to the app immediately — this setTimeout
     * only covers the "instant back-press" path.
     */
    const openBatteryOptSettings = async () => {
        if (!isTauri) return;
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') return;
        setBatteryOptBusy(true);
        try {
            await invoke('request_ignore_battery_optimization');
        } catch { /* ignore */ }
        // Re-check status shortly after — user returns from the settings
        // page via the back button, at which point Android reports the
        // new whitelist state. 600ms is generous for the round-trip.
        window.setTimeout(() => {
            refreshBatteryOptStatus();
            setBatteryOptBusy(false);
        }, 600);
    };

    // 当 Power 图标显示为绿色（已加入系统白名单）时，点击该选项会弹一个
    // 破坏性确认对话框 —— 用户明确点确认后才跳转到系统电池优化页面，
    // 让用户主动移除白名单。这样避免误点「已绿色状态」就直接跳系统设置，
    // 也提醒用户「移除白名单 = 用药通知可能延迟」。
    const handleBatteryOptClick = async () => {
        if (!isTauri || batteryOptBusy) return;
        if (batteryOptIgnored === true) {
            const ok = await showDialog(
                'confirm',
                t('settings.battery_opt.remove_confirm') ||
                '移除电池优化白名单后，可能无法准时收到用药通知提醒，仍要移除？',
            );
            if (ok !== 'confirm') return;
        }
        openBatteryOptSettings();
    };

    const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
    const { isDark, setIsDark, themeColor, setThemeColor } = useTheme();
    const navigate = useNavigate();

    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isPasswordInputOpen, setIsPasswordInputOpen] = useState(false);
    const [isDisclaimerOpen, setIsDisclaimerOpen] = useState(false);
    const [isStatisticsOpen, setIsStatisticsOpen] = useState(false);
    const [isModelInfoOpen, setIsModelInfoOpen] = useState(false);
    const [isAnnouncementOpen, setIsAnnouncementOpen] = useState(false);
    const [isBasicInfoOpen, setIsBasicInfoOpen] = useState(false);
    const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
    const [basicInfo, setBasicInfo] = useState<BasicInfo>(() => loadBasicInfo());
    const [pendingImportText, setPendingImportText] = useState<string | null>(null);

    const languageOptions = useMemo(() => ([
        { value: 'zh', label: '简体中文', icon: <img src={flagCN} alt="CN" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'zh-TW', label: '正體中文（台湾）', icon: <img src={flagTW} alt="TW" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'en', label: 'English', icon: <img src={flagUS} alt="US" className="w-5 h-5 rounded-sm object-contain" /> },
        { value: 'ja', label: '日本語', icon: <img src={flagJP} alt="JP" className="w-5 h-5 rounded-sm object-contain" /> },
    ]), []);

    /**
     * Apply a backup payload onto the live app state. Every v3 section is
     * strictly opt-in: `null` means "the backup did not carry this section,
     * leave the device's local state alone". Sections present but EMPTY
     * (e.g. `plans: []`) are applied as-is so a user can clear a stale list
     * by re-importing a clean backup.
     *
     * Each setter goes through the matching context provider so its
     * `useEffect`-driven localStorage sync takes care of persistence; we
     * only re-write `hrt-events` / `hrt-lab-results` keys explicitly because
     * those flows have additional bookkeeping (per-dose weight migration,
     * legacy `hrt-weight` mirror).
     */
    const processImportedData = (parsed: unknown): boolean => {
        try {
            const fallbackWeight = importFallbackWeight(parsed, DEFAULT_WEIGHT_KG);
            const parsedImport = parseImportedBackup(parsed, fallbackWeight);
            const {
                events: newEvents,
                labResults: newLabResults,
                gelProducts: newGelProducts,
                plans: newPlans,
                postponeLog: newPostponeLog,
                dueLog: newDueLog,
                prefs: newPrefs,
                calibration: newCalibration,
                migratedCount,
            } = parsedImport;

            if (!importHasContent(parsedImport)) {
                throw new Error('No valid entries');
            }

            const nextEvents = newEvents.length > 0 ? newEvents : events;
            const nextLabResults = newLabResults ?? labResults;
            const nextGelProducts = newGelProducts ?? gelProducts;
            const nextPlans = newPlans ?? plans;
            const nextPostponeLog = newPostponeLog ?? postponeLog;
            const nextDueLog = newDueLog ?? dueLog;

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

            // v3 sections ────────────────────────────────────────────────
            // Replace plan list verbatim when present. `setPlans` enforces
            // conflict rules, so an orphan (ester, route, enabled) tuple in
            // the import can't put the user into an inconsistent state.
            if (newPlans !== null) {
                setPlans(newPlans);
            }
            // Frozen compliance / postpone history — replacing, not merging,
            // because IDs were already UUIDs from the source device; merging
            // would silently double-count on the new device.
            if (newPostponeLog !== null) setPostponeLog(newPostponeLog);
            if (newDueLog !== null) setDueLog(newDueLog);

            // Calibration + global reminder toggle. Each setter's useEffect
            // already rewrites the matching localStorage key.
            if (newCalibration !== null) {
                if (newCalibration.model !== undefined) setCalibrationModel(newCalibration.model);
                if (newCalibration.mode !== undefined) setCalibrationMode(newCalibration.mode);
                if (newCalibration.applyE2LearningToCPA !== undefined) setApplyE2LearningToCPA(newCalibration.applyE2LearningToCPA);
                if (newCalibration.applyCPAInhibitionToE2 !== undefined) setApplyCPAInhibitionToE2(newCalibration.applyCPAInhibitionToE2);
            }

            // Reminders toggle lives outside calibration for historical reasons
            // (it predates the prefs block in the Settings UI). Apply via the
            // same setter the toggle row uses so the Android side re-syncs on
            // its next effect tick.
            if (newPrefs !== null) {
                if (newPrefs.remindersEnabled !== undefined) setRemindersEnabled(newPrefs.remindersEnabled);
                // Theme + lang live in their own contexts; their setters'
                // useEffects write hrt-theme-color / hrt-lang / hrt-dark-mode
                // and refire the FOUC-safe early-bird in index.html on reload.
                if (newPrefs.lang !== undefined) setLang(newPrefs.lang as typeof lang);
                if (newPrefs.themeColor !== undefined) setThemeColor(newPrefs.themeColor as typeof themeColor);
                if (newPrefs.darkMode !== undefined) setIsDark(newPrefs.darkMode);
            }

            const lastModified = new Date().toISOString();
            localStorage.setItem('hrt-last-modified', lastModified);
            localStorage.setItem('hrt-last-data-updated', lastModified);
            // Data hash must reflect the post-apply state so cloud-sync's
            // "did anything change?" check doesn't spuriously re-upload.
            const langForHash = newPrefs?.lang ?? localStorage.getItem('hrt-lang') ?? lang;
            const themeColorForHash = newPrefs?.themeColor ?? localStorage.getItem('hrt-theme-color') ?? themeColor;
            const darkModeForHash = newPrefs?.darkMode ?? isDark;
            const remindersForHash = newPrefs?.remindersEnabled ?? remindersEnabled;
            const calibrationModelForHash = newCalibration?.model ?? calibrationModel;
            const calibrationModeForHash = newCalibration?.mode ?? calibrationMode;
            const applyE2LearningForHash = newCalibration?.applyE2LearningToCPA ?? applyE2LearningToCPA;
            const applyCPAInhibitionForHash = newCalibration?.applyCPAInhibitionToE2 ?? applyCPAInhibitionToE2;
            const dataHash = computeDataHash({
                events: nextEvents,
                weight: latestEventWeight(nextEvents),
                labResults: nextLabResults,
                lang: langForHash,
                calibrationModel: calibrationModelForHash,
                calibrationMode: calibrationModeForHash,
                applyE2LearningToCPA: applyE2LearningForHash,
                applyCPAInhibitionToE2: applyCPAInhibitionForHash,
                themeColor: themeColorForHash,
                darkMode: darkModeForHash,
                gelProducts: nextGelProducts,
                plans: nextPlans,
                remindersEnabled: remindersForHash,
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

    /**
     * Snapshot every section that can be migrated to another device. v3 schema
     * is intentionally a SUPERSET of v2's top-level keys (weight / events /
     * labResults / gelProducts) — older readers still recognise the v2 keys,
     * while a v3-aware importer picks up the prefs / calibration / plans /
     * reminderLog blocks too. Keep `meta.version` bumped; the importer uses
     * it to dispatch to the right parser.
     *
     * `personalModel` is intentionally omitted: events + labResults are the
     * authoritative inputs, and `replayPersonalModel` rebuilds the EKF from
     * scratch after import. Shipping the trained theta only saves ~1s on a
     * warm cache and risks diverging from a stale `labResults` set.
     */
    const buildExportPayload = (): string => {
        const exportData = {
            meta: {
                version: 3,
                schema: 'hrt-tracker-v3',
                exportedAt: new Date().toISOString(),
            },
            // —— v2-compatible top-level keys ——
            weight: latestEventWeight(events),
            events,
            labResults,
            gelProducts,
            // —— v3 sections ——
            prefs: {
                lang,
                themeColor,
                darkMode: isDark,
                remindersEnabled,
            },
            calibration: {
                model: calibrationModel,
                mode: calibrationMode,
                applyE2LearningToCPA,
                applyCPAInhibitionToE2,
            },
            plans,
            reminderLog: {
                postponeLog,
                dueLog,
            },
        };
        return JSON.stringify(exportData, null, 2);
    };

    const handleQuickExport = () => {
        if (events.length === 0 && labResults.length === 0 && gelProducts.length === 0) {
            showDialog('alert', t('drawer.empty_export'));
            return;
        }
        const payload = buildExportPayload();

        // ── Web fallback: navigator.clipboard. Android 走原 invoke 路径，行为不变。
        if (!isTauri) {
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(payload).then(
                    () => showDialog('alert', t('drawer.export_copied')),
                    (err: any) => {
                        const msg = err?.message || String(err);
                        showDialog('alert', `${t('drawer.export_failed') || 'Copy failed'}: ${msg}`);
                    }
                );
            } else {
                showDialog('alert', t('drawer.export_failed') || 'Copy failed: clipboard not supported');
            }
            return;
        }

        invoke('clipboard_write_text', { text: payload }).then(() => {
            showDialog('alert', t('drawer.export_copied'));
        }).catch((error: any) => {
            const msg = error?.message || String(error);
            showDialog('alert', `${t('drawer.export_failed') || 'Copy failed'}: ${msg}`);
        });
    };

    const downloadFile = async (data: string, filename: string) => {
        // ── Web fallback: Blob + <a download>. Android 走原 invoke 路径，行为不变。
        if (!isTauri) {
            try {
                const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                showDialog(
                    'alert',
                    t('drawer.export_saved').replace('{path}', filename) || `已保存 ${filename}`
                );
            } catch (err: any) {
                const msg = err?.message || String(err) || 'unknown';
                showDialog('alert', `${t('drawer.export_failed')}: ${msg}`);
            }
            return;
        }
        try {
            // text 走 base64 编码（btoa + unescape(encodeURIComponent) 是 UTF-8 → base64 的老 trick，
            // 跨 Android WebView 兼容性最好）
            const b64 = btoa(unescape(encodeURIComponent(data)));
            const result = await invoke<{ uri: string; displayPath: string; mime: string }>(
                'save_data_to_download',
                {
                    subdir: 'HRT Tracker',
                    filename,
                    contentB64: b64,
                },
            );
            // 弹窗提示：「已保存到 <可点击的路径>」—— 点击路径调用系统 Intent
            // 让用户选 app 打开（系统文件管理器 / 微信传输助手 / WPS 等）。
            // 仅 Android 端：Tauri 这条路径必返回结构体，web 走更早的 <a download> blob 分支。
            showDialog(
                'alert',
                t('drawer.export_saved').replace('{path}', result.displayPath)
                    || `已保存到 ${result.displayPath}`,
                {
                    messageNode: (
                        <>
                            {'已保存到 '}
                            <a
                                role="button"
                                className="underline cursor-pointer break-all"
                                style={{ color: 'var(--accent-primary, #ec4899)' }}
                                onClick={() => {
                                    if (!isTauri) return;
                                    invoke('open_with_system', {
                                        uri: result.uri,
                                        mime: result.mime,
                                    }).catch((e) => {
                                        console.error('open_with_system failed', e);
                                    });
                                }}
                            >
                                {result.displayPath}
                            </a>
                        </>
                    ),
                },
            );
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
        await downloadFile(
            buildExportPayload(),
            `hrt-dosages-${new Date().toISOString().split('T')[0]}.json`
        );
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

                {/* Basic Info Section — treatment route / birth / height / allergies / HRT start.
                 *  Click the row to open the BasicInfoModal form. The description under the title
                 *  shows a short summary of currently stored values, or "未设置" if empty, so users
                 *  can tell at a glance whether they've already filled this in. */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.basic') || '基础信息'}
                    </h2>
                    <div className="overflow-hidden rounded-2xl glass-card">
                        <button
                            onClick={() => setIsBasicInfoOpen(true)}
                            className="flex w-full items-center gap-3 px-4 py-4 text-left transition btn-press-glass"
                            style={{ color: 'var(--text-primary)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-soft-rose)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <User className="text-pink-500 shrink-0" size={20} />
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold">{t('settings.basic.title')}</p>
                            </div>
                            <ChevronRight size={18} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />
                        </button>
                    </div>
                </section>

                {/* Appearance Section */}
                <section className="space-y-2">
                    <h2 className={sectionTitleClass} style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.group.appearance') || 'Appearance'}
                    </h2>
                    <div className="rounded-2xl glass-card p-5 space-y-5">
                        {/* Theme Color — 折叠卡。折叠时右侧显示当前主题色块 + 名称;
                 *  点击整行展开内联颜色选择器。展开后箭头旋转 90°。
                 *  切换主题色不改变展开状态,符合用户预期。
                 *
                 *  这里用 div + role="button" 而不是 <button>,因为展开状态下
                 *  内嵌 ThemePicker 的色块按钮也是 <button>,而 <button>
                 *  嵌套在 HTML 中无效,部分浏览器会自动修正 DOM 破坏事件处理。 */}
                        <div>
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => setIsThemePickerOpen(v => !v)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setIsThemePickerOpen(v => !v);
                                    }
                                }}
                                aria-expanded={isThemePickerOpen}
                                aria-controls="theme-picker-panel"
                                className="flex w-full items-center gap-3 text-left transition btn-press-glass"
                            >
                                <Palette size={20} style={{ color: 'var(--accent-500)' }} className="shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.theme.title')}</p>
                                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.theme.desc')}</p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <span
                                        className="w-5 h-5 rounded-full shadow-sm"
                                        style={{
                                            background: `linear-gradient(135deg, ${THEME_PRESETS[themeColor].colors[400]}, ${THEME_PRESETS[themeColor].colors[500]})`,
                                        }}
                                        aria-hidden="true"
                                    />
                                    <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                        {THEME_PRESETS[themeColor].zh}
                                    </span>
                                    <ChevronDown
                                        size={16}
                                        style={{
                                            color: 'var(--text-tertiary)',
                                            transform: isThemePickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                            transition: 'transform 0.2s ease',
                                        }}
                                        aria-hidden="true"
                                    />
                                </div>
                            </div>
                            {isThemePickerOpen && (
                                <div id="theme-picker-panel" className="mt-4 pl-8">
                                    <ThemePicker />
                                </div>
                            )}
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
                        </div>

                        {/* Battery optimization whitelist — a sibling row to the
                         *  reminders toggle. This is the "doze / not optimized"
                         *  system setting; Android periodically suspends apps
                         *  in Doze mode which delays our AlarmManager reminders
                         *  by minutes-to-hours. Tapping the row opens the
                         *  system battery-optimization settings page so the
                         *  user can whitelist us. The toggle on the right is
                         *  read-only and reflects the live status (true =
                         *  whitelisted / not optimized, false = still subject
                         *  to doze). Tapping anywhere on the row opens the
                         *  settings page — we don't expose a separate
                         *  "go to settings" button because the row itself is
                         *  the affordance.
                         *
                         *  Implementation note: the row used to be a <button>,
                         *  but the inner Toggle is itself a <button>, and
                         *  nested <button> is invalid HTML (browsers
                         *  "auto-fix" the DOM, which breaks click handling +
                         *  a11y). The row is now a div with role="button" +
                         *  keyboard handlers, keeping click + Tab + Enter. */}
                        <div className="border-t pt-4" style={{ borderColor: 'var(--border-secondary)' }}>
                            <div
                                role="button"
                                tabIndex={(!isTauri || batteryOptBusy) ? -1 : 0}
                                onClick={() => { if (!(!isTauri || batteryOptBusy)) handleBatteryOptClick(); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        if (!(!isTauri || batteryOptBusy)) handleBatteryOptClick();
                                    }
                                }}
                                aria-disabled={!isTauri || batteryOptBusy}
                                aria-label={t('settings.battery_opt.title') || '关闭系统电池优化'}
                                className={`flex w-full items-center justify-between gap-3 text-left transition btn-press-glass ${(!isTauri || batteryOptBusy) ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                            >
                                <div className="flex items-start gap-3 min-w-0">
                                    <BatteryCharging
                                        className="shrink-0 mt-0.5"
                                        size={20}
                                        style={{ color: batteryOptIgnored === false ? '#f59e0b' : '#10b981' }}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                            {t('settings.battery_opt.title') || '关闭系统电池优化'}
                                        </p>
                                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                            {batteryOptIgnored === true
                                                ? (t('settings.battery_opt.whitelisted_desc') || '已进入系统白名单，可准时推送用药提醒')
                                                : (t('settings.battery_opt.desc') || '关闭电池优化，允许本应用在 Android 通知栏提醒用药。')}
                                        </p>
                                    </div>
                                </div>
                                {/* 右侧 Power 图标：灰色=未加入白名单，绿色=已加入白名单。
                                 * 绿色状态下再点击会触发确认对话框（handleBatteryOptClick）。 */}
                                <Power
                                    className="shrink-0"
                                    size={22}
                                    style={{ color: batteryOptIgnored === true ? '#10b981' : '#9ca3af' }}
                                />
                            </div>
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

            <BasicInfoModal
                isOpen={isBasicInfoOpen}
                initial={basicInfo}
                // 第一次打开时,如果用户没填过 HRT 开始日期,弹窗的
                // 日期输入框预填「最早用药日期」作为推荐值;确认即保存,
                // 改写或清空都尊重用户操作。仅在 hrtStart 为 null 时生效,
                // 已填过值的人不会再被预填覆盖。
                defaultHrtStart={basicInfo.hrtStart ?? earliestEventHrtDate(events)}
                onClose={() => setIsBasicInfoOpen(false)}
                onSave={(next) => {
                    setBasicInfo(next);
                    saveBasicInfo(next);
                    // 让 Overview 的 MedicationHeatmap 在不重挂载的情况下
                    // 立刻拿到新的 HRT 开始日期并刷新「开始HRT」KPI。
                    window.dispatchEvent(new CustomEvent('hrt-local-data-updated', {
                        detail: { key: 'hrt-basic-info' },
                    }));
                }}
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
