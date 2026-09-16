'use client';

import { Maximize2, Minus, Plus, Unlink, WandSparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { canConnect, CONNECT_ERRORS, edgePath, graphBounds, GRID, NODE_WIDTH, nodeHeight, snap } from '@/lib/workflows/graph';
import { nodeAccent, ROLE_LABELS } from '@/lib/workflows/presentation';
import type { NodeExecutability, Position, WorkflowDefinition, WorkflowNode, WorkflowStep } from '@/lib/workflows/types';
import { cx } from '../ui';
import { NodeAvatar, StepStatusLabel, Tag, toolShortName } from './parts';

// Hand-rolled canvas (ADR-031: no graph or drag-and-drop libraries): HTML node cards and SVG edges inside one transformed
// layer. Pan by dragging the background or scrolling, zoom with the controls or Ctrl/⌘ + wheel, drag nodes, drag from a
// node's lower port onto another node to connect, click an edge to remove it. Every action also exists in the outline.

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;
const PAD = 80;

export interface CanvasProps {
  definition: WorkflowDefinition;
  selectedId: string | null;
  steps: ReadonlyMap<string, WorkflowStep>;
  executability: Readonly<Record<string, NodeExecutability>>;
  readOnly: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Position) => void;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (edgeId: string) => void;
  onRemove: (id: string) => void;
  onLayout: () => void;
  onNotice: (message: string) => void;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function WorkflowCanvas(props: CanvasProps) {
  const { definition, selectedId, steps, executability, readOnly } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 24, k: 0.8 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [linking, setLinking] = useState<{ source: string; point: Position; target: string | null } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const fitted = useRef(false);

  const nodes = useMemo(
    () => definition.nodes.map((node) => (drag && drag.id === node.id ? { ...node, position: { x: node.position.x + drag.dx, y: node.position.y + drag.dy } } : node)),
    [definition.nodes, drag],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const bounds = useMemo(() => graphBounds({ ...definition, nodes }), [definition, nodes]);

  const toGraph = useCallback((clientX: number, clientY: number): Position => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const { x, y, k } = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - x) / k, y: (clientY - (rect?.top ?? 0) - y) / k };
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const b = graphBounds(definition);
    const width = b.maxX - b.minX + PAD * 2;
    const height = b.maxY - b.minY + PAD * 2;
    const k = clampZoom(Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1));
    setView({ k, x: (viewport.clientWidth - (b.maxX - b.minX) * k) / 2 - b.minX * k, y: (viewport.clientHeight - (b.maxY - b.minY) * k) / 2 - b.minY * k });
  }, [definition]);

  useEffect(() => {
    if (fitted.current || definition.nodes.length === 0) return;
    fitted.current = true;
    fit();
  }, [definition.nodes.length, fit]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = clientX !== undefined ? clientX - rect.left : rect.width / 2;
    const cy = clientY !== undefined ? clientY - rect.top : rect.height / 2;
    setView((current) => {
      const k = clampZoom(current.k * factor);
      const ratio = k / current.k;
      return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  }, []);

  // Non-passive wheel listener: Ctrl/⌘ + wheel (and trackpad pinch) zooms, plain wheel pans.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.0022), event.clientX, event.clientY);
      else setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Background drag pans the view.
  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-node-id],[data-edge-id],[data-canvas-control]')) return;
    props.onSelect(null);
    setSelectedEdge(null);
    const start = { x: event.clientX, y: event.clientY, view: viewRef.current };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setView({ ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y });
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: WorkflowNode) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-port]')) return;
    props.onSelect(node.id);
    setSelectedEdge(null);
    if (readOnly) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let moved = false;
    const move = (e: PointerEvent) => {
      const { k } = viewRef.current;
      const dx = (e.clientX - startX) / k;
      const dy = (e.clientY - startY) / k;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      setDrag({ id: node.id, dx, dy });
    };
    const up = (e: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!moved) return;
      const { k } = viewRef.current;
      props.onMove(node.id, { x: snap(node.position.x + (e.clientX - startX) / k), y: snap(node.position.y + (e.clientY - startY) / k) });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onPortPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: WorkflowNode) => {
    event.stopPropagation();
    if (readOnly || event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setLinking({ source: node.id, point: toGraph(event.clientX, event.clientY), target: null });
    const hit = (e: PointerEvent) => {
      const element = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.dataset.nodeId && el.dataset.nodeId !== node.id) as HTMLElement | undefined;
      return element?.dataset.nodeId ?? null;
    };
    const move = (e: PointerEvent) => setLinking({ source: node.id, point: toGraph(e.clientX, e.clientY), target: hit(e) });
    const up = (e: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      setLinking(null);
      const dropped = hit(e);
      if (dropped) props.onConnect(node.id, dropped);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, node: WorkflowNode) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      props.onSelect(node.id);
      return;
    }
    if (readOnly) return;
    const step = event.shiftKey ? GRID * 4 : GRID;
    const delta: Record<string, Position> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const move = delta[event.key];
    if (move) {
      event.preventDefault();
      props.onMove(node.id, { x: node.position.x + move.x, y: node.position.y + move.y });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      props.onRemove(node.id);
    }
  };

  useEffect(() => {
    if (!selectedEdge) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && !readOnly && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        props.onDisconnect(selectedEdge);
        setSelectedEdge(null);
      } else if (event.key === 'Escape') setSelectedEdge(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdge, readOnly, props]);

  const linkError = linking?.target ? canConnect(definition, linking.source, linking.target) : null;
  useEffect(() => {
    if (linkError && linking?.target) props.onNotice(CONNECT_ERRORS[linkError]);
    // Only announce when the hovered target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linking?.target, linkError]);

  const layerStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: '0 0' };
  const svgLeft = bounds.minX - PAD * 4;
  const svgTop = bounds.minY - PAD * 4;
  const svgWidth = bounds.maxX - bounds.minX + PAD * 8;
  const svgHeight = bounds.maxY - bounds.minY + PAD * 8;
  const edgeMid = selectedEdge ? definition.edges.find((e) => e.id === selectedEdge) : undefined;
  const midpoint = edgeMid && byId.get(edgeMid.source) && byId.get(edgeMid.target) ? edgePath(byId.get(edgeMid.source)!, byId.get(edgeMid.target)!) : null;

  return (
    <div
      ref={viewportRef}
      onPointerDown={onBackgroundPointerDown}
      className="wf-canvas relative h-full min-h-[480px] touch-none select-none overflow-hidden rounded-2xl border border-hub-line"
      aria-label="Workflow-Canvas. Tastatur: Tab zu einem Knoten, Pfeiltasten verschieben, Entf löscht. Vollständige Bearbeitung auch in der Gliederung."
      role="application"
    >
      <div className="absolute left-0 top-0" style={layerStyle}>
        <svg className="pointer-events-none absolute overflow-visible" style={{ left: svgLeft, top: svgTop, width: svgWidth, height: svgHeight }} viewBox={`${svgLeft} ${svgTop} ${svgWidth} ${svgHeight}`} aria-hidden="true">
          <defs>
            {definition.edges.map((edge) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const path = edgePath(source, target);
              return (
                <linearGradient key={edge.id} id={`wf-edge-${edge.id}`} gradientUnits="userSpaceOnUse" x1={path.from.x} y1={path.from.y} x2={path.to.x} y2={path.to.y}>
                  <stop offset="0" stopColor={nodeAccent(source)} />
                  <stop offset="1" stopColor={nodeAccent(target)} />
                </linearGradient>
              );
            })}
          </defs>
          {definition.edges.map((edge) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const path = edgePath(source, target);
            const active = steps.get(edge.target)?.status === 'running';
            const selected = selectedEdge === edge.id;
            return (
              <g key={edge.id}>
                <path d={path.d} fill="none" stroke={`url(#wf-edge-${edge.id})`} strokeWidth={selected ? 6 : 5} strokeOpacity={0.16} />
                <path d={path.d} fill="none" stroke={`url(#wf-edge-${edge.id})`} strokeWidth={selected ? 2.5 : 1.75} strokeDasharray={active ? '6 6' : undefined} className={active ? 'wf-flow' : undefined} />
                <circle cx={path.from.x} cy={path.from.y} r={3.5} fill={nodeAccent(source)} />
                <circle cx={path.to.x} cy={path.to.y} r={3.5} fill={nodeAccent(target)} />
                <path
                  data-edge-id={edge.id}
                  d={path.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setSelectedEdge(edge.id);
                    props.onSelect(null);
                  }}
                >
                  <title>{`${source.label} → ${target.label}`}</title>
                </path>
              </g>
            );
          })}
          {linking ? (
            (() => {
              const source = byId.get(linking.source);
              if (!source) return null;
              const from = { x: source.position.x + NODE_WIDTH / 2, y: source.position.y + nodeHeight(source) };
              const bend = Math.max(30, Math.abs(linking.point.y - from.y) / 2);
              return (
                <path
                  d={`M ${from.x} ${from.y} C ${from.x} ${from.y + bend}, ${linking.point.x} ${linking.point.y - bend}, ${linking.point.x} ${linking.point.y}`}
                  fill="none"
                  stroke={linkError ? 'var(--critical)' : nodeAccent(source)}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                />
              );
            })()
          ) : null}
        </svg>

        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selectedId === node.id}
            dragging={drag?.id === node.id}
            linkTarget={linking ? (linking.target === node.id ? (linkError ? 'invalid' : 'valid') : null) : null}
            step={steps.get(node.id)}
            executability={executability[node.id]}
            readOnly={readOnly}
            onPointerDown={(event) => onNodePointerDown(event, node)}
            onKeyDown={(event) => onNodeKeyDown(event, node)}
            onPortPointerDown={(event) => onPortPointerDown(event, node)}
          />
        ))}

        {midpoint && !readOnly ? (
          <button
            type="button"
            data-canvas-control
            onClick={() => {
              props.onDisconnect(selectedEdge!);
              setSelectedEdge(null);
            }}
            className="absolute inline-flex h-8 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border border-hub-line-strong bg-hub-card px-3 text-xs font-medium text-ink shadow-pop transition-[background-color] duration-150 ease-out hover:bg-hub-card-2"
            style={{ left: (midpoint.from.x + midpoint.to.x) / 2, top: (midpoint.from.y + midpoint.to.y) / 2 }}
          >
            <Unlink aria-hidden="true" size={13} />
            Verbindung entfernen
          </button>
        ) : null}
      </div>

      <Minimap definition={{ ...definition, nodes }} view={view} viewportRef={viewportRef} onJump={(x, y) => setView((current) => ({ ...current, x, y }))} />

      <div data-canvas-control className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-hub-line bg-hub-card/90 p-1 shadow-pop backdrop-blur">
        <CanvasButton label="Verkleinern" onClick={() => zoomAt(1 / 1.2)} icon={<Minus size={15} />} />
        <span className="tabular w-11 text-center text-xs text-ink-2" aria-live="polite">
          {Math.round(view.k * 100)}%
        </span>
        <CanvasButton label="Vergrößern" onClick={() => zoomAt(1.2)} icon={<Plus size={15} />} />
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-hub-line" />
        <CanvasButton label="Ansicht einpassen" onClick={fit} icon={<Maximize2 size={14} />} />
        {!readOnly ? <CanvasButton label="Automatisch anordnen" onClick={() => { props.onLayout(); requestAnimationFrame(fit); }} icon={<WandSparkles size={14} />} /> : null}
      </div>
    </div>
  );
}

function CanvasButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition-[background-color,color] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-hub-card-2 hover:text-ink"
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}

function statusLine(node: WorkflowNode, step: WorkflowStep | undefined, executability: NodeExecutability | undefined) {
  if (step && step.status !== 'pending') return <StepStatusLabel status={step.status} compact />;
  if (node.type === 'agent' && executability && !executability.executable) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-warning" title={executability.message}>
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <span className="truncate">{executability.message.replace('Nicht ausführbar – ', 'Nicht ausführbar · ')}</span>
      </span>
    );
  }
  if (step) return <StepStatusLabel status="pending" compact />;
  if (node.type === 'agent' && executability) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-hub-connected">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-hub-connected" />
        {executability.demo ? 'Ausführbar (Demo)' : 'Ausführbar'}
      </span>
    );
  }
  return null;
}

function NodeCard({
  node,
  selected,
  dragging,
  linkTarget,
  step,
  executability,
  readOnly,
  onPointerDown,
  onKeyDown,
  onPortPointerDown,
}: {
  node: WorkflowNode;
  selected: boolean;
  dragging: boolean;
  linkTarget: 'valid' | 'invalid' | null;
  step: WorkflowStep | undefined;
  executability: NodeExecutability | undefined;
  readOnly: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPortPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const accent = nodeAccent(node);
  const height = nodeHeight(node);
  const blocked = node.type === 'agent' && executability && !executability.executable;
  const subtitle = node.type === 'agent' ? toolShortName(node.toolId) : node.type === 'goal' ? null : null;
  const body =
    step?.summary && step.status === 'succeeded'
      ? step.summary
      : step?.reason && step.status !== 'pending'
        ? step.reason
        : node.type === 'goal'
          ? node.goal || 'Ziel beschreiben …'
          : node.type === 'agent'
            ? node.description || node.instructions || ROLE_LABELS[node.role]
            : node.description;
  const style: CSSProperties & Record<'--wf-accent', string> = {
    left: node.position.x,
    top: node.position.y,
    width: NODE_WIDTH,
    height,
    '--wf-accent': accent,
  };

  return (
    <div
      data-node-id={node.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.label}${subtitle ? `, ${subtitle}` : ''}${step ? `, ${step.status}` : ''}${blocked ? `, ${executability!.message}` : ''}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cx('wf-node group absolute flex flex-col rounded-2xl p-3 text-left outline-none', selected && 'wf-node-selected', dragging && 'wf-node-dragging', blocked && 'wf-node-blocked', linkTarget === 'valid' && 'wf-node-link-valid', linkTarget === 'invalid' && 'wf-node-link-invalid', readOnly ? 'cursor-default' : 'cursor-grab')}
      style={style}
    >
      {node.type !== 'goal' ? <span aria-hidden="true" data-port="in" className="wf-port absolute -top-[5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full" /> : null}
      <div className="flex min-w-0 items-center gap-2.5">
        <NodeAvatar node={node} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold leading-tight text-ink">{node.label}</p>
          <p className="truncate text-xs text-ink-2">{node.type === 'agent' ? toolShortName(node.toolId) : node.type === 'goal' ? 'Ziel' : node.type === 'orchestrator' ? 'Plant und koordiniert' : node.type === 'finale' ? 'Ergebnis' : 'Zusammenführung'}</p>
        </div>
      </div>
      {node.type === 'agent' && node.tags.length > 0 ? (
        <div className="mt-2 flex min-w-0 flex-wrap gap-1 overflow-hidden" style={{ maxHeight: 24 }}>
          {node.tags.slice(0, 3).map((tag) => (
            <Tag key={tag} className="h-[22px] text-[11px]">
              {tag}
            </Tag>
          ))}
        </div>
      ) : null}
      {node.type === 'agent' ? <div className="mt-2">{statusLine(node, step, executability)}</div> : null}
      {node.type === 'agent' ? <div aria-hidden="true" className="my-2 h-px bg-hub-line" /> : null}
      <p className={cx('min-w-0 text-[12px] leading-snug text-ink-2', node.type === 'agent' ? 'line-clamp-2' : 'mt-1.5 line-clamp-2')}>{body}</p>
      {node.type !== 'agent' && step && step.status !== 'pending' ? <div className="mt-auto pt-1">{statusLine(node, step, executability)}</div> : null}
      {step?.status === 'running' ? (
        <div className="mt-auto h-1 overflow-hidden rounded-full bg-hub-line" role="progressbar" aria-label={`${node.label} läuft`}>
          <div className="wf-indeterminate h-full w-1/3 rounded-full" style={{ background: accent }} />
        </div>
      ) : null}
      {node.type !== 'finale' ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-port="out"
          disabled={readOnly}
          onPointerDown={onPortPointerDown}
          title="Ziehen, um zu verbinden"
          className="wf-port wf-port-out absolute -bottom-[7px] left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full after:absolute after:-inset-2 after:content-['']"
        />
      ) : null}
    </div>
  );
}

function Minimap({ definition, view, viewportRef, onJump }: { definition: WorkflowDefinition; view: View; viewportRef: React.RefObject<HTMLDivElement | null>; onJump: (x: number, y: number) => void }) {
  const width = 168;
  const height = 112;
  const b = graphBounds(definition);
  const graphWidth = b.maxX - b.minX + PAD * 2;
  const graphHeight = b.maxY - b.minY + PAD * 2;
  const scale = Math.min(width / graphWidth, height / graphHeight);
  const offsetX = (width - graphWidth * scale) / 2 - (b.minX - PAD) * scale;
  const offsetY = (height - graphHeight * scale) / 2 - (b.minY - PAD) * scale;
  const viewport = viewportRef.current;
  const vw = (viewport?.clientWidth ?? 800) / view.k;
  const vh = (viewport?.clientHeight ?? 500) / view.k;
  const vx = -view.x / view.k;
  const vy = -view.y / view.k;

  return (
    <div data-canvas-control className="absolute bottom-3 left-3 hidden rounded-xl border border-hub-line bg-hub-card/90 p-1.5 shadow-pop backdrop-blur md:block">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Minimap: klicken, um den Ausschnitt zu verschieben"
        className="cursor-pointer"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const gx = (event.clientX - rect.left - offsetX) / scale;
          const gy = (event.clientY - rect.top - offsetY) / scale;
          const k = view.k;
          onJump(-(gx - vw / 2) * k, -(gy - vh / 2) * k);
        }}
      >
        {definition.edges.map((edge) => {
          const s = definition.nodes.find((n) => n.id === edge.source);
          const t = definition.nodes.find((n) => n.id === edge.target);
          if (!s || !t) return null;
          return (
            <line
              key={edge.id}
              x1={offsetX + (s.position.x + NODE_WIDTH / 2) * scale}
              y1={offsetY + (s.position.y + nodeHeight(s)) * scale}
              x2={offsetX + (t.position.x + NODE_WIDTH / 2) * scale}
              y2={offsetY + t.position.y * scale}
              stroke={nodeAccent(s)}
              strokeOpacity={0.55}
              strokeWidth={1}
            />
          );
        })}
        {definition.nodes.map((node) => (
          <rect key={node.id} x={offsetX + node.position.x * scale} y={offsetY + node.position.y * scale} width={NODE_WIDTH * scale} height={nodeHeight(node) * scale} rx={2} fill={nodeAccent(node)} fillOpacity={0.35} stroke={nodeAccent(node)} strokeWidth={0.75} />
        ))}
        <rect x={offsetX + vx * scale} y={offsetY + vy * scale} width={vw * scale} height={vh * scale} fill="none" stroke="var(--hub-cta)" strokeWidth={1.25} rx={3} />
      </svg>
    </div>
  );
}
