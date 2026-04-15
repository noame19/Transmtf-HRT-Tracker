import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import apiClient from '../api/client';
import type { AuthTokens } from '../api/types';
import { clearSecurityPassword } from '../utils/crypto';
import { deleteCookie, getCookie, setCookie } from '../utils/cookies';
import { setLogoutInProgress } from '../utils/authSessionState';

interface User {
  username: string;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isLoggingOut: boolean;
  sessionExpiredNotice: { id: number } | null;
  login: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string; status?: number }>;
  register: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string }>;
  loginWithTokens: (tokens: AuthTokens, username: string) => void;
  logout: (clearLocalData?: boolean) => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;
  clearSessionExpiredNotice: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'hrt-access-token';
const REFRESH_TOKEN_STORAGE_KEY = 'hrt-refresh-token';
const USERNAME_STORAGE_KEY = 'hrt-username';
const TOKEN_COOKIE_DAYS = 3650;

/**
 * Token Storage Strategy:
 *
 * We store auth tokens in cookies (not localStorage) to reduce XSS attack surface.
 * However, these are JavaScript-set cookies and NOT HttpOnly, so they can still
 * be accessed by malicious scripts.
 *
 * See src/utils/cookies.ts for detailed security notes and recommendations.
 */

const getStoredValue = (key: string) => getCookie(key);
const setStoredValue = (key: string, value: string) => {
  setCookie(key, value, TOKEN_COOKIE_DAYS);
};
const clearStoredValue = (key: string) => {
  deleteCookie(key);
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState<{ id: number } | null>(null);
  const refreshPromiseRef = React.useRef<Promise<boolean> | null>(null);
  const sessionExpiredHandledRef = React.useRef(false);
  const sessionExpiredNoticeIdRef = React.useRef(0);

  const clearLocalSession = useCallback(async (clearLocalData: boolean = false) => {
    setAccessToken(null);
    setUser(null);
    apiClient.setAccessToken(null);

    clearStoredValue(TOKEN_STORAGE_KEY);
    clearStoredValue(REFRESH_TOKEN_STORAGE_KEY);
    clearStoredValue(USERNAME_STORAGE_KEY);

    try {
      await clearSecurityPassword();
    } catch (error) {
      console.error('Failed to clear security password during logout:', error);
    }

    if (clearLocalData) {
      localStorage.removeItem('hrt-events');
      localStorage.removeItem('hrt-weight');
      localStorage.removeItem('hrt-lab-results');
      localStorage.removeItem('hrt-lang');
      localStorage.removeItem('hrt-last-modified');
      localStorage.removeItem('hrt-last-data-updated');
      localStorage.removeItem('hrt-last-sync-time');
      localStorage.removeItem('hrt-last-pull-time');
    }
  }, []);

  const clearSessionExpiredNotice = useCallback(() => {
    setSessionExpiredNotice(null);
  }, []);

  const invalidateSessionDueToExpiration = useCallback(async (): Promise<boolean> => {
    const hasPersistedSession = Boolean(
      accessToken ||
      user ||
      getStoredValue(TOKEN_STORAGE_KEY) ||
      getStoredValue(REFRESH_TOKEN_STORAGE_KEY) ||
      getStoredValue(USERNAME_STORAGE_KEY)
    );

    if (isLoggingOut || !hasPersistedSession || sessionExpiredHandledRef.current) {
      return false;
    }

    sessionExpiredHandledRef.current = true;
    setIsLoggingOut(true);
    setLogoutInProgress(true);

    try {
      await clearLocalSession();
      setSessionExpiredNotice({ id: ++sessionExpiredNoticeIdRef.current });
      return true;
    } finally {
      setLogoutInProgress(false);
      setIsLoggingOut(false);
    }
  }, [accessToken, clearLocalSession, isLoggingOut, user]);

  const logout = useCallback(async (clearLocalData: boolean = false) => {
    if (isLoggingOut) {
      return;
    }

    const tokenToRevoke = accessToken || getStoredValue(TOKEN_STORAGE_KEY);

    setIsLoggingOut(true);
    setLogoutInProgress(true);
    sessionExpiredHandledRef.current = false;
    setSessionExpiredNotice(null);

    try {
      await clearLocalSession(clearLocalData);

      try {
        if (tokenToRevoke) {
          await apiClient.logout(tokenToRevoke);
        }
      } catch (error) {
        console.error('Failed to logout from server:', error);
      }
    } finally {
      setLogoutInProgress(false);
      setIsLoggingOut(false);
    }
  }, [accessToken, clearLocalSession, isLoggingOut]);

  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    // Prevent multiple simultaneous refresh attempts
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const refreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);
        if (!refreshToken) {
          const expired = await invalidateSessionDueToExpiration();
          if (expired) {
            return false;
          }
          throw new Error('Refresh token missing');
        }

        const response = await apiClient.refreshToken({ refresh_token: refreshToken });

        if (response.success && response.data) {
          const { access_token, refresh_token } = response.data;
          setAccessToken(access_token);
          apiClient.setAccessToken(access_token);
          setStoredValue(TOKEN_STORAGE_KEY, access_token);
          setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
          return true;
        }

        if (response.status === 401) {
          await invalidateSessionDueToExpiration();
          return false;
        }

        console.warn('Refresh token failed, keeping session for retry:', response.error);
        throw new Error(response.error || 'Token refresh failed');
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [invalidateSessionDueToExpiration]);

  // Initialize auth state from cookies, with silent refresh fallback
  useEffect(() => {
    const storedAccessToken = getStoredValue(TOKEN_STORAGE_KEY);
    const storedUsername = getStoredValue(USERNAME_STORAGE_KEY);
    const storedRefreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);

    if (storedAccessToken && storedUsername) {
      sessionExpiredHandledRef.current = false;
      setSessionExpiredNotice(null);
      setAccessToken(storedAccessToken);
      setUser({ username: storedUsername });
      apiClient.setAccessToken(storedAccessToken);
      setIsLoading(false);
    } else if (storedRefreshToken && storedUsername) {
      apiClient.refreshToken({ refresh_token: storedRefreshToken }).then((response) => {
        if (response.success && response.data) {
          const { access_token, refresh_token } = response.data;
          sessionExpiredHandledRef.current = false;
          setSessionExpiredNotice(null);
          setAccessToken(access_token);
          setUser({ username: storedUsername });
          apiClient.setAccessToken(access_token);
          setStoredValue(TOKEN_STORAGE_KEY, access_token);
          setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
          setStoredValue(USERNAME_STORAGE_KEY, storedUsername);
          setIsLoading(false);
        } else if (response.status === 401) {
          invalidateSessionDueToExpiration().finally(() => {
            setIsLoading(false);
          });
        } else {
          console.warn('Startup refresh failed, keeping session for retry:', response.error);
          setIsLoading(false);
        }
      }).catch(() => {
        setIsLoading(false);
      });
    } else {
      setIsLoading(false);
    }
  }, [invalidateSessionDueToExpiration]);

  // Set refresh token callback
  useEffect(() => {
    apiClient.setRefreshTokenCallback(refreshAccessToken);
  }, [refreshAccessToken]);

  // Set up token refresh interval (every 50 minutes while tab is active)
  useEffect(() => {
    if (!accessToken) return;

    // Refresh token every 50 minutes (tokens expire in 1 hour)
    const refreshInterval = setInterval(() => {
      refreshAccessToken();
    }, 50 * 60 * 1000);

    return () => clearInterval(refreshInterval);
    // Only re-run when accessToken changes, not when refreshAccessToken changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Re-validate session when the page becomes visible again (e.g. mobile app resume)
  useEffect(() => {
    if (!accessToken) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Page was hidden (background / sleep) and is now active again.
        // Proactively refresh the access token so that a stale JWT doesn't
        // cause the very next API call to get a 401 and trigger a forced logout.
        refreshAccessToken();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const login = async (username: string, password: string, turnstileToken?: string) => {
    const response = await apiClient.login({
      username,
      password,
      turnstile_token: turnstileToken
    });

    if (response.success && response.data) {
      const { access_token, refresh_token } = response.data;

      sessionExpiredHandledRef.current = false;
      setSessionExpiredNotice(null);
      setAccessToken(access_token);
      setUser({ username });
      apiClient.setAccessToken(access_token);

      setStoredValue(TOKEN_STORAGE_KEY, access_token);
      setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
      setStoredValue(USERNAME_STORAGE_KEY, username);

      return { success: true };
    }

    return { success: false, error: response.error || 'Login failed', status: response.status };
  };

  const register = async (username: string, password: string, turnstileToken?: string) => {
    const response = await apiClient.register({
      username,
      password,
      turnstile_token: turnstileToken
    });

    if (response.success && response.data) {
      const { access_token, refresh_token } = response.data;

      sessionExpiredHandledRef.current = false;
      setSessionExpiredNotice(null);
      setAccessToken(access_token);
      setUser({ username });
      apiClient.setAccessToken(access_token);

      setStoredValue(TOKEN_STORAGE_KEY, access_token);
      setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
      setStoredValue(USERNAME_STORAGE_KEY, username);

      return { success: true };
    }

    return { success: false, error: response.error || 'Registration failed' };
  };

  const loginWithTokens = (tokens: AuthTokens, username: string) => {
    const { access_token, refresh_token } = tokens;

    sessionExpiredHandledRef.current = false;
    setSessionExpiredNotice(null);
    setAccessToken(access_token);
    setUser({ username });
    apiClient.setAccessToken(access_token);

    setStoredValue(TOKEN_STORAGE_KEY, access_token);
    setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
    setStoredValue(USERNAME_STORAGE_KEY, username);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isAuthenticated: !!user && !!accessToken,
        isLoading,
        isLoggingOut,
        sessionExpiredNotice,
        login,
        register,
        loginWithTokens,
        logout,
        refreshAccessToken,
        clearSessionExpiredNotice,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
