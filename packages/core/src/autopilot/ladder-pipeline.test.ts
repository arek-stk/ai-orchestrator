import { describe, expect, it } from 'vitest';
import { defaultProjectProfile, defaultProjectSettings } from '../domain/project';
import { TaskInputSchema } from '../domain/task';
import { Orchestrator, type StepResult } from '../orchestrator/orchestrator';
import { RepoIndexer } from '../repo-index/indexer';
import { RoomService } from '../room/service';
import type { SandboxPort } from '../sandbox/port';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { createMemoryConversationStore } from '../testing/memory-conversations';
import { createMemoryStore } from '../testing/memory-store';
import { scriptedModel, scriptedWorld, type ScriptedCall } from '../testing/scripted-provider';
import { CouncilRoomPublisher } from './council-room';
import { AutopilotService, sessionBudgetScope, type AutopilotAuditEntry } from './service';
import { autopilotStartSchema, DEFAULT_AUTOPILOT_LIMITS } from './session';

// DESIGN inside an autopilot session climbs the decision ladder (docs/plans/autopilot.md stage 2+3): provisional
// decisions for the digest, council threads in the Project Room, council spend on the session budget, parked
// questions as deferred approvals that only a human can decide.

const repo = { owner: 'acme', name: 'shop' };
const CACHE_TS = 'export const cache = new Map<string, string>();\n// entries are never evicted\n';
const DECISIONS_MD = '# ADRs\n\n## ADR-004 — Durable DB-backed job queue\n* **Decision:** Background work runs through the PostgreSQL job queue with leases.\n* **Status:** Accepted (2026-09-10)\n';

const option = (id: string, summary: string, reversibility: 'easy' | 'moderate' | 'hard' = 'easy') => ({ id, summary, reversibility, blastRadius: 'small', estimatedCost: 'low' });

function pipelineScript(): Record<string, (call: ScriptedCall) => unknown> {
  const title = (call: ScriptedCall) => /^Title: (.+)$/m.exec(call.prompt)?.[1] ?? 'task';
  const slug = (call: ScriptedCall) => title(call).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    analysis_output: () => ({ summary: 'shop', architecture: 'layers', relevantPaths: ['src/cache.ts'], conventions: [], risks: [], techDebt: [], confidence: 0.8 }),
    plan_output: (call) => ({
      goal: title(call),
      approach: 'Add an LRU eviction to the catalog cache',
      tasks: [{ key: 'impl', title: 'Implement', description: 'Do it', role: 'builder', dependsOn: [], acceptanceCriteria: ['works'] }],
      risks: [],
      acceptanceCriteria: ['Cache evicts old entries'],
      estimatedComplexity: 'complex',
      requiresDesign: true,
      touchesAreas: ['src/cache.ts'],
      openQuestions: [],
      confidence: 0.85,
    }),
    precedent_check_output: () => ({ verdict: 'not_applicable', precedentRef: null, quote: null, answer: '', rationale: 'no precedent', confidence: 0.6 }),
    decision_research_output: () => ({ answer: 'The cache is a plain Map.', settled: false, citations: [{ path: 'src/cache.ts', quote: 'export const cache = new Map<string, string>();', supports: 'current cache' }], limitations: ['design judgment'], confidence: 0.6 }),
    council_proposal_output: (call) => ({
      options: [option('lru-map', 'Wrap the Map in a small LRU'), option('external-cache', 'Introduce an external cache service', 'hard')],
      recommendedOptionId: 'lru-map',
      claims: [{ optionId: 'lru-map', text: `${call.role}: the Map is the only cache`, evidence: [{ type: 'file', ref: 'src/cache.ts', quote: 'export const cache = new Map<string, string>();' }] }],
      assumptions: [],
      confidence: 0.85,
    }),
    council_critique_output: () => ({ objections: [], confidence: 0.6 }),
    council_vote_output: () => ({ responses: [], optionId: 'lru-map', changedBecause: null, confidence: 0.85 }),
    build_output: (call) => ({ summary: 'lru', changes: [{ path: `src/${slug(call)}.ts`, action: 'create', content: 'export const lru = 1;\n', rationale: 'lru' }], notes: [], confidence: 0.8 }),
    test_output: (call) => ({ summary: 'tests', testFiles: [{ path: `src/${slug(call)}.test.ts`, action: 'create', content: 'test("x", () => {});\n', rationale: 't' }], coverageNotes: [], confidence: 0.8 }),
    review_output: () => ({ verdict: 'approve', summary: 'ok', issues: [], acceptanceCriteria: [], confidence: 0.9 }),
    security_output: () => ({ verdict: 'pass', summary: 'ok', findings: [], confidence: 0.9 }),
    blocker_analysis_output: () => ({ why: 'blocked', missingInformation: [], alternativeApproach: null, needsHuman: true, confidence: 0.7 }),
  };
}

const passingSandbox: SandboxPort = {
  available: true,
  run: async () => ({ passed: true, results: [{ name: 'test', exitCode: 0, output: 'ok', durationMs: 5 }], failedCommand: null, infrastructureError: null }),
};

async function harness() {
  let time = Date.parse('2026-09-16T10:00:00Z');
  const clock = { now: () => new Date(time) };
  const store = createMemoryStore(clock);
  const github = new InMemoryGitHub();
  github.seed(repo, { 'src/index.ts': 'export {};\n', 'src/cache.ts': CACHE_TS, 'docs/DECISIONS.md': DECISIONS_MD, 'README.md': '# Shop\n' });
  const conversations = createMemoryConversationStore(clock);
  const room = new RoomService({ ...conversations, events: store.events });
  const audit: AutopilotAuditEntry[] = [];
  const models = [scriptedModel('anthropic/a', 'anthropic', { pricing: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: null, cacheWritePerMTok: null } }), scriptedModel('openai/b', 'openai')];
  const world = scriptedWorld(store, clock, models, pipelineScript(), {
    budgetScopes: async ({ runId }) => {
      const session = await sessionBudgetScope({ sessions: store.autopilotSessions, runs: store.runs }, runId, clock.now());
      return session ? [session] : [];
    },
  });
  const orchestrator = new Orchestrator({
    ...store,
    clock,
    runtime: world.runtime,
    github,
    sandbox: passingSandbox,
    repoIndex: new RepoIndexer(github, store.repoFiles),
    autopilotSessions: store.autopilotSessions,
    toolAudit: store.toolAudit,
    audit: async (entry) => void audit.push(entry),
    decisionLadder: { requests: store.decisionRequests, councils: store.councils, sink: new CouncilRoomPublisher(room) },
  });
  const limits = { ...DEFAULT_AUTOPILOT_LIMITS, enabled: true };
  const autopilot = new AutopilotService({
    sessions: store.autopilotSessions,
    projects: store.projects,
    runs: store.runs,
    events: store.events,
    clock,
    limits: () => limits,
    pauseRun: (runId, reason) => orchestrator.pause(runId, reason),
    audit: async (entry) => void audit.push(entry),
    decisions: store.decisions,
  });
  const project = await store.projects.create({
    slug: 'shop',
    name: 'Shop',
    description: 'Demo shop',
    repo: { ...repo, defaultBranch: 'main' },
    priority: 5,
    autonomyLevel: 3,
    budgetUsd: 50,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'], commands: { test: 'npm test' } },
    settings: defaultProjectSettings(),
  });
  const task = await store.tasks.create(project.id, TaskInputSchema.parse({ title: 'Evict catalog cache entries', goal: 'The catalog cache stays bounded', kind: 'feature', estimatedComplexity: 'complex' }), null);
  const session = await autopilot.start(autopilotStartSchema(limits).parse({ projectIds: [project.id], durationHours: 10, budgetUsd: 5 }), { type: 'user', id: 'usr_owner', login: 'owner' });

  async function drive(runId: string): Promise<StepResult> {
    for (let i = 0; i < 200; i++) {
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
  return { store, github, world, orchestrator, autopilot, project, task, session, drive, audit, conversations };
}

describe('decision ladder in the pipeline (autopilot session)', () => {
  it('settles DESIGN through the council as a provisional decision, posts the thread, bills the session and lets a human reject it', async () => {
    const h = await harness();
    const [runId] = (await h.orchestrator.tick()).started;
    expect(await h.drive(runId!)).toMatchObject({ next: 'done', status: 'SUCCEEDED' });

    const [request] = await h.store.decisionRequests.list({ sessionId: h.session.id });
    expect(request).toMatchObject({ kind: 'design_choice', status: 'answered', rung: 'council', runId });
    expect(request!.trail.map((s) => [s.rung, s.outcome])).toEqual([
      // ADR-004 (job queue) shares no keywords with a cache question: no precedent, no model call.
      ['memory', 'skipped'],
      ['research', 'escalated'],
      ['council', 'answered'],
    ]);
    const decision = (await h.store.decisions.get(request!.decisionId!))!;
    expect(decision).toMatchObject({ origin: 'autopilot_council', status: 'provisional', sessionId: h.session.id, requestId: request!.id, chosenOptionId: 'lru-map' });
    expect((await h.store.runs.get(runId!))!.checkpoint.designDecisionId).toBe(decision.id);

    // The council's agent calls are ledger entries of the session run: they count against the session budget.
    const [council] = await h.store.councils.list({ requestId: request!.id });
    expect(council).toMatchObject({ status: 'decided', diversity: 'cross_provider' });
    expect(council!.costUsd).toBeGreaterThan(0);
    const spent = await h.store.autopilotSessions.spentUsd(h.session, new Date());
    expect(spent).toBeGreaterThanOrEqual(council!.costUsd);
    expect(request!.costUsd).toBeGreaterThanOrEqual(council!.costUsd);

    // Visibility: the council transcript is one thread in the project room.
    const messages = h.conversations.messages.all();
    const root = messages.find((m) => m.threadId === null && m.body.startsWith('Council convened'))!;
    expect(root).toBeDefined();
    expect(messages.filter((m) => m.threadId === root.id).at(-1)).toMatchObject({ intent: 'decision' });

    const digest = (await h.autopilot.digest(h.session.id))!;
    expect(digest.totals).toMatchObject({ decisions: 1, decisionsToReview: 1, questionsParked: 0 });
    expect(digest.decisions[0]).toMatchObject({ decisionId: decision.id, status: 'provisional', origin: 'autopilot_council', diversity: 'cross_provider', singleProvider: false });
    expect(digest.questions[0]).toMatchObject({ requestId: request!.id, status: 'answered', rung: 'council' });
    expect(digest.costs.decisionsUsd).toBeGreaterThan(0);

    // The human rejects it in the digest; it cannot be reviewed twice and is never reused.
    const actor = { type: 'user' as const, id: 'usr_owner', login: 'owner' };
    const rejected = await h.autopilot.reviewDecision(decision.id, 'rejected', actor, 'We want an external cache later');
    expect(rejected).toMatchObject({ ok: true, decision: { status: 'rejected', reviewedBy: 'owner', reviewComment: 'We want an external cache later' } });
    expect(await h.autopilot.reviewDecision(decision.id, 'confirmed', actor, null)).toMatchObject({ ok: false, status: 409 });
    expect(await h.autopilot.reviewDecision('dec_missing', 'confirmed', actor, null)).toMatchObject({ ok: false, status: 404 });
    expect(await h.store.decisions.findByQuestionKey(h.project.id, decision.questionKey)).toBeNull();
    expect(h.store.events.log.some((e) => e.type === 'decision.reviewed')).toBe(true);
    expect(h.audit.find((a) => a.action === 'autopilot.decision.reject')).toMatchObject({ target: decision.id, details: { withComment: true } });
    expect((await h.autopilot.digest(h.session.id))!.totals.decisionsToReview).toBe(0);
  });

  it('parks a design question with an unrebutted verified blocking objection; only a human approval lets the run continue', async () => {
    const h = await harness();
    h.world.script.council_critique_output = () => ({
      objections: [
        { id: 'obj-evict', targetOptionId: 'lru-map', severity: 'blocking', kind: 'risk', claim: 'Eviction breaks callers relying on stable entries', evidence: [{ type: 'file', ref: 'src/cache.ts', quote: 'entries are never evicted' }], falsifier: null },
      ],
      confidence: 0.7,
    });
    const [runId] = (await h.orchestrator.tick()).started;
    expect(await h.drive(runId!)).toEqual({ next: 'wait', resumeAt: null });

    const run = (await h.store.runs.get(runId!))!;
    expect(run.status).toBe('PARKED');
    const [approval] = await h.store.approvals.list({ status: 'pending' });
    expect(approval).toMatchObject({ action: 'architecture_change', mode: 'deferred', sessionId: h.session.id });
    const [request] = await h.store.decisionRequests.list({ sessionId: h.session.id });
    expect(request).toMatchObject({ status: 'parked', parkReason: 'council_blocking_objection', approvalId: approval!.id, advisory: { leadingOptionId: 'lru-map' } });
    expect(approval!.details).toMatchObject({ decisionRequestId: request!.id, parkReason: 'council_blocking_objection' });
    // Nothing was decided or approved by the council.
    expect(await h.store.decisions.list({ sessionId: h.session.id })).toEqual([]);
    expect((await h.autopilot.digest(h.session.id))!.totals).toMatchObject({ questionsParked: 1, decisionsToReview: 0 });

    await h.store.approvals.decide(approval!.id, 'approved', 'owner', 'LRU is fine, callers copy entries');
    expect(await h.orchestrator.onApprovalDecided(approval!.id)).toEqual({ next: 'continue' });
    expect(await h.drive(runId!)).toMatchObject({ next: 'done', status: 'SUCCEEDED' });
    const answered = (await h.store.decisionRequests.get(request!.id))!;
    expect(answered).toMatchObject({ status: 'answered_by_human', rung: 'human' });
    expect(await h.store.decisions.get(answered.decisionId!)).toMatchObject({ origin: 'human', status: 'active', chosenOptionId: 'lru-map' });
    // The ladder did not run again after the human decision.
    expect(h.world.calls.filter((c) => c.schemaName === 'council_critique_output')).toHaveLength(1);
  });
});
