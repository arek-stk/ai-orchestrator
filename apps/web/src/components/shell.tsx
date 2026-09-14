'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Bot,
  ChevronRight,
  Coins,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '@/hooks/use-api';
import { useLiveEvents } from '@/hooks/use-live-events';
import type { Approval } from '@/lib/types';
import { useSession, useTheme, type ThemePreference } from './providers';
import { cx, ErrorBanner, IconButton, OrchestratorMark, Skeleton } from './ui';

// ---------------------------------------------------------------------------
// Breadcrumbs: derived from the path, pages can refine them with names
// ---------------------------------------------------------------------------

export interface Crumb {
  label: string;
  href?: string;
}

const BreadcrumbContext = createContext<(items: Crumb[] | null) => void>(() => undefined);

export function useBreadcrumb(items: Crumb[] | null): void {
  const set = useContext(BreadcrumbContext);
  const key = JSON.stringify(items);
  useEffect(() => {
    set(key === 'null' ? null : (JSON.parse(key) as Crumb[]));
    return () => set(null);
  }, [key, set]);
}

const SECTION_LABELS: Record<string, string> = {
  agents: 'Agents',
  approvals: 'Approvals',
  decisions: 'Decisions',
  costs: 'Costs',
  settings: 'Settings',
  projects: 'Projects',
};

function defaultCrumbs(pathname: string): Crumb[] {
  if (pathname === '/') return [{ label: 'Dashboard' }];
  const [, section] = pathname.split('/');
  if (pathname.startsWith('/projects/')) return [{ label: 'Projects', href: '/projects' }, { label: 'Project' }];
  if (pathname.startsWith('/runs/')) return [{ label: 'Projects', href: '/projects' }, { label: 'Run' }];
  return [{ label: SECTION_LABELS[section ?? ''] ?? 'Dashboard' }];
}

function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className={cx('flex min-w-0 items-center gap-1', !last && 'hidden sm:flex')}>
              {index > 0 ? <ChevronRight aria-hidden="true" size={13} className="shrink-0 text-muted" /> : null}
              {item.href && !last ? (
                <Link href={item.href} className="truncate text-ink-2 transition-[color] duration-150 ease-out hover:text-ink">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cx('truncate', last ? 'font-medium text-ink' : 'text-ink-2')}>
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/projects') return pathname.startsWith('/projects') || pathname.startsWith('/runs');
  return pathname.startsWith(href);
}

/** `rail` renders the 56px icon-only variant (between 640px and 1024px). */
function NavList({ items, pathname, mode, onNavigate }: { items: NavItem[]; pathname: string; mode: 'responsive' | 'full'; onNavigate?: () => void }) {
  const responsive = mode === 'responsive';
  return (
    <nav aria-label="Main" className={cx('flex flex-col gap-0.5', responsive ? 'px-2 lg:px-3' : 'px-3')}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            title={responsive ? item.label : undefined}
            className={cx(
              'relative flex h-9 items-center gap-2.5 rounded-md text-[13px] transition-[color,background-color] duration-150 ease-out',
              responsive ? 'justify-center px-0 lg:justify-start lg:px-2.5' : 'px-2.5',
              active ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <item.icon aria-hidden="true" size={16} strokeWidth={active ? 2.25 : 1.75} className={active ? 'text-ink' : 'text-ink-2'} />
            <span className={cx('flex-1 truncate', responsive && 'sr-only lg:not-sr-only')}>{item.label}</span>
            {item.badge ? (
              <span
                aria-label={`${item.badge} pending`}
                className={cx(
                  'tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-strong px-1 text-[11px] font-semibold leading-none text-white',
                  responsive && 'absolute right-1 top-1 lg:static',
                )}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ compactBelowLg }: { compactBelowLg: boolean }) {
  return (
    <Link href="/" className={cx('flex h-[52px] shrink-0 items-center gap-2.5 text-[14px] font-semibold tracking-[-0.01em] text-ink', compactBelowLg ? 'justify-center lg:justify-start lg:px-5' : 'px-5')}>
      <OrchestratorMark size={22} />
      <span className={compactBelowLg ? 'sr-only lg:not-sr-only' : undefined}>Orchestrator</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Top bar widgets
// ---------------------------------------------------------------------------

function LiveIndicator() {
  const { state } = useLiveEvents();
  const map = {
    open: { dot: 'bg-good', label: 'Live' },
    connecting: { dot: 'bg-warning', label: 'Connecting…' },
    reconnecting: { dot: 'bg-warning', label: 'Reconnecting…' },
    offline: { dot: 'bg-critical', label: 'Offline' },
    idle: { dot: 'bg-muted', label: 'Not connected' },
  } as const;
  const current = map[state];
  return (
    <span role="status" title="Live event stream" className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full px-2 text-xs text-ink-2">
      <span aria-hidden="true" className="relative inline-flex h-2 w-2">
        {state === 'open' ? <span className="pulse absolute inset-0 rounded-full bg-good opacity-40" /> : null}
        <span className={cx('relative h-2 w-2 rounded-full', current.dot)} />
      </span>
      <span className="hidden sm:inline">{current.label}</span>
      <span className="sr-only sm:hidden">{current.label}</span>
    </span>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
    { value: 'system', label: 'System theme', icon: Monitor },
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'dark', label: 'Dark theme', icon: Moon },
  ];
  return (
    <div role="group" aria-label="Color theme" className="inline-flex h-8 shrink-0 items-center rounded-md border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={theme === option.value}
          title={option.label}
          onClick={() => setTheme(option.value)}
          className={cx(
            "relative inline-flex h-6 w-7 items-center justify-center rounded-[4px] transition-[color,background-color] duration-150 ease-out after:absolute after:-inset-y-2 after:inset-x-0 after:content-['']",
            theme === option.value ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          <option.icon aria-hidden="true" size={14} />
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const initials = (user.name ?? user.login).slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.login}`}
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 items-center gap-2 rounded-full pl-0.5 pr-0.5 transition-[background-color] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-surface-2 sm:pr-2.5"
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" width={28} height={28} className="h-7 w-7 rounded-full border border-line" />
        ) : (
          <span aria-hidden="true" className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2">
            {initials}
          </span>
        )}
        <span className="hidden text-[13px] font-medium text-ink sm:inline">{user.login}</span>
      </button>
      {open ? (
        <div role="menu" aria-label="Account" className="absolute right-0 top-full z-40 mt-2 w-56 rounded-[10px] border border-line bg-surface p-1 shadow-pop">
          <div className="px-2.5 py-2">
            <p className="truncate text-[13px] font-medium text-ink">{user.name ?? user.login}</p>
            <p className="text-xs text-ink-2">
              <span className="font-mono text-[12px]">{user.login}</span> · {user.role}
            </p>
          </div>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => void logout()}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink transition-[background-color] duration-150 ease-out hover:bg-surface-2"
          >
            <LogOut aria-hidden="true" size={14} className="text-ink-2" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { user, loading, error, health, refresh } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [crumbOverride, setCrumbOverride] = useState<Crumb[] | null>(null);
  const setCrumbs = useCallback((items: Crumb[] | null) => setCrumbOverride(items), []);
  const onLogin = pathname.startsWith('/login');

  const pending = useApi<{ approvals: Approval[] }>(user && !onLogin ? '/api/approvals?status=pending' : null, {
    live: (event) => event.type.startsWith('approval.'),
  });
  const demoMode = health?.demoMode ?? false;

  useEffect(() => {
    if (!onLogin && !loading && !error && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [onLogin, loading, error, user, router, pathname]);

  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (onLogin) return <>{children}</>;

  if (loading || (!user && !error)) {
    return (
      <div role="status" className="min-h-screen bg-page">
        <span className="sr-only">Loading…</span>
        <div className="fixed inset-y-0 left-0 hidden w-14 border-r border-line bg-surface sm:block lg:w-[232px]" />
        <div className="sm:pl-14 lg:pl-[232px]">
          <div className="h-[52px] border-b border-line" />
          <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6">
            <Skeleton className="h-6 w-48" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[92px] rounded-[10px]" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-[10px]" />
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4">
        <ErrorBanner error={error} onRetry={() => void refresh()} />
      </main>
    );
  }

  const pendingCount = pending.data?.approvals.length ?? 0;
  const items: NavItem[] = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/projects', label: 'Projects', icon: FolderKanban },
    { href: '/agents', label: 'Agents', icon: Bot },
    { href: '/approvals', label: 'Approvals', icon: ShieldCheck, badge: pendingCount },
    { href: '/decisions', label: 'Decisions', icon: Lightbulb },
    { href: '/costs', label: 'Costs', icon: Coins },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];
  const crumbs = crumbOverride ?? defaultCrumbs(pathname);

  return (
    <BreadcrumbContext.Provider value={setCrumbs}>
      <div className="min-h-screen bg-page">
        <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-[13px] text-ink shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>

        {/* 56px icon rail from 640px, full 232px sidebar from 1024px */}
        <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-14 flex-col border-r border-line bg-surface sm:flex lg:w-[232px]">
          <Brand compactBelowLg />
          <div className="mt-2">
            <NavList items={items} pathname={pathname} mode="responsive" />
          </div>
        </aside>

        {/* Off-canvas drawer below 640px */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 sm:hidden">
            <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
            <aside aria-label="Sidebar" className="enter relative flex h-full w-[232px] flex-col border-r border-line bg-surface shadow-pop">
              <div className="flex items-center justify-between pr-2">
                <Brand compactBelowLg={false} />
                <IconButton icon={X} label="Close navigation" onClick={() => setDrawerOpen(false)} />
              </div>
              <div className="mt-2">
                <NavList items={items} pathname={pathname} mode="full" onNavigate={() => setDrawerOpen(false)} />
              </div>
            </aside>
          </div>
        ) : null}

        <div className="sm:pl-14 lg:pl-[232px]">
          <header className="sticky top-0 z-20 flex h-[52px] items-center gap-2 border-b border-line bg-page px-4 sm:gap-3 sm:px-6">
            <IconButton icon={Menu} label="Open navigation" className="-ml-1.5 sm:hidden" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} />
            <div className="min-w-0 flex-1">
              <Breadcrumbs items={crumbs} />
            </div>
            <LiveIndicator />
            {demoMode ? (
              <span
                title="No real model provider is configured: agents run with deterministic mock models."
                className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-xs font-medium text-ink"
              >
                <FlaskConical aria-hidden="true" size={12} className="text-warning" />
                <span className="hidden sm:inline">Demo mode</span>
                <span className="sr-only sm:hidden">Demo mode</span>
              </span>
            ) : null}
            <div className="hidden sm:block">
              <ThemeToggle />
            </div>
            <UserMenu />
          </header>
          <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6">
            {children}
            <div className="mt-10 flex justify-center sm:hidden">
              <ThemeToggle />
            </div>
          </main>
        </div>
      </div>
    </BreadcrumbContext.Provider>
  );
}
