import React from 'react';

type BadgeVariant = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}

const variantClasses: Record<BadgeVariant, string> = {
  // accent uses the rose semantic tokens (bg-soft/border-soft/text-icon)
  // which have correct dark overrides in index.html — the raw --accent-*
  // palette has no .dark block, so it would stay bright in dark mode.
  accent: 'bg-[var(--bg-soft-rose)] text-[var(--text-icon-rose)] border-[var(--border-soft-rose)]',
  // Light/dark variants are driven by the alert-* CSS variables in
  // index.html (:root + .dark). This keeps the dark palette under app
  // toggle control, not the OS `prefers-color-scheme` media query.
  info: 'bg-[var(--alert-bg-info)] text-[var(--alert-text-info)] border-[var(--alert-border-info)]',
  success: 'bg-[var(--alert-bg-success)] text-[var(--alert-text-success)] border-[var(--alert-border-success)]',
  warning: 'bg-[var(--alert-bg-warning)] text-[var(--alert-text-warning)] border-[var(--alert-border-warning)]',
  danger: 'bg-[var(--alert-bg-danger)] text-[var(--alert-text-danger)] border-[var(--alert-border-danger)]',
  neutral: 'bg-[var(--alert-bg-neutral)] text-[var(--alert-text-neutral)] border-[var(--alert-border-neutral)]',
};

const Badge: React.FC<BadgeProps> = ({
  variant = 'accent',
  children,
  className = '',
  icon,
}) => (
  <span
    className={`
      inline-flex items-center gap-1 px-2.5 py-1 rounded-full
      text-[10px] md:text-[11px] font-bold border backdrop-blur-sm
      ${variantClasses[variant]}
      ${className}
    `}
  >
    {icon && <span className="flex-shrink-0">{icon}</span>}
    {children}
  </span>
);

export default Badge;
