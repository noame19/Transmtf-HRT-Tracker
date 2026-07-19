# 用药记录 / 用药计划 多选删除设计

## Context(为什么改)

现状 `/history` 页面:
- **用药记录 tab**:单击 event 卡片 → 打开 `DoseFormModal`,modal 内部才能删除单条。**没有任何多选 / 批量删除能力**。删除前有 `showDialog('confirm')` 兜底,但需要进 modal → 点删除 → 二次确认,清空一周 14 条得重复 14 次。
- **用药计划 tab**:`PlanList` 每张卡片底部有「编辑 / 删除」按钮,删除走 `showDialog('confirm')`。同样**没有多选 / 批量删除能力**。

用户的实际场景:误录了一整周的口服 E2(7 天 × 2 次/天 = 14 条),或者一次性把"测试用的临时计划"全部清掉。当前 UX 都不支持。

目标:在两个 tab 都加**长按进入多选模式 + 范围选择 + 批量删除**。

约束:
- 不破坏现有的玻璃感设计语言(沿用 `glass-card` / `btn-press-glass` / `var(--accent-500)`)
- 不破坏单击打开编辑的现状(非多选模式下单击保持原行为)
- patch apply 删时自动连带配对 remove(保持"一片贴片 = 一条记录"的语义)
- 多选模式状态是 HistoryView 本地状态,切换 tab 时自然重置(不需要跨 tab 持久)

---

## 范围

**改**:
- `src/views/HistoryView.tsx` — 加多选状态机 + 长按/单击路由分发 + 工具栏挂载点 + 顶部选中 banner
- `src/components/PlanList.tsx` — 加 `selectionMode + selectedIds + onToggleSelected` props,卡片渲染 ✓ 角标
- `src/components/MainLayout.tsx` — 新增 `handleBulkDeleteEvents(ids)` 和 `handleBulkDeletePlans(ids)`,透传到 outlet context

**新增**:
- `src/components/HistoryBulkActionBar.tsx` — 4 按钮竖排浮动工具栏

**不改**:
- `src/pages/HistoryPage.tsx`(只转发 props,新签名透传)
- `DoseFormModal.tsx` / `PlanEditModal.tsx` / `BatchDoseModal.tsx` / `BatchPlanConfirmModal.tsx`(单条删除路径保留,作 fallback)
- 其他 view(Overview / Lab / Settings)

---

## 1. 架构

### 1.1 新 prop 签名

`HistoryViewProps` 新增(HistoryView / HistoryPage / MainLayout 三层都要同步):

```ts
interface HistoryViewProps {
    // ... 已有
    onBulkDeleteEvents: (ids: string[]) => void;
    onBulkDeletePlans: (ids: string[]) => void;
}
```

`PlanListProps` 新增:

```ts
interface PlanListProps {
    // ... 已有
    /** Whether the parent view is currently in multi-select mode. When true,
     *  each card renders a leading ✓ checkbox and the inline enable toggle +
     *  edit/delete buttons are HIDDEN (the multi-select toolbar replaces
     *  them). */
    selectionMode: boolean;
    /** Currently selected plan ids. Order doesn't matter. */
    selectedIds: string[];
    /** Toggle a single plan's selection state. The parent is the source of
     *  truth — PlanList only forwards the user's click. */
    onToggleSelected: (id: string) => void;
}
```

注:`selectedIds` 用 `string[]` 而不是 `Set<string>`——React props 引用稳定性更重要,Set 的引用每次 add 都变,会触发无谓重渲染。HistoryView 内部用 Set 做 O(1) 查询,只在透传时 `Array.from(set)`。

### 1.2 MainLayout outlet context 新增

```ts
onBulkDeleteEvents: handleBulkDeleteEvents,
onBulkDeletePlans: handleBulkDeletePlans,
```

### 1.3 不引入 Context

**理由**:多选状态是**临时性、tab 隔离**的——切到 plans tab 时 records 的选中状态本来就该清空。Context 共享反而要处理"两个 tab 的 id 空间不撞车"、"切 tab 时清哪部分 state"等无谓复杂度。本地 state 完全够用,且不影响 SSR/React 19 升级路径。

---

## 2. 状态机(核心)

HistoryView 内部 4 个 useState:

```ts
const [selectionMode, setSelectionMode] = useState(false);
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

// "区间选择"按钮 3 态:
//  - idle:         默认状态;点按钮 → awaitingAnchor
//  - awaitingAnchor: 用户被告知"点 A 作为锚点";点 A → armed;点空白处/再按按钮 → idle
//  - armed:        已选 anchor;点 B → 触发范围勾选 → idle;再按按钮 → idle
const [rangeButtonState, setRangeButtonState] = useState<'idle' | 'awaitingAnchor' | 'armed'>('idle');
const [rangeAnchorId, setRangeAnchorId] = useState<string | null>(null);
```

**进入多选**:`selectionMode = true`(长按触发,详见 §3)。
**退出多选**:`selectionMode = false`,所有相关 state 全部 reset。

### 2.1 4 个按钮行为表

| 按钮 | idle | awaitingAnchor | armed |
|---|---|---|---|
| **全选** | `setSelectedIds(new Set(visibleEventIds))` | 同 left | 同 left(范围 anchor 仍在,不影响) |
| **区间选择** | → awaitingAnchor,`setRangeAnchorId(null)` | 取消待选 → idle,清 anchor | 取消待选 → idle,清 anchor |
| **取消** | 退出多选 + 清空 selectedIds + 清 anchor | → idle(不退出多选) | → idle(不退出多选) |
| **删除** | `showDialog('confirm', '...')` 确认后调 `onBulkDeleteEvents/Plans(Array.from(selectedIds))` → 退出多选 | **disabled** | **disabled** |

**disabled 条件**:`rangeButtonState !== 'idle'`(防止范围 anchor 悬空时误删)**或** `selectedIds.size === 0`。

### 2.2 切 tab 重置

HistoryView 当前 useEffect(隐式):切 `activeTab` 时 React 不自动 reset useState。**需要显式**在 tab 切换按钮 onClick 里调 `resetSelection()`:

```ts
const resetSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setRangeButtonState('idle');
    setRangeAnchorId(null);
};
```

并在 tab 切换按钮处 `setActiveTab(t); resetSelection();`。

---

## 3. 长按 / 单击路由

### 3.1 长按检测(避免和滚动冲突)

每个 item `<div>` 加:

```tsx
const pressTimerRef = useRef<number | null>(null);
const pressStartRef = useRef<{ x: number; y: number } | null>(null);

const onPointerDown = (e: React.PointerEvent, item: { id: string }) => {
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    pressTimerRef.current = window.setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(30);
        setSelectionMode(true);
        setSelectedIds(new Set([item.id]));
    }, 500);
};

const onPointerMove = (e: React.PointerEvent) => {
    if (!pressStartRef.current || pressTimerRef.current === null) return;
    const dx = e.clientX - pressStartRef.current.x;
    const dy = e.clientY - pressStartRef.current.y;
    if (Math.hypot(dx, dy) > 10) {
        // 用户在滚动 / 拖动,取消长按
        if (pressTimerRef.current !== null) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = null;
        }
    }
};

const onPointerEnd = () => {
    if (pressTimerRef.current !== null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
    }
    pressStartRef.current = null;
};
```

### 3.2 单击路由

```tsx
const handleItemClick = (item: { id: string }) => {
    if (selectionMode) {
        toggleSelected(item.id);
        return;
    }
    onEditEvent(item as DoseEvent); // 原行为
};
```

### 3.3 范围勾选核心算法

**关键决策**:范围按"当前 tab 可见 item 的渲染顺序"算,不用 `timeH` 排序。这样:
- records tab:渲染顺序 = `groupedEvents` 从最新到最旧;区间勾选按这个数组顺序
- plans tab:渲染顺序 = `plans` 数组顺序;区间勾选按这个数组顺序

```ts
// 仅在 records tab 计算
const visibleEventIds: string[] = useMemo(() => {
    const out: string[] = [];
    for (const group of Object.values(groupedEvents)) {
        for (const ev of group.items) {
            if (isPatchRemove(ev)) continue; // 隐藏项不进选
            out.push(ev.id);
            // patch apply 自动连带配对 remove(详 §5)
            if (isPatchApply(ev)) {
                const paired = findPatchRemoveForApply(ev, events);
                if (paired) out.push(paired.id);
            }
        }
    }
    return out;
}, [groupedEvents, events]);
```

`onArmRange` 流程:

```ts
const handleRangeArm = () => {
    if (rangeButtonState === 'idle') {
        setRangeButtonState('awaitingAnchor');
        return;
    }
    // awaitingAnchor 或 armed → 取消
    setRangeButtonState('idle');
    setRangeAnchorId(null);
};

// 在 item 的 onClick 里:
const handleItemClickInMulti = (itemId: string) => {
    if (selectionMode && rangeButtonState === 'awaitingAnchor') {
        setRangeAnchorId(itemId);
        setRangeButtonState('armed');
        toggleSelected(itemId); // anchor 自动勾上
        return;
    }
    if (selectionMode && rangeButtonState === 'armed' && rangeAnchorId) {
        // plans tab 用 plans 数组顺序;records tab 用 groupedEvents 渲染顺序(详 §3.3 visibleEventIds)
        const visibleIds = activeTab === 'records' ? visibleEventIds : plans.map(p => p.id);
        const startIdx = visibleIds.indexOf(rangeAnchorId);
        const endIdx = visibleIds.indexOf(itemId);
        if (startIdx >= 0 && endIdx >= 0) {
            const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
            const rangeIds = visibleIds.slice(lo, hi + 1);
            setSelectedIds(prev => {
                const next = new Set(prev);
                rangeIds.forEach(id => next.add(id));
                return next;
            });
        }
        setRangeButtonState('idle');
        setRangeAnchorId(null);
        return;
    }
    if (selectionMode) {
        toggleSelected(itemId);
        return;
    }
    // 非多选模式 = 原行为
    onEditEvent(item);
};
```

---

## 4. 工具栏视觉

新建 `src/components/HistoryBulkActionBar.tsx`:

```tsx
interface Props {
    visible: boolean;                                  // selectionMode
    selectedCount: number;
    rangeButtonState: 'idle' | 'awaitingAnchor' | 'armed';
    onSelectAll: () => void;
    onArmRange: () => void;
    onCancel: () => void;
    onDelete: () => void;
}

const HistoryBulkActionBar: React.FC<Props> = ({
    visible, selectedCount, rangeButtonState,
    onSelectAll, onArmRange, onCancel, onDelete,
}) => {
    if (!visible) return null;
    const canDelete = rangeButtonState === 'idle' && selectedCount > 0;

    return (
        <div
            className="fixed right-3 bottom-24 z-50 flex flex-col gap-2
                       md:right-6 md:bottom-6"
            aria-label="批量操作"
        >
            <ToolbarBtn icon={<CheckCheck size={20} />} label="全选" onClick={onSelectAll} />
            <ToolbarBtn
                icon={<ArrowDownUp size={20} />}
                label="区间选择"
                onClick={onArmRange}
                active={rangeButtonState !== 'idle'}
                pulsing={rangeButtonState === 'awaitingAnchor'}
            />
            <ToolbarBtn icon={<X size={20} />} label="取消" onClick={onCancel} />
            <ToolbarBtn
                icon={<Trash2 size={20} />}
                label={selectedCount > 0 ? `删除 (${selectedCount})` : '删除'}
                onClick={onDelete}
                disabled={!canDelete}
                danger
            />
        </div>
    );
};

const ToolbarBtn: React.FC<{
    icon: React.ReactNode; label: string; onClick: () => void;
    active?: boolean; pulsing?: boolean; disabled?: boolean; danger?: boolean;
}> = ({ icon, label, onClick, active, pulsing, disabled, danger }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`w-14 h-14 rounded-2xl flex items-center justify-center btn-press-glass transition ${pulsing ? 'animate-pulse' : ''}`}
        style={{
            background: 'var(--bg-card)',
            color: disabled ? 'var(--text-tertiary)'
                  : danger ? '#dc2626'
                  : active ? 'var(--accent-500)'
                  : 'var(--text-secondary)',
            boxShadow: 'var(--shadow-md)',
            border: `1px solid ${active ? 'var(--accent-500)' : 'var(--border-primary)'}`,
            opacity: disabled ? 0.5 : 1,
        }}
    >
        {icon}
    </button>
);
```

### 4.1 顶部选中 banner

HistoryView 在 tab strip 之下、列表之上加一条 sticky banner:

```tsx
{selectionMode && (
    <div className="px-2 md:max-lg:px-2 lg:px-4 sticky top-0 z-30">
        <div className="glass-card rounded-xl px-3 py-2 flex items-center justify-between text-sm">
            <span style={{ color: 'var(--text-primary)' }}>
                {t('history.selected_count', { count: selectedIds.size }) || `已选 ${selectedIds.size} 项`}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {rangeButtonState === 'awaitingAnchor' && '请点 A 作为起点'}
                {rangeButtonState === 'armed' && '请点 B 完成范围'}
            </span>
        </div>
    </div>
)}
```

i18n 新增 key:`history.selected_count`(带 `{count}` 占位符)。fallback 中文已写在代码里。

---

## 5. 数据流 + 删除联动

### 5.1 MainLayout 新增 handler

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

**注**:不弹二次 confirm—— HistoryView 的工具栏"删除"按钮调用时**已经**走过 `showDialog('confirm', '确认删除 N 条?此操作不可撤销。')` 一次,MainLayout 不重复弹。dialog 文本里写明 N。

### 5.2 patch apply 联动

在 `visibleEventIds` 计算里(§3.3)已经做了:每个 patchApply 的 id 加进 visibleEventIds 时,`findPatchRemoveForApply(ev, events)` 拿到配对 remove event,**也加进同一个数组**。

后果:
- "全选"按钮一次性选中所有 apply + 所有配对 remove
- "区间选择"覆盖到 patchApply 时,也会带上配对 remove
- 删除时 set filter 一次性干掉全部

### 5.3 单选 vs 多选的状态同步

- 单击 patchApply item 在多选模式下 toggleSelected(item.id)——只 toggle 它自己,**不带**配对 remove 进 selectedIds
- 想完整删 patchApply 的对应数据,需要"全选"或"区间选择"覆盖到它

这是有意的:单击 toggle 是"用户只想要这一条"的语义;批量按钮是"用户想要这一片"的语义。两者行为分清楚。

---

## 6. 错误处理

### 6.1 删除失败

setEvents / setPlans 是同步纯函数,不会失败。持久化由 AppDataContext 的 storage watcher 异步处理;若 IndexedDB 写入失败,AppDataContext 已有 try/catch 包住,失败会走全局 toast。本特性不需要额外处理。

### 6.2 长按误触

- 500ms 阈值 + 移动 >10px 取消 → 99% 误触被过滤
- 极端情况(用户真就要等 500ms):震动反馈让用户意识到状态切换了

### 6.3 多选模式下编辑被屏蔽

`handleItemClick` 在 selectionMode 下不发 `onEditEvent`,确保用户不会意外打开编辑 modal。但 PlanList 卡片底部的"编辑/删除"按钮区:在 selectionMode 下**隐藏**(由 PlanList 的 prop 决定),避免误触。

### 6.4 patch remove 是 hidden item

现状 list 已经把 `isPatchRemove(ev)` 的 event 从 groupedEvents.items 里 filter 掉(HistoryView.tsx line 210)。所以 visibleEventIds 里不会单独出现 remove event id——它只会作为 apply 的"伴生 id"出现,删除时一并干掉。

---

## 7. 测试

### 7.1 vitest 单元测试

`src/components/HistoryBulkActionBar.test.tsx`(新建,~50 行):
- 渲染:visible=false 时返回 null
- visible=true:渲染 4 个按钮,标签分别为"全选"/"区间选择"/"取消"/"删除"
- 删除按钮 disabled:`selectedCount === 0` 或 `rangeButtonState !== 'idle'`
- 点删除按钮调用 onDelete

`src/views/HistoryView.selection.test.tsx`(新建,~150 行):
- 长按触发:mock setTimeout 触发 500ms 定时器 → selectionMode=true + selectedIds 含该 id
- 长按 + 移动 >10px 不触发:setSelectedIds 未被调用
- 单击在多选模式下:toggleSelected(itemId),不调 onEditEvent
- 单击在非多选模式下:调 onEditEvent
- 范围选择 idle → awaitingAnchor → 选 A → armed → 选 B → A~B 全勾 + state 归位
- 切 tab 重置:模拟 setActiveTab('plans') 后 selectionMode=false

### 7.2 手动验证清单

- [ ] 桌面 chrome devtools device mode 390×844,长按一条 event 0.5s → 工具栏从右侧浮出 + 顶部"已选 1 项"banner 出现
- [ ] 移动设备真机(android / iOS):震动反馈触发
- [ ] 区间选择:idle 点按钮 → awaitingAnchor → 点 A → armed → 点 B → A~B 全勾上 + state 归位 + 顶部"已选 N 项"
- [ ] 全选:当前 tab 所有 visible item 全勾 + patch apply 的配对 remove 也勾上
- [ ] 单击多选模式下某条:该条独立勾选 / 取消(不带配对)
- [ ] 取消按钮:弹 confirm "放弃 N 项选中?" 确认后退出多选
- [ ] 删除按钮:弹 confirm "确认删除 N 条?此操作不可撤销。" 确认后 item 从 DOM 消失 + 工具栏消失
- [ ] patch apply 多选删除:打开 AppDataContext devtools,看 events state 同时少了一条 apply + 一条配对 remove
- [ ] 切 tab:多选状态完全重置
- [ ] 长按时滚动 list:中途移动 >10px,长按不触发

---

## 8. 风险与边界

- **手势冲突**:单击已经在 records tab 触发 `onEditEvent`。长按 500ms 在桌面 chrome devtools device mode 上能区分,但真机上要看用户手指不动的能力。**不实现二次确认"是否进入多选模式"**——震动就是反馈。
- **PlanList 既有按钮区**:多选模式下隐藏 enable toggle / edit / delete 三个按钮。多选模式卡片只显示 ✓ checkbox + 卡片标题 + 副标题——避免用户困惑"我到底能不能点这个按钮"。
- **i18n**:仅 1 个新 key `history.selected_count`,fallback 中文已写在代码里。Languages 文件夹同步提交,en / ja 翻译留 stub。
- **可访问性**:工具栏按钮都有 aria-label + title。键盘 tab 序列:range/cancel/delete 顺序合理。
- **未来扩展**:"全选"按钮目前只覆盖"当前 tab 可见",不覆盖"所有 tab 全部数据"——后者在 pagination / filter 出现时才需要。

---

## 9. 文件清单

| 文件 | 操作 | 行数估算 |
|---|---|---|
| `src/views/HistoryView.tsx` | 改 | +150 行 |
| `src/components/PlanList.tsx` | 改 | +30 行 |
| `src/components/MainLayout.tsx` | 改 | +10 行 |
| `src/pages/HistoryPage.tsx` | 改(透传 props) | +2 行 |
| `src/components/HistoryBulkActionBar.tsx` | 新建 | ~80 行 |
| `src/components/HistoryBulkActionBar.test.tsx` | 新建 | ~50 行 |
| `src/views/HistoryView.selection.test.tsx` | 新建 | ~150 行 |
| `src/i18n/locales/zh.json`(或类似) | 改 | +1 key |

合计:6 个文件改,2 个文件新建,~470 行新增。

---

## 10. 验证清单

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm run test`(vitest)全绿
- [ ] `npm run build` 通过(确认无 unused 警告)
- [ ] 桌面 chrome devtools 模拟手机 + 真实移动设备走通 §7.2 全部 9 条
- [ ] patch apply 多选删除后,DoseFormModal list 不残留孤儿 remove event
- [ ] PlanList 在多选模式下隐藏 enable toggle / 编辑 / 删除按钮