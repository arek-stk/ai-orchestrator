import { findSecrets } from '../security/secrets';
import type { ToolName } from '../tools/tool-router';
import { findWorkflowTool } from './executability';
import { WORKFLOW_LIMITS, WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowNode } from './types';

// Structural and semantic validation of a workflow definition. Messages are German because they are shown inline in the
// editor and in the code view; codes are stable for tests and clients.

export type WorkflowIssueSeverity = 'error' | 'warning';

export interface WorkflowIssue {
  severity: WorkflowIssueSeverity;
  code: string;
  message: string;
  /** JSON path into the definition, e.g. "nodes.3.maxTokens". */
  path: string | null;
  nodeId: string | null;
  edgeId: string | null;
}

export interface WorkflowValidation {
  /** Parsed definition (defaults applied) when the schema matched; semantic errors may still exist. */
  definition: WorkflowDefinition | null;
  issues: WorkflowIssue[];
  valid: boolean;
}

export interface ValidationOptions {
  /** Router tools a node may enable; toggles outside this set are errors. */
  availableTools?: ReadonlySet<ToolName>;
}

const issue = (severity: WorkflowIssueSeverity, code: string, message: string, extra: Partial<Pick<WorkflowIssue, 'path' | 'nodeId' | 'edgeId'>> = {}): WorkflowIssue => ({
  severity,
  code,
  message,
  path: extra.path ?? null,
  nodeId: extra.nodeId ?? null,
  edgeId: extra.edgeId ?? null,
});

/** Artifact names: relative, forward slashes, no traversal, limited characters (linear scan, no regex). */
export function isValidArtifactName(name: string): boolean {
  if (name.length === 0 || name.length > WORKFLOW_LIMITS.artifactNameLength) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  for (const segment of name.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    for (const char of segment) {
      const ok = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '-' || char === '_' || char === '.';
      if (!ok) return false;
    }
  }
  return true;
}

/** Normalises a user-entered "Ziel" into an artifact name: strips leading slashes, keeps safe characters. */
export function normalizeArtifactName(raw: string, fallback: string): string {
  let out = '';
  for (const char of raw.trim().slice(0, WORKFLOW_LIMITS.artifactNameLength * 2)) {
    const ok = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '-' || char === '_' || char === '.' || char === '/';
    out += ok ? char : '-';
  }
  const segments = out.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  const joined = segments.join('/').slice(0, WORKFLOW_LIMITS.artifactNameLength);
  return isValidArtifactName(joined) ? joined : fallback;
}

/** Kahn's algorithm; returns null when the graph has a cycle. Ties keep definition order (deterministic). */
export function workflowTopologicalOrder(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): string[] | null {
  const indegree = new Map(definition.nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>(definition.nodes.map((n) => [n.id, []]));
  for (const edge of definition.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const position = new Map(definition.nodes.map((n, i) => [n.id, i]));
  const ready = definition.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const target of outgoing.get(id)!) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return order.length === definition.nodes.length ? order : null;
}

export function predecessors(definition: Pick<WorkflowDefinition, 'edges'>, nodeId: string): string[] {
  return definition.edges.filter((e) => e.target === nodeId).map((e) => e.source);
}

/** All nodes reachable from `start` following edges (excluding `start`). */
export function descendants(definition: Pick<WorkflowDefinition, 'edges'>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
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

/** All nodes from which `start` is reachable (excluding `start`). */
export function ancestors(definition: Pick<WorkflowDefinition, 'edges'>, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of definition.edges) {
      if (edge.target === current && !seen.has(edge.source)) {
        seen.add(edge.source);
        stack.push(edge.source);
      }
    }
  }
  return seen;
}

function semanticIssues(definition: WorkflowDefinition, options: ValidationOptions): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodeIndex = new Map<string, number>();
  definition.nodes.forEach((node, index) => {
    if (nodeIndex.has(node.id)) issues.push(issue('error', 'duplicate_node_id', `Die Knoten-ID „${node.id}“ ist doppelt vergeben.`, { path: `nodes.${index}.id`, nodeId: node.id }));
    else nodeIndex.set(node.id, index);
  });

  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  definition.edges.forEach((edge, index) => {
    const at = { path: `edges.${index}`, edgeId: edge.id };
    if (edgeIds.has(edge.id)) issues.push(issue('error', 'duplicate_edge_id', `Die Kanten-ID „${edge.id}“ ist doppelt vergeben.`, at));
    edgeIds.add(edge.id);
    if (!nodeIndex.has(edge.source) || !nodeIndex.has(edge.target)) {
      issues.push(issue('error', 'dangling_edge', `Die Kante „${edge.id}“ verweist auf einen fehlenden Knoten.`, at));
      return;
    }
    if (edge.source === edge.target) issues.push(issue('error', 'self_loop', `Die Kante „${edge.id}“ verbindet einen Knoten mit sich selbst.`, at));
    const key = `${edge.source}->${edge.target}`;
    if (pairs.has(key)) issues.push(issue('error', 'duplicate_edge', `Die Verbindung ${edge.source} → ${edge.target} existiert doppelt.`, at));
    pairs.add(key);
  });

  const byType = (type: WorkflowNode['type']) => definition.nodes.filter((n) => n.type === type);
  const goals = byType('goal');
  const finales = byType('finale');
  if (definition.nodes.length === 0) {
    issues.push(issue('error', 'empty', 'Der Workflow enthält keine Knoten.'));
    return issues;
  }
  if (goals.length !== 1) issues.push(issue('error', 'goal_count', goals.length === 0 ? 'Ein Workflow braucht genau ein Ziel.' : 'Ein Workflow darf nur ein Ziel haben.'));
  if (finales.length !== 1) issues.push(issue('error', 'finale_count', finales.length === 0 ? 'Ein Workflow braucht genau ein Finale.' : 'Ein Workflow darf nur ein Finale haben.'));

  const validEdges = definition.edges.filter((e) => nodeIndex.has(e.source) && nodeIndex.has(e.target) && e.source !== e.target);
  const graph = { nodes: definition.nodes, edges: validEdges };
  const acyclic = workflowTopologicalOrder(graph) !== null;
  if (!acyclic) issues.push(issue('error', 'cycle', 'Der Workflow enthält einen Zyklus. Verbindungen müssen vom Ziel zum Finale fließen.'));

  const goal = goals[0];
  const finale = finales[0];
  if (goal && validEdges.some((e) => e.target === goal.id)) {
    issues.push(issue('error', 'goal_incoming', 'Das Ziel darf keine eingehenden Verbindungen haben.', { nodeId: goal.id }));
  }
  if (finale && validEdges.some((e) => e.source === finale.id)) {
    issues.push(issue('error', 'finale_outgoing', 'Das Finale darf keine ausgehenden Verbindungen haben.', { nodeId: finale.id }));
  }
  if (goal && goals.length === 1) {
    const reachable = descendants(graph, goal.id);
    if (finale && finales.length === 1 && !reachable.has(finale.id)) {
      issues.push(issue('error', 'finale_unreachable', 'Das Finale ist vom Ziel aus nicht erreichbar.', { nodeId: finale.id }));
    }
    for (const node of definition.nodes) {
      if (node.id !== goal.id && !reachable.has(node.id)) {
        issues.push(issue('error', 'node_unreachable', `„${node.label}“ ist vom Ziel aus nicht erreichbar.`, { nodeId: node.id, path: `nodes.${nodeIndex.get(node.id)}` }));
      }
    }
    if (finale && finales.length === 1 && acyclic) {
      const feedsFinale = ancestors(graph, finale.id);
      for (const node of definition.nodes) {
        if (node.id !== finale.id && reachable.has(node.id) && !feedsFinale.has(node.id)) {
          issues.push(issue('warning', 'dead_end', `Die Ausgabe von „${node.label}“ fließt nicht ins Finale.`, { nodeId: node.id }));
        }
      }
    }
  }

  definition.nodes.forEach((node, index) => {
    if (node.type !== 'agent' && node.type !== 'finale') return;
    const at = (field: string) => ({ path: `nodes.${index}.${field}`, nodeId: node.id });
    if (node.output.artifactName && !isValidArtifactName(node.output.artifactName)) {
      issues.push(issue('error', 'artifact_name', `„${node.label}“: Das Ziel muss ein relativer Artefaktname ohne „..“ sein (Buchstaben, Ziffern, - _ . /).`, at('output.artifactName')));
    }
    if (node.type !== 'agent') return;
    if (!findWorkflowTool(node.toolId)) issues.push(issue('error', 'unknown_tool', `„${node.label}“: Unbekanntes Tool „${node.toolId}“.`, at('toolId')));
    for (const tool of node.enabledTools) {
      if (!options.availableTools?.has(tool)) {
        issues.push(issue('error', 'tool_unavailable', `„${node.label}“: Das Werkzeug „${tool}“ ist für Workflows nicht verfügbar.`, at('enabledTools')));
      }
    }
    if (node.instructions.trim().length === 0) issues.push(issue('warning', 'empty_instructions', `„${node.label}“ hat keine Anweisungen.`, at('instructions')));
  });

  const goalNode = goal?.type === 'goal' ? goal : null;
  if (goalNode && goalNode.goal.trim().length === 0) issues.push(issue('warning', 'empty_goal', 'Das Ziel ist noch nicht beschrieben.', { nodeId: goalNode.id }));

  if (findSecrets(JSON.stringify(definition)).length > 0) {
    issues.push(issue('error', 'secret', 'Die Definition enthält einen Wert, der wie ein Geheimnis (API-Schlüssel, Token) aussieht. Zugangsdaten gehören in die Provider-Einstellungen.'));
  }
  return issues;
}

/** Validates untrusted input (API body or code view). */
export function validateWorkflowDefinition(raw: unknown, options: ValidationOptions = {}): WorkflowValidation {
  if (typeof raw === 'object' && raw !== null) {
    const nodes = (raw as { nodes?: unknown }).nodes;
    const edges = (raw as { edges?: unknown }).edges;
    if (Array.isArray(nodes) && nodes.length > WORKFLOW_LIMITS.maxNodes) {
      return { definition: null, valid: false, issues: [issue('error', 'too_many_nodes', `Höchstens ${WORKFLOW_LIMITS.maxNodes} Knoten sind erlaubt.`, { path: 'nodes' })] };
    }
    if (Array.isArray(edges) && edges.length > WORKFLOW_LIMITS.maxEdges) {
      return { definition: null, valid: false, issues: [issue('error', 'too_many_edges', `Höchstens ${WORKFLOW_LIMITS.maxEdges} Verbindungen sind erlaubt.`, { path: 'edges' })] };
    }
  }
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 50).map((i) => {
      const path = i.path.map(String).join('.');
      const nodeIndex = i.path[0] === 'nodes' && typeof i.path[1] === 'number' ? i.path[1] : null;
      const nodeId = nodeIndex !== null ? readId(raw, 'nodes', nodeIndex) : null;
      const edgeIndex = i.path[0] === 'edges' && typeof i.path[1] === 'number' ? i.path[1] : null;
      const edgeId = edgeIndex !== null ? readId(raw, 'edges', edgeIndex) : null;
      return issue('error', 'schema', `${path || 'Definition'}: ${i.message}`, { path: path || null, nodeId, edgeId });
    });
    return { definition: null, issues, valid: false };
  }
  const issues = semanticIssues(parsed.data, options);
  return { definition: parsed.data, issues, valid: !issues.some((i) => i.severity === 'error') };
}

function readId(raw: unknown, key: 'nodes' | 'edges', index: number): string | null {
  const list = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return null;
  const id = (list[index] as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id.slice(0, 40) : null;
}
