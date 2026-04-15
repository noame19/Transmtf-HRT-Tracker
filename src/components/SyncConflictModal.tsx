import React, { useState, useMemo } from 'react';
import { AlertTriangle, Monitor, Cloud, ChevronDown, ChevronUp, Check } from 'lucide-react';
import Modal from './ui/Modal';
import { useTranslation } from '../contexts/LanguageContext';

export interface FieldDiff {
  field: string;
  localValue: any;
  cloudValue: any;
}

export interface ConflictState {
  localData: Record<string, any>;
  cloudData: Record<string, any>;
  diffs: FieldDiff[];
  localTime: string;
  cloudTime: string;
}

interface SyncConflictModalProps {
  isOpen: boolean;
  conflict: ConflictState | null;
  onResolve: (resolution: 'local' | 'cloud' | 'merge', mergedData?: Record<string, any>) => void;
}

const FIELD_KEYS: Record<string, string> = {
  events: 'sync.conflict.field.events',
  weight: 'sync.conflict.field.weight',
  labResults: 'sync.conflict.field.labResults',
  lang: 'sync.conflict.field.lang',
  calibrationModel: 'sync.conflict.field.calibrationModel',
  themeColor: 'sync.conflict.field.theme',
  darkMode: 'sync.conflict.field.darkMode',
  applyE2LearningToCPA: 'sync.conflict.field.applyE2LearningToCPA',
  applyCPAInhibitionToE2: 'sync.conflict.field.applyCPAInhibitionToE2',
};

const LANG_NAMES: Record<string, string> = {
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
};

const CALIBRATION_NAMES: Record<string, string> = {
  ekf: 'EKF',
  'ou-kalman': 'OU-Kalman',
};

function formatFieldValue(field: string, value: any, t: (k: string) => string): string {
  if (value === undefined || value === null) return '—';

  switch (field) {
    case 'events':
      return Array.isArray(value)
        ? `${t('sync.conflict.field.events')} (${value.length} ${t('sync.conflict.items')})`
        : '—';
    case 'labResults':
      return Array.isArray(value)
        ? `${t('sync.conflict.field.labResults')} (${value.length} ${t('sync.conflict.items')})`
        : '—';
    case 'weight':
      return `${value} kg`;
    case 'lang':
      return LANG_NAMES[value] || value;
    case 'calibrationModel':
      return CALIBRATION_NAMES[value] || value;
    case 'themeColor':
      return value;
    case 'darkMode':
    case 'applyE2LearningToCPA':
    case 'applyCPAInhibitionToE2':
      return value ? t('sync.conflict.on') : t('sync.conflict.off');
    default:
      return String(value);
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

const SyncConflictModal: React.FC<SyncConflictModalProps> = ({ isOpen, conflict, onResolve }) => {
  const { t } = useTranslation();
  const [showMerge, setShowMerge] = useState(false);
  // For each field in merge mode: 'local' | 'cloud'
  const [mergeChoices, setMergeChoices] = useState<Record<string, 'local' | 'cloud'>>({});

  // Initialize merge choices when conflict changes
  React.useEffect(() => {
    if (conflict) {
      const initial: Record<string, 'local' | 'cloud'> = {};
      conflict.diffs.forEach((d) => {
        // Default to the newer side
        const localNewer = new Date(conflict.localTime) > new Date(conflict.cloudTime);
        initial[d.field] = localNewer ? 'local' : 'cloud';
      });
      setMergeChoices(initial);
      setShowMerge(false);
    }
  }, [conflict]);

  const mergedData = useMemo(() => {
    if (!conflict) return {};
    const result: Record<string, any> = { ...conflict.cloudData };
    conflict.diffs.forEach((d) => {
      const choice = mergeChoices[d.field] || 'cloud';
      result[d.field] = choice === 'local' ? d.localValue : d.cloudValue;
    });
    // Also include non-conflicting fields from local
    Object.keys(conflict.localData).forEach((key) => {
      if (!(key in result) && key !== 'dataHash' && key !== 'lastModified' && key !== 'lastDataUpdated') {
        result[key] = conflict.localData[key];
      }
    });
    return result;
  }, [conflict, mergeChoices]);

  if (!conflict) return null;

  const handleMergeChoice = (field: string, choice: 'local' | 'cloud') => {
    setMergeChoices((prev) => ({ ...prev, [field]: choice }));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      title={t('sync.conflict.title')}
      maxWidth="max-w-xl"
      hideClose
    >
      <div className="space-y-4">
        {/* Warning banner */}
        <div
          className="flex items-start gap-3 p-3 rounded-xl"
          style={{
            background: 'color-mix(in srgb, var(--accent-50) 60%, transparent)',
            border: '1px solid var(--accent-200)',
          }}
        >
          <AlertTriangle size={20} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-500)' }} />
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {t('sync.conflict.desc')}
          </p>
        </div>

        {/* Time comparison */}
        <div className="grid grid-cols-2 gap-3">
          <div
            className="p-3 rounded-xl text-center"
            style={{
              background: 'color-mix(in srgb, #3b82f6 8%, var(--bg-card-hover))',
              border: '1px solid color-mix(in srgb, #3b82f6 20%, var(--border-secondary))',
            }}
          >
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <Monitor size={14} className="text-blue-500" />
              <span className="text-xs font-bold text-blue-500">{t('sync.conflict.local')}</span>
            </div>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {formatTime(conflict.localTime)}
            </span>
          </div>
          <div
            className="p-3 rounded-xl text-center"
            style={{
              background: 'color-mix(in srgb, #8b5cf6 8%, var(--bg-card-hover))',
              border: '1px solid color-mix(in srgb, #8b5cf6 20%, var(--border-secondary))',
            }}
          >
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <Cloud size={14} className="text-purple-500" />
              <span className="text-xs font-bold text-purple-500">{t('sync.conflict.cloud')}</span>
            </div>
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {formatTime(conflict.cloudTime)}
            </span>
          </div>
        </div>

        {/* Diff table */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid var(--border-primary)' }}
        >
          {/* Header */}
          <div
            className="grid grid-cols-[1fr_1fr_1fr] text-xs font-bold px-3 py-2"
            style={{
              background: 'var(--bg-card-hover)',
              color: 'var(--text-tertiary)',
              borderBottom: '1px solid var(--border-secondary)',
            }}
          >
            <span>{/* field name */}</span>
            <span className="text-center text-blue-500">{t('sync.conflict.local')}</span>
            <span className="text-center text-purple-500">{t('sync.conflict.cloud')}</span>
          </div>
          {/* Rows */}
          {conflict.diffs.map((diff, idx) => (
            <div
              key={diff.field}
              className="grid grid-cols-[1fr_1fr_1fr] text-xs px-3 py-2.5 items-center"
              style={{
                borderBottom:
                  idx < conflict.diffs.length - 1
                    ? '1px solid var(--border-secondary)'
                    : undefined,
              }}
            >
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t(FIELD_KEYS[diff.field] || diff.field)}
              </span>
              <span
                className="text-center px-2 py-1 rounded-lg truncate"
                style={{
                  background: 'color-mix(in srgb, #3b82f6 6%, transparent)',
                  color: 'var(--text-secondary)',
                }}
                title={formatFieldValue(diff.field, diff.localValue, t)}
              >
                {formatFieldValue(diff.field, diff.localValue, t)}
              </span>
              <span
                className="text-center px-2 py-1 rounded-lg truncate"
                style={{
                  background: 'color-mix(in srgb, #8b5cf6 6%, transparent)',
                  color: 'var(--text-secondary)',
                }}
                title={formatFieldValue(diff.field, diff.cloudValue, t)}
              >
                {formatFieldValue(diff.field, diff.cloudValue, t)}
              </span>
            </div>
          ))}
        </div>

        {/* Quick action buttons */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onResolve('local')}
            className="btn-press py-3 px-4 rounded-xl font-bold text-sm transition-all"
            style={{
              background: 'color-mix(in srgb, #3b82f6 10%, var(--bg-card-hover))',
              border: '1px solid color-mix(in srgb, #3b82f6 30%, var(--border-primary))',
              color: '#3b82f6',
            }}
          >
            <Monitor size={16} className="inline mr-1.5 -mt-0.5" />
            {t('sync.conflict.use_local')}
          </button>
          <button
            onClick={() => onResolve('cloud')}
            className="btn-press py-3 px-4 rounded-xl font-bold text-sm transition-all"
            style={{
              background: 'color-mix(in srgb, #8b5cf6 10%, var(--bg-card-hover))',
              border: '1px solid color-mix(in srgb, #8b5cf6 30%, var(--border-primary))',
              color: '#8b5cf6',
            }}
          >
            <Cloud size={16} className="inline mr-1.5 -mt-0.5" />
            {t('sync.conflict.use_cloud')}
          </button>
        </div>

        {/* Manual merge toggle */}
        <button
          onClick={() => setShowMerge(!showMerge)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{
            background: 'var(--bg-card-hover)',
            border: '1px solid var(--border-primary)',
            color: 'var(--text-secondary)',
          }}
        >
          {showMerge ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {t('sync.conflict.manual_merge')}
        </button>

        {/* Manual merge panel */}
        {showMerge && (
          <div
            className="rounded-xl p-4 space-y-3"
            style={{
              background: 'var(--bg-card-hover)',
              border: '1px solid var(--border-primary)',
            }}
          >
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('sync.conflict.merge_select')}
            </p>
            {conflict.diffs.map((diff) => (
              <div key={diff.field} className="space-y-2">
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {t(FIELD_KEYS[diff.field] || diff.field)}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {/* Local option */}
                  <button
                    onClick={() => handleMergeChoice(diff.field, 'local')}
                    className="relative p-2.5 rounded-xl text-xs text-left transition-all"
                    style={{
                      background:
                        mergeChoices[diff.field] === 'local'
                          ? 'color-mix(in srgb, #3b82f6 12%, var(--bg-card))'
                          : 'var(--bg-card)',
                      border:
                        mergeChoices[diff.field] === 'local'
                          ? '2px solid #3b82f6'
                          : '1px solid var(--border-secondary)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {mergeChoices[diff.field] === 'local' && (
                      <Check size={12} className="absolute top-1.5 right-1.5 text-blue-500" />
                    )}
                    <div className="text-[10px] font-bold text-blue-500 mb-1">
                      {t('sync.conflict.local')}
                    </div>
                    <div className="truncate">{formatFieldValue(diff.field, diff.localValue, t)}</div>
                  </button>
                  {/* Cloud option */}
                  <button
                    onClick={() => handleMergeChoice(diff.field, 'cloud')}
                    className="relative p-2.5 rounded-xl text-xs text-left transition-all"
                    style={{
                      background:
                        mergeChoices[diff.field] === 'cloud'
                          ? 'color-mix(in srgb, #8b5cf6 12%, var(--bg-card))'
                          : 'var(--bg-card)',
                      border:
                        mergeChoices[diff.field] === 'cloud'
                          ? '2px solid #8b5cf6'
                          : '1px solid var(--border-secondary)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {mergeChoices[diff.field] === 'cloud' && (
                      <Check size={12} className="absolute top-1.5 right-1.5 text-purple-500" />
                    )}
                    <div className="text-[10px] font-bold text-purple-500 mb-1">
                      {t('sync.conflict.cloud')}
                    </div>
                    <div className="truncate">{formatFieldValue(diff.field, diff.cloudValue, t)}</div>
                  </button>
                </div>
              </div>
            ))}

            {/* Confirm merge button */}
            <button
              onClick={() => onResolve('merge', mergedData)}
              className="btn-press w-full py-3 rounded-xl font-bold text-sm text-white transition-all"
              style={{
                background: 'linear-gradient(135deg, var(--accent-400) 0%, var(--accent-500) 100%)',
                boxShadow: '0 4px 14px color-mix(in srgb, var(--accent-500) 25%, transparent)',
              }}
            >
              {t('sync.conflict.confirm_merge')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default SyncConflictModal;
