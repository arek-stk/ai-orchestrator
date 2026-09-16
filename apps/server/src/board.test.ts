import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub, type AnyDomainEvent } from '@orch/core';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3000';

let container: Container;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', bob: '', vic: '', dave: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });
const base = (project: string) => `/api/projects/${project}`;
const card = async (user: string, project: string, payload: object = {}) => {
  const response = await send(user, 'POST', `${base(project)}/board/cards`, { title: 'Add wishlist', goal: 'Customers keep products for later', ...payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().task as { id: string; status: string; schedulingHold: boolean };
};

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'src/index.ts': 'export {};\n', 'README.md': '# Alpha\n' });
  github.seed({ owner: 'acme', name: 'beta' }, { 'src/index.ts': 'export {};\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);

  cookies.alice = await login('alice'); // first user: owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.vic = await login('vic'); // viewer, member of A
  cookies.dave = await login('dave'); // operator, member of B only
  for (const [key, name, repo] of [
    ['projectA', 'Alpha', 'alpha'],
    ['projectB', 'Beta', 'beta'],
  ] as const) {
    const created = await send('alice', 'POST', '/api/projects', { name, repo: { owner: 'acme', name: repo }, autonomyLevel: 3 });
    expect(created.statusCode).toBe(201);
    ids[key] = created.json().project.id;
  }
  const users = (await get('alice', '/api/users')).json().users as Array<{ id: string; login: string }>;
  ids.bob = users.find((u) => u.login === 'bob')!.id;
  ids.vic = users.find((u) => u.login === 'vic')!.id;
  ids.dave = users.find((u) => u.login === 'dave')!.id;
  expect((await send('alice', 'PATCH', `/api/users/${ids.vic}/role`, { role: 'viewer' })).statusCode).toBe(200);
  cookies.vic = await login('vic');
  for (const [project, user, role] of [
    [ids.projectA, ids.bob, 'operator'],
    [ids.projectA, ids.vic, 'viewer'],
    [ids.projectB, ids.dave, 'operator'],
  ] as const) {
    expect((await send('alice', 'PUT', `/api/projects/${project}/members/${user}`, { role })).statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('Board API', () => {
  it('creates held cards, never starts them on a move and starts them only after an explicit release', async () => {
    const created = await card('bob', ids.projectA, { column: 'backlog', estimatePoints: 3, labels: ['ui'] });
    expect(created).toMatchObject({ status: 'BACKLOG', schedulingHold: true });

    const moved = await send('bob', 'POST', `${base(ids.projectA)}/board/cards/${created.id}/move`, { to: 'ready' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ from: 'backlog', to: 'ready', mayStartRun: false, task: { status: 'READY', schedulingHold: true } });

    const worker = new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 });
    await worker.tick();
    expect(await container.repos.runs.list({ taskId: created.id })).toEqual([]);

    const released = await send('bob', 'POST', `${base(ids.projectA)}/board/cards/${created.id}/move`, { to: 'ready', index: 0, release: true });
    expect(released.json()).toMatchObject({ mayStartRun: true, task: { schedulingHold: false } });
    await worker.tick();
    expect(await container.repos.runs.list({ taskId: created.id })).toHaveLength(1);

    const audit = (await get('alice', '/api/audit?action=board.card.move')).json().entries as Array<{ details: Record<string, unknown> }>;
    expect(audit.map((e) => e.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: created.id, from: 'backlog', to: 'ready', release: false, mayStartRun: false }),
        expect.objectContaining({ taskId: created.id, from: 'ready', to: 'ready', release: true, mayStartRun: true }),
      ]),
    );
    expect((await get('alice', '/api/audit?action=board.card.create')).json().entries[0]).toMatchObject({ target: ids.projectA, details: { taskId: created.id, schedulingHold: true } });

    const board = (await get('vic', `${base(ids.projectA)}/board`)).json();
    expect(board.columns.map((c: { id: string }) => c.id)).toEqual(['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
    expect(board.columns.find((c: { id: string }) => c.id === 'in_progress').wip).toMatchObject({ limit: 2 });
    expect(board.assignees.map((a: { login: string }) => a.login).sort()).toEqual(['alice', 'bob']);

    const notices = (await get('vic', `${base(ids.projectA)}/room/messages?limit=100`)).json().messages as Array<{ authorType: string; body: string }>;
    expect(notices.some((m) => m.authorType === 'system' && m.body === 'bob moved “Add wishlist” from Backlog to Ready. It is on hold.')).toBe(true);
  });

  it('enforces roles: viewers read, operators mutate, anonymous and cross-origin requests are rejected', async () => {
    const created = await card('alice', ids.projectA);
    expect((await get('vic', `${base(ids.projectA)}/board`)).statusCode).toBe(200);
    expect((await get('vic', `${base(ids.projectA)}/milestones`)).statusCode).toBe(200);
    expect((await get('vic', `${base(ids.projectA)}/leases`)).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ['POST', `${base(ids.projectA)}/board/cards`, { title: 'Nope', goal: 'Viewer cannot' }],
      ['POST', `${base(ids.projectA)}/board/cards/${created.id}/move`, { to: 'ready' }],
      ['PATCH', `${base(ids.projectA)}/board/cards/${created.id}`, { labels: ['x'] }],
      ['POST', `${base(ids.projectA)}/board/cards/${created.id}/release`, {}],
      ['POST', `/api/tasks/${created.id}/release`, {}],
      ['POST', `${base(ids.projectA)}/milestones`, { title: 'Beta' }],
      ['POST', `${base(ids.projectA)}/leases`, { scope: 'task', taskId: created.id }],
    ] as const) {
      expect((await send('vic', method, url, payload)).statusCode, url).toBe(403);
    }
    expect((await app.inject({ url: `${base(ids.projectA)}/board` })).statusCode).toBe(401);
    const crossOrigin = await app.inject({ method: 'POST', url: `${base(ids.projectA)}/board/cards/${created.id}/move`, headers: { cookie: cookies.bob!, origin: 'https://evil.example' }, payload: { to: 'ready' } });
    expect(crossOrigin.statusCode).toBe(403);
  });

  it('denies every board, milestone, hold and lease route of a foreign project with 404', async () => {
    const foreignCard = await card('dave', ids.projectB);
    const milestone = (await send('dave', 'POST', `${base(ids.projectB)}/milestones`, { title: 'Beta launch' })).json().milestone;
    const lease = (await send('dave', 'POST', `${base(ids.projectB)}/leases`, { scope: 'paths', paths: ['src/**'] })).json().lease;
    for (const url of [`${base(ids.projectB)}/board`, `${base(ids.projectB)}/milestones`, `${base(ids.projectB)}/leases`]) {
      expect((await get('bob', url)).statusCode, url).toBe(404);
    }
    for (const [method, url, payload] of [
      ['POST', `${base(ids.projectB)}/board/cards`, { title: 'Sneaky', goal: 'Not my project' }],
      ['POST', `${base(ids.projectB)}/board/cards/${foreignCard.id}/move`, { to: 'ready', release: true }],
      ['PATCH', `${base(ids.projectB)}/board/cards/${foreignCard.id}`, { labels: ['x'] }],
      ['POST', `${base(ids.projectB)}/board/cards/${foreignCard.id}/release`, {}],
      ['POST', `/api/tasks/${foreignCard.id}/release`, {}],
      ['POST', `/api/tasks/${foreignCard.id}/hold`, {}],
      ['PATCH', `${base(ids.projectB)}/milestones/${milestone.id}`, { status: 'done' }],
      ['DELETE', `${base(ids.projectB)}/milestones/${milestone.id}`, undefined],
      ['POST', `${base(ids.projectB)}/leases`, { scope: 'paths', paths: ['docs/**'] }],
      ['POST', `${base(ids.projectB)}/leases/${lease.id}/release`, {}],
      // Foreign ids addressed through the operator's own project are not found either.
      ['POST', `${base(ids.projectA)}/board/cards/${foreignCard.id}/move`, { to: 'ready', release: true }],
      ['PATCH', `${base(ids.projectA)}/board/cards/${foreignCard.id}`, { milestoneId: null }],
      ['PATCH', `${base(ids.projectA)}/milestones/${milestone.id}`, { status: 'done' }],
      ['POST', `${base(ids.projectA)}/leases/${lease.id}/release`, {}],
      ['POST', `${base(ids.projectA)}/leases`, { scope: 'task', taskId: foreignCard.id }],
    ] as const) {
      const response = await send('bob', method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    // A card in the own project cannot be attached to a foreign milestone.
    const own = await card('bob', ids.projectA);
    expect((await send('bob', 'PATCH', `${base(ids.projectA)}/board/cards/${own.id}`, { milestoneId: milestone.id })).statusCode).toBe(404);
    expect((await container.repos.tasks.get(foreignCard.id))!.schedulingHold).toBe(true);
  });

  it('assigns cards only to people who may operate the project and lets assignees move their own work', async () => {
    const created = await card('alice', ids.projectA, { column: 'ready' });
    const url = `${base(ids.projectA)}/board/cards/${created.id}`;
    expect((await send('alice', 'PATCH', url, { assignee: { type: 'user', id: ids.vic } })).statusCode).toBe(400);
    expect((await send('alice', 'PATCH', url, { assignee: { type: 'user', id: ids.dave } })).statusCode).toBe(400);
    expect((await send('alice', 'PATCH', url, { assignee: { type: 'external_ai', id: 'ai_1' } })).statusCode).toBe(400);
    const assigned = await send('alice', 'PATCH', url, { assignee: { type: 'user', id: ids.bob }, estimatePoints: 5, labels: ['api', 'API'], dueDate: '2026-10-01' });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json().task).toMatchObject({ assigneeType: 'user', assigneeId: ids.bob, estimatePoints: 5, labels: ['api'], dueDate: '2026-10-01' });
    expect((await send('alice', 'PATCH', url, { estimatePoints: 4 })).statusCode).toBe(400);
    expect((await send('alice', 'PATCH', url, { unknown: true })).statusCode).toBe(400);

    // Bob works on it himself; the orchestrator never starts it.
    const inProgress = await send('bob', 'POST', `${url}/move`, { to: 'in_progress' });
    expect(inProgress.statusCode, inProgress.body).toBe(200);
    expect(inProgress.json()).toMatchObject({ to: 'in_progress', task: { status: 'RUNNING' }, wip: { limit: 2 } });
    expect(await container.repos.runs.list({ taskId: created.id })).toEqual([]);
    expect((await send('bob', 'POST', `${url}/release`, {})).statusCode).toBe(409);

    // Moving the orchestrator's own cards into pipeline columns is refused with a reason.
    const orchestratorCard = await card('alice', ids.projectA);
    const refused = await send('bob', 'POST', `${base(ids.projectA)}/board/cards/${orchestratorCard.id}/move`, { to: 'done' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'pipeline_controlled' });
    const assignedAudit = (await get('alice', '/api/audit?action=board.card.update')).json().entries[0];
    expect(assignedAudit).toMatchObject({ details: { taskId: created.id, assigneeType: 'user', assigneeId: ids.bob } });
  });

  it('manages milestones with validation, progress and room notices', async () => {
    const created = await send('bob', 'POST', `${base(ids.projectA)}/milestones`, { title: 'Search MVP', startDate: '2026-09-01', dueDate: '2026-09-30', status: 'active' });
    expect(created.statusCode, created.body).toBe(201);
    const milestone = created.json().milestone;
    expect((await send('bob', 'POST', `${base(ids.projectA)}/milestones`, { title: 'Bad', startDate: '2026-10-01', dueDate: '2026-09-01' })).statusCode).toBe(400);
    expect((await send('bob', 'POST', `${base(ids.projectA)}/milestones`, { title: 'Bad date', dueDate: '2026-02-30' })).statusCode).toBe(400);
    expect((await send('bob', 'PATCH', `${base(ids.projectA)}/milestones/${milestone.id}`, { startDate: '2026-10-15' })).statusCode).toBe(400);

    const done = await card('bob', ids.projectA, { milestoneId: milestone.id, estimatePoints: 8 });
    await card('bob', ids.projectA, { milestoneId: milestone.id, estimatePoints: 2 });
    await container.repos.tasks.update(done.id, { status: 'DONE' });
    const listed = (await get('vic', `${base(ids.projectA)}/milestones`)).json().milestones;
    expect(listed.find((m: { id: string }) => m.id === milestone.id).progress).toMatchObject({ total: 2, done: 1, points: 10, pointsDone: 8, pct: 80 });

    expect((await send('bob', 'PATCH', `${base(ids.projectA)}/milestones/${milestone.id}`, { status: 'done' })).json().milestone.status).toBe('done');
    expect((await send('bob', 'DELETE', `${base(ids.projectA)}/milestones/${milestone.id}`)).statusCode).toBe(200);
    expect((await container.repos.tasks.get(done.id))!.milestoneId).toBeNull();

    const bodies = ((await get('vic', `${base(ids.projectA)}/room/messages?limit=100`)).json().messages as Array<{ body: string }>).map((m) => m.body);
    expect(bodies).toEqual(expect.arrayContaining(['bob created milestone “Search MVP”.', 'bob marked milestone “Search MVP” as done.', 'bob deleted milestone “Search MVP”; its tasks remain.']));
    const actions = ((await get('alice', '/api/audit?limit=200')).json().entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['milestone.create', 'milestone.update', 'milestone.delete']));
  });

  it('grants leases, reports conflicts, lets only holders extend and admins break them', async () => {
    const url = `${base(ids.projectA)}/leases`;
    expect((await send('bob', 'POST', url, { scope: 'paths', paths: ['../etc/passwd'] })).statusCode).toBe(400);
    expect((await send('bob', 'POST', url, { scope: 'task' })).statusCode).toBe(400);
    const acquired = await send('bob', 'POST', url, { scope: 'paths', paths: ['src/auth/**'], reason: 'refactoring auth', ttlMinutes: 60 });
    expect(acquired.statusCode, acquired.body).toBe(201);
    const lease = acquired.json().lease;

    const conflict = await send('alice', 'POST', url, { scope: 'paths', paths: ['src/**/*.ts'] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'lease_conflict', conflicts: [{ holderName: 'bob', pathGlobs: ['src/auth/**'] }] });
    expect((await send('alice', 'POST', `${url}/${lease.id}/heartbeat`, {})).statusCode).toBe(403);
    expect((await send('bob', 'POST', `${url}/${lease.id}/heartbeat`, { ttlMinutes: 90 })).statusCode).toBe(200);
    expect((await get('vic', url)).json().leases.map((l: { id: string }) => l.id)).toContain(lease.id);

    const broken = await send('alice', 'POST', `${url}/${lease.id}/release`, {});
    expect(broken.json()).toMatchObject({ broken: true, lease: { endReason: 'broken' } });
    expect((await send('bob', 'POST', `${url}/${lease.id}/release`, {})).statusCode).toBe(409);
    expect((await get('alice', '/api/audit?action=lease.break')).json().entries[0]).toMatchObject({ target: ids.projectA, details: { leaseId: lease.id, holderId: ids.bob } });
    expect(JSON.stringify((await get('alice', '/api/audit?action=lease.acquire')).json())).not.toContain('refactoring auth');

    const bodies = ((await get('vic', `${base(ids.projectA)}/room/messages?limit=100`)).json().messages as Array<{ body: string; intent: string }>).filter((m) => m.intent === 'claim' || m.intent === 'release');
    expect(bodies.map((m) => m.body)).toEqual(expect.arrayContaining(["alice broke bob's paths lease."]));
  });

  it('publishes board events on the bus and replays them to SSE clients of the project', async () => {
    const created = await card('bob', ids.projectA);
    const live: AnyDomainEvent[] = [];
    const unsubscribe = container.bus.subscribe((event) => void live.push(event), { types: ['task.moved', 'task.hold_changed'] });
    const before = (await get('alice', `/api/events?projectId=${ids.projectA}&limit=1`)).json().events[0];
    await send('bob', 'POST', `${base(ids.projectA)}/board/cards/${created.id}/move`, { to: 'ready' });
    await send('bob', 'POST', `/api/tasks/${created.id}/release`, {});
    unsubscribe();
    expect(live.map((e) => e.type)).toEqual(['task.moved', 'task.hold_changed']);
    expect(live[0]).toMatchObject({ projectId: ids.projectA, taskId: created.id, payload: { from: 'backlog', to: 'ready', schedulingHold: true, by: 'bob' } });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?projectId=${ids.projectA}`, { headers: { cookie: cookies.vic!, 'last-event-id': String(before.id) }, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes('event: task.hold_changed') && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      expect(text).toContain('event: task.moved');
      expect(text).toContain('event: task.hold_changed');
    } finally {
      abort.abort();
    }
  });
});
