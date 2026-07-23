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
});