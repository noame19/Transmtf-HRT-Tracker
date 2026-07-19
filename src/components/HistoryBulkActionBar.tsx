import React from 'react';
import { CheckCheck, BetweenHorizontalEnd, RotateCcw, Trash2 } from 'lucide-react';

export type RangeButtonState = 'idle' | 'pickingEnd';

interface HistoryBulkActionBarProps {
    visible: boolean;
    selectedCount: number;
    rangeButtonState: RangeButtonState;
    onSelectAll: () => void;
    onArmRange: () => void;
    onCancel: () => void;
    onDelete: () => void;
}

const HistoryBulkActionBar: React.FC<HistoryBulkActionBarProps> = ({
    visible,
    selectedCount,
    rangeButtonState,
    onSelectAll,
    onArmRange,
    onCancel,
    onDelete,
}) => {
    if (!visible) return null;
    // Deletion is only allowed when no range anchor is pending AND the user
    // has actually picked at least one item — otherwise the destructive
    // primary button is misleading.
    const canDelete = rangeButtonState === 'idle' && selectedCount > 0;
    // 区间按钮:有 anchor + 已选 ≥ 2 时高亮可点,只选了 1 条时灰着提示用户再选一条。
    const canArmRange = rangeButtonState === 'pickingEnd' && selectedCount >= 2;

    return (
        <div
            className="fixed right-3 bottom-24 z-50 flex flex-col gap-2 md:right-6 md:bottom-6"
            aria-label="批量操作工具栏"
            data-testid="bulk-action-bar"
        >
            <ToolbarBtn
                icon={<BetweenHorizontalEnd size={20} />}
                label="区间选择"
                onClick={onArmRange}
                active={canArmRange}
                pulsing={canArmRange}
                disabled={!canArmRange}
                testId="btn-range"
            />
            <ToolbarBtn
                icon={<CheckCheck size={20} />}
                label="全选"
                onClick={onSelectAll}
                testId="btn-select-all"
            />
            <ToolbarBtn
                icon={<Trash2 size={20} />}
                label={selectedCount > 0 ? `删除 (${selectedCount})` : '删除'}
                onClick={onDelete}
                disabled={!canDelete}
                danger
                testId="btn-delete"
            />
            <ToolbarBtn
                icon={<RotateCcw size={20} />}
                label="取消"
                onClick={onCancel}
                testId="btn-cancel"
            />
        </div>
    );
};

const ToolbarBtn: React.FC<{
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    active?: boolean;
    pulsing?: boolean;
    disabled?: boolean;
    danger?: boolean;
    testId?: string;
}> = ({ icon, label, onClick, active, pulsing, disabled, danger, testId }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        data-testid={testId}
        className={`w-14 h-14 rounded-2xl flex items-center justify-center btn-press-glass transition ${pulsing ? 'animate-pulse' : ''}`}
        style={{
            background: 'var(--bg-card)',
            color: disabled
                ? 'var(--text-tertiary)'
                : danger
                ? '#dc2626'
                : active
                ? 'var(--accent-500)'
                : 'var(--text-secondary)',
            boxShadow: 'var(--shadow-md)',
            border: `1px solid ${active ? 'var(--accent-500)' : 'var(--border-primary)'}`,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
        }}
    >
        {icon}
    </button>
);

export default HistoryBulkActionBar;
