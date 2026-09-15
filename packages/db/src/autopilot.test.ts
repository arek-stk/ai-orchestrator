import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutopilotConflictError,
  defaultProjectProfile,
  defaultProjectSettings,
  defaultStopPolicy,
  DEFAULT_STOP_CONDITIONS,
  TaskInputSchema,
  type NewAutopilotSession,
} from '@orch/core';
import { createAdminRepositories, type AdminRepositories } from './admin-repositories';
import { DrizzleAutopilotSessionRepository } from './autopilot-repositories';
import { createDatabase, type DatabaseHandle } from './client';
import { createRepositories, type Repositories } from './repositories';

const HOUR = 60 * 60 * 1000;
let handle: DatabaseHandle;
let repos: Repositories;
let admin: AdminRepositories;
let sessions: DrizzleAutopilotSessionRepository;

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  admin = createAdminRepositories(handle.db);
  sessions = new DrizzleAutopilotSessionRepository(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function makeProject(slug: string) {
  return repos.projects.create({
    slug,
    name: slug,
    description: '',
    repo: { owner: 'acme', name: slug, defaultBranch: 'main' },
    priority: 5,
    autonomyLevel: 3,
    budgetUsd: 10,
    profile: defaultProjectProfile(),
    settings: defaultProjectSettings(),
  });
}

function sessionInput(projectIds: string[], overrides: Partial<NewAutopilotSession> = {}): NewAutopilotSession {
  const now = new Date();
  return {
    startedBy: 'usr_owner',
    projectIds,
    startsAt: new Date(now.getTime() - 60_000),
    endsAt: new Date(now.getTime() + 10 * HOUR),
    budgetUsd: 5,
    autonomyCeiling: 3,
    maxTaskRisk: 'medium',
    maxConcurrentRuns: null,
    maxParkedRuns: 3,
    quietHours: { timeZone: 'Europe/Berlin', windows: [{ from: '22:00', to: '07:00' }] },
    stopPolicy: defaultStopPolicy(),
    demo: false,
    ...overrides,
  };
}

async function sessionRun(projectId: string, sessionId: string | null) {
  const task = await repos.tasks.create(projectId, TaskInputSchema.parse({ title: 'Add search', goal: 'Search products' }), null);
  return repos.runs.create({ taskId: task.id, projectId, stagePlan: [], limits: DEFAULT_STOP_CONDITIONS, sessionId });
}

async function spend(run: { id: string; taskId: string; projectId: string }, costUsd: number) {
  const agentRun = await repos.agentRuns.start({ runId: run.id, taskId: run.taskId, projectId: run.projectId, role: 'builder', inputSummary: 'test' });
  await repos.usage.record({
    projectId: run.projectId,
    taskId: run.taskId,
    agentRunId: agentRun.id,
    provider: 'mock',
    modelId: 'test',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd,
  });
}

describe('autopilot session repository (PGlite)', () => {
  it('allows one active session per project atomically and rolls back a conflicting start', async () => {
    const a = await makeProject('ap-a');
    const b = await makeProject('ap-b');
    const first = await sessions.create(sessionInput([a.id]));
    expect(first).toMatchObject({ status: 'active', projectIds: [a.id], maxParkedRuns: 3, stopReason: null, endedAt: null });
    expect(first.quietHours).toEqual({ timeZone: 'Europe/Berlin', windows: [{ from: '22:00', to: '07:00' }] });

    const conflict = await sessions.create(sessionInput([b.id, a.id])).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(AutopilotConflictError);
    expect((conflict as AutopilotConflictError).projectIds).toEqual([a.id]);
    // The failed start left nothing behind: b is still free.
    expect(await sessions.list({ projectIds: [b.id] })).toEqual([]);

    // Concurrent starts for the same project: exactly one wins.
    const results = await Promise.allSettled([sessions.create(sessionInput([b.id])), sessions.create(sessionInput([b.id]))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const finished = await sessions.finish(first.id, { status: 'killed', stopReason: 'killed', stopDetail: 'test', stoppedBy: 'operator', endedAt: new Date() });
    expect(finished).toMatchObject({ status: 'killed', stopReason: 'killed', stoppedBy: 'operator' });
    expect(await sessions.finish(first.id, { status: 'ended', stopReason: 'manual', stopDetail: 'again', stoppedBy: 'x', endedAt: new Date() })).toBeNull();
    // After the session ended the project can join a new one.
    const next = await sessions.create(sessionInput([a.id]));
    expect((await sessions.list({ statuses: ['active'], projectIds: [a.id] })).map((s) => s.id)).toEqual([next.id]);
    expect((await sessions.list({ projectIds: [a.id] })).map((s) => s.id)).toEqual([next.id, first.id]);
  });

  it('persists the session of runs and approvals; saving a detached run clears it', async () => {
    const project = await makeProject('ap-runs');
    const session = await sessions.create(sessionInput([project.id]));
    const run = await sessionRun(project.id, session.id);
    expect(run.sessionId).toBe(session.id);
    expect((await repos.runs.list({ sessionId: session.id })).map((r) => r.id)).toEqual([run.id]);

    const parked = await repos.runs.save({ ...run, status: 'PARKED' });
    expect((await repos.runs.countByProject(['PARKED'])).get(project.id)).toBe(1);
    const detached = await repos.runs.save({ ...parked, status: 'PAUSED', sessionId: null });
    expect(detached.sessionId).toBeNull();

    const expiresAt = new Date(Date.now() + 58 * HOUR);
    const approval = await repos.approvals.create({ projectId: project.id, taskId: run.taskId, runId: run.id, action: 'database_migration', reason: 'migration', risk: 'medium', details: {}, mode: 'deferred', sessionId: session.id, expiresAt });
    expect(approval).toMatchObject({ mode: 'deferred', sessionId: session.id, expiresAt });
    const blocking = await repos.approvals.create({ projectId: project.id, taskId: run.taskId, runId: run.id, action: 'high_cost', reason: 'cost', risk: 'medium', details: {} });
    expect(blocking).toMatchObject({ mode: 'blocking', sessionId: null, expiresAt: null });
    expect((await repos.approvals.list({ sessionId: session.id })).map((a) => a.id)).toEqual([approval.id]);
  });

  it('expires blocking approvals after the TTL and deferred ones only at expires_at', async () => {
    const project = await makeProject('ap-expiry');
    const session = await sessions.create(sessionInput([project.id]));
    const run = await sessionRun(project.id, session.id);
    const now = new Date();
    const deferred = await repos.approvals.create({ projectId: project.id, taskId: run.taskId, runId: run.id, action: 'database_migration', reason: 'm', risk: 'medium', details: {}, mode: 'deferred', sessionId: session.id, expiresAt: new Date(now.getTime() + 118 * HOUR) });
    const blocking = await repos.approvals.create({ projectId: project.id, taskId: run.taskId, runId: run.id, action: 'high_cost', reason: 'c', risk: 'medium', details: {} });
    const ids = (approvals: Array<{ id: string }>) => approvals.map((a) => a.id).filter((id) => id === deferred.id || id === blocking.id);

    expect(ids(await repos.approvals.listDue(new Date(now.getTime() + 71 * HOUR), 72 * HOUR, 100))).toEqual([]);
    // At 73 h the blocking approval is due (ADR-023 unchanged); the deferred one requested at the same time is not.
    expect(ids(await repos.approvals.listDue(new Date(now.getTime() + 73 * HOUR), 72 * HOUR, 100))).toEqual([blocking.id]);
    expect(ids(await repos.approvals.listDue(new Date(now.getTime() + 119 * HOUR), 72 * HOUR, 100)).sort()).toEqual([blocking.id, deferred.id].sort());
  });

  it('attributes ledger spend, CI results and security denials to the session', async () => {
    const project = await makeProject('ap-stats');
    const other = await makeProject('ap-stats-other');
    const session = await sessions.create(sessionInput([project.id, other.id]));
    const run = await sessionRun(project.id, session.id);
    const otherRun = await sessionRun(other.id, session.id);
    const outside = await sessionRun(project.id, null);
    await spend(run, 1.25);
    await spend(otherRun, 0.5);
    await spend(outside, 9);

    for (const [type, classification] of [
      ['ci.failed', 'code'],
      ['ci.failed', 'infra'],
      ['ci.passed', null],
      ['ci.failed', 'code'],
    ] as const) {
      await repos.events.append({ type, projectId: project.id, taskId: run.taskId, runId: run.id, payload: type === 'ci.failed' ? { sha: 'abc1234', classification: classification! } : { sha: 'abc1234' } } as never);
    }
    await repos.events.append({ type: 'ci.failed', projectId: project.id, taskId: outside.taskId, runId: outside.id, payload: { sha: 'abc1234', classification: 'code' } });

    const denial = (sessionId: string, reason: string) =>
      admin.audit.record({ actorType: 'agent', actorId: 'builder', action: 'tool.git.branch.denied', target: project.id, details: { runId: run.id, sessionId, reason } });
    await denial(session.id, 'security: branch "main" is protected');
    await denial(session.id, 'security: path is not writable');
    await denial(session.id, 'autonomy: requires level 3');
    await denial('aps_other', 'security: branch "main" is protected');

    await repos.runs.save({ ...(await repos.runs.get(otherRun.id))!, status: 'BLOCKED', finishedAt: new Date(), blockedReason: 'test' });

    const stats = await sessions.stats(session, new Date());
    expect(stats.spentUsd).toBeCloseTo(1.75, 6);
    expect(stats.spentLastHourUsd).toBeCloseTo(1.75, 6);
    expect(stats.ciResults).toEqual([
      { passed: false, classification: 'code' },
      { passed: false, classification: 'infra' },
      { passed: true, classification: null },
      { passed: false, classification: 'code' },
    ]);
    expect(stats.securityDenials).toBe(2);
    expect(stats.finishedRuns).toEqual([expect.objectContaining({ runId: otherRun.id, status: 'BLOCKED' })]);
    expect(await sessions.spentUsd(session)).toBeCloseTo(1.75, 6);

    const input = await sessions.digestInput(session);
    expect(input.runs.map((r) => r.id).sort()).toEqual([run.id, otherRun.id].sort());
    expect(input.taskTitles.get(run.taskId)).toBe('Add search');
    expect([...input.costByProject].sort((x, y) => x.projectId.localeCompare(y.projectId))).toEqual(
      [
        { projectId: project.id, costUsd: 1.25 },
        { projectId: other.id, costUsd: 0.5 },
      ].sort((x, y) => x.projectId.localeCompare(y.projectId)),
    );

    // Spend after the session ended is not attributed to it.
    const ended = (await sessions.finish(session.id, { status: 'ended', stopReason: 'manual', stopDetail: 'back', stoppedBy: 'owner', endedAt: new Date(Date.now() - 1) }))!;
    await spend(run, 3);
    expect(await sessions.spentUsd(ended)).toBeCloseTo(1.75, 6);
  });
});
