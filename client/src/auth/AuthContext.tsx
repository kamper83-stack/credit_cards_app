import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { authApi, bumpAuthGeneration, currentAuthGeneration, setUnauthorizedHandler } from '../api';
import { statusOf } from '../lib/errors';
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
  /** True when the last server-side logout request failed (the session cookie may still be valid). */
  logoutFailed: boolean;
  changePassword: UseMutationResult<unknown, unknown, PasswordChange>;
}

const CHANNEL = 'auth';
/** Minimum gap between /auth/me re-checks triggered by tab focus / visibility. */
export const RECHECK_THROTTLE_MS = 5000;

type AuthMessage = { type: 'user'; user: AuthUser | null } | { type: 'recheck' };

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Owns the session state. The session itself is an HttpOnly cookie the client never sees; this only
 * mirrors "who am I" from GET /auth/me.
 *
 * Isolation rule: every transition between users (login, register, logout, a 401 from any data
 * request) wipes the entire TanStack Query cache BEFORE the new user is published, so user B can
 * never be shown user A's cached data on the same browser.
 *
 * Several tabs share one cookie, so another tab can switch the account under this one. Two guards
 * keep a stale tab honest: (1) user changes are broadcast over BroadcastChannel('auth') and applied
 * here through the same applyUser path; (2) /auth/me is re-checked when the tab becomes visible or
 * focused (throttled). Applying a received/fetched user never re-broadcasts, so there are no loops.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // undefined = /auth/me still resolving
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const userRef = useRef<AuthUser | null | undefined>(undefined);

  const [logoutFailed, setLogoutFailed] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastCheckRef = useRef(0);
  const checkingRef = useRef(false);

  /** Single place that changes the current user. `wipe` is false only for the initial /me load. */
  const applyUser = useCallback((next: AuthUser | null, wipe = true) => {
    if (wipe) qc.clear();
    bumpAuthGeneration(); // requests of the previous user may no longer log the new one out
    if (next) setLogoutFailed(false);
    userRef.current = next;
    setUser(next);
  }, [qc]);

  /** Adopt an identity learned from elsewhere (another tab, a re-check) only if it is a different user. */
  const adoptIfChanged = useCallback((next: AuthUser | null) => {
    const cur = userRef.current;
    if (cur === undefined) return; // initial probe still in flight; it will read the live cookie
    if ((cur?.id ?? null) === (next?.id ?? null)) return;
    applyUser(next);
  }, [applyUser]);

  const broadcast = useCallback((msg: AuthMessage) => {
    try { channelRef.current?.postMessage(msg); } catch { /* closed channel / unsupported payload */ }
  }, []);

  // Authoritative re-check against the shared cookie.
  const recheck = useCallback(async (force = false) => {
    if (userRef.current === undefined || checkingRef.current) return;
    const now = Date.now();
    if (!force && now - lastCheckRef.current < RECHECK_THROTTLE_MS) return;
    lastCheckRef.current = now;
    checkingRef.current = true;
    const gen = currentAuthGeneration();
    try {
      const u = await authApi.me();
      if (gen === currentAuthGeneration()) adoptIfChanged(u); // else a login/logout raced us: its result wins
    } catch (e) {
      if (statusOf(e) === 401 && gen === currentAuthGeneration()) adoptIfChanged(null);
      // network / 5xx: keep what we have
    } finally {
      checkingRef.current = false;
    }
  }, [adoptIfChanged]);

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

  // Cross-tab: broadcast + re-check on focus / visibility.
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        ch = new BroadcastChannel(CHANNEL);
        ch.onmessage = (ev: MessageEvent<AuthMessage>) => {
          const m = ev.data;
          if (m?.type === 'user') adoptIfChanged(m.user ?? null);
          else if (m?.type === 'recheck') void recheck(true);
        };
      } catch { ch = null; }
    }
    channelRef.current = ch;
    const onVisible = () => { if (document.visibilityState === 'visible') void recheck(); };
    const onFocus = () => { void recheck(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      ch?.close();
      channelRef.current = null;
    };
  }, [adoptIfChanged, recheck]);

  const onSignedIn = useCallback((u: AuthUser) => { applyUser(u); broadcast({ type: 'user', user: u }); }, [applyUser, broadcast]);
  const login = useMutation({ mutationFn: authApi.login, onSuccess: onSignedIn });
  const register = useMutation({ mutationFn: authApi.register, onSuccess: onSignedIn });
  const logout = useMutation({
    mutationFn: async () => { await authApi.logout(); },
    onSuccess: () => { setLogoutFailed(false); broadcast({ type: 'user', user: null }); },
    // The server-side session may still be alive: remember it so the login screen can say so.
    onError: () => setLogoutFailed(true),
    // Either way forget the user locally.
    onSettled: () => applyUser(null),
  });
  const changePassword = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: () => broadcast({ type: 'recheck' }), // sessions were rotated server-side
  });

  const value = useMemo<AuthValue>(() => ({
    status: user === undefined ? 'loading' : user ? 'authenticated' : 'anonymous',
    user: user ?? null,
    login, register, logout, logoutFailed, changePassword,
  }), [user, login, register, logout, logoutFailed, changePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
