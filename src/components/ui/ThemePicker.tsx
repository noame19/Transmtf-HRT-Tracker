import React from 'react';
import { Check } from 'lucide-react';
import { useTheme, THEME_PRESETS, THEME_COLOR_IDS, ThemeColorId } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

const ThemePicker: React.FC = () => {
  const { themeColor, setThemeColor } = useTheme();
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap gap-3">
      {THEME_COLOR_IDS.map((id: ThemeColorId) => {
        const preset = THEME_PRESETS[id];
        const isActive = themeColor === id;

        return (
          <button
            key={id}
            type="button"
            onClick={() => setThemeColor(id)}
            className="flex flex-col items-center gap-1.5 group"
            aria-label={t(`theme.${id}`)}
            aria-pressed={isActive}
          >
            <div
              className={`
                w-10 h-10 rounded-full flex items-center justify-center
                transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]
                ${isActive
                  ? 'ring-2 ring-offset-2 ring-offset-[var(--bg-card)] scale-110 shadow-md'
                  : 'hover:scale-105 shadow-sm'
                }
              `}
              style={{
                background: `linear-gradient(135deg, ${preset.colors[400]}, ${preset.colors[500]})`,
                ...(isActive ? { ringColor: preset.colors[400] } : {}),
                boxShadow: isActive
                  ? `0 0 0 2px var(--bg-card), 0 0 0 4px ${preset.colors[400]}, 0 6px 16px ${preset.colors[300]}60`
                  : undefined,
                filter: isActive ? `drop-shadow(0 0 6px ${preset.colors[400]}80)` : undefined,
              }}
            >
              {isActive && (
                <Check size={16} className="text-white" strokeWidth={3} />
              )}
            </div>
            <span
              className={`
                text-[10px] font-semibold transition-colors
                ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'}
              `}
            >
              {t(`theme.${id}`)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default ThemePicker;
