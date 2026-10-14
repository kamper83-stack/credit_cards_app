import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { authApi, setUnauthorizedHandler } from '../api';
import type { AuthUser } from '../types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface Credentials { email: string; password: string }
interface PasswordChange { currentPassword: string; newPassword: string }

export interface AuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: UseMutationResult<AuthUser, unknown, Credentials>;
  register: UseMutationResult<AuthUser, unknown, Credentials>;
  logout: UseMutationResult<void, unknown, void>;
  changePassword: UseMutationResult<unknown, unknown, PasswordChange>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Owns the session state. The session itself is an HttpOnly cookie the client never sees; this only
 * mirrors "who am I" from GET /auth/me.
 *
 * Isolation rule: every transition between users (login, register, logout, a 401 from any data
 * request) wipes the entire TanStack Query cache BEFORE the new user is published, so user B can
 * never be shown user A's cached data on the same browser.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // undefined = /auth/me still resolving
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const userRef = useRef<AuthUser | null | undefined>(undefined);

  /** Single place that changes the current user. `wipe` is false only for the initial /me load. */
  const applyUser = useCallback((next: AuthUser | null, wipe = true) => {
    if (wipe) qc.clear();
    userRef.current = next;
    setUser(next);
  }, [qc]);

  // Initial session probe. Not retried: a 401 simply means "anonymous".
  useEffect(() => {
    let cancelled = false;
    authApi.me().then(
      (u) => { if (!cancelled) applyUser(u, false); },
      () => { if (!cancelled) applyUser(null, false); },
    );
    return () => { cancelled = true; };
  }, [applyUser]);

  // A 401 on any non-/auth request (expired / revoked session) drops us to anonymous.
  useEffect(() => {
    setUnauthorizedHandler(() => applyUser(null));
    return () => setUnauthorizedHandler(null);
  }, [applyUser]);

  const login = useMutation({ mutationFn: authApi.login, onSuccess: (u) => applyUser(u) });
  const register = useMutation({ mutationFn: authApi.register, onSuccess: (u) => applyUser(u) });
  const logout = useMutation({
    mutationFn: async () => { await authApi.logout().catch(() => undefined); },
    onSettled: () => applyUser(null), // even if the request failed, forget the user locally
  });
  const changePassword = useMutation({ mutationFn: authApi.changePassword });

  const value = useMemo<AuthValue>(() => ({
    status: user === undefined ? 'loading' : user ? 'authenticated' : 'anonymous',
    user: user ?? null,
    login, register, logout, changePassword,
  }), [user, login, register, logout, changePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
