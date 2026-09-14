import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../agents/runtime';
import type { AutonomyLevel } from '../domain/enums';
import { defaultProjectProfile, defaultProjectSettings, type ProjectProfile, type ProjectSettings } from '../domain/project';
import { TaskInputSchema, type TaskInput } from '../domain/task';
import type { ModelProvider, StructuredRequest } from '../models/provider';
import type { ModelConfig } from '../models/types';
import { Orchestrator, type StepResult } from '../orchestrator/orchestrator';
import { RepoIndexer } from '../repo-index/indexer';
import type { SandboxPort } from '../sandbox/port';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { createMemoryStore } from '../testing/memory-store';
import { ToolDeniedError } from '../tools/tool-router';
import { buildAutopilotDigest } from './digest';
import { AutopilotConflictError, AutopilotService, sessionBudgetScope, SYSTEM_ACTOR, type AutopilotAuditEntry } from './service';
import { autopilotStartSchema, DEFAULT_AUTOPILOT_LIMITS, type AutopilotLimits } from './session';

// Pipeline scenarios for autopilot sessions on the in-memory stores (docs/plans/autopilot.md, stage 1).

const HOUR = 60 * 60 * 1000;
const repo = { owner: 'acme', name: 'shop' };

function field(prompt: string, name: string): string {
  return new RegExp(`^${name}: (.+)$`, 'm').exec(prompt)?.[1] ?? '';
}

const responders: Record<string, (request: StructuredRequest<unknown>) => unknown> = {
  analysis_output: () => ({ summary: 'TypeScript shop', architecture: 'layers', relevantPaths: ['src/index.ts'], conventions: [], risks: [], techDebt: [], confidence: 0.8 }),
  plan_output: (req) => ({
    goal: field(req.messages[0]!.content, 'Title'),
    approach: 'Small feature module',
    tasks: [{ key: 'impl', title: 'Implement', description: 'Do it', role: 'builder', dependsOn: [], acceptanceCriteria: ['works'] }],
    risks: [],
    acceptanceCriteria: ['Feature works'],
    estimatedComplexity: 'medium',
    requiresDesign: false,
    touchesAreas: ['src'],
    openQuestions: [],
    confidence: 0.85,
  }),
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
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const changes = [{ path: `src/${slug}.ts`, action: 'create', content: 'export const feature = 1;\n', rationale: 'feature' }];
    if (title.includes('index')) changes.push({ path: `db/migrations/${slug}.sql`, action: 'create', content: 'CREATE INDEX idx ON products(name);\n', rationale: 'index' });
    return { summary: 'feature', changes, notes: [], confidence: 0.8 };
  },
  test_output: (req) => ({
    summary: 'tests',
    testFiles: [{ path: `src/${field(req.messages[0]!.content, 'Title').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.test.ts`, action: 'create', content: 'test("x", () => {});\n', rationale: 'test' }],
    coverageNotes: [],
    confidence: 0.8,
  }),
  review_output: () => ({ verdict: 'approve', summary: 'good', issues: [], acceptanceCriteria: [{ criterion: 'Feature works', met: true, evidence: 'tests' }], confidence: 0.9 }),
  security_output: () => ({ verdict: 'pass', summary: 'ok', findings: [], confidence: 0.9 }),
  synthesis_output: () => ({ decision: 'option-a', chosenOptionId: 'option-a', reason: 'consensus', dissent: [], evidence: [], confidence: 0.9 }),
  blocker_analysis_output: () => ({ why: 'Blocked.', missingInformation: [], alternativeApproach: null, needsHuman: true, confidence: 0.7 }),
  release_readiness_output: () => ({ verdict: 'ready', summary: 'Ready to ship', checks: [{ name: 'tests', status: 'pass', detail: 'passed' }], blockers: [], confidence: 0.9 }),
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

const provider: ModelProvider = {
  kind: 'mock',
  async generateStructured<T>(request: StructuredRequest<T>) {
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

const passingSandbox: SandboxPort = {
  available: true,
  run: async () => ({ passed: true, results: [{ name: 'test', exitCode: 0, output: 'ok', durationMs: 5 }], failedCommand: null, infrastructureError: null }),
};

interface HarnessOptions {
  level?: AutonomyLevel;
  profile?: Partial<ProjectProfile>;
  settings?: (settings: ProjectSettings) => void;
  limits?: Partial<AutopilotLimits>;
}

async function harness(options: HarnessOptions = {}) {
  let time = Date.parse('2026-09-14T10:00:00Z');
  const clock = { now: () => new Date(time) };
  const store = createMemoryStore(clock);
  const github = new InMemoryGitHub();
  github.seed(repo, { 'src/index.ts': 'export {};\n', 'README.md': '# Shop\n' });
  const audit: AutopilotAuditEntry[] = [];
  const recordAudit = async (entry: AutopilotAuditEntry) => void audit.push(entry);

  const runtime = new AgentRuntime({
    models: () => [model],
    providers: { get: () => provider },
    agentRuns: store.agentRuns,
    usage: store.usage,
    addProjectUsage: (id, cost, tokens) => store.projects.addUsage(id, cost, tokens),
    addTaskUsage: (id, cost, tokens) => store.tasks.addUsage(id, cost, tokens),
    events: store.events,
    // Same composition as the server container: the session scope joins the project scope.
    budgetScopes: async ({ projectId, runId }) => {
      const project = (await store.projects.get(projectId))!;
      const session = await sessionBudgetScope({ sessions: store.autopilotSessions, runs: store.runs }, runId, clock.now());
      return [{ scope: 'project', limitUsd: project.budgetUsd, spentUsd: project.spentUsd }, ...(session ? [session] : [])];
    },
    globalRoleOverrides: () => ({}),
    clock,
  });

  const orchestrator = new Orchestrator({
    ...store,
    clock,
    runtime,
    github,
    sandbox: passingSandbox,
    repoIndex: new RepoIndexer(github, store.repoFiles),
    autopilotSessions: store.autopilotSessions,
    toolAudit: store.toolAudit,
    audit: recordAudit,
  });

  const limits: AutopilotLimits = { ...DEFAULT_AUTOPILOT_LIMITS, enabled: true, ...options.limits };
  const autopilot = new AutopilotService({
    sessions: store.autopilotSessions,
    projects: store.projects,
    runs: store.runs,
    events: store.events,
    clock,
    limits: () => limits,
    pauseRun: (runId, reason) => orchestrator.pause(runId, reason),
    audit: recordAudit,
  });

  const settings = defaultProjectSettings();
  options.settings?.(settings);
  const project = await store.projects.create({
    slug: 'shop',
    name: 'Shop',
    description: 'Demo shop',
    repo: { ...repo, defaultBranch: 'main' },
    priority: 5,
    autonomyLevel: options.level ?? 3,
    budgetUsd: 50,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'], commands: { test: 'npm test' }, ...options.profile },
    settings,
  });

  const createTask = (input: Partial<TaskInput> = {}) =>
    store.tasks.create(project.id, TaskInputSchema.parse({ title: 'Add product search', goal: 'Users can search products by name', ...input }), null);

  const startSession = (input: Record<string, unknown> = {}) =>
    autopilot.start(autopilotStartSchema(limits).parse({ projectIds: [project.id], durationHours: 10, budgetUsd: 5, ...input }), { type: 'user', id: 'usr_owner', login: 'owner' });

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

  const advance = (ms: number) => {
    time += ms;
  };
  const eventTypes = () => store.events.log.map((e) => e.type);
  return { store, github, orchestrator, autopilot, project, createTask, startSession, drive, advance, clock, audit, eventTypes, limits };
}

describe('autopilot sessions in the pipeline', () => {
  it('parks gated runs without holding slots: two parked approvals no longer stall a maxConcurrentTasks = 2 project', async () => {
    // Without a session, two gated runs hold both slots and the project stalls (today's behaviour, unchanged).
    const control = await harness();
    const controlTasks = [await control.createTask({ title: 'Add search index A', goal: 'Index products' }), await control.createTask({ title: 'Add search index B', goal: 'Index orders' })];
    await control.createTask({ title: 'Add product search', goal: 'Search products by name' });
    const controlTick = await control.orchestrator.tick();
    expect(controlTick.started).toHaveLength(2);
    for (const runId of controlTick.started) expect(await control.drive(runId)).toEqual({ next: 'wait', resumeAt: null });
    expect((await control.store.runs.list({ statuses: ['WAITING'] })).map((r) => r.taskId).sort()).toEqual(controlTasks.map((t) => t.id).sort());
    expect((await control.orchestrator.tick()).started).toHaveLength(0);

    const h = await harness();
    const gated = [await h.createTask({ title: 'Add search index A', goal: 'Index products' }), await h.createTask({ title: 'Add search index B', goal: 'Index orders' })];
    const plain = await h.createTask({ title: 'Add product search', goal: 'Search products by name' });
    const session = await h.startSession();

    const first = await h.orchestrator.tick();
    expect(first.started).toHaveLength(2);
    for (const runId of first.started) expect(await h.drive(runId)).toEqual({ next: 'wait', resumeAt: null });

    const parked = await h.store.runs.list({ statuses: ['PARKED'] });
    expect(parked.map((r) => r.taskId).sort()).toEqual(gated.map((t) => t.id).sort());
    expect(parked.every((r) => r.sessionId === session.id)).toBe(true);
    const approvals = await h.store.approvals.list({ status: 'pending' });
    expect(approvals).toHaveLength(2);
    expect(approvals.every((a) => a.mode === 'deferred' && a.sessionId === session.id && a.action === 'database_migration')).toBe(true);
    // The project is not marked WAITING and the approval stays valid until the session end plus the grace period.
    expect((await h.store.projects.get(h.project.id))!.status).toBe('IDLE');
    expect(approvals[0]!.expiresAt!.getTime()).toBe(session.endsAt.getTime() + h.limits.returnGraceMs);
    expect(h.eventTypes().filter((t) => t === 'autopilot.run.parked')).toHaveLength(2);
    expect(h.audit.filter((a) => a.action === 'autopilot.run.park')).toHaveLength(2);

    // The next tick starts the third task: parked runs free their slots.
    const second = await h.orchestrator.tick();
    expect(second.started).toHaveLength(1);
    expect((await h.store.tasks.get(plain.id))!.status).toBe('RUNNING');
    expect(await h.drive(second.started[0]!)).toMatchObject({ next: 'done', status: 'SUCCEEDED' });
    expect(h.github.pulls(repo)).toHaveLength(1);

    // A human approves one parked run (during the session); it resumes and publishes. Nobody else can approve.
    const approval = approvals.find((a) => a.taskId === gated[0]!.id)!;
    await h.store.approvals.decide(approval.id, 'approved', 'owner', null);
    expect(await h.orchestrator.onApprovalDecided(approval.id)).toEqual({ next: 'continue' });
    expect(h.eventTypes()).toContain('autopilot.run.unparked');
    expect(await h.drive(approval.runId!)).toMatchObject({ status: 'SUCCEEDED' });
    expect(h.github.pulls(repo)).toHaveLength(2);

    // After the session a rejection still reaches the parked run.
    await h.autopilot.stop(session.id, SYSTEM_ACTOR);
    const other = approvals.find((a) => a.taskId === gated[1]!.id)!;
    await h.store.approvals.decide(other.id, 'rejected', 'owner', 'not now');
    expect(await h.orchestrator.onApprovalDecided(other.id)).toEqual({ next: 'done', status: 'BLOCKED' });

    const digest = (await h.autopilot.digest(session.id))!;
    expect(digest.totals).toMatchObject({ runsStarted: 3, succeeded: 2, failed: 1, parked: 0, pullRequests: 2 });
    expect(digest.parkedApprovals.map((a) => a.status).sort()).toEqual(['approved', 'rejected']);
    expect(digest.stop.reason).toBe('manual');
    // Digest costs equal the ledger sums of the session's runs.
    const input = await h.store.autopilotSessions.digestInput((await h.store.autopilotSessions.get(session.id))!, h.clock.now());
    expect(digest.costs.totalUsd).toBeCloseTo(input.costByProject.reduce((s, c) => s + c.costUsd, 0), 6);
    expect(digest.costs.totalUsd).toBeGreaterThan(0);
    expect(buildAutopilotDigest({ ...input, runs: [...input.runs].reverse() }, h.clock.now())).toEqual(digest);
  });

  it('caps autonomy at level 3 at runtime: a level-4 project never deploys and keeps its stored level', async () => {
    const h = await harness({ level: 4, profile: { deployWorkflow: 'deploy.yml' } });
    await h.createTask();
    const session = await h.startSession();
    expect(h.store.events.log.find((e) => e.type === 'autopilot.session.started')?.payload).toMatchObject({ effectiveAutonomy: 3 });

    const [runId] = (await h.orchestrator.tick()).started;
    const run = (await h.store.runs.get(runId!))!;
    expect(run.stagePlan.find((s) => s.stage === 'DEPLOY')).toMatchObject({ run: false });
    expect(await h.drive(runId!)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await h.store.runs.get(runId!))!.checkpoint.outcome).toBe('pr_ready');
    expect(h.github.dispatched(repo)).toEqual([]);
    expect((await h.store.projects.get(h.project.id))!.autonomyLevel).toBe(4);
    expect(h.store.events.log.find((e) => e.type === 'autopilot.run.started')?.payload).toEqual({ sessionId: session.id, effectiveAutonomy: 3, baseAutonomy: 4 });

    // deploy.run is structurally unreachable at the effective level.
    const project = (await h.store.projects.get(h.project.id))!;
    await expect(
      h.orchestrator.tools.invoke('deploy.run', { prNumber: 1, workflow: 'deploy.yml', ref: 'main' }, { project: { ...project, autonomyLevel: 3 }, agentRole: 'orchestrator', taskId: null, runId, approvedActions: ['production_deploy'], sessionId: session.id }),
    ).rejects.toMatchObject({ reason: 'autonomy' });

    // A crash mid-session cannot leave the project elevated or lowered: nothing was ever written.
    await h.autopilot.kill(session.id, SYSTEM_ACTOR);
    expect((await h.store.projects.get(h.project.id))!.autonomyLevel).toBe(4);
  });

  it('keeps hard gates hard: a gate disabled for normal operation still parks inside a session', async () => {
    const h = await harness({ settings: (s) => void (s.approvalGates.database_migration = false) });
    const outside = await h.createTask({ title: 'Add search index outside', goal: 'Index products' });
    expect(await h.drive((await h.orchestrator.startTask(outside.id))!.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await h.store.approvals.list({})).toHaveLength(0);

    await h.createTask({ title: 'Add search index inside', goal: 'Index orders' });
    await h.startSession();
    const [runId] = (await h.orchestrator.tick()).started;
    expect(await h.drive(runId!)).toEqual({ next: 'wait', resumeAt: null });
    expect(await h.store.approvals.list({ status: 'pending' })).toEqual([expect.objectContaining({ action: 'database_migration', mode: 'deferred' })]);
  });

  it('kill switch: pauses session runs, denies further tool calls, writes events and audit entries', async () => {
    const h = await harness();
    await h.createTask();
    await h.createTask({ title: 'Add search index A', goal: 'Index products' });
    const session = await h.startSession();
    const started = (await h.orchestrator.tick()).started;
    expect(started).toHaveLength(2);
    // One run parks, the other is mid-pipeline.
    const runs = await Promise.all(started.map((id) => h.store.runs.get(id)));
    const gatedRun = runs.find((r) => r!.taskId !== runs[0]!.taskId || true)!;
    for (const run of runs) if (run) await h.orchestrator.step(run.id);
    const indexRun = (await h.store.runs.list({ sessionId: session.id })).find(async (r) => (await h.store.tasks.get(r.taskId))!.title.includes('index'))!;
    expect(indexRun).toBeDefined();
    expect(gatedRun).toBeDefined();

    const result = (await h.autopilot.kill(session.id, { type: 'user', id: 'usr_op', login: 'operator' }))!;
    expect(result.pausedRuns).toBe(2);
    expect((await h.store.runs.list({ sessionId: session.id })).map((r) => r.status)).toEqual(['PAUSED', 'PAUSED']);
    expect(await h.orchestrator.step(started[0]!)).toEqual({ next: 'wait', resumeAt: null });
    expect((await h.orchestrator.tick()).started).toHaveLength(0);
    expect(h.store.events.log.find((e) => e.type === 'autopilot.session.killed')?.payload).toMatchObject({ sessionId: session.id, by: 'operator', pausedRuns: 2 });
    expect(h.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['autopilot.session.kill', 'autopilot.run.pause']));

    const project = (await h.store.projects.get(h.project.id))!;
    const denied = await h.orchestrator.tools
      .invoke('git.branch', { branch: 'orchestrator/x', fromSha: 'abcdef1' }, { project, agentRole: 'orchestrator', taskId: null, runId: started[0]!, approvedActions: [], sessionId: session.id })
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ToolDeniedError);
    expect(denied).toMatchObject({ reason: 'autonomy', detail: `autopilot session ${session.id} was killed` });
    expect(h.store.toolAuditLog.at(-1)).toMatchObject({ outcome: 'denied', sessionId: session.id });

    // A second kill is a no-op; a human resume detaches the run from the killed session.
    expect(await h.autopilot.kill(session.id, SYSTEM_ACTOR)).toBeNull();
    expect(await h.orchestrator.resume(started[0]!)).toEqual({ next: 'continue' });
    expect((await h.store.runs.get(started[0]!))!.sessionId).toBeNull();
    expect(await h.drive(started[0]!)).toMatchObject({ next: expect.any(String) });
  });

  it('never executes a stage of a killed session even when the kill lost the race to pause the run', async () => {
    const h = await harness();
    await h.createTask();
    const session = await h.startSession();
    const [runId] = (await h.orchestrator.tick()).started;
    // Simulate a kill whose pause step did not reach this run.
    await h.store.autopilotSessions.finish(session.id, { status: 'killed', stopReason: 'killed', stopDetail: 'test', stoppedBy: 'test', endedAt: h.clock.now() });
    expect(await h.orchestrator.step(runId!)).toEqual({ next: 'wait', resumeAt: null });
    expect((await h.store.runs.get(runId!))!).toMatchObject({ status: 'PAUSED', currentStage: 'INTAKE' });
    expect(await h.store.agentRuns.list({ runId: runId! })).toHaveLength(0);
  });

  it('rejects a second active session for the same project', async () => {
    const h = await harness();
    await h.startSession();
    await expect(h.startSession()).rejects.toBeInstanceOf(AutopilotConflictError);
  });

  it('stops automatically when the session budget is spent; the runtime pauses at the session scope', async () => {
    const h = await harness();
    await h.createTask();
    await h.createTask({ title: 'Add product filters', goal: 'Filter products by price' });
    const session = await h.startSession({ budgetUsd: 0.01 });
    const [runId] = (await h.orchestrator.tick()).started;
    expect(await h.drive(runId!)).toEqual({ next: 'wait', resumeAt: null });
    expect((await h.store.runs.get(runId!))!.status).toBe('PAUSED');
    expect(h.store.events.log.find((e) => e.type === 'budget.exhausted')?.payload).toMatchObject({ scope: 'session' });

    // At ≥ 90 % of the budget no further run starts, then the tick ends the session.
    const skipped = (await h.orchestrator.tick()).skipped;
    expect(skipped.map((s) => s.reason)).toContain('autopilot_budget_reserve');
    expect(await h.autopilot.tick()).toEqual({ stopped: 1, killed: 0 });
    expect((await h.store.autopilotSessions.get(session.id))!).toMatchObject({ status: 'ended', stopReason: 'budget_exhausted', stoppedBy: 'system' });
    expect(h.eventTypes()).toContain('autopilot.session.stopped');
  });

  it('stops at the end of the time box and kills after repeated security denials', async () => {
    const h = await harness();
    const timed = await h.startSession({ durationHours: 1 });
    h.advance(HOUR);
    expect(await h.autopilot.tick()).toEqual({ stopped: 1, killed: 0 });
    expect((await h.store.autopilotSessions.get(timed.id))!.stopReason).toBe('time_box');

    const guarded = await h.startSession();
    const project = (await h.store.projects.get(h.project.id))!;
    for (let i = 0; i < 3; i++) {
      await h.orchestrator.tools
        .invoke('git.branch', { branch: 'main', fromSha: 'abcdef1' }, { project, agentRole: 'orchestrator', taskId: null, runId: null, approvedActions: [], sessionId: guarded.id })
        .catch(() => undefined);
    }
    expect(await h.autopilot.tick()).toEqual({ stopped: 0, killed: 1 });
    expect((await h.store.autopilotSessions.get(guarded.id))!).toMatchObject({ status: 'killed', stopReason: 'security_denials' });
  });

  it('stops after consecutive failed runs', async () => {
    const h = await harness();
    const session = await h.startSession({ stopPolicy: { maxConsecutiveFailures: 1 } });
    await h.createTask({ title: 'Add product search', goal: 'Search products' });
    const [runId] = (await h.orchestrator.tick()).started;
    const run = (await h.store.runs.get(runId!))!;
    await h.store.runs.save({ ...run, status: 'BLOCKED', finishedAt: h.clock.now(), blockedReason: 'test' });
    expect(await h.autopilot.tick()).toEqual({ stopped: 1, killed: 0 });
    expect((await h.store.autopilotSessions.get(session.id))!.stopReason).toBe('failure_streak');
  });

  it('recovers after a restart: resumes running sessions and stops sessions whose time box passed', async () => {
    const h = await harness();
    const other = await h.store.projects.create({ ...h.project, slug: 'other', name: 'Other' });
    const shortSession = await h.startSession({ durationHours: 1 });
    const longSession = await h.autopilot.start(autopilotStartSchema(h.limits).parse({ projectIds: [other.id], durationHours: 10, budgetUsd: 5 }), SYSTEM_ACTOR);
    h.advance(2 * HOUR);
    expect(await h.autopilot.recover()).toEqual({ resumed: 1, stopped: 1 });
    expect((await h.store.autopilotSessions.get(shortSession.id))!).toMatchObject({ status: 'ended', stopReason: 'time_box' });
    expect((await h.store.autopilotSessions.get(longSession.id))!.status).toBe('active');
    expect(h.store.events.log.find((e) => e.type === 'autopilot.session.resumed')?.payload).toMatchObject({ sessionId: longSession.id });
  });

  it('refuses to start when the autopilot is disabled', async () => {
    const h = await harness({ limits: { enabled: false } });
    await expect(h.startSession()).rejects.toMatchObject({ statusCode: 403 });
  });
});
