import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agents/runtime';
import type { ProposalItem } from '../agents/schemas';
import type { IndexedFile } from '../context/context-builder';
import { selectFilesToSummarize, summarizeFiles } from '../context/file-summarizer';
import type { AutonomyLevel } from '../domain/enums';
import { defaultProjectProfile, defaultProjectSettings } from '../domain/project';
import type { ModelProvider, StructuredRequest } from '../models/provider';
import type { ModelConfig } from '../models/types';
import { RepoIndexer } from '../repo-index/indexer';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { createMemoryStore } from '../testing/memory-store';
import { heuristicProposals, isAutoAcceptable, priorityFromRoi, proposalFingerprint, proposalTaskInput, roiScore } from './proposals';
import { HEALTH_SCAN_JOB, HealthScanner } from './scanner';
import { collectSignals, computeHealthScore, findUnpinnedDependencies, isNonModulePath, isTestPath } from './signals';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const repo = { owner: 'acme', name: 'shop' };
const bigCart = `export function cartTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n${'// pricing rules and discounts\n'.repeat(90)}`;

const repoFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '*', zod: '^4.0.0' }, devDependencies: { vitest: 'latest' } }),
  'README.md': '# Shop\n',
  'src/index.ts': "export { cartTotal } from './cart';\n",
  'src/checkout.ts': "import { cartTotal } from './cart';\nexport const checkout = () => cartTotal([1]);\n",
  'src/cart.ts': bigCart,
  '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
};

const largeTechDebt: ProposalItem = {
  key: 'rewrite-checkout',
  category: 'tech_debt',
  title: 'Rewrite checkout as a state machine',
  description: 'Checkout mixes pricing and payment',
  rationale: 'Hard to extend',
  evidence: ['src/checkout.ts calls cartTotal directly'],
  affectedPaths: ['src/checkout.ts', 'src/invented-file.ts'],
  impact: 'high',
  effort: 'large',
  risk: 'medium',
  acceptanceCriteria: ['Checkout states are explicit'],
};

const smallUx: ProposalItem = {
  key: 'friendly-errors',
  category: 'ux',
  title: 'Return friendly checkout error messages',
  description: 'Errors expose stack traces',
  rationale: 'Customers see raw errors',
  evidence: ['src/checkout.ts has no error handling'],
  affectedPaths: ['src/checkout.ts'],
  impact: 'medium',
  effort: 'small',
  risk: 'low',
  acceptanceCriteria: ['Checkout errors are user-friendly'],
};

const model: ModelConfig = {
  id: 'mock/test',
  provider: 'mock',
  providerConfigId: null,
  modelId: 'test',
  displayName: 'Test',
  tier: 'reasoning',
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWritePerMTok: null },
  latency: 'low',
  codingScore: 95,
  reasoningScore: 95,
  capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: true },
  enabled: true,
};

const responders: Record<string, (request: StructuredRequest<unknown>) => unknown> = {
  health_scan_output: () => ({ summary: 'Checkout needs attention.', proposals: [largeTechDebt, smallUx], confidence: 0.8 }),
  devops_output: () => ({
    summary: 'CI lacks caching',
    suggestions: [{ ...smallUx, key: 'ci-cache', area: 'ci', category: 'performance', title: 'Cache dependencies in CI', affectedPaths: ['.github/workflows/ci.yml'], effort: 'small', risk: 'low' }],
    confidence: 0.7,
  }),
  file_summary_output: (request) => ({
    summaries: [...request.messages[0]!.content.matchAll(/^### (.+?) \(full content\)$/gm)].map((m) => ({ path: m[1]!, summary: `Summary of ${m[1]!} with its exports.` })),
    confidence: 0.8,
  }),
};

async function harness(options: { level?: AutonomyLevel; maxScanCostUsd?: number } = {}) {
  const clock = { now: () => new Date('2026-09-14T10:00:00Z') };
  const store = createMemoryStore(clock);
  const github = new InMemoryGitHub();
  github.seed(repo, repoFiles);
  const calls: string[] = [];
  const provider: ModelProvider = {
    kind: 'mock',
    async generateStructured<T>(request: StructuredRequest<T>) {
      calls.push(request.schemaName);
      return {
        data: request.schema.parse(responders[request.schemaName]!(request as StructuredRequest<unknown>)),
        usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'end_turn',
        providerModelId: 'test',
      };
    },
  };
  const runtime = new AgentRuntime({
    models: () => [model],
    providers: { get: () => provider },
    agentRuns: store.agentRuns,
    usage: store.usage,
    addProjectUsage: (id, cost, tokens) => store.projects.addUsage(id, cost, tokens),
    addTaskUsage: async () => {},
    events: store.events,
    budgetScopes: async () => [],
    globalRoleOverrides: () => ({}),
    clock,
    cache: store.agentCache,
  });
  const project = await store.projects.create({
    slug: 'shop',
    name: 'Shop',
    description: '',
    repo: { ...repo, defaultBranch: 'main' },
    priority: 5,
    autonomyLevel: options.level ?? 3,
    budgetUsd: 50,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'] },
    settings: defaultProjectSettings(),
  });
  const scanner = new HealthScanner(
    {
      ...store,
      clock,
      runtime,
      github,
      repoIndex: new RepoIndexer(github, store.repoFiles),
      summaries: store.fileSummaries,
    },
    options.maxScanCostUsd !== undefined ? { maxScanCostUsd: options.maxScanCostUsd } : {},
  );
  const scanNow = async () => {
    const { scan } = await scanner.request(project.id, 'manual', 'usr_1');
    return (await scanner.run(scan.id))!;
  };
  return { store, scanner, project, calls, scanNow };
}

// ---------------------------------------------------------------------------

describe('health signals and score', () => {
  const files: IndexedFile[] = Object.entries(repoFiles).map(([path, content]) => ({ path, sha: path, size: content.length, imports: path === 'src/index.ts' || path === 'src/checkout.ts' ? ['./cart'] : [] }));
  const manifests = [{ path: 'package.json', content: repoFiles['package.json']! }];

  it('collects deterministic signals from the index, manifests, failures and runs', () => {
    const signals = collectSignals({
      files,
      manifests,
      failures: [{ id: 'm', projectId: 'p', scope: 'failure', taskId: null, kind: 'test_failure', key: 'abc', content: JSON.stringify({ summary: 'total off by one' }), tags: [], hits: 3, createdAt: new Date(), updatedAt: new Date() }],
      runs: [{ status: 'SUCCEEDED' }, { status: 'BLOCKED' }, { status: 'FAILED' }, { status: 'SUCCEEDED' }],
      blockedTasks: [{ id: 't1', title: 'Refunds', blockedReason: 'needs a human' }],
    });
    expect(signals.files).toMatchObject({ source: 3, tests: 0 });
    expect(signals.untestedModules[0]).toEqual({ path: 'src/cart.ts', importers: 2 });
    expect(signals.untestedModules.map((m) => m.path)).not.toContain('src/index.ts');
    expect(signals.dependencies.unpinned.map((d) => d.name).sort()).toEqual(['express', 'vitest']);
    expect(signals.ci.workflows).toEqual(['.github/workflows/ci.yml']);
    expect(signals.docs).toEqual({ readme: true, changelog: false, contributing: false });
    expect(signals.failures[0]).toMatchObject({ hits: 3, summary: 'total off by one' });

    const { score, breakdown } = computeHealthScore(signals);
    expect(breakdown.find((b) => b.component === 'tests')?.penalty).toBe(25);
    expect(breakdown.find((b) => b.component === 'runs')?.penalty).toBe(7.5);
    expect(score).toBe(100 - breakdown.reduce((sum, b) => sum + b.penalty, 0));
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('scores a healthy project at 100', () => {
    const signals = collectSignals({
      files: [
        { path: 'README.md', sha: '1', size: 10 },
        { path: 'CHANGELOG.md', sha: '2', size: 10 },
        { path: 'CONTRIBUTING.md', sha: '3', size: 10 },
        { path: 'src/cart.ts', sha: '4', size: 10 },
        { path: 'src/cart.test.ts', sha: '5', size: 10 },
      ],
      manifests: [],
      failures: [],
      runs: [],
      blockedTasks: [],
    });
    expect(computeHealthScore(signals).score).toBe(100);
  });

  it('detects unbounded dependency ranges in package.json and requirements.txt', () => {
    expect(findUnpinnedDependencies({ path: 'package.json', content: '{"dependencies":{"a":">=1","b":">=1 <2","c":"1.2.3"}}' })).toEqual([{ name: 'a', range: '>=1' }]);
    expect(findUnpinnedDependencies({ path: 'requirements.txt', content: 'requests\nflask==3.0.0\n# comment\nnumpy>=1.2\n-r base.txt\n' }).map((d) => d.name)).toEqual(['requests', 'numpy']);
    expect(findUnpinnedDependencies({ path: 'package.json', content: 'not json' })).toEqual([]);
    expect(findUnpinnedDependencies({ path: 'requirements.txt', content: 'uvicorn[standard] >=0.30\ndjango[argon2]==5.0 # pinned\n' })).toEqual([{ name: 'uvicorn', range: '>=0.30' }]);
  });

  it('classifies test and non-module paths without backtracking on hostile input', () => {
    expect(['src/cart.test.ts', 'src/cart.spec.js', 'pkg/cart_test.go', 'tests/test_cart.py', 'src/__tests__/cart.ts', 'e2e/checkout.ts'].every(isTestPath)).toBe(true);
    expect(['src/cart.ts', 'src/testing/helpers.ts', 'src/contest.ts', 'test.ts'].some(isTestPath)).toBe(false);
    expect(['src/types.d.ts', 'src/index.ts', 'vite.config.ts', 'scripts/build.ts', 'db/migrations/0001.ts'].every(isNonModulePath)).toBe(true);
    expect(['src/cart.ts', 'src/config.ts', 'src/indexer.ts'].some(isNonModulePath)).toBe(false);

    const started = Date.now();
    isTestPath(`.test.${'.spec.'.repeat(50_000)}`);
    isNonModulePath(`.config.${'.config.'.repeat(50_000)}`);
    findUnpinnedDependencies({ path: 'requirements.txt', content: `${'#'.repeat(100_000)}\n-${' '.repeat(100_000)}x\n` });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('proposal ranking and task mapping', () => {
  it('ranks by ROI and maps ROI onto priority 1–10', () => {
    expect(roiScore({ impact: 'high', effort: 'small', risk: 'low' })).toBe(30);
    expect(roiScore({ impact: 'low', effort: 'large', risk: 'high' })).toBe(1);
    expect(priorityFromRoi(30)).toBe(10);
    expect(priorityFromRoi(1)).toBe(1);
    expect(priorityFromRoi(roiScore({ impact: 'medium', effort: 'medium', risk: 'medium' }))).toBeGreaterThan(priorityFromRoi(roiScore({ impact: 'medium', effort: 'large', risk: 'medium' })));
  });

  it('fingerprints ignore case and punctuation but not the category', () => {
    expect(proposalFingerprint('ux', 'Friendly errors!')).toBe(proposalFingerprint('ux', 'friendly   errors'));
    expect(proposalFingerprint('ux', 'Friendly errors')).not.toBe(proposalFingerprint('tech_debt', 'Friendly errors'));
  });

  it('creates capped-priority tasks and only auto-accepts small low-risk work from level 3', () => {
    const input = proposalTaskInput({ ...largeTechDebt, priority: 9 });
    expect(input).toMatchObject({ kind: 'refactor', priority: 5, estimatedComplexity: 'complex', risk: 'medium' });
    expect(proposalTaskInput({ ...smallUx, priority: 3 })).toMatchObject({ kind: 'improvement', priority: 3, estimatedComplexity: 'simple' });
    expect(isAutoAcceptable(smallUx, 3)).toBe(true);
    expect(isAutoAcceptable(smallUx, 2)).toBe(false);
    expect(isAutoAcceptable(largeTechDebt, 4)).toBe(false);
    expect(isAutoAcceptable({ risk: 'medium', effort: 'small' }, 4)).toBe(false);
  });

  it('never auto-accepts removal of committed secrets', () => {
    const signals = collectSignals({ files: [{ path: 'config/.env', sha: '1', size: 10 }, { path: 'README.md', sha: '2', size: 5 }], manifests: [], failures: [], runs: [], blockedTasks: [] });
    const security = heuristicProposals(signals).find((p) => p.category === 'security_risk')!;
    expect(security.evidence).toEqual(['Sensitive file tracked: config/.env']);
    expect(isAutoAcceptable(security, 4)).toBe(false);
  });
});

describe('file summarizer', () => {
  it('summarises large, central files once per blob sha within its bounds', async () => {
    const h = await harness();
    const index = await new RepoIndexer(new InMemoryGitHub(), h.store.repoFiles).refresh(h.project.id, repo, 'main').catch(() => null);
    expect(index).toBeNull();

    const github = new InMemoryGitHub();
    github.seed(repo, repoFiles);
    const { files, headSha } = await new RepoIndexer(github, h.store.repoFiles).refresh(h.project.id, repo, 'main');
    expect(selectFilesToSummarize(files, { limit: 10, minBytes: 2_000 }).map((f) => f.path)).toEqual(['src/cart.ts']);

    const runtime = (h.scanner as unknown as { deps: { runtime: AgentRuntime } }).deps.runtime;
    const request = { runtime, store: h.store.fileSummaries, project: h.project, loadContent: (path: string) => github.getFileContent(repo, path, headSha), scope: { projectId: h.project.id, taskId: null, runId: null } };
    const first = await summarizeFiles({ ...request, files });
    expect(first).toMatchObject({ summarized: 1, batches: 1, stoppedBecause: null });
    const stored = await h.store.repoFiles.list(h.project.id);
    expect(stored.find((f) => f.path === 'src/cart.ts')?.summary).toMatch(/Summary of src\/cart.ts/);

    const second = await summarizeFiles({ ...request, files: stored });
    expect(second.batches).toBe(0);
    expect(h.calls.filter((c) => c === 'file_summary_output')).toHaveLength(1);
  });
});

describe('HealthScanner', () => {
  it('scans, persists the health score, ranks proposals and auto-accepts only small low-risk ones at level 3', async () => {
    const h = await harness({ level: 3 });
    const scan = await h.scanNow();

    expect(scan).toMatchObject({ status: 'completed', agentStatus: 'ok', previousScore: null });
    expect(scan.healthScore).toBeLessThan(100);
    expect((await h.store.projects.get(h.project.id))!.healthScore).toBe(scan.healthScore);
    expect(h.calls).toEqual(['file_summary_output', 'health_scan_output', 'devops_output']);
    expect(scan.costUsd).toBeGreaterThan(0);

    const proposals = await h.store.proposals.list({ projectId: h.project.id });
    expect(proposals.map((p) => p.source).sort()).toEqual(expect.arrayContaining(['agent', 'devops', 'heuristic']));
    const rewrite = proposals.find((p) => p.title === largeTechDebt.title)!;
    expect(rewrite).toMatchObject({ status: 'proposed', affectedPaths: ['src/checkout.ts'] });

    const accepted = proposals.filter((p) => p.status === 'accepted');
    expect(accepted.length).toBe(3);
    expect(scan.autoAccepted).toBe(3);
    for (const proposal of accepted) {
      expect(proposal).toMatchObject({ autoAccepted: true, risk: 'low', effort: 'small', decidedBy: 'system' });
      const task = (await h.store.tasks.get(proposal.taskId!))!;
      expect(task.status).toBe('BACKLOG');
      expect(task.priority).toBeLessThanOrEqual(5);
    }
    expect(h.store.events.log.map((e) => e.type)).toEqual(expect.arrayContaining(['project.health_scan.requested', 'improvement.proposed', 'improvement.accepted', 'project.health_scanned']));
    expect((await h.store.memories.search(h.project.id, { key: 'health:latest' }))[0]?.kind).toBe('health');
  });

  it('never auto-accepts below level 3, dedupes across scans and keeps dismissals', async () => {
    const h = await harness({ level: 2 });
    const first = await h.scanNow();
    expect(first.autoAccepted).toBe(0);
    const proposals = await h.store.proposals.list({ projectId: h.project.id });
    expect(proposals.every((p) => p.status === 'proposed')).toBe(true);

    const dismissed = await h.scanner.dismiss(proposals[0]!.id, { userId: 'usr_1', name: 'alice' }, 'not relevant');
    expect(dismissed).toMatchObject({ status: 'dismissed' });

    const second = await h.scanNow();
    expect(second).toMatchObject({ proposalsCreated: 0, previousScore: first.healthScore, agentStatus: 'cached' });
    const again = await h.store.proposals.list({ projectId: h.project.id });
    expect(again).toHaveLength(proposals.length);
    expect(again.find((p) => p.id === proposals[0]!.id)).toMatchObject({ status: 'dismissed', occurrences: 2 });
  });

  it('degrades to a heuristics-only scan when the scan budget is exhausted', async () => {
    const h = await harness({ maxScanCostUsd: 0 });
    const scan = await h.scanNow();
    expect(scan).toMatchObject({ status: 'completed', agentStatus: 'skipped: scan budget exhausted', costUsd: 0 });
    expect(h.calls.filter((c) => c !== 'file_summary_output')).toEqual([]);
    expect((await h.store.proposals.list({ projectId: h.project.id })).every((p) => p.source === 'heuristic')).toBe(true);
  });

  it('queues at most one scan per project and decides proposals exactly once', async () => {
    const h = await harness({ level: 2 });
    const a = await h.scanner.request(h.project.id, 'manual', 'usr_1');
    const b = await h.scanner.request(h.project.id, 'manual', 'usr_2');
    expect(b).toMatchObject({ created: false, scan: { id: a.scan.id } });
    expect(h.store.queue.jobs.filter((j) => j.type === HEALTH_SCAN_JOB)).toHaveLength(1);
    await h.scanner.run(a.scan.id);

    const [proposal] = await h.store.proposals.list({ projectId: h.project.id });
    const actor = { userId: 'usr_1', name: 'alice' };
    const accepted = await h.scanner.accept(proposal!.id, actor);
    expect(accepted?.task).toMatchObject({ status: 'BACKLOG', projectId: h.project.id });
    expect(await h.scanner.accept(proposal!.id, actor)).toBeNull();
    expect(await h.scanner.dismiss(proposal!.id, actor, null)).toBeNull();
  });

  it('creates one scan and one job for concurrent manual and scheduled requests', async () => {
    const h = await harness({ level: 2 });
    const results = await Promise.all([
      h.scanner.request(h.project.id, 'manual', 'usr_1'),
      h.scanner.request(h.project.id, 'manual', 'usr_2'),
      h.scanner.scheduleDue(0).then(() => null),
    ]);
    const requests = results.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(new Set(requests.map((r) => r.scan.id)).size).toBe(1);
    expect(await h.store.scans.list(h.project.id)).toHaveLength(1);
    expect(h.store.queue.jobs.filter((j) => j.type === HEALTH_SCAN_JOB)).toHaveLength(1);
    expect(h.store.events.log.filter((e) => e.type === 'project.health_scan.requested')).toHaveLength(1);
  });

  it('queues scheduled scans only for due projects with a repository and autonomy level ≥ 1', async () => {
    const h = await harness({ level: 1 });
    expect(await h.scanner.scheduleDue(24 * 60 * 60 * 1000)).toBe(1);
    expect(await h.scanner.scheduleDue(24 * 60 * 60 * 1000)).toBe(0);
    await h.store.projects.update(h.project.id, { autonomyLevel: 0 });
    const [scan] = await h.store.scans.list(h.project.id);
    await h.scanner.run(scan!.id);
    expect(await h.scanner.scheduleDue(0)).toBe(0);
  });
});
