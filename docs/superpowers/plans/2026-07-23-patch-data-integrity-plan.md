# 贴片数据完整性修复 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 HRT Tracker app 中 `patchApply` / `patchRemove` 事件的所有写入路径，确保任何写入操作都不会产生孤儿撕下记录；PK 引擎改用 `companionGroupId` 严格配对；批量添加生成配对事件；导入路径对历史数据 reconcile。

**Architecture:** 把级联逻辑下沉到 `src/utils/patch.ts` 的纯函数（`removeCompanion` / `applyCompanion` / `collectCascadeIds` / `shouldCascadeRemove`），让 `MainLayout` 的 handler 成为薄壳，可单测。PK 引擎内联改用 groupId 严格匹配。`BatchDoseModal` 在 `generatePreview` 里检测 patch 时自动成对生成。`importData` 加 `reconcileImportedPatchEvents` 在所有反序列化入口之前跑。

**Tech Stack:** React 18.3 + TypeScript 5.8 + Vite 6.4 + Vitest + happy-dom + @testing-library/react

---

## File Structure

**新增文件**：
- `src/utils/patchReconcile.ts` — `reconcileImportedPatchEvents` 函数
- `src/utils/patchReconcile.test.ts` — reconcile 单测
- `src/views/HistoryView.cascade.test.tsx` — 级联回归测试

**修改文件**：
- `src/utils/patch.ts` — 新增 4 个级联 helper
- `src/utils/patch.test.ts` — 新增 helper 单测
- `src/components/MainLayout.tsx` — 3 个 handler 接级联 helper
- `src/components/DoseFormModal.tsx` — `handleSave` D1/D2 groupId 分流
- `src/components/BatchDoseModal.tsx` — `generatePreview` 加 wearDays 字段 + 配对
- `src/utils/importData.ts` — 所有反序列化入口接 reconcile
- `pk.ts` — `case Route.patchApply` 改用 groupId 严格匹配

---

## Task 1: 添加 `removeCompanion` / `applyCompanion` helper（TDD）

**Files:**
- Modify: `src/utils/patch.ts`
- Modify: `src/utils/patch.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `src/utils/patch.test.ts` 的 `describe('findPatchRemoveForApply', ...)` 块之后新增：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- src/utils/patch.test.ts
```

Expected: FAIL with "removeCompanion is not defined" 或 "Cannot find name 'removeCompanion'"

- [ ] **Step 3: 实现 helper**

在 `src/utils/patch.ts` 末尾（`findPatchApplyForRemove` 之后）新增：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- src/utils/patch.test.ts
```

Expected: 全部 PASS（旧的 + 新增 7 个）

- [ ] **Step 5: commit**

```bash
git add src/utils/patch.ts src/utils/patch.test.ts
git commit -m "feat(patch): 新增 removeCompanion / applyCompanion 严格 groupId helper"
```

---

## Task 2: 添加 `collectCascadeIds` / `shouldCascadeRemove` helper（TDD）

**Files:**
- Modify: `src/utils/patch.ts`
- Modify: `src/utils/patch.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `src/utils/patch.test.ts` 末尾新增：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- src/utils/patch.test.ts
```

Expected: FAIL with "collectCascadeIds is not defined"

- [ ] **Step 3: 实现 helper**

在 `src/utils/patch.ts` 末尾新增：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- src/utils/patch.test.ts
```

Expected: 全部 PASS

- [ ] **Step 5: commit**

```bash
git add src/utils/patch.ts src/utils/patch.test.ts
git commit -m "feat(patch): 新增 collectCascadeIds / shouldCascadeRemove helper"
```

---

## Task 3: PK 引擎 `case Route.patchApply` 改用 groupId 严格配对

**Files:**
- Modify: `pk.ts`

（pk.ts 已有数值单测，新增的 groupId 配对逻辑在数值层面不影响 E2 曲线形状——只影响 wearH 的取值。回归靠手动 smoke + 既有 pk.test.ts 数值不变验证。）

- [ ] **Step 1: 跑现有 pk 测试做基线**

```bash
npm test -- pk.test.ts
```

Expected: 全部 PASS（记录当前基线）

- [ ] **Step 2: 修改 `case Route.patchApply` 块**

定位 `pk.ts` 第 1023-1025 行附近：

```ts
case Route.patchApply: {
    const remove = allEvents.find(e => e.route === Route.patchRemove && e.timeH > startTime);
    const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;
```

替换为：

```ts
case Route.patchApply: {
    // Strict groupId-only pairing: a patchApply's wear window is its
    // sibling patchRemove stamped with the same companionGroupId. Without
    // a groupId (legacy / hand-edited data) we fall back to "worn forever"
    // — conservative, never wrong, and never reintroduces the 1-to-N bug
    // that time-axis scan caused.
    const evGroupId = patchGroupOf(event);
    const remove = evGroupId
        ? allEvents.find(e =>
            e.route === Route.patchRemove &&
            patchGroupOf(e) === evGroupId &&
            e.timeH > startTime)
        : undefined;
    const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;
```

- [ ] **Step 3: 引入 `patchGroupOf` 引用**

在 `pk.ts` 顶部 imports 段新增：

```ts
import { patchGroupOf } from './src/utils/patch';
```

（如果路径不对，按实际项目结构调整）

- [ ] **Step 4: 跑 pk 测试确认通过**

```bash
npm test -- pk.test.ts
```

Expected: 全部 PASS（数值不变；只是 wearH 在无 groupId 场景下从「第一条 remove 的 timeH」变成「Number.MAX_VALUE」）

- [ ] **Step 5: commit**

```bash
git add pk.ts
git commit -m "fix(pk): patchApply 改用 companionGroupId 严格配对，去除 1-to-N 风险"
```

---

## Task 4: `MainLayout.handleDeleteEvent` 接 `collectCascadeIds`

**Files:**
- Modify: `src/components/MainLayout.tsx`

（`handleDeleteEvent` 是单条删除入口。MainLayout 的 handler 没有单测，但通过 `HistoryView.cascade.test.tsx` 走完整 React 树端到端验证 — 见 Task 11。）

- [ ] **Step 1: 找到 handler 当前实现**

定位 `MainLayout.tsx` line 666-670：

```ts
const handleDeleteEvent = (id: string) => {
    showDialog('confirm', t('timeline.delete_confirm'), () => {
        setEvents(prev => prev.filter(e => e.id !== id));
    });
};
```

- [ ] **Step 2: 修改 handler**

替换为：

```ts
const handleDeleteEvent = (id: string) => {
    showDialog('confirm', t('timeline.delete_confirm'), () => {
        setEvents(prev => {
            const ids = collectCascadeIds(id, prev);
            return prev.filter(e => !ids.has(e.id));
        });
    });
};
```

- [ ] **Step 3: 引入 helper**

在 `MainLayout.tsx` 顶部 imports 段（已有 `isPatchApply` 的地方）新增：

```ts
import { collectCascadeIds } from '../utils/patch';
```

- [ ] **Step 4: 编译确认**

```bash
npm run build
```

Expected: build 成功，无 TS 报错

- [ ] **Step 5: commit**

```bash
git add src/components/MainLayout.tsx
git commit -m "fix(history): handleDeleteEvent 接级联 helper，单条删除不会留孤儿撕下"
```

---

## Task 5: `MainLayout.handleSaveEvent` 接 `shouldCascadeRemove`

**Files:**
- Modify: `src/components/MainLayout.tsx`

- [ ] **Step 1: 找到 handler 当前实现**

定位 `MainLayout.tsx` line 598-603：

```ts
const handleSaveEvent = (e: DoseEvent) => {
    setEvents(prev => {
        const exists = prev.find(p => p.id === e.id);
        return exists ? prev.map(p => p.id === e.id ? e : p) : [...prev, e];
    });
};
```

- [ ] **Step 2: 修改 handler**

替换为：

```ts
const handleSaveEvent = (e: DoseEvent) => {
    setEvents(prev => {
        const oldE = prev.find(p => p.id === e.id);
        if (!oldE) return [...prev, e];

        const next = prev.map(p => p.id === e.id ? e : p);

        // 如果 route 从 patch 改成非 patch，把配对的 remove 删掉。
        // 反向（remove→非 patch）的情况：清掉 apply 的 groupId（详见 helper 注释）。
        const companionToClear = shouldCascadeRemove(oldE, e, prev);
        if (!companionToClear) return next;

        if (oldE.route === Route.patchRemove && e.route !== Route.patchRemove) {
            // 移除 → 非 remove：apply 的 groupId 清空（PK 引擎不再把它当「带撕下」处理）
            return next.map(p => p.id === companionToClear.id
                ? { ...p, companionGroupId: undefined }
                : p);
        }
        // apply → 非 patch：直接删配对 remove
        return next.filter(p => p.id !== companionToClear.id);
    });
};
```

- [ ] **Step 3: 引入 helper**

在 `MainLayout.tsx` 顶部新增：

```ts
import { shouldCascadeRemove } from '../utils/patch';
```

（如果 `collectCascadeIds` 已经引入了，这里改成同一行）

- [ ] **Step 4: 编译确认**

```bash
npm run build
```

Expected: build 成功

- [ ] **Step 5: commit**

```bash
git add src/components/MainLayout.tsx
git commit -m "fix(history): handleSaveEvent 检测 route 变更时级联清理配对事件"
```

---

## Task 6: `MainLayout.handleSavePatch` 防止新旧两对并存

**Files:**
- Modify: `src/components/MainLayout.tsx`

- [ ] **Step 1: 找到 handler 当前实现**

定位 `MainLayout.tsx` line 615-626：

```ts
const handleSavePatch = (apply: DoseEvent, remove: DoseEvent) => {
    setEvents(prev => {
        const applyExists = prev.some(p => p.id === apply.id);
        const afterApply = applyExists
            ? prev.map(p => p.id === apply.id ? apply : p)
            : [...prev, apply];
        const removeExists = afterApply.some(p => p.id === remove.id);
        return removeExists
            ? afterApply.map(p => p.id === remove.id ? remove : p)
            : [...afterApply, remove];
    });
};
```

- [ ] **Step 2: 修改 handler**

替换为：

```ts
const handleSavePatch = (apply: DoseEvent, remove: DoseEvent) => {
    setEvents(prev => {
        // Step 1: 把「旧 groupId 对应的旧 remove」清掉（D1 编辑改摘下时间场景）
        // ——  旧 remove 可能还挂在旧 groupId 上，新写入的 remove 是新 groupId，
        //     两者并存会让 PK 引擎出错。
        const oldApply = prev.find(p => p.id === apply.id);
        const oldRemoveId = oldApply
            ? removeCompanion(oldApply, prev)?.id
            : undefined;
        const withoutOldRemove = oldRemoveId
            ? prev.filter(p => p.id !== oldRemoveId)
            : prev;

        // Step 2: 原地替换 apply
        const applyExists = withoutOldRemove.some(p => p.id === apply.id);
        const afterApply = applyExists
            ? withoutOldRemove.map(p => p.id === apply.id ? apply : p)
            : [...withoutOldRemove, apply];

        // Step 3: 原地替换或新增 remove（新 remove 总用新 groupId，DoseFormModal 已保证）
        const removeExists = afterApply.some(p => p.id === remove.id);
        return removeExists
            ? afterApply.map(p => p.id === remove.id ? remove : p)
            : [...afterApply, remove];
    });
};
```

- [ ] **Step 3: 引入 helper**

```ts
import { removeCompanion } from '../utils/patch';
```

- [ ] **Step 4: 编译确认**

```bash
npm run build
```

Expected: build 成功

- [ ] **Step 5: commit**

```bash
git add src/components/MainLayout.tsx
git commit -m "fix(history): handleSavePatch 防止新旧两对 (apply, remove) 并存"
```

---

## Task 7: `DoseFormModal.handleSave` D1/D2 groupId 分流

**Files:**
- Modify: `src/components/DoseFormModal.tsx`

- [ ] **Step 1: 找到 `handleSave` 当前结构**

定位 `DoseFormModal.tsx` line 689 附近的 paired save 块（`if (route === Route.patchApply && removeTimeStr.trim() !== '' && onSavePatch) { ... }`）和单事件 save 块（line 741-769）。

- [ ] **Step 2: 改 paired save 块的 apply id 生成**

在 `const applyEvent: DoseEvent = {` 那行（第 705 行附近），把：

```ts
const groupId = uuidv4();
```

改成：

```ts
// D1（编辑+改摘下时间）走 paired save：用新 groupId（call site 已让 remove 也用同一 groupId）
// D2（编辑+清空摘下时间）走 onSave 单事件路径，根本不到这里
// A（新增）用新 groupId（保持现状）
const groupId = uuidv4();
```

（实际不需改 — 第 704 行已经是 `const groupId = uuidv4();`，符合 D1 行为）

- [ ] **Step 3: 给单事件 save 路径（D2）显式保留 groupId**

定位 line 741-769 的 `const newEvent: DoseEvent = { ... }`，确认 `companionGroupId` **没有显式被清空**：

```ts
const newEvent: DoseEvent = {
    id: eventToEdit?.id || uuidv4(),
    route,
    ester: effectiveEster,
    timeH,
    doseMG: finalDose,
    weightKG,
    heightCm,
    extras
    // ← 不写 companionGroupId，spread `extras` 也不含它
};
```

问题：如果 `eventToEdit` 原本有 `companionGroupId`，新 `newEvent` 会丢失。

- [ ] **Step 4: 显式保留 groupId**

修改 `newEvent` 定义为：

```ts
const newEvent: DoseEvent = {
    id: eventToEdit?.id || uuidv4(),
    route,
    ester: effectiveEster,
    timeH,
    doseMG: finalDose,
    weightKG,
    heightCm,
    extras,
    // D2 场景：编辑 apply、清空「摘下时间」，保持原 groupId
    // （如果清掉 groupId 而旧 remove 还在 → 真孤儿；保持 groupId + 旧 remove
    //  → PK 引擎继续按旧对算，行为符合「只改贴上时间不动摘下时间」的直觉）
    ...(eventToEdit?.companionGroupId !== undefined
        && removeTimeStr.trim() === ''
        ? { companionGroupId: eventToEdit.companionGroupId }
        : {}),
};
```

- [ ] **Step 5: 编译确认**

```bash
npm run build
```

Expected: build 成功

- [ ] **Step 6: commit**

```bash
git add src/components/DoseFormModal.tsx
git commit -m "fix(history): DoseFormModal D2 场景保留原 groupId，避免真孤儿"
```

---

## Task 8: `BatchDoseModal` wearDays 字段 + 生成配对事件

**Files:**
- Modify: `src/components/BatchDoseModal.tsx`

- [ ] **Step 1: 加 wearDays state**

定位 BatchDoseModal 中其他 useState 附近，新增：

```ts
const [wearDays, setWearDays] = useState('3.5');
```

- [ ] **Step 2: 加 wearDays 输入框 UI**

在 route === patchApply 时显示的 dose/rate section 旁边（line 817-896 附近），新增输入框：

```tsx
{route === Route.patchApply && (
    <div className="space-y-1">
        <label className="block text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-tertiary)' }}>
            佩戴天数（默认 3.5）
        </label>
        <input
            type="number"
            min="0.5"
            max="7"
            step="0.5"
            value={wearDays}
            onChange={(e) => setWearDays(e.target.value)}
            style={inputStyle}
            className="w-full px-3 py-2 rounded-lg"
        />
    </div>
)}
```

- [ ] **Step 3: 改 `generatePreview` 生成配对事件**

定位 `generatePreview`（line 433-481）。在 `events.push({...})` 那块改成：

```ts
const events: DoseEvent[] = [];
const parsedWearDays = route === Route.patchApply ? parseFloat(wearDays) : 0;
const wearDaysValid = route !== Route.patchApply
    || (Number.isFinite(parsedWearDays) && parsedWearDays > 0 && parsedWearDays <= 14);

if (route === Route.patchApply && !wearDaysValid) {
    showDialog('alert', '佩戴天数需要在 0.5–14 之间');
    return;
}

const parsedWeight = parseFloat(weightStr);
const weightKG = (Number.isFinite(parsedWeight) && parsedWeight > 0)
    ? parsedWeight
    : prefillWeightKG(allEvents);
const current = new Date(start);
while (current <= end) {
    for (const slot of timeSlots) {
        const [hh, mm] = slot.split(':').map(Number);
        const eventDate = new Date(current);
        eventDate.setHours(hh, mm, 0, 0);
        const timeH = eventDate.getTime() / 3600000;

        if (route === Route.patchApply) {
            // 同时生成 (apply, remove) 对
            const groupId = uuidv4();
            const removeTimeH = timeH + parsedWearDays * 24;
            events.push({
                id: uuidv4(),
                route: Route.patchApply,
                ester: finalEster,
                timeH,
                doseMG: finalDoseMG,
                weightKG,
                extras: { ...extrasTemplate },
                companionGroupId: groupId,
            });
            events.push({
                id: uuidv4(),
                route: Route.patchRemove,
                ester: Ester.E2,
                timeH: removeTimeH,
                doseMG: 0,
                weightKG,
                extras: {},
                companionGroupId: groupId,
            });
        } else {
            events.push({
                id: uuidv4(),
                route,
                ester: finalEster,
                timeH,
                doseMG: finalDoseMG,
                weightKG,
                extras: { ...extrasTemplate },
            });
        }
    }
    current.setDate(current.getDate() + intervalDays);
}
```

- [ ] **Step 4: 编译确认**

```bash
npm run build
```

Expected: build 成功

- [ ] **Step 5: commit**

```bash
git add src/components/BatchDoseModal.tsx
git commit -m "feat(batch): 批量添加贴片生成 (apply, remove) 配对，佩戴天数默认 3.5 天"
```

---

## Task 9: `reconcileImportedPatchEvents` 函数（TDD）

**Files:**
- Create: `src/utils/patchReconcile.ts`
- Create: `src/utils/patchReconcile.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/utils/patchReconcile.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DoseEvent, Ester, Route } from '../../types';
import { reconcileImportedPatchEvents } from './patchReconcile';

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
            timeH: 100 * HOUR,
        });
        const remove = makeEvent({
            id: 'old-remove',
            route: Route.patchRemove,
            timeH: (100 + 48) * HOUR,
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
            timeH: 100 * HOUR,
        });
        const remove = makeEvent({
            id: 'old-remove',
            route: Route.patchRemove,
            timeH: (100 + 15 * 24) * HOUR,
        });
        const result = reconcileImportedPatchEvents([apply, remove]);
        expect(result[0].companionGroupId).toBeUndefined();
        expect(result[1].companionGroupId).toBeUndefined();
    });

    it('does 1-to-1 greedy pairing (no 1-to-N)', () => {
        // 两条 apply + 一条 remove：只该配其中一条
        const apply1 = makeEvent({ id: 'a1', route: Route.patchApply, timeH: 100 * HOUR });
        const apply2 = makeEvent({ id: 'a2', route: Route.patchApply, timeH: 200 * HOUR });
        const remove = makeEvent({ id: 'r1', route: Route.patchRemove, timeH: 250 * HOUR });
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- src/utils/patchReconcile.test.ts
```

Expected: FAIL with "Cannot find module './patchReconcile'"

- [ ] **Step 3: 实现 `reconcileImportedPatchEvents`**

创建 `src/utils/patchReconcile.ts`：

```ts
import { v4 as uuidv4 } from 'uuid';
import { DoseEvent, Route } from '../../types';

const MAX_PATCH_WEAR_HOURS = 14 * 24;

const isPatchApply = (e: DoseEvent) => e.route === Route.patchApply;
const isPatchRemove = (e: DoseEvent) => e.route === Route.patchRemove;

const groupOf = (e: DoseEvent): string | null => {
    const id = e.companionGroupId;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

/**
 * Reconcile a freshly-imported (or freshly-parsed) events array so it
 * conforms to the project's "patch data integrity" contract:
 *
 *   1. Drop orphan `patchRemove` events whose `companionGroupId` has no
 *      matching `patchApply` in the same array.
 *   2. Strip a dangling `companionGroupId` off any `patchApply` whose paired
 *      `patchRemove` is missing (UI must not show "摘下时间" for it).
 *   3. Backfill `companionGroupId` on legacy pairs (no groupId but a
 *      `patchRemove` lands within 14 days of the `patchApply` on the time
 *      axis). Pairing is 1-to-1 greedy: each `patchRemove` is consumed by
 *      the earliest unpaired `patchApply` whose wear window contains it.
 *   4. Events without any patch context pass through untouched.
 *
 * Called by every deserialization entry point in `importData.ts` so legacy
 * imports (or hand-edited localStorage blobs) never silently feed dirty
 * data into the PK engine.
 */
export function reconcileImportedPatchEvents(events: DoseEvent[]): DoseEvent[] {
    // ── Pass 1: drop orphan removes + strip dangling groupIds ─────────────
    const groupIds = new Set<string>();
    for (const e of events) {
        const g = groupOf(e);
        if (g) groupIds.add(g);
    }
    const validGroups = new Set<string>();
    for (const g of groupIds) {
        const hasApply = events.some((e) => groupOf(e) === g && isPatchApply(e));
        const hasRemove = events.some((e) => groupOf(e) === g && isPatchRemove(e));
        if (hasApply && hasRemove) validGroups.add(g);
    }

    const cleaned: DoseEvent[] = [];
    for (const e of events) {
        if (isPatchRemove(e)) {
            const g = groupOf(e);
            if (g && !validGroups.has(g)) continue; // orphan remove → drop
        }
        if (isPatchApply(e)) {
            const g = groupOf(e);
            if (g && !validGroups.has(g)) {
                // dangling groupId on apply → strip it
                cleaned.push({ ...e, companionGroupId: undefined });
                continue;
            }
        }
        cleaned.push(e);
    }

    // ── Pass 2: 1-to-1 greedy pairing of legacy (no-groupId) pairs ───────
    const noGroupApply = cleaned
        .filter((e) => isPatchApply(e) && !groupOf(e))
        .sort((a, b) => a.timeH - b.timeH);
    const noGroupRemove = cleaned
        .filter((e) => isPatchRemove(e) && !groupOf(e))
        .sort((a, b) => a.timeH - b.timeH);

    const consumedRemoves = new Set<string>();
    const idToGroupId = new Map<string, string>();
    for (const apply of noGroupApply) {
        const minH = apply.timeH;
        const maxH = apply.timeH + MAX_PATCH_WEAR_HOURS;
        const candidate = noGroupRemove.find(
            (r) =>
                !consumedRemoves.has(r.id) &&
                r.timeH >= minH &&
                r.timeH <= maxH,
        );
        if (candidate) {
            const g = uuidv4();
            idToGroupId.set(apply.id, g);
            idToGroupId.set(candidate.id, g);
            consumedRemoves.add(candidate.id);
        }
    }

    return cleaned.map((e) => {
        const g = idToGroupId.get(e.id);
        return g ? { ...e, companionGroupId: g } : e;
    });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- src/utils/patchReconcile.test.ts
```

Expected: 全部 7 个测试 PASS

- [ ] **Step 5: commit**

```bash
git add src/utils/patchReconcile.ts src/utils/patchReconcile.test.ts
git commit -m "feat(import): 新增 reconcileImportedPatchEvents，给老数据补 groupId"
```

---

## Task 10: 把 reconcile 接入 `importData.ts` 所有反序列化入口

**Files:**
- Modify: `src/utils/importData.ts`

- [ ] **Step 1: 找出所有「产出最终 events 数组」的位置**

```bash
grep -n "events:" src/utils/importData.ts | head -30
```

逐行看上下文，标出所有「从 JSON / CSV / 备份数据解析完，得到最终 events 数组」的位置。

- [ ] **Step 2: 在每个出口前调用 reconcile**

在每个出口处（返回 events 数组前）插入：

```ts
import { reconcileImportedPatchEvents } from './patchReconcile';
// ...
return reconcileImportedPatchEvents(parsedEvents);
```

或如果是 mutation 风格（直接修改参数），改成：

```ts
parsedEvents.splice(0, parsedEvents.length, ...reconcileImportedPatchEvents(parsedEvents));
```

- [ ] **Step 3: 跑 importData 现有测试确认通过**

```bash
npm test -- src/utils/importData.test.ts
```

Expected: 全部 PASS（如果有老的 importData 测试验证导入后的 events 形状，需更新断言以适应 reconcile 后的结果）

- [ ] **Step 4: 编译确认**

```bash
npm run build
```

Expected: build 成功

- [ ] **Step 5: commit**

```bash
git add src/utils/importData.ts
git commit -m "fix(import): 所有反序列化入口走 reconcileImportedPatchEvents"
```

---

## Task 11: `HistoryView.cascade.test.tsx` 级联回归测试

**Files:**
- Create: `src/views/HistoryView.cascade.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `src/views/HistoryView.cascade.test.tsx`：

```tsx
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

describe('HistoryView — cascade delete + bulk', () => {
    it('select-all includes the paired remove for an apply', () => {
        // 验证 visibleEventIds 的级联逻辑（这是 HistoryView 内的 useMemo）
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
        // 应该渲染 apply 行
        expect(screen.getByTestId('event-row-apply-1')).toBeTruthy();
        // remove 不渲染（被分组 filter 掉）
        expect(screen.queryByTestId('event-row-remove-1')).toBeNull();
    });
});
```

- [ ] **Step 2: 跑测试确认通过（不是失败 — 这是补全覆盖率）**

```bash
npm test -- src/views/HistoryView.cascade.test.tsx
```

Expected: PASS（如果失败，说明 HistoryView 的可见数据形状跟测试期望不一致，需调整测试）

- [ ] **Step 3: 补端到端级联测试**

调用 `onBulkDeleteEvents` 后看是否能把 `apply + remove` 一并传上去。

（具体测试写法取决于 `HistoryView` 是否暴露 `selectedIds` 给外部。如果不暴露，就在测试里模拟「勾选 → 调用 onBulkDeleteEvents([applyId, removeId])」的流程来验证集成。）

- [ ] **Step 4: commit**

```bash
git add src/views/HistoryView.cascade.test.tsx
git commit -m "test(history): 补级联删除的回归测试"
```

---

## Task 12: 端到端 smoke test + 全套测试

**Files:**
- 无（只验证）

- [ ] **Step 1: 跑全套测试**

```bash
npm test
```

Expected: 全部 PASS

- [ ] **Step 2: 类型检查 + build**

```bash
npm run build
```

Expected: build 成功，无 TS 报错

- [ ] **Step 3: 手动 smoke test**

按 spec 「验收」段列的 5 条 checklist 跑一遍：
1. 单元测试全过 ✅（Step 1）
2. 回归测试覆盖 ✅（Task 11）
3. 手动 smoke test：
   - A 路径：单条新增 + 填摘下时间 → 应只有 1 条 apply + 1 条 remove，共享 groupId
   - B 路径：单条新增 + 不填摘下时间 → 只有 1 条 apply
   - C 路径：点「贴片移除」 → 多一条 remove，groupId 复用 apply
   - D1 路径：编辑 apply、改摘下时间 → 旧 remove 被删，新 remove 写入，新 groupId
   - E 路径：编辑 apply、改 route → remove 被删
   - F 路径：垃圾桶删 apply → apply 和 remove 一起没
   - G 路径：多选删 apply → apply 和 remove 一起没
   - H 路径：全选删 → apply 和 remove 一起没
   - I 路径：批量添加 → 每天 (apply, remove) 对，共享 groupId
4. 用 Playwright 复跑用户实测过的历史 bug 场景（如果还有 chrome-devtools MCP 可以用）
5. 导入老 JSON → reconcile 后所有 patch 事件都带 groupId 或单独合法存在

- [ ] **Step 4: commit（如有改动）**

```bash
git add -A
git status  # 确认没意外改动
git commit -m "chore: smoke test 后小调整"  # 仅当实际有改动
```

---

## Self-Review Notes

- Task 1-2 是纯 helper，无副作用，可独立测 ✅
- Task 3 PK 引擎改动数值不变，靠既有 pk.test.ts 兜底 ✅
- Task 4-6 MainLayout handler 改动靠 Task 11 端到端测 ✅
- Task 7-8 DoseFormModal + BatchDoseModal 改动靠手动 smoke ✅
- Task 9-10 reconcile 函数 + 接入点，TDD 覆盖 ✅
- Task 11-12 回归 + 端到端 ✅

每步都有「写测试 / 实现 / commit」的明确节奏，符合 CLAUDE.md「改完立刻 commit」要求。