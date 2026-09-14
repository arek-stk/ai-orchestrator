import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryGitHub } from '@orch/core';
import { schema } from '@orch/db';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { WorkerPool } from './worker';

const ORIGIN = 'http://localhost:3000';
const repo = { owner: 'acme', name: 'shop' };

let container: Container;
let app: FastifyInstance;
let github: InMemoryGitHub;
let ownerCookie: string;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : String(header);
  return value.split(';')[0]!;
}

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response);
}

beforeAll(async () => {
  github = new InMemoryGitHub();
  github.seed(repo, { 'src/index.ts': 'export {};\n', 'README.md': '# Shop\n' });
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      ALLOW_DEV_LOGIN: 'true',
      APP_ORIGIN: ORIGIN,
      GITHUB_WEBHOOK_SECRET: 'hook-secret',
      ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config, { github });
  app = await buildApp(container);
  ownerCookie = await login('alice');
});

afterAll(async () => {
  await app.close();
  await container.close();
});

describe('authentication and access control', () => {
  it('reports health without authentication but protects the API', async () => {
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ ok: true, demoMode: true, database: 'pglite' });
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
  });

  it('makes the first user the owner and stores only hashed session tokens', async () => {
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: ownerCookie } });
    expect(me.json().user).toMatchObject({ login: 'alice', role: 'owner' });
    const token = ownerCookie.split('=')[1]!;
    const sessions = await container.db.db.select().from(schema.sessions);
    expect(sessions.some((s) => s.tokenHash === token)).toBe(false);
  });

  it('rejects state-changing requests from foreign or missing origins (CSRF)', async () => {
    const payload = { name: 'Evil project' };
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: ownerCookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: ownerCookie, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
  });

  it('enforces roles: operators cannot create projects or decide approvals', async () => {
    const operatorCookie = await login('bob');
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: operatorCookie, origin: ORIGIN }, payload: { name: 'Nope' } });
    expect(create.statusCode).toBe(403);
    const decide = await app.inject({ method: 'POST', url: '/api/approvals/apr_x/decide', headers: { cookie: operatorCookie, origin: ORIGIN }, payload: { status: 'approved' } });
    expect(decide.statusCode).toBe(403);
  });
});

describe('projects, tasks and the pipeline through the API', () => {
  it('validates input', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: ownerCookie, origin: ORIGIN }, payload: { name: 'x', autonomyLevel: 9 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['autonomyLevel', 'name']);
  });

  it('creates a project and task, runs the pipeline with workers and opens a pull request', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { name: 'Shop', repo: { owner: 'acme', name: 'shop' }, autonomyLevel: 3, priority: 7, profile: { languages: ['TypeScript'] } },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    expect(project).toMatchObject({ slug: 'shop', autonomyLevel: 3, repo: { owner: 'acme', name: 'shop', defaultBranch: 'main' } });

    const badDependency = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, headers, payload: { title: 'Broken', goal: 'depends on nothing real', dependencies: ['tsk_missing'] } });
    expect(badDependency.statusCode).toBe(400);

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      headers,
      payload: { title: 'Add product search', goal: 'Customers can search products by name', acceptanceCriteria: ['Search is case-insensitive'] },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json().task;

    const started = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/start`, headers });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id;

    const workers = new WorkerPool(container, { concurrency: 1, schedulerIntervalMs: 60_000 });
    expect(await workers.drain()).toBeGreaterThan(5);

    const run = (await app.inject({ url: `/api/runs/${runId}`, headers: { cookie: ownerCookie } })).json();
    expect(run.run).toMatchObject({ status: 'SUCCEEDED' });
    expect(run.run.checkpoint.outcome).toBe('pr_ready');
    expect(run.agentRuns.length).toBeGreaterThan(3);
    expect(github.pulls(repo)).toHaveLength(1);
    expect(github.branch(repo, 'main')).toBeDefined();

    const dashboard = (await app.inject({ url: '/api/dashboard', headers: { cookie: ownerCookie } })).json();
    expect(dashboard.pipelines.succeeded7d).toBe(1);
    expect(dashboard.costs.callsToday).toBeGreaterThan(0);
    expect(dashboard.recentEvents.length).toBeGreaterThan(0);

    const costs = (await app.inject({ url: '/api/costs?days=7', headers: { cookie: ownerCookie } })).json();
    expect(costs.byModel[0].provider).toBe('mock');

    const audit = (await app.inject({ url: '/api/audit', headers: { cookie: ownerCookie } })).json();
    expect(audit.entries.some((e: { action: string }) => e.action === 'tool.github.pr.create.allowed')).toBe(true);
  });
});

describe('models, providers and settings', () => {
  it('lists models with availability and stores provider keys encrypted', async () => {
    const headers = { cookie: ownerCookie, origin: ORIGIN };
    const models = (await app.inject({ url: '/api/models', headers: { cookie: ownerCookie } })).json();
    expect(models.demoMode).toBe(true);
    expect(models.models.find((m: { id: string }) => m.id === 'anthropic/claude-opus-5')).toMatchObject({ available: false });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/providers/local-ollama',
      headers,
      payload: { kind: 'openai-compatible', name: 'Local Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-local-secret-value-123456' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().provider).toMatchObject({ hasApiKey: true });
    expect(JSON.stringify(saved.json())).not.toContain('sk-local-secret');

    const [row] = await container.db.db.select().from(schema.providerConfigs);
    expect(row!.apiKeyEncrypted).toMatch(/^v1:/);
    expect(row!.apiKeyEncrypted).not.toContain('sk-local-secret');

    const model = await app.inject({
      method: 'PUT',
      url: '/api/models/openai-compatible%2Fqwen-coder',
      headers,
      payload: {
        provider: 'openai-compatible',
        providerConfigId: 'local-ollama',
        modelId: 'qwen2.5-coder',
        displayName: 'Qwen Coder (local)',
        tier: 'balanced',
        contextWindow: 32_000,
        maxOutputTokens: 8_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: null, cacheWritePerMTok: null },
        latency: 'medium',
        codingScore: 80,
        reasoningScore: 70,
        capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: false },
        enabled: true,
      },
    });
    expect(model.statusCode).toBe(200);
    const listed = (await app.inject({ url: '/api/models', headers: { cookie: ownerCookie } })).json();
    expect(listed.models.find((m: { id: string }) => m.id === 'openai-compatible/qwen-coder')).toMatchObject({ available: true });
    expect(listed.demoMode).toBe(false);
  });

  it('updates global settings', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: ownerCookie, origin: ORIGIN }, payload: { globalDailyBudgetUsd: 12, modelOverrides: { reviewer: 'anthropic/claude-opus-5' } } });
    expect(response.json().settings).toMatchObject({ globalDailyBudgetUsd: 12, modelOverrides: { reviewer: 'anthropic/claude-opus-5' } });
  });
});

describe('GitHub webhooks', () => {
  const body = JSON.stringify({ action: 'completed', repository: { name: 'shop', owner: { login: 'acme' } }, check_suite: { head_sha: 'a'.repeat(40) } });

  it('rejects invalid signatures and accepts signed events', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/webhooks/github', headers: { 'content-type': 'application/json', 'x-github-event': 'check_suite', 'x-hub-signature-256': 'sha256=deadbeef' }, payload: body });
    expect(bad.statusCode).toBe(401);

    const signature = `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
    const good = await app.inject({ method: 'POST', url: '/api/webhooks/github', headers: { 'content-type': 'application/json', 'x-github-event': 'check_suite', 'x-hub-signature-256': signature }, payload: body });
    expect(good.statusCode).toBe(202);
    expect(good.json()).toMatchObject({ accepted: true, kind: 'ci_completed' });
  });
});
