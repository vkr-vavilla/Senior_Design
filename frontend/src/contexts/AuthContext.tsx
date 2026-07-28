'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi } from '@/lib/api';
import type { User } from '@/types/auth';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  register: (token: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'prepai_token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async (tkn: string) => {
    try {
      const userData = await authApi.me(tkn);
      setUser(userData);
      setToken(tkn);
    } catch {
      // Token invalid or expired
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setUser(null);
    }
  }, []);

  // On mount, check localStorage for stored token
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      fetchUser(stored).finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [fetchUser]);

  // apiRequest() silently refreshes an expired access token via the refresh_token
  // cookie and dispatches this event with the new token — keep context state in
  // sync so callers reading `token` directly (not through apiRequest) don't keep
  // using the stale, now-expired one.
  useEffect(() => {
    const onTokenRefreshed = (e: Event) => {
      const newToken = (e as CustomEvent<string>).detail;
      if (newToken) setToken(newToken);
    };
    window.addEventListener('token-refreshed', onTokenRefreshed);
    return () => window.removeEventListener('token-refreshed', onTokenRefreshed);
  }, []);

  const login = useCallback(async (tkn: string) => {
    localStorage.setItem(TOKEN_KEY, tkn);
    await fetchUser(tkn);
  }, [fetchUser]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const register = useCallback(async (tkn: string) => {
    localStorage.setItem(TOKEN_KEY, tkn);
    await fetchUser(tkn);
  }, [fetchUser]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return ctx;
}
