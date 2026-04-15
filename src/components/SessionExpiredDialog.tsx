import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useTranslation } from '../contexts/LanguageContext';

const SessionExpiredDialog: React.FC = () => {
  const navigate = useNavigate();
  const { sessionExpiredNotice, clearSessionExpiredNotice } = useAuth();
  const { showDialog } = useDialog();
  const { t } = useTranslation();
  const handledNoticeIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!sessionExpiredNotice || handledNoticeIdRef.current === sessionExpiredNotice.id) {
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
      navigate('/login', { replace: true });
    };

    showSessionExpiredDialog();

    return () => {
      cancelled = true;
    };
  }, [clearSessionExpiredNotice, navigate, sessionExpiredNotice, showDialog, t]);

  return null;
};

export default SessionExpiredDialog;
