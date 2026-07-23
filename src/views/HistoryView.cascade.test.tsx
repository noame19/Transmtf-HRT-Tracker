// @vitest-environment happy-dom
import { render, screen, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';

vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string) => k,
        lang: 'zh',
    }),
}));
vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({ showDialog: vi.fn(async () => 'confirm' as const) }),
}));
vi.mock('../components/PlanList', () => ({ default: () => null }));

import HistoryView from './HistoryView';
import { DoseEvent, Route } from '../../types';

const HOUR = 1; // timeH 字段单位是「小时」，这里只是占位，避免歧义
const makeEvent = (overrides: Partial<DoseEvent> = {}): DoseEvent => ({
    id: 'ev',
    route: Route.injection,
    timeH: 100,
    doseMG: 1,
    ester: 'E2' as any,
    weightKG: 60,
    extras: {},
    ...overrides,
});

const baseProps = {
    events: [] as DoseEvent[],
    onAddEvent: vi.fn(),
    onEditEvent: vi.fn(),
    onBatchAdd: vi.fn(),
    plans: [],
    onAddPlan: vi.fn(),
    onEditPlan: vi.fn(),
    onDeletePlan: vi.fn(),
    onTogglePlan: vi.fn(),
    onRemovePatch: vi.fn(),
    pendingReminder: null,
    matchedPendingPlan: null,
    onConfirmPendingReminder: vi.fn(),
    bannerEntries: [],
    onConfirmBanner: vi.fn(),
    onSkipBanner: vi.fn(),
    onDelay1d: vi.fn(),
    onDelay2d: vi.fn(),
    permissionDenied: false,
    complianceMismatches: [],
    onBulkDeleteEvents: vi.fn(),
    onBulkDeletePlans: vi.fn(),
};

afterEach(() => cleanup());

describe('HistoryView — patch apply/remove cascade rendering', () => {
    it('renders apply row, hides remove row (cascaded inline)', () => {
        // HistoryView 的 groupedEvents 已 filter 掉 patchRemove，避免空日期栏。
        // 而 visibleEventIds 在 select-all 时仍把配对 remove id 一起带上。
        const apply = makeEvent({
            id: 'apply-1',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'g1',
        });
        const remove = makeEvent({
            id: 'remove-1',
            route: Route.patchRemove,
            timeH: 200,
            companionGroupId: 'g1',
        });
        render(<HistoryView {...baseProps} events={[apply, remove]} />);
        // apply 行渲染
        expect(screen.getByTestId('event-row-apply-1')).toBeTruthy();
        // remove 行不渲染（groupedEvents 已 filter 掉 patchRemove）
        expect(screen.queryByTestId('event-row-remove-1')).toBeNull();
    });

    it('shows inline "摘下时间" hint on the apply card', () => {
        // 配对成功时 apply 卡片下面应该显示撕下时间提示
        const apply = makeEvent({
            id: 'apply-2',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'g2',
        });
        const remove = makeEvent({
            id: 'remove-2',
            route: Route.patchRemove,
            timeH: 200,
            companionGroupId: 'g2',
        });
        render(<HistoryView {...baseProps} events={[apply, remove]} />);
        const applyRow = screen.getByTestId('event-row-apply-2');
        const text = applyRow.textContent || '';
        const hasRemoveHint = text.includes('overview.patch_removed_at')
            || text.includes('route.patchRemove');
        expect(hasRemoveHint).toBe(true);
    });

    it('still shows "贴片移除" button when apply has no paired remove', () => {
        // 没配对的 apply → 一键撕下按钮
        const apply = makeEvent({
            id: 'apply-lonely',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'lonely',
        });
        render(<HistoryView {...baseProps} events={[apply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });

    it('shows "贴片移除" button for newly-saved apply with own groupId and no remove', () => {
        // 用户场景：从 DoseFormModal 新建贴片没填摘下时间保存，apply 带 groupId，
        // 没有对应的 remove → 按钮必须显示
        const apply = makeEvent({
            id: 'fresh-apply',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'fresh',
        });
        render(<HistoryView {...baseProps} events={[apply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });

    it('shows "贴片移除" button even when 14d window contains an UNRELATED paired (apply, remove) group', () => {
        // 真实 bug 4：先批量添加 (apply+remove) 对（有 groupId），再新建一条 apply（有 groupId）。
        // 新 apply 落在 14 天窗口内，按钮必须仍然显示（strict groupId 不被无关 remove 干扰）
        const pairedApply = makeEvent({
            id: 'paired-apply',
            route: Route.patchApply,
            timeH: 100,
            companionGroupId: 'paired',
        });
        const pairedRemove = makeEvent({
            id: 'paired-remove',
            route: Route.patchRemove,
            timeH: 108,
            companionGroupId: 'paired',
        });
        const freshApply = makeEvent({
            id: 'fresh-apply',
            route: Route.patchApply,
            timeH: 104,
            companionGroupId: 'fresh', // 自己独立的 groupId
        });
        render(<HistoryView {...baseProps} events={[pairedApply, pairedRemove, freshApply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });

    it('hides "贴片移除" button for legacy apply without groupId when 14d window has a remove', () => {
        // 老数据兼容：apply 无 groupId，14 天内有 remove（也是无 groupId）→ 按钮不显示
        const apply = makeEvent({
            id: 'legacy-apply',
            route: Route.patchApply,
            timeH: 100,
        });
        const remove = makeEvent({
            id: 'legacy-remove',
            route: Route.patchRemove,
            timeH: 108,
        });
        render(<HistoryView {...baseProps} events={[apply, remove]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeNull();
    });
});