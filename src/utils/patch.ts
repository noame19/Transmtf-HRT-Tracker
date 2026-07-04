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
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum wear window for the time-axis fallback pairing. Real patches top
 *  out at ~7 days; 14d gives a comfortable safety margin against late logging
 *  without letting an old "remove" from a prior cycle accidentally pair with a
 *  new "apply". */
const MAX_PATCH_WEAR_HOURS = 14 * 24;

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
 * Find the remove event paired with `apply`. Resolution order:
 *
 *   1. `companionGroupId` exact match (the modern path — same UUID on both
 *      events means the form wrote them as a pair).
 *   2. Time-axis fallback for legacy data (no `companionGroupId`): the FIRST
 *      `Route.patchRemove` whose time is strictly within the wear window
 *      (14 days) after `apply.timeH`.
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

    // 1. Exact companion-group match.
    const groupId = patchGroupOf(apply);
    if (groupId) {
        const byGroup = allEvents.find(
            (e) =>
                e.id !== apply.id &&
                e.route === Route.patchRemove &&
                patchGroupOf(e) === groupId,
        );
        if (byGroup) return byGroup;
    }

    // 2. Time-axis fallback for legacy data. We always do this so an
    //    apply-without-groupId that already has a remove in its wear window
    //    (typical pre-unification pair) ALSO hides the button — otherwise the
    //    user could double-record a remove and confuse the PK engine.
    const minH = apply.timeH;
    const maxH = apply.timeH + MAX_PATCH_WEAR_HOURS;
    let best: DoseEvent | null = null;
    for (const e of allEvents) {
        if (e.id === apply.id) continue;
        if (e.route !== Route.patchRemove) continue;
        if (e.timeH < minH) continue;
        if (e.timeH > maxH) continue;
        if (!best || e.timeH < best.timeH) best = e;
    }
    return best;
};

/**
 * Inverse of `findPatchRemoveForApply`: find the apply event paired with
 * `remove`. Used by the /history renderer to add a small "贴上 HH:MM" hint on
 * the remove card when a pair exists. Falls back to the time-axis heuristic
 * for legacy data.
 */
export const findPatchApplyForRemove = (
    remove: DoseEvent,
    allEvents: DoseEvent[],
): DoseEvent | null => {
    if (!isPatchRemove(remove)) return null;

    const groupId = patchGroupOf(remove);
    if (groupId) {
        const byGroup = allEvents.find(
            (e) =>
                e.id !== remove.id &&
                e.route === Route.patchApply &&
                patchGroupOf(e) === groupId,
        );
        if (byGroup) return byGroup;
    }

    const minH = remove.timeH - MAX_PATCH_WEAR_HOURS;
    const maxH = remove.timeH;
    let best: DoseEvent | null = null;
    for (const e of allEvents) {
        if (e.id === remove.id) continue;
        if (e.route !== Route.patchApply) continue;
        if (e.timeH < minH) continue;
        if (e.timeH > maxH) continue;
        if (!best || e.timeH > best.timeH) best = e;
    }
    return best;
};
