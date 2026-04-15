import React from 'react';

type BadgeVariant = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}

const variantClasses: Record<BadgeVariant, string> = {
  accent: 'bg-[var(--accent-50)] text-[var(--accent-600)] border-[var(--accent-200)]',
  info: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700',
  warning: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  danger: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
  neutral: 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600',
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
