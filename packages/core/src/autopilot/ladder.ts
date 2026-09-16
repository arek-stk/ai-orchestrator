import { AGENT_DEFINITIONS, type AgentInput } from '../agents/definitions';
import type { AgentOutcome, AgentRuntime } from '../agents/runtime';
import type { CouncilOption, DecisionResearchOutput, PrecedentCheckOutput } from '../agents/schemas';
import type { ContextFile } from '../context/context-builder';
import type { AgentRole } from '../domain/enums';
import { totalTokens } from '../models/types';
import { questionKey } from '../orchestrator/helpers';
import type { Clock, EventRecorder } from '../ports';
import {
  COUNCIL_DECISION_TYPES,
  DEFAULT_COUNCIL_RULE,
  runCouncilProtocol,
  type CouncilDecisionRule,
  type CouncilDecisionType,
  type CouncilDiversity,
  type CouncilRepository,
  type CouncilRunInput,
  type CouncilTurnSink,
  type ExperimentRunner,
} from './council-protocol';
import { verifyEvidence, type EvidenceSources } from './evidence';
import { proposesAdrChange, quoteAppearsIn, retrievePrecedents, type Precedent, type RankedPrecedent } from './precedents';
import { delimitUntrusted, type UntrustedEntry } from './untrusted';

// The question/decision ladder for autopilot session runs (docs/plans/autopilot.md §3): (a) precedent from decision
// memory, accepted ADRs and docs/STATE.md → (b) evidenced repository research → (c) council protocol v2 → (d) park
// for the human. Authority (approval gates) never enters the ladder; only uncertainty does. An answer that contradicts
// an accepted ADR, or proposes changing one, is always parked. Routing is pure (`nextRung`); the ladder persists every
// rung it climbs on the decision request.

export const DECISION_REQUEST_KINDS = COUNCIL_DECISION_TYPES;
export type DecisionRequestKind = CouncilDecisionType;

export const DECISION_REQUEST_STATUSES = ['open', 'resolving', 'answered', 'parked', 'answered_by_human', 'withdrawn'] as const;
export type DecisionRequestStatus = (typeof DECISION_REQUEST_STATUSES)[number];

export const LADDER_RUNGS = ['memory', 'research', 'council', 'human'] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** factual: repository research may settle it. judgment: needs a council (or a human). */
export type DecisionNature = 'factual' | 'judgment';

export interface LadderStep {
  rung: LadderRung;
  outcome: 'answered' | 'conflict' | 'not_applicable' | 'escalated' | 'skipped' | 'parked';
  detail: string;
  costUsd: number;
  at: string;
}

export interface LadderAnswer {
  text: string;
  chosenOptionId: string | null;
  rationale: string;
  confidence: number;
  adrRefs: string[];
  evidence: string[];
  dissent: string[];
  diversity: CouncilDiversity | null;
  singleProvider: boolean;
}

export interface LadderAdvisory {
  leadingOptionId: string | null;
  summary: string;
}

export interface DecisionRequest {
  id: string;
  projectId: string;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  kind: DecisionRequestKind;
  nature: DecisionNature;
  question: string;
  options: CouncilOption[];
  fingerprint: string;
  status: DecisionRequestStatus;
  rung: LadderRung | null;
  trail: LadderStep[];
  answer: LadderAnswer | null;
  parkReason: string | null;
  advisory: LadderAdvisory | null;
  decisionId: string | null;
  approvalId: string | null;
  councilId: string | null;
  costUsd: number;
  createdAt: Date;
  resolvedAt: Date | null;
}

export type NewDecisionRequest = Pick<DecisionRequest, 'projectId' | 'sessionId' | 'taskId' | 'runId' | 'kind' | 'nature' | 'question' | 'options' | 'fingerprint'>;
export type DecisionRequestPatch = Partial<
  Pick<DecisionRequest, 'status' | 'rung' | 'trail' | 'answer' | 'parkReason' | 'advisory' | 'decisionId' | 'approvalId' | 'councilId' | 'costUsd' | 'resolvedAt'>
>;

export interface DecisionRequestRepository {
  /** Opens a request; an open/resolving request with the same project and fingerprint is returned instead (dedupe). */
  open(input: NewDecisionRequest): Promise<{ request: DecisionRequest; created: boolean }>;
  get(id: string): Promise<DecisionRequest | null>;
  list(filter: { projectId?: string; sessionId?: string; statuses?: readonly DecisionRequestStatus[]; limit?: number }): Promise<DecisionRequest[]>;
  update(id: string, patch: DecisionRequestPatch): Promise<DecisionRequest>;
}

/** Identical questions from several runs resolve once: kind + normalised question + project. */
export function decisionRequestFingerprint(projectId: string, kind: DecisionRequestKind, question: string): string {
  return questionKey(['decision_request', projectId, kind, question]);
}

const MAX_TRAIL = 12;

/** Pure routing: the next rung for a request given the rungs already climbed. */
export function nextRung(request: Pick<DecisionRequest, 'nature'>, trail: readonly LadderStep[]): LadderRung | 'done' {
  const last = trail.at(-1);
  if (last?.outcome === 'answered') return 'done';
  if (trail.some((s) => s.outcome === 'conflict' || s.outcome === 'parked') || trail.some((s) => s.rung === 'human')) return 'human';
  if (!trail.some((s) => s.rung === 'memory')) return 'memory';
  if (!trail.some((s) => s.rung === 'research')) return 'research';
  if (request.nature === 'factual') return 'human';
  if (!trail.some((s) => s.rung === 'council')) return 'council';
  return 'human';
}

export interface LadderSettings {
  /** Minimum self-reported confidence for a verified precedent to settle a question (it still has to verify). */
  precedentMinConfidence: number;
  researchMinConfidence: number;
  /** Cap per decision request across all rungs (precedent, research, council, consistency checks). */
  maxDecisionCostUsd: number;
  maxCouncilsPerSession: number;
  /** Share of the session budget councils may spend in total. */
  councilBudgetShare: number;
  rule: CouncilDecisionRule;
}

export const DEFAULT_LADDER_SETTINGS: Readonly<LadderSettings> = Object.freeze({
  precedentMinConfidence: 0.8,
  researchMinConfidence: 0.8,
  maxDecisionCostUsd: 1.5,
  maxCouncilsPerSession: 10,
  councilBudgetShare: 0.25,
  rule: DEFAULT_COUNCIL_RULE,
});

export interface LadderDeps {
  runtime: AgentRuntime;
  requests: DecisionRequestRepository;
  councils: CouncilRepository;
  clock: Clock;
  events?: EventRecorder;
  sink?: CouncilTurnSink;
  experiments?: ExperimentRunner;
  onError?: (error: unknown) => void;
}

export interface LadderContext {
  request: DecisionRequest;
  session: { id: string; budgetUsd: number } | null;
  agent: CouncilRunInput['agent'];
  precedents: readonly Precedent[];
  evidence: EvidenceSources;
  /** Ranked repository files for research (read-only, base commit). */
  researchFiles: readonly ContextFile[];
  members: readonly AgentRole[];
  council: { maxRounds: number; maxTokens: number; timeoutMs: number; confidenceThreshold: number };
  settings: LadderSettings;
  runBudgetRemainingUsd: number | null;
  allowedChecks: readonly string[];
  /** A policy reason that sends the request straight to a human (e.g. security-relevant: advisory only). */
  policyPark: string | null;
}

export type LadderResult =
  | { kind: 'answered'; request: DecisionRequest; rung: LadderRung; answer: LadderAnswer; costUsd: number; tokens: number }
  | { kind: 'parked'; request: DecisionRequest; rung: LadderRung; reason: string; detail: string; advisory: LadderAdvisory | null; costUsd: number; tokens: number };

type PrecedentVerdict =
  | { verdict: 'applies'; precedent: RankedPrecedent; quote: string; output: PrecedentCheckOutput }
  | { verdict: 'conflicts'; precedent: RankedPrecedent; quote: string; output: PrecedentCheckOutput }
  | { verdict: 'not_applicable'; detail: string };

/**
 * Deterministic verification of a precedent check: the precedent must be one of the retrieved ones, the quote must be
 * in its text and it must be authoritative (accepted ADR, STATE, active/confirmed decision). Anything else counts as
 * not applicable: an unverified precedent neither settles nor blocks a question.
 */
export function verifyPrecedentVerdict(output: PrecedentCheckOutput, retrieved: readonly RankedPrecedent[]): PrecedentVerdict {
  if (output.verdict === 'not_applicable') return { verdict: 'not_applicable', detail: 'no precedent applies' };
  const precedent = retrieved.find((p) => p.ref === output.precedentRef?.trim());
  if (!precedent) return { verdict: 'not_applicable', detail: `cited precedent ${output.precedentRef ?? '(none)'} was not among the retrieved precedents` };
  if (!quoteAppearsIn(precedent.text, output.quote)) return { verdict: 'not_applicable', detail: `quote not found in ${precedent.ref}` };
  if (!precedent.authoritative) return { verdict: 'not_applicable', detail: `${precedent.ref} is not authoritative (not accepted or not confirmed)` };
  return { verdict: output.verdict, precedent, quote: output.quote!, output };
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export class DecisionLadder {
  constructor(private readonly deps: LadderDeps) {}

  async resolve(ctx: LadderContext): Promise<LadderResult> {
    const { deps } = this;
    let request = ctx.request;
    let costUsd = 0;
    let tokens = 0;
    if (request.status === 'open') request = await deps.requests.update(request.id, { status: 'resolving' });

    const record = async (step: Omit<LadderStep, 'at'>, patch: Parameters<DecisionRequestRepository['update']>[1] = {}) => {
      const trail = [...request.trail, { ...step, detail: step.detail.slice(0, 500), at: deps.clock.now().toISOString() }].slice(-MAX_TRAIL);
      request = await deps.requests.update(request.id, { trail, rung: step.rung, costUsd: round6(request.costUsd + step.costUsd), ...patch });
    };
    const spend = (outcome: AgentOutcome<unknown>) => {
      costUsd += outcome.costUsd;
      tokens += totalTokens(outcome.usage);
      return outcome.costUsd;
    };
    const park = async (rung: LadderRung, reason: string, detail: string, advisory: LadderAdvisory | null): Promise<LadderResult> => {
      request = await deps.requests.update(request.id, { status: 'parked', rung: 'human', parkReason: reason, advisory, resolvedAt: deps.clock.now() });
      return { kind: 'parked', request, rung, reason, detail, advisory, costUsd: round6(costUsd), tokens };
    };
    const answered = async (rung: LadderRung, answer: LadderAnswer): Promise<LadderResult> => {
      // Consistency: an answer may never change an ADR, and must not contradict an accepted one.
      const change = proposesAdrChange(`${answer.text}\n${answer.rationale}`);
      if (change) {
        await record({ rung, outcome: 'conflict', detail: change, costUsd: 0 });
        return park(rung, 'adr_change', `${change}; ADRs are changed by humans only`, { leadingOptionId: answer.chosenOptionId, summary: answer.text.slice(0, 500) });
      }
      const conflict = rung === 'memory' && answer.adrRefs.length > 0 ? null : await this.consistencyCheck({ ...ctx, request }, answer, spend);
      if (conflict) {
        await record({ rung, outcome: 'conflict', detail: conflict.detail, costUsd: conflict.costUsd });
        return park(rung, 'adr_conflict', conflict.detail, { leadingOptionId: answer.chosenOptionId, summary: answer.text.slice(0, 500) });
      }
      request = await deps.requests.update(request.id, { status: 'answered', rung, answer, resolvedAt: deps.clock.now() });
      return { kind: 'answered', request, rung, answer, costUsd: round6(costUsd), tokens };
    };

    if (ctx.policyPark) {
      await record({ rung: 'human', outcome: 'parked', detail: ctx.policyPark, costUsd: 0 });
      return park('human', 'policy', ctx.policyPark, null);
    }

    let researchFindings: UntrustedEntry[] = [];
    for (let guard = 0; guard < 6; guard++) {
      const rung = nextRung(request, request.trail);
      if (rung === 'done') {
        // Resumed after a crash between answering and persisting the answer.
        if (request.answer) return { kind: 'answered', request, rung: request.rung ?? 'memory', answer: request.answer, costUsd: round6(costUsd), tokens };
        break;
      }
      if (rung === 'human') {
        const last = request.trail.at(-1);
        return park(last?.rung ?? 'human', request.parkReason ?? reasonFromTrail(request.trail), last?.detail ?? 'no rung settled the question', request.advisory);
      }
      if (request.costUsd >= ctx.settings.maxDecisionCostUsd) {
        await record({ rung, outcome: 'parked', detail: `decision cost cap $${ctx.settings.maxDecisionCostUsd.toFixed(2)} reached`, costUsd: 0 });
        return park(rung, 'decision_cost_cap', `the decision spent $${request.costUsd.toFixed(4)}`, request.advisory);
      }

      if (rung === 'memory') {
        const result = await this.memory({ ...ctx, request }, spend);
        if (result.kind === 'budget') {
          await record({ rung, outcome: 'parked', detail: result.detail, costUsd: result.costUsd });
          return park(rung, 'budget', result.detail, null);
        }
        if (result.kind === 'conflict') {
          await record({ rung, outcome: 'conflict', detail: result.detail, costUsd: result.costUsd });
          return park(rung, 'adr_conflict', result.detail, { leadingOptionId: null, summary: result.detail });
        }
        if (result.kind === 'answered') {
          await record({ rung, outcome: 'answered', detail: result.detail, costUsd: result.costUsd });
          return answered(rung, result.answer);
        }
        await record({ rung, outcome: result.kind === 'skipped' ? 'skipped' : 'not_applicable', detail: result.detail, costUsd: result.costUsd });
        continue;
      }

      if (rung === 'research') {
        const result = await this.research({ ...ctx, request }, spend);
        researchFindings = result.findings;
        if (result.kind === 'budget') {
          await record({ rung, outcome: 'parked', detail: result.detail, costUsd: result.costUsd });
          return park(rung, 'budget', result.detail, null);
        }
        if (result.kind === 'answered' && request.nature === 'factual') {
          await record({ rung, outcome: 'answered', detail: result.detail, costUsd: result.costUsd });
          return answered(rung, result.answer);
        }
        await record({ rung, outcome: result.kind === 'skipped' ? 'skipped' : 'escalated', detail: result.detail, costUsd: result.costUsd });
        continue;
      }

      // rung === 'council'
      const cap = await this.councilCap(ctx);
      if (cap) {
        await record({ rung, outcome: 'parked', detail: cap.detail, costUsd: 0 });
        return park(rung, cap.reason, cap.detail, null);
      }
      const existing = (await deps.councils.list({ requestId: request.id, limit: 1 }))[0] ?? null;
      const adrConstraints = retrievePrecedents(request.question, ctx.precedents.filter((p) => p.authoritative), 3).map((p) => ({ ref: p.ref, title: p.title.slice(0, 160), excerpt: p.text.slice(0, 1_500) }));
      const councilBudget = Math.min(ctx.settings.maxDecisionCostUsd - request.costUsd, await this.councilBudgetLeft(ctx));
      const result = await runCouncilProtocol(
        { runtime: deps.runtime, councils: deps.councils, clock: deps.clock, ...(deps.events ? { events: deps.events } : {}), ...(deps.sink ? { sink: deps.sink } : {}), ...(deps.experiments ? { experiments: deps.experiments } : {}), ...(deps.onError ? { onError: deps.onError } : {}) },
        {
          requestId: request.id,
          projectId: request.projectId,
          sessionId: request.sessionId,
          runId: request.runId,
          councilId: existing?.id ?? null,
          decisionType: request.kind,
          question: request.question,
          members: ctx.members,
          seedOptions: request.options,
          constraints: adrConstraints,
          context: researchFindings,
          agent: ctx.agent,
          bounds: {
            maxCostUsd: Math.max(0, councilBudget),
            maxTokens: ctx.council.maxTokens,
            timeoutMs: ctx.council.timeoutMs,
            rounds: ctx.council.maxRounds >= 2 ? 2 : 1,
            runBudgetRemainingUsd: ctx.runBudgetRemainingUsd === null ? null : Math.max(0, ctx.runBudgetRemainingUsd - costUsd),
          },
          rule: { ...ctx.settings.rule, threshold: ctx.council.confidenceThreshold },
          evidence: ctx.evidence,
          allowedChecks: ctx.allowedChecks,
        },
      );
      costUsd += result.costUsd;
      tokens += result.tokens;
      const synthesis = result.synthesis;
      request = await deps.requests.update(request.id, { councilId: result.council.id });
      const leading = synthesis.options.find((o) => o.id === synthesis.leadingOptionId) ?? null;
      if (synthesis.outcome === 'parked') {
        const detail = synthesis.reasons.at(-1) ?? `council parked (${synthesis.parkReason})`;
        await record({ rung, outcome: 'parked', detail, costUsd: result.costUsd });
        return park(rung, `council_${synthesis.parkReason ?? 'parked'}`, detail, leading ? { leadingOptionId: leading.id, summary: leading.summary.slice(0, 500) } : null);
      }
      await record({ rung, outcome: 'answered', detail: `council decided ${synthesis.chosenOptionId} (${synthesis.diversity})`, costUsd: result.costUsd });
      const chosen = synthesis.chosenOption!;
      return answered(rung, {
        text: `${chosen.id}: ${chosen.summary}`,
        chosenOptionId: chosen.id,
        rationale: [
          `Council protocol v2 decided with ${Math.round(synthesis.confidence * 100)}% confidence (threshold ${Math.round(synthesis.threshold * 100)}%).`,
          `Model diversity: ${synthesis.diversity}${synthesis.singleProvider ? ' (single provider: raised threshold)' : ''}.`,
          synthesis.tieBreak ? `Tie-break: ${synthesis.tieBreak.join(' → ')}.` : '',
          ...synthesis.objections.filter((o) => o.status === 'active').map((o) => `Open ${o.severity} objection ${o.id}: ${o.claim.slice(0, 200)}${o.rebutted ? ' (rebutted with evidence)' : ''}`),
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 3_000),
        confidence: synthesis.confidence,
        adrRefs: synthesis.adrRefs,
        evidence: synthesis.support.map((s) => `${s.optionId}: weight ${s.weight} from ${s.voters.join(', ')}`),
        dissent: synthesis.dissent,
        diversity: synthesis.diversity,
        singleProvider: synthesis.singleProvider,
      });
    }
    return park('human', 'ladder_exhausted', 'the ladder ran out of rungs', request.advisory);
  }

  private async memory(ctx: LadderContext, spend: (o: AgentOutcome<unknown>) => number) {
    const retrieved = retrievePrecedents(ctx.request.question, ctx.precedents, 5);
    if (retrieved.length === 0) return { kind: 'skipped' as const, detail: 'no precedent matched the question', costUsd: 0 };
    const outcome = await this.precedentCheck(ctx, ctx.request.question, retrieved);
    const costUsd = spend(outcome);
    if (!outcome.ok) {
      if (outcome.kind === 'budget_paused') return { kind: 'budget' as const, detail: `budget paused the precedent check: ${outcome.error}`, costUsd };
      return { kind: 'not_applicable' as const, detail: `precedent check failed: ${outcome.error}`.slice(0, 300), costUsd };
    }
    const verdict = verifyPrecedentVerdict(outcome.output, retrieved);
    if (verdict.verdict === 'not_applicable') return { kind: 'not_applicable' as const, detail: verdict.detail, costUsd };
    if (verdict.verdict === 'conflicts') {
      if (verdict.precedent.kind !== 'adr') return { kind: 'not_applicable' as const, detail: `question conflicts with ${verdict.precedent.ref}; escalated`, costUsd };
      return { kind: 'conflict' as const, detail: `conflicts with accepted ${verdict.precedent.ref.slice(4)}: "${verdict.quote.slice(0, 300)}"`, costUsd };
    }
    if (outcome.output.confidence < ctx.settings.precedentMinConfidence) {
      return { kind: 'not_applicable' as const, detail: `precedent ${verdict.precedent.ref} applies with low confidence ${outcome.output.confidence}`, costUsd };
    }
    return {
      kind: 'answered' as const,
      detail: `answered by ${verdict.precedent.ref}`,
      costUsd,
      answer: {
        text: outcome.output.answer.slice(0, 2_000),
        chosenOptionId: null,
        rationale: `Precedent ${verdict.precedent.ref}: "${verdict.quote.slice(0, 500)}". ${outcome.output.rationale}`.slice(0, 3_000),
        confidence: outcome.output.confidence,
        adrRefs: verdict.precedent.kind === 'adr' ? [verdict.precedent.ref.slice(4)] : [],
        evidence: [`${verdict.precedent.ref}: "${verdict.quote.slice(0, 300)}"`],
        dissent: [],
        diversity: null,
        singleProvider: false,
      } satisfies LadderAnswer,
    };
  }

  private async research(ctx: LadderContext, spend: (o: AgentOutcome<unknown>) => number) {
    if (ctx.researchFiles.length === 0) return { kind: 'skipped' as const, detail: 'no repository context available', costUsd: 0, findings: [] as UntrustedEntry[] };
    const outcome = await this.deps.runtime.run({
      definition: AGENT_DEFINITIONS.decision_research,
      input: {
        ...ctx.agent.baseInput,
        sections: [
          ...ctx.agent.baseInput.sections,
          { title: 'Question', body: delimitUntrusted('decision_question', 'The question to research.', [{ label: 'question', text: ctx.request.question }]) },
          {
            title: 'Repository excerpts',
            body: delimitUntrusted(
              'repository_excerpts',
              'Read-only excerpts of repository files at the base commit.',
              ctx.researchFiles.map((f) => ({ label: f.path, text: f.content })),
              { maxEntryChars: 6_000 },
            ),
          },
        ],
      },
      scope: ctx.agent.scope,
      complexity: ctx.agent.complexity,
      risk: ctx.agent.risk,
      runBudgetRemainingUsd: this.callBudget(ctx),
      ...(ctx.agent.projectRoleOverrides ? { projectRoleOverrides: ctx.agent.projectRoleOverrides } : {}),
    });
    const costUsd = spend(outcome as AgentOutcome<unknown>);
    if (!outcome.ok) {
      if (outcome.kind === 'budget_paused') return { kind: 'budget' as const, detail: `budget paused research: ${outcome.error}`, costUsd, findings: [] };
      return { kind: 'escalated' as const, detail: `research failed: ${outcome.error}`.slice(0, 300), costUsd, findings: [] };
    }
    const output: DecisionResearchOutput = outcome.output;
    const checked = await verifyEvidence(
      output.citations.map((c, i) => ({ id: `research-${i}`, item: { type: 'file', ref: c.path, quote: c.quote } })),
      ctx.evidence,
    );
    const verified = checked.filter((c) => c.status === 'verified');
    const refuted = checked.filter((c) => c.status === 'refuted');
    const findings: UntrustedEntry[] = verified.map((c) => {
      const citation = output.citations[Number(c.id.slice('research-'.length))]!;
      return { label: `verified citation ${c.ref}`, text: `"${citation.quote}" — ${citation.supports}` };
    });
    if (refuted.length > 0) {
      // A fabricated citation discredits the whole answer; the verified ones still inform the council.
      return { kind: 'escalated' as const, detail: `research cited ${refuted.length} quote(s) that are not in the repository: ${refuted.map((r) => r.detail).join('; ')}`.slice(0, 500), costUsd, findings };
    }
    if (!output.settled || verified.length === 0 || output.confidence < ctx.settings.researchMinConfidence) {
      const why = !output.settled ? 'research did not settle the question' : verified.length === 0 ? 'no citation verified' : `confidence ${output.confidence} below ${ctx.settings.researchMinConfidence}`;
      return { kind: 'escalated' as const, detail: `${why} (${verified.length} of ${checked.length} citations verified)`, costUsd, findings };
    }
    return {
      kind: 'answered' as const,
      detail: `${verified.length} verified citation(s)`,
      costUsd,
      findings,
      answer: {
        text: output.answer.slice(0, 2_000),
        chosenOptionId: null,
        rationale: `Answered from the repository with ${verified.length} verified citation(s).${output.limitations.length > 0 ? ` Limitations: ${output.limitations.join('; ')}` : ''}`.slice(0, 3_000),
        confidence: output.confidence,
        adrRefs: [],
        evidence: verified.map((c) => `${c.ref}: "${(c.quote ?? '').slice(0, 200)}"`),
        dissent: [],
        diversity: null,
        singleProvider: false,
      } satisfies LadderAnswer,
    };
  }

  /** Re-runs the precedent check on a proposed answer against accepted ADRs (plan §4.5 rule 3). */
  private async consistencyCheck(ctx: LadderContext, answer: LadderAnswer, spend: (o: AgentOutcome<unknown>) => number): Promise<{ detail: string; costUsd: number } | null> {
    const adrs = retrievePrecedents(`${ctx.request.question}\n${answer.text}`, ctx.precedents.filter((p) => p.kind === 'adr' && p.authoritative), 3);
    if (adrs.length === 0) return null;
    const outcome = await this.precedentCheck(ctx, `Proposed answer to "${ctx.request.question}": ${answer.text}`, adrs);
    const costUsd = spend(outcome);
    // A failed consistency check cannot prove consistency: park conservatively.
    if (!outcome.ok) return { detail: `the ADR consistency check could not run (${outcome.kind}); parked conservatively`, costUsd };
    const verdict = verifyPrecedentVerdict(outcome.output, adrs);
    if (verdict.verdict !== 'conflicts') return null;
    return { detail: `the answer conflicts with accepted ${verdict.precedent.ref.slice(4)}: "${verdict.quote.slice(0, 300)}"`, costUsd };
  }

  private precedentCheck(ctx: LadderContext, question: string, precedents: readonly RankedPrecedent[]): Promise<AgentOutcome<PrecedentCheckOutput>> {
    const sections: AgentInput['sections'] = [
      { title: 'Question', body: delimitUntrusted('decision_question', 'The question or proposed answer to check.', [{ label: 'question', text: question }]) },
      {
        title: 'Precedents',
        body: delimitUntrusted('precedents', 'Precedents retrieved by keyword overlap; reference them by the label before the colon.', precedents.map((p) => ({ label: `${p.ref} (${p.title})`, text: p.text })), { maxEntryChars: 4_000 }),
      },
    ];
    return this.deps.runtime.run({
      definition: AGENT_DEFINITIONS.precedent_check,
      input: { ...ctx.agent.baseInput, sections: [...ctx.agent.baseInput.sections, ...sections] },
      scope: ctx.agent.scope,
      complexity: 'simple',
      risk: ctx.agent.risk,
      runBudgetRemainingUsd: this.callBudget(ctx),
      ...(ctx.agent.projectRoleOverrides ? { projectRoleOverrides: ctx.agent.projectRoleOverrides } : {}),
    });
  }

  private callBudget(ctx: LadderContext): number {
    const decisionLeft = Math.max(0, ctx.settings.maxDecisionCostUsd - ctx.request.costUsd);
    return ctx.runBudgetRemainingUsd === null ? decisionLeft : Math.min(decisionLeft, ctx.runBudgetRemainingUsd);
  }

  private async councilBudgetLeft(ctx: LadderContext): Promise<number> {
    if (!ctx.session) return Number.POSITIVE_INFINITY;
    const usage = await this.deps.councils.sessionUsage(ctx.session.id);
    return ctx.session.budgetUsd * ctx.settings.councilBudgetShare - usage.costUsd;
  }

  private async councilCap(ctx: LadderContext): Promise<{ reason: string; detail: string } | null> {
    if (!ctx.session) return null;
    const existing = (await this.deps.councils.list({ requestId: ctx.request.id, limit: 1 }))[0];
    if (existing) return null; // resuming a council that was already admitted
    const usage = await this.deps.councils.sessionUsage(ctx.session.id);
    if (usage.councils >= ctx.settings.maxCouncilsPerSession) return { reason: 'council_cap', detail: `the session already held ${usage.councils} councils (cap ${ctx.settings.maxCouncilsPerSession})` };
    const share = ctx.session.budgetUsd * ctx.settings.councilBudgetShare;
    if (usage.costUsd >= share) return { reason: 'council_budget', detail: `councils spent $${usage.costUsd.toFixed(2)} of their $${share.toFixed(2)} session share` };
    return null;
  }
}

function reasonFromTrail(trail: readonly LadderStep[]): string {
  const last = trail.at(-1);
  if (!last) return 'unresolved';
  if (last.outcome === 'conflict') return 'adr_conflict';
  if (last.rung === 'research') return 'research_unsettled';
  return 'unresolved';
}
