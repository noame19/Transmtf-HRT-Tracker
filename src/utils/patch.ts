import { DoseEvent, Route } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Patch (贴片) pairing helpers.
//
// A patch administration consists of two events on the time axis:
//   1. `Route.patchApply` — when the user puts the patch on.
//   2. `Route.patchRemove` — when the user takes it off.
//
// Pairing is the *UI's* concern only:
//   - The PK engine (pk.ts / personalModel.ts / mipd.ts) still scans the time
//     axis for the next `patchRemove` after each `patchApply`, so the engine
//     keeps working on legacy data that has no `companionGroupId`.
//   - The form's "unified 贴片" entry-point (DoseFormModal) writes BOTH events
//     at save time and stamps them with a shared `companionGroupId` UUID so
//     the /history list can render a "贴片移除" button on the apply card that
//     vanishes as soon as a paired remove is found.
//
// These helpers are pure (no DOM, no React) so they're trivially unit-testable
// and safe to call from anywhere in the React tree.
//
// Pairing policy: STRICT groupId-only. Both `findPatchRemoveForApply` and
// `findPatchApplyForRemove` only resolve companions that share a non-empty
// `companionGroupId`. A previously-existing 14-day time-axis fallback was
// removed because it could mis-attribute a remove from a *different* cycle
// to the current apply (see `HistoryView`'s "撕下时间" hint and the
// `removeCompanion` strict variant below for the rationale). Legacy data
// arriving through `importData.ts` is still repaired by
// `reconcileImportedPatchEvents` (patchReconcile.ts), which backfills
// `companionGroupId` on legacy pairs during the import pass so the strict
// UI helpers find them downstream.
// ─────────────────────────────────────────────────────────────────────────────

/** True when `ev` is a patch-apply event. */
export const isPatchApply = (ev: DoseEvent): boolean => ev.route === Route.patchApply;

/** True when `ev` is a patch-remove event. */
export const isPatchRemove = (ev: DoseEvent): boolean => ev.route === Route.patchRemove;

/**
 * Returns the shared group id when this event is part of a paired patch group.
 * Strict — returns null for any non-string / empty / whitespace-only value so
 * hand-edited localStorage blobs can't poison the pairing logic.
 */
export const patchGroupOf = (ev: DoseEvent): string | null => {
    const id = ev.companionGroupId;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

/**
 * Find the remove event paired with `apply`. **Strict groupId-only** — only
 * resolves when both events share an identical, non-empty
 * `companionGroupId`. A previous 14-day time-axis fallback was removed
 * because it could mis-attribute a remove from a different cycle to the
 * current apply (the same bug pattern as `removeCompanion`'s stricter
 * siblings). Legacy data without groupIds is repaired by
 * `reconcileImportedPatchEvents` at import time, so the strict lookup
 * here is sufficient for all in-app data.
 *
 * Returns `null` for non-apply inputs, self-matches, and apply events with no
 * paired remove. Callers should treat a non-null return as "the button should
 * be hidden"; null means "show the '贴片移除' button".
 */
export const findPatchRemoveForApply = (
    apply: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (!isPatchApply(apply)) return null;
    const groupId = patchGroupOf(apply);
    if (!groupId) return null;
    return allEvents.find(
        (e) =>
            e.id !== apply.id &&
            e.route === Route.patchRemove &&
            patchGroupOf(e) === groupId,
    ) ?? null;
};

/**
 * Inverse of `findPatchRemoveForApply`. **Strict groupId-only** — see the
 * rationale on `findPatchRemoveForApply`. Used by the /history renderer to
 * add a small "贴上 HH:MM" hint on the remove card when a pair exists.
 */
export const findPatchApplyForRemove = (
    remove: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (!isPatchRemove(remove)) return null;
    const groupId = patchGroupOf(remove);
    if (!groupId) return null;
    return allEvents.find(
        (e) =>
            e.id !== remove.id &&
            e.route === Route.patchApply &&
            patchGroupOf(e) === groupId,
    ) ?? null;
};

/**
 * Strict groupId-only inverse of `findPatchRemoveForApply`. Returns the
 * companion `Route.patchRemove` for `apply` when both share an identical,
 * non-empty `companionGroupId`. **No time-axis fallback** — this helper is
 * used by write-path cascades (delete / route-change) where we need 1-to-1
 * certainty, never a fuzzy "closest remove" guess.
 */
export const removeCompanion = (
    apply: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (!isPatchApply(apply)) return null;
    const groupId = patchGroupOf(apply);
    if (!groupId) return null;
    return allEvents.find(
        (e) =>
            e.id !== apply.id &&
            e.route === Route.patchRemove &&
            patchGroupOf(e) === groupId,
    ) ?? null;
};

/** Inverse direction: find the apply companion of a remove. See `removeCompanion`. */
export const applyCompanion = (
    remove: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (!isPatchRemove(remove)) return null;
    const groupId = patchGroupOf(remove);
    if (!groupId) return null;
    return allEvents.find(
        (e) =>
            e.id !== remove.id &&
            e.route === Route.patchApply &&
            patchGroupOf(e) === groupId,
    ) ?? null;
};

/**
 * Given an event id and the current event list, return the SET of ids that
 * should be removed together. For a non-patch event, the set is just `{id}`.
 * For a `patchApply` or `patchRemove` with a `companionGroupId`, the set
 * also includes its paired sibling (looked up strictly by groupId — no
 * time-axis fallback). Used by `handleDeleteEvent` and `handleBulkDeleteEvents`
 * to enforce 1-to-1 cleanup without depending on the broader event stream.
 */
export const collectCascadeIds = (
    id: string,
    allEvents: DoseEvent[],
): Set<string> => {
    const ids = new Set<string>([id]);
    const target = allEvents.find((e) => e.id === id);
    if (!target) return ids;
    if (target.route === Route.patchApply) {
        const companion = removeCompanion(target, allEvents);
        if (companion) ids.add(companion.id);
    } else if (target.route === Route.patchRemove) {
        const companion = applyCompanion(target, allEvents);
        if (companion) ids.add(companion.id);
    }
    return ids;
};

/**
 * Decide whether saving `newE` (which replaces `oldE` by id) should also
 * trigger a sibling cleanup. Returns the companion `DoseEvent` whose own
 * groupId link must be broken (i.e., the sibling gets deleted OR, for the
 * remove→non-patch case, has its `companionGroupId` cleared).
 *
 * Cases:
 *   - apply → non-patch route: companion is the paired remove (caller deletes it).
 *   - remove → non-patch route: companion is the paired apply (caller clears its groupId).
 *   - any other route change (e.g. injection → sublingual): no cascade.
 *   - same-route edits (e.g. apply → apply with new timeH): no cascade (groupId preserved).
 */
export const shouldCascadeRemove = (
    oldE: DoseEvent,
    newE: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (oldE.id !== newE.id) return null;
    if (oldE.route === newE.route) return null;

    if (oldE.route === Route.patchApply && newE.route !== Route.patchApply) {
        return removeCompanion(oldE, allEvents);
    }
    if (oldE.route === Route.patchRemove && newE.route !== Route.patchRemove) {
        return applyCompanion(oldE, allEvents);
    }
    return null;
};
