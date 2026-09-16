import type { AgentRuntime } from '../agents/runtime';
import { totalTokens } from '../models/types';
import { buildWorkflowAgentInput, workflowAgentDefinition, type UpstreamOutput } from './agent';
import { findWorkflowTool } from './executability';
import type { WorkflowAgentNode } from './types';

// Executors run one agent node. The live executor goes through the agent runtime (routing restricted to the tool's own
// models, budget gates, usage ledger); the demo executor is deterministic and never calls a model.

export interface WorkflowAgentStepRequest {
  projectId: string;
  project: { name: string; description: string };
  workflowName: string;
  goal: string;
  node: WorkflowAgentNode;
  upstream: readonly UpstreamOutput[];
  /** Remaining run budget reserved for this step. */
  budgetUsd: number;
  /** Registry models the node may use, preferred first (from the executability assessment). */
  modelIds: readonly string[];
  signal: AbortSignal;
}

export type WorkflowAgentStepResult =
  | { ok: true; content: string; summary: string; agentRunId: string | null; modelId: string | null; provider: string | null; costUsd: number; tokens: number }
  | { ok: false; kind: 'budget' | 'failed'; error: string; agentRunId: string | null; modelId: string | null; provider: string | null; costUsd: number; tokens: number };

export interface WorkflowAgentExecutor {
  execute(request: WorkflowAgentStepRequest): Promise<WorkflowAgentStepResult>;
}

export class LiveWorkflowExecutor implements WorkflowAgentExecutor {
  constructor(private readonly runtime: Pick<AgentRuntime, 'run'>) {}

  async execute(request: WorkflowAgentStepRequest): Promise<WorkflowAgentStepResult> {
    const { node } = request;
    if (request.modelIds.length === 0) {
      return { ok: false, kind: 'failed', error: 'Kein verfügbares Modell für dieses Tool.', agentRunId: null, modelId: null, provider: null, costUsd: 0, tokens: 0 };
    }
    const outcome = await this.runtime.run({
      definition: workflowAgentDefinition(node),
      role: node.role,
      input: buildWorkflowAgentInput({ project: request.project, workflowName: request.workflowName, goal: request.goal, node, upstream: request.upstream }),
      // No task and no pipeline run: the ledger rows are linked to the step through the agent run id.
      scope: { projectId: request.projectId, taskId: null, runId: null },
      complexity: 'medium',
      risk: 'low',
      pinnedModelId: request.modelIds[0]!,
      allowedModelIds: request.modelIds,
      runBudgetRemainingUsd: request.budgetUsd,
    });
    const model = outcome.model;
    const common = { agentRunId: outcome.agentRunId, modelId: model?.id ?? null, provider: model?.provider ?? null, costUsd: outcome.costUsd, tokens: totalTokens(outcome.usage) };
    if (outcome.ok) return { ok: true, content: outcome.output.content, summary: outcome.output.summary, ...common };
    const detail = outcome.issues.length > 0 ? `${outcome.error}: ${outcome.issues.join('; ')}` : outcome.error;
    return { ok: false, kind: outcome.kind === 'budget_paused' ? 'budget' : 'failed', error: detail.slice(0, 1000), ...common };
  }
}

/** FNV-1a, for deterministic choices from ids. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

const ROLE_FOCUS: Partial<Record<WorkflowAgentNode['role'], string>> = {
  researcher: 'Recherche-Notizen',
  planner: 'Strategie und Positionierung',
  architect: 'Struktur und Architektur',
  documentation: 'Texte und Inhalte',
  frontend: 'Gestaltungsbriefing',
  reviewer: 'Review-Hinweise',
};

const POINTS = [
  ['Zielgruppe und Kernbotschaft zusammengefasst', 'Drei Varianten zur Auswahl skizziert', 'Offene Fragen für die nächste Runde gesammelt'],
  ['Wichtigste Annahmen explizit markiert', 'Nächste Schritte priorisiert', 'Risiken und Abhängigkeiten benannt'],
  ['Entwurf in klare Abschnitte gegliedert', 'Tonalität an das Ziel angepasst', 'Übergabe an die folgenden Schritte vorbereitet'],
] as const;

/**
 * Demo mode (no real provider): deterministic placeholder output per node, clearly labelled, zero cost, no ledger rows.
 * The same node always produces the same text.
 */
export class DemoWorkflowExecutor implements WorkflowAgentExecutor {
  constructor(private readonly options: { latencyMs?: number } = {}) {}

  async execute(request: WorkflowAgentStepRequest): Promise<WorkflowAgentStepResult> {
    const { node } = request;
    if (this.options.latencyMs) await abortableDelay(this.options.latencyMs, request.signal);
    const toolName = findWorkflowTool(node.toolId)?.name ?? node.toolId;
    const focus = ROLE_FOCUS[node.role] ?? 'Ergebnis';
    const points = POINTS[hash(node.id) % POINTS.length]!;
    const inputs = request.upstream.filter((u) => u.status === 'succeeded').map((u) => u.label);
    const content = [
      `# ${node.label}: ${focus}`,
      '',
      '> Demo-Ausgabe – simuliert, kein Modellaufruf, keine Kosten.',
      '',
      `**Tool:** ${toolName} (Demo) · **Rolle:** ${node.role}`,
      inputs.length > 0 ? `**Eingaben:** ${inputs.join(', ')}` : '**Eingaben:** Workflow-Ziel',
      '',
      '## Ergebnis',
      ...points.map((point) => `- ${point}`),
    ].join('\n');
    return { ok: true, content, summary: `${focus} erstellt (Demo)`, agentRunId: null, modelId: null, provider: 'demo', costUsd: 0, tokens: 0 };
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
