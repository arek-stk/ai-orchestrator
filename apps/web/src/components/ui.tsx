'use client';

import Link from 'next/link';
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
  OctagonAlert,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { formatAbsolute, formatRelative } from '@/lib/format';
import type { Tone } from '@/lib/status';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Tone (status) primitives: dot + icon + label, never color alone
// ---------------------------------------------------------------------------

export const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warning: Clock,
  serious: OctagonAlert,
  critical: CircleX,
  accent: LoaderCircle,
  muted: CircleDashed,
};

export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-good',
  warning: 'text-warning',
  serious: 'text-serious',
  critical: 'text-critical',
  accent: 'text-accent',
  muted: 'text-muted',
};

export const TONE_BG: Record<Tone, string> = {
  good: 'bg-good',
  warning: 'bg-warning',
  serious: 'bg-serious',
  critical: 'bg-critical',
  accent: 'bg-accent',
  muted: 'bg-muted',
};

export const TONE_SOFT: Record<Tone, string> = {
  good: 'bg-good-soft',
  warning: 'bg-warning-soft',
  serious: 'bg-serious-soft',
  critical: 'bg-critical-soft',
  accent: 'bg-accent-soft',
  muted: 'bg-surface-2',
};

export function ToneIcon({ tone, icon, className, size = 14 }: { tone: Tone; icon?: LucideIcon; className?: string; size?: number }) {
  const Icon = icon ?? TONE_ICON[tone];
  return <Icon aria-hidden="true" size={size} strokeWidth={2.25} className={cx('shrink-0', TONE_TEXT[tone], className)} />;
}

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG[tone], tone === 'accent' && 'pulse', className)} />;
}

export function StatusBadge({ tone, label, icon, title, className }: { tone: Tone; label: string; icon?: LucideIcon; title?: string; className?: string }) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <span
      title={title}
      className={cx('inline-flex h-[22px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface pl-2 pr-2.5 text-xs font-medium text-ink', className)}
    >
      <Icon aria-hidden="true" size={12} strokeWidth={2.25} className={cx('shrink-0', TONE_TEXT[tone])} />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function Chip({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx('inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 text-xs text-ink-2', className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <div className="mt-1 text-sm text-ink-2 [text-wrap:pretty]">{description}</div> : null}
        {meta ? <div className="mt-3">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({ title, description, actions, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-[13px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-[13px] text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className={cx('min-w-0 rounded-[10px] border border-line bg-surface', className)}>
      {title || actions ? (
        <div className="px-5 pt-4">
          <SectionHeader id={headingId} title={title} description={description} actions={actions} />
        </div>
      ) : null}
      <div className={cx('px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Keeps previous content visible (60% opacity) while a refetch runs. */
export function Refreshable({ busy, children, className }: { busy: boolean; children: ReactNode; className?: string }) {
  return (
    <div aria-busy={busy} className={cx('transition-opacity duration-150 ease-out', busy && 'opacity-60', className)}>
      {children}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden="true" style={style} className={cx('animate-pulse rounded-md bg-surface-2', className)} />;
}

/** First-load placeholder (skeleton lines). Refetches never show this. */
export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-2.5 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${92 - ((i * 23) % 50)}%` }} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, hint, icon: Icon, action }: { title: string; hint?: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      {Icon ? <Icon aria-hidden="true" size={20} strokeWidth={1.75} className="text-muted" /> : null}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-[13px] text-ink-2">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, onDismiss, className }: { error: string | null | undefined; onRetry?: () => void; onDismiss?: () => void; className?: string }) {
  if (!error) return null;
  const forbidden = error.startsWith('Insufficient role');
  return (
    <div role="alert" className={cx('flex flex-wrap items-start gap-3 rounded-[10px] border border-line px-4 py-3 text-[13px] text-ink', forbidden ? 'bg-warning-soft' : 'bg-critical-soft', className)}>
      {forbidden ? <ShieldAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-warning" /> : <TriangleAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-critical" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{forbidden ? 'Insufficient role' : 'Something went wrong'}</p>
        <p className="break-words text-ink-2">{forbidden ? error.replace(/^Insufficient role:\s*/, '') : error}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function buttonClass(variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'md'): string {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    size === 'sm' ? 'h-7 px-2.5 text-xs pointer-coarse:h-9' : 'h-8 px-3 text-[13px] pointer-coarse:h-9',
    variant === 'primary' && 'bg-accent-strong text-white hover:bg-accent-strong/90',
    variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
    variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
    variant === 'danger' && 'border border-line-strong bg-surface text-ink hover:border-critical/40 hover:bg-critical-soft',
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  busy,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: LucideIcon; busy?: boolean }) {
  return (
    <button type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={cx(buttonClass(variant, size), className)} {...rest}>
      {busy ? (
        <LoaderCircle aria-hidden="true" size={14} className="animate-spin" />
      ) : Icon ? (
        <Icon aria-hidden="true" size={14} className={variant === 'danger' ? 'text-critical' : undefined} />
      ) : null}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'secondary', size = 'md', icon: Icon, className }: { href: string; children: ReactNode; variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: LucideIcon; className?: string }) {
  return (
    <Link href={href} className={cx(buttonClass(variant, size), className)}>
      {Icon ? <Icon aria-hidden="true" size={14} /> : null}
      {children}
    </Link>
  );
}

/** Square icon button; the invisible ::after extends the hit area to at least 40px. */
export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-[color,background-color,transform] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-surface-2 hover:text-ink active:scale-[0.98]",
        className,
      )}
      {...rest}
    >
      <Icon aria-hidden="true" size={16} />
    </button>
  );
}

export const inputClass =
  'h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink transition-[border-color] duration-150 ease-out placeholder:text-muted hover:border-axis disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-9';
export const textareaClass =
  'w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink transition-[border-color] duration-150 ease-out placeholder:text-muted hover:border-axis disabled:cursor-not-allowed disabled:opacity-60';

export function Field({ label, hint, children, className, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; description?: string }) {
  return (
    <label className={cx('flex items-start gap-2.5 text-[13px]', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden="true"
        className={cx(
          'relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-[background-color,border-color] duration-150 ease-out peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          checked ? 'border-accent-strong bg-accent-strong' : 'border-line-strong bg-surface-2',
        )}
      >
        <span className={cx('absolute h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out', checked ? 'translate-x-3' : 'translate-x-0.5')} />
      </span>
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {description ? <span className="block text-xs text-ink-2">{description}</span> : null}
      </span>
    </label>
  );
}

export interface TabItem {
  id: string;
  label: string;
  count?: number | null;
}

/** WAI-ARIA tabs with roving focus (arrow keys, Home/End). */
export function Tabs({ tabs, active, onChange, idPrefix, label }: { tabs: TabItem[]; active: string; onChange: (id: string) => void; idPrefix: string; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div role="tablist" aria-label={label} className="flex min-w-max gap-x-1 border-b border-line">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              role="tab"
              type="button"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cx(
                '-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-[13px] transition-[color,border-color] duration-150 ease-out',
                selected ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink',
              )}
            >
              {tab.label}
              {tab.count !== undefined && tab.count !== null ? <span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] leading-4 text-ink-2">{tab.count}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0} className="pt-6 focus-visible:outline-none">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export function StatTile({ label, value, sublabel, href, icon: Icon }: { label: string; value: ReactNode; sublabel?: ReactNode; href?: string; icon?: LucideIcon }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        {Icon ? <Icon aria-hidden="true" size={14} strokeWidth={1.75} className="text-muted" /> : null}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-[-0.01em] text-ink">{value}</div>
      {sublabel ? <div className="mt-0.5 truncate text-xs text-ink-2">{sublabel}</div> : null}
    </>
  );
  const className = 'block min-w-0 rounded-[10px] border border-line bg-surface px-4 py-3.5';
  return href ? (
    <Link href={href} className={cx(className, 'transition-[border-color] duration-150 ease-out hover:border-line-strong')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** Meter: fill carries severity, track is a lighter tint of the same hue; state also spelled out with icon + label. */
export function Meter({ label, pct, tone, valueText, statusLabel, detail }: { label: string; pct: number; tone: Tone; valueText: ReactNode; statusLabel: string; detail?: ReactNode }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const StatusIcon = tone === 'accent' || tone === 'good' ? CircleCheck : tone === 'critical' ? OctagonAlert : TriangleAlert;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <span className="text-[13px] text-ink-2">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-valuetext={`${Math.round(clamped)}%, ${statusLabel}`}
        className={cx('mt-2 h-2 w-full overflow-hidden rounded-full', TONE_SOFT[tone])}
      >
        <div className={cx('h-full rounded-full transition-[width] duration-500 ease-out', TONE_BG[tone])} style={{ width: `${clamped}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <ToneIcon tone={tone} icon={StatusIcon} size={13} />
          {statusLabel}
        </span>
        {detail}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const nowListeners = new Set<(now: number) => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    nowListeners.add(setNow);
    if (!nowTimer) nowTimer = setInterval(() => nowListeners.forEach((fn) => fn(Date.now())), intervalMs);
    return () => {
      nowListeners.delete(setNow);
      if (nowListeners.size === 0 && nowTimer) {
        clearInterval(nowTimer);
        nowTimer = null;
      }
    };
  }, [intervalMs]);
  return now;
}

export function RelativeTime({ value, className }: { value: string | Date | null | undefined; className?: string }) {
  const now = useNow();
  if (!value) return <span className={className}>n/a</span>;
  const iso = typeof value === 'string' ? value : value.toISOString();
  return (
    <time dateTime={iso} title={formatAbsolute(value)} className={cx('whitespace-nowrap', className)}>
      {formatRelative(value, now)}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function TextLink({
  href,
  children,
  className,
  external,
  title,
  variant = 'link',
}: {
  href: string;
  children: ReactNode;
  className?: string;
  external?: boolean;
  title?: string;
  /** `quiet` reads as body text and only reveals the link on hover (dense lists, feeds). */
  variant?: 'link' | 'quiet';
}) {
  const classes = cx(
    'underline-offset-2 transition-[color] duration-150 ease-out hover:underline',
    variant === 'quiet' ? 'text-ink hover:text-link' : 'text-link',
    className,
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes} title={title}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} title={title}>
      {children}
    </Link>
  );
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('font-mono text-[12px]', className)}>
      {children}
    </span>
  );
}

export function JsonDetails({ value, summary = 'Details' }: { value: unknown; summary?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-xs font-medium text-ink-2 transition-[color] duration-150 ease-out hover:text-ink">{summary}</summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-2">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function KeyValues({ items, className }: { items: Array<{ label: string; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-6 gap-y-3', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-ink-2">{item.label}</dt>
          <dd className="mt-0.5 truncate text-[13px] font-medium text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Tables: sticky header (below the 52px top bar, from xl up where the table does not scroll horizontally), row hover.
export const th = 'whitespace-nowrap border-b border-line bg-surface px-2 py-2 text-left text-xs font-medium text-ink-2 xl:sticky xl:top-[52px] xl:z-[5]';
export const td = 'border-b border-line px-2 py-2.5 align-top text-[13px] text-ink';

export function TableWrap({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="-mx-2 overflow-x-auto xl:overflow-x-visible" role={label ? 'region' : undefined} aria-label={label} tabIndex={label ? 0 : undefined}>
      <table className="w-full border-collapse [&_tbody_tr]:transition-[background-color] [&_tbody_tr]:duration-150 [&_tbody_tr:hover]:bg-surface-2 [&_tbody_tr:last-child_td]:border-b-0">
        {children}
      </table>
    </div>
  );
}

export function GitHubMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Product mark: a rounded square holding a miniature stage rail. */
export function OrchestratorMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 20 20" className={className}>
      <rect width="20" height="20" rx="5" className="fill-ink" />
      <rect x="3.5" y="8.5" width="3.8" height="3" rx="1" className="fill-page" />
      <rect x="8.1" y="8.5" width="3.8" height="3" rx="1" className="fill-page" opacity="0.7" />
      <rect x="12.7" y="8.5" width="3.8" height="3" rx="1" className="fill-accent" />
    </svg>
  );
}
