/**
 * 血药浓度图视觉常量集中文件 (Recharts → ECharts 迁移)。
 *
 * 设计目的:
 * 1. 把原 Recharts 代码里散落的硬编码颜色/线宽/dasharray/渐变 1:1 集中到一处,
 *    ECharts option 构建器从这里取值,不写散落的 hex/rgba,避免视觉漂移。
 * 2. 视觉规则保持 100% 与原 Recharts 实现一致,仅渲染层从 SVG 换到 Canvas。
 *
 * 数据来源: src/components/ResultChart.tsx 原 Recharts 实现的所有
 *           stroke / fill / fontSize / strokeWidth / strokeDasharray 调用点
 *           (已逐行对照,见 PR 描述)。
 */

// ============================================================
// 系列色
// ============================================================

export const ECHART_THEME = {
    // --- E2 主曲线 ---
    e2Stroke: '#f2a3ad',          // rgb(242,163,173) 用户指定;原 Recharts Area stroke="#f6c4d7"
    e2Accent: '#ec4899',          // 原 Recharts E2 轴标签 fill="#ec4899"
    e2DotFill: '#ec4899',         // 原 Recharts E2 dose 点 fill="#ec4899"
    e2ActiveDotStroke: '#ffffff', // activeDot stroke="#fff"
    e2GradientTop: 'rgba(242,163,173,0.33)', // 同步 e2Stroke 改为 rgb(242,163,173);offset="5%" opacity 0.33(2026-07-19 原 0.18 加 0.15)
    e2GradientBottom: 'rgba(242,163,173,0)', // 同步 e2Stroke 改为 rgb(242,163,173);offset="95%" opacity 0(底部始终透明)

    // --- Personal model (E2 个性化拟合曲线) ---
    personalStroke: '#f43f5e',    // 原 Recharts Line stroke="#f43f5e"
    personalDasharray: [5, 3],    // 原 Recharts strokeDasharray="5 3"
    personalGradientTop: 'rgba(244,63,94,0.12)', // 原 colorPersonal stopOpacity={0.12}
    personalGradientBottom: 'rgba(244,63,94,0)',
    personalActiveDotStroke: '#ffffff',

    // --- CI band (95% / 68% 置信区间) ---
    ci95Fill: 'rgba(244,63,94,0.24)', // 2026-07-19 原 0.09 加 0.15;颜色固定红,不会跟着 E2 曲线变色
    ci68Fill: 'rgba(244,63,94,0.32)', // 2026-07-19 原 0.17 加 0.15;颜色固定红

    // --- AA (抗雄) 系列 ---
    // 运行时由 pickPrimaryAntiandrogen / ANTIANDROGENS 表给出,
    // 这里给 fallback:CPA 默认紫色。
    aaFallback: '#8b5cf6',
    // 原 Recharts CPA band fill = `${aaColor}1A`(hex alpha 10%),
    // 运行时把运行时 aaColor 转成 `{aaColor}1A` 形式,这里保留 hex alpha 0x1A 的说明。

    // --- 实验室结果 marker ---
    labFill: '#14b8a6',           // 原 Recharts Lab circle fill="#14b8a6"
    labStroke: '#ffffff',         // 原 Recharts Lab circle stroke="white"
    labStrokeWidth: 2,            // 原 Recharts Lab circle strokeWidth={2}
    labSymbolSize: 18,            // 原 Recharts Lab r=9(直径 18px)

    // --- "now" 当前时刻 ---
    nowDotFill: '#bfdbfe',        // 原 Recharts nowDot fill="#bfdbfe"
    nowDotStroke: '#ffffff',      // 原 Recharts nowDot stroke="white"
    nowDotStrokeWidth: 1.5,       // 原 Recharts nowDot strokeWidth={1.5}
    nowDotSize: 6,                // 视觉对齐:now 是双轴上的小亮点
    nowLineStroke: '#f2a3ad',     // 同步 e2Stroke 改 rgb(242,163,173);原 ReferenceLine stroke="#f6c4d7"
    nowLineDasharray: [3, 3],     // 原 Recharts strokeDasharray="3 3"
    nowLineWidth: 1.2,            // 原 Recharts strokeWidth={1.2}

    // --- 内源 baseline 横线 ---
    baselineStroke: '#14b8a6',    // 原 Recharts baseline stroke="#14b8a6"
    baselineDasharray: [4, 3],    // 原 Recharts strokeDasharray="4 3"
    baselineWidth: 1.2,           // 原 Recharts strokeWidth={1.2}

    // --- Tooltip cursor(hover 时悬停虚线) ---
    cursorStroke: '#f2a3ad',      // 同步 e2Stroke 改 rgb(242,163,173);原 cursor stroke="#f6c4d7"
    cursorDasharray: [4, 4],      // 原 Recharts strokeDasharray="4 4"
    cursorWidth: 1,               // 原 Recharts strokeWidth={1}

    // --- 几何尺寸 ---
    curveStrokeWidth: 2.2,        // 原 Recharts E2/AA strokeWidth={2.2}
    personalStrokeWidth: 1.8,     // 原 Recharts personal strokeWidth={1.8}
    doseDotSize: 6,               // 视觉对齐:原 Recharts dose 点 3px 半径 → 直径 6px
    activeDotR: 6,                // 原 Recharts activeDot r={6}
    personalActiveDotR: 4,        // 原 Recharts personal activeDot r={4}

    // --- 坐标轴 ---
    gridStroke: 'var(--border-secondary)', // 原 Recharts CartesianGrid stroke="var(--border-secondary)"
    gridDasharray: [3, 3],        // 原 Recharts CartesianGrid strokeDasharray="3 3"
    axisTickFontSize: 10,         // 原 Recharts tick fontSize={10}
    axisLabelFontSize: 11,        // 原 Recharts label fontSize={11}
    axisTickFontWeight: 600,      // 原 Recharts tick fontWeight={600}
    axisLabelFontWeight: 700,     // 原 Recharts label fontWeight={700}
    baselineLabelFontSize: 9,     // 原 Recharts baselineLabel fontSize={9}
    baselineLabelFontWeight: 600, // 原 Recharts baselineLabel fontWeight={600}

    // --- 动效 ---
    // 用户选择:开 cubicOut 400ms 入场 + 250ms 数据更新(原 Recharts 全程 isAnimationActive=false,
    // 这里是有意行为差异,首次加载曲线滑入,后续数据切换平滑过渡)。
    animationDuration: 400,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 250,
    animationEasingUpdate: 'cubicOut',

    // --- 渲染 ---
    renderer: 'canvas',           // 用户明确:Canvas only,弃用 SVG
} as const;

// ============================================================
// 自定义 ECharts symbol: 实验室 flask 图标
// ============================================================

/**
 * 原 Recharts 用 lucide-react `flask-conical` 图标,三段 path:
 *   1. 瓶身 + 瓶颈     "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"
 *   2. 瓶口横线        "M8.5 2h7"
 *   3. 瓶底刻度线      "M7 16h10"
 *
 * ECharts symbol 'path://' 支持多 path 的 SVG,
 * 我们保留 stroke="white" 让图标在彩色背景圆上可见。
 */
export const LAB_FLASK_PATH =
    'path://' +
    '<g stroke="white" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
    '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />' +
    '<path d="M8.5 2h7" />' +
    '<path d="M7 16h10" />' +
    '</g>';

// ============================================================
// Helpers
// ============================================================

/**
 * 把 hex 颜色转成带 alpha 的 hex(rgba alpha 用 hex 后缀,匹配原 Recharts `\`${color}1A\``)。
 *
 * 原 Recharts 用法:`fill={... `${aaColor}1A`}` → aaColor='#8b5cf6' + '1A' = '#8b5cf61A'(10% alpha)
 * ECharts 用 rgba 更稳:把 hex 转 rgb,再 `rgba(r, g, b, 0.1)`。
 */
export function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 等价于原 Recharts `\`${aaColor}1A\`` → 'rgba(139,92,246,0.1)'。
 * CPA band 默认 10% 透明度(2026-07-19 调到 25%:曲线渐变填充 + 95% CI 都用这个 base alpha)。
 */
export function aaBandFill(aaColor: string): string {
    return hexToRgba(aaColor, 0.25);
}

/**
 * 把 CSS var 解析成实际值。ECharts 不能直接用 'var(--xxx)',
 * 需要在 option 构建时调一次 getComputedStyle 拿到实值。
 *
 * 监听 .dark 切换 → 重新 setOption 即可跟随主题。
 */
export function resolveCssVar(name: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    return v || fallback;
}