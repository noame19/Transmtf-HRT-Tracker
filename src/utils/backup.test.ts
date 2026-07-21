import { describe, expect, it } from 'vitest';
import {
    BACKUP_RETENTION_MS,
    BACKUP_SUBDIR,
    formatBackupTimestamp,
    parseBackupTimestamp,
} from './backup';

describe('backup constants', () => {
    it('subdir matches the writer literal', () => {
        expect(BACKUP_SUBDIR).toBe('HRT Tracker');
    });

    it('retention is 180 days', () => {
        expect(BACKUP_RETENTION_MS).toBe(180 * 24 * 60 * 60 * 1000);
    });
});

describe('formatBackupTimestamp', () => {
    it('pads single-digit components', () => {
        const d = new Date(2026, 0, 5, 3, 7, 9); // Jan 5 03:07:09 local
        expect(formatBackupTimestamp(d)).toBe('2026-01-05T03-07-09');
    });

    it('uses local clock time (so cross-checking against new Date() is sane)', () => {
        const d = new Date(2026, 6, 22, 15, 30, 45); // Jul 22 15:30:45
        expect(formatBackupTimestamp(d)).toBe('2026-07-22T15-30-45');
    });

    it('never inserts colons (Android exFAT-safe)', () => {
        const stamp = formatBackupTimestamp(new Date());
        expect(stamp).not.toContain(':');
        expect(stamp).not.toContain(' ');
    });

    it('round-trips with parseBackupTimestamp', () => {
        const original = new Date(2026, 11, 31, 23, 59, 59);
        const stamp = formatBackupTimestamp(original);
        const parsed = parseBackupTimestamp(`hrt-backup-pre-clear-${stamp}.json`);
        expect(parsed).not.toBeNull();
        // We compare on local-time components because the parser uses
        // the local-time Date constructor (no Z suffix).
        expect(parsed!.getFullYear()).toBe(original.getFullYear());
        expect(parsed!.getMonth()).toBe(original.getMonth());
        expect(parsed!.getDate()).toBe(original.getDate());
        expect(parsed!.getHours()).toBe(original.getHours());
        expect(parsed!.getMinutes()).toBe(original.getMinutes());
        expect(parsed!.getSeconds()).toBe(original.getSeconds());
    });
});

describe('parseBackupTimestamp', () => {
    it('returns null for non-matching filenames (manual exports)', () => {
        expect(parseBackupTimestamp('hrt-dosages-2026-07-22.json')).toBeNull();
        expect(parseBackupTimestamp('random.json')).toBeNull();
        expect(parseBackupTimestamp('hrt-backup-pre-import-foo.json')).toBeNull();
    });

    it('returns null for wrong reason tag', () => {
        expect(parseBackupTimestamp('hrt-backup-pre-other-2026-07-22T10-30-45.json')).toBeNull();
    });

    it('returns null for missing .json extension', () => {
        expect(parseBackupTimestamp('hrt-backup-pre-import-2026-07-22T10-30-45')).toBeNull();
    });

    it('parses import-prefixed backup', () => {
        const d = parseBackupTimestamp('hrt-backup-pre-import-2026-07-22T10-30-45.json');
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
        expect(d!.getMonth()).toBe(6); // July (0-indexed)
        expect(d!.getDate()).toBe(22);
        expect(d!.getHours()).toBe(10);
        expect(d!.getMinutes()).toBe(30);
        expect(d!.getSeconds()).toBe(45);
    });

    it('parses clear-prefixed backup', () => {
        const d = parseBackupTimestamp('hrt-backup-pre-clear-2025-01-01T00-00-00.json');
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2025);
        expect(d!.getMonth()).toBe(0);
        expect(d!.getDate()).toBe(1);
    });

    it('stale-filenames sort older first via getTime', () => {
        const older = parseBackupTimestamp('hrt-backup-pre-import-2024-01-01T00-00-00.json')!;
        const newer = parseBackupTimestamp('hrt-backup-pre-clear-2026-07-22T10-30-45.json')!;
        expect(older.getTime()).toBeLessThan(newer.getTime());
    });
});
