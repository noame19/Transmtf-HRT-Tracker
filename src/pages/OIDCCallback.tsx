import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import apiClient from '../api/client';
import { Loader2 } from 'lucide-react';

const OIDCCallback: React.FC = () => {
  const navigate = useNavigate();
  const { loginWithTokens, accessToken, isLoading } = useAuth();
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const hasRunRef = useRef(false);

  useEffect(() => {
    // Wait for auth state hydration before proceeding (critical for bind flow)
    if (isLoading) return;
    // Prevent double execution (React StrictMode / state change re-runs)
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    const handleCallback = async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');

      // Read sessionStorage immediately, then clear in all paths
      const savedState = sessionStorage.getItem('oidc_state');
      const action = sessionStorage.getItem('oidc_action');
      sessionStorage.removeItem('oidc_state');
      sessionStorage.removeItem('oidc_action');

      if (!code || !state) {
        setError(t('oidc.callback.stateError') || 'Missing code or state parameter.');
        return;
      }

      if (!savedState || state !== savedState) {
        setError(t('oidc.callback.stateError') || 'Security verification failed. Please try again.');
        return;
      }

      // Fail closed: only accept known actions
      if (action !== 'login' && action !== 'bind') {
        setError(t('oidc.callback.stateError') || 'Invalid session action. Please try again.');
        return;
      }

      if (action === 'bind') {
        if (!accessToken) {
          setError(t('oidc.callback.error') || 'Sign-in required. Please log in first.');
          return;
        }
        const response = await apiClient.oidcBindCallback({ code, state });
        if (response.success) {
          navigate('/account/oidc', { replace: true });
        } else {
          setError(response.error || t('oidc.callback.error') || 'Binding failed.');
        }
      } else {
        const response = await apiClient.oidcCallback({ code, state });
        if (response.success && response.data) {
          const { tokens, username, display_name, avatar_url } = response.data;

          // Backend always returns username in data.username (both new and existing users)
          if (!username) {
            setError(t('oidc.callback.error') || 'Could not determine account. Please try again.');
            return;
          }
          loginWithTokens(tokens, username, display_name, avatar_url);
          navigate('/', { replace: true });
        } else {
          setError(response.error || t('oidc.callback.error') || 'Sign-in failed.');
        }
      }
    };

    handleCallback();
    // isLoading is the only trigger: wait for auth hydration before running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (error) {
    return (
      <div className="w-full min-h-full flex items-center justify-center p-4" style={{ background: 'var(--bg-secondary)' }}>
        <div className="glass-card rounded-3xl w-full max-w-sm p-6 text-center">
          <div className="mb-4 text-red-500 text-4xl">✕</div>
          <h2 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            {t('oidc.callback.error') || 'Sign-in Failed'}
          </h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>{error}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="w-full py-2.5 px-4 rounded-xl font-medium transition text-sm text-white glass-btn-primary"
          >
            {t('oidc.callback.returnToLogin') || 'Return to Login'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-h-full flex items-center justify-center p-4" style={{ background: 'var(--bg-secondary)' }}>
      <div className="glass-card rounded-3xl w-full max-w-sm p-6 text-center">
        <Loader2 className="mx-auto mb-4 text-pink-500 animate-spin" size={40} />
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('oidc.callback.processing') || 'Processing sign-in...'}
        </p>
      </div>
    </div>
  );
};

export default OIDCCallback;
