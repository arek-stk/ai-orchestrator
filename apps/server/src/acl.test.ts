import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub, type AnyDomainEvent } from '@orch/core';
import { createProjectAcl, eventVisible, lowerRole } from './acl';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3000';

let container: Container;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', taskA: '', taskB: '', runA: '', runB: '', userBob: '', userDave: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'src/index.ts': 'export {};\n' });
  github.seed({ owner: 'acme', name: 'beta' }, { 'src/index.ts': 'export {};\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);

  cookies.alice = await login('alice'); // first user: owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.dave = await login('dave'); // operator globally, viewer membership on A
  cookies.olga = await login('olga'); // operator without memberships

  for (const [key, name, repo] of [
    ['projectA', 'Alpha', 'alpha'],
    ['projectB', 'Beta', 'beta'],
  ] as const) {
    const created = await send('alice', 'POST', '/api/projects', { name, repo: { owner: 'acme', name: repo }, autonomyLevel: 3 });
    expect(created.statusCode).toBe(201);
    ids[key] = created.json().project.id;
  }
  for (const [taskKey, runKey, projectKey] of [
    ['taskA', 'runA', 'projectA'],
    ['taskB', 'runB', 'projectB'],
  ] as const) {
    const task = await send('alice', 'POST', `/api/projects/${ids[projectKey]}/tasks`, { title: 'Add search', goal: 'Customers can search products' });
    expect(task.statusCode).toBe(201);
    ids[taskKey] = task.json().task.id;
    const started = await send('alice', 'POST', `/api/tasks/${ids[taskKey]}/start`);
    expect(started.statusCode).toBe(202);
    ids[runKey] = started.json().run.id;
  }
  await new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 }).drain();

  const users = (await get('alice', '/api/users')).json().users as Array<{ id: string; login: string }>;
  ids.userBob = users.find((u) => u.login === 'bob')!.id;
  ids.userDave = users.find((u) => u.login === 'dave')!.id;
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${ids.userBob}`, { role: 'operator' })).statusCode).toBe(200);
  expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${ids.userDave}`, { role: 'viewer' })).statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('project visibility with PROJECT_ACL=enforced', () => {
  it('owners see every project; members only theirs; users without memberships none', async () => {
    const names = async (user: string) => ((await get(user, '/api/projects')).json().projects as Array<{ name: string }>).map((p) => p.name).sort();
    expect(await names('alice')).toEqual(['Alpha', 'Beta']);
    expect(await names('bob')).toEqual(['Alpha']);
    expect(await names('olga')).toEqual([]);
  });

  it('answers 404 for every project-scoped read of a foreign project', async () => {
    const b = ids.projectB;
    for (const url of [
      `/api/projects/${b}`,
      `/api/projects/${b}/tasks`,
      `/api/projects/${b}/memory`,
      `/api/tasks/${ids.taskB}`,
      `/api/runs/${ids.runB}`,
      `/api/runs?projectId=${b}`,
      `/api/agents?projectId=${b}`,
      `/api/decisions?projectId=${b}`,
      `/api/decisions?taskId=${ids.taskB}`,
      `/api/approvals?projectId=${b}`,
      `/api/costs?projectId=${b}`,
      `/api/events?projectId=${b}`,
      `/api/events?runId=${ids.runB}`,
    ]) {
      const response = await get('bob', url);
      expect(response.statusCode, url).toBe(404);
    }
    // Same URLs work for the owner and for the member's own project.
    expect((await get('alice', `/api/projects/${b}`)).statusCode).toBe(200);
    expect((await get('bob', `/api/projects/${ids.projectA}`)).statusCode).toBe(200);
    expect((await get('bob', `/api/runs/${ids.runA}`)).statusCode).toBe(200);
  });

  it('filters lists, costs, events and the dashboard to visible projects', async () => {
    const onlyA = (items: Array<{ projectId: string | null }>) => items.every((item) => item.projectId === ids.projectA);

    const runs = (await get('bob', '/api/runs')).json().runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(onlyA(runs)).toBe(true);
    const agentRuns = (await get('bob', '/api/agents')).json().agentRuns;
    expect(agentRuns.length).toBeGreaterThan(0);
    expect(onlyA(agentRuns)).toBe(true);
    expect(onlyA((await get('bob', '/api/decisions')).json().decisions)).toBe(true);
    expect(onlyA((await get('bob', '/api/approvals')).json().approvals)).toBe(true);
    const events = (await get('bob', '/api/events?limit=500')).json().events;
    expect(events.length).toBeGreaterThan(0);
    expect(onlyA(events)).toBe(true);
    expect(onlyA((await get('bob', '/api/events?afterId=0&limit=500')).json().events)).toBe(true);
    expect((await get('alice', '/api/runs')).json().runs.some((r: { projectId: string }) => r.projectId === ids.projectB)).toBe(true);

    const costs = (await get('bob', '/api/costs')).json();
    const ownerCosts = (await get('alice', '/api/costs')).json();
    expect(costs.byProject.map((p: { projectId: string }) => p.projectId)).toEqual([ids.projectA]);
    expect(costs.summary.calls).toBeLessThan(ownerCosts.summary.calls);
    expect((await get('olga', '/api/costs')).json().summary.calls).toBe(0);

    const dashboard = (await get('bob', '/api/dashboard')).json();
    expect(dashboard.projects.total).toBe(1);
    expect(onlyA(dashboard.recentEvents)).toBe(true);
    expect((await get('alice', '/api/dashboard')).json().projects.total).toBe(2);
  });
});

describe('project-scoped actions', () => {
  it('denies mutations on foreign projects and their tasks and runs', async () => {
    const b = ids.projectB;
    const attempts: Array<[string, 'POST' | 'PATCH', string, object?]> = [
      ['patch project', 'PATCH', `/api/projects/${b}`, { priority: 2 }],
      ['pause project', 'POST', `/api/projects/${b}/pause`],
      ['resume project', 'POST', `/api/projects/${b}/resume`],
      ['create task', 'POST', `/api/projects/${b}/tasks`, { title: 'Sneaky task', goal: 'should never be created' }],
      ['edit task', 'PATCH', `/api/tasks/${ids.taskB}`, { priority: 1 }],
      ['start task', 'POST', `/api/tasks/${ids.taskB}/start`],
      ['retry task', 'POST', `/api/tasks/${ids.taskB}/retry`],
      ['cancel task', 'POST', `/api/tasks/${ids.taskB}/cancel`],
      ['resume run', 'POST', `/api/runs/${ids.runB}/resume`],
      ['cancel run', 'POST', `/api/runs/${ids.runB}/cancel`],
    ];
    for (const [name, method, url, payload] of attempts) {
      expect((await send('bob', method, url, payload)).statusCode, name).toBe(404);
    }
    const tasksB = (await get('alice', `/api/projects/${b}/tasks`)).json().tasks;
    expect(tasksB.some((t: { title: string }) => t.title === 'Sneaky task')).toBe(false);

    expect((await send('bob', 'PATCH', `/api/projects/${ids.projectA}`, { priority: 2 })).statusCode).toBe(200);
    expect((await send('bob', 'POST', `/api/projects/${ids.projectA}/tasks`, { title: 'Member task', goal: 'allowed for members' })).statusCode).toBe(201);
  });

  it('caps the effective role at the membership role', async () => {
    expect((await get('dave', `/api/projects/${ids.projectA}`)).statusCode).toBe(200);
    const patch = await send('dave', 'PATCH', `/api/projects/${ids.projectA}`, { priority: 4 });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toMatch(/operator role on this project/);
    expect((await send('dave', 'POST', `/api/tasks/${ids.taskA}/cancel`)).statusCode).toBe(403);
  });
});

describe('membership management', () => {
  it('is admin-only, validated and audited', async () => {
    expect((await send('bob', 'PUT', `/api/projects/${ids.projectB}/members/${ids.userBob}`, { role: 'operator' })).statusCode).toBe(403);
    expect((await get('bob', `/api/projects/${ids.projectA}/members`)).statusCode).toBe(403);
    expect((await send('alice', 'PUT', `/api/projects/${ids.projectB}/members/${ids.userBob}`, { role: 'admin' })).statusCode).toBe(400);
    expect((await send('alice', 'PUT', `/api/projects/${ids.projectB}/members/usr_missing`, { role: 'viewer' })).statusCode).toBe(404);
    expect((await send('alice', 'PUT', `/api/projects/prj_missing/members/${ids.userBob}`, { role: 'viewer' })).statusCode).toBe(404);

    const members = (await get('alice', `/api/projects/${ids.projectA}/members`)).json();
    expect(members.aclMode).toBe('enforced');
    expect(members.members.map((m: { login: string; role: string }) => [m.login, m.role])).toEqual([
      ['bob', 'operator'],
      ['dave', 'viewer'],
    ]);
    expect((await get('alice', `/api/users/${ids.userBob}/projects`)).json().memberships).toHaveLength(1);

    const audit = (await get('alice', '/api/audit?action=project.member.upsert')).json().entries;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('revoking a membership removes access immediately', async () => {
    expect((await send('alice', 'DELETE', `/api/projects/${ids.projectA}/members/${ids.userDave}`)).statusCode).toBe(200);
    expect((await send('alice', 'DELETE', `/api/projects/${ids.projectA}/members/${ids.userDave}`)).statusCode).toBe(404);
    expect((await get('dave', `/api/projects/${ids.projectA}`)).statusCode).toBe(404);
    expect((await get('dave', '/api/projects')).json().projects).toEqual([]);
    expect((await get('alice', '/api/audit?action=project.member.remove')).json().entries).toHaveLength(1);
  });
});

describe('acl helpers', () => {
  const event = (projectId: string | null) => ({ projectId }) as Pick<AnyDomainEvent, 'projectId'>;
  const request = (user: { id: string; role: 'owner' | 'admin' | 'operator' | 'viewer' } | null) =>
    ({ user: user && { ...user, login: user.id, name: null, avatarUrl: null, sessionId: 's' } }) as unknown as FastifyRequest;

  it('filters SSE events by visible projects and hides system events from restricted users', () => {
    const visible = new Map([['prj_a', 'viewer' as const]]);
    expect(eventVisible(null, event(null))).toBe(true);
    expect(eventVisible(visible, event('prj_a'))).toBe(true);
    expect(eventVisible(visible, event('prj_b'))).toBe(false);
    expect(eventVisible(visible, event(null))).toBe(false);
  });

  it('derives the effective role and merges per-project lists', async () => {
    expect(lowerRole('operator', 'viewer')).toBe('viewer');
    expect(lowerRole('viewer', 'operator')).toBe('viewer');
    let lookups = 0;
    const members = {
      listForUser: async () => {
        lookups++;
        return [
          { projectId: 'p1', userId: 'u', role: 'operator' as const, createdAt: new Date() },
          { projectId: 'p2', userId: 'u', role: 'operator' as const, createdAt: new Date() },
        ];
      },
    };
    const acl = createProjectAcl('enforced', { members: members as never });
    const viewerRequest = request({ id: 'u', role: 'viewer' });
    const visible = await acl.visibleProjects(viewerRequest);
    expect([...visible!.entries()]).toEqual([
      ['p1', 'viewer'],
      ['p2', 'viewer'],
    ]);
    await acl.visibleProjects(viewerRequest);
    expect(lookups).toBe(1); // cached per request
    await acl.visibleProjects(viewerRequest, { fresh: true });
    expect(lookups).toBe(2);

    const rows: Record<string, Array<{ projectId: string; at: number }>> = {
      p1: [{ projectId: 'p1', at: 1 }, { projectId: 'p1', at: 4 }],
      p2: [{ projectId: 'p2', at: 3 }],
      p3: [{ projectId: 'p3', at: 9 }],
    };
    const merged = await acl.scopedList(viewerRequest, undefined, async (p) => rows[p!] ?? [], { limit: 2, sortKey: (r) => r.at });
    expect(merged.map((r) => r.at)).toEqual([4, 3]);
    await expect(acl.scopedList(viewerRequest, 'p3', async () => [], { limit: 1, sortKey: () => 0 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(acl.assertProject(viewerRequest, 'p1', 'operator')).rejects.toMatchObject({ statusCode: 403 });

    expect(await createProjectAcl('enforced', { members: members as never }).visibleProjects(request({ id: 'a', role: 'admin' }))).toBeNull();
    expect(await createProjectAcl('off', { members: members as never }).visibleProjects(request({ id: 'v', role: 'viewer' }))).toBeNull();
    expect((await createProjectAcl('enforced', { members: members as never }).visibleProjects(request(null)))!.size).toBe(0);
  });
});
