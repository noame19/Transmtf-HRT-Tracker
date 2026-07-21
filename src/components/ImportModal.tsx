import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { X, Upload, History } from 'lucide-react';
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

const ImportModal = ({
    isOpen,
    onClose,
    onImportJson,
    isTauri,
}: {
    isOpen: boolean;
    onClose: () => void;
    onImportJson: (text: string) => Promise<boolean>;
    /** True when running inside the Tauri Android runtime. The
     *  auto-backup restore section is hidden entirely on web — the
     *  browser sandbox can't list the user's Downloads folder, so
     *  the dropdown would always be empty there. */
    isTauri: boolean;
}) => {
    const { t, lang } = useTranslation();
    const [text, setText] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

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
            setText("");
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

    // Auto-refresh when the modal opens on Tauri. We only fire on
    // `isOpen` flip → true so a stale listing isn't replaced on every
    // keystroke in the paste textarea.
    useEffect(() => {
        if (isOpen && isTauri && backups === null) {
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
                    const result = await invoke<{ contentB64: string }>(
                        'read_download_file',
                        { subdir: BACKUP_SUBDIR, filename: selectedBackup },
                    );
                    // atob → UTF-8 safe string (the same shape FileReader
                    // produces when the user picks the file directly).
                    const text = atob(result.contentB64);
                    if (await onImportJson(text)) {
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
            if (await onImportJson(content)) {
                onClose();
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    const handleTextImport = async () => {
        if (await onImportJson(text)) {
            onClose();
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

                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>{t('import.text')}</label>
                            <textarea
                                className="w-full h-32 p-3 rounded-xl focus:ring-2 focus:ring-pink-300 outline-none font-mono text-xs"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                                placeholder={t('import.paste_hint')}
                                value={text}
                                onChange={e => setText(e.target.value)}
                            />
                            <button
                                onClick={handleTextImport}
                                disabled={!text.trim()}
                                className="mt-2 w-full py-3 text-white font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition glass-btn-primary btn-press-glass"
                            >
                                {t('drawer.import')}
                            </button>
                        </div>

                        <div className="relative flex py-2 items-center">
                            <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
                            <span className="flex-shrink-0 mx-4 text-xs uppercase font-bold" style={{ color: 'var(--text-tertiary)' }}>OR</span>
                            <div className="flex-grow border-t" style={{ borderColor: 'var(--border-primary)' }}></div>
                        </div>

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
