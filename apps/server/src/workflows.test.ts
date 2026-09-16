import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryGitHub, WORKFLOW_TOOLS } from '@orch/core';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3000';

let container: Container;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids = { projectA: '', projectB: '', workflowA: '', workflowB: '' };

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

const get = (user: string, url: string) => app.inject({ url, headers: { cookie: cookies[user]! } });
const send = (user: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: cookies[user]!, origin: ORIGIN }, ...(payload ? { payload } : {}) });
const drain = () => new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 }).drain();

beforeAll(async () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'alpha' }, { 'README.md': '# Alpha\n' });
  const config = loadConfig(
    { NODE_ENV: 'test', PROJECT_ACL: 'enforced', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);

  cookies.alice = await login('alice'); // owner
  cookies.bob = await login('bob'); // operator, member of A
  cookies.vic = await login('vic'); // viewer, member of A
  for (const [key, name] of [
    ['projectA', 'Alpha'],
    ['projectB', 'Beta'],
  ] as const) {
    const created = await send('alice', 'POST', '/api/projects', { name, autonomyLevel: 2 });
    expect(created.statusCode).toBe(201);
    ids[key] = created.json().project.id;
  }
  const users = (await get('alice', '/api/users')).json().users as Array<{ id: string; login: string }>;
  const userId = (login: string) => users.find((u) => u.login === login)!.id;
  expect((await send('alice', 'PATCH', `/api/users/${userId('vic')}/role`, { role: 'viewer' })).statusCode).toBe(200);
  cookies.vic = await login('vic');
  for (const [login, role] of [
    ['bob', 'operator'],
    ['vic', 'viewer'],
  ] as const) {
    expect((await send('alice', 'PUT', `/api/projects/${ids.projectA}/members/${userId(login)}`, { role })).statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('Workflows API', () => {
  it('serves meta with honest tool status, disabled toggles and templates', async () => {
    const meta = (await get('vic', '/api/workflows/meta')).json();
    expect(meta.mode).toBe('demo');
    const tools = new Map((meta.tools as Array<{ id: string; executable: boolean; message: string }>).map((t) => [t.id, t]));
    expect(tools.get('claude')).toMatchObject({ executable: true, message: 'Ausführbar (Demo)' });
    expect(tools.get('midjourney')).toMatchObject({ executable: false, message: 'Nicht ausführbar – keine offizielle API' });
    expect(tools.get('runway')).toMatchObject({ executable: false, message: 'Nicht ausführbar – Integration fehlt' });
    expect((meta.toggles as Array<{ available: boolean }>).every((t) => !t.available)).toBe(true);
    expect(meta.templates.map((t: { id: string }) => t.id)).toContain('marketing-kampagne');
  });

  it('keeps the core tool list in sync with the AI Hub catalog', () => {
    const source = readFileSync(fileURLToPath(new URL('../../web/src/lib/hub/catalog.ts', import.meta.url)), 'utf8');
    const entries: Array<[string, string]> = [];
    // Line-based scan (no backtracking regex): an entry starts with "    id: '<id>'" and has one "    integration: '<type>'".
    let current: string | null = null;
    for (const line of source.split('\n')) {
      if (line.startsWith("    id: '")) current = line.slice("    id: '".length, line.indexOf("'", "    id: '".length));
      else if (line.startsWith("    integration: '") && current) {
        entries.push([current, line.slice("    integration: '".length, line.indexOf("'", "    integration: '".length))]);
        current = null;
      }
    }
    expect(entries.length).toBeGreaterThan(30);
    expect(WORKFLOW_TOOLS.map((t) => [t.id, t.integration])).toEqual(entries);
  });

  it('enforces RBAC, CSRF and audits without content', async () => {
    const body = { projectId: ids.projectA, name: 'Marketing Kampagne', templateId: 'marketing-kampagne', status: 'active' };
    expect((await send('vic', 'POST', '/api/workflows', body)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/workflows', headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: cookies.bob!, origin: 'https://evil.example' }, payload: body })).statusCode).toBe(403);

    const created = await send('bob', 'POST', '/api/workflows', body);
    expect(created.statusCode).toBe(201);
    const payload = created.json();
    ids.workflowA = payload.workflow.id;
    expect(payload.workflow).toMatchObject({ version: 1, status: 'active', projectName: 'Alpha', lastRun: null });
    expect(payload.validation.valid).toBe(true);
    expect(payload.executability.design).toMatchObject({ executable: false, code: 'no_public_api' });
    expect(payload.executability.strategy).toMatchObject({ executable: true, demo: true });

    expect((await get('vic', `/api/workflows/${ids.workflowA}`)).statusCode).toBe(200);
    expect((await send('vic', 'PUT', `/api/workflows/${ids.workflowA}`, { expectedVersion: 1, name: 'x' })).statusCode).toBe(403);

    const audit = await container.admin.audit.list({ action: 'workflow.create' });
    expect(audit[0]).toMatchObject({ target: ids.workflowA, details: { projectId: ids.projectA, templateId: 'marketing-kampagne' } });
    expect(JSON.stringify(audit)).not.toContain('Marketingkampagne');
  });

  it('applies the per-project ACL to workflows, runs and artifacts', async () => {
    const foreign = await send('alice', 'POST', '/api/workflows', { projectId: ids.projectB, name: 'Beta only', templateId: 'blog-artikel' });
    expect(foreign.statusCode).toBe(201);
    ids.workflowB = foreign.json().workflow.id;
    const run = await send('alice', 'POST', `/api/workflows/${ids.workflowB}/runs`, { onNonExecutable: 'skip' });
    expect(run.statusCode).toBe(201);
    const runId = run.json().run.id;

    expect((await get('bob', '/api/workflows')).json().workflows.map((w: { id: string }) => w.id)).toEqual([ids.workflowA]);
    for (const url of [`/api/workflows/${ids.workflowB}`, `/api/workflows/${ids.workflowB}/runs`, `/api/workflows/${ids.workflowB}/versions`, `/api/workflow-runs/${runId}`, `/api/workflow-runs/${runId}/events`, `/api/workflows?projectId=${ids.projectB}`]) {
      expect((await get('bob', url)).statusCode, url).toBe(404);
    }
    expect((await send('bob', 'PUT', `/api/workflows/${ids.workflowB}`, { expectedVersion: 1, name: 'mine' })).statusCode).toBe(404);
    expect((await send('bob', 'POST', `/api/workflows/${ids.workflowB}/runs`, {})).statusCode).toBe(404);
    expect((await send('bob', 'POST', `/api/workflow-runs/${runId}/cancel`)).statusCode).toBe(404);
    expect((await send('bob', 'DELETE', `/api/workflows/${ids.workflowB}`)).statusCode).toBe(404);
    expect((await send('bob', 'POST', '/api/workflows', { projectId: ids.projectB, name: 'sneaky' })).statusCode).toBe(404);
    await drain();
  });

  it('versions saves, rejects stale versions and invalid active definitions, and validates drafts inline', async () => {
    const current = (await get('bob', `/api/workflows/${ids.workflowA}`)).json().workflow;
    const saved = await send('bob', 'PUT', `/api/workflows/${ids.workflowA}`, { expectedVersion: current.version, description: 'Neue Beschreibung' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().workflow.version).toBe(current.version + 1);
    expect((await send('bob', 'PUT', `/api/workflows/${ids.workflowA}`, { expectedVersion: current.version, name: 'stale' })).statusCode).toBe(409);

    const cyclic = { ...current.definition, edges: [...current.definition.edges, { id: 'back', source: 'finale', target: 'ziel' }] };
    const rejected = await send('bob', 'PUT', `/api/workflows/${ids.workflowA}`, { expectedVersion: current.version + 1, definition: cyclic });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().issues.map((i: { code: string }) => i.code)).toContain('cycle');

    const draft = await send('bob', 'POST', '/api/workflows', { projectId: ids.projectA, name: 'Entwurf', status: 'draft', definition: { schemaVersion: 1, nodes: [], edges: [] } });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().validation).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: 'empty' })] });
    expect((await send('bob', 'POST', '/api/workflows', { projectId: ids.projectA, name: 'Kaputt', definition: { schemaVersion: 2 } })).statusCode).toBe(400);
    const secret = await send('bob', 'POST', '/api/workflows/validate', { definition: { ...current.definition, nodes: current.definition.nodes.map((n: { id: string }) => (n.id === 'ziel' ? { ...n, goal: `key sk-${'a'.repeat(48)}` } : n)) } });
    expect(secret.json().validation.issues.map((i: { code: string }) => i.code)).toContain('secret');
    // The draft can run only once it is valid.
    expect((await send('bob', 'POST', `/api/workflows/${draft.json().workflow.id}/runs`, {})).statusCode).toBe(400);
    expect((await get('vic', `/api/workflows/${ids.workflowA}/versions`)).json().versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('blocks a run before it starts when agents are not executable', async () => {
    const response = await send('bob', 'POST', `/api/workflows/${ids.workflowA}/runs`, { onNonExecutable: 'block' });
    expect(response.statusCode).toBe(201);
    const { run, steps } = response.json();
    expect(run.status).toBe('blocked');
    expect(run.blockers.map((b: { nodeId: string }) => b.nodeId)).toEqual(['research', 'design', 'video', 'voice']);
    expect(steps.find((s: { nodeId: string }) => s.nodeId === 'design')).toMatchObject({ status: 'blocked', reason: 'Nicht ausführbar – keine offizielle API' });
    const audit = await container.admin.audit.list({ action: 'workflow.run.start' });
    expect(audit.find((a) => a.target === run.id)).toMatchObject({ details: { status: 'blocked', blockers: 4, mode: 'demo' } });
  });

  it('runs in demo mode through the worker, skips honestly, stores artifacts, posts room notices and streams progress', async () => {
    const before = (await get('alice', `/api/events?projectId=${ids.projectA}&limit=1`)).json().events[0];
    const response = await send('bob', 'POST', `/api/workflows/${ids.workflowA}/runs`, { onNonExecutable: 'skip', maxParallel: 2 });
    expect(response.statusCode).toBe(201);
    const runId = response.json().run.id;
    expect(response.json().run).toMatchObject({ status: 'queued', mode: 'demo', limits: { maxParallel: 2 } });
    expect((await send('bob', 'POST', `/api/workflows/${ids.workflowA}/runs`, {})).statusCode).toBe(409);
    await drain();

    const detail = (await get('vic', `/api/workflow-runs/${runId}`)).json();
    expect(detail.run).toMatchObject({ status: 'partial', costUsd: 0, reason: 'Nicht ausführbare Schritte wurden übersprungen.' });
    expect(detail.usage).toBeNull();
    const byNode = Object.fromEntries(detail.steps.map((s: { nodeId: string; status: string }) => [s.nodeId, s.status]));
    expect(byNode).toMatchObject({ ziel: 'succeeded', orchestrator: 'succeeded', strategy: 'succeeded', content: 'succeeded', research: 'skipped', design: 'skipped', finale: 'succeeded' });
    const finale = detail.artifacts.find((a: { nodeId: string }) => a.nodeId === 'finale');
    expect(finale).toMatchObject({ name: 'marketing/kampagne.md', format: 'markdown' });

    const artifact = (await get('vic', `/api/workflow-runs/${runId}/artifacts/${finale.id}`)).json().artifact;
    expect(artifact.content).toContain('Demo-Ausgabe');
    const download = await get('vic', `/api/workflow-runs/${runId}/artifacts/${finale.id}?download=1`);
    expect(download.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(download.headers['content-disposition']).toBe('attachment; filename="marketing_kampagne.md"');
    expect(download.headers['x-content-type-options']).toBe('nosniff');

    const events = (await get('vic', `/api/workflow-runs/${runId}/events`)).json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(events[0]!.type).toBe('workflow.run.created');
    expect(events.at(-1)).toMatchObject({ type: 'workflow.run.finished', payload: { status: 'partial' } });
    expect(JSON.stringify(events)).not.toContain('Demo-Ausgabe');

    const room = (await get('vic', `/api/projects/${ids.projectA}/room/messages?limit=100`)).json().messages as Array<{ body: string; refs: { workflowRunId?: string } }>;
    const notices = room.filter((m) => m.refs.workflowRunId === runId);
    expect(notices.map((m) => m.body)).toEqual(['Workflow „Marketing Kampagne“ gestartet (Demo).', 'Workflow „Marketing Kampagne“ teilweise abgeschlossen: 5 von 9 Schritten abgeschlossen (Demo, keine Kosten). Nicht ausführbare Schritte wurden übersprungen.']);

    // SSE: a reconnecting client replays the content-free step updates from the persisted history.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const stream = await fetch(`http://127.0.0.1:${port}/api/events/stream?projectId=${ids.projectA}`, { headers: { cookie: cookies.vic!, 'last-event-id': String(before.id) }, signal: abort.signal });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes('event: workflow.run.finished') && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      expect(text).toContain('event: workflow.step.updated');
      expect(text).toContain(`"workflowRunId":"${runId}"`);
      expect(text).toContain('event: workflow.run.finished');
    } finally {
      abort.abort();
    }
  });

  it('cancels queued runs and refuses to delete a workflow with an active run', async () => {
    const created = (await send('bob', 'POST', '/api/workflows', { projectId: ids.projectA, name: 'Blog', templateId: 'blog-artikel', status: 'active' })).json().workflow;
    const run = (await send('bob', 'POST', `/api/workflows/${created.id}/runs`, {})).json().run;
    expect((await send('bob', 'DELETE', `/api/workflows/${created.id}`)).statusCode).toBe(409);
    const cancelled = await send('bob', 'POST', `/api/workflow-runs/${run.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');
    expect((await send('bob', 'POST', `/api/workflow-runs/${run.id}/cancel`)).statusCode).toBe(409);
    await drain();
    expect((await get('bob', `/api/workflow-runs/${run.id}`)).json().run.status).toBe('cancelled');
    expect((await send('vic', 'DELETE', `/api/workflows/${created.id}`)).statusCode).toBe(403);
    expect((await send('bob', 'DELETE', `/api/workflows/${created.id}`)).statusCode).toBe(200);
    expect((await container.admin.audit.list({ action: 'workflow.delete' }))[0]).toMatchObject({ target: created.id });
  });

  it('attaches runs to an active autopilot session and caps them by its remaining budget', async () => {
    const session = await send('alice', 'POST', '/api/autopilot/sessions', { projectIds: [ids.projectA], durationHours: 2, budgetUsd: 0.5 });
    expect(session.statusCode).toBe(201);
    const run = (await send('bob', 'POST', `/api/workflows/${ids.workflowA}/runs`, { onNonExecutable: 'skip', maxCostUsd: 10 })).json().run;
    expect(run).toMatchObject({ sessionId: session.json().session.id, limits: { maxCostUsd: 0.5 } });
    expect(run.limits.maxDurationMs).toBeLessThanOrEqual(20 * 60_000);
    await send('alice', 'POST', '/api/autopilot/kill', { sessionId: session.json().session.id });
    await drain();
    expect((await get('bob', `/api/workflow-runs/${run.id}`)).json().run).toMatchObject({ status: 'cancelled', reason: 'Die Autopilot-Session wurde per Kill-Switch beendet.' });
  });
});
