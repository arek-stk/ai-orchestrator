import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  createMemoryWorkflowStore,
  defaultProjectProfile,
  defaultProjectSettings,
  findWorkflowTemplate,
  type WorkflowRepository,
  type WorkflowRunRepository,
} from '@orch/core';
import { createDatabase, type DatabaseHandle } from './client';
import { createRepositories, type Repositories } from './repositories';
import { createWorkflowRepositories, type WorkflowRepositories } from './workflow-repositories';

let handle: DatabaseHandle;
let repos: Repositories;
let store: WorkflowRepositories;
const projectIds: string[] = [];

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  store = createWorkflowRepositories(handle.db);
  for (const slug of ['wf-a', 'wf-b']) {
    const project = await repos.projects.create({ slug, name: slug, description: '', repo: null, priority: 5, autonomyLevel: 1, budgetUsd: 10, profile: defaultProjectProfile(), settings: defaultProjectSettings() });
    projectIds.push(project.id);
  }
});

afterAll(async () => {
  await handle.close();
});

const definition = () => findWorkflowTemplate('blog-artikel')!.definition;

// The same contract runs against PGlite and the in-memory store, so core tests and the server behave alike.
function contract(name: string, get: () => { workflows: WorkflowRepository; runs: WorkflowRunRepository }) {
  describe(`workflow repositories (${name})`, () => {
    it('versions every save and rejects stale versions', async () => {
      const { workflows } = get();
      const created = await workflows.create({ projectId: projectIds[0]!, name: 'Blog', description: 'd', status: 'draft', definition: definition(), createdBy: null });
      expect(created).toMatchObject({ version: 1, status: 'draft', name: 'Blog' });
      const updated = await workflows.update(created.id, { name: 'Blog 2', status: 'active' }, 1, null);
      expect(updated).toMatchObject({ version: 2, name: 'Blog 2', status: 'active' });
      await expect(workflows.update(created.id, { name: 'stale' }, 1, null)).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect((await workflows.listVersions(created.id, 10)).map((v) => [v.version, v.name])).toEqual([
        [2, 'Blog 2'],
        [1, 'Blog'],
      ]);
      expect((await workflows.list({ projectIds: [projectIds[1]!], limit: 10 })).map((w) => w.id)).not.toContain(created.id);
      expect((await workflows.list({ projectIds: [], limit: 10 }))).toEqual([]);
      expect(await workflows.delete(created.id)).toBe(true);
      expect(await workflows.get(created.id)).toBeNull();
    });

    it('stores runs with ordered steps, conditional updates and one artifact per node', async () => {
      const { workflows, runs } = get();
      const workflow = await workflows.create({ projectId: projectIds[0]!, name: 'Run me', description: '', status: 'active', definition: definition(), createdBy: null });
      const run = await runs.create(
        {
          workflowId: workflow.id,
          projectId: workflow.projectId,
          workflowVersion: 1,
          workflowName: workflow.name,
          definition: workflow.definition,
          status: 'queued',
          mode: 'live',
          onNonExecutable: 'skip',
          limits: { maxParallel: 2, maxCostUsd: 1, maxDurationMs: 60_000 },
          sessionId: null,
          blockers: [],
          reason: null,
          startedBy: null,
          startedAt: null,
          finishedAt: null,
        },
        workflow.definition.nodes.map((n) => ({ nodeId: n.id, nodeType: n.type, status: n.id === 'entwurf' ? 'skipped' : 'pending', reason: null })),
      );
      expect((await runs.listSteps(run.id)).map((s) => s.nodeId)).toEqual(workflow.definition.nodes.map((n) => n.id));
      expect((await runs.listSteps(run.id)).find((s) => s.nodeId === 'entwurf')!.finishedAt).not.toBeNull();

      expect(await runs.update(run.id, { status: 'running' }, ['queued'])).toMatchObject({ status: 'running' });
      expect(await runs.update(run.id, { status: 'running' }, ['queued'])).toBeNull();
      await runs.updateStep(run.id, 'gliederung', { status: 'succeeded', costUsd: 0.25, tokens: 900 });

      const first = await runs.addArtifact({ runId: run.id, nodeId: 'gliederung', name: 'a.md', format: 'markdown', content: 'v1' });
      await runs.addArtifact({ runId: run.id, nodeId: 'gliederung', name: 'a.md', format: 'markdown', content: 'version 2' });
      const artifacts = await runs.listArtifacts(run.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).not.toHaveProperty('content');
      expect(artifacts[0]!.size).toBe(9);
      expect((await runs.getArtifact(run.id, artifacts[0]!.id))!.content).toBe('version 2');
      expect(first.nodeId).toBe('gliederung');
      expect(await runs.getArtifact('wfr_other', artifacts[0]!.id)).toBeNull();
      expect((await runs.list({ workflowId: workflow.id, limit: 5 })).map((r) => r.id)).toEqual([run.id]);
    });
  });
}

contract('memory', (() => {
  let memory: ReturnType<typeof createMemoryWorkflowStore> | null = null;
  return () => (memory ??= createMemoryWorkflowStore());
})());
contract('drizzle', () => store);

describe('workflow ledger and events (drizzle)', () => {
  it('sums real ledger rows of the run and lists its workflow events', async () => {
    const workflow = await store.workflows.create({ projectId: projectIds[1]!, name: 'Ledger', description: '', status: 'active', definition: definition(), createdBy: null });
    const run = await store.runs.create(
      { workflowId: workflow.id, projectId: workflow.projectId, workflowVersion: 1, workflowName: 'Ledger', definition: workflow.definition, status: 'running', mode: 'live', onNonExecutable: 'block', limits: { maxParallel: 1, maxCostUsd: 1, maxDurationMs: 1000 }, sessionId: null, blockers: [], reason: null, startedBy: null, startedAt: new Date(), finishedAt: null },
      workflow.definition.nodes.map((n) => ({ nodeId: n.id, nodeType: n.type, status: 'pending', reason: null })),
    );
    const agentRun = await repos.agentRuns.start({ projectId: workflow.projectId, runId: null, taskId: null, role: 'planner', inputSummary: 'wf' });
    await repos.usage.record({ projectId: workflow.projectId, taskId: null, agentRunId: agentRun.id, provider: 'anthropic', modelId: 'claude', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.12 });
    await repos.usage.record({ projectId: workflow.projectId, taskId: null, agentRunId: 'agr_unrelated', provider: 'anthropic', modelId: 'claude', usage: { inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 9 });
    await store.runs.updateStep(run.id, 'gliederung', { agentRunId: agentRun.id, costUsd: 0.12 });
    expect(await store.runs.ledgerTotals(run.id)).toEqual({ costUsd: 0.12, tokens: 150, calls: 1, byModel: [{ provider: 'anthropic', modelId: 'claude', costUsd: 0.12, tokens: 150, calls: 1 }] });

    await repos.events.append({ type: 'workflow.step.updated', projectId: workflow.projectId, taskId: null, runId: null, payload: { workflowRunId: run.id, workflowId: workflow.id, nodeId: 'gliederung', status: 'running' } });
    await repos.events.append({ type: 'workflow.step.updated', projectId: workflow.projectId, taskId: null, runId: null, payload: { workflowRunId: 'wfr_other', workflowId: workflow.id, nodeId: 'x', status: 'running' } });
    const events = await store.runs.listEvents(workflow.projectId, run.id, 50);
    expect(events.map((e) => e.payload.nodeId)).toEqual(['gliederung']);

    await store.runs.update(run.id, { status: 'running' });
    expect(await store.runs.sessionCostUsd('aps_none')).toBe(0);
  });
});
