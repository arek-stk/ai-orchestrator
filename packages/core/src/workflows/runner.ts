import { systemClock, type Clock, type EventRecorder, type JobQueue, type ProjectRepository } from '../ports';
import type { PostMessageInput } from '../room/types';
import type { ToolName } from '../tools/tool-router';
import { upstreamOf, type UpstreamOutput } from './agent';
import { assessWorkflow, workflowBlockers, type ExecutabilityEnvironment, type NodeExecutability } from './executability';
import type { WorkflowAgentExecutor, WorkflowAgentStepResult } from './executors';
import {
  ACTIVE_WORKFLOW_RUN_STATUSES,
  TERMINAL_WORKFLOW_STEP_STATUSES,
  WORKFLOW_LIMITS,
  type NewWorkflowStep,
  type NonExecutablePolicy,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowOutputFormat,
  type WorkflowRun,
  type WorkflowRunLimits,
  type WorkflowRunMode,
  type WorkflowRunRepository,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepStatus,
} from './types';
import { ancestors, descendants, predecessors, validateWorkflowDefinition, workflowTopologicalOrder, type WorkflowIssue } from './validation';

// Executes workflow runs (docs/plans/workflows.md §3): one durable job per run, topological order, bounded parallelism,
// cost and time caps, honest handling of non-executable nodes, artifacts per step, content-free events, room notices.

export const WORKFLOW_RUN_JOB = 'workflow.run';

export class WorkflowValidationError extends Error {
  constructor(readonly issues: WorkflowIssue[]) {
    super('workflow definition is invalid');
    this.name = 'WorkflowValidationError';
  }
}

/** Active autopilot session as the runner needs it (ADR-034). */
export interface WorkflowSessionInfo {
  id: string;
  remainingBudgetUsd: number;
  endsAt: Date;
}

export interface WorkflowSessionPort {
  activeForProject(projectId: string): Promise<WorkflowSessionInfo | null>;
  /** Current status of the session, e.g. `active`, `stopped`, `killed`. */
  status(sessionId: string): Promise<string | null>;
}

export interface WorkflowRunnerDeps {
  runs: WorkflowRunRepository;
  projects: Pick<ProjectRepository, 'get'>;
  events: EventRecorder;
  queue: JobQueue;
  executors: Record<WorkflowRunMode, WorkflowAgentExecutor>;
  environment: (mode: WorkflowRunMode) => Promise<ExecutabilityEnvironment>;
  availableTools: () => ReadonlySet<ToolName>;
  room?: { post(input: PostMessageInput): Promise<unknown> };
  sessions?: WorkflowSessionPort;
  clock?: Clock;
  onError?: (error: unknown, context: string) => void;
}

export interface StartWorkflowRunInput {
  workflow: Workflow;
  mode: WorkflowRunMode;
  onNonExecutable: NonExecutablePolicy;
  startedBy: string | null;
  limits?: { maxParallel?: number; maxCostUsd?: number; maxDurationMinutes?: number };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const usd = (value: number) => `$${value.toFixed(2)}`;

/** Resolves requested limits against the instance maximum and an active autopilot session. */
export function resolveWorkflowLimits(requested: StartWorkflowRunInput['limits'] = {}, session: WorkflowSessionInfo | null, now: Date): WorkflowRunLimits {
  const maxParallel = Math.trunc(clamp(requested.maxParallel ?? WORKFLOW_LIMITS.defaultParallel, 1, WORKFLOW_LIMITS.maxParallel));
  let maxCostUsd = clamp(requested.maxCostUsd ?? WORKFLOW_LIMITS.defaultMaxCostUsd, 0, WORKFLOW_LIMITS.maxCostUsd);
  let maxDurationMs = clamp(requested.maxDurationMinutes ?? WORKFLOW_LIMITS.defaultMaxDurationMinutes, 1, WORKFLOW_LIMITS.maxDurationMinutes) * 60_000;
  if (session) {
    maxCostUsd = Math.max(0, Math.min(maxCostUsd, session.remainingBudgetUsd));
    maxDurationMs = Math.max(0, Math.min(maxDurationMs, session.endsAt.getTime() - now.getTime()));
  }
  return { maxParallel, maxCostUsd, maxDurationMs };
}

/**
 * Nodes that may start now: pending, every ancestor terminal (not only the direct predecessors: a skipped step passes its
 * inputs through, so a join behind it must wait for them), in topological order, at most the free slots. Pure.
 */
export function readyWorkflowNodes(definition: WorkflowDefinition, states: ReadonlyMap<string, WorkflowStepStatus>, running: number, maxParallel: number): string[] {
  const free = maxParallel - running;
  if (free <= 0) return [];
  const order = workflowTopologicalOrder(definition) ?? [];
  const ready: string[] = [];
  for (const id of order) {
    if (states.get(id) !== 'pending') continue;
    if ([...ancestors(definition, id)].every((p) => TERMINAL_WORKFLOW_STEP_STATUSES.has(states.get(p) ?? 'pending'))) ready.push(id);
    if (ready.length >= free) break;
  }
  return ready;
}

/** Final run status from step states (never "succeeded" when anything was skipped or failed). */
export function workflowRunOutcome(steps: readonly Pick<WorkflowStep, 'status'>[], capReason: string | null): WorkflowRunStatus {
  if (capReason || steps.some((s) => s.status === 'blocked')) return 'blocked';
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'skipped' || s.status === 'cancelled' || s.status === 'pending')) return 'partial';
  return 'succeeded';
}

interface NodeOutput {
  content: string;
  format: WorkflowOutputFormat;
}

export class WorkflowRunner {
  private readonly clock: Clock;

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  private report(error: unknown, context: string): void {
    this.deps.onError?.(error, context);
  }

  private async emitStep(run: WorkflowRun, nodeId: string, status: WorkflowStepStatus): Promise<void> {
    await this.deps.events.emit({
      type: 'workflow.step.updated',
      projectId: run.projectId,
      taskId: null,
      runId: null,
      payload: { workflowRunId: run.id, workflowId: run.workflowId, nodeId, status },
    });
  }

  private async notifyRoom(run: WorkflowRun, phase: 'started' | 'finished', body: string): Promise<void> {
    if (!this.deps.room) return;
    try {
      await this.deps.room.post({
        projectId: run.projectId,
        author: { type: 'orchestrator', id: null, name: 'Orchestrator' },
        intent: 'status',
        body,
        refs: { workflowId: run.workflowId, workflowRunId: run.id },
        dedupeKey: `workflow-run:${run.id}:${phase}`,
      });
    } catch (error) {
      // Room notices are informational; they never fail a run.
      this.report(error, 'workflow room notice');
    }
  }

  private async finish(run: WorkflowRun, status: WorkflowRunStatus, reason: string | null): Promise<WorkflowRun> {
    const steps = await this.deps.runs.listSteps(run.id);
    const costUsd = steps.reduce((sum, s) => sum + s.costUsd, 0);
    const tokens = steps.reduce((sum, s) => sum + s.tokens, 0);
    const updated = (await this.deps.runs.update(run.id, { status, reason, costUsd, tokens, finishedAt: this.clock.now() }, ACTIVE_WORKFLOW_RUN_STATUSES)) ?? (await this.deps.runs.get(run.id)) ?? run;
    await this.deps.events.emit({
      type: 'workflow.run.finished',
      projectId: run.projectId,
      taskId: null,
      runId: null,
      payload: { workflowRunId: run.id, workflowId: run.workflowId, status: updated.status, costUsd: updated.costUsd, tokens: updated.tokens },
    });
    const done = steps.filter((s) => s.status === 'succeeded').length;
    const label = STATUS_TEXT[updated.status];
    const cost = updated.mode === 'demo' ? 'Demo, keine Kosten' : usd(updated.costUsd);
    await this.notifyRoom(updated, 'finished', `Workflow „${run.workflowName}“ ${label}: ${done} von ${steps.length} Schritten abgeschlossen (${cost}).${updated.reason ? ` ${updated.reason}` : ''}`);
    return updated;
  }

  /** Validates, assesses executability, applies the non-executable policy and enqueues the run (or stores it blocked). */
  async start(input: StartWorkflowRunInput): Promise<WorkflowRun> {
    const { workflow } = input;
    const validation = validateWorkflowDefinition(workflow.definition, { availableTools: this.deps.availableTools() });
    if (!validation.valid || !validation.definition) throw new WorkflowValidationError(validation.issues);
    const definition = validation.definition;
    const now = this.clock.now();

    const assessment = assessWorkflow(definition, await this.deps.environment(input.mode));
    const blockers = workflowBlockers(definition, assessment);
    const session = this.deps.sessions ? await this.deps.sessions.activeForProject(workflow.projectId) : null;
    const limits = resolveWorkflowLimits(input.limits, session, now);

    let status: WorkflowRunStatus = 'queued';
    let reason: string | null = null;
    if (input.onNonExecutable === 'block' && blockers.length > 0) {
      status = 'blocked';
      reason = `${blockers.length} ${blockers.length === 1 ? 'Agent ist' : 'Agenten sind'} nicht ausführbar. Integrationen verbinden oder „überspringen“ wählen.`;
    } else if (session && limits.maxCostUsd <= 0) {
      status = 'blocked';
      reason = 'Das Budget der aktiven Autopilot-Session ist ausgeschöpft.';
    } else if (session && limits.maxDurationMs <= 0) {
      status = 'blocked';
      reason = 'Das Zeitfenster der aktiven Autopilot-Session ist abgelaufen.';
    }

    const blocked = new Set(blockers.map((b) => b.nodeId));
    const steps: NewWorkflowStep[] = definition.nodes.map((node) => {
      if (blocked.has(node.id)) {
        const message = assessment.get(node.id)?.message ?? 'Nicht ausführbar';
        return status === 'blocked'
          ? { nodeId: node.id, nodeType: node.type, status: 'blocked', reason: message }
          : { nodeId: node.id, nodeType: node.type, status: 'skipped', reason: `Übersprungen – ${message.replace('Nicht ausführbar – ', 'nicht ausführbar: ')}` };
      }
      return { nodeId: node.id, nodeType: node.type, status: 'pending', reason: null };
    });

    const run = await this.deps.runs.create(
      {
        workflowId: workflow.id,
        projectId: workflow.projectId,
        workflowVersion: workflow.version,
        workflowName: workflow.name,
        definition,
        status,
        mode: input.mode,
        onNonExecutable: input.onNonExecutable,
        limits,
        sessionId: session?.id ?? null,
        blockers,
        reason,
        startedBy: input.startedBy,
        startedAt: null,
        finishedAt: status === 'blocked' ? now : null,
      },
      steps,
    );
    await this.deps.events.emit({
      type: 'workflow.run.created',
      projectId: run.projectId,
      taskId: null,
      runId: null,
      payload: { workflowRunId: run.id, workflowId: run.workflowId, status: run.status, mode: run.mode },
    });
    if (status === 'blocked') {
      await this.notifyRoom(run, 'finished', `Workflow „${run.workflowName}“ wurde nicht gestartet: ${reason}`);
      return run;
    }
    await this.deps.queue.enqueue({ type: WORKFLOW_RUN_JOB, payload: { runId: run.id }, dedupeKey: `workflow-run:${run.id}`, maxAttempts: 3 });
    return run;
  }

  /** Cancels a queued or running run. In-flight steps finish and are recorded; nothing new starts. */
  async cancel(runId: string, reason: string): Promise<WorkflowRun | null> {
    const run = await this.deps.runs.update(runId, { status: 'cancelled', reason, finishedAt: this.clock.now() }, ACTIVE_WORKFLOW_RUN_STATUSES);
    if (!run) return null;
    for (const step of await this.deps.runs.listSteps(runId)) {
      if (step.status === 'pending') {
        await this.deps.runs.updateStep(runId, step.nodeId, { status: 'cancelled', reason });
        await this.emitStep(run, step.nodeId, 'cancelled');
      }
    }
    await this.deps.events.emit({
      type: 'workflow.run.finished',
      projectId: run.projectId,
      taskId: null,
      runId: null,
      payload: { workflowRunId: run.id, workflowId: run.workflowId, status: 'cancelled', costUsd: run.costUsd, tokens: run.tokens },
    });
    await this.notifyRoom(run, 'finished', `Workflow „${run.workflowName}“ abgebrochen: ${reason}`);
    return run;
  }

  /** Job handler: executes the run to completion. Safe to call again after a crash (running steps restart). */
  async execute(runId: string): Promise<WorkflowRun | null> {
    let run = await this.deps.runs.get(runId);
    if (!run || !ACTIVE_WORKFLOW_RUN_STATUSES.includes(run.status)) return run;
    const firstStart = run.status === 'queued';
    run = (await this.deps.runs.update(runId, { status: 'running', startedAt: run.startedAt ?? this.clock.now() }, ACTIVE_WORKFLOW_RUN_STATUSES)) ?? run;
    if (run.status !== 'running') return run;
    if (firstStart) {
      await this.deps.events.emit({ type: 'workflow.run.started', projectId: run.projectId, taskId: null, runId: null, payload: { workflowRunId: run.id, workflowId: run.workflowId, mode: run.mode } });
      await this.notifyRoom(run, 'started', `Workflow „${run.workflowName}“ gestartet${run.mode === 'demo' ? ' (Demo)' : ''}.`);
    }

    const definition = run.definition;
    const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    const states = new Map<string, WorkflowStepStatus>();
    const reasons = new Map<string, string | null>();
    const costs = new Map<string, number>();
    const outputs = new Map<string, NodeOutput>();

    for (const step of await this.deps.runs.listSteps(runId)) {
      let status = step.status;
      if (status === 'running') {
        // A crashed worker left this step half done; at-least-once semantics restart it.
        status = 'pending';
        await this.deps.runs.updateStep(runId, step.nodeId, { status, attempts: step.attempts + 1 });
      }
      states.set(step.nodeId, status);
      reasons.set(step.nodeId, step.reason);
      costs.set(step.nodeId, step.costUsd);
    }
    for (const meta of await this.deps.runs.listArtifacts(runId)) {
      const artifact = await this.deps.runs.getArtifact(runId, meta.id);
      if (artifact) outputs.set(artifact.nodeId, { content: artifact.content, format: artifact.format });
    }
    for (const node of definition.nodes) {
      if (node.type === 'goal' && states.get(node.id) === 'succeeded') outputs.set(node.id, { content: node.goal, format: 'text' });
    }

    const assessment: Map<string, NodeExecutability> = run.mode === 'live' ? assessWorkflow(definition, await this.deps.environment('live')) : assessWorkflow(definition, await this.deps.environment('demo'));
    const project = await this.deps.projects.get(run.projectId);
    const projectInfo = { name: project?.name ?? 'Projekt', description: project?.description ?? '' };
    const goalNode = definition.nodes.find((n) => n.type === 'goal');
    const goalText = goalNode?.type === 'goal' ? goalNode.goal : '';
    const deadline = (run.startedAt ?? this.clock.now()).getTime() + run.limits.maxDurationMs;

    const abort = new AbortController();
    const inflight = new Map<string, Promise<void>>();
    const reserved = new Map<string, number>();
    let capReason: string | null = null;
    let cancelled = false;
    const currentRun = run;

    const setState = async (nodeId: string, status: WorkflowStepStatus, patch: Parameters<WorkflowRunRepository['updateStep']>[2] = {}) => {
      states.set(nodeId, status);
      if ('reason' in patch) reasons.set(nodeId, patch.reason ?? null);
      await this.deps.runs.updateStep(runId, nodeId, { status, ...patch });
      await this.emitStep(currentRun, nodeId, status);
    };

    const upstream = (nodeId: string): UpstreamOutput[] =>
      upstreamOf(definition, nodeId, (id) => {
        const node = nodes.get(id);
        if (!node) return undefined;
        return { nodeId: id, label: node.label, status: states.get(id) ?? 'pending', content: outputs.get(id)?.content ?? null, reason: reasons.get(id) ?? null };
      });

    const spent = () => [...costs.values()].reduce((sum, c) => sum + c, 0);

    const runNode = async (node: WorkflowNode, budgetUsd: number): Promise<void> => {
      const started = this.clock.now();
      await setState(node.id, 'running', { startedAt: started, reason: null });
      try {
        if (node.type === 'agent') {
          const entry = assessment.get(node.id);
          let result: WorkflowAgentStepResult;
          if (!entry?.executable) {
            result = { ok: false, kind: 'failed', error: entry?.message ?? 'Nicht ausführbar', agentRunId: null, modelId: null, provider: null, costUsd: 0, tokens: 0 };
          } else {
            result = await this.deps.executors[currentRun.mode].execute({
              projectId: currentRun.projectId,
              project: projectInfo,
              workflowName: currentRun.workflowName,
              goal: goalText,
              node,
              upstream: upstream(node.id),
              budgetUsd,
              modelIds: entry.modelIds,
              signal: abort.signal,
            });
          }
          costs.set(node.id, result.costUsd);
          const common = { agentRunId: result.agentRunId, modelId: result.modelId, provider: result.provider, costUsd: result.costUsd, tokens: result.tokens, finishedAt: this.clock.now() };
          if (result.ok) {
            const content = result.content.slice(0, WORKFLOW_LIMITS.artifactChars);
            outputs.set(node.id, { content, format: node.output.format });
            await this.deps.runs.addArtifact({ runId, nodeId: node.id, name: artifactName(node.output.artifactName, node.id, node.output.format), format: node.output.format, content });
            await setState(node.id, 'succeeded', { ...common, summary: result.summary.slice(0, 300) });
          } else if (result.kind === 'budget') {
            await setState(node.id, 'blocked', { ...common, reason: `Budget erreicht: ${result.error}`.slice(0, 1000) });
          } else {
            await setState(node.id, 'failed', { ...common, reason: result.error.slice(0, 1000) });
          }
        } else {
          const content = deterministicOutput(definition, node, (id) => ({ label: nodes.get(id)?.label ?? id, status: states.get(id) ?? 'pending', content: outputs.get(id)?.content ?? null }));
          outputs.set(node.id, { content, format: node.type === 'goal' ? 'text' : 'markdown' });
          if (node.type === 'orchestrator' || node.type === 'join' || node.type === 'finale') {
            const format = node.type === 'finale' ? node.output.format : 'markdown';
            const name = node.type === 'finale' ? artifactName(node.output.artifactName, node.id, format) : artifactName('', node.id, 'markdown');
            await this.deps.runs.addArtifact({ runId, nodeId: node.id, name, format, content: content.slice(0, WORKFLOW_LIMITS.artifactChars) });
          }
          await setState(node.id, 'succeeded', { finishedAt: this.clock.now(), summary: SUMMARY[node.type] });
        }
      } catch (error) {
        this.report(error, `workflow step ${node.id}`);
        await setState(node.id, 'failed', { reason: `Interner Fehler: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), finishedAt: this.clock.now() });
      }
    };

    // Each iteration starts or finishes at least one step; the bound is a safety net against logic errors.
    const maxIterations = definition.nodes.length * 4 + 10;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const latest = await this.deps.runs.get(runId);
      if (!latest || latest.status !== 'running') {
        cancelled = true;
        break;
      }
      if (latest.sessionId && this.deps.sessions) {
        const sessionStatus = await this.deps.sessions.status(latest.sessionId);
        if (sessionStatus === 'killed') {
          await this.cancel(runId, 'Die Autopilot-Session wurde per Kill-Switch beendet.');
          cancelled = true;
          break;
        }
      }
      if (!capReason && this.clock.now().getTime() >= deadline) capReason = 'Zeitlimit des Laufs erreicht.';
      if (!capReason && currentRun.mode === 'live' && spent() >= currentRun.limits.maxCostUsd) capReason = `Kostenlimit von ${usd(currentRun.limits.maxCostUsd)} erreicht.`;

      if (!capReason) {
        const ready = readyWorkflowNodes(definition, states, inflight.size, run.limits.maxParallel);
        let startedAny = false;
        for (const nodeId of ready) {
          const node = nodes.get(nodeId)!;
          const failedInput = predecessors(definition, nodeId).find((p) => ['failed', 'blocked', 'cancelled'].includes(states.get(p) ?? ''));
          if (failedInput) {
            await setState(nodeId, 'skipped', { reason: `Übersprungen – vorheriger Schritt „${nodes.get(failedInput)?.label ?? failedInput}“ ist fehlgeschlagen.`, finishedAt: this.clock.now() });
            startedAny = true;
            continue;
          }
          let budget = 0;
          if (node.type === 'agent' && currentRun.mode === 'live') {
            const free = Math.max(1, currentRun.limits.maxParallel - inflight.size);
            const reservedTotal = [...reserved.values()].reduce((sum, r) => sum + r, 0);
            budget = Math.max(0, currentRun.limits.maxCostUsd - spent() - reservedTotal) / free;
            if (budget <= 0) {
              // Everything left is reserved by running steps; once they finish the cap check decides.
              if (inflight.size === 0) capReason = `Kostenlimit von ${usd(currentRun.limits.maxCostUsd)} erreicht.`;
              break;
            }
          }
          reserved.set(nodeId, budget);
          const promise = runNode(node, budget).finally(() => {
            inflight.delete(nodeId);
            reserved.delete(nodeId);
          });
          inflight.set(nodeId, promise);
          startedAny = true;
        }
        if (startedAny) continue;
      }
      if (inflight.size === 0) break;
      await Promise.race(inflight.values());
    }
    abort.abort();
    await Promise.allSettled(inflight.values());

    if (cancelled) {
      // A cancel keeps its status; record the cost of steps that finished meanwhile.
      const steps = await this.deps.runs.listSteps(runId);
      for (const step of steps.filter((s) => s.status === 'pending')) await this.deps.runs.updateStep(runId, step.nodeId, { status: 'cancelled' });
      const all = await this.deps.runs.listSteps(runId);
      await this.deps.runs.update(runId, { costUsd: all.reduce((s, x) => s + x.costUsd, 0), tokens: all.reduce((s, x) => s + x.tokens, 0) });
      return this.deps.runs.get(runId);
    }

    const pendingReason = capReason ?? 'Nicht erreichbar, weil vorherige Schritte nicht abgeschlossen wurden.';
    for (const [nodeId, status] of states) {
      if (status === 'pending') await setState(nodeId, capReason ? 'blocked' : 'skipped', { reason: pendingReason, finishedAt: this.clock.now() });
    }
    const steps = await this.deps.runs.listSteps(runId);
    const outcome = workflowRunOutcome(steps, capReason);
    const firstFailure = steps.find((s) => s.status === 'failed' || s.status === 'blocked');
    const finalReason = capReason ?? (outcome === 'partial' ? 'Nicht ausführbare Schritte wurden übersprungen.' : firstFailure?.reason ?? null);
    return this.finish(run, outcome, finalReason);
  }
}

const STATUS_TEXT: Record<WorkflowRunStatus, string> = {
  queued: 'wartet',
  running: 'läuft',
  succeeded: 'abgeschlossen',
  partial: 'teilweise abgeschlossen',
  failed: 'fehlgeschlagen',
  blocked: 'blockiert',
  cancelled: 'abgebrochen',
};

const STEP_TEXT: Record<WorkflowStepStatus, string> = {
  pending: 'wartet',
  running: 'läuft',
  succeeded: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  skipped: 'übersprungen',
  blocked: 'blockiert',
  cancelled: 'abgebrochen',
};

const SUMMARY: Record<Exclude<WorkflowNode['type'], 'agent'>, string> = {
  goal: 'Ziel übernommen',
  orchestrator: 'Ausführungsplan aus der Topologie erstellt',
  join: 'Eingaben zusammengeführt',
  finale: 'Ergebnisse zusammengeführt',
};

const EXTENSIONS: Record<WorkflowOutputFormat, string> = { markdown: '.md', text: '.txt', json: '.json' };

export function artifactName(name: string, nodeId: string, format: WorkflowOutputFormat): string {
  const base = name || nodeId;
  return base.includes('.') ? base : `${base}${EXTENSIONS[format]}`;
}

/** Output of goal, orchestrator (plan from topology, no model) and join/finale (concatenation). */
export function deterministicOutput(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  lookup: (nodeId: string) => { label: string; status: WorkflowStepStatus; content: string | null },
): string {
  if (node.type === 'goal') return node.goal;
  if (node.type === 'orchestrator') {
    const order = workflowTopologicalOrder(definition) ?? [];
    const downstream = descendants(definition, node.id);
    const byId = new Map(definition.nodes.map((n) => [n.id, n]));
    const lines = ['# Ausführungsplan', '', 'Deterministisch aus dem Workflow-Graphen abgeleitet (Stufe 1: keine Modellentscheidung).', ''];
    let index = 1;
    for (const id of order) {
      if (!downstream.has(id)) continue;
      const target = byId.get(id)!;
      const inputs = predecessors(definition, id).map((p) => byId.get(p)?.label ?? p);
      lines.push(`${index++}. ${target.label}${inputs.length > 0 ? ` ← ${inputs.join(', ')}` : ''}`);
    }
    return lines.join('\n');
  }
  const parts: string[] = [`# ${node.label}`, ''];
  const included = new Set<string>();
  // A skipped input passes its own inputs through, so a finale behind a non-executable step still collects the work
  // that was done upstream. Bounded by the node count through `included`.
  const collect = (id: string, depth: number) => {
    if (included.has(id)) return;
    included.add(id);
    const input = lookup(id);
    const source = definition.nodes.find((n) => n.id === id);
    if (input.status === 'succeeded' && input.content) {
      if (source?.type === 'goal' || source?.type === 'orchestrator') return;
      parts.push(`${depth > 0 ? '###' : '##'} ${input.label}`, '', input.content, '');
      return;
    }
    parts.push(`${depth > 0 ? '###' : '##'} ${input.label}`, '', `_Keine Ausgabe (${STEP_TEXT[input.status]})._`, '');
    if (input.status === 'skipped') for (const upstreamId of predecessors(definition, id)) collect(upstreamId, depth + 1);
  };
  for (const id of predecessors(definition, node.id)) collect(id, 0);
  return parts.join('\n').trimEnd();
}
