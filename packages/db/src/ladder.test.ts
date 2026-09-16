import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decisionRequestFingerprint, defaultProjectProfile, defaultProjectSettings, defaultStopPolicy, DEFAULT_STOP_CONDITIONS, TaskInputSchema } from '@orch/core';
import { DrizzleAutopilotSessionRepository } from './autopilot-repositories';
import { createDatabase, type DatabaseHandle } from './client';
import { createLadderRepositories, type LadderRepositories } from './ladder-repositories';
import { createRepositories, type Repositories } from './repositories';

// Decision ladder and council persistence (autopilot stage 2+3) on PGlite: request dedupe through the partial unique
// index, append-only council turns, single human review of provisional decisions, digest input.

let handle: DatabaseHandle;
let repos: Repositories;
let ladder: LadderRepositories;
let sessions: DrizzleAutopilotSessionRepository;

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  ladder = createLadderRepositories(handle.db);
  sessions = new DrizzleAutopilotSessionRepository(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function fixture(slug: string) {
  const project = await repos.projects.create({
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
  const now = new Date();
  const session = await sessions.create({
    startedBy: 'usr_owner',
    projectIds: [project.id],
    startsAt: new Date(now.getTime() - 60_000),
    endsAt: new Date(now.getTime() + 3_600_000),
    budgetUsd: 5,
    autonomyCeiling: 3,
    maxTaskRisk: 'medium',
    maxConcurrentRuns: null,
    maxParkedRuns: 3,
    quietHours: null,
    stopPolicy: defaultStopPolicy(),
    demo: false,
  });
  const task = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Cache catalog', goal: 'Bounded cache' }), null);
  const run = await repos.runs.create({ taskId: task.id, projectId: project.id, stagePlan: [], limits: DEFAULT_STOP_CONDITIONS, sessionId: session.id });
  return { project, session, task, run };
}

describe('decision ladder repositories (PGlite)', () => {
  it('deduplicates open requests per project and fingerprint, and allows a new one once resolved', async () => {
    const { project, session, task, run } = await fixture('ladder-dedupe');
    const input = {
      projectId: project.id,
      sessionId: session.id,
      taskId: task.id,
      runId: run.id,
      kind: 'design_choice' as const,
      nature: 'judgment' as const,
      question: 'Which cache?',
      options: [{ id: 'proposed', summary: 'LRU', reversibility: 'easy' as const, blastRadius: 'small' as const, estimatedCost: 'low' as const }],
      fingerprint: decisionRequestFingerprint(project.id, 'design_choice', 'Which cache?'),
    };
    const [first, second] = await Promise.all([ladder.decisionRequests.open(input), ladder.decisionRequests.open(input)]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.request.id).toBe(second.request.id);

    const updated = await ladder.decisionRequests.update(first.request.id, {
      status: 'answered',
      rung: 'council',
      trail: [{ rung: 'memory', outcome: 'skipped', detail: 'no precedent', costUsd: 0, at: new Date().toISOString() }],
      answer: { text: 'LRU', chosenOptionId: 'proposed', rationale: 'r', confidence: 0.9, adrRefs: ['ADR-004'], evidence: [], dissent: [], diversity: 'cross_provider', singleProvider: false },
      costUsd: 0.12,
      resolvedAt: new Date(),
    });
    expect(updated).toMatchObject({ status: 'answered', rung: 'council', answer: { diversity: 'cross_provider' }, costUsd: 0.12 });
    expect((await ladder.decisionRequests.open(input)).created).toBe(true);
    expect(await ladder.decisionRequests.list({ sessionId: session.id, statuses: ['answered'] })).toHaveLength(1);
  });

  it('keeps council turns append-only and sums council usage per session', async () => {
    const { project, session, task, run } = await fixture('ladder-council');
    const { request } = await ladder.decisionRequests.open({ projectId: project.id, sessionId: session.id, taskId: task.id, runId: run.id, kind: 'design_choice', nature: 'judgment', question: 'Q?', options: [], fingerprint: 'fp-council' });
    const council = await ladder.councils.create({ requestId: request.id, projectId: project.id, sessionId: session.id, runId: run.id, decisionType: 'design_choice', question: 'Q?', deadlineAt: new Date(Date.now() + 60_000) });
    expect(council).toMatchObject({ status: 'running', protocolVersion: 2, participants: [], roundsUsed: 0 });

    const brief = await ladder.councils.appendTurn({ councilId: council.id, seq: 0, round: 0, kind: 'brief', role: 'orchestrator', stance: 'orchestrator', body: { question: 'Q?' }, modelId: null, provider: null, costUsd: 0, tokens: 0 });
    const rewrite = await ladder.councils.appendTurn({ councilId: council.id, seq: 0, round: 0, kind: 'brief', role: 'orchestrator', stance: 'orchestrator', body: { question: 'rewritten' }, modelId: null, provider: null, costUsd: 0, tokens: 0 });
    expect(rewrite).toEqual(brief);
    await ladder.councils.appendTurn({ councilId: council.id, seq: 1, round: 1, kind: 'proposal', role: 'architect', stance: 'member', body: { ok: true }, modelId: 'anthropic/a', provider: 'anthropic', costUsd: 0.02, tokens: 1200 });
    expect((await ladder.councils.turns(council.id)).map((t) => [t.seq, t.kind, t.body])).toEqual([
      [0, 'brief', { question: 'Q?' }],
      [1, 'proposal', { ok: true }],
    ]);

    await ladder.councils.recordProgress(council.id, { participants: [{ role: 'architect', stance: 'member', modelId: 'anthropic/a', provider: 'anthropic' }], roundsUsed: 1, costUsd: 0.02, tokens: 1200 });
    const finished = await ladder.councils.finish(council.id, { status: 'parked', chosenOptionId: null, confidence: 0, parkReason: 'cost_cap', diversity: 'none', finishedAt: new Date() });
    expect(finished).toMatchObject({ status: 'parked', parkReason: 'cost_cap', roundsUsed: 1 });
    expect(await ladder.councils.finish(council.id, { status: 'decided', chosenOptionId: 'x', confidence: 1, parkReason: null, diversity: 'none', finishedAt: new Date() })).toBeNull();
    expect(await ladder.councils.sessionUsage(session.id)).toEqual({ councils: 1, costUsd: 0.02 });
    expect(await ladder.councils.list({ requestId: request.id })).toHaveLength(1);
  });

  it('reviews a provisional decision exactly once, never reuses a rejected one and includes it in the digest input', async () => {
    const { project, session, task, run } = await fixture('ladder-review');
    const base = {
      projectId: project.id,
      taskId: task.id,
      runId: null,
      question: 'Which cache?',
      questionKey: 'qk-cache',
      options: [],
      consulted: [],
      evidence: [],
      decision: 'LRU',
      chosenOptionId: 'lru',
      reason: 'council',
      confidence: 0.9,
      costUsd: 0.1,
      supersedesId: null,
    };
    const pipeline = await repos.decisions.create(base);
    expect(pipeline).toMatchObject({ origin: 'pipeline', status: 'active', adrRefs: [], sessionId: null });
    const provisional = await repos.decisions.create({ ...base, origin: 'autopilot_council', status: 'provisional', sessionId: session.id, adrRefs: ['ADR-004'] });
    expect(await repos.decisions.findByQuestionKey(project.id, 'qk-cache')).toMatchObject({ id: provisional.id });

    const at = new Date();
    const [a, b] = await Promise.all([
      repos.decisions.review(provisional.id, { status: 'rejected', reviewedBy: 'owner', comment: 'not now', at }),
      repos.decisions.review(provisional.id, { status: 'confirmed', reviewedBy: 'admin', comment: null, at }),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(await repos.decisions.review(pipeline.id, { status: 'confirmed', reviewedBy: 'owner', comment: null, at })).toBeNull();

    const reviewed = (await repos.decisions.get(provisional.id))!;
    if (reviewed.status === 'rejected') {
      expect(await repos.decisions.findByQuestionKey(project.id, 'qk-cache')).toMatchObject({ id: pipeline.id });
    }
    expect(await repos.decisions.list({ sessionId: session.id, statuses: [reviewed.status] })).toHaveLength(1);

    // The digest input picks up decisions by session (even without a run) and the session's requests.
    await ladder.decisionRequests.open({ projectId: project.id, sessionId: session.id, taskId: task.id, runId: run.id, kind: 'design_choice', nature: 'judgment', question: 'Which cache?', options: [], fingerprint: 'fp-digest' });
    const input = await sessions.digestInput(session);
    expect(input.decisions.map((d) => d.id)).toEqual([provisional.id]);
    expect(input.decisionRequests.map((r) => r.fingerprint)).toEqual(['fp-digest']);
  });
});
