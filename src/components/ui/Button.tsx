import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  fullWidth?: boolean;
}

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs font-semibold rounded-lg gap-1.5',
  md: 'px-4 py-2.5 text-sm font-bold rounded-xl gap-2',
  lg: 'px-5 py-3.5 text-base font-bold rounded-xl gap-2.5',
};

const variantStyles: Record<Variant, { base: string; hover: string }> = {
  primary: {
    base: 'accent-bg-gradient text-white shadow-sm',
    hover: 'hover:brightness-110 hover:shadow-md',
  },
  secondary: {
    base: 'bg-[var(--bg-card-hover)] text-[var(--text-primary)] border border-[var(--border-primary)]',
    hover: 'hover:bg-[var(--border-primary)]',
  },
  ghost: {
    base: 'text-[var(--text-secondary)] bg-transparent',
    hover: 'hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]',
  },
  danger: {
    base: 'bg-red-500 text-white shadow-sm',
    hover: 'hover:bg-red-600 hover:shadow-md',
  },
  outline: {
    base: 'bg-transparent border-2 text-[var(--text-primary)]',
    hover: 'hover:bg-[var(--bg-card-hover)]',
  },
};

const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  fullWidth = false,
  children,
  disabled,
  className = '',
  ...rest
}) => {
  const vs = variantStyles[variant];
  const isDisabled = disabled || loading;

  return (
    <button
      className={[
        'inline-flex items-center justify-center btn-press transition-all duration-150',
        sizeClasses[size],
        vs.base,
        !isDisabled ? vs.hover : '',
        fullWidth ? 'w-full' : '',
        isDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
        variant === 'outline' ? 'accent-border' : '',
        className,
      ].filter(Boolean).join(' ')}
      disabled={isDisabled}
      {...rest}
    >
      {loading ? (
        <span className="accent-spinner" />
      ) : icon ? (
        <span className="flex-shrink-0">{icon}</span>
      ) : null}
      {children && <span>{children}</span>}
      {iconRight && !loading && <span className="flex-shrink-0">{iconRight}</span>}
    </button>
  );
};

export default Button;
