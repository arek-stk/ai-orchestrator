import type { TaskStatus } from '../domain/enums';

export interface DagNode {
  id: string;
  dependencies: readonly string[];
}

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

/**
 * Returns the first dependency cycle found (e.g. ["a","b","c","a"]) or null.
 * Dependencies pointing outside the node set are ignored.
 */
export function findCycle(nodes: readonly DagNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Groups nodes into layers that can execute in parallel: every node's in-set dependencies
 * live in an earlier layer. Throws CycleError when the graph is not a DAG.
 */
export function parallelLayers(nodes: readonly DagNode[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const remainingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = new Set(node.dependencies.filter((d) => ids.has(d) && d !== node.id));
    remainingDeps.set(node.id, deps);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const layers: string[][] = [];
  let frontier = [...remainingDeps].filter(([, deps]) => deps.size === 0).map(([id]) => id);
  let placed = 0;

  while (frontier.length > 0) {
    frontier.sort();
    layers.push(frontier);
    placed += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of dependents.get(id) ?? []) {
        const deps = remainingDeps.get(dependent);
        if (!deps) continue;
        deps.delete(id);
        if (deps.size === 0) next.push(dependent);
      }
    }
    frontier = next;
  }

  if (placed !== nodes.length) {
    throw new CycleError(findCycle(nodes) ?? [...ids]);
  }
  return layers;
}

export function topologicalOrder(nodes: readonly DagNode[]): string[] {
  return parallelLayers(nodes).flat();
}

export interface DependencyState {
  ready: boolean;
  waitingOn: string[];
  missing: string[];
  failed: string[];
}

const FAILED_STATUSES: ReadonlySet<TaskStatus> = new Set(['FAILED', 'CANCELLED']);

export function dependencyState(
  dependencies: readonly string[],
  statusById: ReadonlyMap<string, TaskStatus>,
): DependencyState {
  const waitingOn: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const dep of dependencies) {
    const status = statusById.get(dep);
    if (status === undefined) missing.push(dep);
    else if (FAILED_STATUSES.has(status)) failed.push(dep);
    else if (status !== 'DONE') waitingOn.push(dep);
  }
  return { ready: waitingOn.length === 0 && missing.length === 0 && failed.length === 0, waitingOn, missing, failed };
}
