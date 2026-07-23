# 设计文档：贴片数据完整性 + 批量添加漏洞修复

**日期**：2026-07-23
**范围**：让 `patchApply` / `patchRemove` 两条事件在任何写入路径上都严格成对；所有新写入的贴片记录都带 `companionGroupId`；PK 引擎改用 groupId 严格配对；导入路径对历史数据 reconcile；批量添加生成配对事件。

---

## 目标

解决以下现状问题：
1. **孤儿撕下记录**（apply 被删或改 route 后，remove 残留 → 污染 PK 引擎）
2. **批量添加不配对**（BatchDoseModal 只生成 apply，没有 remove、没有 groupId）
3. **PK 引擎配对错乱**（只看时间轴，不看 groupId，可能把别的 remove 算进来）
4. **导入老数据没有 reconcile**（导入后老数据没 groupId，落入 PK 引擎兜底分支）

修完后：**所有合法贴片数据严格 1-to-1 成对**。

---

## 用户故事

作为 HRT 用药记录者，我想要：
1. **删除一条贴片记录**，它对应的「撕下时间」也一起没了（不论是垃圾桶按钮、多选、全选、还是区间删除）
2. **编辑一条贴片记录、把「贴上」改成「肌肉注射」**，原来记录的撕下时间也消失了（不会变成诡异的孤儿数据）
3. **编辑一条贴片记录、改「摘下时间」**，原来的撕下时间消失，新的撕下时间生效
4. **批量添加贴片**时一次性录完一个疗程（默认每片戴 3.5 天），不用事后一个个补撕下时间
5. **从老版本备份恢复**时 app 自动把旧数据「升级」到新版本格式（自动补 groupId），老的撕下时间不会变成别人的

---

## 设计原则

- **`companionGroupId` 是配对的唯一真理**：所有「精确成对」操作只信它。
- **时间轴兜底只用于 UI 渲染**（显示「摘下时间」小字 / 决定是否显示一键移除按钮），PK 引擎不依赖它。
- **不增加孤儿清理 sweep**：当前用户都是新用户，导入路径做一次 reconcile 就够了。
- **写操作严格对称**：删 apply 必须带 remove（如果有 groupId 的话）；改 route 必须清 groupId 相关的 remove。
- **批量添加写入路径必须有 groupId**：否则后续任何 fix 都白搭。

---

## 架构

### 数据层（`src/utils/patch.ts`）

**保持现有导出**（向后兼容 `patch.test.ts`）：
- `isPatchApply`, `isPatchRemove`, `patchGroupOf`
- `findPatchRemoveForApply`, `findPatchApplyForRemove`（**保持现有两阶段：groupId 优先 → 14 天兜底**，仅用于 UI 渲染）

**新增导出**：
- `removeCompanion(apply: DoseEvent, allEvents: DoseEvent[]): DoseEvent | null`
  - 仅按 `companionGroupId` 精确匹配，返回同 groupId 的 remove；找不到返回 `null`。
  - 不带时间轴兜底，专供「级联删除 / 级联修改」使用。
- `applyCompanion(remove: DoseEvent, allEvents: DoseEvent[]): DoseEvent | null`
  - 同上，方向反过来。

### 写入层（`src/components/MainLayout.tsx`）

**修改 `handleDeleteEvent`**（路径 F 单条删除）：
- 若删除的事件是 `patchApply`，先调 `removeCompanion`，把配对 remove 一并加进 id 集合。
- 若删除的事件是 `patchRemove`，先调 `applyCompanion`，把配对 apply 一并加进 id 集合。
- 然后照原逻辑按 id 集合过滤。
- 这样**任何单条删除都安全**，不论用户是删 apply 还是删 remove。

**修改 `handleSaveEvent`**（路径 E 编辑 apply 改 route）：
- 比较 `prev` 中对应 id 的旧事件 `oldE` 和新事件 `newE`：
  - 如果 `oldE.route === Route.patchApply` **且** `newE.route !== Route.patchApply`（route 被改成非贴片）→ 用 `removeCompanion` 找配对 remove，从 `prev` 里一并删掉。
  - 其他场景不动。

**修改 `handleSavePatch`**（路径 A / D1 / D2 编辑 apply 改摘下时间）：
- 现状已经够好（apply 原地替换 + remove 替换或新增），但要补一个保险：传入的 remove 要带 groupId（call site 已经在做）。
- **新增**：在替换前，如果 `prev` 中存在「同 apply id 但不同 groupId 的 remove」或「同 apply 的旧 groupId 对应的 remove」，先把它从 `prev` 里移除（避免新旧两对并存）。

**`handleSaveBatch` 不变**（批量生成的事会在 BatchDoseModal 里改，不在这里）。

**`handleRemovePatch` 不变**（一键撕下已经带 groupId 复用，现状正确）。

**`handleBulkDeleteEvents` 不变**（`HistoryView.visibleEventIds` 已经在做 groupId 级联补全）。`handleBulkDeleteEvents` 内部对 `idSet` 用 `new Set(...)` 已天然去重，无需额外保险。

### UI 层（`src/components/DoseFormModal.tsx`）

**修改 `handleSave`**（路径 A / D1 / D2 编辑路径）：
- 编辑 apply 的 `eventToEdit` 进来时，按其当前 groupId 找出旧 remove id（用 `removeCompanion`），记录到本地变量 `prevRemoveId` / `prevRemoveGroupId`。
- 保存时按 `removeTimeStr.trim()` 是否为空分流：
  - **非空**（路径 A 新增 / 路径 D1 编辑）：走 `onSavePatch`，apply 用原 id（如有）、新 groupId；remove 用新 id、新 groupId。**额外**：把 `prevRemoveId`（如果存在）从 `onSavePatch` 的 prev 里去掉（由 `handleSavePatch` 处理）。
  - **空**（路径 B 新增 / 路径 D2 编辑）：走 `onSave` 单事件路径。**关键**：apply **保持原 groupId**（D2 场景）；新增（B 场景）原本就没 groupId、保持空。
- 用户没填摘下时间的「新增贴片」和「编辑贴片清空摘下时间」走同一条路径：单事件保存。
- 用户填了摘下时间的「新增」和「编辑」走另一条路径：paired save。

### UI 层（`src/components/BatchDoseModal.tsx`）

**修改 `generatePreview`**（路径 I 批量添加）：
- 当 `route === Route.patchApply` 时：
  - 新增表单字段 `wearDays: number`（默认 `3.5`）。范围和上下限在实现时与用户最终确认（暂定 0.5–7 天，对应现实贴片 12h–1 周的使用周期）。
  - 对每个生成的 apply 事件 `e`，在同一 groupId 下同时生成 remove 事件 `r`：`r.timeH = e.timeH + wearDays * 24`、`r.doseMG = 0`、`r.route = Route.patchRemove`、共享 `e.companionGroupId`。
  - 把 `(apply, remove)` 对作为 `previewEvents` 的一部分。
- `ROUTE_DISPLAY_ORDER` 保持不变（不暴露 `Route.patchRemove`），仅在内部 `generatePreview` 里检测到 patch 时自动配对生成。
- `groupedPreview`（按天分组用于预览渲染）当前已经有 `const isPatchRemove = ev.route === Route.patchRemove;` 判断（line 1121），preview 渲染需要把 apply 和 remove 渲染成一行而不是两行（避免视觉混乱）。

### PK 引擎（`pk.ts`）

**修改 `PrecomputedEventModel` 的 `case Route.patchApply`**（路径 J）：
- 把现有 `allEvents.find(e => e.route === Route.patchRemove && e.timeH > startTime)` 替换为：
  ```ts
  const remove = event.companionGroupId
      ? allEvents.find(e =>
            e.route === Route.patchRemove &&
            e.companionGroupId === event.companionGroupId &&
            e.timeH > startTime)
      : undefined;
  const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;
  ```
- 无 groupId 时按「贴到永远」处理（`Number.MAX_VALUE`），保证 PK 引擎永不踩到 1-to-N 坑。

### 导入层（`src/utils/importData.ts`）

**新增导出**：`reconcileImportedPatchEvents(events: DoseEvent[]): DoseEvent[]`

**行为**：
1. 抹除不合法事件：
   - `route === Route.patchRemove` 但同 `companionGroupId`（如果有）找不到 `patchApply` 配对 → 删
   - `route === Route.patchApply` 但同 groupId 找不到 `patchRemove` 配对 → **保留 apply，移除残留的 groupId**（防止 UI 把它当成「带撕下」状态）
2. 补回合法老数据：
   - 找出所有「没有 groupId 的 `patchApply`」，按 `timeH` 升序排。
   - 找出所有「没有 groupId 的 `patchRemove`」，按 `timeH` 升序排。
   - **1-to-1 greedy 配对**：从头扫，每条 apply 找 `timeH` 在 `[apply.timeH, apply.timeH + 14 * 24]` 范围内的第一条 remove，打上同一个新 UUID 作为 groupId。
   - 配对剩余的（找不到配对 remove 的 apply、找不到配对 apply 的 remove）保持原样（apply 单独存在、remove 单独存在）。
3. 调用位置：`importData.ts` 的反序列化入口，**至少包括**：
   - `parseBackupData` / `parseJSON` / `parseCSV` 等所有格式解析完成后的最终事件数组
   - 反序列化结果在赋值到全局状态前必须过 `reconcileImportedPatchEvents`
   - 具体调用点由实现者在 `importData.ts` 末尾统一加（grep `events:` 找所有解析完成的位置）

### 测试（`src/utils/patch.test.ts` + 新文件）

**在 `patch.test.ts` 新增**：
- `removeCompanion / applyCompanion` 的精确匹配 + 无 groupId 场景

**新增 `src/utils/importData.test.ts` 中的 reconcile 用例**（或单独 `patchReconcile.test.ts`）：
- 抹除孤儿 remove
- 给合法老 apply + remove 补 groupId
- 保留合法单条 apply（无 remove）
- 1-to-1 greedy 配对验证（多条 apply + 多条 remove 不会跨对配错）

**新增 `src/components/BatchDoseModal.test.tsx`**（如果还没有）：
- 选 patchApply + 默认 wearDays = 3.5 → 预览里同时出现 (apply, remove) 对，共享 groupId

**新增 `src/views/HistoryView.cascade.test.tsx`（或扩展 dateGrouping 测试）**：
- 单条删除 apply → 配对 remove 一起消失
- 编辑 apply 改 route → 配对 remove 一起消失

---

## 行为细节（特殊场景）

### D2（编辑 apply，清空「摘下时间」）

**现状**：`removeTimeStr = ''` → 走单事件保存 `onSave`，apply 原地替换、remove 没动 → 旧 remove 变孤儿（因为它仍挂在原 groupId 上，但 UI 不再显示撕下小字、PK 引擎仍按 groupId 找到它 → 曲线继续按原撕下时间算）

**新行为（基于级联匹配规则）**：
- 编辑 apply、清空摘下时间 → apply **保持原 groupId**（不重置），不写新 remove
- 旧 remove 仍挂在原 groupId 上 → PK 引擎仍按它算 → 行为和编辑前一致
- 用户如果想「彻底去掉这条撕下时间」，需要手动点垃圾桶按钮删 apply（级联会带走 remove）

**为什么要这样**：用户的意图是「只改贴上时间、不改撕下时间」，那撕下时间应该不变。如果 apply 的 groupId 被重置、旧 remove 又没被删，旧 remove 就成了真正的孤儿（apply groupId 是新的，remove groupId 是旧的，PK 引擎会忽略 remove 当作「贴到永远」）—— **更糟**。

### 编辑 apply、同时改时间、同时改摘下时间

按 D1 处理（最严格）：旧的 remove 按原 groupId 找到 → 删除 → 写新 groupId 的 remove。

### 编辑 apply、只改贴上时间（不动摘下时间）

走的是 `handleSaveEvent`（DoseFormModal 的 `removeTimeStr.trim() === ''` 分支，不是 `handleSavePatch`）→ apply 原地替换（id / groupId / remove id 全保留）→ remove 仍正确。现状已正确，无需改。

### 编辑 remove、只改撕下时间

现状：单独编辑 `patchRemove`（id 不变） → `handleSaveEvent` 原地替换 → groupId 保留 → 行为正确。
新行为不需要改（也无需级联）。

### 编辑 remove、改 route 成其他

按路径 E 同款：旧 apply 仍挂在 groupId 上 → 旧 remove 改 route 后，groupId 仍一样 → UI 仍把它当 remove 渲染 → 错乱。
**需要级联**：若 `oldE.route === Route.patchRemove` 且 `newE.route !== Route.patchRemove`，找同 groupId 的 apply 一并处理（**不删 apply，但要重置 apply 的 groupId 为空**，防止 PK 引擎继续把它当成「带撕下」处理）。

### 「贴片移除」一键按钮（路径 C）

现状已对：复用 apply 的 groupId（如果有）或新建。无需改。

### 多选删除（路径 G / H）

`HistoryView.visibleEventIds` 已经在做 groupId 级联补全。`handleBulkDeleteEvents` 用 `new Set(...)` 已天然去重，无需额外保险。无需改。

---

## 范围边界（不做的事）

- **不做启动时孤儿 sweep**：用户都是新用户，不需要。
- **不做跨设备 sync 时增量 reconcile**：`SyncConflictModal` 仍是整批选 local / cloud；reconcile 只在导入时跑一次。
- **不做 `findPatchRemoveForApply` 的 14 天兜底移除**：UI 渲染可能仍需要（虽然实际数据都有 groupId）；兜底保留无害。
- **不做 PK 引擎对 groupId 缺失事件的「1-to-1 greedy 兜底」**：按用户决策，无 groupId 直接当「贴到永远」。

---

## 风险 / 取舍

- **`removeCompanion` 不带时间轴兜底**：可能漏掉「旧导入 + 没 groupId 的对」。但用户已经定了「导入时 reconcile 补 groupId」，所以这条路径只影响「在 reconcile 之前发生的 in-flight 写入」—— 实际不会发生（reconcile 在导入完成时已经跑过了）。
- **D2 的「保留 groupId + 旧 remove」行为**：可能让用户困惑（清空摘下时间字段但 PK 曲线不变）。**MVP 不做 UI 提示**；如用户后续报问题再加。
- **PK 引擎兜底为「贴到永远」**：无 groupId 的老数据（用户从未导入过 reconcile 的极端情况下）会画成「贴到永远」曲线，比「错配」更保守、不会算错药效。
- **导入时抹除孤儿 remove**：如果用户的 localStorage 里有手写的「孤儿 remove」（带 groupId 但 apply 不存在），会被静默删除。无 UI 提示（用户决策）。

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/utils/patch.ts` | 新增 `removeCompanion` / `applyCompanion` |
| `src/utils/patch.test.ts` | 新增上述两函数的单测 |
| `src/utils/importData.ts` | 新增 `reconcileImportedPatchEvents`，所有反序列化入口调用 |
| `src/utils/importData.test.ts` | 新增 reconcile 用例 |
| `src/components/MainLayout.tsx` | `handleDeleteEvent` / `handleSaveEvent` / `handleSavePatch` 三处加级联 |
| `src/components/DoseFormModal.tsx` | `handleSave` 改 apply 的 groupId 处理（D1 用新 groupId、D2 保持） |
| `src/components/BatchDoseModal.tsx` | `generatePreview` 加 wearDays 字段 + 生成 remove 配对 |
| `src/views/HistoryView.cascade.test.tsx` (新) | 回归测试：级联删除、改 route 级联 |
| `src/components/BatchDoseModal.test.tsx` (新，如无) | 批量贴片生成配对事件 |
| `pk.ts` | `case Route.patchApply` 改用 groupId 严格匹配 |

---

## 验收

- [ ] 单元测试全过（vitest）
- [ ] 回归测试覆盖：单条删 apply 带走 remove；编辑改 route 带走 remove；批量添加生成配对
- [ ] 手动 smoke test：完整走 A → B → C → D → E → F → G → H → I → J 各路径，确认数据无孤儿
- [ ] 用 Playwright 在真实浏览器复跑历史 bug 场景（用户实测过的）
- [ ] 导入老 JSON 测试：reconcile 后所有 patch 事件都带 groupId 或单独合法存在