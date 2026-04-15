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
    ? 'glass glass-noise glass-highlight rounded-2xl'
    : 'glass-card glass-highlight rounded-2xl transition-all duration-200';

  const hoverClass = hover
    ? 'card-lift-glass cursor-pointer'
    : '';

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      className={`${base} ${paddingMap[padding]} ${hoverClass} ${className}`}
      onClick={onClick}
      {...(onClick ? { type: 'button' as const } : {})}
    >
      {children}
    </Tag>
  );
};

export default Card;
