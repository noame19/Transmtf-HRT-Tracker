// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';

// vitest 3 + @testing-library/react 16 默认未自动 cleanup,显式注册
afterEach(() => cleanup());

// 由于 ThemeContext / LanguageContext 自身未 export,测试里直接 mock 两个 hook。
// 这样组件内部 `import { useTheme } from '../contexts/ThemeContext'` 时,
// 拿到的就是我们的可控实现,避免把 provider 树硬塞进每个 case。
vi.mock('../contexts/ThemeContext', () => ({
    useTheme: () => ({
        isDark: false,
        colors: {
            50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af',
            400: '#fb7185', 500: '#F1405D', 600: '#e11d48',
        },
    }),
}));

vi.mock('../contexts/LanguageContext', () => ({
    useTranslation: () => ({
        t: (k: string) => {
            if (k === 'reminder.confirm.aria_pending_suffix') return '，再点一次确认';
            return k;
        },
    }),
}));

import { ConfirmButton } from './ConfirmButton';

describe('ConfirmButton', () => {
    it('默认态:背景透明、1px 描边', () => {
        render(<ConfirmButton label="已服用" onClick={() => {}} />);
        const btn = screen.getByRole('button', { name: '已服用' });
        expect(btn.style.background).toBe('transparent');
        expect(btn.style.borderColor).not.toBe('transparent');
    });

    it('等待确认态(pending=true):背景主题色、无描边', () => {
        render(<ConfirmButton label="已服用" onClick={() => {}} pending />);
        // pending 时 aria-label 是 "已服用，再点一次确认",用正则部分匹配
        const btn = screen.getByRole('button', { name: /已服用/ });
        expect(btn.style.background).not.toBe('transparent');
        expect(btn.style.borderColor).toBe('transparent');
    });

    it('点击触发 onClick', () => {
        const onClick = vi.fn();
        render(<ConfirmButton label="已服用" onClick={onClick} />);
        fireEvent.click(screen.getByRole('button', { name: '已服用' }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('等待态时 aria-label 包含"再点一次确认"', () => {
        render(<ConfirmButton label="已服用" onClick={() => {}} pending />);
        const btn = screen.getByRole('button');
        expect(btn.getAttribute('aria-label')).toContain('再点一次确认');
    });

    it('默认态时 aria-label 就是 label 本身', () => {
        render(<ConfirmButton label="已服用" onClick={() => {}} />);
        const btn = screen.getByRole('button');
        expect(btn.getAttribute('aria-label')).toBe('已服用');
    });
});