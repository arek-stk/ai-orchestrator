'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LiveEventsProvider } from '@/hooks/use-live-events';
import { api, errorMessage } from '@/lib/api';
import type { AuthMe, HealthResponse, SessionUser, UserRole } from '@/lib/types';

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'orch-theme';

interface ThemeValue {
  theme: ThemePreference;
  setTheme(theme: ThemePreference): void;
}

const ThemeContext = createContext<ThemeValue>({ theme: 'system', setTheme: () => undefined });

function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>('system');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') setThemeState(stored);
    } catch {
      // Storage unavailable: stay on system.
    }
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function hasRole(user: SessionUser | null | undefined, minimum: UserRole): boolean {
  return Boolean(user) && ROLE_RANK[user!.role] >= ROLE_RANK[minimum];
}

interface SessionValue {
  user: SessionUser | null;
  methods: AuthMe['methods'];
  health: HealthResponse | null;
  /** True until /api/auth/me answered once. */
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue>({
  user: null,
  methods: { github: false, dev: false },
  health: null,
  loading: true,
  error: null,
  refresh: async () => undefined,
  logout: async () => undefined,
});

function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [auth, healthResult] = await Promise.all([
        api<AuthMe>('/api/auth/me', { redirectOn401: false }),
        api<HealthResponse>('/api/health', { redirectOn401: false }).catch(() => null),
      ]);
      setMe(auth);
      setHealth(healthResult);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {}, redirectOn401: false });
    } finally {
      setMe((previous) => (previous ? { ...previous, user: null } : previous));
      window.location.assign('/login');
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ user: me?.user ?? null, methods: me?.methods ?? { github: false, dev: false }, health, loading, error, refresh, logout }),
    [me, health, loading, error, refresh, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

function LiveGate({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return <LiveEventsProvider enabled={Boolean(user)}>{children}</LiveEventsProvider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SessionProvider>
        <LiveGate>{children}</LiveGate>
      </SessionProvider>
    </ThemeProvider>
  );
}
