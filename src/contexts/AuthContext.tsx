import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import apiClient from '../api/client';
import type { AuthTokens } from '../api/types';
import { clearSecurityPassword } from '../utils/crypto';
import { deleteCookie, getCookie, setCookie } from '../utils/cookies';
import { setLogoutInProgress } from '../utils/authSessionState';

interface User {
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isLoggingOut: boolean;
  login: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string; status?: number }>;
  register: (username: string, password: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string }>;
  loginWithTokens: (tokens: AuthTokens, username: string, displayName?: string, avatarUrl?: string) => void;
  logout: (clearLocalData?: boolean) => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'hrt-access-token';
const REFRESH_TOKEN_STORAGE_KEY = 'hrt-refresh-token';
const USERNAME_STORAGE_KEY = 'hrt-username';
const DISPLAY_NAME_STORAGE_KEY = 'hrt-display-name';
const AVATAR_URL_STORAGE_KEY = 'hrt-avatar-url';
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
  const refreshPromiseRef = React.useRef<Promise<boolean> | null>(null);

  const logout = useCallback(async (clearLocalData: boolean = false) => {
    if (isLoggingOut) {
      return;
    }

    const tokenToRevoke = accessToken || getStoredValue(TOKEN_STORAGE_KEY);

    setIsLoggingOut(true);
    setLogoutInProgress(true);

    setAccessToken(null);
    setUser(null);
    apiClient.setAccessToken(null);

    // Always clear auth tokens before touching local data so sync can no longer authenticate.
    clearStoredValue(TOKEN_STORAGE_KEY);
    clearStoredValue(REFRESH_TOKEN_STORAGE_KEY);
    clearStoredValue(USERNAME_STORAGE_KEY);
    clearStoredValue(DISPLAY_NAME_STORAGE_KEY);
    clearStoredValue(AVATAR_URL_STORAGE_KEY);

    try {
      try {
        if (tokenToRevoke) {
          await apiClient.logout(tokenToRevoke);
        }
      } catch (error) {
        console.error('Failed to logout from server:', error);
      }

      // Always clear security password cookie
      try {
        await clearSecurityPassword();
      } catch (error) {
        console.error('Failed to clear security password during logout:', error);
      }

      // Optionally clear local user data
      if (clearLocalData) {
        localStorage.removeItem('hrt-events');
        localStorage.removeItem('hrt-weight');
        localStorage.removeItem('hrt-lab-results');
        localStorage.removeItem('hrt-lang');
        localStorage.removeItem('hrt-last-modified');
        localStorage.removeItem('hrt-last-data-updated');
        localStorage.removeItem('hrt-last-sync-time');
        localStorage.removeItem('hrt-last-pull-time');
        localStorage.removeItem('hrt-last-known-cloud-updated');
        localStorage.removeItem('hrt-last-known-cloud-hash');
        localStorage.removeItem('hrt-data-hash');
      }
    } finally {
      setLogoutInProgress(false);
      setIsLoggingOut(false);
    }
  }, [accessToken, isLoggingOut]);

  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    // Prevent multiple simultaneous refresh attempts
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const refreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);
        if (!refreshToken) return false;

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
          // Refresh token is invalid/expired - logout
          logout();
        } else {
          console.warn('Refresh token failed, keeping session for retry:', response.error);
        }
        return false;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [logout]);

  // Initialize auth state from cookies, with silent refresh fallback
  useEffect(() => {
    const storedAccessToken = getStoredValue(TOKEN_STORAGE_KEY);
    const storedUsername = getStoredValue(USERNAME_STORAGE_KEY);
    const storedRefreshToken = getStoredValue(REFRESH_TOKEN_STORAGE_KEY);

    if (storedAccessToken && storedUsername) {
      // Access token present — restore session immediately
      const storedDisplayName = getStoredValue(DISPLAY_NAME_STORAGE_KEY) || undefined;
      const storedAvatarUrl = getStoredValue(AVATAR_URL_STORAGE_KEY) || undefined;
      setAccessToken(storedAccessToken);
      setUser({ username: storedUsername, displayName: storedDisplayName, avatarUrl: storedAvatarUrl });
      apiClient.setAccessToken(storedAccessToken);
      setIsLoading(false);
    } else if (storedRefreshToken && storedUsername) {
      // No access token (expired / cleared) but refresh token exists — try silent refresh
      // Keep isLoading=true until refresh completes so ProtectedRoute doesn't flash /login
      apiClient.refreshToken({ refresh_token: storedRefreshToken }).then((response) => {
        if (response.success && response.data) {
          const { access_token, refresh_token } = response.data;
          const storedDisplayName = getStoredValue(DISPLAY_NAME_STORAGE_KEY) || undefined;
          const storedAvatarUrl = getStoredValue(AVATAR_URL_STORAGE_KEY) || undefined;
          setAccessToken(access_token);
          setUser({ username: storedUsername, displayName: storedDisplayName, avatarUrl: storedAvatarUrl });
          apiClient.setAccessToken(access_token);
          setStoredValue(TOKEN_STORAGE_KEY, access_token);
          setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
        } else {
          // Refresh token also invalid — clear all stored tokens
          clearStoredValue(TOKEN_STORAGE_KEY);
          clearStoredValue(REFRESH_TOKEN_STORAGE_KEY);
          clearStoredValue(USERNAME_STORAGE_KEY);
        }
        setIsLoading(false);
      }).catch(() => {
        // Network error during startup refresh — keep tokens, let user retry later
        setIsLoading(false);
      });
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const loginWithTokens = (tokens: AuthTokens, username: string, displayName?: string, avatarUrl?: string) => {
    const { access_token, refresh_token } = tokens;

    setAccessToken(access_token);
    setUser({ username, displayName, avatarUrl });
    apiClient.setAccessToken(access_token);

    setStoredValue(TOKEN_STORAGE_KEY, access_token);
    setStoredValue(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
    setStoredValue(USERNAME_STORAGE_KEY, username);
    if (displayName) setStoredValue(DISPLAY_NAME_STORAGE_KEY, displayName);
    else clearStoredValue(DISPLAY_NAME_STORAGE_KEY);
    if (avatarUrl) setStoredValue(AVATAR_URL_STORAGE_KEY, avatarUrl);
    else clearStoredValue(AVATAR_URL_STORAGE_KEY);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isAuthenticated: !!user && !!accessToken,
        isLoading,
        isLoggingOut,
        login,
        register,
        loginWithTokens,
        logout,
        refreshAccessToken,
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
