import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useFocusTrap } from '../hooks/useFocusTrap';

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

const BasicInfoModal: React.FC<BasicInfoModalProps> = ({ isOpen, initial, onClose, onSave }) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<BasicInfo>(initial);

    // 打开时重新载入,防止打开时外部更新了 localStorage 但 draft 还是旧的
    useEffect(() => {
        if (isOpen) setDraft(initial);
    }, [isOpen, initial]);

    const dialogRef = useFocusTrap(isOpen, onClose);

    if (!isOpen) return null;

    const thisMonth = currentYearMonth();
    const thisDay = currentDay();
    // 出生年下限 1900-01
    const minMonth = '1900-01';

    const handleSave = () => {
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

                        {/* 身高 */}
                        <div>
                            <label className="block text-sm font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                {t('settings.basic.height')}
                            </label>
                            <input
                                type="number"
                                inputMode="decimal"
                                min={50}
                                max={250}
                                step="0.1"
                                placeholder="—"
                                value={draft.heightCm ?? ''}
                                onChange={(e) => {
                                    const raw = e.target.value;
                                    if (raw === '') {
                                        setDraft({ ...draft, heightCm: null });
                                        return;
                                    }
                                    const n = Number(raw);
                                    setDraft({ ...draft, heightCm: Number.isFinite(n) ? n : draft.heightCm });
                                }}
                                className="w-full px-4 py-3 rounded-xl outline-none focus:ring-2 focus:ring-pink-300 text-sm"
                                style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                            />
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