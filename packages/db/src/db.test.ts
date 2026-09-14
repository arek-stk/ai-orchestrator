import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  DEFAULT_STOP_CONDITIONS,
  TaskInputSchema,
  defaultProjectProfile,
  defaultProjectSettings,
  type Clock,
} from '@orch/core';
import { createDatabase, type DatabaseHandle } from './client';
import { PgJobQueue, backoffMs } from './job-queue';
import { createRepositories, type Repositories } from './repositories';

let handle: DatabaseHandle;
let repos: Repositories;

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function makeProject(slug: string) {
  return repos.projects.create({
    slug,
    name: `Project ${slug}`,
    description: 'test',
    repo: { owner: 'acme', name: slug, defaultBranch: 'main' },
    priority: 7,
    autonomyLevel: 3,
    budgetUsd: 20,
    profile: defaultProjectProfile(),
    settings: defaultProjectSettings(),
  });
}

describe('repositories', () => {
  it('creates, reads, updates projects and accumulates usage', async () => {
    const project = await makeProject('shop');
    expect(project).toMatchObject({ slug: 'shop', status: 'IDLE', repo: { owner: 'acme', name: 'shop' } });

    await repos.projects.addUsage(project.id, 0.25, 1200);
    await repos.projects.addUsage(project.id, 0.5, 800);
    const updated = await repos.projects.update(project.id, { status: 'BUILDING', autonomyLevel: 4 });
    expect(updated).toMatchObject({ status: 'BUILDING', autonomyLevel: 4, spentUsd: 0.75, tokensUsed: 2000 });
    expect(await repos.projects.getBySlug('shop')).toMatchObject({ id: project.id });
  });

  it('creates tasks with validated defaults and reports statuses', async () => {
    const project = await makeProject('tasks');
    const api = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Build API', goal: 'REST endpoints' }), null);
    const ui = await repos.tasks.create(
      project.id,
      TaskInputSchema.parse({ title: 'Build UI', goal: 'Screens', dependencies: [api.id] }),
      null,
    );
    expect(ui).toMatchObject({ status: 'READY', dependencies: [api.id], maxAttempts: 3, risk: 'medium' });

    await repos.tasks.update(api.id, { status: 'DONE' });
    const statuses = await repos.tasks.statuses([api.id, ui.id, 'tsk_missing']);
    expect(Object.fromEntries(statuses)).toEqual({ [api.id]: 'DONE', [ui.id]: 'READY' });
    expect((await repos.tasks.list({ projectId: project.id, statuses: ['READY'] })).map((x) => x.id)).toEqual([ui.id]);
  });

  it('protects pipeline runs with optimistic concurrency', async () => {
    const project = await makeProject('runs');
    const task = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Run me', goal: 'Ship the run' }), null);
    const run = await repos.runs.create({ taskId: task.id, projectId: project.id, stagePlan: [], limits: { ...DEFAULT_STOP_CONDITIONS } });
    expect(run.checkpoint.changeset).toEqual([]);

    const saved = await repos.runs.save({ ...run, status: 'RUNNING', currentStage: 'PLAN', iterations: 1 });
    expect(saved.version).toBe(run.version + 1);
    await expect(repos.runs.save({ ...run, status: 'FAILED' })).rejects.toBeInstanceOf(ConcurrentModificationError);

    const counts = await repos.runs.countByProject(['RUNNING']);
    expect(counts.get(project.id)).toBe(1);
  });

  it('upserts memories and increments hits for repeated failures', async () => {
    const project = await makeProject('memory');
    await repos.memories.upsert({ projectId: project.id, scope: 'failure', kind: 'test_failure', key: 'abc123', content: 'cart discount off by 10%' });
    const again = await repos.memories.upsert({ projectId: project.id, scope: 'failure', kind: 'test_failure', key: 'abc123', content: 'cart discount off by 10% (again)' });
    expect(again.hits).toBe(2);
    expect(await repos.memories.search(project.id, { text: '10%' })).toHaveLength(1);
    expect(await repos.memories.search(project.id, { text: 'nothing_like_this' })).toHaveLength(0);
  });

  it('decides approvals exactly once', async () => {
    const project = await makeProject('approvals');
    const approval = await repos.approvals.create({
      projectId: project.id,
      taskId: null,
      runId: null,
      action: 'production_deploy',
      reason: 'All tests passed',
      risk: 'medium',
      details: {},
    });
    expect(await repos.approvals.decide(approval.id, 'approved', 'usr_1', null)).toMatchObject({ status: 'approved', decidedBy: 'usr_1' });
    expect(await repos.approvals.decide(approval.id, 'rejected', 'usr_2', null)).toBeNull();
  });

  it('sums usage and stores events in order', async () => {
    const since = new Date(Date.now() - 1000);
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await repos.usage.record({ projectId: 'p1', taskId: null, agentRunId: null, provider: 'mock', modelId: 'm', usage, costUsd: 0.1 });
    await repos.usage.record({ projectId: 'p2', taskId: null, agentRunId: null, provider: 'mock', modelId: 'm', usage, costUsd: 0.2 });
    expect(await repos.usage.totalCostSince(since)).toBeCloseTo(0.3);
    expect(await repos.usage.totalCostSince(since, 'p1')).toBeCloseTo(0.1);

    const first = await repos.events.append({ type: 'task.created', projectId: 'p1', taskId: 't1', runId: null, payload: { title: 'x' } });
    await repos.events.append({ type: 'task.started', projectId: 'p1', taskId: 't1', runId: 'r1', payload: { runId: 'r1' } });
    const after = await repos.events.list({ afterId: Number(first.id), projectId: 'p1' });
    expect(after.map((e) => e.type)).toEqual(['task.started']);
  });
});

describe('PgJobQueue', () => {
  function fixedClock(start: Date) {
    let now = start.getTime();
    const clock: Clock = { now: () => new Date(now) };
    return { clock, advance: (ms: number) => (now += ms) };
  }

  it('deduplicates active jobs and claims each job once', async () => {
    const { clock } = fixedClock(new Date('2030-01-01T00:00:00Z'));
    const queue = new PgJobQueue(handle.db, clock);
    await queue.enqueue({ type: 'pipeline.step', payload: { runId: 'dedupe' }, dedupeKey: 'run:dedupe' });
    await queue.enqueue({ type: 'pipeline.step', payload: { runId: 'dedupe' }, dedupeKey: 'run:dedupe' });

    const [a] = await queue.claim('worker-a', { types: ['pipeline.step'] });
    const b = await queue.claim('worker-b', { types: ['pipeline.step'] });
    expect(a?.payload).toEqual({ runId: 'dedupe' });
    expect(b).toEqual([]);
    expect(await queue.complete(a!.id, 'worker-a')).toBe(true);

    // After completion the dedupe key is free again.
    await queue.enqueue({ type: 'pipeline.step', payload: { runId: 'dedupe' }, dedupeKey: 'run:dedupe' });
    expect(await queue.claim('worker-b', { types: ['pipeline.step'] })).toHaveLength(1);
  });

  it('does not claim jobs scheduled in the future', async () => {
    const { clock, advance } = fixedClock(new Date('2031-01-01T00:00:00Z'));
    const queue = new PgJobQueue(handle.db, clock);
    await queue.enqueue({ type: 'future.job', payload: {}, runAt: new Date('2031-01-01T00:05:00Z') });
    expect(await queue.claim('w', { types: ['future.job'] })).toEqual([]);
    advance(5 * 60_000);
    expect(await queue.claim('w', { types: ['future.job'] })).toHaveLength(1);
  });

  it('retries with backoff, then dead-letters after maxAttempts', async () => {
    const { clock, advance } = fixedClock(new Date('2032-01-01T00:00:00Z'));
    const queue = new PgJobQueue(handle.db, clock);
    await queue.enqueue({ type: 'flaky.job', payload: {}, maxAttempts: 2 });

    const [first] = await queue.claim('w', { types: ['flaky.job'] });
    expect(await queue.fail(first!.id, 'w', 'boom')).toBe('queued');
    expect(await queue.claim('w', { types: ['flaky.job'] })).toEqual([]);

    advance(60_000);
    const [second] = await queue.claim('w', { types: ['flaky.job'] });
    expect(second?.attempts).toBe(2);
    expect(await queue.fail(second!.id, 'w', 'boom again')).toBe('dead');
  });

  it('re-claims jobs whose worker lease expired (crash recovery)', async () => {
    const { clock, advance } = fixedClock(new Date('2033-01-01T00:00:00Z'));
    const queue = new PgJobQueue(handle.db, clock);
    await queue.enqueue({ type: 'crashy.job', payload: {} });
    const [job] = await queue.claim('crashed-worker', { types: ['crashy.job'], leaseMs: 30_000 });
    expect(job).toBeDefined();
    expect(await queue.claim('rescuer', { types: ['crashy.job'] })).toEqual([]);

    advance(31_000);
    const [rescued] = await queue.claim('rescuer', { types: ['crashy.job'] });
    expect(rescued?.id).toBe(job!.id);
    expect(await queue.complete(job!.id, 'crashed-worker')).toBe(false);
    expect(await queue.complete(job!.id, 'rescuer')).toBe(true);
  });

  it('computes bounded exponential backoff', () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(5_000);
    expect(backoffMs(3, mid)).toBe(20_000);
    expect(backoffMs(20, mid)).toBe(600_000);
  });
});
