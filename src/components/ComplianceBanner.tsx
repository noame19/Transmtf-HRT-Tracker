import React, { useState } from 'react';
import { Pill, ChevronDown, ChevronUp, Check, X } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { ComplianceMismatch } from '../utils/planCompliance';
import { Ester, Route } from '../../types';

interface ComplianceBannerProps {
    /** Mismatches from `analyzePlanCompliance`. Empty = render nothing. */
    mismatches: ComplianceMismatch[];
    /** Optional callback fired when the user dismisses a single category. */
    onDismiss?: (category: string) => void;
}

const DISMISS_KEY_PREFIX = 'hrt-compliance-dismissed:';

function isDismissed(category: string): boolean {
    try {
        return localStorage.getItem(DISMISS_KEY_PREFIX + category) === '1';
    } catch {
        return false;
    }
}

function setDismissed(category: string): void {
    try {
        localStorage.setItem(DISMISS_KEY_PREFIX + category, '1');
    } catch {
        /* ignore — private mode / quota exceeded, banner stays */
    }
}

function describe(ester: Ester, route: Route, t: (k: string) => string): string {
    return `${t(`ester.${ester}`)} · ${t(`route.${route}`)}`;
}

/**
 * /history 顶部告警：用药记录与用药计划不一致时弹出。
 *
 * 视觉风格照 ReminderBanner 那一套：`mx-4 rounded-2xl p-4` 外壳 +
 * `var(--accent-50)` 浅底 + `var(--accent-200)` 边 + 警示图标。
 * 单击展开看见最近 4 条样本对比 + "推迟 1d/2d" 影响警告段 +
 * 忽略按钮（localStorage 记录，避免反复打扰）。
 */
const ComplianceBanner: React.FC<ComplianceBannerProps> = ({ mismatches, onDismiss }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    /** Bump after a local dismiss so the banner re-reads localStorage on next paint. */
    const [, setRefreshTick] = useState(0);

    const visible = mismatches.filter((x) => !isDismissed(x.category));
    if (visible.length === 0) return null;

    // Render the first mismatch prominently; "+N" suffix when more categories
    // share the banner. In practice ≤ 2 (estrogen + anti_androgen).
    const primary = visible[0];
    const moreCount = visible.length - 1;

    const planLabel = describe(primary.planSpec.ester, primary.planSpec.route, t);
    const historyLabel = primary.historyMain
        ? describe(primary.historyMain.ester, primary.historyMain.route, t)
        : (t('compliance.banner.detail_history_split') || '未达 75% 主流');

    const handleDismiss = (category: string) => {
        setDismissed(category);
        setRefreshTick((n) => n + 1);
        onDismiss?.(category);
    };

    return (
        <div
            className="mx-4 rounded-2xl p-4 flex flex-col gap-3"
            style={{
                background: 'var(--accent-50)',
                border: '1px solid var(--accent-200)',
            }}
            role="status"
            aria-live="polite"
        >
            {/* Header row — always visible. */}
            <div className="flex items-center gap-3">
                <Pill size={20} style={{ color: 'var(--accent-700, #92400e)' }} />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                        {t('compliance.banner.title') || '用药方式与计划不符'}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                        {(t('compliance.banner.compact') ||
                            '最近 {history} 与计划 {plan} 不一致，请核对修正用药计划。')
                            .replace('{history}', historyLabel)
                            .replace('{plan}', planLabel)}
                        {moreCount > 0 && (
                            <span style={{ color: 'var(--text-tertiary)' }}>{` +${moreCount}`}</span>
                        )}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setExpanded((e) => !e)}
                    aria-expanded={expanded}
                    aria-label={
                        expanded
                            ? (t('compliance.banner.collapse') || '折叠详情')
                            : (t('compliance.banner.expand') || '展开详情')
                    }
                    className="p-2 rounded-lg btn-press-glass"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                >
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
            </div>

            {/* Detail panel — only when expanded. */}
            {expanded && (
                <div
                    className="border-t pt-3 space-y-3"
                    style={{ borderColor: 'var(--border-secondary)' }}
                >
                    {/* Plan vs history summary */}
                    <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
                        <div className="flex items-center gap-2">
                            <span
                                className="font-bold shrink-0"
                                style={{ color: 'var(--text-tertiary)' }}
                            >
                                {t('compliance.banner.detail_plan') || '当前计划'}：
                            </span>
                            <span style={{ color: 'var(--text-primary)' }}>{planLabel}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span
                                className="font-bold shrink-0"
                                style={{ color: 'var(--text-tertiary)' }}
                            >
                                {t('compliance.banner.detail_history') || '最近 4 次用药'}：
                            </span>
                            <span style={{ color: 'var(--text-primary)' }}>{historyLabel}</span>
                        </div>
                    </div>

                    {/* Per-sample list (newest-first) */}
                    <div className="space-y-1">
                        {primary.samples.map((s, i) => (
                            <div
                                key={`${s.timeH}-${i}`}
                                className="flex items-center gap-2 text-xs"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                {s.matchesPlan ? (
                                    <Check size={13} style={{ color: 'rgb(21, 128, 61)' }} />
                                ) : (
                                    <X size={13} style={{ color: 'var(--text-tertiary)' }} />
                                )}
                                <span
                                    className="font-mono text-[11px] shrink-0"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    {s.dateKey}
                                </span>
                                <span className="truncate">{describe(s.ester, s.route, t)}</span>
                                <span
                                    className="ml-auto text-[10px] shrink-0"
                                    style={{
                                        color: s.matchesPlan
                                            ? 'rgb(21, 128, 61)'
                                            : 'var(--text-tertiary)',
                                    }}
                                >
                                    {s.matchesPlan
                                        ? (t('compliance.banner.detail_match') || '一致')
                                        : (t('compliance.banner.detail_mismatch') || '不一致')}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Warning paragraph — explains the auto-delay impact. Amber
                       * tone matches the alert palette and stays legible in
                       * both light/dark themes (rgba alpha). */}
                    <div
                        className="rounded-xl p-3 text-xs leading-relaxed"
                        style={{
                            background: 'rgba(254, 243, 199, 0.45)',
                            color: 'var(--text-primary)',
                            border: '1px solid rgba(245, 158, 11, 0.25)',
                        }}
                    >
                        {t('compliance.banner.delay_warning') ||
                            '用药方式与计划不一致，会影响通知的「推迟 1 天 / 2 天」功能 — 系统会基于与实际不符的计划预测下次用药时刻，可能造成提醒和真实用药的偏差。建议先核对计划（修改药物 / 给药方式），或忽略此提示。'}
                    </div>

                    {/* Dismiss button */}
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={() => handleDismiss(primary.category)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 h-9 rounded-xl text-xs font-bold btn-press-glass transition"
                            style={{
                                background: 'var(--bg-card)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-primary)',
                            }}
                        >
                            <X size={13} />
                            <span>{t('compliance.banner.dismiss') || '忽略'}</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ComplianceBanner;
