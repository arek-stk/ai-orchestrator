import { describe, expect, it } from 'vitest';
import type { CouncilOption } from '../agents/schemas';
import { DEFAULT_DECISION_PROVENANCE, type Decision } from '../domain/records';
import { createMemoryStore } from '../testing/memory-store';
import { scriptedModel, scriptedWorld, type ScriptedCall } from '../testing/scripted-provider';
import { DEFAULT_COUNCIL_RULE } from './council-protocol';
import { verifyEvidence, type EvidenceSources } from './evidence';
import { DecisionLadder, decisionRequestFingerprint, DEFAULT_LADDER_SETTINGS, nextRung, type DecisionNature, type LadderContext, type LadderStep } from './ladder';
import { buildPrecedents, parseAdrSections, proposesAdrChange, quoteAppearsIn, retrievePrecedents } from './precedents';

// The decision ladder (docs/plans/autopilot.md §3, §9.6 stage 2) over deterministic scripted models.

const DECISIONS_MD = `# Architecture Decision Records

## ADR-004 — Durable DB-backed job queue + checkpointed pipeline state machine (Temporal deferred)
* **Decision:** Background work runs through the PostgreSQL job queue with leases; no external broker such as Redis or Temporal.
* **Status:** Accepted (2026-09-10)

## ADR-009 — Secrets encrypted at rest (AES-256-GCM), never in model context
* **Decision:** Secrets are encrypted with AES-256-GCM.
* **Status:** Superseded by ADR-099

## ADR-030 — Collaboration and planning
* **Decision:** One task system, many views.
* **Status:** Accepted (2026-09-14)

### ADR-004 addendum — queue priorities
* **Decision:** Pipeline steps are claimed before maintenance jobs.
`;

const STATE_MD = '# Build State\n| 4 | Database | done | job queue with SKIP LOCKED, leases, backoff |\n';
const REPO: Record<string, string> = { 'src/queue.ts': 'export class PgJobQueue {\n  // SELECT ... FOR UPDATE SKIP LOCKED\n}\n', 'README.md': '# Shop\n' };

describe('precedents', () => {
  it('parses ADR sections with status and joins addenda to their ADR', () => {
    const adrs = parseAdrSections(DECISIONS_MD);
    expect(adrs.map((a) => [a.id, a.status])).toEqual([
      ['ADR-004', 'accepted'],
      ['ADR-009', 'superseded'],
      ['ADR-030', 'accepted'],
    ]);
    expect(adrs[0]!.text).toContain('Pipeline steps are claimed before maintenance jobs.');
    expect(adrs[2]!.text).not.toContain('queue priorities');
  });

  it('matches quotes whitespace-, case- and emphasis-insensitively but rejects short or absent quotes', () => {
    const text = '* **Decision:** Background work runs through the PostgreSQL job queue with leases.';
    expect(quoteAppearsIn(text, 'Decision: background work runs through the   PostgreSQL job queue')).toBe(true);
    expect(quoteAppearsIn(text, 'the queue')).toBe(false);
    expect(quoteAppearsIn(text, 'Background work runs through Redis streams')).toBe(false);
    expect(quoteAppearsIn(text, null)).toBe(false);
  });

  it('retrieves precedents deterministically by keyword overlap, dropping rejected decisions', () => {
    const decision = (id: string, status: Decision['status']): Decision => ({
      ...DEFAULT_DECISION_PROVENANCE,
      id,
      status,
      projectId: 'prj',
      taskId: null,
      runId: null,
      question: 'Which job queue backend?',
      questionKey: 'k',
      options: [],
      consulted: [],
      evidence: [],
      decision: 'Use Redis for the job queue',
      chosenOptionId: null,
      reason: 'fast',
      confidence: 0.9,
      costUsd: 0,
      supersedesId: null,
      createdAt: new Date(0),
    });
    const precedents = buildPrecedents({ adrs: parseAdrSections(DECISIONS_MD), stateDoc: STATE_MD, decisions: [decision('dec_ok', 'confirmed'), decision('dec_no', 'rejected'), decision('dec_tmp', 'provisional')] });
    expect(precedents.map((p) => p.ref)).not.toContain('decision:dec_no');
    expect(precedents.find((p) => p.ref === 'decision:dec_tmp')?.authoritative).toBe(false);
    const ranked = retrievePrecedents('Should background jobs use a Redis queue instead of the PostgreSQL job queue?', precedents, 3);
    expect(ranked[0]!.ref).toBe('adr:ADR-004');
    expect(retrievePrecedents('Should background jobs use a Redis queue instead of the PostgreSQL job queue?', precedents, 3)).toEqual(ranked);
  });

  it('flags answers that propose changing an ADR (deterministic consistency check)', () => {
    expect(proposesAdrChange('Supersede ADR-004 and move the queue to Redis.')).toMatch(/supersede/);
    expect(proposesAdrChange('We can ignore the ADR here.')).toMatch(/ignore/);
    expect(proposesAdrChange('Address the queue lag by adding an index (consistent with ADR-004).')).toBeNull();
  });
});

describe('evidence verification', () => {
  const sources: EvidenceSources = {
    indexPaths: new Set(Object.keys(REPO)),
    readFile: async (path) => REPO[path] ?? null,
    adrs: new Map(parseAdrSections(DECISIONS_MD).map((a) => [a.id, a])),
    decisions: new Map(),
    stateDoc: STATE_MD,
    checks: new Map([['test', { name: 'test', passed: false, detail: '1 failing' }]]),
  };

  it('verifies paths, quotes, ADR status and executed checks; refutes fabricated quotes and unsafe paths', async () => {
    const results = await verifyEvidence(
      [
        { id: 'e1', item: { type: 'file', ref: 'src/queue.ts', quote: 'FOR UPDATE SKIP LOCKED' } },
        { id: 'e2', item: { type: 'file', ref: 'src/redis.ts', quote: 'new Redis()' } },
        { id: 'e3', item: { type: 'file', ref: 'src/queue.ts', quote: 'import Redis from "ioredis"' } },
        { id: 'e4', item: { type: 'file', ref: '../../etc/passwd', quote: 'root:x:0:0:root' } },
        { id: 'e5', item: { type: 'adr', ref: 'ADR-4', quote: 'no external broker such as Redis or Temporal' } },
        { id: 'e6', item: { type: 'adr', ref: 'ADR-009', quote: 'Secrets are encrypted with AES-256-GCM.' } },
        { id: 'e7', item: { type: 'state', ref: 'docs/STATE.md', quote: 'job queue with SKIP LOCKED' } },
        { id: 'e8', item: { type: 'check', ref: 'test', quote: null } },
        { id: 'e9', item: { type: 'check', ref: 'lint', quote: null } },
      ],
      sources,
    );
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['e1', 'verified'],
      ['e2', 'unverified'],
      ['e3', 'refuted'],
      ['e4', 'refuted'],
      ['e5', 'verified'],
      ['e6', 'unverified'],
      ['e7', 'verified'],
      ['e8', 'verified'],
      ['e9', 'unverified'],
    ]);
    expect(results[7]).toMatchObject({ passed: false });
  });
});

describe('ladder routing (pure)', () => {
  const step = (rung: LadderStep['rung'], outcome: LadderStep['outcome']): LadderStep => ({ rung, outcome, detail: '', costUsd: 0, at: '' });

  it('climbs memory → research → council → human, stops on an answer and parks on conflicts', () => {
    const judgment: { nature: DecisionNature } = { nature: 'judgment' };
    const factual: { nature: DecisionNature } = { nature: 'factual' };
    expect(nextRung(judgment, [])).toBe('memory');
    expect(nextRung(judgment, [step('memory', 'not_applicable')])).toBe('research');
    expect(nextRung(judgment, [step('memory', 'skipped'), step('research', 'escalated')])).toBe('council');
    expect(nextRung(judgment, [step('memory', 'skipped'), step('research', 'escalated'), step('council', 'parked')])).toBe('human');
    expect(nextRung(factual, [step('memory', 'skipped'), step('research', 'escalated')])).toBe('human');
    expect(nextRung(judgment, [step('memory', 'answered')])).toBe('done');
    expect(nextRung(judgment, [step('memory', 'conflict')])).toBe('human');
  });
});

// ---------------------------------------------------------------------------
// Ladder over scripted models
// ---------------------------------------------------------------------------

const seed: CouncilOption = { id: 'proposed', summary: 'Keep the PostgreSQL job queue', reversibility: 'moderate', blastRadius: 'medium', estimatedCost: 'medium' };

type Script = Record<string, (call: ScriptedCall) => unknown>;

const notApplicable = { verdict: 'not_applicable', precedentRef: null, quote: null, answer: '', rationale: 'none', confidence: 0.5 };

function ladderHarness(script: Script, options: { nature?: DecisionNature; question?: string; models?: ReturnType<typeof scriptedModel>[] } = {}) {
  const time = Date.parse('2026-09-16T10:00:00Z');
  const clock = { now: () => new Date(time) };
  const store = createMemoryStore(clock);
  const models = options.models ?? [scriptedModel('anthropic/a', 'anthropic', { pricing: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: null, cacheWritePerMTok: null } }), scriptedModel('openai/b', 'openai')];
  const world = scriptedWorld(store, clock, models, {
    precedent_check_output: () => notApplicable,
    decision_research_output: () => ({ answer: 'unclear', settled: false, citations: [], limitations: ['judgment call'], confidence: 0.4 }),
    council_proposal_output: () => ({ options: [seed], recommendedOptionId: 'proposed', claims: [{ optionId: 'proposed', text: 'the queue exists', evidence: [{ type: 'file', ref: 'src/queue.ts', quote: 'FOR UPDATE SKIP LOCKED' }] }], assumptions: [], confidence: 0.8 }),
    council_critique_output: () => ({ objections: [], confidence: 0.6 }),
    council_vote_output: () => ({ responses: [], optionId: 'proposed', changedBecause: null, confidence: 0.8 }),
    ...script,
  });
  const adrs = parseAdrSections(DECISIONS_MD);
  const evidence: EvidenceSources = { indexPaths: new Set(Object.keys(REPO)), readFile: async (path) => REPO[path] ?? null, adrs: new Map(adrs.map((a) => [a.id, a])), decisions: new Map(), stateDoc: STATE_MD, checks: new Map() };
  const ladder = new DecisionLadder({ runtime: world.runtime, requests: store.decisionRequests, councils: store.councils, clock, events: store.events });
  const question = options.question ?? 'Should background jobs move from the PostgreSQL job queue to a Redis queue?';

  async function resolve(overrides: Partial<LadderContext> = {}) {
    const nature = options.nature ?? 'judgment';
    const { request } = await store.decisionRequests.open({
      projectId: 'prj_1',
      sessionId: 'aps_1',
      taskId: null,
      runId: null,
      kind: 'design_choice',
      nature,
      question,
      options: [seed],
      fingerprint: decisionRequestFingerprint('prj_1', 'design_choice', question),
    });
    return ladder.resolve({
      request,
      session: { id: 'aps_1', budgetUsd: 10 },
      agent: {
        baseInput: { project: { name: 'Shop', description: '', languages: ['TypeScript'] }, task: { title: 'Queue', goal: 'Jobs', kind: 'feature', risk: 'medium', estimatedComplexity: 'medium', acceptanceCriteria: [] }, sections: [], files: [] },
        scope: { projectId: 'prj_1', taskId: null, runId: null },
        complexity: 'medium',
        risk: 'medium',
      },
      precedents: buildPrecedents({ adrs, stateDoc: STATE_MD, decisions: [] }),
      evidence,
      researchFiles: Object.entries(REPO).map(([path, content]) => ({ path, mode: 'full', content, tokens: 10, reasons: [] })),
      members: ['architect', 'backend', 'reviewer'],
      council: { maxRounds: 2, maxTokens: 1_000_000, timeoutMs: 600_000, confidenceThreshold: 0.8 },
      settings: DEFAULT_LADDER_SETTINGS,
      runBudgetRemainingUsd: null,
      allowedChecks: [],
      policyPark: null,
      ...overrides,
    });
  }
  const schemas = () => world.calls.map((c) => c.schemaName);
  return { store, world, resolve, schemas };
}

describe('decision ladder', () => {
  it('answers from a verified accepted ADR at rung (a) without any research or council cost', async () => {
    const h = ladderHarness({
      precedent_check_output: () => ({ verdict: 'applies', precedentRef: 'adr:ADR-004', quote: 'Background work runs through the PostgreSQL job queue with leases', answer: 'Keep the PostgreSQL job queue.', rationale: 'ADR-004 decides it', confidence: 0.9 }),
    });
    const result = await h.resolve();
    expect(result).toMatchObject({ kind: 'answered', rung: 'memory', answer: { adrRefs: ['ADR-004'], chosenOptionId: null } });
    expect(h.schemas()).toEqual(['precedent_check_output']);
    expect((await h.store.councils.list({})).length).toBe(0);
    expect(result.request).toMatchObject({ status: 'answered', rung: 'memory' });
    expect(result.request.trail.map((s) => [s.rung, s.outcome])).toEqual([['memory', 'answered']]);
  });

  it('does not accept a precedent whose quote is fabricated or whose ADR is superseded', async () => {
    const fabricated = ladderHarness({ precedent_check_output: () => ({ verdict: 'applies', precedentRef: 'adr:ADR-004', quote: 'Background work runs through Redis streams exclusively', answer: 'Use Redis.', rationale: '', confidence: 0.95 }) });
    const result = await fabricated.resolve();
    expect(result.request.trail[0]).toMatchObject({ rung: 'memory', outcome: 'not_applicable', detail: 'quote not found in adr:ADR-004' });
    expect(fabricated.schemas()).toContain('council_proposal_output');

    const superseded = ladderHarness({ precedent_check_output: () => ({ verdict: 'conflicts', precedentRef: 'adr:ADR-009', quote: 'Secrets are encrypted with AES-256-GCM.', answer: '', rationale: '', confidence: 0.9 }) }, { question: 'Should secrets be encrypted with AES-256-GCM at rest?' });
    const noPark = await superseded.resolve();
    expect(noPark.request.trail[0]).toMatchObject({ outcome: 'not_applicable' });
  });

  it('parks a question that conflicts with an accepted ADR, citing the ADR', async () => {
    const h = ladderHarness({
      precedent_check_output: () => ({ verdict: 'conflicts', precedentRef: 'adr:ADR-004', quote: 'no external broker such as Redis or Temporal', answer: 'ADR-004 forbids external brokers', rationale: '', confidence: 0.9 }),
    });
    const result = await h.resolve();
    expect(result).toMatchObject({ kind: 'parked', rung: 'memory', reason: 'adr_conflict' });
    expect(result.kind === 'parked' && result.detail).toContain('ADR-004');
    expect(result.kind === 'parked' && result.detail).toContain('no external broker such as Redis or Temporal');
    expect(h.schemas()).toEqual(['precedent_check_output']);
    expect(result.request).toMatchObject({ status: 'parked', parkReason: 'adr_conflict' });
  });

  it('parks a council decision that the consistency check finds in conflict with an accepted ADR', async () => {
    let checks = 0;
    const h = ladderHarness({
      precedent_check_output: () =>
        ++checks === 1
          ? notApplicable
          : { verdict: 'conflicts', precedentRef: 'adr:ADR-004', quote: 'no external broker such as Redis or Temporal', answer: '', rationale: 'Redis is an external broker', confidence: 0.9 },
    });
    const result = await h.resolve();
    expect(h.schemas().filter((s) => s === 'council_critique_output')).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'parked', rung: 'council', reason: 'adr_conflict' });
    expect(result.request.trail.map((s) => [s.rung, s.outcome])).toEqual([
      ['memory', 'not_applicable'],
      ['research', 'escalated'],
      ['council', 'answered'],
      ['council', 'conflict'],
    ]);
  });

  it('parks answers that propose changing an ADR, deterministically and without a model', async () => {
    const h = ladderHarness({
      council_proposal_output: () => ({ options: [{ ...seed, id: 'redis', summary: 'Supersede ADR-004 and switch to Redis' }], recommendedOptionId: 'redis', claims: [], assumptions: [], confidence: 0.9 }),
      council_vote_output: () => ({ responses: [], optionId: 'redis', changedBecause: null, confidence: 0.9 }),
    });
    const result = await h.resolve();
    expect(result).toMatchObject({ kind: 'parked', reason: 'adr_change' });
  });

  it('research: verified citations settle a factual question; fabricated or missing ones escalate', async () => {
    const good = ladderHarness(
      { decision_research_output: () => ({ answer: 'The queue uses SKIP LOCKED.', settled: true, citations: [{ path: 'src/queue.ts', quote: 'FOR UPDATE SKIP LOCKED', supports: 'locking' }], limitations: [], confidence: 0.9 }) },
      { nature: 'factual', question: 'How does the job queue lock rows?' },
    );
    expect(await good.resolve()).toMatchObject({ kind: 'answered', rung: 'research', answer: { evidence: ['src/queue.ts: "FOR UPDATE SKIP LOCKED"'] } });

    const fabricated = ladderHarness(
      { decision_research_output: () => ({ answer: 'It uses advisory locks.', settled: true, citations: [{ path: 'src/queue.ts', quote: 'pg_advisory_xact_lock(42)', supports: 'locking' }], limitations: [], confidence: 0.95 }) },
      { nature: 'factual', question: 'How does the job queue lock rows?' },
    );
    const parked = await fabricated.resolve();
    expect(parked).toMatchObject({ kind: 'parked', rung: 'research' });
    expect(parked.request.trail.at(-1)).toMatchObject({ rung: 'research', outcome: 'escalated' });
    expect(parked.request.trail.at(-1)!.detail).toContain('not in the repository');

    const missingPath = ladderHarness(
      { decision_research_output: () => ({ answer: 'See the worker.', settled: true, citations: [{ path: 'src/worker.ts', quote: 'claim(workerId)', supports: 'x' }], limitations: [], confidence: 0.95 }) },
      { nature: 'factual', question: 'How does the job queue lock rows?' },
    );
    expect((await missingPath.resolve()).request.trail.at(-1)!.detail).toContain('no citation verified');

    // A judgment call is never settled by research; its verified findings go to the council brief.
    const judgment = ladderHarness({ decision_research_output: () => ({ answer: 'Keep it.', settled: true, citations: [{ path: 'src/queue.ts', quote: 'FOR UPDATE SKIP LOCKED', supports: 'existing queue' }], limitations: [], confidence: 0.9 }) });
    const decided = await judgment.resolve();
    expect(decided).toMatchObject({ kind: 'answered', rung: 'council' });
    const proposalPrompt = judgment.world.calls.find((c) => c.schemaName === 'council_proposal_output')!.prompt;
    expect(proposalPrompt).toContain('verified citation src/queue.ts');
  });

  it('deduplicates identical questions and enforces per-decision and per-session council caps', async () => {
    const h = ladderHarness({});
    const input = { projectId: 'prj_1', sessionId: 'aps_1', taskId: null, runId: null, kind: 'design_choice' as const, nature: 'judgment' as const, question: 'Q?', options: [], fingerprint: decisionRequestFingerprint('prj_1', 'design_choice', 'Q?') };
    const first = await h.store.decisionRequests.open(input);
    const second = await h.store.decisionRequests.open({ ...input, runId: 'run_other' });
    expect(second).toMatchObject({ created: false, request: { id: first.request.id } });

    const capped = ladderHarness({});
    const result = await capped.resolve({ settings: { ...DEFAULT_LADDER_SETTINGS, maxCouncilsPerSession: 0 } });
    expect(result).toMatchObject({ kind: 'parked', rung: 'council', reason: 'council_cap' });
    expect(capped.schemas()).not.toContain('council_proposal_output');

    const cheap = ladderHarness({});
    cheap.world.usage = { inputTokens: 1_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const costCapped = await cheap.resolve({ settings: { ...DEFAULT_LADDER_SETTINGS, maxDecisionCostUsd: 0.01, rule: DEFAULT_COUNCIL_RULE } });
    expect(costCapped).toMatchObject({ kind: 'parked' });
    expect(['decision_cost_cap', 'council_cost_cap', 'council_budget']).toContain(costCapped.kind === 'parked' ? costCapped.reason : '');
    expect(costCapped.request.costUsd).toBeLessThan(0.1);
  });

  it('sends security-relevant questions straight to a human (advisory only)', async () => {
    const h = ladderHarness({});
    const result = await h.resolve({ policyPark: 'security-relevant design' });
    expect(result).toMatchObject({ kind: 'parked', reason: 'policy' });
    expect(h.world.calls).toHaveLength(0);
  });
});
