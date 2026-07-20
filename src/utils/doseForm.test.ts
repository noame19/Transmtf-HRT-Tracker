import { describe, it, expect } from 'vitest';
import { Ester, Route } from '../../types';
import {
    DEFAULT_DOSE_MAP,
    DOSE_GUIDE_CONFIG,
    LEVEL_BADGE_STYLES,
    LEVEL_CONTAINER_STYLES,
    formatGuideNumber,
    computeDoseGuide,
    getDefaultDoseFor,
    drugKeyOf,
} from './doseForm';

const isAa = (e: Ester) => e === Ester.CPA || e === Ester.BICA;

describe('DEFAULT_DOSE_MAP', () => {
    it('推荐值覆盖所有 E2 酯 + 抗雄 + 黄体酮 + 主要给药途径', () => {
        // 关键 (route, ester) 组合都有合理默认
        expect(DEFAULT_DOSE_MAP[`${Route.sublingual}:${Ester.E2}`]).toBe(2);
        expect(DEFAULT_DOSE_MAP[`${Route.sublingual}:${Ester.EV}`]).toBe(2);
        expect(DEFAULT_DOSE_MAP[`${Route.oral}:${Ester.E2}`]).toBe(4);
        expect(DEFAULT_DOSE_MAP[`${Route.oral}:${Ester.EV}`]).toBe(4);
        expect(DEFAULT_DOSE_MAP[`${Route.oral}:${Ester.CPA}`]).toBe(12.5);
        expect(DEFAULT_DOSE_MAP[`${Route.oral}:${Ester.BICA}`]).toBe(50);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.EV}`]).toBe(5);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.EB}`]).toBe(5);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.EU}`]).toBe(5);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.EC}`]).toBe(5);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.EN}`]).toBe(5);
        expect(DEFAULT_DOSE_MAP[`${Route.injection}:${Ester.PROG}`]).toBe(50);
        expect(DEFAULT_DOSE_MAP[`${Route.rectal}:${Ester.PROG}`]).toBe(100);
        expect(DEFAULT_DOSE_MAP[`${Route.patchApply}:${Ester.E2}`]).toBe(100);
        expect(DEFAULT_DOSE_MAP[`${Route.gel}:${Ester.E2}`]).toBe(3);
    });

    it('肌注 E2 酯默认值与 PlanEditModal 旧硬编码值保持一致（5 mg，避免破坏已有计划）', () => {
        // 回归保护：DEFAULT_DOSE_MAP 是 2026-07-20 新增，肌注默认值沿用旧硬编码 5
        for (const e of [Ester.EB, Ester.EV, Ester.EU, Ester.EC, Ester.EN]) {
            expect(DEFAULT_DOSE_MAP[`${Route.injection}:${e}`]).toBe(5);
        }
    });
});

describe('DOSE_GUIDE_CONFIG', () => {
    it('抗雄药物不在档位表里 — 避免 computeDoseGuide 返回错误档位', () => {
        // 抗雄的参考范围与 E2 体系不同，computeDoseGuide 走 isAntiandrogen 早退，
        // 所以 DOSE_GUIDE_CONFIG 本身不收录。
        expect(DOSE_GUIDE_CONFIG[`${Route.oral}:${Ester.CPA}`]).toBeUndefined();
        expect(DOSE_GUIDE_CONFIG[`${Route.oral}:${Ester.BICA}`]).toBeUndefined();
    });

    it('贴片条目带 requiresRate=true', () => {
        expect(DOSE_GUIDE_CONFIG[`${Route.patchApply}:${Ester.E2}`]?.requiresRate).toBe(true);
    });

    it('黄体酮走 mg_dose 单位（不分昼夜）', () => {
        expect(DOSE_GUIDE_CONFIG[`${Route.rectal}:${Ester.PROG}`]?.unitKey).toBe('mg_dose');
        expect(DOSE_GUIDE_CONFIG[`${Route.injection}:${Ester.PROG}`]?.unitKey).toBe('mg_dose');
    });

    it('所有阈值为 4 个数（low / medium / high / veryHigh）', () => {
        for (const cfg of Object.values(DOSE_GUIDE_CONFIG)) {
            if (cfg) expect(cfg.thresholds).toHaveLength(4);
        }
    });
});

describe('formatGuideNumber', () => {
    it('整数直显', () => {
        expect(formatGuideNumber(2)).toBe('2');
        expect(formatGuideNumber(50)).toBe('50');
        expect(formatGuideNumber(200)).toBe('200');
    });

    it('< 1 的小数保留 2 位', () => {
        expect(formatGuideNumber(1.5)).toBe('1.5');
        // 0.5 经过去尾零变成 '0.5'（剂量参考卡片不显示尾随零）
        expect(formatGuideNumber(0.5)).toBe('0.5');
    });

    it('≥ 1 的小数保留 1 位 + 去尾零', () => {
        expect(formatGuideNumber(12.5)).toBe('12.5');
        expect(formatGuideNumber(6.0)).toBe('6');
    });
});

describe('computeDoseGuide', () => {
    it('抗雄药物返回 null', () => {
        expect(computeDoseGuide(Route.oral, Ester.CPA, isAa, 'dose', '', '')).toBeNull();
        expect(computeDoseGuide(Route.oral, Ester.BICA, isAa, 'dose', '', '')).toBeNull();
    });

    it('(route, ester) 不在配置表里返回 null', () => {
        expect(computeDoseGuide(Route.oral, Ester.CPA, isAa, 'dose', '', '')).toBeNull();
    });

    it('空白剂量：level=null, value=null', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '');
        expect(result?.value).toBeNull();
        expect(result?.level).toBeNull();
        expect(result?.showRateHint).toBe(false);
        expect(result?.config.unitKey).toBe('mg_dose');
    });

    it('落在 low 档（value ≤ thresholds[0]）', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '50');
        expect(result?.level).toBe('low');
        expect(result?.value).toBe(50);
    });

    it('落在 medium 档（thresholds[0] < value ≤ thresholds[1]）', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '75');
        expect(result?.level).toBe('medium');
    });

    it('落在 high 档', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '120');
        expect(result?.level).toBe('high');
    });

    it('落在 very_high 档', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '180');
        expect(result?.level).toBe('very_high');
    });

    it('落在 above 档（value > thresholds[3]）', () => {
        const result = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '300');
        expect(result?.level).toBe('above');
    });

    it('贴片 dose 模式 + requiresRate → showRateHint=true, level=null', () => {
        const result = computeDoseGuide(Route.patchApply, Ester.E2, isAa, 'dose', '', '5');
        expect(result?.showRateHint).toBe(true);
        expect(result?.level).toBeNull();
        expect(result?.value).toBeNull();
        expect(result?.config.unitKey).toBe('ug_day');
    });

    it('贴片 rate 模式：按 releaseRate 计算 level', () => {
        const result = computeDoseGuide(Route.patchApply, Ester.E2, isAa, 'rate', '150', '');
        expect(result?.showRateHint).toBe(false);
        expect(result?.value).toBe(150);
        expect(result?.level).toBe('medium'); // 100 < 150 ≤ 200
    });

    it('非贴片：从 rawDose 取值', () => {
        const result = computeDoseGuide(Route.gel, Ester.E2, isAa, 'dose', '', '4');
        expect(result?.value).toBe(4);
        expect(result?.level).toBe('high'); // 3 < 4 ≤ 6
        expect(result?.config.unitKey).toBe('mg_day');
    });

    it('回归：EV 含服 2mg 时档位卡片显示 2 mg/天（不是 E2 当量 1.5）', () => {
        // bug 复现：旧实现用 e2Dose 取值，EV factor≈0.764 → 2 × 0.764 ≈ 1.53，
        // 档位卡片错误显示「1.5 mg/天」。修复后 computeDoseGuide 取 rawDose，
        // EV 2mg 直接得 value=2。
        const result = computeDoseGuide(Route.sublingual, Ester.EV, isAa, 'dose', '', '2');
        expect(result?.value).toBe(2);
        expect(result?.level).toBe('medium'); // 1 < 2 ≤ 2 → medium
        expect(result?.config.unitKey).toBe('mg_day');
    });

    it('回归：EV 肌注 5mg 走 mg/周 阈值（不显示成 E2 当量 3.8）', () => {
        const result = computeDoseGuide(Route.injection, Ester.EV, isAa, 'dose', '', '5');
        expect(result?.value).toBe(5);
        expect(result?.level).toBe('very_high'); // 4 < 5 ≤ 6
        expect(result?.config.unitKey).toBe('mg_week');
    });

    it('无效输入（非数字/空）→ value=null, level=null', () => {
        const r1 = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '');
        expect(r1?.value).toBeNull();
        expect(r1?.level).toBeNull();
        const r2 = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', 'abc');
        expect(r2?.value).toBeNull();
        const r3 = computeDoseGuide(Route.rectal, Ester.PROG, isAa, 'dose', '', '0');
        expect(r3?.value).toBeNull(); // 0 不算正数
    });
});

describe('getDefaultDoseFor', () => {
    it('per-drug memo 优先于 DEFAULT_DOSE_MAP', () => {
        expect(getDefaultDoseFor(Route.injection, Ester.EV, { rawDose: '7' })).toBe('7');
    });

    it('memo.rawDose 为空字符串时回退到 DEFAULT_DOSE_MAP', () => {
        expect(getDefaultDoseFor(Route.oral, Ester.CPA, { rawDose: '' })).toBe('12.5');
    });

    it('memo.rawDose 非数字字符串时回退到 DEFAULT_DOSE_MAP', () => {
        expect(getDefaultDoseFor(Route.oral, Ester.CPA, { rawDose: 'abc' })).toBe('12.5');
    });

    it('未传 memo 时按 DEFAULT_DOSE_MAP', () => {
        expect(getDefaultDoseFor(Route.rectal, Ester.PROG)).toBe('100');
        expect(getDefaultDoseFor(Route.injection, Ester.PROG)).toBe('50');
        expect(getDefaultDoseFor(Route.oral, Ester.BICA)).toBe('50');
    });

    it('(route, ester) 在任何表里都没有时返回空字符串', () => {
        // 构造一个永远不在 DEFAULT_DOSE_MAP 里的组合（不可能真出现，防御性测试）
        // patchApply:E2 在 DEFAULT_DOSE_MAP 有，所以换一个肯定不会有的
        // 选个未在表里的 (rectal, EV)
        expect(DEFAULT_DOSE_MAP[`${Route.rectal}:${Ester.EV}`]).toBeUndefined();
        expect(getDefaultDoseFor(Route.rectal, Ester.EV)).toBe('');
    });

    it('memo 包含 rawDose 数值时返回 memo（先 trim 再判断）', () => {
        // 实现先 trim 然后判断 parseFloat 是否 finite；'  4.5  ' trim 后是 '4.5'，返回 trim 后的值。
        expect(getDefaultDoseFor(Route.injection, Ester.EV, { rawDose: '  4.5  ' })).toBe('4.5');
    });
});

describe('drugKeyOf', () => {
    it('拼接 route + ester 形成稳定 key', () => {
        expect(drugKeyOf(Route.injection, Ester.EV)).toBe('injection:EV');
        expect(drugKeyOf(Route.rectal, Ester.PROG)).toBe('rectal:PROG');
    });
});

describe('LEVEL_*_STYLES 完整性', () => {
    it('LEVEL_BADGE_STYLES 覆盖 5 档', () => {
        expect(Object.keys(LEVEL_BADGE_STYLES).sort()).toEqual(
            ['above', 'high', 'low', 'medium', 'very_high'].sort(),
        );
    });

    it('LEVEL_CONTAINER_STYLES 覆盖 5 档 + neutral', () => {
        expect(Object.keys(LEVEL_CONTAINER_STYLES).sort()).toEqual(
            ['above', 'high', 'low', 'medium', 'neutral', 'very_high'].sort(),
        );
    });

    it('每个 LEVEL_*_STYLES 条目都引用 --bg-* / --text-* / --border-* token（与 ThemeContext 兼容）', () => {
        for (const cls of Object.values(LEVEL_BADGE_STYLES)) {
            expect(cls).toMatch(/var\(--bg-bold-/);
            expect(cls).toMatch(/var\(--text-bold-/);
        }
        for (const cls of Object.values(LEVEL_CONTAINER_STYLES)) {
            expect(cls).toMatch(/var\(--(bg|border)-soft-/);
        }
    });
});