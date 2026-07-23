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

const HOUR = 3600000;
const makeEvent = (overrides: Partial<DoseEvent> = {}): DoseEvent => ({
    id: 'ev',
    route: Route.injection,
    timeH: 100 * HOUR,
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
            timeH: 100 * HOUR,
            companionGroupId: 'g1',
        });
        const remove = makeEvent({
            id: 'remove-1',
            route: Route.patchRemove,
            timeH: 200 * HOUR,
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
            timeH: 100 * HOUR,
            companionGroupId: 'g2',
        });
        const remove = makeEvent({
            id: 'remove-2',
            route: Route.patchRemove,
            timeH: 200 * HOUR,
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
            timeH: 100 * HOUR,
            companionGroupId: 'lonely',
        });
        render(<HistoryView {...baseProps} events={[apply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });

    it('shows "贴片移除" button for newly-saved apply with no groupId and no remove', () => {
        // 用户报告的 bug：新建贴片没填摘下时间保存后，按钮不见了。
        // 这种 apply 没有 companionGroupId 也没有任何配对 remove，按钮必须可见。
        const apply = makeEvent({
            id: 'fresh-apply',
            route: Route.patchApply,
            timeH: 100 * HOUR,
            // 注意：故意不设 companionGroupId
        });
        render(<HistoryView {...baseProps} events={[apply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });

    it('shows "贴片移除" button even when 14d fallback would find another remove', () => {
        // 用户报告的 root cause：批量添加生成 (apply+remove) 对后，用户新建一条无摘下时间的 apply，
        // 新 apply 没 groupId 但时间落在 14 天窗口内 → findPatchRemoveForApply 的兜底分支
        // 错误地把批量那条 remove 配给它 → 按钮消失。新建 apply 的按钮必须可见。
        const pairedApply = makeEvent({
            id: 'paired-apply',
            route: Route.patchApply,
            timeH: 100 * HOUR,
            companionGroupId: 'paired',
        });
        const pairedRemove = makeEvent({
            id: 'paired-remove',
            route: Route.patchRemove,
            timeH: 108 * HOUR, // 8 天后
            companionGroupId: 'paired',
        });
        const freshApply = makeEvent({
            id: 'fresh-apply',
            route: Route.patchApply,
            timeH: 104 * HOUR, // 落在 14 天窗口内但完全无关
            // 无 groupId
        });
        render(<HistoryView {...baseProps} events={[pairedApply, pairedRemove, freshApply]} />);
        const btn = screen.queryByLabelText('btn.patch_remove');
        expect(btn).toBeTruthy();
    });
});