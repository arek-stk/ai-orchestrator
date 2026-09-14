import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultProjectProfile, defaultProjectSettings, TaskInputSchema, type Clock } from '@orch/core';
import { expireApprovals } from './approval-expiry';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';

const HOUR = 60 * 60 * 1000;
let now = new Date();
const clock: Clock = { now: () => now };
let container: Container;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', APPROVAL_TTL_HOURS: '72', ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }, { inMemoryDatabase: true, demoLatencyMs: 0 });
  container = await createContainer(config, { clock });
});

afterAll(async () => {
  await container.close();
});

/** A run parked in WAITING on a pending approval, as the orchestrator leaves it after a gate. */
async function waitingRun(name: string) {
  const { repos, orchestrator } = container;
  const project = await repos.projects.create({
    slug: name,
    name,
    description: '',
    repo: null,
    priority: 5,
    autonomyLevel: 3,
    budgetUsd: 10,
    profile: defaultProjectProfile(),
    settings: defaultProjectSettings(),
  });
  const task = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Migrate the orders table', goal: 'Add an index to orders' }), null);
  await repos.tasks.update(task.id, { status: 'READY', readySince: now });
  const run = await orchestrator.startTask(task.id);
  expect(run).not.toBeNull();
  const approval = await repos.approvals.create({ projectId: project.id, taskId: task.id, runId: run!.id, action: 'database_migration', reason: 'migration detected', risk: 'high', details: {} });
  const current = (await repos.runs.get(run!.id))!;
  current.status = 'WAITING';
  current.checkpoint.pendingApprovalId = approval.id;
  await repos.runs.save(current);
  await repos.tasks.update(task.id, { status: 'WAITING_APPROVAL' });
  return { project, task, run: current, approval };
}

describe('approval expiry', () => {
  it('leaves approvals younger than the TTL untouched', async () => {
    const { approval } = await waitingRun('fresh-approval');
    now = new Date(Date.now() + 71 * HOUR);
    expect(await expireApprovals(container)).toBe(0);
    expect((await container.repos.approvals.get(approval.id))!.status).toBe('pending');
  });

  it('expires stale approvals, blocks the run with a clear reason, emits an event and audits', async () => {
    now = new Date(Date.now() + 73 * HOUR);
    const expired = await expireApprovals(container);
    expect(expired).toBe(1);

    const [approval] = await container.repos.approvals.list({ status: 'expired' });
    expect(approval).toMatchObject({ status: 'expired', decidedBy: 'system' });
    expect(approval!.comment).toContain('72h');

    const run = (await container.repos.runs.get(approval!.runId!))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedReason).toMatch(/Approval for database_migration expired without a decision/);
    expect(run.checkpoint.pendingApprovalId).toBeNull();
    const task = (await container.repos.tasks.get(approval!.taskId!))!;
    expect(task.status).toBe('BLOCKED');

    const events = await container.repos.events.list({ runId: run.id, types: ['approval.decided'] });
    expect(events.map((e) => e.payload)).toContainEqual({ approvalId: approval!.id, status: 'expired', by: 'system' });
    const audit = await container.admin.audit.list({ action: 'approval.expired' });
    expect(audit[0]).toMatchObject({ actorType: 'system', target: approval!.id });
    expect(audit[0]!.details).toMatchObject({ runBlocked: true, action: 'database_migration' });
    expect(container.metrics.approvalsExpired.get({ action: 'database_migration' })).toBe(1);

    // Idempotent: nothing left to expire.
    expect(await expireApprovals(container)).toBe(0);
  });

  it('records an event even when no run is waiting any more', async () => {
    const { run, approval } = await waitingRun('cancelled-run');
    await container.orchestrator.cancel(run.id, 'cancelled by test');
    now = new Date(Date.now() + 100 * HOUR);
    expect(await expireApprovals(container)).toBe(1);
    const events = await container.repos.events.list({ types: ['approval.decided'], order: 'desc', limit: 5 });
    expect(events.map((e) => e.payload)).toContainEqual({ approvalId: approval.id, status: 'expired', by: 'system' });
    const [entry] = await container.admin.audit.list({ action: 'approval.expired', limit: 1 });
    expect(entry!.details).toMatchObject({ runBlocked: false });
  });

  it('is disabled with APPROVAL_TTL_HOURS=0', async () => {
    const { approval } = await waitingRun('ttl-disabled');
    now = new Date(Date.now() + 1_000 * HOUR);
    container.config.approvalTtlMs = 0;
    try {
      expect(await expireApprovals(container)).toBe(0);
      expect((await container.repos.approvals.get(approval.id))!.status).toBe('pending');
    } finally {
      container.config.approvalTtlMs = 72 * HOUR;
    }
  });
});
