import { ConcurrentModificationError, systemClock, type Clock } from '../ports';
import type {
  NewWorkflow,
  NewWorkflowRun,
  NewWorkflowStep,
  Workflow,
  WorkflowArtifact,
  WorkflowArtifactMeta,
  WorkflowRepository,
  WorkflowRun,
  WorkflowRunRepository,
  WorkflowStep,
  WorkflowVersion,
} from '../workflows/types';

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory workflow persistence with the semantics of the Drizzle repositories (versions, conditional updates). */
export function createMemoryWorkflowStore(clock: Clock = systemClock) {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;
  const workflowMap = new Map<string, Workflow>();
  const versionList: WorkflowVersion[] = [];
  const runMap = new Map<string, WorkflowRun>();
  const stepList: WorkflowStep[] = [];
  const artifactList: WorkflowArtifact[] = [];

  const workflows: WorkflowRepository = {
    async create(input: NewWorkflow) {
      const now = clock.now();
      const workflow: Workflow = { id: id('wfl'), ...clone(input), version: 1, updatedBy: input.createdBy, createdAt: now, updatedAt: now };
      workflowMap.set(workflow.id, workflow);
      versionList.push({ workflowId: workflow.id, version: 1, name: workflow.name, definition: clone(workflow.definition), createdBy: input.createdBy, createdAt: now });
      return clone(workflow);
    },
    async get(workflowId) {
      return clone(workflowMap.get(workflowId) ?? null);
    },
    async list({ projectIds, limit }) {
      return [...workflowMap.values()]
        .filter((w) => !projectIds || projectIds.includes(w.projectId))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async update(workflowId, patch, expectedVersion, updatedBy) {
      const current = workflowMap.get(workflowId);
      if (!current || current.version !== expectedVersion) throw new ConcurrentModificationError('workflow', workflowId);
      const now = clock.now();
      const next: Workflow = { ...current, ...clone(patch), version: current.version + 1, updatedBy, updatedAt: now };
      workflowMap.set(workflowId, next);
      versionList.push({ workflowId, version: next.version, name: next.name, definition: clone(next.definition), createdBy: updatedBy, createdAt: now });
      return clone(next);
    },
    async delete(workflowId) {
      const existed = workflowMap.delete(workflowId);
      for (let i = versionList.length - 1; i >= 0; i--) if (versionList[i]!.workflowId === workflowId) versionList.splice(i, 1);
      for (const run of [...runMap.values()]) if (run.workflowId === workflowId) runMap.delete(run.id);
      return existed;
    },
    async listVersions(workflowId, limit) {
      return versionList
        .filter((v) => v.workflowId === workflowId)
        .sort((a, b) => b.version - a.version)
        .slice(0, limit)
        .map(clone);
    },
  };

  const meta = ({ content: _content, ...rest }: WorkflowArtifact): WorkflowArtifactMeta => clone(rest);

  const runs: WorkflowRunRepository = {
    async create(input: NewWorkflowRun, steps: readonly NewWorkflowStep[]) {
      const run: WorkflowRun = { ...clone(input), id: id('wfr'), costUsd: 0, tokens: 0, createdAt: clock.now() };
      runMap.set(run.id, run);
      for (const step of steps) {
        stepList.push({
          id: id('wfs'),
          runId: run.id,
          ...clone(step),
          agentRunId: null,
          modelId: null,
          provider: null,
          costUsd: 0,
          tokens: 0,
          summary: null,
          attempts: 0,
          startedAt: null,
          finishedAt: step.status === 'pending' ? null : run.createdAt,
        });
      }
      return clone(run);
    },
    async get(runId) {
      return clone(runMap.get(runId) ?? null);
    },
    async list({ workflowId, projectId, sessionId, statuses, limit }) {
      return [...runMap.values()]
        .filter((r) => (!workflowId || r.workflowId === workflowId) && (!projectId || r.projectId === projectId) && (!sessionId || r.sessionId === sessionId) && (!statuses || statuses.includes(r.status)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async update(runId, patch, onlyIf) {
      const current = runMap.get(runId);
      if (!current || (onlyIf && !onlyIf.includes(current.status))) return null;
      const next = { ...current, ...clone(patch) };
      runMap.set(runId, next);
      return clone(next);
    },
    async listSteps(runId) {
      const run = runMap.get(runId);
      const order = new Map(run?.definition.nodes.map((n, i) => [n.id, i]) ?? []);
      return stepList
        .filter((s) => s.runId === runId)
        .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
        .map(clone);
    },
    async updateStep(runId, nodeId, patch) {
      const step = stepList.find((s) => s.runId === runId && s.nodeId === nodeId);
      if (!step) throw new Error(`step ${nodeId} of run ${runId} not found`);
      Object.assign(step, clone(patch));
      return clone(step);
    },
    async addArtifact(input) {
      const artifact: WorkflowArtifact = { ...clone(input), id: id('wfa'), size: input.content.length, createdAt: clock.now() };
      // One artifact per node: a restarted step replaces its previous output.
      const existing = artifactList.findIndex((a) => a.runId === input.runId && a.nodeId === input.nodeId);
      if (existing >= 0) artifactList.splice(existing, 1);
      artifactList.push(artifact);
      return meta(artifact);
    },
    async listArtifacts(runId) {
      return artifactList.filter((a) => a.runId === runId).map(meta);
    },
    async getArtifact(runId, artifactId) {
      return clone(artifactList.find((a) => a.runId === runId && a.id === artifactId) ?? null);
    },
    async sessionCostUsd(sessionId) {
      return [...runMap.values()].filter((r) => r.sessionId === sessionId).reduce((sum, r) => sum + r.costUsd, 0);
    },
  };

  return { workflows, runs };
}
