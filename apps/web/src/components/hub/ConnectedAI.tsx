'use client';

import { Plus } from 'lucide-react';
import type { ConnectionMap } from '@/lib/hub/filter';
import type { AITool } from '@/lib/hub/types';
import { Skeleton } from '../ui';
import { LogoTile } from './primitives';

/** "Meine KI": what is connected right now, plus a shortcut to the tools that are not. */
export function ConnectedAI({ tools, connections, loading, onOpen, onAdd }: { tools: AITool[]; connections: ConnectionMap; loading: boolean; onOpen: (tool: AITool) => void; onAdd: () => void }) {
  const connected = tools.filter((tool) => connections.get(tool.id)?.status === 'connected');

  return (
    <section aria-labelledby="hub-my-ai" className="flex flex-col gap-3 rounded-2xl border border-hub-line bg-hub-card px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex shrink-0 items-center gap-2.5">
        <h2 id="hub-my-ai" className="text-[13px] font-semibold text-ink">
          Meine KI
        </h2>
        {loading ? (
          <Skeleton className="h-6 w-20 rounded-full" />
        ) : (
          <span className="tabular inline-flex h-6 items-center gap-1.5 rounded-full bg-hub-connected-soft px-2 text-xs font-medium text-hub-connected">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-hub-connected" />
            {connected.length} verbunden
          </span>
        )}
      </div>

      <div className="hub-scroll-x -mx-4 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {loading ? (
          <>
            <Skeleton className="h-8 w-28 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </>
        ) : connected.length === 0 ? (
          <p className="text-[13px] text-ink-2">Noch keine KI verbunden.</p>
        ) : (
          <ul className="flex items-center gap-1.5">
            {connected.map((tool) => (
              <li key={tool.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onOpen(tool)}
                  className="relative inline-flex h-8 items-center gap-2 rounded-full border border-hub-line bg-hub-card-2 pl-1 pr-3 text-[13px] text-ink transition-[border-color] duration-150 ease-out after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] hover:border-hub-connected-line"
                >
                  <LogoTile logo={tool.logo} name={tool.name} size="xs" className="!rounded-full" />
                  {tool.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 self-start rounded-xl border border-dashed border-hub-line-strong px-3.5 text-[13px] font-medium text-ink transition-[border-color,background-color] duration-150 ease-out hover:border-hub-cta hover:bg-hub-card-2 sm:self-auto"
      >
        <Plus aria-hidden="true" size={15} />
        KI hinzufügen
      </button>
    </section>
  );
}
