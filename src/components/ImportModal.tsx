import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { X, Upload, History, ClipboardPaste } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useConfirmButton } from '../hooks/useConfirmButton';
import ConfirmButton from './ConfirmButton';
import CustomSelect from './CustomSelect';
import {
    BACKUP_SUBDIR,
    parseBackupTimestamp,
} from '../utils/backup';

interface BackupEntry {
    filename: string;
    /** Filename-parsed timestamp (the auto-backup convention embeds the
     *  backup time in the name itself). `null` for non-matching files
     *  that we filtered out before reaching the dropdown. */
    timestamp: Date | null;
    modifiedAtMs: number;
    sizeBytes: number;
}

/**
 * Horizontal "OR" separator that groups the three import actions into
 * three visually distinct pickers (auto-backup restore | clipboard |
 * file). Two of these sit between the cards; reusing one definition keeps
 * the styling identical if we ever tweak the line weight or colour.
 */
const SectionDivider = () => (
    <div className="relative flex py-2 items-center">
        <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
        <span className="flex-shrink-0 mx-4 text-xs uppercase font-bold" style={{ color: 'var(--text-tertiary)' }}>OR</span>
        <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
    </div>
);

/**
 * Where the JSON text being imported came from. Used by the parent to
 * decide whether to write a `pre-import` auto-backup before overwriting
 * current data — `restore` skips the backup because the operation is
 * itself a rollback (writing yet another pre-backup would just pollute
 * the restore list).
 */
export type ImportSource = 'restore' | 'clipboard' | 'file';

const ImportModal = ({
    isOpen,
    onClose,
    onImportJson,
    isTauri,
}: {
    isOpen: boolean;
    onClose: () => void;
    onImportJson: (text: string, source: ImportSource) => Promise<boolean>;
    /** True when running inside the Tauri Android runtime. The
     *  auto-backup restore section is hidden entirely on web — the
     *  browser sandbox can't list the user's Downloads folder, so
     *  the dropdown would always be empty there. */
    isTauri: boolean;
}) => {
    const { t, lang } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [clipboardError, setClipboardError] = useState<string | null>(null);
    const [clipboardBusy, setClipboardBusy] = useState(false);

    // ── Backup restore section state ──────────────────────────────────
    // `null` = haven't tried to load yet (modal just opened).
    // `[]`   = loaded successfully, no backups exist.
    // array  = loaded, contains entries (newest first).
    const [backups, setBackups] = useState<BackupEntry[] | null>(null);
    const [backupsLoading, setBackupsLoading] = useState(false);
    const [backupsError, setBackupsError] = useState<string | null>(null);
    const [selectedBackup, setSelectedBackup] = useState<string>('');
    const [restoreBusy, setRestoreBusy] = useState(false);
    const [restoreError, setRestoreError] = useState<string | null>(null);
    const { pending: restorePending, request: requestRestore, reset: resetRestore } = useConfirmButton();

    useEffect(() => {
        if (isOpen) {
            setClipboardError(null);
            setRestoreError(null);
        }
    }, [isOpen]);

    /**
     * Fetch the auto-backup file list from the Tauri/Android side.
     * Filters to filenames matching `hrt-backup-pre-{import|clear}-*.json`
     * so manual exports never appear in the restore dropdown. Sorted
     * newest-first so the most recent snapshot is the default option.
     *
     * Failures (Kotlin side error, missing class, etc.) are surfaced as
     * inline text rather than a dialog — the dropdown is a utility,
     * not a destructive action.
     */
    const refreshBackups = useCallback(async () => {
        if (!isTauri) return;
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            setBackupsError('Tauri runtime not available');
            return;
        }
        setBackupsLoading(true);
        setBackupsError(null);
        try {
            const rows = await invoke<Array<{
                filename: string;
                modifiedAtMs: number;
                sizeBytes: number;
            }>>('list_download_files', { subdir: BACKUP_SUBDIR });
            const entries: BackupEntry[] = rows
                .map((r) => ({
                    filename: r.filename,
                    timestamp: parseBackupTimestamp(r.filename),
                    modifiedAtMs: r.modifiedAtMs,
                    sizeBytes: r.sizeBytes,
                }))
                .filter((e) => e.timestamp !== null)
                .sort((a, b) => (b.timestamp!.getTime() - a.timestamp!.getTime()));
            setBackups(entries);
            // Default-select the newest backup so the user just has to
            // tap the Restore button twice.
            setSelectedBackup((prev) => prev || (entries[0]?.filename ?? ''));
        } catch (err) {
            console.warn('list_download_files failed', err);
            setBackupsError(
                t('import.backup.fetch_error') || '读取备份列表失败',
            );
        } finally {
            setBackupsLoading(false);
        }
    }, [isTauri, t]);

    // Auto-refresh when the modal opens on Tauri. Two triggers:
    //   1. First open ever → `backups === null` (haven't tried yet).
    //   2. Re-open after at least 30 s → a fresh listing may exist (the
    //      user might have cleared all records or had a new auto-backup
    //      created since the last open). Ref-gated so we don't re-fetch
    //      on every render / focus tick.
    // We DON'T fire on `isOpen` flip alone because that would spam the
    // native bridge if the user is just typing into the paste textarea
    // while the modal is open (rapid re-renders). 30 s covers the
    // practical "user just left the app to clear records / import" case.
    const lastBackupsFetchAtMs = useRef<number>(0);
    useEffect(() => {
        if (!isOpen || !isTauri) return;
        const now = Date.now();
        const stale = now - lastBackupsFetchAtMs.current > 30_000;
        if (backups === null || stale) {
            lastBackupsFetchAtMs.current = now;
            refreshBackups();
        }
    }, [isOpen, isTauri, backups, refreshBackups]);

    /**
     * Restore handler bound to the ConfirmButton. Two-tap confirmation:
     *   1. first tap  → `pending=true`, button switches to solid colour
     *   2. second tap → actually read the file + pipe into the import flow
     * On success the parent closes the modal; on failure we surface the
     * error inline and reset the pending state so the user can retry.
     */
    const handleRestoreTap = useCallback(() => {
        if (!selectedBackup || restoreBusy) return;
        requestRestore('restore', {
            onTrigger: async () => {
                if (!isTauri) return;
                const invoke = window.__TAURI_INTERNALS__?.invoke;
                if (typeof invoke !== 'function') return;
                setRestoreBusy(true);
                setRestoreError(null);
                try {
                    const result = await invoke<{ content: string }>(
                        'read_download_file',
                        { subdir: BACKUP_SUBDIR, filename: selectedBackup },
                    );
                    // Rust side already UTF-8-decoded the file bytes —
                    // auto-backup only ever writes a JSON.stringify
                    // payload, so the string is valid JSON ready for
                    // the import flow. No atob hop needed.
                    const text = result.content;
                    if (await onImportJson(text, 'restore')) {
                        onClose();
                    } else {
                        // Import flow already showed its own error toast;
                        // just reset the pending state so the button can
                        // be re-tapped.
                        resetRestore();
                    }
                } catch (err) {
                    console.warn('read_download_file failed', err);
                    setRestoreError(
                        t('import.backup.read_error') || '读取备份内容失败',
                    );
                    resetRestore();
                } finally {
                    setRestoreBusy(false);
                }
            },
        });
    }, [selectedBackup, restoreBusy, isTauri, onImportJson, onClose, requestRestore, resetRestore, t]);

    const handleJsonFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const content = reader.result as string;
            if (await onImportJson(content, 'file')) {
                onClose();
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    /**
     * Read JSON from the system clipboard and pipe it into the import flow.
     * Replaces the old "paste text" textarea + button pair — the user just
     * taps once, the rest is the same as before (parse → confirm overwrite
     * → silentBackup → apply). Failure surfaces inline rather than as a
     * dialog so the user can still try the file picker without losing
     * state.
     *
     * `navigator.clipboard.readText()` requires a user gesture (this is a
     * click handler, so fine) and a secure context (HTTPS or localhost).
     * Web preview on `http://localhost:3000` qualifies; production on
     * `https://` also qualifies.
     *
     * On the Tauri Android WebView, `readText()` is exposed but throws
     * NotAllowedError when the document loses focus inside a list row (the
     * clipboard_write_text mirror image of the write-side bug). We detect
     * the Tauri runtime and fall back to the `clipboard_read_text` command,
     * which goes through the Kotlin `ClipboardManager` and doesn't care
     * about WebView focus state. iOS / desktop keep using the WebView API.
     */
    const handleClipboardImport = async () => {
        if (clipboardBusy) return;
        setClipboardError(null);
        const hasWebViewApi = !!navigator.clipboard?.readText;
        const tauriInvoke = (typeof window !== 'undefined'
            ? window.__TAURI_INTERNALS__?.invoke
            : undefined);
        const useTauriFallback = !hasWebViewApi && typeof tauriInvoke === 'function';
        if (!hasWebViewApi && !useTauriFallback) {
            setClipboardError(
                t('import.clipboard.unsupported') || '当前环境不支持读取剪贴板，请改用下方「选择文件」',
            );
            return;
        }
        setClipboardBusy(true);
        try {
            let text: string | null = null;
            if (hasWebViewApi) {
                try {
                    text = await navigator.clipboard.readText();
                } catch (webErr) {
                    // Tauri Android WebView sometimes throws NotAllowedError
                    // here even though the API is "available". If we have
                    // the Rust fallback wired up, route through it instead
                    // of surfacing a misleading error.
                    console.warn('navigator.clipboard.readText failed, trying Tauri fallback', webErr);
                    if (typeof tauriInvoke === 'function') {
                        try {
                            text = await tauriInvoke('clipboard_read_text') as string;
                        } catch (tauriErr) {
                            console.warn('clipboard_read_text fallback failed', tauriErr);
                        }
                    }
                }
            } else if (useTauriFallback) {
                text = await (tauriInvoke as NonNullable<typeof tauriInvoke>)('clipboard_read_text') as string;
            }
            if (text === null || text === undefined) {
                setClipboardError(
                    t('import.clipboard.read_error') || '读取剪贴板失败',
                );
                return;
            }
            if (!text.trim()) {
                setClipboardError(
                    t('import.clipboard.empty') || '剪贴板为空，请先复制 JSON 文本，再点此按钮',
                );
                return;
            }
            if (await onImportJson(text, 'clipboard')) {
                onClose();
            }
        } catch (err) {
            console.warn('clipboard read failed', err);
            setClipboardError(
                t('import.clipboard.read_error') || '读取剪贴板失败，请检查浏览器权限，或改用「选择文件」',
            );
        } finally {
            setClipboardBusy(false);
        }
    };

    /**
     * Format a backup entry for the dropdown label. Local-time, in the
     * user's locale — matches the auto-backup filename convention so the
     * displayed label corresponds 1:1 with the file the user could find
     * in their file manager. `import`/`clear` suffix tells the user
     * which destructive op the backup was created before.
     */
    const formatBackupLabel = (entry: BackupEntry): string => {
        const ts = entry.timestamp!;
        const reasonMatch = /^hrt-backup-pre-(import|clear)-/.exec(entry.filename);
        const reason = reasonMatch?.[1] ?? '?';
        const reasonLabel =
            reason === 'import'
                ? (t('import.backup.reason_import') || '导入前')
                : (t('import.backup.reason_clear') || '清空前');
        const locale =
            lang === 'zh' || lang === 'zh-TW' ? 'zh-CN' :
            lang === 'ja' ? 'ja-JP' : 'en-US';
        const dateStr = ts.toLocaleString(locale, {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
        return `${dateStr} (${reasonLabel})`;
    };

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                <div className="flex justify-between items-center mb-6 shrink-0">
                    <h3 id="import-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{t('import.title')}</h3>
                    <button onClick={onClose} aria-label={t('btn.close')} className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}>
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                    <div className="space-y-4">
                        {/* ── Restore from auto-backup ─────────────────────
                         * Tauri-only block (Android). Web sandbox can't list
                         * the user's Downloads folder, so we hide the
                         * entire section rather than render an empty
                         * dropdown. The auto-backup feature itself (silent
                         * backup before import/clear) still runs on web —
                         * just through the browser's download mechanism
                         * — but restoring from those files has to happen
                         * via "Choose File" or paste-on-web.
                         *   - 第一次 tap: 按钮变实底，等第二次 tap
                         *   - 第二次 tap: 真正读文件、走 import 流程
                         * 双击确认沿用项目里 "该用药了" 按钮同款
                         * ConfirmButton + useConfirmButton 状态机。 */}
                        {isTauri && (
                            <div className="rounded-2xl p-4 space-y-3"
                                style={{ background: 'var(--bg-card-hover)' }}>
                                <div className="flex items-center gap-2">
                                    <History size={18} style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                                        {t('import.backup.title') || '从自动备份恢复'}
                                    </p>
                                </div>
                                {backupsLoading && (
                                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                        {t('import.backup.loading') || '加载中…'}
                                    </p>
                                )}
                                {backupsError && (
                                    <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>
                                        {backupsError}
                                    </p>
                                )}
                                {!backupsLoading && !backupsError && backups !== null && (
                                    backups.length === 0 ? (
                                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                            {t('import.backup.empty') || '暂无备份'}
                                        </p>
                                    ) : (
                                        <div className="flex flex-col sm:flex-row gap-2">
                                            <div className="flex-1 min-w-0">
                                                <CustomSelect
                                                    value={selectedBackup}
                                                    onChange={setSelectedBackup}
                                                    options={backups.map((b) => ({
                                                        value: b.filename,
                                                        label: formatBackupLabel(b),
                                                    }))}
                                                />
                                            </div>
                                            <ConfirmButton
                                                label={t('import.backup.restore_label') || '恢复'}
                                                onClick={handleRestoreTap}
                                                pending={restorePending === 'restore'}
                                            />
                                        </div>
                                    )
                                )}
                                {restoreError && (
                                    <p className="text-xs" role="alert" style={{ color: '#ef4444' }}>
                                        {restoreError}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Visual rhythm matches the existing pattern between
                            the clipboard row and the file row — each picker
                            gets its own section so users can scan the
                            options top-to-bottom without confusion. */}
                        {isTauri && <SectionDivider />}

                        <div>
                            <button
                                onClick={handleClipboardImport}
                                disabled={clipboardBusy}
                                className="w-full py-3 border-2 border-dashed font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                            >
                                <ClipboardPaste size={20} />
                                {clipboardBusy
                                    ? (t('import.clipboard.reading') || '正在读取…')
                                    : (t('import.clipboard.import') || '从剪贴板导入')}
                            </button>
                            {clipboardError && (
                                <p className="mt-2 text-xs" role="alert" style={{ color: '#ef4444' }}>
                                    {clipboardError}
                                </p>
                            )}
                        </div>

                        <SectionDivider />

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full py-3 border-2 border-dashed font-bold rounded-xl transition flex items-center justify-center gap-2"
                            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                        >
                            <Upload size={20} />
                            {t('import.file_btn')}
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/json"
                            className="hidden"
                            onChange={handleJsonFileChange}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ImportModal;
