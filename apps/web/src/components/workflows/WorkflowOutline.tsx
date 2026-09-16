'use client';

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Link2, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { canConnect, CONNECT_ERRORS, GRID, topologicalOrder } from '@/lib/workflows/graph';
import { NODE_TYPE_LABELS } from '@/lib/workflows/presentation';
import type { NodeExecutability, Position, WorkflowDefinition, WorkflowNode, WorkflowStep } from '@/lib/workflows/types';
import { cx } from '../ui';
import { NodeAvatar, StepStatusLabel, toolShortName } from './parts';

// Keyboard- and screen-reader-friendly equivalent of the canvas: every node with its connections, and buttons to select,
// move, connect, disconnect and delete. On phones this is the primary editor.

export interface OutlineProps {
  definition: WorkflowDefinition;
  selectedId: string | null;
  steps: ReadonlyMap<string, WorkflowStep>;
  executability: Readonly<Record<string, NodeExecutability>>;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, position: Position) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (edgeId: string) => void;
  onRemove: (id: string) => void;
}

export function WorkflowOutline(props: OutlineProps) {
  const { definition } = props;
  const order = topologicalOrder(definition);
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  // Topological order reads like the flow; with a cycle (invalid) fall back to definition order.
  const nodes = order ? order.map((id) => byId.get(id)!) : definition.nodes;

  return (
    <ol aria-label="Workflow-Gliederung" className="flex flex-col gap-2">
      {nodes.map((node, index) => (
        <OutlineItem key={node.id} index={index} node={node} {...props} />
      ))}
    </ol>
  );
}

function OutlineItem({ node, index, definition, selectedId, steps, executability, readOnly, onSelect, onMove, onConnect, onDisconnect, onRemove }: OutlineProps & { node: WorkflowNode; index: number }) {
  const selectId = useId();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const outgoing = definition.edges.filter((e) => e.source === node.id);
  const incoming = definition.edges.filter((e) => e.target === node.id);
  const label = (id: string) => definition.nodes.find((n) => n.id === id)?.label ?? id;
  const candidates = definition.nodes.filter((n) => n.id !== node.id && canConnect(definition, node.id, n.id) === null);
  const step = steps.get(node.id);
  const exec = executability[node.id];
  const selected = selectedId === node.id;

  const move = (dx: number, dy: number) => onMove(node.id, { x: node.position.x + dx, y: node.position.y + dy });

  return (
    <li className={cx('rounded-2xl border bg-hub-card p-3 transition-[border-color] duration-150 ease-out', selected ? 'border-hub-cta' : 'border-hub-line')}>
      <div className="flex min-w-0 items-start gap-3">
        <NodeAvatar node={node} size="sm" />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onSelect(node.id)} aria-pressed={selected} className="block max-w-full truncate text-left text-[14px] font-semibold text-ink underline-offset-2 hover:underline">
            <span className="sr-only">Schritt {index + 1}: </span>
            {node.label}
          </button>
          <p className="truncate text-xs text-ink-2">
            {NODE_TYPE_LABELS[node.type]}
            {node.type === 'agent' ? ` · ${toolShortName(node.toolId)}` : ''}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {step ? <StepStatusLabel status={step.status} compact /> : null}
            {exec && !exec.executable ? <span className="text-xs font-medium text-warning">{exec.message}</span> : null}
          </div>
        </div>
        {!readOnly ? (
          <button
            type="button"
            onClick={() => onRemove(node.id)}
            aria-label={`${node.label} löschen`}
            className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-[background-color,color] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-critical-soft hover:text-critical"
          >
            <Trash2 aria-hidden="true" size={15} />
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-2">Eingänge</p>
          <p className="mt-0.5 break-words text-ink">{incoming.length > 0 ? incoming.map((e) => label(e.source)).join(', ') : '–'}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-2">Ausgänge</p>
          {outgoing.length === 0 ? <p className="mt-0.5 text-ink">–</p> : null}
          <ul className="mt-0.5 flex flex-wrap gap-1.5">
            {outgoing.map((edge) => (
              <li key={edge.id} className="inline-flex h-7 items-center gap-1 rounded-full border border-hub-line bg-hub-card-2 pl-2.5 pr-1 text-xs text-ink">
                {label(edge.target)}
                {!readOnly ? (
                  <button type="button" onClick={() => onDisconnect(edge.id)} aria-label={`Verbindung ${node.label} → ${label(edge.target)} entfernen`} className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-2 hover:bg-hub-line hover:text-ink">
                    <X aria-hidden="true" size={12} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!readOnly ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {node.type !== 'finale' ? (
            <form
              className="flex min-w-0 flex-1 items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!target) return;
                const problem = canConnect(definition, node.id, target);
                if (problem) {
                  setError(CONNECT_ERRORS[problem]);
                  return;
                }
                setError(null);
                onConnect(node.id, target);
                setTarget('');
              }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label htmlFor={selectId} className="text-xs font-medium text-ink-2">
                  Verbinden mit
                </label>
                <select id={selectId} value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-full min-w-0 rounded-[10px] border border-hub-line bg-hub-card-2 px-2 text-[13px] text-ink">
                  <option value="">Knoten wählen …</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={!target} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hub-line-strong px-3 text-[13px] font-medium text-ink hover:bg-hub-card-2 disabled:opacity-50">
                <Link2 aria-hidden="true" size={14} />
                Verbinden
              </button>
            </form>
          ) : null}
          <div role="group" aria-label={`${node.label} auf dem Canvas verschieben`} className="flex shrink-0 items-center gap-1">
            {[
              { label: 'nach links', icon: ArrowLeft, dx: -GRID * 4, dy: 0 },
              { label: 'nach oben', icon: ArrowUp, dx: 0, dy: -GRID * 4 },
              { label: 'nach unten', icon: ArrowDown, dx: 0, dy: GRID * 4 },
              { label: 'nach rechts', icon: ArrowRight, dx: GRID * 4, dy: 0 },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => move(action.dx, action.dy)}
                aria-label={`${node.label} ${action.label} verschieben`}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-hub-line text-ink-2 transition-[background-color,color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink"
              >
                <action.icon aria-hidden="true" size={14} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-critical">
          {error}
        </p>
      ) : null}
    </li>
  );
}
