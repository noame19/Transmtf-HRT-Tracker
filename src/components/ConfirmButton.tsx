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
    const { colors } = useTheme();
    const { t } = useTranslation();
    // LanguageContext 的 t 仅接受 key,fallback 在调用方做(支持多语言覆盖)
    const pendingSuffix = t('reminder.confirm.aria_pending_suffix') || '，再点一次确认';
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
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor,
                fontSize: '14px',
            }}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
};

export default ConfirmButton;