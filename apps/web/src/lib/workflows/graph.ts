// Pure editing operations on a workflow definition. Every function returns a new definition (immutable updates), so the
// editor can diff against the saved version for its dirty state. The server re-validates everything on save.

import type { AgentNode, AgentRole, Position, WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT: Record<WorkflowNode['type'], number> = { goal: 92, orchestrator: 92, agent: 184, join: 100, finale: 100 };
const COLUMN_GAP = 36;
const ROW_GAP = 64;
export const GRID = 12;

export function nodeHeight(node: Pick<WorkflowNode, 'type'>): number {
  return NODE_HEIGHT[node.type];
}

/** Kahn's algorithm (definition order for ties); null on a cycle. */
export function topologicalOrder(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): string[] | null {
  const indegree = new Map(definition.nodes.map((n) => [n.id, 0]));
  for (const edge of definition.edges) if (indegree.has(edge.target) && indegree.has(edge.source)) indegree.set(edge.target, indegree.get(edge.target)! + 1);
  const position = new Map(definition.nodes.map((n, i) => [n.id, i]));
  const ready = definition.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const edge of definition.edges) {
      if (edge.source !== id || !indegree.has(edge.target)) continue;
      const next = indegree.get(edge.target)! - 1;
      indegree.set(edge.target, next);
      if (next === 0) ready.push(edge.target);
    }
  }
  return order.length === definition.nodes.length ? order : null;
}

export function reachable(definition: Pick<WorkflowDefinition, 'edges'>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of definition.edges) {
      if (edge.source === current && !seen.has(edge.target)) {
        seen.add(edge.target);
        stack.push(edge.target);
      }
    }
  }
  return seen;
}

export type ConnectError = 'self' | 'duplicate' | 'cycle' | 'goal_incoming' | 'finale_outgoing' | 'missing' | 'limit';

export const CONNECT_ERRORS: Record<ConnectError, string> = {
  self: 'Ein Knoten kann nicht mit sich selbst verbunden werden.',
  duplicate: 'Diese Verbindung existiert bereits.',
  cycle: 'Diese Verbindung würde einen Zyklus erzeugen.',
  goal_incoming: 'Das Ziel kann keine eingehenden Verbindungen haben.',
  finale_outgoing: 'Das Finale kann keine ausgehenden Verbindungen haben.',
  missing: 'Einer der Knoten existiert nicht mehr.',
  limit: 'Die maximale Anzahl an Verbindungen ist erreicht.',
};

export function canConnect(definition: WorkflowDefinition, source: string, target: string, maxEdges = 120): ConnectError | null {
  const from = definition.nodes.find((n) => n.id === source);
  const to = definition.nodes.find((n) => n.id === target);
  if (!from || !to) return 'missing';
  if (source === target) return 'self';
  if (to.type === 'goal') return 'goal_incoming';
  if (from.type === 'finale') return 'finale_outgoing';
  if (definition.edges.some((e) => e.source === source && e.target === target)) return 'duplicate';
  if (reachable(definition, target).has(source)) return 'cycle';
  if (definition.edges.length >= maxEdges) return 'limit';
  return null;
}

function uniqueId(existing: Iterable<string>, base: string): string {
  const taken = new Set(existing);
  const clean = slug(base) || 'knoten';
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean.slice(0, 36)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${clean.slice(0, 20)}-${Date.now().toString(36)}`;
}

/** Linear ASCII slug for ids (1–40 chars of a-z0-9_-). */
export function slug(text: string): string {
  const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
  let out = '';
  let dash = false;
  for (const raw of text.toLowerCase()) {
    const char = map[raw] ?? raw;
    const ok = /^[a-z0-9]+$/.test(char);
    if (ok) {
      out += char;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += '-';
      dash = true;
    }
    if (out.length >= 40) break;
  }
  return out.replace(/-+$/, '').slice(0, 40);
}

export function connect(definition: WorkflowDefinition, source: string, target: string): { definition: WorkflowDefinition; error: ConnectError | null } {
  const error = canConnect(definition, source, target);
  if (error) return { definition, error };
  const edge: WorkflowEdge = { id: uniqueId(definition.edges.map((e) => e.id), `${source}--${target}`.slice(0, 40)), source, target };
  return { definition: { ...definition, edges: [...definition.edges, edge] }, error: null };
}

export function disconnect(definition: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  return { ...definition, edges: definition.edges.filter((e) => e.id !== edgeId) };
}

export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.filter((n) => n.id !== nodeId), edges: definition.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) };
}

export function updateNode(definition: WorkflowDefinition, nodeId: string, patch: Partial<WorkflowNode>): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch, id: n.id, type: n.type } as WorkflowNode) : n)) };
}

export function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

export function moveNode(definition: WorkflowDefinition, nodeId: string, position: Position): WorkflowDefinition {
  const clamp = (v: number) => Math.max(-100_000, Math.min(100_000, Math.round(v)));
  return updateNode(definition, nodeId, { position: { x: clamp(position.x), y: clamp(position.y) } });
}

/** A free spot right of the existing graph's middle row, so a new node never lands on top of another. */
export function freePosition(definition: WorkflowDefinition): Position {
  if (definition.nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...definition.nodes.map((n) => n.position.x));
  const minY = Math.min(...definition.nodes.map((n) => n.position.y));
  const maxY = Math.max(...definition.nodes.map((n) => n.position.y));
  return { x: snap(maxX + NODE_WIDTH + COLUMN_GAP * 2), y: snap((minY + maxY) / 2) };
}

export function addAgent(
  definition: WorkflowDefinition,
  input: { toolId: string; toolName: string; role?: AgentRole; label?: string },
): { definition: WorkflowDefinition; nodeId: string } {
  const label = (input.label ?? `${input.toolName} Agent`).slice(0, 60);
  const id = uniqueId(definition.nodes.map((n) => n.id), label);
  const node: AgentNode = {
    id,
    type: 'agent',
    label,
    position: freePosition(definition),
    role: input.role ?? 'researcher',
    toolId: input.toolId,
    model: null,
    temperature: 0.7,
    maxTokens: 2000,
    enabledTools: [],
    output: { format: 'markdown', artifactName: '' },
    instructions: '',
    description: '',
    tags: [],
  };
  return { definition: { ...definition, nodes: [...definition.nodes, node] }, nodeId: id };
}

export function addStructuralNode(definition: WorkflowDefinition, type: 'orchestrator' | 'join'): { definition: WorkflowDefinition; nodeId: string } {
  const label = type === 'orchestrator' ? 'KI-Orchestrator' : 'Zusammenführung';
  const id = uniqueId(definition.nodes.map((n) => n.id), label);
  const node: WorkflowNode = type === 'orchestrator' ? { id, type, label, position: freePosition(definition), description: '' } : { id, type, label, position: freePosition(definition), description: '' };
  return { definition: { ...definition, nodes: [...definition.nodes, node] }, nodeId: id };
}

/** Layered layout: longest path from a source decides the row; rows are centred; definition order is kept per row. */
export function autoLayout(definition: WorkflowDefinition): WorkflowDefinition {
  const order = topologicalOrder(definition);
  if (!order) return definition;
  const layer = new Map<string, number>();
  for (const id of order) {
    const incoming = definition.edges.filter((e) => e.target === id && layer.has(e.source)).map((e) => layer.get(e.source)! + 1);
    layer.set(id, incoming.length > 0 ? Math.max(...incoming) : 0);
  }
  const rows: WorkflowNode[][] = [];
  for (const node of definition.nodes) {
    const index = layer.get(node.id) ?? 0;
    (rows[index] ??= []).push(node);
  }
  const widest = Math.max(1, ...rows.map((row) => row?.length ?? 0));
  const totalWidth = widest * NODE_WIDTH + (widest - 1) * COLUMN_GAP;
  const positions = new Map<string, Position>();
  let y = 0;
  for (const row of rows) {
    if (!row) continue;
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * COLUMN_GAP;
    const offset = (totalWidth - rowWidth) / 2;
    row.forEach((node, column) => positions.set(node.id, { x: Math.round(offset + column * (NODE_WIDTH + COLUMN_GAP)), y }));
    y += Math.max(...row.map(nodeHeight)) + ROW_GAP;
  }
  return { ...definition, nodes: definition.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function graphBounds(definition: WorkflowDefinition): Bounds {
  if (definition.nodes.length === 0) return { minX: 0, minY: 0, maxX: NODE_WIDTH, maxY: 100 };
  return {
    minX: Math.min(...definition.nodes.map((n) => n.position.x)),
    minY: Math.min(...definition.nodes.map((n) => n.position.y)),
    maxX: Math.max(...definition.nodes.map((n) => n.position.x + NODE_WIDTH)),
    maxY: Math.max(...definition.nodes.map((n) => n.position.y + nodeHeight(n))),
  };
}

/** Cubic edge path from the bottom centre of the source to the top centre of the target. */
export function edgePath(source: WorkflowNode, target: WorkflowNode): { d: string; from: Position; to: Position } {
  const from = { x: source.position.x + NODE_WIDTH / 2, y: source.position.y + nodeHeight(source) };
  const to = { x: target.position.x + NODE_WIDTH / 2, y: target.position.y };
  const bend = Math.max(36, Math.abs(to.y - from.y) / 2);
  return { d: `M ${from.x} ${from.y} C ${from.x} ${from.y + bend}, ${to.x} ${to.y - bend}, ${to.x} ${to.y}`, from, to };
}

/** Structural equality used for the dirty state (key order independent through the canonical serializer). */
export function sameDefinition(a: WorkflowDefinition, b: WorkflowDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
