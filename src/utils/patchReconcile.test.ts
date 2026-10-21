// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DoseEvent, Ester, Route } from '../lib/types';
import { reconcileImportedPatchEvents, sanitizePatchGroups } from './patchReconcile';

const HOUR = 3600000;
const makeEvent = (overrides: Partial<DoseEvent> = {}): DoseEvent => ({
    id: 'ev',
    route: Route.injection,
    timeH: 0,
    doseMG: 5,
    ester: Ester.E2,
    weightKG: 60,
    extras: {},
    ...overrides,
});

describe('reconcileImportedPatchEvents', () => {
    it('removes orphan patchRemove (groupId with no matching apply)', () => {
        const orphan = makeEvent({
            id: 'orphan-remove',
            route: Route.patchRemove,
            timeH: 100,
            companionGroupId: 'orphan-g',
        });
        const result = reconcileImportedPatchEvents([orphan]);
        expect(result).toEqual([]);
    });

    it('strips dangling groupId from apply with no matching remove', () => {
        const apply = makeEvent({
            id: 'lonely-apply',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'lonely-g',
        });
        const result = reconcileImportedPatchEvents([apply]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('lonely-apply');
        expect(result[0].companionGroupId).toBeUndefined();
    });

    it('backfills groupId for unpaired legacy apply+remove (within 14d window)', () => {
        const apply = makeEvent({
            id: 'old-apply',
            route: Route.patchApply,
            timeH: 100,
        });
        const remove = makeEvent({
            id: 'old-remove',
            route: Route.patchRemove,
            timeH: 100 + 48,
        });
        const result = reconcileImportedPatchEvents([apply, remove]);
        expect(result).toHaveLength(2);
        expect(result[0].companionGroupId).toBeDefined();
        expect(result[0].companionGroupId).toBe(result[1].companionGroupId);
    });

    it('does not pair apply/remove across 14d gap', () => {
        const apply = makeEvent({
            id: 'old-apply',
            route: Route.patchApply,
            timeH: 100,
        });
        const remove = makeEvent({
            id: 'old-remove',
            route: Route.patchRemove,
            timeH: 100 + 15 * 24,
        });
        const result = reconcileImportedPatchEvents([apply, remove]);
        expect(result[0].companionGroupId).toBeUndefined();
        expect(result[1].companionGroupId).toBeUndefined();
    });

    it('does 1-to-1 greedy pairing (no 1-to-N)', () => {
        // 两条 apply + 一条 remove：只该配其中一条
        const apply1 = makeEvent({ id: 'a1', route: Route.patchApply, timeH: 100 });
        const apply2 = makeEvent({ id: 'a2', route: Route.patchApply, timeH: 200 });
        const remove = makeEvent({ id: 'r1', route: Route.patchRemove, timeH: 250 });
        const result = reconcileImportedPatchEvents([apply1, apply2, remove]);
        const grouped = result.filter((e) => e.companionGroupId);
        expect(grouped).toHaveLength(2); // 一对 apply+remove
        // 找出 paired remove
        const groupedApply = grouped.find((e) => e.id === 'a1' || e.id === 'a2');
        const groupedRemove = grouped.find((e) => e.id === 'r1');
        expect(groupedApply).toBeDefined();
        expect(groupedRemove).toBeDefined();
        expect(groupedApply!.companionGroupId).toBe(groupedRemove!.companionGroupId);
    });

    it('preserves non-patch events untouched', () => {
        const inj = makeEvent({ id: 'i', route: Route.injection, timeH: 100 });
        const result = reconcileImportedPatchEvents([inj]);
        expect(result).toEqual([inj]);
    });

    it('keeps a single patch apply (no remove) intact (legitimate "still wearing")', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const result = reconcileImportedPatchEvents([apply]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('a');
        expect(result[0].companionGroupId).toBeUndefined();
    });
});
describe('sanitizePatchGroups — the runtime half of the contract', () => {
    const apply = (gid?: string, timeH = 0) =>
        makeEvent({ id: `a-${timeH}`, route: Route.patchApply, timeH, companionGroupId: gid });
    const remove = (gid?: string, timeH = 1) =>
        makeEvent({ id: `r-${timeH}`, route: Route.patchRemove, timeH, companionGroupId: gid });

    it('leaves a fully paired group untouched (same array reference)', () => {
        const events = [apply('g1'), remove('g1')];
        expect(sanitizePatchGroups(events)).toBe(events);
    });

    it('drops an orphan patchRemove', () => {
        // Exactly what a bulk delete of the apply half used to leave behind.
        const out = sanitizePatchGroups([apply(undefined), remove('ghost')]);
        expect(out).toHaveLength(1);
        expect(out[0].route).toBe(Route.patchApply);
    });

    it('strips a dangling groupId but keeps the apply', () => {
        // The user is still wearing the patch; the apply must survive so the
        // row can show its 摘下 button.
        const out = sanitizePatchGroups([apply('solo')]);
        expect(out).toHaveLength(1);
        expect(out[0].route).toBe(Route.patchApply);
        expect(out[0].companionGroupId).toBeUndefined();
    });

    it('keeps unrelated events byte-identical', () => {
        const oral = makeEvent({ id: 'oral', route: Route.oral, timeH: 5 });
        const out = sanitizePatchGroups([oral, remove('ghost')]);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(oral); // same object, not a clone
    });

    it('is idempotent', () => {
        const once = sanitizePatchGroups([apply('solo'), remove('ghost')]);
        expect(sanitizePatchGroups(once)).toBe(once);
    });

    it('returns the same reference when there are no patch events at all', () => {
        const events = [makeEvent({ id: 'x', route: Route.oral, timeH: 1 })];
        expect(sanitizePatchGroups(events)).toBe(events);
    });

    it('does NOT invent group ids (that heuristic stays import-only)', () => {
        // Legacy pair with no groupId: reconcileImportedPatchEvents would pair
        // them, sanitizePatchGroups must leave both alone.
        const out = sanitizePatchGroups([apply(undefined, 0), remove(undefined, 24)]);
        expect(out).toHaveLength(2);
        out.forEach((e) => expect(e.companionGroupId).toBeUndefined());
    });
});
