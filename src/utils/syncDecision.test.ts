import { describe, it, expect } from 'vitest';
import { classifyChanges, type BaselineInputs } from './syncDecision';

const SCHEMA = 'v2';
const base = (over: Partial<BaselineInputs> = {}): BaselineInputs => ({
    lastKnownCloudUpdated: null,
    lastKnownCloudHash: null,
    cloudDataUpdated: undefined,
    cloudHash: 'v2:cloud',
    localHash: 'v2:local',
    localLastModified: null,
    schemaPrefix: SCHEMA,
    ...over,
});

describe('classifyChanges', () => {
    it('no baseline → both assumed changed only if local was ever edited', () => {
        expect(classifyChanges(base({ localLastModified: null }))).toEqual({ cloudChanged: true, localChanged: false });
        expect(classifyChanges(base({ localLastModified: '2026-06-01T00:00:00Z' }))).toEqual({ cloudChanged: true, localChanged: true });
    });

    it('current-schema baseline, only local edited → push (cloud unchanged, local changed)', () => {
        const r = classifyChanges(base({
            lastKnownCloudUpdated: 'T0', lastKnownCloudHash: 'v2:base',
            cloudDataUpdated: 'T0',               // cloud timestamp unchanged
            cloudHash: 'v2:base',                  // cloud content unchanged
            localHash: 'v2:edited',                // local changed
        }));
        expect(r).toEqual({ cloudChanged: false, localChanged: true });
    });

    it('SCHEMA MIGRATION + real local edit → local-only change → PUSH', () => {
        // Realistic upgrade: baseline hash is unprefixed (old schema); the user
        // added a custom gel, which bumps lastModified. The stale hash must NOT be
        // used to infer the change — the bumped lastModified is. → push, not conflict.
        const r = classifyChanges(base({
            lastKnownCloudUpdated: 'T0', lastKnownCloudHash: 'deadbeef', // old, unprefixed
            cloudDataUpdated: 'T0',                // cloud unchanged
            cloudHash: 'v2:cloudnow',
            localHash: 'v2:localnow',
            localLastModified: 'T5',               // edited after baseline → bumped
        }));
        expect(r).toEqual({ cloudChanged: false, localChanged: true }); // → push
    });

    it('SCHEMA MIGRATION + no local edit → no change detected (NOT misread as edit)', () => {
        // Stale baseline but the user never touched data (lastModified == baseline).
        // The unprefixed hash must NOT be read as a local edit. This classifies as
        // "neither changed" → routes to performSync's fallback, where the
        // destructive-pull guard (tryPull) prevents any silent clear of local lists.
        const r = classifyChanges(base({
            lastKnownCloudUpdated: 'T0', lastKnownCloudHash: 'deadbeef',
            cloudDataUpdated: 'T0',
            cloudHash: 'v2:cloudnow',
            localHash: 'v2:localnow',
            localLastModified: 'T0',               // unchanged since baseline
        }));
        expect(r).toEqual({ cloudChanged: false, localChanged: false });
    });

    it('cloud timestamp moved (old client rewrite) + local edit → both changed (real conflict)', () => {
        const r = classifyChanges(base({
            lastKnownCloudUpdated: 'T0', lastKnownCloudHash: 'v2:base',
            cloudDataUpdated: 'T9',                // cloud moved
            localHash: 'v2:edited',                // local changed
        }));
        expect(r).toEqual({ cloudChanged: true, localChanged: true });
    });

    it('current-schema baseline, only cloud moved → pull', () => {
        const r = classifyChanges(base({
            lastKnownCloudUpdated: 'T0', lastKnownCloudHash: 'v2:base',
            cloudDataUpdated: 'T9',
            localHash: 'v2:base',                  // local unchanged
        }));
        expect(r).toEqual({ cloudChanged: true, localChanged: false });
    });
});
