import React, { useRef, useState, useEffect, useCallback } from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
}

const TabBar: React.FC<TabBarProps> = ({ tabs, activeId, onChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  const updateIndicator = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeIndex = tabs.findIndex(t => t.id === activeId);
    if (activeIndex < 0) return;
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-tab]');
    const btn = buttons[activeIndex];
    if (!btn) return;
    const containerRect = container.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    setIndicatorStyle({
      left: btnRect.left - containerRect.left,
      width: btnRect.width,
    });
  }, [tabs, activeId]);

  useEffect(() => {
    updateIndicator();
    window.addEventListener('resize', updateIndicator);
    return () => window.removeEventListener('resize', updateIndicator);
  }, [updateIndicator]);

  return (
    <div
      ref={containerRef}
      className="relative flex p-1 rounded-xl glass-subtle border border-[var(--glass-border)]"
    >
      {/* Sliding indicator */}
      <div
        className="absolute top-1 bottom-1 rounded-lg glass transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          boxShadow: `inset 0 0 0 1px rgba(var(--accent-rgb),0.15), 0 2px 8px rgba(var(--accent-rgb),0.10)`,
        }}
      />

      {tabs.map(tab => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            data-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className={`
              relative z-10 flex-1 py-2 text-sm font-bold rounded-lg
              flex items-center justify-center gap-2
              transition-colors duration-200
              ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}
            `}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export default TabBar;
