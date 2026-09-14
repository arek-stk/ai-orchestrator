import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agents/runtime';
import type { AutonomyLevel } from '../domain/enums';
import { defaultProjectProfile, defaultProjectSettings, type ProjectProfile } from '../domain/project';
import { TaskInputSchema, type TaskInput } from '../domain/task';
import type { CheckReport } from '../github/port';
import type { ModelProvider, StructuredRequest } from '../models/provider';
import type { ModelConfig } from '../models/types';
import { RepoIndexer } from '../repo-index/indexer';
import type { SandboxPort, SandboxRunResult } from '../sandbox/port';
import { unavailableSandbox } from '../sandbox/port';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { createMemoryStore } from '../testing/memory-store';
import { runResearch } from '../intelligence/research';
import { Orchestrator, type StepResult } from './orchestrator';

// ---------------------------------------------------------------------------
// Canned agent outputs (the orchestrator logic is under test, not the models)
// ---------------------------------------------------------------------------

type Responder = (request: StructuredRequest<unknown>) => unknown;

function field(prompt: string, name: string): string {
  return new RegExp(`^${name}: (.+)$`, 'm').exec(prompt)?.[1] ?? '';
}

const responders: Record<string, Responder> = {
  analysis_output: () => ({ summary: 'TypeScript shop', architecture: 'layers', relevantPaths: ['src/index.ts'], conventions: [], risks: [], techDebt: [], confidence: 0.8 }),
  plan_output: (req) => {
    const prompt = req.messages[0]!.content;
    const complex = field(prompt, 'Complexity') === 'complex';
    return {
      goal: field(prompt, 'Title'),
      approach: 'Small feature module',
      tasks: complex
        ? [
            { key: 'api', title: 'Build the API', description: 'Endpoints for search', role: 'backend', dependsOn: [], acceptanceCriteria: ['API returns results'] },
            { key: 'ui', title: 'Build the UI', description: 'Search box', role: 'frontend', dependsOn: ['api'], acceptanceCriteria: ['UI shows results'] },
          ]
        : [{ key: 'impl', title: 'Implement', description: 'Do it', role: 'builder', dependsOn: [], acceptanceCriteria: ['works'] }],
      risks: [],
      acceptanceCriteria: ['Feature works'],
      estimatedComplexity: complex ? 'complex' : 'medium',
      requiresDesign: false,
      touchesAreas: ['src'],
      openQuestions: [],
      confidence: 0.85,
    };
  },
  design_opinion_output: () => ({
    options: [
      { id: 'option-a', summary: 'Extend module', pros: ['simple'], cons: [] },
      { id: 'option-b', summary: 'New service', pros: [], cons: ['complex'] },
    ],
    recommendedOptionId: 'option-a',
    rationale: 'Lowest risk',
    risks: [],
    confidence: 0.9,
  }),
  build_output: (req) => {
    const title = field(req.messages[0]!.content, 'Title');
    const changes = [{ path: 'src/feature.ts', action: 'create', content: 'export const feature = 1;\n', rationale: 'feature' }];
    if (title.includes('index')) changes.push({ path: 'db/migrations/0002_add_index.sql', action: 'create', content: 'CREATE INDEX idx ON products(name);\n', rationale: 'index' });
    return { summary: 'feature', changes, notes: [], confidence: 0.8 };
  },
  test_output: () => ({
    summary: 'tests',
    testFiles: [{ path: 'src/feature.test.ts', action: 'create', content: 'test("x", () => {});\n', rationale: 'test' }],
    coverageNotes: [],
    confidence: 0.8,
  }),
  debug_output: () => ({
    reproduction: 'ran tests',
    rootCause: 'wrong constant',
    evidence: ['src/feature.ts'],
    isInfrastructureIssue: false,
    fix: [{ path: 'src/feature.ts', action: 'update', content: 'export const feature = 2;\n', rationale: 'fix' }],
    confidence: 0.8,
  }),
  review_output: () => ({ verdict: 'approve', summary: 'good', issues: [], acceptanceCriteria: [{ criterion: 'Feature works', met: true, evidence: 'tests' }], confidence: 0.9 }),
  security_output: () => ({ verdict: 'pass', summary: 'ok', findings: [], confidence: 0.9 }),
  synthesis_output: () => ({ decision: 'option-a', chosenOptionId: 'option-a', reason: 'consensus', dissent: [], evidence: [], confidence: 0.9 }),
  blocker_analysis_output: () => ({ why: 'Tests keep failing with the same error.', missingInformation: [], alternativeApproach: null, needsHuman: true, confidence: 0.7 }),
  documentation_output: (req) => {
    const target = field(req.messages[0]!.content, 'Title').includes('code') ? 'src/index.ts' : 'README.md';
    return { summary: 'docs', changes: [{ path: target, action: 'update', content: '# Shop\n\nSearch products by name.\n', rationale: 'docs' }], notes: [], confidence: 0.9 };
  },
  release_readiness_output: (req) =>
    field(req.messages[0]!.content, 'Title').includes('unready')
      ? { verdict: 'not_ready', summary: 'Changelog missing', checks: [{ name: 'changelog', status: 'fail', detail: 'missing' }], blockers: ['changelog entry missing'], confidence: 0.8 }
      : { verdict: 'ready', summary: 'Ready to ship', checks: [{ name: 'tests', status: 'pass', detail: 'passed' }], blockers: [], confidence: 0.9 },
  research_output: () => ({
    question: 'q',
    findings: [{ claim: 'Postgres trigram indexes speed up ILIKE search', source: 'docs', confidence: 0.8 }],
    recommendation: 'Use a trigram index',
    limitations: [],
    openQuestions: [],
    confidence: 0.8,
  }),
};

const model: ModelConfig = {
  id: 'mock/test',
  provider: 'mock',
  providerConfigId: null,
  modelId: 'test',
  displayName: 'Test model',
  tier: 'reasoning',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWritePerMTok: null },
  latency: 'low',
  codingScore: 99,
  reasoningScore: 99,
  capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: true },
  enabled: true,
};

/** Last user prompt per schema, for assertions on what an agent was shown. */
const lastPrompts: Record<string, string> = {};

const provider: ModelProvider = {
  kind: 'mock',
  async generateStructured<T>(request: StructuredRequest<T>) {
    lastPrompts[request.schemaName] = request.messages[0]!.content;
    const responder = responders[request.schemaName];
    if (!responder) throw new Error(`no responder for ${request.schemaName}`);
    return {
      data: request.schema.parse(responder(request as StructuredRequest<unknown>)),
      usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
      providerModelId: request.model.modelId,
    };
  },
};

function scriptedSandbox(results: boolean[]): SandboxPort & { calls: number } {
  const sandbox = {
    available: true,
    calls: 0,
    async run(): Promise<SandboxRunResult> {
      const pass = results[Math.min(sandbox.calls, results.length - 1)]!;
      sandbox.calls++;
      return pass
        ? { passed: true, results: [{ name: 'test', exitCode: 0, output: 'ok', durationMs: 5 }], failedCommand: null, infrastructureError: null }
        : {
            passed: false,
            results: [{ name: 'test', exitCode: 1, output: 'FAIL src/feature.test.ts\nAssertionError: expected 1 to equal 2', durationMs: 5 }],
            failedCommand: 'test',
            infrastructureError: null,
          };
    },
  };
  return sandbox;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const repo = { owner: 'acme', name: 'shop' };

async function harness(options: { level?: AutonomyLevel; sandbox?: SandboxPort; profile?: Partial<ProjectProfile>; budgetUsd?: number } = {}) {
  let time = Date.parse('2026-09-14T10:00:00Z');
  const clock = { now: () => new Date(time) };
  const store = createMemoryStore(clock);
  const github = new InMemoryGitHub();
  const mainSha = github.seed(repo, { 'src/index.ts': 'export {};\n', 'README.md': '# Shop\n' });

  const runtime = new AgentRuntime({
    models: () => [model],
    providers: { get: () => provider },
    agentRuns: store.agentRuns,
    usage: store.usage,
    addProjectUsage: (id, cost, tokens) => store.projects.addUsage(id, cost, tokens),
    addTaskUsage: (id, cost, tokens) => store.tasks.addUsage(id, cost, tokens),
    events: store.events,
    budgetScopes: async ({ projectId }) => {
      const project = (await store.projects.get(projectId))!;
      return [{ scope: 'project', limitUsd: project.budgetUsd, spentUsd: project.spentUsd }];
    },
    globalRoleOverrides: () => ({}),
    clock,
  });

  const orchestrator = new Orchestrator({
    ...store,
    clock,
    runtime,
    github,
    sandbox: options.sandbox ?? scriptedSandbox([true]),
    repoIndex: new RepoIndexer(github, store.repoFiles),
  });

  const project = await store.projects.create({
    slug: 'shop',
    name: 'Shop',
    description: 'Demo shop',
    repo: { ...repo, defaultBranch: 'main' },
    priority: 5,
    autonomyLevel: options.level ?? 3,
    budgetUsd: options.budgetUsd ?? 50,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'], commands: { test: 'npm test' }, ...options.profile },
    settings: defaultProjectSettings(),
  });

  const createTask = (input: Partial<TaskInput> = {}) =>
    store.tasks.create(project.id, TaskInputSchema.parse({ title: 'Add product search', goal: 'Users can search products by name', ...input }), null);

  /** Runs steps like the job worker would, fast-forwarding the clock through timed waits. */
  async function drive(runId: string, maxSteps = 200): Promise<StepResult> {
    for (let i = 0; i < maxSteps; i++) {
      const result = await orchestrator.step(runId);
      if (result.next === 'continue') continue;
      if (result.next === 'wait' && result.resumeAt) {
        time = Math.max(time, result.resumeAt.getTime());
        continue;
      }
      return result;
    }
    throw new Error('run did not settle');
  }

  const eventTypes = () => store.events.log.map((e) => e.type);
  return { store, github, orchestrator, project, createTask, drive, eventTypes, mainSha };
}

// ---------------------------------------------------------------------------

describe('Orchestrator pipeline', () => {
  it('delivers a feature end to end at level 3: plan, design, build, test, review, branch, commit, PR, CI', async () => {
    const h = await harness();
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;
    expect(run.stagePlan.filter((s) => s.run).map((s) => s.stage)).toEqual([
      'INTAKE', 'ANALYZE', 'PLAN', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'VERIFY', 'COMMIT', 'PUSH', 'PR', 'CI',
    ]);

    expect(await h.drive(run.id)).toEqual({ next: 'done', status: 'SUCCEEDED' });

    const finished = (await h.store.runs.get(run.id))!;
    expect(finished.checkpoint.outcome).toBe('pr_ready');
    expect(finished.costUsd).toBeGreaterThan(0);
    expect((await h.store.tasks.get(task.id))!).toMatchObject({ status: 'DONE', prNumber: 1 });

    // Never writes to main: the change lives on a feature branch with an open PR.
    expect(h.github.branch(repo, 'main')).toBe(h.mainSha);
    const [pr] = h.github.pulls(repo);
    expect(pr).toMatchObject({ base: 'main', state: 'open' });
    expect(pr!.head.startsWith(`orchestrator/${task.id}`)).toBe(true);
    const head = h.github.branch(repo, pr!.head)!;
    expect(h.github.fileAt(repo, head, 'src/feature.ts')).toBe('export const feature = 1;\n');
    expect(h.github.fileAt(repo, head, 'src/feature.test.ts')).toBeDefined();

    expect(h.eventTypes()).toEqual(expect.arrayContaining(['task.started', 'decision.made', 'test.passed', 'github.push', 'github.pr.created', 'ci.passed', 'task.completed']));
    expect(await h.store.decisions.list({ projectId: h.project.id })).toHaveLength(1);
    expect((await h.store.projects.get(h.project.id))!.status).toBe('IDLE');
  });

  it('debugs a failing test run, fixes the code and remembers the failure', async () => {
    const sandbox = scriptedSandbox([false, true]);
    const h = await harness({ sandbox });
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    const finished = (await h.store.runs.get(run.id))!;
    expect(finished.debugAttempts).toBe(1);
    expect(finished.stageStates.DEBUG?.status).toBe('passed');
    expect(finished.checkpoint.changeset.find((c) => c.path === 'src/feature.ts')?.content).toBe('export const feature = 2;\n');
    expect(sandbox.calls).toBe(2);
    expect(await h.store.memories.search(h.project.id, { scope: 'failure' })).toHaveLength(1);
    expect(h.eventTypes()).toContain('test.failed');
  });

  it('blocks after maxDebugAttempts with a blocker analysis instead of looping', async () => {
    const h = await harness({ sandbox: scriptedSandbox([false]) });
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toEqual({ next: 'done', status: 'BLOCKED' });
    const blocked = (await h.store.runs.get(run.id))!;
    expect(blocked.debugAttempts).toBe(3);
    expect(blocked.blockedReason).toMatch(/Gave up after 3 repair attempt/);
    expect(blocked.checkpoint.notes.some((n) => n.startsWith('blocker analysis:'))).toBe(true);
    expect((await h.store.tasks.get(task.id))!.status).toBe('BLOCKED');
    expect((await h.store.projects.get(h.project.id))!.status).toBe('BLOCKED');
    expect(h.github.pulls(repo)).toHaveLength(0);
  });

  it('level 2 executes and verifies but never publishes', async () => {
    const h = await harness({ level: 2 });
    const commitsBefore = h.github.commitCount(repo);
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await h.store.runs.get(run.id))!.checkpoint.outcome).toBe('changes_ready');
    expect(h.github.commitCount(repo)).toBe(commitsBefore);
  });

  it('re-runs CI on infrastructure failures without touching the code', async () => {
    const h = await harness();
    const failures: CheckReport = {
      state: 'failure',
      conclusion: 'failure',
      jobs: [],
      logExcerpt: 'The self-hosted runner lost communication with the server.',
      url: null,
      runIds: [42],
    };
    h.github.checks = (_sha, poll) =>
      poll === 0 ? failures : { state: 'success', conclusion: 'success', jobs: [], logExcerpt: '', url: null, runIds: [] };
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(h.github.reruns).toEqual([[42]]);
    expect((await h.store.runs.get(run.id))!.debugAttempts).toBe(0);
  });

  it('sends code-level CI failures to the debug agent and pushes a fix commit', async () => {
    const h = await harness({ sandbox: unavailableSandbox });
    h.github.checks = (sha, poll) => {
      const content = h.github.fileAt(repo, sha, 'src/feature.ts');
      if (content === 'export const feature = 1;\n') {
        return { state: 'failure', conclusion: 'failure', jobs: [], logExcerpt: 'FAIL src/feature.test.ts\nAssertionError: expected 1 to equal 2', url: null, runIds: [7] };
      }
      return poll === 0 ? { state: 'pending', conclusion: null, jobs: [], logExcerpt: '', url: null, runIds: [] } : { state: 'success', conclusion: 'success', jobs: [], logExcerpt: '', url: null, runIds: [] };
    };
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    const finished = (await h.store.runs.get(run.id))!;
    expect(finished.debugAttempts).toBe(1);
    expect(finished.checkpoint.verification?.source).toBe('ci');
    const head = h.github.branch(repo, finished.checkpoint.branch!)!;
    expect(h.github.fileAt(repo, head, 'src/feature.ts')).toBe('export const feature = 2;\n');
    expect(h.github.reruns).toEqual([]);
  });

  it('waits for human approval on gated changes and continues once approved', async () => {
    const h = await harness();
    const task = await h.createTask({ title: 'Add search index', goal: 'Speed up product search with an index' });
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toEqual({ next: 'wait', resumeAt: null });
    const [approval] = await h.store.approvals.list({ status: 'pending' });
    expect(approval).toMatchObject({ action: 'database_migration', runId: run.id });
    expect((await h.store.tasks.get(task.id))!.status).toBe('WAITING_APPROVAL');
    expect(h.github.pulls(repo)).toHaveLength(0);

    await h.store.approvals.decide(approval!.id, 'approved', 'usr_owner', null);
    expect(await h.orchestrator.onApprovalDecided(approval!.id)).toEqual({ next: 'continue' });
    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(h.github.pulls(repo)).toHaveLength(1);
  });

  it('blocks the run when a human rejects the approval', async () => {
    const h = await harness();
    const task = await h.createTask({ title: 'Add search index', goal: 'Speed up product search with an index' });
    const run = (await h.orchestrator.startTask(task.id))!;
    await h.drive(run.id);
    const [approval] = await h.store.approvals.list({ status: 'pending' });
    await h.store.approvals.decide(approval!.id, 'rejected', 'usr_owner', 'no schema changes this sprint');

    expect(await h.orchestrator.onApprovalDecided(approval!.id)).toEqual({ next: 'done', status: 'BLOCKED' });
    expect((await h.store.runs.get(run.id))!.blockedReason).toContain('no schema changes this sprint');
  });

  it('decomposes complex tasks into a dependency graph and schedules only ready sub-tasks', async () => {
    const h = await harness();
    const parent = await h.createTask({ estimatedComplexity: 'complex' });
    const run = (await h.orchestrator.startTask(parent.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await h.store.runs.get(run.id))!.checkpoint.outcome).toBe('decomposed');
    expect((await h.store.tasks.get(parent.id))!.status).toBe('WAITING_CHILDREN');

    const children = await h.store.tasks.list({ parentId: parent.id });
    expect(children).toHaveLength(2);
    const api = children.find((c) => c.title === 'Build the API')!;
    const ui = children.find((c) => c.title === 'Build the UI')!;
    expect(ui.dependencies).toEqual([api.id]);

    const tick = await h.orchestrator.tick();
    expect(tick.started).toHaveLength(1);
    expect((await h.store.tasks.get(api.id))!.status).toBe('RUNNING');
    expect((await h.store.tasks.get(ui.id))!.status).toBe('READY');
  });

  it('pauses instead of calling models when the project budget is exhausted', async () => {
    const h = await harness({ budgetUsd: 0.000001 });
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toEqual({ next: 'wait', resumeAt: null });
    expect((await h.store.runs.get(run.id))!.status).toBe('PAUSED');
    expect((await h.store.tasks.get(task.id))!.status).toBe('PAUSED');
    expect(h.eventTypes()).toContain('budget.exhausted');
  });

  it('reuses a confident earlier design decision instead of consulting the council again', async () => {
    const h = await harness();
    const first = await h.createTask();
    await h.drive((await h.orchestrator.startTask(first.id))!.id);
    const agentRunsAfterFirst = (await h.store.agentRuns.list({ role: 'architect' })).length;

    const second = await h.createTask();
    const run = (await h.orchestrator.startTask(second.id))!;
    await h.drive(run.id);
    expect((await h.store.agentRuns.list({ role: 'architect' })).length).toBe(agentRunsAfterFirst);
    expect((await h.store.runs.get(run.id))!.stageStates.DESIGN?.summary).toMatch(/Reused earlier decision/);
  });
});

describe('Specialists in the pipeline', () => {
  it('lets the documentation agent implement docs tasks and publishes only documentation files', async () => {
    const h = await harness();
    const task = await h.createTask({ title: 'Document search', goal: 'Explain product search in the README', kind: 'docs', estimatedComplexity: 'simple', risk: 'low' });
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    const roles = (await h.store.agentRuns.list({ runId: run.id })).map((r) => r.role);
    expect(roles).toContain('documentation');
    expect(roles).not.toContain('builder');
    const finished = (await h.store.runs.get(run.id))!;
    expect(finished.checkpoint.changeset.map((c) => c.path)).toEqual(['README.md']);
    const head = h.github.branch(repo, finished.checkpoint.branch!)!;
    expect(h.github.fileAt(repo, head, 'README.md')).toContain('Search products by name.');
  });

  it('rejects documentation output that touches code', async () => {
    const h = await harness();
    const task = await h.createTask({ title: 'Document code comments', goal: 'Explain the index module', kind: 'docs', estimatedComplexity: 'simple', risk: 'low' });
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'BLOCKED' });
    expect(h.github.pulls(repo)).toHaveLength(0);
    expect((await h.store.agentRuns.list({ runId: run.id, role: 'documentation' }))[0]?.error).toMatch(/not a documentation file/);
  });

  it('checks release readiness before asking for the production deploy approval', async () => {
    const h = await harness({ level: 4, profile: { deployWorkflow: 'deploy.yml' } });
    const task = await h.createTask();
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toEqual({ next: 'wait', resumeAt: null });
    const [approval] = await h.store.approvals.list({ status: 'pending' });
    expect(approval).toMatchObject({ action: 'production_deploy' });
    expect(approval!.details.releaseReadiness).toMatchObject({ summary: 'Ready to ship' });
    expect(h.store.events.log.find((e) => e.type === 'release.readiness')?.payload).toEqual({ verdict: 'ready', blockers: [] });
    expect((await h.store.agentRuns.list({ runId: run.id, role: 'release' })).length).toBe(1);

    await h.store.approvals.decide(approval!.id, 'approved', 'usr_owner', null);
    await h.orchestrator.onApprovalDecided(approval!.id);
    expect(await h.drive(run.id)).toMatchObject({ status: 'SUCCEEDED' });
    // The readiness verdict is reused after the approval, not re-evaluated.
    expect((await h.store.agentRuns.list({ runId: run.id, role: 'release' })).length).toBe(1);
    expect(h.github.dispatched(repo)).toEqual([{ workflow: 'deploy.yml', ref: 'main' }]);
  });

  it('blocks the deployment when release readiness finds blockers', async () => {
    const h = await harness({ level: 4, profile: { deployWorkflow: 'deploy.yml' } });
    const task = await h.createTask({ title: 'Add search (unready)' });
    const run = (await h.orchestrator.startTask(task.id))!;

    expect(await h.drive(run.id)).toMatchObject({ status: 'BLOCKED' });
    expect((await h.store.runs.get(run.id))!.blockedReason).toContain('changelog entry missing');
    expect(await h.store.approvals.list({ status: 'pending' })).toHaveLength(0);
    expect(h.github.dispatched(repo)).toEqual([]);
  });

  it('includes explicitly requested research for the task in planning, and only then', async () => {
    const h = await harness({ level: 2 });
    const task = await h.createTask();
    const research = await runResearch({ ...h.store, runtime: (h.orchestrator as unknown as { deps: { runtime: AgentRuntime } }).deps.runtime }, { projectId: h.project.id, question: 'How to speed up search?', taskId: task.id });
    expect(research).toMatchObject({ ok: true });
    expect(h.eventTypes()).toContain('research.completed');

    const run = (await h.orchestrator.startTask(task.id))!;
    await h.drive(run.id);
    const planPrompts = (await h.store.agentRuns.list({ runId: run.id, role: 'planner' })).length;
    expect(planPrompts).toBe(1);
    expect(lastPrompts.plan_output).toContain('Postgres trigram indexes');

    const other = await h.createTask({ title: 'Another feature' });
    await h.drive((await h.orchestrator.startTask(other.id))!.id);
    expect(lastPrompts.plan_output).not.toContain('Research notes');
  });
});
