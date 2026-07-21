/**
 * Auto-backup conventions shared between SettingsPage (silent backup +
 * 180-day cleanup sweep) and ImportModal (restore-from-backup dropdown).
 *
 * Filenames use LOCAL-time components instead of the ISO 8601 string from
 * `Date.toISOString()` because colons are illegal on Android's exFAT/FAT
 * filesystem and would break MediaStore inserts. We keep the year-month-day
 * + dash-separated HH-mm-ss order so the prefix is sort-by-time as long as
 * the year stays 4-digit (works until year 9999).
 *
 * Only files matching `hrt-backup-pre-{import|clear}-*.json` are eligible
 * for the auto-cleanup sweep. Manual exports (`hrt-dosages-*.json`) are
 * owned by the user — we never touch them.
 */

/** Sub-directory inside public Downloads where every export / backup lands.
 *  Mirrors the literal string passed to `save_data_to_download` everywhere
 *  in the codebase. */
export const BACKUP_SUBDIR = 'HRT Tracker';

/** Auto-backups older than this get pruned before each new backup lands.
 *  Fixed at 180 days — the agreed retention. */
export const BACKUP_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Prefix a file must match to be considered an auto-backup eligible for
 *  cleanup. Manual exports deliberately use a different prefix
 *  (`hrt-dosages-`) so they survive any sweep. The reason group
 *  (`import|clear`) lets the cleanup loop and restore dropdown tell
 *  which destructive op a given snapshot was captured before. */
const BACKUP_FILENAME_RE = /^hrt-backup-pre-(import|clear)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json$/;

/** Build a filename-safe timestamp like `2026-07-22T10-30-45` from local
 *  clock time. Dashes replace colons so the string is filesystem-safe on
 *  every Android storage volume; local-time formatting means "6 months
 *  ago" lines up with the user's clock instead of UTC drift. */
export const formatBackupTimestamp = (d: Date = new Date()): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

/** Inverse of `formatBackupTimestamp`. Returns `null` if the filename
 *  doesn't match the auto-backup convention so the caller can skip
 *  non-matching files (e.g. manual exports). */
export const parseBackupTimestamp = (filename: string): Date | null => {
    const m = BACKUP_FILENAME_RE.exec(filename);
    if (!m) return null;
    const [, , stamp] = m;
    const [datePart, timePart] = stamp.split('T');
    const [y, mo, da] = datePart.split('-').map(Number);
    const [h, mi, s] = timePart.split('-').map(Number);
    return new Date(y, mo - 1, da, h, mi, s);
};
