/**
 * Pure change-classification for the cloud-sync decision (extracted from
 * CloudSyncContext.performSync so it can be unit-tested in node).
 *
 * Given the current cloud/local hashes + timestamps and the last-known baseline,
 * decide whether each side has changed SINCE the baseline. performSync then maps
 * (cloudChanged, localChanged) → push / pull / conflict.
 *
 * The subtle part is schema evolution: when the synced field set grows, the
 * baseline hash was written with an OLDER hash schema, so a mismatch against it
 * does NOT prove a local edit — it may just be the hash formula that changed. In
 * that case we fall back to timestamps instead of the hash.
 */
export interface BaselineInputs {
    lastKnownCloudUpdated: string | null;
    lastKnownCloudHash: string | null;
    cloudDataUpdated: string | null | undefined;
    cloudHash: string;
    localHash: string;
    localLastModified: string | null;
    /** Current SYNC_HASH_SCHEMA prefix, e.g. "v2". */
    schemaPrefix: string;
}

export interface ChangeClassification {
    cloudChanged: boolean;
    localChanged: boolean;
}

export function classifyChanges(i: BaselineInputs): ChangeClassification {
    const hasBaseline = Boolean(i.lastKnownCloudUpdated || i.lastKnownCloudHash);
    const baselineHashIsCurrent = i.lastKnownCloudHash?.startsWith(i.schemaPrefix + ':') ?? false;

    // Conservative when there is no baseline (fresh install / post-logout / first
    // run after upgrade): assume both sides may have diverged.
    const cloudChanged = hasBaseline
        ? (i.lastKnownCloudUpdated && i.cloudDataUpdated
            ? i.cloudDataUpdated !== i.lastKnownCloudUpdated
            : (baselineHashIsCurrent ? i.cloudHash !== i.lastKnownCloudHash : true))
        : true;

    const localChanged = hasBaseline
        ? (baselineHashIsCurrent
            ? i.localHash !== i.lastKnownCloudHash
            // Stale-schema baseline: don't infer a local edit from the hash; rely
            // on whether the user actually touched data since the baseline.
            : Boolean(i.localLastModified && i.localLastModified !== i.lastKnownCloudUpdated))
        : Boolean(i.localLastModified);

    return { cloudChanged, localChanged };
}
