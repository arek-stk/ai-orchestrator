'use client';

import { Ban, CircleAlert, CircleCheck, CircleDashed, CircleSlash, Clock, Flag, LoaderCircle, Merge, Sparkles, Target, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { findTool } from '@/lib/hub/catalog';
import { nodeAccent, STEP_STATUS, type WorkflowTone } from '@/lib/workflows/presentation';
import type { WorkflowNode, WorkflowStepStatus } from '@/lib/workflows/types';
import { LogoTile } from '../hub/primitives';
import { cx } from '../ui';

export const TONE_CLASS: Record<WorkflowTone, string> = {
  good: 'text-hub-connected',
  accent: 'text-hub-blue',
  warning: 'text-warning',
  critical: 'text-critical',
  muted: 'text-ink-2',
};

const STEP_ICON: Record<WorkflowStepStatus, LucideIcon> = {
  pending: Clock,
  running: LoaderCircle,
  succeeded: CircleCheck,
  failed: CircleAlert,
  skipped: CircleSlash,
  blocked: Ban,
  cancelled: CircleDashed,
};

/** Step status: icon plus label, never colour alone. */
export function StepStatusLabel({ status, className, compact }: { status: WorkflowStepStatus; className?: string; compact?: boolean }) {
  const meta = STEP_STATUS[status];
  const Icon = STEP_ICON[status];
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', TONE_CLASS[meta.tone], className)}>
      <Icon aria-hidden="true" size={compact ? 13 : 14} strokeWidth={2.25} className={cx('shrink-0', status === 'running' && 'animate-spin motion-reduce:animate-none')} />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

const TYPE_ICON: Record<Exclude<WorkflowNode['type'], 'agent'>, LucideIcon> = { goal: Target, orchestrator: Sparkles, join: Merge, finale: Flag };

/** The node's avatar: the Hub logo for agents, a glowing icon tile for structural nodes. */
export function NodeAvatar({ node, size = 'sm' }: { node: WorkflowNode; size?: 'xs' | 'sm' | 'md' }) {
  if (node.type === 'agent') {
    const tool = findTool(node.toolId);
    if (tool) return <LogoTile logo={tool.logo} name={tool.name} size={size} />;
    return <LogoTile logo={{ kind: 'monogram', value: node.toolId.slice(0, 2).toUpperCase(), accent: nodeAccent(node) }} name={node.toolId} size={size} />;
  }
  const Icon = TYPE_ICON[node.type];
  const box = size === 'md' ? 44 : size === 'sm' ? 32 : 24;
  const accent = nodeAccent(node);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center text-white"
      style={{
        width: box,
        height: box,
        borderRadius: box * 0.28,
        background: `linear-gradient(150deg, color-mix(in oklab, ${accent} 78%, white) 0%, ${accent} 55%, color-mix(in oklab, ${accent} 70%, black) 100%)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.22), 0 0 18px -4px ${accent}`,
      }}
    >
      <Icon size={box * 0.5} strokeWidth={2} />
    </span>
  );
}

export function toolName(toolId: string): string {
  return findTool(toolId)?.name ?? toolId;
}

/** Compact provider label as on the mockup cards ("Claude", "ChatGPT"). */
export function toolShortName(toolId: string): string {
  const tool = findTool(toolId);
  if (!tool) return toolId;
  return tool.name.split(' & ')[0]!.split(' (')[0]!;
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-6 items-center whitespace-nowrap rounded-full border border-hub-line bg-hub-card-2 px-2 text-[11.5px] text-ink-2', className)}>{children}</span>;
}

/** Circular progress (SVG), labelled for assistive technology. */
export function ProgressRing({ ratio, size = 64, label }: { ratio: number; size?: number; label: string }) {
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)} className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <defs>
          <linearGradient id="wf-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--hub-cyan)' }} />
            <stop offset="1" style={{ stopColor: 'var(--hub-violet)' }} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--hub-line-strong)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#wf-ring)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="tabular absolute inset-0 flex items-center justify-center text-[13px] font-semibold text-ink">{Math.round(clamped * 100)}%</span>
    </div>
  );
}

export const panelClass = 'rounded-2xl border border-hub-line bg-hub-card';
export const subtleButton =
  'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] border border-hub-line-strong bg-hub-card px-3 text-[13px] font-medium text-ink transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-hub-card-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100';
export const primaryButton =
  'inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] bg-hub-cta px-3.5 text-[13px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[background-color,transform] duration-150 ease-out hover:bg-hub-cta-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100';
export const fieldClass =
  'h-9 w-full min-w-0 rounded-[10px] border border-hub-line bg-hub-card-2 px-3 text-[13px] text-ink transition-[border-color] duration-150 ease-out placeholder:text-muted hover:border-hub-line-strong focus-visible:border-hub-cta disabled:cursor-not-allowed disabled:opacity-60';
export const labelClass = 'text-xs font-medium text-ink-2';
