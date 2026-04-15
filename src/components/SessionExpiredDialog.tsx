import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from '../contexts/LanguageContext';

const EXEMPT_PATHS = new Set(['/auth/oidc/callback']);

const SessionExpiredDialog: React.FC = () => {
  const location = useLocation();
  const { isAuthenticated, sessionExpiredNotice, clearSessionExpiredNotice } = useAuth();
  const { showDialog } = useDialog();
  const { t } = useTranslation();
  const handledNoticeIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      !sessionExpiredNotice ||
      isAuthenticated ||
      EXEMPT_PATHS.has(location.pathname) ||
      handledNoticeIdRef.current === sessionExpiredNotice.id
    ) {
      return;
    }

    handledNoticeIdRef.current = sessionExpiredNotice.id;
    let cancelled = false;

    const showSessionExpiredDialog = async () => {
      await showDialog(
        'alert',
        t('auth.sessionExpiredMessage') || '您的登录状态失效,为保证数据同步,建议您立即重新登陆',
        {
          confirmText: t('auth.reloginNow') || '立即重新登录',
        }
      );

      if (cancelled) {
        return;
      }

      clearSessionExpiredNotice();
    };

    showSessionExpiredDialog();

    return () => {
      cancelled = true;
    };
  }, [clearSessionExpiredNotice, isAuthenticated, location.pathname, sessionExpiredNotice, showDialog, t]);

  return null;
};

export default SessionExpiredDialog;
