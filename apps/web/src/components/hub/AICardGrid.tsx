'use client';

import type { Ref } from 'react';
import type { ConnectionMap } from '@/lib/hub/filter';
import type { AITool } from '@/lib/hub/types';
import { AICard, type CardHandlers } from './AICard';

/** Container-query grid: 1 column on phones, 2 on tablets, 3–4 next to the detail panel on wide screens. */
export function AICardGrid({
  tools,
  connections,
  selectedId,
  canDisconnect,
  listRef,
  ...handlers
}: CardHandlers & {
  tools: AITool[];
  connections: ConnectionMap;
  selectedId: string | null;
  canDisconnect: (tool: AITool) => boolean;
  listRef?: Ref<HTMLUListElement>;
}) {
  return (
    <div className="@container">
      <ul ref={listRef} aria-label="KI-Tools" className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4">
        {tools.map((tool) => (
          <li key={tool.id} className="min-w-0">
            <AICard tool={tool} connection={connections.get(tool.id)} selected={tool.id === selectedId} showDisconnect={canDisconnect(tool)} {...handlers} />
          </li>
        ))}
      </ul>
    </div>
  );
}
