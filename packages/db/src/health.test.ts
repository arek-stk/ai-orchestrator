import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultProjectProfile, defaultProjectSettings, TaskInputSchema, type NewProposal } from '@orch/core';
import { createAdminRepositories, type AdminRepositories } from './admin-repositories';
import { createDatabase, type DatabaseHandle } from './client';
import { createHealthRepositories, type HealthRepositories } from './health-repositories';
import { createRepositories, type Repositories } from './repositories';

let handle: DatabaseHandle;
let repos: Repositories;
let admin: AdminRepositories;
let health: HealthRepositories;

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  admin = createAdminRepositories(handle.db);
  health = createHealthRepositories(handle.db);
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

function proposal(projectId: string, overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    projectId,
    scanId: null,
    fingerprint: 'fp-cart-tests',
    category: 'missing_tests',
    title: 'Add tests for cart',
    description: 'cart.ts has no tests',
    rationale: 'central module',
    evidence: ['src/cart.ts is imported by 3 files'],
    affectedPaths: ['src/cart.ts'],
    acceptanceCriteria: ['cart is tested'],
    impact: 'high',
    effort: 'small',
    risk: 'low',
    roiScore: 30,
    priority: 5,
    source: 'heuristic',
    ...overrides,
  };
}

describe('health scans', () => {
  it('tracks the active scan and completes it', async () => {
    const project = await makeProject('scan-a');
    const { scan, created } = await health.healthScans.create({ projectId: project.id, trigger: 'manual', requestedBy: 'usr_1' });
    expect(created).toBe(true);
    expect(scan).toMatchObject({ status: 'queued', healthScore: null, breakdown: [] });
    expect((await health.healthScans.findActive(project.id))?.id).toBe(scan.id);

    const done = await health.healthScans.update(scan.id, { status: 'completed', healthScore: 82, breakdown: [{ component: 'tests', penalty: 18, maxPenalty: 25, detail: 'no tests' }], finishedAt: new Date() });
    expect(done).toMatchObject({ status: 'completed', healthScore: 82 });
    expect(await health.healthScans.findActive(project.id)).toBeNull();
    expect(await health.healthScans.list(project.id)).toHaveLength(1);
  });

  it('allows only one active scan per project, even for concurrent creates', async () => {
    const project = await makeProject('scan-race');
    const input = { projectId: project.id, trigger: 'manual' as const, requestedBy: null };
    const results = await Promise.all([health.healthScans.create(input), health.healthScans.create({ ...input, trigger: 'scheduled' }), health.healthScans.create(input)]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.scan.id)).size).toBe(1);
    expect(await health.healthScans.list(project.id)).toHaveLength(1);

    // Once the active scan has finished, a new one can be created.
    await health.healthScans.update(results[0]!.scan.id, { status: 'failed', finishedAt: new Date() });
    const next = await health.healthScans.create(input);
    expect(next.created).toBe(true);
    expect(next.scan.id).not.toBe(results[0]!.scan.id);
  });
});

describe('improvement proposals', () => {
  it('dedupes by fingerprint and keeps decisions sticky', async () => {
    const project = await makeProject('proposals-a');
    const first = await health.proposals.upsert(proposal(project.id));
    expect(first.created).toBe(true);
    const again = await health.proposals.upsert(proposal(project.id, { title: 'changed title' }));
    expect(again).toMatchObject({ created: false, proposal: { id: first.proposal.id, occurrences: 2, title: 'Add tests for cart' } });

    const dismissed = await health.proposals.dismiss(first.proposal.id, { decidedBy: 'alice', reason: 'not now' });
    expect(dismissed).toMatchObject({ status: 'dismissed', dismissReason: 'not now' });
    expect(await health.proposals.dismiss(first.proposal.id, { decidedBy: 'bob', reason: null })).toBeNull();
    const seenAfterDismissal = await health.proposals.upsert(proposal(project.id));
    expect(seenAfterDismissal).toMatchObject({ created: false, proposal: { status: 'dismissed' } });
  });

  it('accepts a proposal exactly once and links the task', async () => {
    const project = await makeProject('proposals-b');
    const { proposal: created } = await health.proposals.upsert(proposal(project.id, { fingerprint: 'fp-docs', category: 'documentation', priority: 3 }));
    await health.proposals.upsert(proposal(project.id, { fingerprint: 'fp-high', priority: 8 }));
    const task = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Write docs', goal: 'Document the API' }), null);

    expect(await health.proposals.accept(created.id, { taskId: task.id, decidedBy: 'system', auto: true })).toMatchObject({ status: 'accepted', taskId: task.id, autoAccepted: true });
    expect(await health.proposals.accept(created.id, { taskId: task.id, decidedBy: 'alice', auto: false })).toBeNull();

    const listed = await health.proposals.list({ projectId: project.id });
    expect(listed.map((p) => p.priority)).toEqual([8, 3]);
    expect(await health.proposals.list({ projectId: project.id, statuses: ['proposed'] })).toHaveLength(1);
  });
});

describe('agent cache and file summaries', () => {
  const value = { output: { ok: true }, confidence: 0.9, costUsd: 0.12, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, modelId: 'mock/test' };

  it('stores entries with expiry and counts hits', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    await health.agentCache.set({ key: 'agent:analyze:1', projectId: 'p1', kind: 'agent:analyze', contentHash: 'h', value, expiresAt: new Date(now.getTime() + 60_000) });
    expect((await health.agentCache.get('agent:analyze:1', now))?.value).toEqual(value);
    await health.agentCache.recordHit('agent:analyze:1');
    expect(await health.agentCache.stats('p1')).toEqual({ entries: 1, hits: 1 });
    expect(await health.agentCache.get('agent:analyze:1', new Date(now.getTime() + 61_000))).toBeNull();
    expect(await health.agentCache.purgeExpired(new Date(now.getTime() + 61_000))).toBe(1);
  });

  it('writes summaries only for the current blob sha and hides stale ones', async () => {
    const project = await makeProject('summaries');
    await admin.repoFiles.replace(project.id, [
      { path: 'src/cart.ts', sha: 'sha-1', size: 3000, summary: null, symbols: ['cartTotal'], imports: [] },
      { path: 'src/products.ts', sha: 'sha-2', size: 3000, summary: null, symbols: [], imports: [] },
    ]);
    const updated = await health.fileSummaries.updateSummaries(project.id, [
      { path: 'src/cart.ts', sha: 'sha-1', summary: 'Cart helpers: addToCart and cartTotal.' },
      { path: 'src/products.ts', sha: 'outdated', summary: 'stale' },
    ]);
    expect(updated).toBe(1);
    const files = await admin.repoFiles.list(project.id);
    expect(files.find((f) => f.path === 'src/cart.ts')?.summary).toBe('Cart helpers: addToCart and cartTotal.');
    expect(files.find((f) => f.path === 'src/products.ts')?.summary).toBeNull();
  });

  it('reports cache hits and savings in usage statistics', async () => {
    const since = new Date(Date.now() - 1000);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await repos.usage.record({ projectId: 'savings', taskId: null, agentRunId: null, provider: 'mock', modelId: 'm', usage, costUsd: 0.2 });
    await repos.usage.record({ projectId: 'savings', taskId: null, agentRunId: null, provider: 'mock', modelId: 'm', usage, costUsd: 0, cacheHit: true, savedUsd: 0.2 });
    expect(await admin.stats.summary(since, 'savings')).toMatchObject({ calls: 2, cacheHits: 1, costUsd: 0.2, savedUsd: 0.2 });
  });
});
