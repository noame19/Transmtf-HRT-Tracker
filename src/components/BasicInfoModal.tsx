import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { DoseEvent } from '../../types';
import { isPatchRemove } from '../utils/patch';
import { findLatestWeight, findLatestHeight } from '../utils/weight';

/**
 * 健康/身份相关的可选基本信息。
 *
 * 字段全部可选——用户可以选择完全留空使用 app，不强制披露。
 * 持久化：单 JSON 写入 localStorage 键 `hrt-basic-info`，避免在
 * localStorage 里散落多个 hrt-* 字段。读不到 / 解析失败视为空对象。
 */
export interface BasicInfo {
    /** 'MtF' | 'Non-binary' | null */
    route: 'MtF' | 'Non-binary' | null;
    /** YYYY-MM, 例如 '1998-05' */
    birth: string | null;
    /** 厘米, 50-250 之间 */
    heightCm: number | null;
    /** 自由文本, 多行 */
    allergies: string;
    /** YYYY-MM-DD, 例如 '2024-03-15' */
    hrtStart: string | null;
}

export const EMPTY_BASIC_INFO: BasicInfo = {
    route: null,
    birth: null,
    heightCm: null,
    allergies: '',
    hrtStart: null,
};

const BASIC_INFO_KEY = 'hrt-basic-info';

/** 从 localStorage 安全读取;读不到 / 解析失败 / 字段缺失时返回空对象。 */
export function loadBasicInfo(): BasicInfo {
    try {
        const raw = localStorage.getItem(BASIC_INFO_KEY);
        if (!raw) return { ...EMPTY_BASIC_INFO };
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return { ...EMPTY_BASIC_INFO };
        return {
            route: obj.route === 'MtF' || obj.route === 'Non-binary' ? obj.route : null,
            birth: typeof obj.birth === 'string' && /^\d{4}-\d{2}$/.test(obj.birth) ? obj.birth : null,
            heightCm: typeof obj.heightCm === 'number' && obj.heightCm >= 50 && obj.heightCm <= 250 ? obj.heightCm : null,
            allergies: typeof obj.allergies === 'string' ? obj.allergies : '',
            hrtStart: typeof obj.hrtStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.hrtStart) ? obj.hrtStart : null,
        };
    } catch {
        return { ...EMPTY_BASIC_INFO };
    }
}

export function saveBasicInfo(info: BasicInfo): void {
    localStorage.setItem(BASIC_INFO_KEY, JSON.stringify(info));
}

interface BasicInfoModalProps {
    isOpen: boolean;
    initial: BasicInfo;
    onClose: () => void;
    onSave: (next: BasicInfo) => void;
    /** 用户从未填过 HRT 开始日期时的缺省值(YYYY-MM-DD)。
     *  当 initial.hrtStart 为 null 且 defaultHrtStart 不为 null 时,
     *  弹窗的 HRT 字段会预填这个值,用户可以直接确认或改写。
     *  Save 时才写回 localStorage,所以"用户清空"或"保持默认"都会被尊重。 */
    defaultHrtStart?: string | null;
    /** 保存校验需要「最新用药日期」做参照,所以调用方必须传。
     *  设计为必传,避免校验漏跑;SettingsPage 已从 useAppData 拿 events。 */
    events: DoseEvent[];
}

/** 当前月的 YYYY-MM, 给 <input type="month"> 的 max 属性用。 */
function currentYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 今天的 YYYY-MM-DD, 给 <input type="date"> 的 max 属性用。 */
function currentDay(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从用药记录里挑出最早的真实用药日期(YYYY-MM-DD 字符串)。
 *  - 跳过 patch remove 事件,apply↔remove 配对算 1 次
 *  - 没有事件时返回 null
 *
 *  BasicInfoModal 用它做"用户从没填过 HRT 开始日期"时的缺省值预填
 *  (用户在弹窗里看到的最早用药日期,确认或改写都行)。导出给 SettingsPage
 *  调用方避免重复实现。 */
export function earliestEventHrtDate(events: DoseEvent[]): string | null {
    const adminEvents = events.filter((e) => !isPatchRemove(e));
    if (adminEvents.length === 0) return null;
    const earliestMs = adminEvents.reduce(
        (min, e) => Math.min(min, e.timeH * 3600000),
        Infinity,
    );
    if (!Number.isFinite(earliestMs)) return null;
    const d = new Date(earliestMs);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 最新一次真实用药日期(YYYY-MM-DD 字符串)。与 earliestEventHrtDate 对称,
 *  仅用于 BasicInfoModal 保存校验:「HRT 开始日期不能晚于用药日期」里的
 *  「用药日期」取最新一次——如果你今天已经用了药,就不可能是「HRT 才开始」
 *  的那天。最早一次用药的对比没意义(用户可能补录旧记录)。 */
export function latestEventHrtDate(events: DoseEvent[]): string | null {
    const adminEvents = events.filter((e) => !isPatchRemove(e));
    if (adminEvents.length === 0) return null;
    const latestMs = adminEvents.reduce(
        (max, e) => Math.max(max, e.timeH * 3600000),
        -Infinity,
    );
    if (!Number.isFinite(latestMs)) return null;
    const d = new Date(latestMs);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** BasicInfoModal 保存校验结果。每条错误带 i18n key + 英文 fallback + 占位符参数。
 *  调用方拿到后用 `t(key, fallback)` 翻译,然后 .replaceAll('{k}', v) 把具体数值
 *  填进文案（例如把 `{hrtStart}` 换成 `'2026-08-15'`），让用户看到「xx 晚于 xx」
 *  的精确值。导出独立函数方便单元测试。 */
export interface BasicInfoValidationError {
    i18nKey: string;
    fallback: string;
    params?: Record<string, string>;
}

/** 基础信息保存校验。返回错误数组(可能为空)。
 *
 *  校验规则(每个都不应违反自然事实):
 *  - 出生年月 ≤ 今天
 *  - HRT 开始日期 ≤ 今天
 *  - HRT 开始日期 ≥ 出生年月(补 -01 当月开始)
 *  - HRT 开始日期 ≤ 最新用药日期(用户决定;若最新用药早于 HRT 启动,逻辑不通)
 *
 *  身高 50-250 由 `<input min/max>` 在 UI 层兜底,不在这里重复校验
 *  (用户已确认沿用现有范围,JS 层只补"日期逻辑不一致"这种 cross-field 校验)。 */
export function validateBasicInfo(
    draft: BasicInfo,
    events: DoseEvent[],
    today: { month: string; day: string },
): BasicInfoValidationError[] {
    const errors: BasicInfoValidationError[] = [];

    // 出生年月 ≤ 今天(YYYY-MM 字符串可直接字典序比较,zero-padded 等长)
    if (draft.birth && draft.birth > today.month) {
        errors.push({
            i18nKey: 'settings.basic.error.birth_future',
            fallback: '出生年月 {birth} 晚于 今天 {today}',
            params: { birth: draft.birth, today: today.day },
        });
    }

    // HRT 开始日期:三条 cross-field 校验,任意一条违例即阻断保存
    if (draft.hrtStart) {
        if (draft.hrtStart > today.day) {
            errors.push({
                i18nKey: 'settings.basic.error.hrt_future',
                fallback: 'HRT 开始日期 {hrtStart} 晚于 今天 {today}',
                params: { hrtStart: draft.hrtStart, today: today.day },
            });
        }
        if (draft.birth && draft.hrtStart < draft.birth + '-01') {
            errors.push({
                i18nKey: 'settings.basic.error.hrt_before_birth',
                fallback: 'HRT 开始日期 {hrtStart} 早于 出生年月 {birth}',
                params: { hrtStart: draft.hrtStart, birth: draft.birth },
            });
        }
        const latestMed = latestEventHrtDate(events);
        if (latestMed && draft.hrtStart > latestMed) {
            errors.push({
                i18nKey: 'settings.basic.error.hrt_after_med',
                fallback: '现在的 HRT 开始日期 {hrtStart} 晚于 最新的用药记录日期 {latestMed}',
                params: { hrtStart: draft.hrtStart, latestMed },
            });
        }
    }

    return errors;
}

const BasicInfoModal: React.FC<BasicInfoModalProps> = ({
    isOpen,
    initial,
    onClose,
    onSave,
    defaultHrtStart,
    events,
}) => {
    const { t } = useTranslation();
    const { showDialog } = useDialog();
    // 打开时,把"用户从未填过 HRT 开始日期"的情况用最早用药日期预填。
    // 这里只是草稿状态,只有用户点 Save 才会写回 localStorage——
    // 取消 = 丢弃默认值,清空 = 写 null,保留 = 写默认值。三种都尊重用户。
    const initialDraft = React.useMemo<BasicInfo>(
        () => ({
            ...initial,
            hrtStart: initial.hrtStart ?? defaultHrtStart ?? null,
        }),
        [initial, defaultHrtStart],
    );
    const [draft, setDraft] = useState<BasicInfo>(initialDraft);

    // 打开时重新载入,防止打开时外部更新了 localStorage 但 draft 还是旧的
    useEffect(() => {
        if (isOpen) setDraft(initialDraft);
    }, [isOpen, initialDraft]);

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    const thisMonth = currentYearMonth();
    const thisDay = currentDay();
    // 出生年下限 1900-01
    const minMonth = '1900-01';

    // 只读显示身高/体重：取最新用药记录（timeH 最大，且 heightCm/weightKG > 0）。
    // 无记录 / 无有效值 → null → UI 渲染为 "——"。
    const displayHeightCm = findLatestHeight(events);
    const displayWeightKg = findLatestWeight(events);

    const handleSave = async () => {
        // JS 层做 cross-field 校验:出生年月、HRT 开始日期不能晚于今天,
        // 且 HRT 开始日期不能早于出生、不能晚于最新用药。
        // <input min/max> 的 HTML hint 用户可以绕过,所以这里再兜一道。
        const errors = validateBasicInfo(draft, events, { month: thisMonth, day: thisDay });
        if (errors.length > 0) {
            // 弹窗渲染:1/2/3/4 编号 + 具体数值,让用户一眼看到是哪两个量冲突。
            // params 占位符 ({hrtStart} / {birth} / {today} / {latestMed}) 替换成实际值。
            // 标题用独立 i18n 键「基础信息有误」,与 PlanEditModal.validatePlan 同款风格。
            const detailLines = errors.map((e, idx) => {
                const text = t(e.i18nKey, e.fallback);
                const replaced = e.params
                    ? Object.entries(e.params).reduce(
                        (acc, [k, v]) => acc.replaceAll(`{${k}}`, v),
                        text,
                    )
                    : text;
                return `${idx + 1}. ${replaced}`;
            });
            await showDialog(
                'alert',
                `${t('settings.basic.error_title', '基础信息有误，请逐条核对后重试')}\n\n${detailLines.join('\n')}`,
            );
            return;
        }
        onSave(draft);
        onClose();
    };

    return (
        <div
            className="fixed inset-0 flex items-center justify-center z-50 animate-in fade-in duration-200"
            style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="basic-info-modal-title"
                className="rounded-3xl w-full max-w-lg md:max-w-2xl p-6 md:p-8 flex flex-col max-h-[90vh] modal-spring-glass safe-area-pb glass-modal"
            >
                <div className="flex justify-between items-center mb-5 shrink-0">
                    <h3 id="basic-info-modal-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('settings.basic.title')}
                    </h3>
                    <button
                        onClick={onClose}
                        aria-label={t('btn.close')}
                        className="p-2 rounded-full transition"
                        style={{ background: 'var(--bg-card-hover)' }}
                    >
                        <X size={20} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0 pr-1">
                    <div className="space-y-5">
                        {/* 治疗路线:两个互斥 radio */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.route')}
                            </label>
                            <div className="flex gap-2">
                                {(['MtF', 'Non-binary'] as const).map((opt) => {
                                    const selected = draft.route === opt;
                                    return (
                                        <button
                                            key={opt}
                                            type="button"
                                            onClick={() => setDraft({ ...draft, route: selected ? null : opt })}
                                            aria-pressed={selected}
                                            className={`flex-1 py-3 rounded-xl text-sm font-bold transition btn-press-glass ${selected ? 'glass-btn-primary' : 'glass-btn'}`}
                                            style={selected ? { color: 'white' } : { color: 'var(--text-primary)' }}
                                        >
                                            {t(`settings.basic.route.${opt === 'MtF' ? 'MtF' : 'NB'}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 出生年月 */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.birth')}
                            </label>
                            <input
                                type="month"
                                min={minMonth}
                                max={thisMonth}
                                value={draft.birth ?? ''}
                                onChange={(e) => setDraft({ ...draft, birth: e.target.value || null })}
                                className="w-full px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-pink-300 text-sm"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                        </div>

                        {/* 身高 / 体重 — 2026-07-21 起改为只读显示。
                           数据取自最新用药记录（按 timeH 最大值，且 heightCm/weightKG > 0），
                           没有则显示「——」。源头迁移到 DoseFormModal 后用户不再手填。
                           BasicInfo.heightCm 字段保留在 type 上做向后兼容，但 UI 不再编辑。 */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.body_stats')}
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                                <div
                                    className="rounded-xl px-4 py-3"
                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}
                                >
                                    <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('field.height')}
                                    </div>
                                    <div className="text-sm font-bold font-mono mt-1" style={{ color: 'var(--text-primary)' }}>
                                        {displayHeightCm !== null ? `${displayHeightCm} cm` : '—'}
                                    </div>
                                </div>
                                <div
                                    className="rounded-xl px-4 py-3"
                                    style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)' }}
                                >
                                    <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('field.weight')}
                                    </div>
                                    <div className="text-sm font-bold font-mono mt-1" style={{ color: 'var(--text-primary)' }}>
                                        {displayWeightKg !== null ? `${displayWeightKg} kg` : '—'}
                                    </div>
                                </div>
                            </div>
                            <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                                {t('settings.basic.body_stats_hint')}
                            </p>
                        </div>

                        {/* HRT 开始日期:完整年月日,精度比「出生年月」更细 */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.hrt_start')}
                            </label>
                            <input
                                type="date"
                                min="1900-01-01"
                                max={thisDay}
                                value={draft.hrtStart ?? ''}
                                onChange={(e) => setDraft({ ...draft, hrtStart: e.target.value || null })}
                                className="w-full px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-pink-300 text-sm"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                        </div>

                        {/* 禁忌/药物过敏:多行文本 */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.allergies')}
                            </label>
                            <textarea
                                rows={3}
                                maxLength={500}
                                value={draft.allergies}
                                onChange={(e) => setDraft({ ...draft, allergies: e.target.value })}
                                className="w-full px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-pink-300 text-sm"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
                        </div>
                    </div>
                </div>

                {/* 底部按钮 */}
                <div className="flex gap-2 mt-6 shrink-0">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 rounded-xl font-bold text-sm btn-press-glass glass-btn"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {t('btn.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex-1 py-3 rounded-xl font-bold text-sm text-white btn-press-glass glass-btn-primary"
                    >
                        {t('btn.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BasicInfoModal;