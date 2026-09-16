import { describe, expect, it } from 'vitest';
import { jsonErrorOffset, lineColumn, lineOfId, parseDefinitionText, serializeDefinition } from './code';
import { addAgent, addStructuralNode, autoLayout, canConnect, connect, disconnect, edgePath, graphBounds, moveNode, NODE_WIDTH, removeNode, sameDefinition, slug, topologicalOrder, updateNode } from './graph';
import { describeEvent, formatRemaining, nodeAccent, runProgress, stepLog } from './presentation';
import type { AgentNode, WorkflowDefinition, WorkflowStep } from './types';

const pos = { x: 0, y: 0 };

function base(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'ziel', type: 'goal', label: 'Ziel', position: pos, goal: 'Kampagne' },
      { id: 'finale', type: 'finale', label: 'Finale', position: { x: 0, y: 300 }, description: '', output: { format: 'markdown', artifactName: 'ergebnis' } },
    ],
    edges: [{ id: 'ziel--finale', source: 'ziel', target: 'finale' }],
  };
}

function step(nodeId: string, status: WorkflowStep['status'], extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: `s-${nodeId}`, runId: 'r', nodeId, nodeType: 'agent', status, reason: null, agentRunId: null, modelId: null, provider: null, costUsd: 0, tokens: 0, summary: null, attempts: 0, startedAt: null, finishedAt: null, ...extra };
}

describe('workflow graph editing', () => {
  it('adds agents with unique ids at a free position and connects them without cycles', () => {
    let def = base();
    const first = addAgent(def, { toolId: 'claude', toolName: 'Claude' });
    const second = addAgent(first.definition, { toolId: 'claude', toolName: 'Claude' });
    def = second.definition;
    expect(first.nodeId).toBe('claude-agent');
    expect(second.nodeId).toBe('claude-agent-2');
    const added = def.nodes.find((n) => n.id === first.nodeId)!;
    expect(added.position.x).toBeGreaterThanOrEqual(NODE_WIDTH);

    def = connect(def, 'ziel', first.nodeId).definition;
    def = connect(def, first.nodeId, second.nodeId).definition;
    expect(connect(def, second.nodeId, first.nodeId).error).toBe('cycle');
    expect(canConnect(def, first.nodeId, first.nodeId)).toBe('self');
    expect(canConnect(def, 'ziel', first.nodeId)).toBe('duplicate');
    expect(canConnect(def, first.nodeId, 'ziel')).toBe('goal_incoming');
    expect(canConnect(def, 'finale', first.nodeId)).toBe('finale_outgoing');
    expect(canConnect(def, second.nodeId, 'finale')).toBeNull();
    expect(topologicalOrder(def)).toEqual(['ziel', 'finale', 'claude-agent', 'claude-agent-2']);

    const edge = def.edges.find((e) => e.source === first.nodeId)!;
    expect(disconnect(def, edge.id).edges).toHaveLength(def.edges.length - 1);
    const removed = removeNode(def, first.nodeId);
    expect(removed.nodes.map((n) => n.id)).not.toContain(first.nodeId);
    expect(removed.edges.some((e) => e.source === first.nodeId || e.target === first.nodeId)).toBe(false);

    const structural = addStructuralNode(def, 'join');
    expect(structural.definition.nodes.find((n) => n.id === structural.nodeId)).toMatchObject({ type: 'join', label: 'Zusammenführung' });
  });

  it('updates and moves nodes immutably, keeps id and type, and clamps coordinates', () => {
    const def = base();
    const updated = updateNode(def, 'ziel', { label: 'Neues Ziel', id: 'hack', type: 'agent' } as never);
    expect(updated.nodes[0]).toMatchObject({ id: 'ziel', type: 'goal', label: 'Neues Ziel' });
    expect(def.nodes[0]!.label).toBe('Ziel');
    expect(moveNode(def, 'ziel', { x: 1e9, y: -3.6 }).nodes[0]!.position).toEqual({ x: 100_000, y: -4 });
    expect(sameDefinition(def, base())).toBe(true);
    expect(sameDefinition(def, updated)).toBe(false);
  });

  it('lays out layers top to bottom and computes bounds and edge paths', () => {
    let def = base();
    for (const tool of ['claude', 'chatgpt', 'gemini']) {
      const added = addAgent(def, { toolId: tool, toolName: tool });
      def = connect(connect(added.definition, 'ziel', added.nodeId).definition, added.nodeId, 'finale').definition;
    }
    const laid = autoLayout(def);
    const y = (id: string) => laid.nodes.find((n) => n.id === id)!.position.y;
    expect(y('ziel')).toBeLessThan(y('claude-agent'));
    expect(y('claude-agent')).toBe(y('gemini-agent'));
    expect(y('finale')).toBeGreaterThan(y('chatgpt-agent'));
    const xs = laid.nodes.filter((n) => n.type === 'agent').map((n) => n.position.x);
    expect(new Set(xs).size).toBe(3);
    const bounds = graphBounds(laid);
    expect(bounds.maxX - bounds.minX).toBeGreaterThanOrEqual(3 * NODE_WIDTH);
    const path = edgePath(laid.nodes[0]!, laid.nodes.find((n) => n.id === 'finale')!);
    expect(path.d.startsWith('M ')).toBe(true);
    expect(path.to.y).toBe(y('finale'));
  });

  it('slugs labels linearly, also for hostile input', () => {
    expect(slug('Strategy Agent (Größe)')).toBe('strategy-agent-groesse');
    const started = Date.now();
    expect(slug(`${'a!'.repeat(50_000)}`).length).toBeLessThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('workflow code view', () => {
  it('round-trips a definition through the canonical JSON form', () => {
    let def = base();
    const added = addAgent(def, { toolId: 'claude', toolName: 'Claude' });
    def = connect(added.definition, 'ziel', added.nodeId).definition;
    const text = serializeDefinition(def);
    const parsed = parseDefinitionText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(def);
    expect(serializeDefinition(parsed.value as WorkflowDefinition)).toBe(text);
    // Stable key order per node type, independent of the object's insertion order.
    const agent = def.nodes.find((n) => n.type === 'agent') as AgentNode;
    const shuffled = { ...def, nodes: def.nodes.map((n) => (n.id === agent.id ? { position: agent.position, tags: agent.tags, ...agent } : n)) };
    expect(serializeDefinition(shuffled)).toBe(text);
    expect(text.indexOf('"id": "claude-agent"')).toBeLessThan(text.indexOf('"toolId": "claude"'));
    expect(lineOfId(text, 'claude-agent')).toBeGreaterThan(1);
  });

  it('reports syntax errors with line and column and rejects non-definitions', () => {
    const broken = '{\n  "schemaVersion": 1,\n  "nodes": [,]\n}';
    const result = parseDefinitionText(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Ungültiges JSON');
      expect(result.error.line).toBe(3);
    }
    expect(parseDefinitionText('[]')).toMatchObject({ ok: false });
    expect(parseDefinitionText('{"nodes": {}, "edges": []}')).toMatchObject({ ok: false, error: { message: '„nodes“ und „edges“ müssen Listen sein.' } });
    expect(parseDefinitionText('   ')).toMatchObject({ ok: false, error: { message: 'Der Code ist leer.' } });
    expect(lineColumn('a\nbc\nd', 4)).toEqual({ line: 2, column: 3 });
    expect(jsonErrorOffset('{"a": [1, 2]}')).toBeNull();
    expect(jsonErrorOffset('{"a": 1,}')).toBe(8);
    expect(jsonErrorOffset('[1] x')).toBe(4);
    expect(jsonErrorOffset('['.repeat(10_000))).not.toBeNull();
  });
});

describe('workflow presentation', () => {
  it('computes progress and a remaining-time estimate only from measured steps', () => {
    const now = new Date('2026-09-16T10:10:00Z').getTime();
    expect(runProgress([step('a', 'pending'), step('b', 'running')], now)).toMatchObject({ done: 0, total: 2, remainingMs: null });
    const steps = [
      step('a', 'succeeded', { startedAt: '2026-09-16T10:00:00Z', finishedAt: '2026-09-16T10:02:00Z' }),
      step('b', 'running', { startedAt: '2026-09-16T10:09:00Z' }),
      step('c', 'pending'),
      step('d', 'skipped'),
    ];
    const progress = runProgress(steps, now);
    expect(progress).toMatchObject({ done: 2, total: 4, ratio: 0.5, remainingMs: 60_000 + 120_000 });
    expect(formatRemaining(progress.remainingMs)).toBe('~ 3 min');
    expect(formatRemaining(null)).toBe('Noch keine Schätzung');
  });

  it('orders the step log by time and describes events in German', () => {
    const nodes = base().nodes;
    const log = stepLog(
      [step('finale', 'succeeded', { finishedAt: '2026-09-16T10:05:00Z', summary: 'Ergebnisse zusammengeführt' }), step('ziel', 'skipped', { finishedAt: '2026-09-16T10:01:00Z', reason: 'nicht ausführbar' }), step('x', 'pending')],
      nodes,
    );
    expect(log.map((l) => [l.label, l.text])).toEqual([
      ['Ziel', 'nicht ausführbar'],
      ['Finale', 'Ergebnisse zusammengeführt'],
    ]);
    const labels = new Map([['ziel', 'Ziel']]);
    expect(describeEvent({ id: 1, type: 'workflow.step.updated', payload: { nodeId: 'ziel', status: 'running' }, createdAt: '' }, labels)).toBe('Ziel: In Bearbeitung');
    expect(describeEvent({ id: 2, type: 'workflow.run.created', payload: { status: 'blocked', mode: 'demo' }, createdAt: '' }, labels)).toBe('Lauf angelegt (Blockiert, Demo)');
    expect(nodeAccent({ ...(addAgent(base(), { toolId: 'unknown-tool', toolName: 'X' }).definition.nodes.at(-1) as AgentNode) })).toMatch(/^#[0-9a-f]{6}$/);
  });
});
