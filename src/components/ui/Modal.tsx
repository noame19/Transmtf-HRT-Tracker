import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Max width class, default 'max-w-lg' */
  maxWidth?: string;
  /** If true, uses full-height sheet on mobile */
  fullHeight?: boolean;
  /** Hide the default close button */
  hideClose?: boolean;
  /** Custom title ID for aria */
  titleId?: string;
}

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = 'max-w-lg',
  fullHeight = false,
  hideClose = false,
  titleId,
}) => {
  const dialogRef = useFocusTrap(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const id = titleId || 'modal-title';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center animate-in fade-in duration-200"
      style={{ background: 'var(--bg-overlay)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? id : undefined}
        className={`
          w-full ${maxWidth} md:mx-4
          bg-[var(--bg-card)] border border-[var(--border-primary)]
          rounded-t-3xl md:rounded-3xl
          shadow-[var(--shadow-lg)]
          flex flex-col
          ${fullHeight ? 'h-[92vh] md:max-h-[85vh]' : 'max-h-[90vh] md:max-h-[85vh]'}
          md:modal-spring modal-slide-up md:animate-none
          safe-area-pb
        `}
      >
        {/* Header */}
        {(title || !hideClose) && (
          <div className="flex items-center justify-between px-6 pt-5 pb-3 shrink-0">
            {title && (
              <h3
                id={id}
                className="text-lg font-bold text-[var(--text-primary)]"
              >
                {title}
              </h3>
            )}
            {!hideClose && (
              <button
                onClick={onClose}
                className="p-2 rounded-full bg-[var(--bg-card-hover)] hover:bg-[var(--border-primary)] transition ml-auto"
                aria-label="Close"
              >
                <X size={18} className="text-[var(--text-secondary)]" />
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-2 min-h-0">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 pb-5 pt-3 shrink-0 border-t border-[var(--border-secondary)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
