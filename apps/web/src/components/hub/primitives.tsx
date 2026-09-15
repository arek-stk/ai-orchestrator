'use client';

import {
  AudioLines,
  AudioWaveform,
  Captions,
  Clapperboard,
  Database,
  Film,
  Gauge,
  Image as ImageIcon,
  MessageSquare,
  Mic,
  Scissors,
  UserRound,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type CSSProperties } from 'react';
import type { HubTone } from '@/lib/hub/presentation';
import type { ToolLogo } from '@/lib/hub/types';
import { cx } from '../ui';

const ICONS: Record<string, LucideIcon> = {
  'audio-lines': AudioLines,
  'audio-waveform': AudioWaveform,
  captions: Captions,
  clapperboard: Clapperboard,
  database: Database,
  film: Film,
  gauge: Gauge,
  image: ImageIcon,
  'message-square': MessageSquare,
  mic: Mic,
  scissors: Scissors,
  'user-round': UserRound,
  'wand-sparkles': WandSparkles,
};

const SIZES = {
  xs: { box: 24, radius: 7, icon: 13, text: 9.5, pad: 4 },
  sm: { box: 32, radius: 9, icon: 16, text: 11.5, pad: 6 },
  md: { box: 44, radius: 12, icon: 21, text: 15, pad: 9 },
  lg: { box: 56, radius: 15, icon: 26, text: 18, pad: 11 },
} as const;

function isLight(hex: string): boolean {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(value)) return false;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
}

/**
 * Tool logo tile. Vendored brand SVGs render through <img> on a fixed tile colour (never inlined, so an SVG cannot
 * run script); tools without a licensed logo get a neutral monogram or icon on a gradient of their accent colour.
 */
export function LogoTile({ logo, name, size = 'md', className }: { logo: ToolLogo; name: string; size?: keyof typeof SIZES; className?: string }) {
  const [failed, setFailed] = useState(false);
  const s = SIZES[size];
  const base: CSSProperties = { width: s.box, height: s.box, borderRadius: s.radius };

  if (logo.kind === 'image' && !failed) {
    const light = isLight(logo.bg);
    return (
      <span
        className={cx('relative inline-flex shrink-0 items-center justify-center', className)}
        style={{ ...base, background: logo.bg, boxShadow: light ? 'inset 0 0 0 1px rgba(15, 17, 30, 0.1)' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.09)' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static, sanitised SVG; next/image adds nothing here */}
        <img src={logo.src} alt={`${name} Logo`} width={s.box - s.pad * 2} height={s.box - s.pad * 2} decoding="async" draggable={false} onError={() => setFailed(true)} />
      </span>
    );
  }

  const accent = logo.accent;
  const Icon = logo.kind === 'icon' ? ICONS[logo.value] : undefined;
  const text = logo.kind === 'image' ? logo.fallback : logo.kind === 'monogram' ? logo.value : logo.value.slice(0, 2);
  return (
    <span
      role="img"
      aria-label={`${name} Symbol`}
      className={cx('relative inline-flex shrink-0 select-none items-center justify-center font-semibold tracking-[-0.02em] text-white', className)}
      style={{
        ...base,
        fontSize: s.text,
        background: `linear-gradient(150deg, color-mix(in oklab, ${accent} 80%, white) 0%, ${accent} 52%, color-mix(in oklab, ${accent} 72%, black) 100%)`,
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
      }}
    >
      {Icon ? <Icon aria-hidden="true" size={s.icon} strokeWidth={1.9} /> : <span aria-hidden="true">{text}</span>}
    </span>
  );
}

const PILL_TONE: Record<HubTone, { wrap: string; dot: string }> = {
  good: { wrap: 'bg-hub-connected-soft text-hub-connected', dot: 'bg-hub-connected' },
  warning: { wrap: 'bg-warning-soft text-ink', dot: 'bg-warning' },
  critical: { wrap: 'bg-critical-soft text-ink', dot: 'bg-critical' },
  accent: { wrap: 'bg-accent-soft text-ink', dot: 'bg-accent' },
  muted: { wrap: 'bg-hub-card-2 text-ink-2 border border-hub-line', dot: 'bg-muted' },
};

/** Status label: dot + text, never colour alone. */
export function StatePill({ tone, label, className }: { tone: HubTone; label: string; className?: string }) {
  const style = PILL_TONE[tone];
  return (
    <span className={cx('inline-flex h-6 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium', style.wrap, className)}>
      <span aria-hidden="true" className={cx('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} />
      <span className="truncate">{label}</span>
    </span>
  );
}

export const TONE_TEXT_CLASS: Record<HubTone, string> = {
  good: 'text-hub-connected',
  warning: 'text-ink',
  critical: 'text-ink',
  accent: 'text-ink',
  muted: 'text-ink-2',
};

/** Decorative four-point star for the page title (not a brand mark). */
export function HubMark({ size = 36 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <linearGradient id={`${id}-fill`} x1="6" y1="4" x2="34" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--hub-cyan)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--hub-blue)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-violet)' }} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="20" cy="20" r="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--hub-violet)', stopOpacity: 0.35 }} />
          <stop offset="1" style={{ stopColor: 'var(--hub-violet)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="18" fill={`url(#${id}-glow)`} />
      <path d="M20 3c1.2 8.6 4.9 12.4 14 14-9.1 1.6-12.8 5.4-14 17-1.2-11.6-4.9-15.4-14-17 9.1-1.6 12.8-5.4 14-14Z" fill={`url(#${id}-fill)`} />
      <path d="M31.5 4.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4Z" fill={`url(#${id}-fill)`} opacity="0.7" />
    </svg>
  );
}
