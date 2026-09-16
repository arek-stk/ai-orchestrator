import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub, TERMINAL_RUN_STATUSES, type Clock, type PipelineRun } from '@orch/core';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

// Autopilot stage 2+3 API: decision requests and council transcripts (RBAC, per-project ACL), confirm/reject of
// provisional decisions from the digest (admin, audit, single review), and the council thread in the Project Room.
// No provider keys are configured, so the demo responders of the mock provider play all agents.

const ORIGIN = 'http://localhost:3000';
let now = Date.now();
const clock: Clock = { now: () => new Date(now) };

let container: Container;
let app: FastifyInstance;
let workers: WorkerPool;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', session: '', request: '', decision: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });

async function settle(runId: string): Promise<PipelineRun> {
  for (let i = 0; i < 80; i++) {
    await workers.drain();
    const run = (await container.repos.runs.get(runId))!;
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === 'PARKED' || run.checkpoint.pendingApprovalId) return run;
    now += 2 * 60_000;
  }
  throw new Error('run did not settle');
}

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'src/index.ts': 'export {};\n', 'docs/DECISIONS.md': '# ADRs\n\n## ADR-001 — Monorepo\n* **Status:** Accepted\n' });
  github.seed({ owner: 'acme', name: 'beta' }, { 'src/index.ts': 'export {};\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github, clock });
  app = await buildApp(container);
  workers = new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 });

  cookies.alice = await login('alice'); // first user: owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.olga = await login('olga'); // operator without memberships
  cookies.vic = await login('vic'); // viewer, member of A
  cookies.ada = await login('ada'); // admin

  for (const [key, name, repo] of [
    ['projectA', 'Alpha', 'alpha'],
    ['projectB', 'Beta', 'beta'],
  ] as const) {
    const created = await send('alice', 'POST', '/api/projects', { name, repo: { owner: 'acme', name: repo }, autonomyLevel: 3 });
    expect(created.statusCode).toBe(201);
    ids[key] = created.json().project.id;
  }
  const users = (await get('alice', '/api/users')).json().users as Array<{ id: string; login: string }>;
  const userId = (login: string) => users.find((u) => u.login === login)!.id;
  expect((await send('alice', 'PATCH', `/api/users/${userId('vic')}/role`, { role: 'viewer' })).statusCode).toBe(200);
  expect((await send('alice', 'PATCH', `/api/users/${userId('ada')}/role`, { role: 'admin' })).statusCode).toBe(200);
  cookies.vic = await login('vic');
  cookies.ada = await login('ada');
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${userId('bob')}`, { role: 'operator' })).statusCode).toBe(200);
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${userId('vic')}`, { role: 'viewer' })).statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('autopilot decision ladder API', () => {
  it('settles a session run design question through the ladder and exposes it ACL-filtered', async () => {
    const started = await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectA, ids.projectB], durationHours: 4, budgetUsd: 5 });
    expect(started.statusCode).toBe(201);
    ids.session = started.json().session.id;
    const task = await send('alice', 'POST', `/api/projects/${ids.projectA}/tasks`, { title: 'Add product search', goal: 'Customers can search products', kind: 'feature', estimatedComplexity: 'medium' });
    expect(task.statusCode).toBe(201);

    await workers.tick();
    const [run] = await container.repos.runs.list({ sessionId: ids.session });
    const settled = await settle(run!.id);
    expect(settled.stageStates.DESIGN?.status).toBe('passed');

    const list = await get('alice', `/api/autopilot/decision-requests?sessionId=${ids.session}`);
    expect(list.statusCode).toBe(200);
    const [request] = list.json().requests;
    // Demo mode runs on one provider (mock): the critic is routed to another mock model, the decision is marked
    // single-provider and needs the raised threshold.
    expect(request).toMatchObject({ projectId: ids.projectA, kind: 'design_choice', status: 'answered', rung: 'council', answer: { diversity: 'cross_model', singleProvider: true } });
    ids.request = request.id;
    ids.decision = request.decisionId;

    const detail = await get('vic', `/api/autopilot/decision-requests/${ids.request}`);
    expect(detail.statusCode).toBe(200);
    const [council] = detail.json().councils;
    expect(council).toMatchObject({ status: 'decided', diversity: 'cross_model' });
    expect(council.turns.map((t: { kind: string }) => t.kind)).toEqual(expect.arrayContaining(['brief', 'proposal', 'critique', 'evidence_result', 'vote', 'synthesis']));

    // Per-project ACL: outsiders see nothing, filters on hidden projects are denied.
    expect((await get('olga', `/api/autopilot/decision-requests/${ids.request}`)).statusCode).toBe(404);
    expect((await get('olga', `/api/autopilot/decision-requests?sessionId=${ids.session}`)).statusCode).toBe(404);
    expect((await get('olga', '/api/autopilot/decision-requests')).json().requests).toEqual([]);
    expect((await get('vic', `/api/autopilot/decision-requests?projectId=${ids.projectB}`)).statusCode).toBe(404);
    expect((await get('vic', '/api/autopilot/decision-requests')).json().requests.map((r: { id: string }) => r.id)).toEqual([ids.request]);

    // The council transcript is a thread in the project room, readable through the room API.
    const room = await get('vic', `/api/projects/${ids.projectA}/room/messages?limit=100`);
    const root = (room.json().messages as Array<{ id: string; body: string; replyCount: number }>).find((m) => m.body.startsWith('Council convened'));
    expect(root).toBeDefined();
    expect(root!.replyCount).toBeGreaterThan(3);
    const replies = (await get('vic', `/api/projects/${ids.projectA}/room/messages/${root!.id}/replies`)).json().replies as Array<{ intent: string; authorName: string }>;
    expect(replies.some((r) => r.authorName === 'Critic' && r.intent === 'objection')).toBe(true);
    expect(replies.at(-1)).toMatchObject({ intent: 'decision' });
  });

  it('shows provisional decisions and questions in the digest and lets only admins confirm or reject them once', async () => {
    const digest = (await get('alice', `/api/autopilot/sessions/${ids.session}/digest`)).json().digest;
    expect(digest.totals).toMatchObject({ decisionsToReview: 1, questionsParked: 0 });
    expect(digest.decisions).toEqual([expect.objectContaining({ decisionId: ids.decision, status: 'provisional', origin: 'autopilot_council', diversity: 'cross_model', singleProvider: true })]);
    expect(digest.questions).toEqual([expect.objectContaining({ requestId: ids.request, status: 'answered', rung: 'council' })]);

    // RBAC: viewers and operators cannot review; CSRF origin is checked.
    expect((await send('vic', 'POST', `/api/autopilot/decisions/${ids.decision}/confirm`, {})).statusCode).toBe(403);
    expect((await send('bob', 'POST', `/api/autopilot/decisions/${ids.decision}/confirm`, {})).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/autopilot/decisions/${ids.decision}/confirm`, headers: { cookie: cookies.ada!, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    // A rejection needs a reason; unknown decisions are 404.
    expect((await send('ada', 'POST', `/api/autopilot/decisions/${ids.decision}/reject`, {})).statusCode).toBe(400);
    expect((await send('ada', 'POST', '/api/autopilot/decisions/dec_missing/confirm', {})).statusCode).toBe(404);

    const confirmed = await send('ada', 'POST', `/api/autopilot/decisions/${ids.decision}/confirm`, { comment: 'Good call' });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().decision).toMatchObject({ status: 'confirmed', reviewedBy: 'ada', reviewComment: 'Good call' });
    expect((await send('alice', 'POST', `/api/autopilot/decisions/${ids.decision}/reject`, { reason: 'changed my mind' })).statusCode).toBe(409);

    const [audit] = await container.admin.audit.list({ action: 'autopilot.decision.confirm', limit: 1 });
    expect(audit).toMatchObject({ actorType: 'user', target: ids.decision, details: { withComment: true, by: 'ada' } });
    const events = (await get('vic', `/api/events?projectId=${ids.projectA}`)).json().events as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['decision_request.created', 'council.started', 'council.finished', 'decision_request.resolved', 'decision.reviewed']));

    // A provisional decision of another project is rejected with a reason and never reused.
    const other = await container.repos.decisions.create({
      projectId: ids.projectB,
      taskId: null,
      runId: null,
      question: 'Which queue?',
      questionKey: 'qk-queue',
      options: [],
      consulted: [],
      evidence: [],
      decision: 'Use the database queue',
      chosenOptionId: null,
      reason: 'precedent',
      confidence: 0.9,
      costUsd: 0,
      supersedesId: null,
      origin: 'autopilot_precedent',
      status: 'provisional',
      sessionId: ids.session,
    });
    const rejected = await send('alice', 'POST', `/api/autopilot/decisions/${other.id}/reject`, { reason: 'We are moving to a managed queue' });
    expect(rejected.statusCode).toBe(200);
    expect(await container.repos.decisions.findByQuestionKey(ids.projectB, 'qk-queue')).toBeNull();

    // The viewer restricted to project A sees only A's decisions in the digest.
    const vicDigest = (await get('vic', `/api/autopilot/sessions/${ids.session}/digest`)).json().digest;
    expect(vicDigest.decisions.map((d: { projectId: string }) => d.projectId)).toEqual([ids.projectA]);
    expect(vicDigest.totals).toMatchObject({ decisions: 1, decisionsToReview: 0 });
  });
});
