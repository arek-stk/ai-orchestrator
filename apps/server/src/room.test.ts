import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub, type AnyDomainEvent } from '@orch/core';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3000';
const GITHUB_TOKEN = `ghp_${'b'.repeat(36)}`;

let container: Container;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', userBob: '', userVic: '', userCarl: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });
const room = (project: string) => `/api/projects/${project}/room`;

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'src/index.ts': 'export {};\n', 'README.md': '# Alpha\n' });
  github.seed({ owner: 'acme', name: 'beta' }, { 'src/index.ts': 'export {};\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);

  cookies.alice = await login('alice'); // first user: owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.vic = await login('vic'); // viewer, member of A
  cookies.carl = await login('carl'); // operator, member of A (rate limit)
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
  ids.userCarl = users.find((u) => u.login === 'carl')!.id;
  expect((await send('alice', 'PATCH', `/api/users/${ids.userVic}/role`, { role: 'viewer' })).statusCode).toBe(200);
  // A role change ends existing sessions.
  cookies.vic = await login('vic');
  for (const [user, role] of [
    [ids.userBob, 'operator'],
    [ids.userVic, 'viewer'],
    [ids.userCarl, 'operator'],
  ] as const) {
    expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${user}`, { role })).statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('Project Room API', () => {
  it('lets operators post and reply, stores plain redacted text and audits without content', async () => {
    const posted = await send('bob', 'POST', `${room(ids.projectA)}/messages`, { body: `Which search index should we use? token ${GITHUB_TOKEN}`, intent: 'question' });
    expect(posted.statusCode).toBe(201);
    const message = posted.json().message;
    expect(message).toMatchObject({ authorType: 'human', authorName: 'bob', intent: 'question', threadId: null, projectId: ids.projectA });
    expect(message.body).toBe('Which search index should we use? token [REDACTED:github_token]');

    const reply = await send('alice', 'POST', `${room(ids.projectA)}/messages/${message.id}/replies`, { body: '<b>Trigram</b> index', intent: 'answer' });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().message).toMatchObject({ threadId: message.id, body: '<b>Trigram</b> index' });

    const thread = (await get('vic', `${room(ids.projectA)}/messages/${message.id}/replies`)).json();
    expect(thread.root).toMatchObject({ id: message.id, replyCount: 1 });
    expect(thread.replies.map((r: { authorName: string }) => r.authorName)).toEqual(['alice']);

    const audit = (await get('alice', '/api/audit?action=room.post')).json().entries;
    expect(audit[0]).toMatchObject({ action: 'room.post', target: ids.projectA, details: { messageId: message.id, intent: 'question' } });
    expect(JSON.stringify(audit)).not.toContain('search index');
    expect((await get('alice', '/api/audit?action=room.reply')).json().entries).toHaveLength(1);
  });

  it('lets viewers read but not post, and rejects unauthenticated and cross-origin requests', async () => {
    expect((await get('vic', `${room(ids.projectA)}/messages`)).statusCode).toBe(200);
    expect((await get('vic', room(ids.projectA))).json().conversation).toMatchObject({ kind: 'room', projectId: ids.projectA });
    expect((await send('vic', 'POST', `${room(ids.projectA)}/messages`, { body: 'hello' })).statusCode).toBe(403);
    expect((await app.inject({ url: `${room(ids.projectA)}/messages` })).statusCode).toBe(401);
    const crossOrigin = await app.inject({ method: 'POST', url: `${room(ids.projectA)}/messages`, headers: { cookie: cookies.bob!, origin: 'https://evil.example' }, payload: { body: 'hi' } });
    expect(crossOrigin.statusCode).toBe(403);
  });

  it('denies every room route of a foreign project with 404', async () => {
    const foreign = (await send('alice', 'POST', `${room(ids.projectB)}/messages`, { body: 'Beta only' })).json().message;
    for (const url of [room(ids.projectB), `${room(ids.projectB)}/messages`, `${room(ids.projectB)}/messages/${foreign.id}/replies`]) {
      expect((await get('bob', url)).statusCode, url).toBe(404);
    }
    expect((await send('bob', 'POST', `${room(ids.projectB)}/messages`, { body: 'hi' })).statusCode).toBe(404);
    expect((await send('bob', 'POST', `${room(ids.projectB)}/messages/${foreign.id}/replies`, { body: 'hi' })).statusCode).toBe(404);
    // A message id from project B addressed through project A is not found either.
    expect((await get('bob', `${room(ids.projectA)}/messages/${foreign.id}/replies`)).statusCode).toBe(404);
    expect((await send('bob', 'POST', `${room(ids.projectA)}/messages/${foreign.id}/replies`, { body: 'hi' })).statusCode).toBe(404);
    expect((await get('bob', `${room('prj_missing')}/messages`)).statusCode).toBe(404);
  });

  it('validates bodies, intents and cursors', async () => {
    const url = `${room(ids.projectA)}/messages`;
    expect((await send('bob', 'POST', url, { body: '   ' })).statusCode).toBe(400);
    expect((await send('bob', 'POST', url, { body: 'x'.repeat(8001) })).statusCode).toBe(400);
    expect((await send('bob', 'POST', url, { body: 'I object', intent: 'objection' })).statusCode).toBe(400);
    expect((await send('bob', 'POST', url, { body: 'Yes', intent: 'answer' })).statusCode).toBe(400);
    expect((await send('bob', 'POST', `${url}/msg_missing/replies`, { body: 'hi' })).statusCode).toBe(404);
    expect((await get('bob', `${url}?before=5&after=1`)).statusCode).toBe(400);
    expect((await get('bob', `${url}?limit=1000`)).statusCode).toBe(400);
  });

  it('paginates top-level messages with seq cursors', async () => {
    const project = (await send('alice', 'POST', '/api/projects', { name: 'Paging', autonomyLevel: 1 })).json().project.id;
    for (let i = 1; i <= 5; i++) expect((await send('alice', 'POST', `${room(project)}/messages`, { body: `m${i}` })).statusCode).toBe(201);
    const latest = (await get('alice', `${room(project)}/messages?limit=2`)).json();
    expect(latest.messages.map((m: { body: string }) => m.body)).toEqual(['m4', 'm5']);
    expect(latest.hasMore).toBe(true);
    const older = (await get('alice', `${room(project)}/messages?limit=2&before=${latest.messages[0].seq}`)).json();
    expect(older.messages.map((m: { body: string }) => m.body)).toEqual(['m2', 'm3']);
    const newer = (await get('alice', `${room(project)}/messages?after=${older.messages[1].seq}`)).json();
    expect(newer).toMatchObject({ hasMore: false });
    expect(newer.messages.map((m: { body: string }) => m.body)).toEqual(['m4', 'm5']);
  });

  it('rate limits posting per user', async () => {
    const url = `${room(ids.projectA)}/messages`;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await send('carl', 'POST', url, { body: `burst ${i}` })).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Other users keep their own budget.
    expect((await send('bob', 'POST', url, { body: 'still allowed' })).statusCode).toBe(201);
  });

  it('publishes content-free room.message events that SSE clients replay after reconnecting', async () => {
    const live: AnyDomainEvent[] = [];
    const unsubscribe = container.bus.subscribe((event) => void live.push(event), { types: ['room.message'] });
    const before = (await get('alice', `/api/events?projectId=${ids.projectA}&limit=1`)).json().events[0];
    const posted = (await send('bob', 'POST', `${room(ids.projectA)}/messages`, { body: 'Live update please' })).json().message;
    unsubscribe();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ type: 'room.message', projectId: ids.projectA, payload: { messageId: posted.id, seq: posted.seq, authorName: 'bob', intent: 'message' } });
    expect(JSON.stringify(live[0])).not.toContain('Live update please');

    // A reconnecting EventSource sends Last-Event-ID and receives the missed event from the persisted history.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events/stream?projectId=${ids.projectA}`, {
        headers: { cookie: cookies.vic!, 'last-event-id': String(before.id) },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes(`"messageId":"${posted.id}"`) && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      expect(text).toContain('event: room.message');
      expect(text).toContain(`"messageId":"${posted.id}"`);
    } finally {
      abort.abort();
    }
  });

  it('shows pipeline notices from a run in the room', async () => {
    const task = await send('alice', 'POST', `/api/projects/${ids.projectA}/tasks`, { title: 'Add search', goal: 'Customers can search products' });
    expect(task.statusCode).toBe(201);
    const started = await send('alice', 'POST', `/api/tasks/${task.json().task.id}/start`);
    expect(started.statusCode).toBe(202);
    await new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 }).drain();

    const messages = (await get('vic', `${room(ids.projectA)}/messages?limit=100`)).json().messages as Array<{ authorType: string; body: string; refs: { runId?: string } }>;
    const notices = messages.filter((m) => m.authorType === 'orchestrator' && m.refs.runId === started.json().run.id);
    expect(notices[0]!.body).toBe('Started working on “Add search”.');
    expect(notices.some((m) => m.body.startsWith('Finished “Add search”'))).toBe(true);
    expect(notices.length).toBeLessThanOrEqual(14);
  });
});
