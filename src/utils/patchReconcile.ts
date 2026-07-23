import { v4 as uuidv4 } from 'uuid';
import { DoseEvent, Route } from '../../types';

const MAX_PATCH_WEAR_HOURS = 14 * 24;

const isPatchApply = (e: DoseEvent) => e.route === Route.patchApply;
const isPatchRemove = (e: DoseEvent) => e.route === Route.patchRemove;

const groupOf = (e: DoseEvent): string | null => {
    const id = e.companionGroupId;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

/**
 * Reconcile a freshly-imported (or freshly-parsed) events array so it
 * conforms to the project's "patch data integrity" contract:
 *
 *   1. Drop orphan `patchRemove` events whose `companionGroupId` has no
 *      matching `patchApply` in the same array.
 *   2. Strip a dangling `companionGroupId` off any `patchApply` whose paired
 *      `patchRemove` is missing (UI must not show "摘下时间" for it).
 *   3. Backfill `companionGroupId` on legacy pairs (no groupId but a
 *      `patchRemove` lands within 14 days of the `patchApply` on the time
 *      axis). Pairing is 1-to-1 greedy: each `patchRemove` is consumed by
 *      the earliest unpaired `patchApply` whose wear window contains it.
 *   4. Events without any patch context pass through untouched.
 *
 * Called by every deserialization entry point in `importData.ts` so legacy
 * imports (or hand-edited localStorage blobs) never silently feed dirty
 * data into the PK engine.
 */
export function reconcileImportedPatchEvents(events: DoseEvent[]): DoseEvent[] {
    // ── Pass 1: drop orphan removes + strip dangling groupIds ─────────────
    const groupIds = new Set<string>();
    for (const e of events) {
        const g = groupOf(e);
        if (g) groupIds.add(g);
    }
    const validGroups = new Set<string>();
    for (const g of groupIds) {
        const hasApply = events.some((e) => groupOf(e) === g && isPatchApply(e));
        const hasRemove = events.some((e) => groupOf(e) === g && isPatchRemove(e));
        if (hasApply && hasRemove) validGroups.add(g);
    }

    const cleaned: DoseEvent[] = [];
    for (const e of events) {
        if (isPatchRemove(e)) {
            const g = groupOf(e);
            if (g && !validGroups.has(g)) continue; // orphan remove → drop
        }
        if (isPatchApply(e)) {
            const g = groupOf(e);
            if (g && !validGroups.has(g)) {
                // dangling groupId on apply → strip it
                cleaned.push({ ...e, companionGroupId: undefined });
                continue;
            }
        }
        cleaned.push(e);
    }

    // ── Pass 2: 1-to-1 greedy pairing of legacy (no-groupId) pairs ───────
    const noGroupApply = cleaned
        .filter((e) => isPatchApply(e) && !groupOf(e))
        .sort((a, b) => a.timeH - b.timeH);
    const noGroupRemove = cleaned
        .filter((e) => isPatchRemove(e) && !groupOf(e))
        .sort((a, b) => a.timeH - b.timeH);

    const consumedRemoves = new Set<string>();
    const idToGroupId = new Map<string, string>();
    for (const apply of noGroupApply) {
        const minH = apply.timeH;
        const maxH = apply.timeH + MAX_PATCH_WEAR_HOURS;
        const candidate = noGroupRemove.find(
            (r) =>
                !consumedRemoves.has(r.id) &&
                r.timeH >= minH &&
                r.timeH <= maxH,
        );
        if (candidate) {
            const g = uuidv4();
            idToGroupId.set(apply.id, g);
            idToGroupId.set(candidate.id, g);
            consumedRemoves.add(candidate.id);
        }
    }

    return cleaned.map((e) => {
        const g = idToGroupId.get(e.id);
        return g ? { ...e, companionGroupId: g } : e;
    });
}