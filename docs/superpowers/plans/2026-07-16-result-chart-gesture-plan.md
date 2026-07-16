# 血药浓度图表手势交互实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除血药浓度图表下方的 Recharts `Brush` 缩略范围选择器，并把横坐标缩放、平移和触屏数据查看直接迁移到主图表。

**Architecture:** 将坐标换算、曲线命中、横坐标平移/缩放等无界面数学逻辑放进一个纯工具模块，便于在 Node 环境下单元测试；`ResultChart.tsx` 只负责把实际图表数据映射到曲线、绑定鼠标/触摸事件和渲染触屏提示框。所有交互最终调用现有的 `xDomain`、`scheduleDomainUpdate` 和边界限制逻辑，不改动药代动力学计算。

**Tech Stack:** React 18、TypeScript、Recharts 2、Vitest、浏览器 Wheel/TouchEvent API。

---

## 文件边界

- **Create:** `src/utils/chartGesture.ts` — 图表绘图区坐标换算、曲线插值/命中、横坐标 domain 的边界限制、平移和锚点缩放；无 React 和 Recharts 依赖。
- **Create:** `src/utils/chartGesture.test.ts` — 上述纯函数的单元测试，使用现有 Vitest Node 环境。
- **Modify:** `src/components/ResultChart.tsx:0-1210` — 删除 Brush 专用代码；建立可命中的曲线列表；绑定桌面端滚轮/空白拖拽和触屏三种手势；渲染触屏查看提示。
- **Do not modify:** 药代动力学逻辑、`types.ts`、翻译文件、Android/Tauri 文件和现有快捷缩放按钮。

---

### Task 1: 建立可测试的图表坐标与 domain 工具

**Files:**
- Create: `src/utils/chartGesture.test.ts`
- Create: `src/utils/chartGesture.ts`

- [ ] **Step 1: 先写纯函数失败测试**

在 `src/utils/chartGesture.test.ts` 写入以下测试契约。测试不依赖 DOM 或 React：

```ts
import { describe, expect, it } from 'vitest';
import {
    clampDomain,
    hitTestCurves,
    interpolateAtTime,
    nearestPoint,
    panDomain,
    pixelXAtTime,
    timeAtPixel,
    zoomDomainAt,
    type CurveSeries,
    type PlotRect,
} from './chartGesture';

const DAY = 24 * 3600 * 1000;
const rect: PlotRect = { left: 100, top: 20, width: 800, height: 400 };
const bounds = { minTime: 0, maxTime: 10 * DAY, minZoom: DAY };
const curve: CurveSeries = {
    points: [
        { time: 0, value: 0 },
        { time: 5 * DAY, value: 100 },
        { time: 10 * DAY, value: 0 },
    ],
    yDomain: [0, 100],
};

describe('chartGesture domain helpers', () => {
    it('round-trips a time through the plot x coordinate', () => {
        const time = 4 * DAY;
        expect(timeAtPixel(pixelXAtTime(time, rect, [0, 10 * DAY]), rect, [0, 10 * DAY]))
            .toBeCloseTo(time);
    });

    it('enforces the minimum zoom and data bounds', () => {
        expect(clampDomain([2 * DAY, 2.25 * DAY], bounds)).toEqual([2 * DAY, 3 * DAY]);
        expect(clampDomain([-2 * DAY, 4 * DAY], bounds)).toEqual([0, 6 * DAY]);
        expect(clampDomain([0, 20 * DAY], bounds)).toEqual([0, 10 * DAY]);
    });

    it('pans in the opposite direction of the finger drag', () => {
        const next = panDomain([2 * DAY, 5 * DAY], 80, rect.width, bounds);
        expect(next[0]).toBeCloseTo(1.7 * DAY);
        expect(next[1]).toBeCloseTo(4.7 * DAY);
    });

    it('zooms around the supplied anchor time', () => {
        const next = zoomDomainAt([2 * DAY, 8 * DAY], 5 * DAY, 2, bounds);
        expect(next).toEqual([3.5 * DAY, 6.5 * DAY]);
    });
});

describe('chartGesture curve helpers', () => {
    it('linearly interpolates between curve points', () => {
        expect(interpolateAtTime(curve.points, 2.5 * DAY)).toBe(50);
    });

    it('returns the closest chart point for a touch tooltip', () => {
        const points = [
            { time: 0, value: 10 },
            { time: 5, value: 20 },
            { time: 10, value: 30 },
        ];
        expect(nearestPoint(points, 7)).toEqual({ index: 1, time: 5, value: 20 });
        expect(nearestPoint(points, 9)).toEqual({ index: 2, time: 10, value: 30 });
        expect(nearestPoint([], 9)).toBeNull();
    });

    it('hits a curve within the touch tolerance and rejects blank space', () => {
        const x = pixelXAtTime(5 * DAY, rect, [0, 10 * DAY]);
        const y = rect.top + rect.height / 2;
        expect(hitTestCurves(x, y + 18, rect, [0, 10 * DAY], [curve], 24)).not.toBeNull();
        expect(hitTestCurves(x, y + 40, rect, [0, 10 * DAY], [curve], 24)).toBeNull();
    });
});
```

这里的重点是先固定 API 和行为：屏幕横向向右拖动时，数据窗口向左移动；缩放因子大于 1 表示放大；曲线垂直命中容差为 24 像素。

- [ ] **Step 2: 运行新测试，确认它因模块不存在而失败**

运行：

```bash
cd /d D:\database\GitHub\Transmtf-HRT-Tracker
npx vitest run src/utils/chartGesture.test.ts
```

预期：FAIL，提示找不到 `./chartGesture` 导入模块；此时还没有修改图表组件。

- [ ] **Step 3: 写入最小纯函数实现**

创建 `src/utils/chartGesture.ts`，提供与测试完全一致的类型和函数签名：

```ts
export interface PlotRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface CurvePoint {
    time: number;
    value: number;
}

export interface CurveSeries {
    points: CurvePoint[];
    yDomain: [number, number];
}

export interface DomainBounds {
    minTime: number;
    maxTime: number;
    minZoom: number;
}

export interface CurveHit {
    time: number;
    distancePx: number;
}

export function clampDomain(domain: [number, number], bounds: DomainBounds): [number, number] {
    const maxZoom = Math.max(bounds.maxTime - bounds.minTime, bounds.minZoom);
    const requestedWidth = Math.max(0, domain[1] - domain[0]);
    const width = Math.max(bounds.minZoom, Math.min(requestedWidth, maxZoom));
    let start = domain[0];
    let end = start + width;

    if (start < bounds.minTime) {
        start = bounds.minTime;
        end = start + width;
    }
    if (end > bounds.maxTime) {
        end = bounds.maxTime;
        start = end - width;
    }
    return [start, end];
}

export function timeAtPixel(pixelX: number, rect: PlotRect, domain: [number, number]): number {
    if (rect.width <= 0 || domain[1] <= domain[0]) return domain[0];
    const ratio = (pixelX - rect.left) / rect.width;
    return domain[0] + ratio * (domain[1] - domain[0]);
}

export function pixelXAtTime(time: number, rect: PlotRect, domain: [number, number]): number {
    if (domain[1] <= domain[0]) return rect.left;
    return rect.left + ((time - domain[0]) / (domain[1] - domain[0])) * rect.width;
}

export function pixelYAtValue(value: number, rect: PlotRect, yDomain: [number, number]): number {
    if (yDomain[1] <= yDomain[0]) return rect.top + rect.height;
    const ratio = (value - yDomain[0]) / (yDomain[1] - yDomain[0]);
    return rect.top + rect.height * (1 - ratio);
}

export function interpolateAtTime(points: CurvePoint[], time: number): number | undefined {
    if (points.length === 0) return undefined;
    if (time <= points[0].time) return points[0].value;
    const last = points[points.length - 1];
    if (time >= last.time) return last.value;

    let low = 0;
    let high = points.length - 1;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (points[mid].time <= time) low = mid;
        else high = mid;
    }
    const span = points[high].time - points[low].time;
    const fraction = span > 0 ? (time - points[low].time) / span : 0;
    return points[low].value + (points[high].value - points[low].value) * fraction;
}

export function nearestPoint(
    points: CurvePoint[],
    time: number,
): { index: number; time: number; value: number } | null {
    if (points.length === 0) return null;
    if (time <= points[0].time) return { index: 0, ...points[0] };
    const lastIndex = points.length - 1;
    if (time >= points[lastIndex].time) return { index: lastIndex, ...points[lastIndex] };

    let low = 0;
    let high = lastIndex;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (points[mid].time <= time) low = mid;
        else high = mid;
    }
    const lowDistance = Math.abs(points[low].time - time);
    const highDistance = Math.abs(points[high].time - time);
    const index = highDistance < lowDistance ? high : low;
    return { index, ...points[index] };
}

export function panDomain(
    domain: [number, number],
    deltaPixels: number,
    plotWidth: number,
    bounds: DomainBounds,
): [number, number] {
    if (plotWidth <= 0) return domain;
    const offset = -(deltaPixels / plotWidth) * (domain[1] - domain[0]);
    return clampDomain([domain[0] + offset, domain[1] + offset], bounds);
}

export function zoomDomainAt(
    domain: [number, number],
    anchorTime: number,
    zoomFactor: number,
    bounds: DomainBounds,
): [number, number] {
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return domain;
    const anchor = Math.max(domain[0], Math.min(anchorTime, domain[1]));
    const start = anchor - (anchor - domain[0]) / zoomFactor;
    const end = anchor + (domain[1] - anchor) / zoomFactor;
    return clampDomain([start, end], bounds);
}

export function hitTestCurves(
    pixelX: number,
    pixelY: number,
    rect: PlotRect,
    xDomain: [number, number],
    curves: CurveSeries[],
    tolerancePx: number,
): CurveHit | null {
    if (rect.width <= 0 || rect.height <= 0 || curves.length === 0) return null;
    const time = timeAtPixel(pixelX, rect, xDomain);
    let closest: CurveHit | null = null;

    for (const curve of curves) {
        const value = interpolateAtTime(curve.points, time);
        if (value === undefined) continue;
        const curveY = pixelYAtValue(value, rect, curve.yDomain);
        const distancePx = Math.abs(pixelY - curveY);
        if (distancePx <= tolerancePx && (!closest || distancePx < closest.distancePx)) {
            closest = { time, distancePx };
        }
    }
    return closest;
}
```

- [ ] **Step 4: 运行纯函数测试，确认全部通过**

运行：

```bash
npx vitest run src/utils/chartGesture.test.ts
```

预期：全部测试 PASS。若 `panDomain` 的浮点比较出现尾数差异，只对数值断言使用 `toBeCloseTo`，不要放宽函数行为或跳过测试。

- [ ] **Step 5: 提交纯工具模块**

```bash
git add src/utils/chartGesture.ts src/utils/chartGesture.test.ts
git commit -m "feat: 增加图表手势坐标计算"
```

只暂存这两个新文件，不要把当前工作区已有的 `apk_dl/` 或 `src/views/OverviewView.module.css` 一并提交。

---

### Task 2: 删除主图下方的 Brush 缩略图

**Files:**
- Modify: `src/components/ResultChart.tsx:5-7, 320-324, 446-448, 705-734, 1149-1204`

- [ ] **Step 1: 删除 Brush 专用导入、常量和状态计算**

将 Recharts 导入从：

```ts
XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot, Area, AreaChart, ComposedChart, Scatter, Brush
```

改为：

```ts
XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot, Area, ComposedChart, Scatter
```

删除：

```ts
const MAX_OVERVIEW_POINTS = 180;
const overviewData = useMemo(() => downsampleSeries(rawData, MAX_OVERVIEW_POINTS), [rawData]);
```

以及 `findClosestIndex`、`brushRange`、`handleBrushChange` 三段逻辑。保留主图仍使用的 `data`、`rawData`、`xDomain`、组件当前的 `clampDomain`、`scheduleDomainUpdate`和 `zoomToDuration`；组件当前的 `clampDomain` 会在下一任务统一迁移到已测试的纯工具函数。

- [ ] **Step 2: 删除 Brush JSX 区块**

删除主图 `ResponsiveContainer` 结束后的整个 `{overviewData.length > 1 && (...)}` 区块，包括外层 `px-3 pb-4` 容器、内部 `AreaChart`、`Brush` 和 `overviewConc` 渐变。主图容器从 `line 796` 开始的 `ResponsiveContainer` 保留。

- [ ] **Step 3: 运行 TypeScript 和现有测试**

运行：

```bash
npx tsc --noEmit
npm run test
```

预期：TypeScript 编译成功；现有 Vitest 测试全部通过；代码中不存在 `AreaChart`、`Brush`、`overviewData`、`brushRange`、`handleBrushChange`和 `MAX_OVERVIEW_POINTS` 的残余引用。

- [ ] **Step 4: 提交 Brush 删除**

```bash
git add src/components/ResultChart.tsx
git commit -m "refactor: 移除血药浓度图表范围刷选器"
```

---

### Task 3: 接入绘图区和桌面端缩放/空白拖拽

**Files:**
- Modify: `src/components/ResultChart.tsx:0-1210`

- [ ] **Step 1: 建立主图引用、绘图区读取和可见曲线列表**

在组件状态附近增加 `chartRef`，并使用当前 Recharts 网格线读取真实绘图区，而不是用固定 margin 估算：

```ts
const chartRef = useRef<HTMLDivElement>(null);

const getPlotRect = useCallback((): PlotRect | null => {
    const container = chartRef.current;
    const horizontalGrid = container?.querySelector<SVGGElement>(
        '.recharts-cartesian-grid-horizontal',
    );
    if (!container || !horizontalGrid) return null;
    const gridRect = horizontalGrid.getBoundingClientRect();
    if (gridRect.width <= 0 || gridRect.height <= 0) return null;
    return {
        left: gridRect.left,
        top: gridRect.top,
        width: gridRect.width,
        height: gridRect.height,
    };
}, []);
```

从实际会绘制的曲线建立 `CurveSeries[]`，只加入数值存在的点：

```ts
const curveSeries = useMemo<CurveSeries[]>(() => {
    const pointsFor = (key: keyof ChartPoint): CurvePoint[] => data.flatMap((point) => {
        const value = point[key];
        return typeof value === 'number' && Number.isFinite(value)
            ? [{ time: point.time, value }]
            : [];
    });
    const left: [number, number] = [Number(yDomainLeft[0]), Number(yDomainLeft[1])];
    const right: [number, number] = [Number(yDomainRight[0]), Number(yDomainRight[1])];
    const curves: CurveSeries[] = [
        { points: pointsFor('concE2'), yDomain: left },
    ];
    if (hasE2Personal) curves.push({ points: pointsFor('concPersonal'), yDomain: left });
    if (hasCPADoses) curves.push({ points: pointsFor('concCPA'), yDomain: right });
    if (hasPersonalCpaModel) curves.push({ points: pointsFor('concPersonalCPA'), yDomain: right });
    return curves.filter((curve) => curve.points.length > 0);
}, [data, yDomainLeft, yDomainRight, hasE2Personal, hasCPADoses, hasPersonalCpaModel]);
```

把该 `useMemo` 和后续事件 `useEffect` 放在现有 `if (!sim || sim.timeH.length === 0) return ...` 之前，确保空态和有数据态的 Hook 调用顺序一致。

从 `chartGesture` 导入纯函数，并将组件当前的 `clampDomain` 重命名为导入别名，避免保留两套边界算法：

```ts
import {
    clampDomain as clampGestureDomain,
    hitTestCurves,
    nearestPoint,
    panDomain,
    pixelXAtTime,
    timeAtPixel,
    zoomDomainAt,
    type CurvePoint,
    type CurveSeries,
    type PlotRect,
} from '../utils/chartGesture';
```

删除组件原有 `line 644-665` 的 `clampDomain` 定义，并在 `zoomToDuration` 中改用：

```ts
const domainBounds = { minTime, maxTime, minZoom: 24 * 3600 * 1000 };
const start = targetCenter - duration / 2;
const end = targetCenter + duration / 2;
commitDomain(clampGestureDomain([start, end], domainBounds));
```

同步一个最新 `xDomain` 引用，供原生事件监听器读取而不依赖过期闭包：

```ts
const xDomainRef = useRef<[number, number] | null>(null);
useEffect(() => {
    xDomainRef.current = xDomain;
}, [xDomain]);
```

- [ ] **Step 2: 将外层主图容器绑定 `chartRef`**

把现有 line 796 的容器改为：

```tsx
<div
    ref={chartRef}
    className="h-[36vh] min-h-[200px] max-h-[420px] md:h-80 lg:h-96 w-full touch-none relative select-none px-2 pb-2"
    style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
>
```

继续保留其中的 `ResponsiveContainer` 和 `ComposedChart`，不要把引用挂到 Recharts 内部 SVG，因为响应式重绘时 SVG 节点会变化。

- [ ] **Step 3: 增加桌面滚轮的锚点缩放**

在 `useEffect` 中给 `chartRef.current` 添加非被动 `wheel` 监听。滚轮向上时 `zoomFactor > 1`，滚轮向下时 `zoomFactor < 1`；锚点使用鼠标所在时间：

```ts
const handleWheel = (event: WheelEvent) => {
    const plot = getPlotRect();
    const domain = xDomainRef.current;
    if (!plot || !domain || data.length < 2) return;
    event.preventDefault();
    const bounds = { minTime, maxTime, minZoom: 24 * 3600 * 1000 };
    const anchorTime = timeAtPixel(event.clientX, plot, domain);
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    scheduleDomainUpdate(zoomDomainAt(domain, anchorTime, zoomFactor, bounds));
};
node.addEventListener('wheel', handleWheel, { passive: false });
```

当没有绘图区或没有有效 domain 时直接返回，不修改状态。

- [ ] **Step 4: 增加空白区域鼠标拖拽平移**

使用一个引用记录拖拽开始位置和开始 domain：

```ts
type MousePan = { startX: number; domain: [number, number] };
const mousePanRef = useRef<MousePan | null>(null);
```

`mousedown` 只接受左键；调用 `hitTestCurves(event.clientX, event.clientY, plot, domain, curveSeries, 16)`，命中曲线时不启动平移，未命中时记录起点并阻止默认选择。`mousemove` 根据当前 X 与起点的差值调用：

```ts
const next = panDomain(
    mousePan.domain,
    event.clientX - mousePan.startX,
    plot.width,
    { minTime, maxTime, minZoom: 24 * 3600 * 1000 },
);
scheduleDomainUpdate(next);
```

在 `mouseup`、`mouseleave` 和组件卸载时清空 `mousePanRef`；所有监听器在 effect cleanup 中移除。鼠标曲线悬停仍交给现有 `Tooltip`，不新增鼠标 tooltip 状态。

- [ ] **Step 5: 运行编译和现有测试**

运行：

```bash
npx tsc --noEmit
npm run test
```

预期：编译和现有测试通过；桌面端手势只改变 `xDomain`，不会改变纵坐标域或药代动力学数据。

- [ ] **Step 6: 提交桌面端手势**

```bash
git add src/components/ResultChart.tsx
git commit -m "feat: 增加血药浓度图表桌面手势"
```

---

### Task 4: 接入触屏曲线查看、空白平移和双指缩放

**Files:**
- Modify: `src/components/ResultChart.tsx:282-1210`

- [ ] **Step 1: 增加触屏手势状态和提示状态**

增加以下类型和引用，模式只在一次触摸手势内固定：

```ts
type TouchMode = 'inspect' | 'pan' | 'pinch';
type TouchGesture = {
    mode: TouchMode;
    startX: number;
    startDomain: [number, number];
    startDistance: number;
    anchorTime: number;
};

type TouchTooltipState = {
    point: ChartPoint;
    x: number;
};

const touchGestureRef = useRef<TouchGesture | null>(null);
const [touchTooltip, setTouchTooltip] = useState<TouchTooltipState | null>(null);
```

触摸命中容差固定为 `24` 像素；鼠标曲线命中容差使用较小的 `16` 像素，避免普通桌面点击被空白平移误判。

- [ ] **Step 2: 实现触摸开始时的位置分流**

在同一组原生监听器中添加 `touchstart`，并使用第一根手指的位置做命中检测：

```ts
const first = event.touches[0];
const plot = getPlotRect();
const domain = xDomainRef.current;
if (!plot || !domain || data.length < 2) return;

if (event.touches.length >= 2) {
    const second = event.touches[1];
    const centerX = (first.clientX + second.clientX) / 2;
    touchGestureRef.current = {
        mode: 'pinch',
        startX: centerX,
        startDomain: domain,
        startDistance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        anchorTime: timeAtPixel(centerX, plot, domain),
    };
    setTouchTooltip(null);
    return;
}

const hit = hitTestCurves(first.clientX, first.clientY, plot, domain, curveSeries, 24);
touchGestureRef.current = {
    mode: hit ? 'inspect' : 'pan',
    startX: first.clientX,
    startDomain: domain,
    startDistance: 0,
    anchorTime: hit?.time ?? timeAtPixel(first.clientX, plot, domain),
};
if (!hit) setTouchTooltip(null);
```

这样一次手势不会在“曲线查看”和“空白平移”之间反复跳转；第二根手指出现时无条件覆盖为 `pinch`。

- [ ] **Step 3: 实现单指曲线查看**

触摸移动时，如果模式是 `inspect`，不修改 domain，只把手指横坐标转换为时间，并取 `data` 中最近的完整 `ChartPoint` 作为现有 `CustomTooltip` 的 payload：

```ts
const point = nearestPoint(data.map((item) => ({ time: item.time, value: item.concE2 ?? 0 })), touchTime);
if (!point) return;
const dataPoint = data[point.index];
const containerRect = chartRef.current?.getBoundingClientRect();
const pointX = pixelXAtTime(dataPoint.time, plot, domain);
setTouchTooltip({
    point: dataPoint,
    x: pointX - (containerRect?.left ?? 0),
});
```

Task 1 已提供并测试 `nearestPoint(points, time): { index: number; time: number; value: number } | null`；它使用二分查找返回距离最近的数据点。触摸移动始终调用 `event.preventDefault()`，阻止页面滚动。

- [ ] **Step 4: 实现单指空白区域平移**

触摸移动时，如果模式是 `pan`，使用开始 domain 和当前手指 X 的差值：

```ts
const next = panDomain(
    gesture.startDomain,
    touch.clientX - gesture.startX,
    plot.width,
    { minTime, maxTime, minZoom: 24 * 3600 * 1000 },
);
scheduleDomainUpdate(next);
```

平移过程中清除 `touchTooltip`，并对 `touchmove` 调用 `preventDefault()`。不根据移动距离重新做曲线命中，所以用户在空白处开始拖动后不会突然切换成查看模式。

- [ ] **Step 5: 实现双指横坐标缩放**

触摸移动检测到至少两根手指时使用当前两指距离与开始距离的比值。两指展开时 `zoomFactor > 1`，因此窗口变窄；两指捏合时窗口变宽：

```ts
const distance = Math.hypot(
    first.clientX - second.clientX,
    first.clientY - second.clientY,
);
const zoomFactor = gesture.startDistance > 0
    ? distance / gesture.startDistance
    : 1;
const next = zoomDomainAt(
    gesture.startDomain,
    gesture.anchorTime,
    zoomFactor,
    { minTime, maxTime, minZoom: 24 * 3600 * 1000 },
);
scheduleDomainUpdate(next);
setTouchTooltip(null);
event.preventDefault();
```

双指中点作为 anchor，保证捏合时用户关注的时间点稳定；不改变 Y 轴。

- [ ] **Step 6: 实现触摸结束和事件清理**

`touchend`/`touchcancel` 在所有手指抬起时清空 `touchGestureRef`；如果双指缩放时只抬起一根手指，也结束当前 pinch，不把剩余手指重新解释成平移或查看，直到下一次新的 `touchstart`。曲线查看模式保留最后一个 `touchTooltip`；空白平移和双指缩放结束时保持提示为空。effect cleanup 必须移除 `wheel`、`mousedown`、`mousemove`、`mouseup`、`mouseleave`、`touchstart`、`touchmove`、`touchend`和 `touchcancel`，并清空所有 refs。

- [ ] **Step 7: 渲染触屏提示框，不改变桌面 Tooltip**

在渲染前根据容器宽度限制提示框左坐标，再增加一个不接收指针事件的绝对定位层：

```ts
const tooltipLeft = touchTooltip
    ? Math.max(
        8,
        Math.min(
            touchTooltip.x,
            Math.max(8, (chartRef.current?.clientWidth ?? touchTooltip.x) - 180),
        ),
    )
    : 0;
```

```tsx
{touchTooltip && (
    <div
        className="absolute top-2 z-20 pointer-events-none"
        style={{ left: tooltipLeft }}
    >
        <CustomTooltip
            active
            payload={[{ payload: touchTooltip.point }]}
            label={touchTooltip.point.time}
            t={t}
            lang={lang}
            aaLabel={aaLabel}
            aaUnit={aaUnit}
            aaColor={aaColor}
            aaShowPersonal={aaPersonalized}
        />
    </div>
)}
```

提示框只在触屏状态存在，桌面端原有 Recharts `Tooltip` 和 hover 行为不变；剂量标记和实验室标记的现有点击行为不改动。

- [ ] **Step 8: 运行工具测试和全套检查**

工具测试已在 Task 1 固定了 `nearestPoint` 契约；这里确认触摸事件接入没有引入类型或回归问题。

运行：

```bash
npx vitest run src/utils/chartGesture.test.ts
npx tsc --noEmit
npm run test
```

预期：新增工具测试、TypeScript 编译和全部现有 Vitest 测试均通过。

- [ ] **Step 9: 提交触屏交互**

```bash
git add src/components/ResultChart.tsx src/utils/chartGesture.ts src/utils/chartGesture.test.ts
git commit -m "feat: 增加血药浓度图表触屏交互"
```

---

### Task 5: 最终验证和手势验收

**Files:**
- No new files; verify `src/components/ResultChart.tsx` and `src/utils/chartGesture.ts`.

- [ ] **Step 1: 执行最终静态检查、测试和构建**

```bash
npx tsc --noEmit
npm run test
npm run build
```

预期：三条命令均成功；构建产物不再包含 Brush 组件引用。

- [ ] **Step 2: 做桌面端手势验收**

运行 `npm run dev`，在浏览器中打开概览页并验证：

- 鼠标滚轮缩放横坐标时，鼠标下方时间点基本保持不动；
- 空白处左键拖动时图表左右移动；
- 曲线处按住不会误启动平移；
- 原有 hover 数据提示、剂量标记点击、`1M`、`1W`和重置按钮仍可用；
- 图表下方不再有缩略图或拖动手柄。

- [ ] **Step 3: 做手机/平板端手势验收**

使用浏览器设备模拟或真实触屏验证：

- 手指落在曲线附近左右滑动时显示最近时间点的完整数据，视图不移动；
- 手指落在空白处拖动时横坐标移动，不显示提示框，页面不跟着滚动；
- 两指捏合/展开时只缩放横坐标，曲线查看和平移不抢手势；
- 缩放和平移到数据边界时不会出现越界空白；
- 抬起曲线查看手指后保留最后提示，下一次空白平移或新手势会清除旧提示。

- [ ] **Step 4: 检查工作区并确认不夹带用户文件**

```bash
git status --short
```

只应看到本功能提交后的正常状态，以及开始实施前就存在、未被暂存的 `apk_dl/` 和 `src/views/OverviewView.module.css`（若它们仍未被用户处理）。不要删除、还原或提交这两个无关路径。
