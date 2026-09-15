'use client';

import { ArrowRight, ArrowUpRight, Workflow } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { connectionBadge, orchestratorState, primaryAction, PRIMARY_ACTION_LABELS } from '@/lib/hub/presentation';
import type { AIConnection, AITool } from '@/lib/hub/types';
import { cx } from '../ui';
import { CardMenu } from './CardMenu';
import { LogoTile, StatePill, TONE_TEXT_CLASS } from './primitives';

export interface CardHandlers {
  onOpen: (tool: AITool, section?: 'connection') => void;
  onConnect: (tool: AITool) => void;
  onDisconnect: (tool: AITool) => void;
}

export const actionClass = {
  connect: 'bg-hub-cta text-white hover:bg-hub-cta-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]',
  manage: 'border border-hub-connected-line text-hub-connected hover:bg-hub-connected-soft',
  details: 'border border-hub-line-strong text-ink hover:bg-hub-card-2',
  learn: 'border border-hub-line-strong text-ink hover:bg-hub-card-2',
} as const;

export const actionBase =
  'group/action relative inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100';

export function ActionArrow({ external }: { external?: boolean }) {
  const Icon = external ? ArrowUpRight : ArrowRight;
  return (
    <Icon
      aria-hidden="true"
      size={14}
      className="transition-transform duration-150 ease-out group-hover/action:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover/action:translate-x-0"
    />
  );
}

/**
 * Tool card. Sizes follow the grid's container width: in the single-column phone layout the logo sits next to the
 * name and spacing is tighter; from two columns up the card stacks logo, name and provider as in the mockup.
 */
export function AICard({
  tool,
  connection,
  selected,
  showDisconnect,
  onOpen,
  onConnect,
  onDisconnect,
}: CardHandlers & { tool: AITool; connection: AIConnection | undefined; selected: boolean; showDisconnect: boolean }) {
  const titleId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const onMenuChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const badge = connectionBadge(tool, connection);
  const orchestrator = orchestratorState(tool, connection);
  const action = primaryAction(tool, connection);
  const connected = connection?.status === 'connected';

  return (
    <article
      aria-labelledby={titleId}
      data-connected={connected || undefined}
      data-selected={selected || undefined}
      className={cx('hub-card group relative flex h-full flex-col rounded-[18px] p-3.5 @xl:p-4', menuOpen && 'z-20')}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 @xl:grid-cols-[minmax(0,1fr)_auto] @xl:items-start">
        <LogoTile logo={tool.logo} name={tool.name} size="card" className="col-start-1 row-span-2 row-start-1 [--hub-tile:40px] @xl:row-span-1 @xl:[--hub-tile:44px]" />
        <div className="relative z-[2] col-start-3 row-start-1 self-start @xl:col-start-2">
          <CardMenu
            toolName={tool.name}
            website={tool.website}
            showDisconnect={showDisconnect}
            onDetails={() => onOpen(tool)}
            onDisconnect={() => onDisconnect(tool)}
            onOpenChange={onMenuChange}
          />
        </div>
        <h3 className="col-start-2 row-start-1 self-end text-[15px] font-semibold leading-5 tracking-[-0.01em] text-ink @xl:col-span-2 @xl:col-start-1 @xl:row-start-2 @xl:mt-3.5">
          <button
            id={titleId}
            type="button"
            data-hub-card-title=""
            aria-haspopup="dialog"
            onClick={() => onOpen(tool)}
            className="hub-card-title text-left after:absolute after:inset-0 after:rounded-[18px] after:content-['']"
          >
            {tool.name}
          </button>
        </h3>
        <p className="col-start-2 row-start-2 truncate self-start text-xs text-ink-2 @xl:col-span-2 @xl:col-start-1 @xl:row-start-3 @xl:mt-0.5">{tool.provider}</p>
      </div>

      <StatePill tone={badge.tone} label={badge.label} className="mt-2.5 self-start" />

      <p className="mt-2 line-clamp-2 text-[13px] leading-[1.4] text-ink-2 @xl:mt-3 @xl:min-h-[2.8em]">{tool.description}</p>

      <ul aria-label="Fähigkeiten" className="mt-2.5 flex flex-wrap gap-1.5 @xl:mt-3">
        {tool.tags.slice(0, 3).map((tag) => (
          <li key={tag} className="inline-flex h-6 items-center rounded-md border border-hub-line bg-hub-card-2 px-2 text-[11.5px] text-ink-2">
            {tag}
          </li>
        ))}
      </ul>

      {/* One line: the value never breaks mid-phrase; if a card is ever too narrow it truncates (full text in title). */}
      <p className="mt-auto flex min-w-0 items-center gap-1.5 whitespace-nowrap pt-3 text-xs @xl:pt-4" title={connection?.detail ?? `Orchestrator: ${orchestrator.label}`}>
        <Workflow aria-hidden="true" size={13} className="shrink-0 text-muted" />
        <span className="shrink-0 text-ink-2">Orchestrator</span>
        <span aria-hidden="true" className="shrink-0 text-muted">
          ·
        </span>
        <span className={cx('min-w-0 truncate font-medium', TONE_TEXT_CLASS[orchestrator.tone])}>{orchestrator.label}</span>
      </p>

      <div className="relative z-[2] mt-3">
        {action === 'learn' ? (
          <a href={tool.website} target="_blank" rel="noopener noreferrer" className={cx(actionBase, actionClass.learn, 'h-11 w-full @xl:h-10')}>
            {PRIMARY_ACTION_LABELS.learn}
            <ActionArrow external />
            <span className="sr-only">über {tool.name} (öffnet in neuem Tab)</span>
          </a>
        ) : (
          <button
            type="button"
            aria-label={`${PRIMARY_ACTION_LABELS[action]}: ${tool.name}`}
            onClick={() => (action === 'connect' ? onConnect(tool) : onOpen(tool, action === 'manage' ? 'connection' : undefined))}
            className={cx(actionBase, actionClass[action], 'h-11 w-full @xl:h-10')}
          >
            {PRIMARY_ACTION_LABELS[action]}
            <ActionArrow />
          </button>
        )}
      </div>
    </article>
  );
}
