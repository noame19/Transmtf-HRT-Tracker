import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  /** ARIA label ID */
  labelledBy?: string;
}

const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled = false, label, labelledBy }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    aria-labelledby={labelledBy}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className={`
      relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent
      transition-colors duration-200 ease-in-out
      focus:outline-none focus:ring-2 focus:ring-offset-2
      ${checked
        ? 'bg-[var(--accent-500)] focus:ring-[var(--accent-300)]'
        : 'bg-gray-200 dark:bg-gray-600 focus:ring-gray-300 dark:focus:ring-gray-500'
      }
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    `}
  >
    <span
      className={`
        inline-block h-5 w-5 transform rounded-full bg-white shadow-sm
        transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]
        ${checked ? 'translate-x-5' : 'translate-x-0'}
      `}
    />
  </button>
);

export default Toggle;
