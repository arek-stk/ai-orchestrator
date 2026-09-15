import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub, TERMINAL_RUN_STATUSES, type Clock, type PipelineRun } from '@orch/core';
import { expireApprovals } from './approval-expiry';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

// Autopilot API (ADR-034): RBAC, per-project ACL, the pipeline through workers inside a session, kill switch,
// deferred approval expiry and automatic stops from the worker tick.

const ORIGIN = 'http://localhost:3000';
const HOUR = 60 * 60 * 1000;
let now = Date.now();
const clock: Clock = { now: () => new Date(now) };

let container: Container;
let app: FastifyInstance;
let workers: WorkerPool;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', userBob: '', userVic: '', session: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });

/** Drives a run through the workers with a moving clock until it finishes or waits for a human. */
async function settle(runId: string): Promise<PipelineRun> {
  for (let i = 0; i < 60; i++) {
    await workers.drain();
    const run = (await container.repos.runs.get(runId))!;
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === 'PARKED' || run.checkpoint.pendingApprovalId) return run;
    now += 2 * 60_000;
  }
  throw new Error('run did not settle');
}

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'src/index.ts': 'export {};\n', 'README.md': '# Alpha\n' });
  github.seed({ owner: 'acme', name: 'beta' }, { 'src/index.ts': 'export {};\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, APPROVAL_TTL_HOURS: '72', ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github, clock });
  app = await buildApp(container);
  workers = new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 });

  cookies.alice = await login('alice'); // first user: owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.olga = await login('olga'); // operator without memberships
  cookies.vic = await login('vic');

  for (const [key, name, repo] of [
    ['projectA', 'Alpha', 'alpha'],
    ['projectB', 'Beta', 'beta'],
  ] as const) {
    const created = await send('alice', 'POST', '/api/projects', { name, repo: { owner: 'acme', name: repo }, autonomyLevel: 3 });
    expect(created.statusCode).toBe(201);
    ids[key] = created.json().project.id;
  }
  const users = (await get('alice', '/api/users')).json().users as Array<{ id: string; login: string }>;
  ids.userBob = users.find((u) => u.login === 'bob')!.id;
  ids.userVic = users.find((u) => u.login === 'vic')!.id;
  expect((await send('alice', 'PATCH', `/api/users/${ids.userVic}/role`, { role: 'viewer' })).statusCode).toBe(200);
  cookies.vic = await login('vic');
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${ids.userBob}`, { role: 'operator' })).statusCode).toBe(200);
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${ids.userVic}`, { role: 'viewer' })).statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('autopilot API', () => {
  it('exposes the instance limits and what stays parked for humans', async () => {
    const response = await get('vic', '/api/autopilot/config');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, maxHours: 72, maxAutonomy: 3, returnGraceHours: 48, approvalTtlHours: 72 });
    expect(response.json().parkedForHumans.length).toBeGreaterThan(0);
  });

  it('only admins and owners start sessions; input is validated and one active session per project is enforced', async () => {
    const body = { projectIds: [ids.projectA, ids.projectB], durationHours: 4, budgetUsd: 5 };
    expect((await send('bob', 'POST', '/api/autopilot/sessions', body)).statusCode).toBe(403);
    expect((await send('vic', 'POST', '/api/autopilot/sessions', body)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/autopilot/sessions', headers: { cookie: cookies.alice!, origin: 'https://evil.example' }, payload: body })).statusCode).toBe(403);
    expect((await send('alice', 'POST', '/api/autopilot/sessions', { ...body, durationHours: 999 })).statusCode).toBe(400);
    expect((await send('alice', 'POST', '/api/autopilot/sessions', { ...body, autonomyCeiling: 4 })).statusCode).toBe(400);
    expect((await send('alice', 'POST', '/api/autopilot/sessions', { ...body, projectIds: ['prj_missing'] })).statusCode).toBe(404);

    const started = await send('alice', 'POST', '/api/autopilot/sessions', body);
    expect(started.statusCode).toBe(201);
    const { session, projects } = started.json();
    ids.session = session.id;
    // No real provider is configured in tests: the session is flagged as a demo session.
    expect(session).toMatchObject({ status: 'active', demo: true, projectIds: [ids.projectA, ids.projectB], maxParkedRuns: 3, progress: { runsStarted: 0, spentUsd: 0 } });
    expect(projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids.projectA, baseAutonomy: 3, effectiveAutonomy: 3 })]));

    const conflict = await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectB], durationHours: 1, budgetUsd: 1 });
    expect(conflict.statusCode).toBe(409);

    const audit = await container.admin.audit.list({ action: 'autopilot.session.start' });
    expect(audit[0]).toMatchObject({ actorType: 'user', target: session.id });
    const events = (await get('bob', `/api/events?projectId=${ids.projectA}`)).json().events as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('autopilot.session.started');
  });

  it('runs existing tasks through the workers inside the session with the session id on runs and tool audit', async () => {
    const task = await send('alice', 'POST', `/api/projects/${ids.projectA}/tasks`, { title: 'Add search', goal: 'Customers can search products' });
    expect(task.statusCode).toBe(201);
    await send('alice', 'POST', `/api/projects/${ids.projectA}/tasks`, { title: 'Rotate secrets', goal: 'Rotate the API credentials', risk: 'high' });

    await workers.tick();
    const runs = await container.repos.runs.list({ sessionId: ids.session });
    expect(runs.map((r) => r.taskId)).toEqual([task.json().task.id]);
    const run = await settle(runs[0]!.id);
    expect(run.sessionId).toBe(ids.session);

    const toolEntries = (await container.admin.audit.list({ limit: 1000 })).filter((e) => e.action.startsWith('tool.'));
    expect(toolEntries.some((e) => (e.details as { sessionId?: string }).sessionId === ids.session)).toBe(true);

    const digest = (await get('alice', `/api/autopilot/sessions/${ids.session}/digest`)).json().digest;
    expect(digest).toMatchObject({ sessionId: ids.session, status: 'active', demo: true, totals: { runsStarted: 1 } });
    expect(digest.projects.map((p: { projectId: string }) => p.projectId).sort()).toEqual([ids.projectA, ids.projectB].sort());
    const ledgerSum = await container.autopilotSessions.spentUsd((await container.autopilotSessions.get(ids.session))!);
    expect(digest.costs.totalUsd).toBeCloseTo(ledgerSum, 6);
  });

  it('applies the per-project ACL to reads: projects outside the viewer ACL are omitted, foreign sessions are 404', async () => {
    const bobList = (await get('bob', '/api/autopilot/sessions')).json().sessions;
    expect(bobList).toHaveLength(1);
    expect(bobList[0]).toMatchObject({ id: ids.session, projectIds: [ids.projectA], progress: { spentUsd: null } });

    expect((await get('olga', '/api/autopilot/sessions')).json().sessions).toEqual([]);
    expect((await get('olga', `/api/autopilot/sessions/${ids.session}`)).statusCode).toBe(404);
    expect((await get('olga', `/api/autopilot/sessions/${ids.session}/digest`)).statusCode).toBe(404);

    const vicDigest = await get('vic', `/api/autopilot/sessions/${ids.session}/digest`);
    expect(vicDigest.statusCode).toBe(200);
    expect(vicDigest.json().digest.projects.map((p: { projectId: string }) => p.projectId)).toEqual([ids.projectA]);
    expect(vicDigest.json().digest.costs.byProject.every((c: { projectId: string }) => c.projectId === ids.projectA)).toBe(true);
    expect((await get('vic', '/api/autopilot/sessions/aps_missing')).statusCode).toBe(404);
  });

  it('the kill switch: operators kill sessions they can act on; viewers and outsiders cannot', async () => {
    expect((await send('vic', 'POST', '/api/autopilot/kill', { sessionId: ids.session })).statusCode).toBe(403);
    expect((await send('vic', 'POST', `/api/autopilot/sessions/${ids.session}/stop`)).statusCode).toBe(403);
    expect((await send('olga', 'POST', '/api/autopilot/kill', { sessionId: ids.session })).statusCode).toBe(404);
    expect((await send('olga', 'POST', `/api/autopilot/sessions/${ids.session}/stop`)).statusCode).toBe(404);
    // Kill-all without a session id only reaches sessions the operator can act on.
    expect((await send('olga', 'POST', '/api/autopilot/kill', {})).json()).toEqual({ killed: [] });

    const killed = await send('bob', 'POST', '/api/autopilot/kill', { sessionId: ids.session });
    expect(killed.statusCode).toBe(200);
    expect(killed.json().killed).toEqual([expect.objectContaining({ sessionId: ids.session })]);
    expect((await send('bob', 'POST', '/api/autopilot/kill', { sessionId: ids.session })).statusCode).toBe(409);
    expect((await send('bob', 'POST', `/api/autopilot/sessions/${ids.session}/stop`)).statusCode).toBe(409);

    const session = (await get('alice', `/api/autopilot/sessions/${ids.session}`)).json().session;
    expect(session).toMatchObject({ status: 'killed', stopReason: 'killed', stoppedBy: 'bob', stopDetail: 'killed by bob' });
    // Vic sees only project A of this two-project session: no session-wide aggregates.
    const vicSession = (await get('vic', `/api/autopilot/sessions/${ids.session}`)).json().session;
    expect(vicSession).toMatchObject({ status: 'killed', stopReason: 'killed', stopDetail: null, projectIds: [ids.projectA], progress: { spentUsd: null } });
    const vicDigest = (await get('vic', `/api/autopilot/sessions/${ids.session}/digest`)).json().digest;
    expect(vicDigest.stop.detail).toBeNull();
    expect(vicDigest.costs.budgetUsedPct).toBeCloseTo(Math.min(100, Math.round((vicDigest.costs.totalUsd / vicDigest.costs.budgetUsd) * 1000) / 10), 6);
    const [entry] = await container.admin.audit.list({ action: 'autopilot.session.kill', limit: 1 });
    expect(entry).toMatchObject({ actorType: 'user', actorId: ids.userBob, target: ids.session });
    const events = (await get('bob', `/api/events?projectId=${ids.projectA}`)).json().events as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('autopilot.session.killed');

    // Tool calls carrying the killed session id are denied by the router.
    const project = (await container.repos.projects.get(ids.projectA))!;
    await expect(
      container.orchestrator.tools.invoke('git.branch', { branch: 'orchestrator/x', fromSha: 'abcdef1' }, { project, agentRole: 'orchestrator', taskId: null, runId: null, approvedActions: [], sessionId: ids.session }),
    ).rejects.toMatchObject({ reason: 'autonomy' });
  });

  it('operators stop sessions gracefully; the worker tick and restart recovery end sessions whose time box passed', async () => {
    const started = await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectA], durationHours: 1, budgetUsd: 2 });
    expect(started.statusCode).toBe(201);
    const stopped = await send('bob', 'POST', `/api/autopilot/sessions/${started.json().session.id}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().session).toMatchObject({ status: 'ended', stopReason: 'manual', stoppedBy: 'bob' });

    const timed = (await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectA], durationHours: 1, budgetUsd: 2 })).json().session;
    const other = (await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectB], durationHours: 3, budgetUsd: 2 })).json().session;
    now += HOUR + 1000;
    await workers.tick();
    expect((await container.autopilotSessions.get(timed.id))!).toMatchObject({ status: 'ended', stopReason: 'time_box', stoppedBy: 'system' });
    expect((await container.autopilotSessions.get(other.id))!.status).toBe('active');

    now += 3 * HOUR;
    expect(await container.autopilot.recover()).toEqual({ resumed: 0, stopped: 1 });
    expect((await container.autopilotSessions.get(other.id))!.stopReason).toBe('time_box');
  });

  it('expires deferred approvals at expires_at and blocking approvals after the TTL (ADR-023 unchanged)', async () => {
    const session = (await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectB], durationHours: 70, budgetUsd: 2 })).json().session;
    const requestedAt = now;
    const deferred = await container.repos.approvals.create({
      projectId: ids.projectB,
      taskId: null,
      runId: null,
      action: 'database_migration',
      reason: 'migration detected',
      risk: 'medium',
      details: {},
      mode: 'deferred',
      sessionId: session.id,
      expiresAt: new Date(requestedAt + 118 * HOUR),
    });
    const blocking = await container.repos.approvals.create({ projectId: ids.projectB, taskId: null, runId: null, action: 'high_cost', reason: 'cost', risk: 'medium', details: {} });

    // Approvals are listed with their mode, so the UI can show parked ones distinctly.
    const pending = (await get('alice', `/api/approvals?status=pending&projectId=${ids.projectB}`)).json().approvals as Array<{ id: string; mode: string; sessionId: string | null }>;
    expect(pending.find((a) => a.id === deferred.id)).toMatchObject({ mode: 'deferred', sessionId: session.id });

    // The blocking approval's requested_at is the database clock (not later than the fake clock here).
    now = requestedAt + 73 * HOUR;
    await expireApprovals(container);
    expect((await container.repos.approvals.get(blocking.id))!.status).toBe('expired');
    expect((await container.repos.approvals.get(deferred.id))!.status).toBe('pending');

    now = requestedAt + 119 * HOUR;
    await expireApprovals(container);
    const expired = (await container.repos.approvals.get(deferred.id))!;
    expect(expired).toMatchObject({ status: 'expired', decidedBy: 'system' });
    expect(expired.comment).toContain('autopilot session end');
    const audit = (await container.admin.audit.list({ action: 'approval.expired', limit: 10 })).find((e) => e.target === deferred.id);
    expect(audit?.details).toMatchObject({ mode: 'deferred', sessionId: session.id });
  });
});
