import React, { createContext, useContext, useState, useCallback } from 'react';
import { useTranslation } from './LanguageContext';
import { useFocusTrap } from '../hooks/useFocusTrap';

type DialogType = 'alert' | 'confirm';

interface DialogOptions {
  confirmText?: string;
  cancelText?: string;
  thirdOption?: string;
}

interface DialogContextType {
  showDialog: (type: DialogType, message: string, options?: DialogOptions | (() => void)) => Promise<'confirm' | 'cancel' | 'third'>;
}

const DialogContext = createContext<DialogContextType | null>(null);

export const useDialog = () => {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
};

export const DialogProvider = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState<DialogType>('alert');
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<DialogOptions>({});
  const [resolver, setResolver] = useState<((value: 'confirm' | 'cancel' | 'third') => void) | null>(null);

  const showDialog = useCallback((
    type: DialogType,
    message: string,
    opts?: DialogOptions | (() => void)
  ): Promise<'confirm' | 'cancel' | 'third'> => {
    if (typeof opts === 'function') {
      const onConfirm = opts;
      setType(type);
      setMessage(message);
      setOptions({});
      setIsOpen(true);
      return new Promise((resolve) => {
        setResolver(() => (value: 'confirm' | 'cancel' | 'third') => {
          if (value === 'confirm') onConfirm();
          resolve(value);
        });
      });
    }

    setType(type);
    setMessage(message);
    setOptions(opts || {});
    setIsOpen(true);

    return new Promise((resolve) => {
      setResolver(() => resolve);
    });
  }, []);

  const handleChoice = (choice: 'confirm' | 'cancel' | 'third') => {
    if (resolver) resolver(choice);
    setIsOpen(false);
    setResolver(null);
  };

  const dialogRef = useFocusTrap(isOpen, () => handleChoice(type === 'alert' ? 'confirm' : 'cancel'));

  return (
    <DialogContext.Provider value={{ showDialog }}>
      {children}
      {isOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-[11000] p-5"
          style={{
            animation: 'dialogFadeIn 0.18s ease-out forwards',
            background: 'var(--bg-overlay)',
            backdropFilter: 'blur(16px) saturate(180%)',
            WebkitBackdropFilter: 'blur(16px) saturate(180%)',
          }}
        >
          <style>{`
            @keyframes dialogFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes dialogScaleIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
          `}</style>
          <div className="w-full max-w-sm" style={{ animation: 'dialogScaleIn 0.2s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
            <div
              ref={dialogRef}
              role={type === 'alert' ? 'alertdialog' : 'dialog'}
              aria-modal="true"
              aria-labelledby="dialog-title"
              aria-describedby="dialog-msg"
              className="glass-heavy glass-noise glass-highlight"
              style={{
                borderRadius: '24px',
                padding: '24px',
              }}
            >
              <h3 id="dialog-title" className="text-base font-bold mb-1.5" style={{ color: 'var(--text-primary)' }}>
                {type === 'confirm' ? t('dialog.confirm_title') : t('dialog.alert_title')}
              </h3>
              <p id="dialog-msg" className="mb-5 leading-relaxed text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</p>

              {type === 'alert' && (
                <button
                  onClick={() => handleChoice('confirm')}
                  className="btn-press-glass glass-btn-primary"
                  style={{
                    width: '100%',
                    padding: '13px',
                    borderRadius: '14px',
                    border: 'none',
                    color: 'white',
                    fontWeight: 700,
                    fontSize: '14px',
                    cursor: 'pointer',
                  }}
                >
                  {options.confirmText || t('btn.ok')}
                </button>
              )}

              {type === 'confirm' && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleChoice('cancel')}
                    className="btn-press-glass glass-btn"
                    style={{
                      flex: 1,
                      padding: '13px',
                      borderRadius: '14px',
                      border: 'none',
                      color: 'var(--text-primary)',
                      fontWeight: 600,
                      fontSize: '14px',
                      cursor: 'pointer',
                    }}
                  >
                    {options.cancelText || t('btn.cancel')}
                  </button>
                  <button
                    onClick={() => handleChoice('confirm')}
                    className="btn-press-glass glass-btn-primary"
                    style={{
                      flex: 1,
                      padding: '13px',
                      borderRadius: '14px',
                      border: 'none',
                      color: 'white',
                      fontWeight: 700,
                      fontSize: '14px',
                      cursor: 'pointer',
                    }}
                  >
                    {options.confirmText || t('btn.ok')}
                  </button>
                </div>
              )}

              {options.thirdOption && (
                <button
                  onClick={() => handleChoice('third')}
                  className="btn-press-glass glass-btn"
                  style={{
                    width: '100%',
                    marginTop: '8px',
                    padding: '13px',
                    borderRadius: '14px',
                    color: 'var(--text-secondary)',
                    fontWeight: 500,
                    fontSize: '14px',
                    cursor: 'pointer',
                  }}
                >
                  {options.thirdOption}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
};
