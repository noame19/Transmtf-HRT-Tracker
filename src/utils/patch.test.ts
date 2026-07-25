import { describe, it, expect } from 'vitest';
import { DoseEvent, Ester, ExtraKey, Route } from '../../types';
import {
    isPatchApply,
    isPatchRemove,
    patchGroupOf,
    findPatchRemoveForApply,
    findPatchApplyForRemove,
    removeCompanion,
    applyCompanion,
    collectCascadeIds,
    shouldCascadeRemove,
} from './patch';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3600000;

function makeEvent(overrides: Partial<DoseEvent> = {}): DoseEvent {
    return {
        id: 'ev-1',
        route: Route.injection,
        timeH: 0,
        doseMG: 5,
        ester: Ester.EV,
        weightKG: 70,
        extras: {},
        ...overrides,
    };
}

describe('isPatchApply / isPatchRemove', () => {
    it('classifies each route correctly', () => {
        expect(isPatchApply(makeEvent({ route: Route.patchApply }))).toBe(true);
        expect(isPatchApply(makeEvent({ route: Route.patchRemove }))).toBe(false);
        expect(isPatchApply(makeEvent({ route: Route.injection }))).toBe(false);
        expect(isPatchRemove(makeEvent({ route: Route.patchRemove }))).toBe(true);
        expect(isPatchRemove(makeEvent({ route: Route.patchApply }))).toBe(false);
    });
});

describe('patchGroupOf', () => {
    it('returns the id when present and non-empty', () => {
        expect(patchGroupOf(makeEvent({ companionGroupId: 'grp-1' }))).toBe('grp-1');
    });
    it('returns null when absent / empty / whitespace / non-string', () => {
        expect(patchGroupOf(makeEvent({}))).toBeNull();
        expect(patchGroupOf(makeEvent({ companionGroupId: '' }))).toBeNull();
        expect(patchGroupOf(makeEvent({ companionGroupId: '   ' }))).toBeNull();
        // Cast through unknown to simulate hand-edited localStorage blobs.
        expect(patchGroupOf(makeEvent({ companionGroupId: 123 as unknown as string }))).toBeNull();
    });
});

describe('findPatchRemoveForApply', () => {
    it('returns null for non-apply inputs', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove });
        expect(findPatchRemoveForApply(remove, [remove])).toBeNull();
        const inj = makeEvent({ id: 'i', route: Route.injection });
        expect(findPatchRemoveForApply(inj, [inj])).toBeNull();
    });
    it('matches by companionGroupId (modern path)', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const other = makeEvent({ id: 'x', route: Route.patchRemove, timeH: 300, companionGroupId: 'g2' });
        expect(findPatchRemoveForApply(apply, [other, remove])).toBe(remove);
    });
    it('returns null when apply has no companionGroupId (strict — no time-axis fallback)', () => {
        // 删除 14 天时间轴兜底后,无 groupId 的 apply 永远找不到配对。
        // 历史 / 编辑表单 / 热力图都会按"未配对"处理。
        // 导入路径会在 importData.ts 里跑 reconcileImportedPatchEvents 自动补 groupId。
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 100 + 24 });
        expect(findPatchRemoveForApply(apply, [remove])).toBeNull();
    });
    it('returns null when the candidate remove is ungrouped (strict — no time-axis fallback)', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        // 同一时间窗内的撕下事件,但没 groupId → 不配对(以前会被时间兜底错误匹配)
        const ungroupedRemove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 105 });
        expect(findPatchRemoveForApply(apply, [ungroupedRemove])).toBeNull();
    });
    it('returns null when no remove has a matching companionGroupId', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const mismatched = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g2' });
        expect(findPatchRemoveForApply(apply, [mismatched])).toBeNull();
    });
    it('ignores other-route events even if they share a groupId', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const inj = makeEvent({ id: 'i', route: Route.injection, timeH: 110, companionGroupId: 'g1' });
        expect(findPatchRemoveForApply(apply, [inj])).toBeNull();
    });
    it('returns the group match when multiple ungrouped removes also exist in the time window', () => {
        // 即使时间窗里有其他未配对的撕下事件,有 groupId 的那对依然要优先配对。
        // 旧版时间兜底会返回"最早"那个无 groupId 的 remove;现在 strict groupId-only
        // 直接忽略它们,只返回 groupId 匹配的那个。
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const late = makeEvent({ id: 'l', route: Route.patchRemove, timeH: 150 });
        const early = makeEvent({ id: 'e', route: Route.patchRemove, timeH: 120 });
        const grouped = makeEvent({ id: 'g', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(findPatchRemoveForApply(apply, [late, early, grouped])).toBe(grouped);
    });
    it('does not match the apply event with itself', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        expect(findPatchRemoveForApply(apply, [apply])).toBeNull();
    });
    it('returns the group match even when a closer ungrouped remove is also present', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const closerNoGroup = makeEvent({ id: 'c', route: Route.patchRemove, timeH: 105 });
        const groupedFar = makeEvent({ id: 'g', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(findPatchRemoveForApply(apply, [closerNoGroup, groupedFar])).toBe(groupedFar);
    });
});

describe('findPatchApplyForRemove (inverse)', () => {
    it('returns null for non-remove inputs', () => {
        const apply = makeEvent({ route: Route.patchApply });
        expect(findPatchApplyForRemove(apply, [apply])).toBeNull();
    });
    it('matches by companionGroupId', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(findPatchApplyForRemove(remove, [apply])).toBe(apply);
    });
    it('returns null when remove has no companionGroupId (strict — no time-axis fallback)', () => {
        // 删除 14 天时间轴兜底后,无 groupId 的 remove 永远找不到配对。
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200 });
        const early = makeEvent({ id: 'e', route: Route.patchApply, timeH: 100 });
        const late = makeEvent({ id: 'l', route: Route.patchApply, timeH: 180 });
        expect(findPatchApplyForRemove(remove, [early, late])).toBeNull();
    });
    it('returns null when the candidate apply is ungrouped (strict — no time-axis fallback)', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const ungroupedApply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 180 });
        expect(findPatchApplyForRemove(remove, [ungroupedApply])).toBeNull();
    });
    it('returns null when no apply has a matching companionGroupId', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const tooEarly = makeEvent({ id: 't', route: Route.patchApply, timeH: 200 - 20 * 24 });
        expect(findPatchApplyForRemove(remove, [tooEarly])).toBeNull();
    });
});

describe('removeCompanion / applyCompanion (strict groupId-only)', () => {
    it('removeCompanion returns the remove with the same groupId', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(removeCompanion(apply, [apply, remove])?.id).toBe('r');
    });

    it('removeCompanion returns null when no groupId match exists', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const other = makeEvent({ id: 'o', route: Route.patchRemove, timeH: 200, companionGroupId: 'g2' });
        expect(removeCompanion(apply, [apply, other])).toBeNull();
    });

    it('removeCompanion returns null for non-apply inputs', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove });
        expect(removeCompanion(remove, [remove])).toBeNull();
    });

    it('removeCompanion does NOT use time-axis fallback', () => {
        // 没有 groupId，但时间上紧邻 → 不应该被配对（这是与 findPatchRemoveForApply 的关键区别）
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 101 });
        expect(removeCompanion(apply, [apply, remove])).toBeNull();
    });

    it('applyCompanion is the inverse direction', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        expect(applyCompanion(remove, [apply, remove])?.id).toBe('a');
    });

    it('applyCompanion returns null for non-remove inputs', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply });
        expect(applyCompanion(apply, [apply])).toBeNull();
    });

    it('applyCompanion returns null when groupId mismatch (even with close time)', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 199, companionGroupId: 'g2' });
        expect(applyCompanion(remove, [apply, remove])).toBeNull();
    });
});

describe('collectCascadeIds / shouldCascadeRemove', () => {
    it('collectCascadeIds returns just the id for non-patch events', () => {
        const inj = makeEvent({ id: 'i', route: Route.injection });
        expect(collectCascadeIds('i', [inj])).toEqual(new Set(['i']));
    });

    it('collectCascadeIds for patchApply includes paired remove id', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const result = collectCascadeIds('a', [apply, remove]);
        expect(result.has('a')).toBe(true);
        expect(result.has('r')).toBe(true);
    });

    it('collectCascadeIds for patchRemove includes paired apply id', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const result = collectCascadeIds('r', [apply, remove]);
        expect(result.has('r')).toBe(true);
        expect(result.has('a')).toBe(true);
    });

    it('collectCascadeIds for apply without groupId returns only apply id', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const result = collectCascadeIds('a', [apply]);
        expect(result.size).toBe(1);
        expect(result.has('a')).toBe(true);
    });

    it('shouldCascadeRemove returns companion when apply→non-patch route', () => {
        const oldApply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const newEvent = makeEvent({ id: 'a', route: Route.injection, timeH: 100 });
        expect(shouldCascadeRemove(oldApply, newEvent, [oldApply, remove])?.id).toBe('r');
    });

    it('shouldCascadeRemove returns null when route stays patchApply', () => {
        const oldApply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const newEvent = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        expect(shouldCascadeRemove(oldApply, newEvent, [oldApply])).toBeNull();
    });

    it('shouldCascadeRemove returns null when old route was not patchApply', () => {
        const oldInj = makeEvent({ id: 'i', route: Route.injection, timeH: 100 });
        const newInj = makeEvent({ id: 'i', route: Route.sublingual, timeH: 100 });
        expect(shouldCascadeRemove(oldInj, newInj, [oldInj])).toBeNull();
    });

    it('shouldCascadeRemove returns apply companion when remove→non-patch route', () => {
        const oldRemove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const newEvent = makeEvent({ id: 'r', route: Route.injection, timeH: 200 });
        // 返回的应该是 apply（要被重置 groupId 的那个），而不是 remove 本身
        expect(shouldCascadeRemove(oldRemove, newEvent, [oldRemove, apply])?.id).toBe('a');
    });
});

describe('extras integration (sanity)', () => {
    it('a paired apply/remove pair can carry release rate in apply.extras only', () => {
        const apply = makeEvent({
            id: 'a',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'g',
            extras: { [ExtraKey.releaseRateUGPerDay]: 50 } as DoseEvent['extras'],
        });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g' });
        expect(findPatchRemoveForApply(apply, [remove])?.id).toBe('r');
        expect(apply.extras[ExtraKey.releaseRateUGPerDay]).toBe(50);
    });
});
