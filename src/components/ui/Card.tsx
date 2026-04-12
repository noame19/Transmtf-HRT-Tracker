import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  glass?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

const paddingMap = {
  none: '',
  sm: 'p-3',
  md: 'p-4 md:p-5',
  lg: 'p-5 md:p-6',
};

const Card: React.FC<CardProps> = ({
  children,
  className = '',
  hover = false,
  glass = false,
  padding = 'md',
  onClick,
}) => {
  const base = glass
    ? 'glass rounded-2xl'
    : 'rounded-2xl border transition-all duration-200';

  const colors = glass
    ? ''
    : 'bg-[var(--bg-card)] border-[var(--border-primary)]';

  const shadow = 'shadow-[var(--shadow-sm)]';

  const hoverClass = hover
    ? 'card-lift cursor-pointer hover:shadow-[var(--shadow-md)]'
    : '';

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      className={`${base} ${colors} ${shadow} ${paddingMap[padding]} ${hoverClass} ${className}`}
      onClick={onClick}
      {...(onClick ? { type: 'button' as const } : {})}
    >
      {children}
    </Tag>
  );
};

export default Card;
