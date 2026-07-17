# 用药提醒防错触交互 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"该用药弹窗"、"过期补打卡弹窗"、"用药页 banner"三个地方共 11 个选项按钮从"点一下生效"改成"点两下生效"，用"按钮原地等待确认"模式替代原"弹窗的弹窗"二次确认。

**Architecture:** 抽出一个 `useConfirmButton` 状态机钩子（跟踪"当前在等待哪个按钮"），和一个 `ConfirmButton` UI 组件（封装"透明+普通描边 ↔ 主题色背景+无描边"视觉变化）。ReminderModal、ReminderBanner 改造时复用这两个新文件。DoseFormModal 不动。

**Tech Stack:** React 18 + TypeScript + Vite 6 + Tailwind CSS + vitest + @testing-library/react。沿用现有 `useDialog` 不变。

---

## 文件结构

### 新增
- `src/hooks/useConfirmButton.ts` — 状态机钩子（点击、切换、触发、查询当前等待的按钮）
- `src/hooks/useConfirmButton.test.ts` — 状态机单元测试（vitest + @testing-library/react 的 `renderHook`）
- `src/components/ConfirmButton.tsx` — UI 组件（封装等待确认视觉 + 键盘可达性 + 屏幕阅读器）
- `src/components/ConfirmButton.test.tsx` — 组件测试

### 修改
- `src/components/ReminderModal.tsx` — on_time 3 按钮 + late 4 按钮（含警告展开）改用 ConfirmButton
- `src/components/ReminderBanner.tsx` — 4 按钮改用 ConfirmButton（跳过本次保留 showDialog）
- `src/components/MainLayout.tsx` — 给 `<ReminderBanner>` 加会随路由变的 `key` 强制重置
- `src/i18n/translations.ts` — 新增 1 个翻译键 × 4 语言

### 不修改
- `src/contexts/DialogContext.tsx`（banner 的跳过本次仍走 `showDialog`）
- `src/components/DoseFormModal.tsx`（不在本设计范围）
- `src/components/MainLayout.tsx` 的 `handleSkipPending` / `handleConfirmBanner` / `handleDelayPlan`（回调链不变）

---

## Task 1: 抽 useConfirmButton 状态机钩子

**Files:**
- Create: `src/hooks/useConfirmButton.ts`
- Create: `src/hooks/useConfirmButton.test.ts`

- [ ] **Step 1: 写失败测试**

`src/hooks/useConfirmButton.test.ts`:

```ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useConfirmButton } from './useConfirmButton';

describe('useConfirmButton', () => {
  it('点击 X 后当前等待标记变成 X', () => {
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    expect(result.current.pending).toBe('X');
  });

  it('等待 X 时再次点 X 触发 X 的处理函数并清空标记', () => {
    const onX = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.request('X', { onTrigger: onX }));
    expect(onX).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it('等待 X 时点 Y 切到 Y,X 恢复,handler 不触发', () => {
    const onX = vi.fn();
    const onY = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X', { onTrigger: onX }));
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onX).not.toHaveBeenCalled();
    expect(onY).not.toHaveBeenCalled();
    expect(result.current.pending).toBe('Y');
  });

  it('切到 Y 后再点 Y 才触发 Y,不在第一次点 Y 时触发', () => {
    const onY = vi.fn();
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onY).not.toHaveBeenCalled();
    act(() => result.current.request('Y', { onTrigger: onY }));
    expect(onY).toHaveBeenCalledTimes(1);
  });

  it('reset() 清空当前等待标记', () => {
    const { result } = renderHook(() => useConfirmButton());
    act(() => result.current.request('X'));
    act(() => result.current.reset());
    expect(result.current.pending).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

运行命令:
```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run src/hooks/useConfirmButton.test.ts
```

预期输出: FAIL with "Cannot find module './useConfirmButton'"（或类似 module-not-found 错误）。

- [ ] **Step 3: 实现状态机**

`src/hooks/useConfirmButton.ts`:

```ts
import { useCallback, useRef, useState } from 'react';

type Key = string;

/**
 * 双击确认状态机:同一个"容器"内同一时刻只有一个按钮处于"等待第二次点击"状态。
 * - 第一次点 X:pending = X
 * - 第二次点 X(在等待中):触发 onTrigger,pending = null
 * - 等待 X 时点 Y:pending 切到 Y,旧 X 不触发
 * - reset():外部主动清空(用于"X 关闭弹窗"、"翻页重置"等场景)
 */
export interface UseConfirmButtonResult {
  pending: Key | null;
  request: (key: Key, opts?: { onTrigger?: () => void }) => void;
  reset: () => void;
}

export function useConfirmButton(): UseConfirmButtonResult {
  const [pending, setPending] = useState<Key | null>(null);
  // 用 ref 持有"当前 pending 按钮的 onTrigger",避免 useCallback 闭包过期
  const triggerRef = useRef<(() => void) | null>(null);
  // 用 ref 同步追踪最新 pending,避免 setState 回调里读 prev 时 React StrictMode 重复执行导致副作用被调两次
  const pendingRef = useRef<Key | null>(null);
  pendingRef.current = pending;

  const request = useCallback((key: Key, opts?: { onTrigger?: () => void }) => {
    if (pendingRef.current === key) {
      // 第二次点同一按钮 → 触发(同步执行,不放在 setState 回调里)
      opts?.onTrigger?.();
      triggerRef.current = null;
      setPending(null);
    } else {
      // 切到新按钮(包含从 null 切到 key),旧 onTrigger 被覆盖
      triggerRef.current = opts?.onTrigger ?? null;
      setPending(key);
    }
  }, []);

  const reset = useCallback(() => {
    triggerRef.current = null;
    setPending(null);
  }, []);

  return { pending, request, reset };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run src/hooks/useConfirmButton.test.ts
```

预期: PASS,5 个测试全过。

- [ ] **Step 5: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/hooks/useConfirmButton.ts src/hooks/useConfirmButton.test.ts && git commit -m "feat(hook): useConfirmButton 双击确认状态机 + 单元测试"
```

---

## Task 2: 抽 ConfirmButton 组件

**Files:**
- Create: `src/components/ConfirmButton.tsx`
- Create: `src/components/ConfirmButton.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/components/ConfirmButton.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton';

describe('ConfirmButton', () => {
  it('默认态:背景透明、1px 描边、原色文字', () => {
    render(<ConfirmButton label="已服用" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: '已服用' });
    expect(btn.style.background).toBe('transparent');
    expect(btn.style.borderColor).not.toBe('transparent');
  });

  it('等待确认态(pending=true):背景主题色、无描边、文字保留原色', () => {
    render(<ConfirmButton label="已服用" onClick={() => {}} pending />);
    const btn = screen.getByRole('button', { name: '已服用' });
    expect(btn.style.background).not.toBe('transparent');
    expect(btn.style.borderColor).toBe('transparent');
  });

  it('点击触发 onClick', () => {
    const onClick = vi.fn();
    render(<ConfirmButton label="已服用" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '已服用' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('等待态时 aria-label 包含"再点一次确认"', () => {
    render(<ConfirmButton label="已服用" onClick={() => {}} pending />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toContain('再点一次确认');
  });

  it('默认态时 aria-label 就是 label 本身', () => {
    render(<ConfirmButton label="已服用" onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('已服用');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run src/components/ConfirmButton.test.tsx
```

预期: FAIL with "Cannot find module './ConfirmButton'"。

- [ ] **Step 3: 实现组件**

`src/components/ConfirmButton.tsx`:

```tsx
import React from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

interface ConfirmButtonProps {
    /** 按钮默认显示文字(也是默认态的 aria-label) */
    label: string;
    /** 点击触发(等同原 onClick) */
    onClick: () => void;
    /** 是否处于"等待第二次点击"状态 */
    pending?: boolean;
    /** Lucide 图标(可选) */
    icon?: React.ReactNode;
    /** 默认态的额外类名(用于尺寸等) */
    className?: string;
}

/**
 * 双击确认按钮:
 * - 默认:背景透明 + 1px 普通描边 + 原色文字
 * - 等待确认(pending=true):背景主题色 + 无描边 + 文字保留原色
 * - 屏幕阅读器:等待态的 aria-label 会附加",再点一次确认"
 *
 * 状态机由父组件的 useConfirmButton 管理,本组件只负责视觉和事件转发。
 */
export const ConfirmButton: React.FC<ConfirmButtonProps> = ({
    label, onClick, pending = false, icon, className = '',
}) => {
    const { isDark, colors } = useTheme();
    const { t } = useTranslation();
    const pendingSuffix = t('reminder.confirm.aria_pending_suffix', '，再点一次确认');
    const ariaLabel = pending ? `${label}${pendingSuffix}` : label;
    const bg = pending ? colors[500] : 'transparent';
    const borderColor = pending ? 'transparent' : 'var(--border-primary)';
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel}
            className={`inline-flex items-center justify-center gap-2 font-bold rounded-2xl transition btn-press-glass ${className}`}
            style={{
                background: bg,
                color: 'var(--text-primary)',
                border: `1px solid ${borderColor}`,
                padding: '12px 16px',
                fontSize: '14px',
            }}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
};

export default ConfirmButton;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run src/components/ConfirmButton.test.tsx
```

预期: PASS,5 个测试全过。

- [ ] **Step 5: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/components/ConfirmButton.tsx src/components/ConfirmButton.test.tsx && git commit -m "feat(component): ConfirmButton 双击确认按钮 + 单元测试"
```

---

## Task 3: 加翻译键

**Files:**
- Modify: `src/i18n/translations.ts`

- [ ] **Step 1: 在中文 zh 段加键**

在 `translations.ts` 第 35 行附近(`"overview.due.today": "今天"` 之后)插入:

```ts
"reminder.confirm.aria_pending_suffix": "，再点一次确认",
```

- [ ] **Step 2: 在英文 en 段加键**

在 `translations.ts` 第 931 行附近(`"overview.due.today": "Today"` 之后)插入:

```ts
"reminder.confirm.aria_pending_suffix": ", tap again to confirm",
```

- [ ] **Step 3: 在繁中 zh-TW 段加键**

在 `translations.ts` 第 2294 行附近(`"overview.due.day_after": "後天"` 之后)插入:

```ts
"reminder.confirm.aria_pending_suffix": "，再點一次確認",
```

- [ ] **Step 4: 在日文 ja 段加键**

在 `translations.ts` 第 2758 行附近(`"overview.due.day_after": "明後日"` 之后)插入:

```ts
"reminder.confirm.aria_pending_suffix": "、もう一度タップで確認",
```

- [ ] **Step 5: 跑类型检查**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/i18n" | head -10 || echo "NO_ERRORS"
```

预期: NO_ERRORS。

- [ ] **Step 6: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/i18n/translations.ts && git commit -m "feat(i18n): reminder.confirm.aria_pending_suffix 4 语言"
```

---

## Task 4: 改造 ReminderModal on_time 态

**Files:**
- Modify: `src/components/ReminderModal.tsx`

- [ ] **Step 1: 引入 ConfirmButton 和 useConfirmButton**

在 `ReminderModal.tsx` 第 1 行附近,把现有的:

```tsx
import React, { useEffect } from 'react';
```

替换为:

```tsx
import React, { useEffect } from 'react';
import { ConfirmButton } from './ConfirmButton';
import { useConfirmButton } from '../hooks/useConfirmButton';
```

- [ ] **Step 2: 在组件内引入状态机**

在 `ReminderModal` 组件函数体内(在 `const { t } = useTranslation();` 之后)加入:

```tsx
const { pending, request, reset } = useConfirmButton();
```

- [ ] **Step 3: 当弹窗关闭时清空等待状态**

在现有的 `useEffect` 块(第 61-66 行附近,锁定 body 滚动那个)下面加一个新的 effect:

```tsx
useEffect(() => {
    if (!isOpen) reset();
}, [isOpen, reset]);
```

- [ ] **Step 4: 改造"已服用"按钮**

把第 161-169 行的"已服用"按钮:

```tsx
<button
    type="button"
    onClick={onConfirm}
    className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-white rounded-2xl transition btn-press-glass glass-btn-primary"
    aria-label={t('reminder.banner.confirm_on_time') || '已服用'}
>
    <Check size={18} />
    <span>{t('reminder.banner.confirm_on_time') || '已服用'}</span>
</button>
```

替换为:

```tsx
<ConfirmButton
    label={t('reminder.banner.confirm_on_time') || '已服用'}
    onClick={() => request('confirm', { onTrigger: onConfirm })}
    pending={pending === 'confirm'}
    icon={<Check size={18} />}
    className="w-full px-4 py-3 text-sm"
/>
```

- [ ] **Step 5: 改造"计划推迟 1 天"按钮**

把第 192-205 行的按钮替换为:

```tsx
<ConfirmButton
    label={t('reminder.banner.delay_1d') || '计划推迟 1 天'}
    onClick={() => request('delay1d', { onTrigger: onDelay1d })}
    pending={pending === 'delay1d'}
    icon={<FastForward size={18} />}
    className="w-full px-4 py-3 text-sm"
/>
```

- [ ] **Step 6: 改造"计划推迟 2 天"按钮**

把第 206-219 行的按钮替换为:

```tsx
<ConfirmButton
    label={t('reminder.banner.delay_2d') || '计划推迟 2 天'}
    onClick={() => request('delay2d', { onTrigger: onDelay2d })}
    pending={pending === 'delay2d'}
    icon={<FastForward size={18} />}
    className="w-full px-4 py-3 text-sm"
/>
```

- [ ] **Step 7: 跑类型检查 + 现有测试**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/components/ReminderModal" | head -10 || echo "NO_ERRORS"
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run 2>&1 | tail -5
```

预期: NO_ERRORS;vitest 跑完(已有 572 通过 + 2 个 worktree 失败不算)。

- [ ] **Step 8: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/components/ReminderModal.tsx && git commit -m "feat(reminder-modal): on_time 3 按钮改用 ConfirmButton"
```

---

## Task 5: 改造 ReminderModal late 态的"跳过本次"按钮(含警告展开)

**Files:**
- Modify: `src/components/ReminderModal.tsx`

- [ ] **Step 1: 改造"跳过本次"按钮本体(展开警告)**

把第 170-185 行的"跳过本次"按钮:

```tsx
{isLate && onSkip && (
    <button
        type="button"
        onClick={onSkip}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold rounded-2xl transition btn-press-glass"
        style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
        }}
        aria-label={t('reminder.banner.skip') || '跳过本次'}
    >
        <SkipForward size={18} />
        <span>{t('reminder.banner.skip') || '跳过本次'}</span>
    </button>
)}
```

替换为:

```tsx
{isLate && onSkip && (
    <ConfirmButton
        label={t('reminder.banner.skip') || '跳过本次'}
        onClick={() => request('skip', { onTrigger: onSkip })}
        pending={pending === 'skip'}
        icon={<SkipForward size={18} />}
        className="w-full px-4 py-3 text-sm"
    />
)}
```

- [ ] **Step 2: 在"跳过本次"按钮下方加警告展开区**

在 step 1 替换后的 `<ConfirmButton ... />` 后面(同一 `{isLate && onSkip && (...)}` 块的尾部)增加警告文本展开:

```tsx
{isLate && onSkip && pending === 'skip' && (
    <div
        className="text-sm leading-relaxed px-2 py-2 rounded-xl"
        style={{
            background: 'rgba(244, 63, 94, 0.06)',
            color: 'var(--text-soft-rose)',
            animation: 'skipWarnIn 200ms ease-out',
        }}
        role="note"
    >
        {t('reminder.banner.skip_confirm.body') || '将跳过今日原有计划,原计划不会顺延。强烈影响身体激素状态,您确定吗?'}
        <style>{`
            @keyframes skipWarnIn {
                from { opacity: 0; transform: translateY(-6px); }
                to   { opacity: 1; transform: translateY(0); }
            }
        `}</style>
    </div>
)}
```

- [ ] **Step 3: 跑类型检查 + 现有测试**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/components/ReminderModal" | head -10 || echo "NO_ERRORS"
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run 2>&1 | tail -5
```

预期: NO_ERRORS,无新增失败。

- [ ] **Step 4: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/components/ReminderModal.tsx && git commit -m "feat(reminder-modal): late 跳过本次按钮内联展开警告"
```

---

## Task 6: 改造 ReminderBanner

**Files:**
- Modify: `src/components/ReminderBanner.tsx`

- [ ] **Step 1: 引入 ConfirmButton 和 useConfirmButton**

在 `ReminderBanner.tsx` 第 1 行附近,把现有的:

```tsx
import React from 'react';
```

替换为:

```tsx
import React from 'react';
import { ConfirmButton } from './ConfirmButton';
import { useConfirmButton } from '../hooks/useConfirmButton';
```

- [ ] **Step 2: 在组件内引入状态机 + key 触发重置**

`ReminderBanner` 已经从父组件接收 `pending`/`matchedPlan`/`onConfirm` 等 prop。要让外部通过 `key` 强制重置(用于翻页场景),用 `useConfirmButton` 内部 state 即可,父组件传 `key={...}` 时 React 会重建整个组件、state 自然清空。

在组件函数体内(在 `const { t } = useTranslation();` 之后)加入:

```tsx
const { pending, request, reset } = useConfirmButton();
```

- [ ] **Step 3: 改造"已服用"按钮**

把第 134-141 行的按钮替换为:

```tsx
<ConfirmButton
    label={t('reminder.banner.confirm_on_time') || '已服用'}
    onClick={() => request('confirm', { onTrigger: () => onConfirm(when) })}
    pending={pending === 'confirm'}
    icon={<Check size={14} />}
    className="px-3 py-2 h-10 text-xs"
/>
```

- [ ] **Step 4: 改造"跳过本次"按钮(保留 showDialog 弹窗)**

把第 143-159 行的按钮:

```tsx
{onSkip && (
    <button
        onClick={onSkip}
        className="inline-flex items-center gap-1.5 px-3 py-2 h-10 rounded-xl text-xs font-bold btn-press-glass"
        style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-soft-rose)',
        }}
        aria-label={t('reminder.banner.skip') || '跳过本次'}
    >
        <SkipForward size={14} />
        <span>{t('reminder.banner.skip') || '跳过本次'}</span>
    </button>
)}
```

替换为:

```tsx
{onSkip && (
    <ConfirmButton
        label={t('reminder.banner.skip') || '跳过本次'}
        onClick={onSkip}
        icon={<SkipForward size={14} />}
        className="px-3 py-2 h-10 text-xs"
    />
)}
```

注意:`onSkip` 直接接 `ConfirmButton` 的 `onClick`,不接 `request()`——因为这个按钮走 showDialog 弹窗(`onSkip` 本身已经包了 showDialog 调用),不需要双击确认。`pending` prop 不传,默认 false。

- [ ] **Step 5: 改造"计划推迟 1 天"按钮**

把第 161-175 行的按钮替换为:

```tsx
{onDelay1d && (
    <ConfirmButton
        label={t('reminder.banner.delay_1d') || '计划推迟 1 天'}
        onClick={() => request('delay1d', { onTrigger: () => onDelay1d(matchedPlan.id) })}
        pending={pending === 'delay1d'}
        icon={<FastForward size={14} />}
        className="px-3 py-2 h-10 text-xs"
    />
)}
```

- [ ] **Step 6: 改造"计划推迟 2 天"按钮**

把第 177-191 行的按钮替换为:

```tsx
{onDelay2d && (
    <ConfirmButton
        label={t('reminder.banner.delay_2d') || '计划推迟 2 天'}
        onClick={() => request('delay2d', { onTrigger: () => onDelay2d(matchedPlan.id) })}
        pending={pending === 'delay2d'}
        icon={<FastForward size={14} />}
        className="px-3 py-2 h-10 text-xs"
    />
)}
```

- [ ] **Step 7: 跑类型检查 + 现有测试**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/components/ReminderBanner" | head -10 || echo "NO_ERRORS"
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run 2>&1 | tail -5
```

预期: NO_ERRORS,无新增失败。

- [ ] **Step 8: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/components/ReminderBanner.tsx && git commit -m "feat(reminder-banner): 4 按钮改用 ConfirmButton,跳过本次保留 showDialog"
```

---

## Task 7: 翻页重置 banner 状态

**Files:**
- Modify: `src/components/MainLayout.tsx`

- [ ] **Step 1: 找到 ReminderBanner 渲染处**

`MainLayout.tsx` 第 833 行附近有 `onSkipBanner: handleSkipPending` 这块,上面是 `<ReminderBanner ... />` 渲染。给它加一个 `key` prop,key 是当前路由。

(具体读 `MainLayout.tsx` 找到 `<ReminderBanner` JSX 标签,通常形如:

```tsx
<ReminderBanner ... />
```

)

- [ ] **Step 2: 加 `key={currentView}` 让路由变化时重置**

把 `<ReminderBanner` 标签改为:

```tsx
<ReminderBanner
    key={currentView}
    ...
/>
```

`currentView` 是 MainLayout 已经有的当前路由状态变量(从 `useState` 或 props 来的),用包成 key 后 React 在路由切换时会卸载并重新挂载 `<ReminderBanner>`,内部的 `useConfirmButton` state 自然清空,达到"翻页重置"。

- [ ] **Step 3: 跑类型检查**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/components/MainLayout" | head -10 || echo "NO_ERRORS"
```

预期: NO_ERRORS。

- [ ] **Step 4: Commit**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git add src/components/MainLayout.tsx && git commit -m "feat(layout): ReminderBanner 加 key 让翻页重置等待确认状态"
```

---

## Task 8: 全量验证

**Files:** 无

- [ ] **Step 1: 跑类型检查**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx tsc --noEmit 2>&1 | grep -E "^src/" | grep -v "src-tauri" | head -20 || echo "NO_SRC_ERRORS"
```

预期: NO_SRC_ERRORS。

- [ ] **Step 2: 跑全部测试**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && npx vitest run 2>&1 | tail -10
```

预期: 之前通过的 572 个测试 + 新加的 10 个测试(useConfirmButton 5 + ConfirmButton 5)都通过。2 个 `.worktrees/chart-gesture/` 下的失败是既有的,不算。

- [ ] **Step 3: vite 启动确认无运行时报错**

浏览器打开 `http://localhost:3000/`,导航到 /history 页,点 banner 上"已服用"按钮两次(间隔内颜色变化),再点"推迟 1 天"——确认 banner 内部状态切换正确;切到 /plans 再切回 /history,banner 状态应已重置。

打开通知 deep-link 触发该用药弹窗,点 4 个按钮,确认"已服用 / 推迟 1d / 推迟 2d" 都要点两次才生效,"跳过本次"(late 态)点一次后下方出现警告,点第二次才生效,点其他按钮时警告收起。

- [ ] **Step 4: 检查 4 主题下视觉**

切到 light / dark / 自定义主题,各截一张图确认:
- 默认态:透明背景 + 普通描边 + 原色文字
- 等待确认态:主题色背景 + 无描边 + 原色文字
- 警告文本(仅 late 弹窗):淡玫红底 + 玫红字

视觉无问题 → 跳过本步;有问题 → 单独 commit 视觉调整。

- [ ] **Step 5: 如有视觉调整则 commit,否则无**

```bash
cd /d/database/GitHub/Transmtf-HRT-Tracker && git status --short
```

如果有未提交的改动:

```bash
git add -A
git commit -m "fix(reminder): 视觉调整来自手工验证"
```

否则跳过本步。

---

## 总结

8 个 task,14 个 commit,1 个新组件(ConfirmButton)+ 1 个新 hook(useConfirmButton)+ 4 个修改文件。核心改动是把"点一下生效"改成"点两下生效",0 弹窗、0 状态切换,所有等待确认的视觉变化在按钮原地完成。

预计总工时:1-2 小时(熟练开发者)。
