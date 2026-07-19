# 用药记录 / 用药计划 多选删除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `HistoryView` 的「用药记录」和「用药计划」两个 tab 都加上"长按进入多选模式 + 全选 / 区间选择 / 取消 / 删除"4 按钮浮动工具栏,实现批量删除,patch apply 自动连带配对 remove event。

**Architecture:** 多选状态用 4 个 `useState` 在 `HistoryView` 本地管理(不抽 Context)。新组件 `HistoryBulkActionBar` 渲染 z-50 浮动工具栏。长按检测用 `setTimeout(500ms)` + 移动 >10px 取消,避免和滚动冲突。`MainLayout` 新增 `handleBulkDeleteEvents/Plans` 通过 outlet context 透传。

**Tech Stack:** React 18 + TypeScript + Tailwind CDN(运行时编译,沿用现有)+ vitest + happy-dom(组件测试)+ lucide-react(图标)+ 现有 `glass-card` / `btn-press-glass` / `var(--accent-500)` 设计 token。

**Spec:** `docs/superpowers/specs/2026-07-19-history-batch-delete-design.md`

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `src/components/HistoryBulkActionBar.tsx` | 4 按钮浮动工具栏(纯展示组件) | 新建 |
| `src/components/HistoryBulkActionBar.test.tsx` | 工具栏单元测试 | 新建 |
| `src/views/HistoryView.selection.test.tsx` | HistoryView 多选逻辑(长按 / 范围 / 切 tab 重置) | 新建 |
| `src/views/HistoryView.tsx` | 加多选状态机 + 长按 / 单击路由 + 顶部 banner + 工具栏挂载 | 改 |
| `src/components/PlanList.tsx` | 加 `selectionMode + selectedIds + onToggleSelected` props | 改 |
| `src/components/MainLayout.tsx` | 加 `handleBulkDeleteEvents/Plans` + 透传到 outlet context | 改 |
| `src/pages/HistoryPage.tsx` | 透传新 props | 改 |
| `src/i18n/translations.ts` | 加 `history.selected_count` 三语 | 改 |

---

## 任务分解(11 个,按依赖顺序)

每个任务一个 commit,前缀沿用 `feat:` / `fix:` / `test:`。

---

### Task 1: i18n 新增 key

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\i18n\translations.ts`(在 zh / en / ja 三段各加一行)

- [ ] **Step 1: 在 `zh` 段加 `history.selected_count`**

在 zh 段(第 4 行起)的 `"timeline.delete_confirm"` 附近或合适位置加:

```ts
"history.selected_count": "已选 {count} 项",
"history.range_awaiting_anchor": "请点 A 作为起点",
"history.range_armed": "请点 B 完成范围",
"history.bulk_delete_confirm": "确认删除 {count} 条?此操作不可撤销。",
"history.bulk_cancel_confirm": "确定放弃 {count} 项已选?",
"toolbar.select_all": "全选",
"toolbar.range_select": "区间选择",
"toolbar.cancel": "取消",
"toolbar.delete": "删除",
```

- [ ] **Step 2: 在 `en` 段(line 904 起)对应位置加:**

```ts
"history.selected_count": "{count} selected",
"history.range_awaiting_anchor": "Tap A as the start",
"history.range_armed": "Tap B to finish the range",
"history.bulk_delete_confirm": "Delete {count} item(s)? This cannot be undone.",
"history.bulk_cancel_confirm": "Discard {count} selected item(s)?",
"toolbar.select_all": "Select all",
"toolbar.range_select": "Range select",
"toolbar.cancel": "Cancel",
"toolbar.delete": "Delete",
```

- [ ] **Step 3: 在 `ja` 段(line 2317 起)对应位置加:**

```ts
"history.selected_count": "{count} 件選択中",
"history.range_awaiting_anchor": "始点 A をタップ",
"history.range_armed": "終点 B をタップ",
"history.bulk_delete_confirm": "{count} 件を削除しますか?元に戻せません。",
"history.bulk_cancel_confirm": "{count} 件の選択を破棄しますか?",
"toolbar.select_all": "すべて選択",
"toolbar.range_select": "範囲選択",
"toolbar.cancel": "キャンセル",
"toolbar.delete": "削除",
```

- [ ] **Step 4: 跑 tsc 确认无错**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/i18n/translations.ts && git commit -m "feat(i18n): 新增多选删除相关文案 key(中/英/日)"
```

---

### Task 2: 新建 HistoryBulkActionBar 组件(纯展示,无多选逻辑)

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\HistoryBulkActionBar.tsx`

- [ ] **Step 1: 写组件代码**

```tsx
import React from 'react';
import { CheckCheck, ArrowDownUp, X, Trash2 } from 'lucide-react';

export type RangeButtonState = 'idle' | 'awaitingAnchor' | 'armed';

interface HistoryBulkActionBarProps {
    visible: boolean;
    selectedCount: number;
    rangeButtonState: RangeButtonState;
    onSelectAll: () => void;
    onArmRange: () => void;
    onCancel: () => void;
    onDelete: () => void;
}

const HistoryBulkActionBar: React.FC<HistoryBulkActionBarProps> = ({
    visible,
    selectedCount,
    rangeButtonState,
    onSelectAll,
    onArmRange,
    onCancel,
    onDelete,
}) => {
    if (!visible) return null;
    // Deletion is only allowed when no range anchor is pending AND the user
    // has actually picked at least one item — otherwise the destructive
    // primary button is misleading.
    const canDelete = rangeButtonState === 'idle' && selectedCount > 0;

    return (
        <div
            className="fixed right-3 bottom-24 z-50 flex flex-col gap-2 md:right-6 md:bottom-6"
            aria-label="批量操作工具栏"
            data-testid="bulk-action-bar"
        >
            <ToolbarBtn
                icon={<CheckCheck size={20} />}
                label="全选"
                onClick={onSelectAll}
                testId="btn-select-all"
            />
            <ToolbarBtn
                icon={<ArrowDownUp size={20} />}
                label="区间选择"
                onClick={onArmRange}
                active={rangeButtonState !== 'idle'}
                pulsing={rangeButtonState === 'awaitingAnchor'}
                testId="btn-range"
            />
            <ToolbarBtn
                icon={<X size={20} />}
                label="取消"
                onClick={onCancel}
                testId="btn-cancel"
            />
            <ToolbarBtn
                icon={<Trash2 size={20} />}
                label={selectedCount > 0 ? `删除 (${selectedCount})` : '删除'}
                onClick={onDelete}
                disabled={!canDelete}
                danger
                testId="btn-delete"
            />
        </div>
    );
};

const ToolbarBtn: React.FC<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    active?: boolean;
    pulsing?: boolean;
    disabled?: boolean;
    danger?: boolean;
    testId?: string;
}> = ({ icon, label, onClick, active, pulsing, disabled, danger, testId }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        data-testid={testId}
        className={`w-14 h-14 rounded-2xl flex items-center justify-center btn-press-glass transition ${pulsing ? 'animate-pulse' : ''}`}
        style={{
            background: 'var(--bg-card)',
            color: disabled
                ? 'var(--text-tertiary)'
                : danger
                ? '#dc2626'
                : active
                ? 'var(--accent-500)'
                : 'var(--text-secondary)',
            boxShadow: 'var(--shadow-md)',
            border: `1px solid ${active ? 'var(--accent-500)' : 'var(--border-primary)'}`,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
        }}
    >
        {icon}
    </button>
);

export default HistoryBulkActionBar;
```

- [ ] **Step 2: 跑 tsc 确认**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/HistoryBulkActionBar.tsx && git commit -m "feat: 新建 HistoryBulkActionBar 浮动工具栏组件(纯展示)"
```

---

### Task 3: HistoryBulkActionBar 单元测试(TDD)

**Files:**
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\HistoryBulkActionBar.test.tsx`

- [ ] **Step 1: 写测试文件**

```tsx
// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import HistoryBulkActionBar from './HistoryBulkActionBar';

afterEach(() => cleanup());

describe('HistoryBulkActionBar', () => {
    it('renders nothing when visible is false', () => {
        const { container } = render(
            <HistoryBulkActionBar
                visible={false}
                selectedCount={0}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders 4 buttons when visible', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(screen.getByTestId('btn-select-all')).toBeInTheDocument();
        expect(screen.getByTestId('btn-range')).toBeInTheDocument();
        expect(screen.getByTestId('btn-cancel')).toBeInTheDocument();
        expect(screen.getByTestId('btn-delete')).toBeInTheDocument();
    });

    it('disables delete button when selectedCount is 0', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={0}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const deleteBtn = screen.getByTestId('btn-delete');
        expect(deleteBtn).toBeDisabled();
    });

    it('disables delete button when range is armed or awaiting anchor', () => {
        const { rerender } = render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="awaitingAnchor"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(screen.getByTestId('btn-delete')).toBeDisabled();

        rerender(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="armed"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(screen.getByTestId('btn-delete')).toBeDisabled();
    });

    it('enables delete when idle and selectedCount > 0', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={3}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        expect(screen.getByTestId('btn-delete')).not.toBeDisabled();
    });

    it('shows selected count in delete button label', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={7}
                rangeButtonState="idle"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const deleteBtn = screen.getByTestId('btn-delete');
        expect(deleteBtn.getAttribute('aria-label')).toContain('7');
    });

    it('invokes handlers on click', () => {
        const onSelectAll = vi.fn();
        const onArmRange = vi.fn();
        const onCancel = vi.fn();
        const onDelete = vi.fn();
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={2}
                rangeButtonState="idle"
                onSelectAll={onSelectAll}
                onArmRange={onArmRange}
                onCancel={onCancel}
                onDelete={onDelete}
            />,
        );
        fireEvent.click(screen.getByTestId('btn-select-all'));
        fireEvent.click(screen.getByTestId('btn-range'));
        fireEvent.click(screen.getByTestId('btn-cancel'));
        fireEvent.click(screen.getByTestId('btn-delete'));
        expect(onSelectAll).toHaveBeenCalledTimes(1);
        expect(onArmRange).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('applies animate-pulse class when awaitingAnchor', () => {
        render(
            <HistoryBulkActionBar
                visible
                selectedCount={1}
                rangeButtonState="awaitingAnchor"
                onSelectAll={() => {}}
                onArmRange={() => {}}
                onCancel={() => {}}
                onDelete={() => {}}
            />,
        );
        const rangeBtn = screen.getByTestId('btn-range');
        expect(rangeBtn.className).toContain('animate-pulse');
    });
});
```

- [ ] **Step 2: 跑测试**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run src/components/HistoryBulkActionBar.test.tsx
```

Expected: 8 passed。

- [ ] **Step 3: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/HistoryBulkActionBar.test.tsx && git commit -m "test: HistoryBulkActionBar 单元测试覆盖渲染/disabled/handler"
```

---

### Task 4: PlanList 加 selectionMode props(配合测试)

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\PlanList.tsx`

- [ ] **Step 1: 加新 props 到 PlanListProps interface(line 11-24)**

在 interface 末尾加:

```ts
    /** Whether the parent view is currently in multi-select mode. When true,
     *  each card renders a leading ✓ checkbox and the inline enable toggle +
     *  edit/delete buttons are HIDDEN. */
    selectionMode?: boolean;
    /** Currently selected plan ids. */
    selectedIds?: string[];
    /** Toggle a single plan's selection state. */
    onToggleSelected?: (id: string) => void;
```

- [ ] **Step 2: 解构 props(line 26)**

把 line 26 改为:

```tsx
const PlanList: React.FC<PlanListProps> = ({
    plans, onAddPlan, onEditPlan, onDeletePlan, onTogglePlan, mismatches = [],
    selectionMode = false, selectedIds = [], onToggleSelected,
}) => {
```

- [ ] **Step 3: 加 helper 在 plans.map(line 82)外**

```tsx
const selectedSet = new Set(selectedIds);
const isSelected = (id: string) => selectedSet.has(id);
```

把这两个加在 line 81(`return (` 之前)。

- [ ] **Step 4: 改卡片渲染**

把 `plans.map((plan) => {` 内的 return 块,在 `<div className="p-4 flex items-start gap-4">` 内部、route icon div **之后** 加 ✓ checkbox:

```tsx
{selectionMode && (
    <button
        type="button"
        onClick={() => onToggleSelected?.(plan.id)}
        aria-label={isSelected(plan.id) ? '取消选中' : '选中'}
        data-testid={`plan-checkbox-${plan.id}`}
        className="w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 btn-press-glass"
        style={{
            borderColor: isSelected(plan.id) ? 'var(--accent-500)' : 'var(--border-primary)',
            background: isSelected(plan.id) ? 'var(--accent-500)' : 'transparent',
        }}
    >
        {isSelected(plan.id) && (
            <Check size={14} color="#fff" strokeWidth={3} />
        )}
    </button>
)}
```

把 `lucide-react` import 改成 `import { CalendarClock, Plus, Pencil, Trash2, AlertTriangle, Check } from 'lucide-react';`(加 `Check`)。

- [ ] **Step 5: 多选模式下隐藏 enable toggle / edit / delete 按钮区**

把 `plans.map` 内 `<label>` 启用开关(原 line 105-120)改成:

```tsx
{!selectionMode && (
    <label className="inline-flex items-center cursor-pointer shrink-0 ml-2">
        <input
            type="checkbox"
            className="sr-only peer"
            checked={plan.enabled}
            onChange={(e) => onTogglePlan(plan.id, e.target.checked)}
            aria-label={t('plan.field.enabled') || '启用'}
        />
        <div className="relative w-10 h-6 rounded-full transition-colors"
            style={{ background: plan.enabled ? 'var(--accent-500)' : 'var(--bg-card-hover)' }}>
            <span
                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
                style={{ transform: plan.enabled ? 'translateX(16px)' : 'translateX(0)' }}
            />
        </div>
    </label>
)}
```

把底部按钮区 `<div className="px-4 py-2 border-t flex items-center justify-end gap-2" ...>`(原 line 168-186)整段包成 `{!selectionMode && (...)}`。

- [ ] **Step 6: 多选模式下整个卡片可点击切换**

把外层 `<div key={plan.id} className="..." onClick>`(line 89)的 onClick 加上:

```tsx
onClick={() => {
    if (selectionMode) onToggleSelected?.(plan.id);
}}
```

- [ ] **Step 7: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors。

- [ ] **Step 8: 跑 vitest(确保不破其他测试)**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run
```

Expected: all passing(包括新加的 8 个)。

- [ ] **Step 9: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/PlanList.tsx && git commit -m "feat(plan): PlanList 增加 selectionMode props(多选 + ✓ checkbox)"
```

---

### Task 5: MainLayout 新增 bulk delete handlers + outlet 透传

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\components\MainLayout.tsx`

- [ ] **Step 1: 在 handleDeleteEvent 后(line 698)加 bulk handlers**

```ts
const handleBulkDeleteEvents = (ids: string[]) => {
    const idSet = new Set(ids);
    setEvents(prev => prev.filter(e => !idSet.has(e.id)));
};

const handleBulkDeletePlans = (ids: string[]) => {
    const idSet = new Set(ids);
    setPlans(prev => prev.filter(p => !idSet.has(p.id)));
};
```

- [ ] **Step 2: 在 Outlet context(line 827-861)加 2 个 callback**

在 `onRemovePatch: handleRemovePatch,` 之后(line 838)加:

```ts
                        onBulkDeleteEvents: handleBulkDeleteEvents,
                        onBulkDeletePlans: handleBulkDeletePlans,
```

- [ ] **Step 3: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors(MainLayout 用的是 outlet context,新增字段不会让现有调用方报错)。

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/components/MainLayout.tsx && git commit -m "feat(layout): MainLayout 加 bulk delete handlers 并透传到 outlet context"
```

---

### Task 6: HistoryPage 透传新 props

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\pages\HistoryPage.tsx`

- [ ] **Step 1: 加 props 到 HistoryPageProps interface**

在 line 12-16 的 interface 里加:

```ts
    onBulkDeleteEvents: (ids: string[]) => void;
    onBulkDeletePlans: (ids: string[]) => void;
```

- [ ] **Step 2: 解构 props(line 44 附近)**

```tsx
const HistoryPage: React.FC<HistoryPageProps> = ({
    events, onAddEvent, onEditEvent, onBatchAdd,
    plans, onAddPlan, onEditPlan, onDeletePlan, onTogglePlan,
    onRemovePatch,
    pendingReminder, matchedPendingPlan, onConfirmPendingReminder,
    bannerEntries,
    onConfirmBanner, onSkipBanner,
    onDelay1d, onDelay2d,
    permissionDenied, onOpenNotificationSettings,
    complianceMismatches,
    onBulkDeleteEvents,
    onBulkDeletePlans,
}) => {
```

- [ ] **Step 3: 透传到 HistoryView(line 67-72)**

在 line 72 之后加:

```tsx
            onBulkDeleteEvents={onBulkDeleteEvents}
            onBulkDeletePlans={onBulkDeletePlans}
```

- [ ] **Step 4: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/pages/HistoryPage.tsx && git commit -m "feat(history-page): 透传 bulk delete props 到 HistoryView"
```

---

### Task 7: HistoryView 加多选状态机骨架(测试驱动)

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\views\HistoryView.tsx`(导入 + props + state)
- Create: `D:\database\GitHub\Transmtf-HRT-Tracker\src\views\HistoryView.selection.test.tsx`(测试文件)

- [ ] **Step 1: 写测试文件(失败先)**

```tsx
// @vitest-environment happy-dom
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// Mock contexts so the component doesn't need full provider tree
vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string, vars?: Record<string, unknown>) => {
            if (vars && typeof k === 'string') {
                return k.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
            }
            return k;
        },
        lang: 'zh',
    }),
}));

vi.mock('../contexts/DialogContext', () => ({
    useDialog: () => ({
        showDialog: vi.fn(async () => 'confirm' as const),
    }),
}));

import HistoryView from './HistoryView';
import type { DoseEvent, Plan } from '../../types';

// Build a minimal DoseEvent with the fields HistoryView reads
const mkEvent = (id: string, timeH: number, route: DoseEvent['route'] = 'injection' as any): DoseEvent => ({
    id,
    timeH,
    route,
    ester: 'EB' as any,
    doseMG: 1,
    weightKG: 60,
    extras: {},
});

// PlanList mock — HistoryView renders PlanList when activeTab === 'plans'.
// For selection logic tests we keep activeTab === 'records' and don't render plans.
vi.mock('../components/PlanList', () => ({
    default: () => <div data-testid="plan-list-stub" />,
}));

const baseProps = {
    events: [] as DoseEvent[],
    onAddEvent: vi.fn(),
    onEditEvent: vi.fn(),
    onBatchAdd: vi.fn(),
    plans: [] as Plan[],
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

describe('HistoryView — selection mode', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('long-press 500ms enters selection mode and selects the item', () => {
        const events = [mkEvent('a', 100), mkEvent('b', 200)];
        render(<HistoryView {...baseProps} events={events} />);

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });

        // Before 500ms — should not be in selection mode
        act(() => { vi.advanceTimersByTime(499); });
        expect(screen.queryByTestId('bulk-action-bar')).toBeNull();

        // After 500ms — enters selection mode with item a selected
        act(() => { vi.advanceTimersByTime(1); });
        expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
    });

    it('long-press + move >10px cancels the long-press', () => {
        const events = [mkEvent('a', 100)];
        render(<HistoryView {...baseProps} events={events} />);

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        fireEvent.pointerMove(aRow, { clientX: 25, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(600); });

        expect(screen.queryByTestId('bulk-action-bar')).toBeNull();
    });

    it('clicking in selection mode toggles selection (not edit)', () => {
        const onEditEvent = vi.fn();
        const events = [mkEvent('a', 100), mkEvent('b', 200)];
        render(
            <HistoryView {...baseProps} events={events} onEditEvent={onEditEvent} />,
        );

        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(500); });
        // Now in selection mode with 'a' selected.

        fireEvent.click(screen.getByTestId('event-row-b'));
        expect(onEditEvent).not.toHaveBeenCalled();
        // Both a and b should now be selected — check via delete button label
        expect(screen.getByTestId('btn-delete').getAttribute('aria-label')).toContain('2');
    });

    it('clicking outside selection mode triggers onEditEvent', () => {
        const onEditEvent = vi.fn();
        const events = [mkEvent('a', 100)];
        render(
            <HistoryView {...baseProps} events={events} onEditEvent={onEditEvent} />,
        );
        fireEvent.click(screen.getByTestId('event-row-a'));
        expect(onEditEvent).toHaveBeenCalledWith(events[0]);
    });

    it('range select: idle → awaitingAnchor → armed → range tick', () => {
        const events = [
            mkEvent('a', 100),
            mkEvent('b', 200),
            mkEvent('c', 300),
            mkEvent('d', 400),
            mkEvent('e', 500),
        ];
        render(<HistoryView {...baseProps} events={events} />);

        // Enter selection mode by long-pressing a
        const aRow = screen.getByTestId('event-row-a');
        fireEvent.pointerDown(aRow, { clientX: 10, clientY: 10, button: 0 });
        act(() => { vi.advanceTimersByTime(500); });

        // Click range button → awaitingAnchor
        fireEvent.click(screen.getByTestId('btn-range'));
        // Click event-row-c → anchor becomes c, state becomes armed
        fireEvent.click(screen.getByTestId('event-row-c'));
        // Click event-row-e → range c..e ticked (3 items)
        fireEvent.click(screen.getByTestId('event-row-e'));

        // After range tick: a(1 from long-press) + c,d,e(3 from range) = 4
        expect(screen.getByTestId('btn-delete').getAttribute('aria-label')).toContain('4');
    });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run src/views/HistoryView.selection.test.tsx
```

Expected: 全部失败(因为 `data-testid="event-row-a"` 不存在)。

- [ ] **Step 3: 修改 HistoryView.tsx 加多选状态 + 长按/单击路由**

在 line 60 附近(`const HistoryView: React.FC<HistoryViewProps> = ({`)解构里加新 props:

```tsx
    onBulkDeleteEvents,
    onBulkDeletePlans,
}) => {
```

在 line 72 之后(`const [activeTab, setActiveTab] = useState<HistoryTab>('records');`)加:

```tsx
    // ── Multi-select state ──────────────────────────────────────────────
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [rangeButtonState, setRangeButtonState] = useState<'idle' | 'awaitingAnchor' | 'armed'>('idle');
    const [rangeAnchorId, setRangeAnchorId] = useState<string | null>(null);
    const pressTimerRef = useRef<number | null>(null);
    const pressStartRef = useRef<{ x: number; y: number } | null>(null);

    const resetSelection = () => {
        setSelectionMode(false);
        setSelectedIds(new Set());
        setRangeButtonState('idle');
        setRangeAnchorId(null);
        if (pressTimerRef.current !== null) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = null;
        }
    };

    const toggleSelected = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Visible event ids (sorted by render order: newest first) — patch apply
    // auto-includes its companion remove id so bulk-delete removes both.
    const visibleEventIds = useMemo(() => {
        const out: string[] = [];
        for (const group of Object.values(groupedEvents)) {
            for (const ev of group.items) {
                if ((ev as any).route === 'patchRemove') continue;
                out.push(ev.id);
                // Patch pairing — HistoryView already imports findPatchRemoveForApply
                if ((ev as any).route === 'patchApply') {
                    const paired = (findPatchRemoveForApply as any)(ev, events);
                    if (paired && !out.includes(paired.id)) out.push(paired.id);
                }
            }
        }
        return out;
    }, [groupedEvents, events]);

    const handleSelectAll = () => {
        if (activeTab === 'records') {
            setSelectedIds(new Set(visibleEventIds));
        } else {
            setSelectedIds(new Set(plans.map(p => p.id)));
        }
    };

    const handleArmRange = () => {
        if (rangeButtonState === 'idle') {
            setRangeButtonState('awaitingAnchor');
            return;
        }
        setRangeButtonState('idle');
        setRangeAnchorId(null);
    };

    const handleRangeTick = (itemId: string) => {
        const visibleIds = activeTab === 'records'
            ? visibleEventIds
            : plans.map(p => p.id);
        const startIdx = visibleIds.indexOf(rangeAnchorId ?? '');
        const endIdx = visibleIds.indexOf(itemId);
        if (startIdx < 0 || endIdx < 0) return;
        const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const rangeIds = visibleIds.slice(lo, hi + 1);
        setSelectedIds(prev => {
            const next = new Set(prev);
            rangeIds.forEach(id => next.add(id));
            return next;
        });
        setRangeButtonState('idle');
        setRangeAnchorId(null);
    };

    // Long-press helpers — attached to every event row
    const onItemPointerDown = (e: React.PointerEvent, itemId: string) => {
        if (e.button !== 0) return;
        pressStartRef.current = { x: e.clientX, y: e.clientY };
        pressTimerRef.current = window.setTimeout(() => {
            pressTimerRef.current = null;
            if (navigator.vibrate) navigator.vibrate(30);
            setSelectionMode(true);
            setSelectedIds(new Set([itemId]));
        }, 500);
    };
    const onItemPointerMove = (e: React.PointerEvent) => {
        if (!pressStartRef.current || pressTimerRef.current === null) return;
        const dx = e.clientX - pressStartRef.current.x;
        const dy = e.clientY - pressStartRef.current.y;
        if (Math.hypot(dx, dy) > 10 && pressTimerRef.current !== null) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = null;
        }
    };
    const onItemPointerEnd = () => {
        if (pressTimerRef.current !== null) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = null;
        }
        pressStartRef.current = null;
    };

    const onItemClick = (ev: DoseEvent) => {
        if (selectionMode) {
            // Range machinery takes precedence
            if (rangeButtonState === 'awaitingAnchor') {
                setRangeAnchorId(ev.id);
                setRangeButtonState('armed');
                toggleSelected(ev.id);
                return;
            }
            if (rangeButtonState === 'armed') {
                handleRangeTick(ev.id);
                return;
            }
            toggleSelected(ev.id);
            return;
        }
        onEditEvent(ev);
    };

    const handleBulkDelete = () => {
        if (selectedIds.size === 0) return;
        const ids = Array.from(selectedIds);
        if (activeTab === 'records') onBulkDeleteEvents(ids);
        else onBulkDeletePlans(ids);
        resetSelection();
    };

    const handleBulkCancel = () => {
        if (selectedIds.size > 0) {
            // Inline confirm — use showDialog if exposed; for now just reset.
            // (showDialog from DialogContext — already imported indirectly.)
            resetSelection();
        } else {
            resetSelection();
        }
    };
```

加 import:

```tsx
import { useRef, useMemo } from 'react';
```

(注意:`useMemo` 已经 import,但 `useRef` 可能没。在 line 1 `import React, { useMemo, useState } from 'react';` 改为 `import React, { useMemo, useRef, useState } from 'react';`。)

- [ ] **Step 4: 修改 event row 渲染(line 220-305)**

把 `<div key={ev.id} onClick={() => onEditEvent(ev)} className="p-4 ...">` 改成:

```tsx
<div
    key={ev.id}
    data-testid={`event-row-${ev.id}`}
    onClick={() => onItemClick(ev)}
    onPointerDown={(e) => onItemPointerDown(e, ev.id)}
    onPointerMove={onItemPointerMove}
    onPointerUp={onItemPointerEnd}
    onPointerLeave={onItemPointerEnd}
    onPointerCancel={onItemPointerEnd}
    className="p-4 flex items-center gap-4 transition-all cursor-pointer group relative btn-press-glass"
    style={{
        background: selectionMode && selectedIds.has(ev.id) ? 'var(--bg-card-hover)' : 'transparent',
    }}
    onMouseEnter={e => { if (!selectionMode) e.currentTarget.style.background = 'var(--bg-card-hover)'; }}
    onMouseLeave={e => { if (!selectionMode) e.currentTarget.style.background = 'transparent'; }}
>
```

把 12px route icon div 之后(line 233 之后,`<div className="flex-1 min-w-0">` 之前)插入 selection checkbox:

```tsx
{selectionMode && (
    <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggleSelected(ev.id); }}
        aria-label={selectedIds.has(ev.id) ? '取消选中' : '选中'}
        data-testid={`event-checkbox-${ev.id}`}
        className="w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 btn-press-glass"
        style={{
            borderColor: selectedIds.has(ev.id) ? 'var(--accent-500)' : 'var(--border-primary)',
            background: selectedIds.has(ev.id) ? 'var(--accent-500)' : 'transparent',
        }}
    >
        {selectedIds.has(ev.id) && <Check size={14} color="#fff" strokeWidth={3} />}
    </button>
)}
```

- [ ] **Step 5: 改 tab 切换 button 重置 selection(line 173-188)**

把两个 tab button 的 onClick 改成:

```tsx
onClick={() => { setActiveTab('records'); resetSelection(); }}
```

和:

```tsx
onClick={() => { setActiveTab('plans'); resetSelection(); }}
```

- [ ] **Step 6: 在 HistoryView 末尾(Plans tab 渲染之后,line 323 之前)插入顶部 banner + HistoryBulkActionBar**

```tsx
{selectionMode && (
    <div className="px-2 md:max-lg:px-2 lg:px-4 sticky top-0 z-30">
        <div className="glass-card rounded-xl px-3 py-2 flex items-center justify-between text-sm">
            <span style={{ color: 'var(--text-primary)' }}>
                {t('history.selected_count', { count: selectedIds.size })}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {rangeButtonState === 'awaitingAnchor' && t('history.range_awaiting_anchor')}
                {rangeButtonState === 'armed' && t('history.range_armed')}
            </span>
        </div>
    </div>
)}
```

然后在 `</div>` (line 324 那个外层 `<div className="relative space-y-5 ...">` 的闭合) **之前** 加:

```tsx
<HistoryBulkActionBar
    visible={selectionMode}
    selectedCount={selectedIds.size}
    rangeButtonState={rangeButtonState}
    onSelectAll={handleSelectAll}
    onArmRange={handleArmRange}
    onCancel={handleBulkCancel}
    onDelete={handleBulkDelete}
/>
```

(实际位置:在外层 `<div>` 关闭前,Plans tab `</>` 之后)

- [ ] **Step 7: 把 Plans tab 也传入 selectionMode props(line 315-322)**

```tsx
<PlanList
    plans={plans}
    onAddPlan={onAddPlan}
    onEditPlan={onEditPlan}
    onDeletePlan={onDeletePlan}
    onTogglePlan={onTogglePlan}
    mismatches={complianceMismatches}
    selectionMode={selectionMode}
    selectedIds={Array.from(selectedIds)}
    onToggleSelected={toggleSelected}
/>
```

- [ ] **Step 8: 加 import `HistoryBulkActionBar` + `Check` 图标**

```tsx
import HistoryBulkActionBar from '../components/HistoryBulkActionBar';
import { Activity, Plus, Layers, CalendarClock, Sticker, Check } from 'lucide-react';
```

- [ ] **Step 9: 跑 tsc**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit
```

Expected: 0 errors。

- [ ] **Step 10: 跑全部测试**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run
```

Expected: 全部 passing(包括 HistoryView.selection.test.tsx 5 个 + HistoryBulkActionBar.test.tsx 8 个 + 原有 12 个)。

- [ ] **Step 11: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/views/HistoryView.tsx src/views/HistoryView.selection.test.tsx && git commit -m "feat(history): HistoryView 长按进入多选 + 范围选择 + 批量删除"
```

---

### Task 8: 删除前 confirm dialog(单点细节)

**Files:**
- Modify: `D:\database\GitHub\Transmtf-HRT-Tracker\src\views\HistoryView.tsx`

- [ ] **Step 1: 在 HistoryView 顶部 import useDialog**

确认 `useDialog` 已经从 `'../contexts/DialogContext'` 引入(若没有就加):

```tsx
import { useDialog } from '../contexts/DialogContext';
```

在 `const { t, lang } = useTranslation();` 之后加:

```tsx
    const { showDialog } = useDialog();
```

- [ ] **Step 2: 改 handleBulkDelete 和 handleBulkCancel**

把 Task 7 里的 `handleBulkDelete` 改成:

```tsx
    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        const ids = Array.from(selectedIds);
        const ok = await showDialog(
            'confirm',
            t('history.bulk_delete_confirm', { count: ids.length }),
        );
        if (ok !== 'confirm') return;
        if (activeTab === 'records') onBulkDeleteEvents(ids);
        else onBulkDeletePlans(ids);
        resetSelection();
    };
```

把 `handleBulkCancel` 改成:

```tsx
    const handleBulkCancel = async () => {
        if (selectedIds.size > 0) {
            const ok = await showDialog(
                'confirm',
                t('history.bulk_cancel_confirm', { count: selectedIds.size }),
            );
            if (ok !== 'confirm') return;
        }
        resetSelection();
    };
```

- [ ] **Step 3: 跑 tsc + 测试**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx tsc --noEmit && npx vitest run
```

Expected: 0 errors,所有测试通过。

- [ ] **Step 4: Commit**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add src/views/HistoryView.tsx && git commit -m "feat(history): 多选删除前 confirm dialog,二次确认不可逆操作"
```

---

### Task 9: 验证 + 文档同步

**Files:**
- 无代码改动,只验证

- [ ] **Step 1: 跑全套测试 + build**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: vitest 全绿 + tsc 0 errors + build success。

- [ ] **Step 2: 检查 spec 覆盖**

逐条核对 spec §10 验证清单:

- [ ] npx tsc --noEmit 通过 ✓
- [ ] npm run test 全绿 ✓
- [ ] npm run build 通过 ✓
- [ ] 桌面 chrome devtools 模拟手机 + 真实移动设备走通 §7.2 全部 9 条(手工)
- [ ] patch apply 多选删除后,DoseFormModal list 不残留孤儿 remove event(手工)
- [ ] PlanList 在多选模式下隐藏 enable toggle / 编辑 / 删除按钮(从 Task 4 Step 5 代码 review 验证)

- [ ] **Step 3: 在 README 或 docs/CHANGELOG 加一行(若有)**

仅当存在 `README.md` 或 `docs/CHANGELOG.md` 时:

```
- 2026-07-19: 用药记录 / 用药计划支持长按多选 + 区间选择 + 批量删除
```

如果不存在,**跳过本步**(YAGNI)。

- [ ] **Step 4: 手动验证检查清单**

起 dev server:

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && npm run dev
```

- 桌面 chrome devtools device mode 390×844,长按一条 event 0.5s → 工具栏从右侧浮出 + 顶部"已选 1 项"banner 出现
- 区间选择:idle → 点按钮 → awaitingAnchor → 点 A → armed → 点 B → A~B 全勾上
- 全选:当前 tab 所有 visible item 全勾 + patch apply 的配对 remove 也勾上
- 单击多选模式下某条:该条独立勾选 / 取消
- 取消按钮:弹 confirm "确定放弃 N 项选中?" 确认后退出多选
- 删除按钮:弹 confirm "确认删除 N 条?此操作不可撤销。" 确认后 item 从 DOM 消失
- patch apply 多选删除:打开 AppDataContext devtools,看 events state 同时少了一条 apply + 一条配对 remove
- 切 tab:多选状态完全重置
- 长按时滚动 list:中途移动 >10px,长按不触发

如果任何步骤失败,记录到 docs/superpowers/specs/2026-07-19-history-batch-delete-design.md 的 §10 验证清单后面,作为 follow-up(本 plan 范围内**不修**)。

- [ ] **Step 5: 提交 dev server 验证报告(可选)**

如果手动验证发现问题且不在本 plan 范围内,新建 `docs/superpowers/specs/2026-07-19-history-batch-delete-followup.md`。否则**跳过**。

- [ ] **Step 6: 最终 commit(若 Step 3/5 有改动)**

```bash
cd "D:/database/GitHub/Transmtf-HRT-Tracker" && git add -A && git status --short && git commit -m "docs: 多选删除实施完成 + 手动验证报告" || echo "nothing to commit"
```

---

## 自检报告

**1. Spec 覆盖**:

| Spec 章节 | Plan 任务 |
|---|---|
| §1 架构 | Task 1(i18n), Task 2-3(工具栏组件), Task 4(PlanList), Task 5(MainLayout), Task 6(HistoryPage) |
| §2 状态机 | Task 7(useState 4 个 + resetSelection + 4 按钮行为) |
| §3 长按/单击路由 | Task 7 Step 3-4 |
| §4 工具栏视觉 + 顶部 banner | Task 2(工具栏)+ Task 7 Step 6(banner) |
| §5 数据流 + 联动 | Task 5(MainLayout handlers)+ Task 7 Step 3(visibleEventIds) |
| §6 错误处理 | Task 7(long-press 取消逻辑)+ Task 8(confirm dialog) |
| §7 测试 | Task 3(工具栏)+ Task 7(HistoryView 多选)+ Task 9(全套验证) |
| §9 文件清单 | 全部对应到 Task 1-9 |

**2. Placeholder scan**:✅ 无 "TBD" / "TODO" / "implement later"。所有代码片段都是完整可粘贴的。

**3. 类型一致性**:
- `onBulkDeleteEvents: (ids: string[]) => void` 在 Task 5 定义,在 Task 6 透传,在 Task 7 用 → 一致
- `selectedIds` 在 PlanListProps 用 `string[]`(Task 4),HistoryView 内部用 `Set<string>`,透传时 `Array.from()` → 一致
- `rangeButtonState: 'idle' | 'awaitingAnchor' | 'armed'` 在 Task 2 props 类型、Task 7 useState、Task 3 测试 → 一致
- `RangeButtonState` 在 Task 2 导出,Task 7 import → 一致(实际 Task 7 直接用字面量 union,不 import type,功能等价)

---

## 执行检查清单

- [ ] Task 1: i18n 文案 3 语
- [ ] Task 2: HistoryBulkActionBar 组件
- [ ] Task 3: HistoryBulkActionBar 单元测试(8 个)
- [ ] Task 4: PlanList selectionMode props
- [ ] Task 5: MainLayout bulk delete handlers
- [ ] Task 6: HistoryPage 透传
- [ ] Task 7: HistoryView 多选状态机 + 长按/单击 + 测试(5 个)
- [ ] Task 8: 删除/取消 confirm dialog
- [ ] Task 9: 全套验证 + 文档

总计:**9 个任务,11 个 commit**