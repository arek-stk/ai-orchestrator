import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub } from '@orch/core';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3200';
const cart = `export function cartTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n${'// pricing rules\n'.repeat(150)}`;

let container: Container;
let app: FastifyInstance;
let workers: WorkerPool;
let ownerCookie: string;
let projectId: string;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  return (Array.isArray(header) ? header[0] : String(header)).split(';')[0]!;
}

async function login(name: string): Promise<{ cookie: string; id: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  return { cookie: cookieFrom(response), id: response.json().user.id };
}

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed(
    { owner: 'acme', name: 'health' },
    {
      'package.json': JSON.stringify({ name: 'health', dependencies: { express: '*' } }),
      'README.md': '# Health\n',
      'src/cart.ts': cart,
      'src/checkout.ts': "import { cartTotal } from './cart';\nexport const checkout = () => cartTotal([1]);\n",
    },
  );
  const config = loadConfig(
    { NODE_ENV: 'test', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);
  workers = new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 });
  ownerCookie = (await login('owner')).cookie;
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: ownerCookie, origin: ORIGIN },
    payload: { name: 'Health project', repo: { owner: 'acme', name: 'health' }, autonomyLevel: 2, profile: { languages: ['TypeScript'] } },
  });
  projectId = created.json().project.id;
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('health scan API', () => {
  it('queues a scan, runs it in the worker and persists the health score', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    const queued = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/health-scans`, headers });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ created: true, scan: { status: 'queued' } });
    const duplicate = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/health-scans`, headers });
    expect(duplicate.json()).toMatchObject({ created: false, scan: { id: queued.json().scan.id } });

    expect(await workers.drain()).toBeGreaterThanOrEqual(1);

    const scans = (await app.inject({ url: `/api/projects/${projectId}/health-scans`, headers: { cookie: ownerCookie } })).json();
    expect(scans.scans[0]).toMatchObject({ status: 'completed', agentStatus: 'ok' });
    expect(scans.scans[0].healthScore).toBeLessThan(100);
    expect(scans.healthScore).toBe(scans.scans[0].healthScore);
    const project = (await app.inject({ url: `/api/projects/${projectId}`, headers: { cookie: ownerCookie } })).json();
    expect(project.project.healthScore).toBe(scans.healthScore);

    const events = (await app.inject({ url: `/api/events?projectId=${projectId}`, headers: { cookie: ownerCookie } })).json();
    expect(events.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['project.health_scanned', 'improvement.proposed']));
  });

  it('lists proposals and lets operators accept or dismiss them once, with audit entries', async () => {
    const operator = await login('operator-olga');
    const headers = { cookie: operator.cookie, origin: ORIGIN };
    const proposals = (await app.inject({ url: `/api/projects/${projectId}/improvements?status=proposed`, headers: { cookie: operator.cookie } })).json().proposals;
    expect(proposals.length).toBeGreaterThanOrEqual(3);
    expect(proposals.map((p: { category: string }) => p.category)).toEqual(expect.arrayContaining(['missing_tests', 'outdated_dependencies']));

    const accepted = await app.inject({ method: 'POST', url: `/api/improvements/${proposals[0].id}/accept`, headers });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().task).toMatchObject({ status: 'BACKLOG', projectId });
    expect(accepted.json().task.priority).toBeLessThanOrEqual(5);
    expect((await app.inject({ method: 'POST', url: `/api/improvements/${proposals[0].id}/accept`, headers })).statusCode).toBe(409);

    const dismissed = await app.inject({ method: 'POST', url: `/api/improvements/${proposals[1].id}/dismiss`, headers, payload: { reason: 'out of scope' } });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().proposal).toMatchObject({ status: 'dismissed', dismissReason: 'out of scope', decidedBy: 'operator-olga' });
    expect((await app.inject({ method: 'POST', url: '/api/improvements/imp_missing/accept', headers })).statusCode).toBe(404);

    const audit = (await app.inject({ url: '/api/audit', headers: { cookie: ownerCookie } })).json();
    const actions = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['health_scan.request', 'improvement.accept', 'improvement.dismiss']));
  });

  it('denies viewers and unauthenticated users', async () => {
    const viewer = await login('viewer-vic');
    await app.inject({ method: 'PATCH', url: `/api/users/${viewer.id}/role`, headers: { cookie: ownerCookie, origin: ORIGIN }, payload: { role: 'viewer' } });
    const viewerCookie = (await login('viewer-vic')).cookie;
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/health-scans`, headers: { cookie: viewerCookie, origin: ORIGIN } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research`, headers: { cookie: viewerCookie, origin: ORIGIN }, payload: { question: 'Which search index should we use?' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/projects/${projectId}/improvements`, headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/projects/${projectId}/improvements` })).statusCode).toBe(401);
  });

  it('reuses cached scan results on a repeated scan and reports the savings in costs', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/health-scans`, headers });
    await workers.drain();
    const scans = (await app.inject({ url: `/api/projects/${projectId}/health-scans`, headers: { cookie: ownerCookie } })).json().scans;
    expect(scans[0]).toMatchObject({ status: 'completed', agentStatus: 'cached', proposalsCreated: 0 });
    expect(scans[0].previousScore).toBe(scans[1].healthScore);
    const costs = (await app.inject({ url: `/api/costs?days=1&projectId=${projectId}`, headers: { cookie: ownerCookie } })).json();
    expect(costs.summary.cacheHits).toBeGreaterThanOrEqual(1);
  });

  it('answers concurrent scan requests with a single queued scan', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    const responses = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'POST', url: `/api/projects/${projectId}/health-scans`, headers })));
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    const bodies = responses.map((r) => r.json());
    expect(bodies.filter((b) => b.created)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.scan.id)).size).toBe(1);

    const listed = (await app.inject({ url: `/api/projects/${projectId}/health-scans`, headers: { cookie: ownerCookie } })).json().scans;
    expect(listed.filter((s: { status: string }) => s.status === 'queued')).toHaveLength(1);
    await workers.drain();
    const after = (await app.inject({ url: `/api/projects/${projectId}/health-scans`, headers: { cookie: ownerCookie } })).json().scans;
    expect(after.filter((s: { status: string }) => s.status === 'queued' || s.status === 'running')).toHaveLength(0);
  });

  it('runs explicitly requested research as a job and stores it as memory', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    const bad = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research`, headers, payload: { question: 'short' } });
    expect(bad.statusCode).toBe(400);
    const queued = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research`, headers, payload: { question: 'Which search index fits product search best?' } });
    expect(queued.statusCode).toBe(202);
    await workers.drain();
    const memory = (await app.inject({ url: `/api/projects/${projectId}/memory?scope=project`, headers: { cookie: ownerCookie } })).json();
    expect(memory.memories.some((m: { kind: string }) => m.kind === 'research')).toBe(true);
  });
});
