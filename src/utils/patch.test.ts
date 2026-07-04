import { describe, it, expect } from 'vitest';
import { DoseEvent, Ester, ExtraKey, Route } from '../../types';
import {
    isPatchApply,
    isPatchRemove,
    patchGroupOf,
    findPatchRemoveForApply,
    findPatchApplyForRemove,
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
    it('falls back to time-axis when groupId is absent (legacy data)', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 100 + 24 });
        expect(findPatchRemoveForApply(apply, [remove])).toBe(remove);
    });
    it('returns null when the time-axis pair is beyond 14 days', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 100 + 15 * 24 });
        expect(findPatchRemoveForApply(apply, [remove])).toBeNull();
    });
    it('returns null when the only candidate is BEFORE the apply', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 200 });
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 100 });
        expect(findPatchRemoveForApply(apply, [remove])).toBeNull();
    });
    it('ignores other-route events even if their time overlaps', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const inj = makeEvent({ id: 'i', route: Route.injection, timeH: 110 });
        expect(findPatchRemoveForApply(apply, [inj])).toBeNull();
    });
    it('picks the EARLIEST remove when multiple fall in the wear window', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        const late = makeEvent({ id: 'l', route: Route.patchRemove, timeH: 150 });
        const early = makeEvent({ id: 'e', route: Route.patchRemove, timeH: 120 });
        expect(findPatchRemoveForApply(apply, [late, early])).toBe(early);
    });
    it('prefers the groupId match over a closer time-axis candidate', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const closerNoGroup = makeEvent({ id: 'c', route: Route.patchRemove, timeH: 105 });
        const groupedFar = makeEvent({ id: 'g', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(findPatchRemoveForApply(apply, [closerNoGroup, groupedFar])).toBe(groupedFar);
    });
    it('does not match the apply event with itself', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100 });
        expect(findPatchRemoveForApply(apply, [apply])).toBeNull();
    });
    it('returns the group match even when the apply has a different group from a closer candidate', () => {
        const apply = makeEvent({ id: 'a', route: Route.patchApply, timeH: 100, companionGroupId: 'g1' });
        const wrongGroup = makeEvent({ id: 'w', route: Route.patchRemove, timeH: 110, companionGroupId: 'g2' });
        const rightGroup = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200, companionGroupId: 'g1' });
        expect(findPatchRemoveForApply(apply, [wrongGroup, rightGroup])).toBe(rightGroup);
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
    it('falls back to time-axis: latest apply in 14d before remove', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200 });
        const early = makeEvent({ id: 'e', route: Route.patchApply, timeH: 100 });
        const late = makeEvent({ id: 'l', route: Route.patchApply, timeH: 180 });
        expect(findPatchApplyForRemove(remove, [early, late])).toBe(late);
    });
    it('returns null when no apply exists in the wear window', () => {
        const remove = makeEvent({ id: 'r', route: Route.patchRemove, timeH: 200 });
        // 20 days before the remove — well outside the 14d wear window.
        const tooEarly = makeEvent({ id: 't', route: Route.patchApply, timeH: 200 - 20 * 24 });
        expect(findPatchApplyForRemove(remove, [tooEarly])).toBeNull();
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
