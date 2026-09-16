import { AGENT_DEFINITIONS, type AgentDefinition, type AgentInput } from '../agents/definitions';
import type { AgentOutcome, AgentRuntime, AgentScope } from '../agents/runtime';
import {
  CouncilCritiqueSchema,
  CouncilProposalSchema,
  CouncilVoteSchema,
  type CouncilCritique,
  type CouncilObjection,
  type CouncilOption,
  type CouncilProposal,
  type CouncilVote,
  type EvidenceItem,
} from '../agents/schemas';
import type { AgentRole, Complexity, Risk } from '../domain/enums';
import { totalTokens } from '../models/types';
import type { Clock, EventRecorder } from '../ports';
import { verifyEvidence, type CheckResult, type EvidenceSources, type VerifiedEvidence } from './evidence';
import { delimitUntrusted, type UntrustedEntry } from './untrusted';

// Council protocol v2 (docs/plans/autopilot.md §4): blind proposals, one critic (preferably on another provider),
// deterministic evidence verification, at most one experiment, a second round of responses and votes, and a pure
// synthesis in which evidence beats votes. Every step is persisted as an append-only turn, so a crashed worker resumes
// from the stored turns and `decideCouncil` can be replayed over them. The council never executes tools and never
// approves anything: its outcome is a provisional decision or a parked question for a human.

export const COUNCIL_PROTOCOL_VERSION = 2;

export const COUNCIL_DECISION_TYPES = ['design_choice', 'clarification', 'blocker_resolution', 'test_strategy'] as const;
export type CouncilDecisionType = (typeof COUNCIL_DECISION_TYPES)[number];

/** cross_provider: the critic runs on another provider than every member; cross_model: same provider, other model. */
export const COUNCIL_DIVERSITY_LEVELS = ['cross_provider', 'cross_model', 'none'] as const;
export type CouncilDiversity = (typeof COUNCIL_DIVERSITY_LEVELS)[number];

export const COUNCIL_TURN_KINDS = ['brief', 'proposal', 'critique', 'evidence_result', 'experiment', 'vote', 'synthesis'] as const;
export type CouncilTurnKind = (typeof COUNCIL_TURN_KINDS)[number];

export const COUNCIL_PARK_REASONS = [
  'no_proposals',
  'critic_unavailable',
  'product_intent',
  'adr_conflict',
  'blocking_objection',
  'no_viable_option',
  'members_voted_park',
  'tie',
  'low_confidence',
  'no_model_diversity',
  'budget',
  'cost_cap',
  'token_limit',
  'timeout',
] as const;
export type CouncilParkReason = (typeof COUNCIL_PARK_REASONS)[number];

export const COUNCIL_STATUSES = ['running', 'decided', 'parked'] as const;
export type CouncilStatus = (typeof COUNCIL_STATUSES)[number];

export interface CouncilParticipant {
  role: AgentRole;
  stance: 'member' | 'critic';
  modelId: string | null;
  provider: string | null;
}

export interface CouncilRecord {
  id: string;
  requestId: string;
  projectId: string;
  sessionId: string | null;
  runId: string | null;
  decisionType: CouncilDecisionType;
  protocolVersion: number;
  question: string;
  participants: CouncilParticipant[];
  diversity: CouncilDiversity | null;
  status: CouncilStatus;
  chosenOptionId: string | null;
  confidence: number | null;
  parkReason: CouncilParkReason | null;
  roundsUsed: number;
  costUsd: number;
  tokens: number;
  deadlineAt: Date;
  createdAt: Date;
  finishedAt: Date | null;
}

export type NewCouncil = Pick<CouncilRecord, 'requestId' | 'projectId' | 'sessionId' | 'runId' | 'decisionType' | 'question' | 'deadlineAt'>;

export interface CouncilTurnRecord {
  id: string;
  councilId: string;
  /** Position in the transcript, unique per council (append-only). */
  seq: number;
  round: number;
  kind: CouncilTurnKind;
  role: AgentRole | 'orchestrator';
  stance: 'member' | 'critic' | 'orchestrator';
  body: Record<string, unknown>;
  modelId: string | null;
  provider: string | null;
  costUsd: number;
  tokens: number;
  createdAt: Date;
}

export type NewCouncilTurn = Omit<CouncilTurnRecord, 'id' | 'createdAt'>;

export interface CouncilFinish {
  status: 'decided' | 'parked';
  chosenOptionId: string | null;
  confidence: number | null;
  parkReason: CouncilParkReason | null;
  diversity: CouncilDiversity | null;
  finishedAt: Date;
}

/** Persistence port for councils and their append-only transcripts. */
export interface CouncilRepository {
  create(input: NewCouncil): Promise<CouncilRecord>;
  get(id: string): Promise<CouncilRecord | null>;
  /** Appends a turn. A turn with an existing (council, seq) is not written again; the stored one is returned. */
  appendTurn(turn: NewCouncilTurn): Promise<CouncilTurnRecord>;
  turns(councilId: string): Promise<CouncilTurnRecord[]>;
  recordProgress(id: string, patch: Pick<CouncilRecord, 'participants' | 'roundsUsed' | 'costUsd' | 'tokens'>): Promise<void>;
  finish(id: string, patch: CouncilFinish): Promise<CouncilRecord | null>;
  /** Councils started in a session and their summed cost (session-wide caps). */
  sessionUsage(sessionId: string): Promise<{ councils: number; costUsd: number }>;
  list(filter: { requestId?: string; sessionId?: string; limit?: number }): Promise<CouncilRecord[]>;
}

// ---------------------------------------------------------------------------
// Turn bodies and state
// ---------------------------------------------------------------------------

export interface CouncilBrief {
  question: string;
  decisionType: CouncilDecisionType;
  members: AgentRole[];
  seedOptions: CouncilOption[];
  /** Accepted precedents the council must respect (ADR excerpts), already sanitised. */
  constraints: Array<{ ref: string; title: string; excerpt: string }>;
  risk: Risk;
  threshold: number;
  rounds: 1 | 2;
}

export type AgentTurnBody<T> = { ok: true; output: T } | { ok: false; error: string };

export type ExperimentBody = { skipped: true; reason: string } | { skipped: false; results: Array<CheckResult & { objectionId: string; optionId: string }> };

export interface MemberTurn<T> {
  role: AgentRole;
  body: AgentTurnBody<T>;
  modelId: string | null;
  provider: string | null;
}

export interface CouncilState {
  brief: CouncilBrief | null;
  proposals: MemberTurn<CouncilProposal>[];
  critique: MemberTurn<CouncilCritique> | null;
  evidence1: VerifiedEvidence[] | null;
  experiment: ExperimentBody | null;
  votes: MemberTurn<CouncilVote>[];
  evidence2: VerifiedEvidence[] | null;
  synthesis: CouncilSynthesis | null;
  nextSeq: number;
  costUsd: number;
  tokens: number;
}

function agentBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: Record<string, unknown>): AgentTurnBody<T> {
  if (body.ok === true) {
    const parsed = schema.safeParse(body.output);
    return parsed.success ? { ok: true, output: parsed.data } : { ok: false, error: 'stored output no longer matches the schema' };
  }
  return { ok: false, error: typeof body.error === 'string' ? body.error : 'failed' };
}

/** Rebuilds the protocol state from stored turns (in seq order). Pure. */
export function councilState(turns: readonly CouncilTurnRecord[]): CouncilState {
  const state: CouncilState = { brief: null, proposals: [], critique: null, evidence1: null, experiment: null, votes: [], evidence2: null, synthesis: null, nextSeq: 0, costUsd: 0, tokens: 0 };
  for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
    state.nextSeq = Math.max(state.nextSeq, turn.seq + 1);
    state.costUsd += turn.costUsd;
    state.tokens += turn.tokens;
    const role = turn.role as AgentRole;
    switch (turn.kind) {
      case 'brief':
        state.brief = turn.body as unknown as CouncilBrief;
        break;
      case 'proposal':
        state.proposals.push({ role, body: agentBody(CouncilProposalSchema, turn.body), modelId: turn.modelId, provider: turn.provider });
        break;
      case 'critique':
        state.critique = { role, body: agentBody(CouncilCritiqueSchema, turn.body), modelId: turn.modelId, provider: turn.provider };
        break;
      case 'evidence_result':
        if (turn.round === 1) state.evidence1 = (turn.body.items as VerifiedEvidence[]) ?? [];
        else state.evidence2 = (turn.body.items as VerifiedEvidence[]) ?? [];
        break;
      case 'experiment':
        state.experiment = turn.body as unknown as ExperimentBody;
        break;
      case 'vote':
        state.votes.push({ role, body: agentBody(CouncilVoteSchema, turn.body), modelId: turn.modelId, provider: turn.provider });
        break;
      case 'synthesis':
        state.synthesis = turn.body as unknown as CouncilSynthesis;
        break;
    }
  }
  return state;
}

export type CouncilStep = 'brief' | 'proposals' | 'critique' | 'evidence_1' | 'experiment' | 'votes' | 'evidence_2' | 'synthesis' | 'done';

/** The next protocol step for a state. Pure; the order is fixed and every step runs at most once. */
export function nextCouncilStep(state: CouncilState): CouncilStep {
  if (state.synthesis) return 'done';
  if (!state.brief) return 'brief';
  if (state.proposals.length < state.brief.members.length) return 'proposals';
  if (!state.proposals.some((p) => p.body.ok)) return 'synthesis';
  if (!state.critique) return 'critique';
  if (!state.evidence1) return 'evidence_1';
  if (!state.experiment) return 'experiment';
  if (state.brief.rounds === 2) {
    const voters = state.proposals.filter((p) => p.body.ok).length;
    if (state.votes.length < voters) return 'votes';
    if (!state.evidence2) return 'evidence_2';
  }
  return 'synthesis';
}

// ---------------------------------------------------------------------------
// Evidence ids
// ---------------------------------------------------------------------------

export const proposalEvidenceId = (role: string, claim: number, item: number) => `ev-p-${role}-${claim}-${item}`;
export const objectionEvidenceId = (objectionId: string, item: number) => `ev-c-${objectionId}-${item}`;
export const voteEvidenceId = (role: string, response: number, item: number) => `ev-v-${role}-${response}-${item}`;
export const checkEvidenceId = (name: string) => `chk-${name}`;

export function roundOneEvidence(state: Pick<CouncilState, 'proposals' | 'critique'>): Array<{ id: string; item: EvidenceItem }> {
  const items: Array<{ id: string; item: EvidenceItem }> = [];
  for (const proposal of state.proposals) {
    if (!proposal.body.ok) continue;
    proposal.body.output.claims.forEach((claim, c) => claim.evidence.forEach((item, i) => items.push({ id: proposalEvidenceId(proposal.role, c, i), item })));
  }
  if (state.critique?.body.ok) {
    for (const objection of state.critique.body.output.objections) objection.evidence.forEach((item, i) => items.push({ id: objectionEvidenceId(objection.id, i), item }));
  }
  return items;
}

export function roundTwoEvidence(state: Pick<CouncilState, 'votes'>): Array<{ id: string; item: EvidenceItem }> {
  const items: Array<{ id: string; item: EvidenceItem }> = [];
  for (const vote of state.votes) {
    if (!vote.body.ok) continue;
    vote.body.output.responses.forEach((response, r) => response.evidence.forEach((item, i) => items.push({ id: voteEvidenceId(vote.role, r, i), item })));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Decision rule (pure, replayable)
// ---------------------------------------------------------------------------

export interface CouncilDecisionRule {
  /** Base confidence threshold (project council settings). */
  threshold: number;
  /** Multiplier on agreement; later calibrated from confirm/reject outcomes (plan §7.3). */
  calibration: number;
  /**
   * Single provider: the critic shares the members' provider. The decision is marked `singleProvider` and needs this
   * much more confidence. With no model diversity at all (critic on the members' model) the council always parks.
   */
  singleProviderPenalty: number;
}

export const DEFAULT_COUNCIL_RULE: Readonly<CouncilDecisionRule> = Object.freeze({ threshold: 0.8, calibration: 0.9, singleProviderPenalty: 0.1 });

export interface CouncilSynthesis {
  outcome: 'decided' | 'parked';
  chosenOptionId: string | null;
  chosenOption: CouncilOption | null;
  parkReason: CouncilParkReason | null;
  /** Leading option when parked (advisory for the human), else the chosen one. */
  leadingOptionId: string | null;
  confidence: number;
  agreement: number;
  threshold: number;
  diversity: CouncilDiversity;
  singleProvider: boolean;
  options: CouncilOption[];
  support: Array<{ optionId: string; weight: number; voters: string[] }>;
  votes: Array<{ role: AgentRole; optionId: string; source: 'round1' | 'round2'; flipIgnored: boolean; weight: number; counted: boolean }>;
  falsifiedOptions: string[];
  objections: Array<{ id: string; targetOptionId: string; severity: CouncilObjection['severity']; kind: CouncilObjection['kind']; claim: string; status: 'active' | 'unverified' | 'refuted' | 'falsified_by_check'; rebutted: boolean }>;
  tieBreak: string[] | null;
  dissent: string[];
  adrRefs: string[];
  reasons: string[];
}

const REVERSIBILITY_RANK = { easy: 0, moderate: 1, hard: 2 } as const;
const SIZE_RANK = { small: 0, medium: 1, large: 2 } as const;
const COST_RANK = { low: 0, medium: 1, high: 2 } as const;
const TIE_MARGIN = 0.1;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Critic diversity relative to the members that produced a proposal. */
export function councilDiversity(state: Pick<CouncilState, 'proposals' | 'critique'>): CouncilDiversity {
  const critic = state.critique;
  if (!critic?.body.ok || !critic.provider || !critic.modelId) return 'none';
  const members = state.proposals.filter((p) => p.body.ok);
  const providers = new Set(members.map((m) => m.provider));
  const models = new Set(members.map((m) => m.modelId));
  if (!providers.has(critic.provider)) return 'cross_provider';
  if (!models.has(critic.modelId)) return 'cross_model';
  return 'none';
}

/** Options by id: seeded options first, then proposals. Ratings are merged conservatively (the worst rating wins). */
function mergeOptions(brief: CouncilBrief | null, proposals: readonly MemberTurn<CouncilProposal>[]): Map<string, CouncilOption> {
  const options = new Map<string, CouncilOption & { rated: boolean }>();
  for (const seed of brief?.seedOptions ?? []) options.set(seed.id, { ...seed, rated: false });
  for (const proposal of proposals) {
    if (!proposal.body.ok) continue;
    for (const option of proposal.body.output.options) {
      const existing = options.get(option.id);
      if (!existing || !existing.rated) {
        options.set(option.id, { ...option, summary: existing?.summary ?? option.summary, rated: true });
        continue;
      }
      existing.reversibility = REVERSIBILITY_RANK[option.reversibility] > REVERSIBILITY_RANK[existing.reversibility] ? option.reversibility : existing.reversibility;
      existing.blastRadius = SIZE_RANK[option.blastRadius] > SIZE_RANK[existing.blastRadius] ? option.blastRadius : existing.blastRadius;
      existing.estimatedCost = COST_RANK[option.estimatedCost] > COST_RANK[existing.estimatedCost] ? option.estimatedCost : existing.estimatedCost;
    }
  }
  return new Map([...options.entries()].sort((a, b) => byId(a[0], b[0])).map(([id, { rated: _rated, ...option }]) => [id, option]));
}

/**
 * `decideCouncil` (plan §4.5). Evidence beats votes:
 * 1. options falsified by an executed check are removed, whatever the votes;
 * 2. an active objection about product intent parks (the council settles how, never what the user wants);
 * 3. an active ADR-conflict objection parks (only a human can change an ADR), even if rebutted;
 * 4. an active blocking objection that nobody rebutted with verified evidence parks;
 * 5. a round-2 vote that differs from the member's round-1 recommendation counts only when `changedBecause` names an
 *    active objection or verified evidence the member did not produce; otherwise the round-1 recommendation counts;
 * 6. a vote weighs 1.0 when the member's own evidence verified, 0.5 without verified evidence and 0.25 when the member
 *    cited evidence that was refuted (fabricated quotes); self-reported confidence never weighs;
 * 7. near ties (< 0.1) go to the more reversible option, then smaller blast radius, then precedent support, then lower
 *    cost, else park; the tied group's combined support is the agreement;
 * 8. confidence = agreement × calibration must reach the threshold plus the diversity penalty; a council without model
 *    diversity parks.
 */
export function decideCouncil(state: CouncilState, rule: CouncilDecisionRule): CouncilSynthesis {
  const reasons: string[] = [];
  const options = mergeOptions(state.brief, state.proposals);
  const diversity = councilDiversity(state);
  const singleProvider = diversity !== 'cross_provider';
  const evidence = new Map<string, VerifiedEvidence>([...(state.evidence1 ?? []), ...(state.evidence2 ?? [])].map((e) => [e.id, e]));
  const experimentResults = state.experiment && !state.experiment.skipped ? state.experiment.results : [];
  const members = state.proposals.filter((p): p is MemberTurn<CouncilProposal> & { body: { ok: true; output: CouncilProposal } } => p.body.ok);

  const base: CouncilSynthesis = {
    outcome: 'parked',
    chosenOptionId: null,
    chosenOption: null,
    parkReason: null,
    leadingOptionId: null,
    confidence: 0,
    agreement: 0,
    threshold: round3(Math.min(0.99, rule.threshold + (diversity === 'cross_provider' ? 0 : rule.singleProviderPenalty))),
    diversity,
    singleProvider,
    options: [...options.values()],
    support: [],
    votes: [],
    falsifiedOptions: [],
    objections: [],
    tieBreak: null,
    dissent: [],
    adrRefs: [],
    reasons,
  };
  const park = (synthesis: CouncilSynthesis, reason: CouncilParkReason, detail: string): CouncilSynthesis => ({
    ...synthesis,
    outcome: 'parked',
    chosenOptionId: null,
    chosenOption: null,
    parkReason: reason,
    reasons: [...reasons, detail],
  });

  if (members.length === 0) return park(base, 'no_proposals', 'no council member produced a valid proposal');
  if (!state.critique?.body.ok) return park(base, 'critic_unavailable', 'the critic produced no valid critique; an unchallenged council does not decide');

  // 1. Executed checks falsify options.
  const falsified = new Set(experimentResults.filter((r) => !r.passed).map((r) => r.optionId));
  for (const optionId of [...falsified].sort(byId)) reasons.push(`option ${optionId} was falsified by an executed check`);

  // Objections: verified evidence makes them active; a refuted citation or a passing falsifier check discredits them.
  const statusOf = (ids: string[]) => ({ verified: ids.some((id) => evidence.get(id)?.status === 'verified'), refuted: ids.some((id) => evidence.get(id)?.status === 'refuted') });
  const rebuttedBy = (objectionId: string) =>
    state.votes.some(
      (vote) =>
        vote.body.ok &&
        vote.body.output.responses.some((response, r) => response.objectionId === objectionId && response.stance === 'rebut' && response.evidence.some((_, i) => evidence.get(voteEvidenceId(vote.role, r, i))?.status === 'verified')),
    );
  const objections = state.critique.body.output.objections.map((objection) => {
    const ids = objection.evidence.map((_, i) => objectionEvidenceId(objection.id, i));
    const { verified, refuted } = statusOf(ids);
    const passedCheck = experimentResults.some((r) => r.objectionId === objection.id && r.passed);
    const status = passedCheck ? ('falsified_by_check' as const) : refuted ? ('refuted' as const) : verified ? ('active' as const) : ('unverified' as const);
    return { ...objection, status, rebutted: rebuttedBy(objection.id) };
  });
  const synthesisObjections = objections.map(({ id, targetOptionId, severity, kind, claim, status, rebutted }) => ({ id, targetOptionId, severity, kind, claim: claim.slice(0, 500), status, rebutted }));
  const withObjections = { ...base, objections: synthesisObjections, falsifiedOptions: [...falsified].sort(byId) };
  const active = objections.filter((o) => o.status === 'active');

  // 5.–6. Effective votes and weights (computed first so a parked synthesis still names the leading option).
  const activeIds = new Set(active.map((o) => o.id));
  const validChange = (role: AgentRole, ref: string | null): boolean => {
    if (!ref) return false;
    if (activeIds.has(ref)) return true;
    if (ref.startsWith(`ev-p-${role}-`) || ref.startsWith(`ev-v-${role}-`)) return false;
    return evidence.get(ref)?.status === 'verified' || experimentResults.some((r) => checkEvidenceId(r.name) === ref);
  };
  const weightOf = (role: AgentRole): number => {
    const own = [...evidence.values()].filter((e) => e.id.startsWith(`ev-p-${role}-`) || e.id.startsWith(`ev-v-${role}-`));
    if (own.some((e) => e.status === 'refuted')) return 0.25;
    return own.some((e) => e.status === 'verified') ? 1 : 0.5;
  };

  const votes: CouncilSynthesis['votes'] = [];
  for (const member of members) {
    const roundOne = member.body.output.recommendedOptionId;
    const vote = state.votes.find((v) => v.role === member.role && v.body.ok);
    let optionId = roundOne;
    let source: 'round1' | 'round2' = 'round1';
    let flipIgnored = false;
    if (vote?.body.ok) {
      if (vote.body.output.optionId === roundOne) source = 'round2';
      else if (validChange(member.role, vote.body.output.changedBecause)) {
        optionId = vote.body.output.optionId;
        source = 'round2';
      } else {
        flipIgnored = true;
        reasons.push(`${member.role} changed from ${roundOne} to ${vote.body.output.optionId} without new verified evidence; the change is ignored`);
      }
    }
    const viable = optionId === 'park' || (options.has(optionId) && !falsified.has(optionId));
    if (!viable) reasons.push(`${member.role}'s vote for ${optionId} does not count (${falsified.has(optionId) ? 'falsified' : 'unknown option'})`);
    votes.push({ role: member.role, optionId, source, flipIgnored, weight: weightOf(member.role), counted: viable });
  }

  const counted = votes.filter((v) => v.counted);
  const parkWeight = counted.filter((v) => v.optionId === 'park').reduce((sum, v) => sum + v.weight, 0);
  const supportMap = new Map<string, { weight: number; voters: string[] }>();
  for (const vote of counted) {
    if (vote.optionId === 'park') continue;
    const entry = supportMap.get(vote.optionId) ?? { weight: 0, voters: [] };
    entry.weight += vote.weight;
    entry.voters.push(vote.role);
    supportMap.set(vote.optionId, entry);
  }
  const support = [...supportMap.entries()]
    .map(([optionId, entry]) => ({ optionId, weight: round3(entry.weight), voters: [...entry.voters].sort(byId) }))
    .sort((a, b) => b.weight - a.weight || byId(a.optionId, b.optionId));
  const total = support.reduce((sum, s) => sum + s.weight, 0);
  const withVotes: CouncilSynthesis = { ...withObjections, votes, support, leadingOptionId: support[0]?.optionId ?? null };

  // 2.–4. Objections that park, whatever the votes.
  const intent = active.find((o) => o.kind === 'product_intent');
  if (intent) return park(withVotes, 'product_intent', `objection ${intent.id}: the options differ in what the user gets; product intent is not guessed`);
  const adrConflict = active.find((o) => o.kind === 'adr_conflict');
  if (adrConflict) return park(withVotes, 'adr_conflict', `objection ${adrConflict.id}: verified conflict with an accepted ADR`);
  const blocking = active.find((o) => o.severity === 'blocking' && !o.rebutted);
  if (blocking) return park(withVotes, 'blocking_objection', `blocking objection ${blocking.id} has verified evidence and no verified rebuttal`);

  if (total === 0 && parkWeight === 0) return park(withVotes, 'no_viable_option', 'no vote for a viable option remained');
  if (parkWeight >= total) return park(withVotes, 'members_voted_park', `park votes (${round3(parkWeight)}) outweigh option votes (${round3(total)})`);

  // 7. Near ties.
  const lead = support[0]!;
  const tied = support.filter((s) => lead.weight - s.weight < TIE_MARGIN);
  let chosenId: string | null = lead.optionId;
  let tieBreak: string[] | null = null;
  let agreement = lead.weight / total;
  if (tied.length > 1) {
    tieBreak = [`tie between ${tied.map((t) => t.optionId).join(', ')}`];
    const hasPrecedent = (optionId: string) =>
      members.some((m) =>
        m.body.output.claims.some(
          (claim, c) => claim.optionId === optionId && claim.evidence.some((item, i) => item.type !== 'file' && item.type !== 'check' && evidence.get(proposalEvidenceId(m.role, c, i))?.status === 'verified'),
        ),
      );
    let candidates = tied.map((t) => options.get(t.optionId)!);
    const narrow = (label: string, score: (option: CouncilOption) => number) => {
      if (candidates.length < 2) return;
      const best = Math.min(...candidates.map(score));
      const next = candidates.filter((option) => score(option) === best);
      if (next.length < candidates.length) tieBreak!.push(`${label}: ${next.map((o) => o.id).join(', ')}`);
      candidates = next;
    };
    narrow('more reversible', (o) => REVERSIBILITY_RANK[o.reversibility]);
    narrow('smaller blast radius', (o) => SIZE_RANK[o.blastRadius]);
    narrow('backed by a verified precedent', (o) => (hasPrecedent(o.id) ? 0 : 1));
    narrow('lower estimated cost', (o) => COST_RANK[o.estimatedCost]);
    if (candidates.length !== 1) {
      return park({ ...withVotes, tieBreak: [...tieBreak, 'still tied'] }, 'tie', `tie between ${tied.map((t) => t.optionId).join(', ')} could not be broken`);
    }
    chosenId = candidates[0]!.id;
    // The council agrees that one of the tied options is acceptable; the tie-break picks the safest of them.
    agreement = tied.reduce((sum, t) => sum + t.weight, 0) / total;
  }

  // 8. Confidence, threshold and diversity.
  const confidence = round3(agreement * rule.calibration);
  const synthesis: CouncilSynthesis = {
    ...withVotes,
    leadingOptionId: chosenId,
    agreement: round3(agreement),
    confidence,
    tieBreak,
    dissent: votes.filter((v) => v.counted && v.optionId !== chosenId).map((v) => `${v.role} preferred ${v.optionId}`),
    adrRefs: [
      ...new Set(
        [...evidence.values()]
          .filter((e) => e.type === 'adr' && e.status === 'verified' && !e.id.startsWith('ev-c-'))
          .map((e) => e.ref.toUpperCase().replace(/^ADR[-\s]?(\d+)$/, (_, n: string) => `ADR-${n.padStart(3, '0')}`)),
      ),
    ].sort(byId),
  };
  if (diversity === 'none') return park(synthesis, 'no_model_diversity', 'the critic ran on the same model as the members; without model diversity the council only advises');
  if (confidence < synthesis.threshold) {
    return park(synthesis, 'low_confidence', `confidence ${confidence} is below the threshold ${synthesis.threshold}${singleProvider ? ' (raised: single provider)' : ''}`);
  }
  const chosen = options.get(chosenId!)!;
  return { ...synthesis, outcome: 'decided', chosenOptionId: chosen.id, chosenOption: chosen, parkReason: null, reasons: [...reasons, `decided ${chosen.id} with confidence ${confidence} (${diversity})`] };
}

/** A synthesis for a council stopped by a bound (cost, tokens, time, budget) before it could decide. */
export function boundedSynthesis(state: CouncilState, reason: Extract<CouncilParkReason, 'budget' | 'cost_cap' | 'token_limit' | 'timeout'>, detail: string): CouncilSynthesis {
  const options = [...mergeOptions(state.brief, state.proposals).values()];
  return {
    outcome: 'parked',
    chosenOptionId: null,
    chosenOption: null,
    parkReason: reason,
    leadingOptionId: null,
    confidence: 0,
    agreement: 0,
    threshold: state.brief?.threshold ?? 0,
    diversity: councilDiversity(state),
    singleProvider: councilDiversity(state) !== 'cross_provider',
    options,
    support: [],
    votes: [],
    falsifiedOptions: [],
    objections: [],
    tieBreak: null,
    dissent: [],
    adrRefs: [],
    reasons: [detail],
  };
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/** Council members per decision type (plan §4.1), at most three; the critic is always added separately. */
export function councilParticipants(type: CouncilDecisionType, touchedAreas: readonly string[] = []): AgentRole[] {
  const areas = touchedAreas.join(' ').toLowerCase();
  const domain: AgentRole = /\b(db|database|schema|migration|sql)\b/.test(areas) ? 'database' : /\b(ui|web|frontend|page|component|css)\b/.test(areas) ? 'frontend' : 'backend';
  switch (type) {
    case 'design_choice':
      return ['architect', domain, 'reviewer'];
    case 'clarification':
      return ['planner', 'reviewer'];
    case 'blocker_resolution':
      return ['debugger', 'architect', 'tester'];
    case 'test_strategy':
      return ['tester', 'reviewer'];
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ExperimentRunner {
  /** Runs one allow-listed project check against a scratch change set (sandbox only); null when it cannot run. */
  run(input: { projectId: string; runId: string | null; check: string; optionId: string; objectionId: string }): Promise<CheckResult | null>;
}

export interface CouncilTurnSink {
  /** Best effort projection of a stored turn (e.g. into the Project Room). Failures never fail the council. */
  publish(council: CouncilRecord, turn: CouncilTurnRecord, state: CouncilState): Promise<void>;
}

export interface CouncilRunnerDeps {
  runtime: AgentRuntime;
  councils: CouncilRepository;
  clock: Clock;
  events?: EventRecorder;
  sink?: CouncilTurnSink;
  experiments?: ExperimentRunner;
  onError?: (error: unknown) => void;
}

export interface CouncilBounds {
  maxCostUsd: number;
  maxTokens: number;
  timeoutMs: number;
  rounds: 1 | 2;
  /** Remaining run budget; each call is additionally limited by it. null = no run limit. */
  runBudgetRemainingUsd: number | null;
}

export interface CouncilRunInput {
  requestId: string;
  projectId: string;
  sessionId: string | null;
  runId: string | null;
  /** Resume an existing council from its stored turns. */
  councilId: string | null;
  decisionType: CouncilDecisionType;
  question: string;
  members: readonly AgentRole[];
  seedOptions: readonly CouncilOption[];
  constraints: CouncilBrief['constraints'];
  /** Untrusted repository excerpts and research findings shared with every participant. */
  context: readonly UntrustedEntry[];
  agent: { baseInput: AgentInput; scope: AgentScope; complexity: Complexity; risk: Risk; projectRoleOverrides?: Partial<Record<AgentRole, string>> };
  bounds: CouncilBounds;
  rule: CouncilDecisionRule;
  evidence: EvidenceSources;
  /** Check names an experiment may run (project profile commands). */
  allowedChecks: readonly string[];
}

export interface CouncilRunResult {
  council: CouncilRecord;
  synthesis: CouncilSynthesis;
  /** Spend of this invocation (a resumed council only reports new calls). */
  costUsd: number;
  tokens: number;
}

const MAX_CONTEXT_CHARS = 3_000;

function renderOptions(options: Iterable<CouncilOption>): UntrustedEntry[] {
  return [...options].map((o) => ({ label: `option ${o.id} (reversibility ${o.reversibility}, blast radius ${o.blastRadius}, cost ${o.estimatedCost})`, text: o.summary }));
}

function renderEvidence(items: readonly EvidenceItem[]): string {
  return items.map((e) => `[${e.type} ${e.ref}${e.quote ? `: "${e.quote}"` : ''}]`).join(' ');
}

/** Runs (or resumes) one council to its synthesis. Every model call is bounded and every step persisted. */
export async function runCouncilProtocol(deps: CouncilRunnerDeps, input: CouncilRunInput): Promise<CouncilRunResult> {
  const { councils, runtime, clock } = deps;
  let council = input.councilId ? await councils.get(input.councilId) : null;
  if (!council) {
    council = await councils.create({
      requestId: input.requestId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      decisionType: input.decisionType,
      question: input.question.slice(0, 2_000),
      deadlineAt: new Date(clock.now().getTime() + input.bounds.timeoutMs),
    });
    await deps.events?.emit({
      type: 'council.started',
      projectId: input.projectId,
      taskId: input.agent.scope.taskId,
      runId: input.runId,
      payload: { councilId: council.id, requestId: input.requestId, decisionType: input.decisionType, members: [...input.members] },
    });
  }
  const current = council;
  let state = councilState(await councils.turns(current.id));
  let spentUsd = 0;
  let spentTokens = 0;

  const append = async (turn: Omit<NewCouncilTurn, 'councilId' | 'seq'>) => {
    const stored = await councils.appendTurn({ ...turn, councilId: current.id, seq: state.nextSeq });
    state = councilState([...(await councils.turns(current.id))]);
    if (deps.sink) {
      try {
        await deps.sink.publish(current, stored, state);
      } catch (error) {
        deps.onError?.(error);
      }
    }
    return stored;
  };

  const participants = (): CouncilParticipant[] => [
    ...state.proposals.map((p) => ({ role: p.role, stance: 'member' as const, modelId: p.modelId, provider: p.provider })),
    ...(state.critique ? [{ role: state.critique.role, stance: 'critic' as const, modelId: state.critique.modelId, provider: state.critique.provider }] : []),
  ];
  const progress = () => councils.recordProgress(current.id, { participants: participants(), roundsUsed: state.votes.length > 0 ? 2 : state.proposals.length > 0 ? 1 : 0, costUsd: round6(state.costUsd), tokens: state.tokens });

  const boundHit = (): { reason: 'cost_cap' | 'token_limit' | 'timeout'; detail: string } | null => {
    if (state.costUsd >= input.bounds.maxCostUsd) return { reason: 'cost_cap', detail: `council spent $${state.costUsd.toFixed(4)} of its $${input.bounds.maxCostUsd.toFixed(2)} cap` };
    if (state.tokens >= input.bounds.maxTokens) return { reason: 'token_limit', detail: `council used ${state.tokens} of ${input.bounds.maxTokens} tokens` };
    if (clock.now().getTime() >= current.deadlineAt.getTime()) return { reason: 'timeout', detail: `council deadline ${current.deadlineAt.toISOString()} passed` };
    return null;
  };
  const callBudget = () => {
    const remaining = input.bounds.maxCostUsd - state.costUsd;
    return input.bounds.runBudgetRemainingUsd === null ? remaining : Math.min(remaining, input.bounds.runBudgetRemainingUsd - spentUsd);
  };

  const call = async <T>(definition: AgentDefinition, role: AgentRole, sections: AgentInput['sections'], diversity?: { avoidProviders?: string[]; avoidModelIds?: string[] }) => {
    const outcome = (await runtime.run({
      definition,
      role,
      input: { ...input.agent.baseInput, sections: [...input.agent.baseInput.sections, ...sections] },
      scope: input.agent.scope,
      complexity: input.agent.complexity,
      risk: input.agent.risk,
      runBudgetRemainingUsd: Math.max(0, callBudget()),
      ...(input.agent.projectRoleOverrides ? { projectRoleOverrides: input.agent.projectRoleOverrides } : {}),
      ...(diversity ? { diversity } : {}),
    })) as AgentOutcome<T>;
    spentUsd += outcome.costUsd;
    spentTokens += totalTokens(outcome.usage);
    return outcome;
  };
  const turnOf = <T>(outcome: AgentOutcome<T>) => ({
    body: outcome.ok ? { ok: true, output: outcome.output as unknown } : { ok: false, error: `${outcome.kind}: ${outcome.error}`.slice(0, 500) },
    modelId: outcome.model?.id ?? null,
    provider: outcome.model?.provider ?? null,
    costUsd: outcome.costUsd,
    tokens: totalTokens(outcome.usage),
  });

  const brief = (): CouncilBrief => state.brief!;
  const briefSections = (role: AgentRole | null): AgentInput['sections'] => [
    {
      title: 'Council brief',
      body: [
        `Decision type: ${brief().decisionType}`,
        role ? `Your perspective: ${role}` : 'You are the critic.',
        `Task risk: ${brief().risk}`,
        `Council members: ${brief().members.join(', ')}`,
        delimitUntrusted('decision_question', 'The question to decide.', [{ label: 'question', text: brief().question }], { maxEntryChars: 2_000 }),
      ].join('\n'),
    },
    ...(brief().seedOptions.length > 0 ? [{ title: 'Seeded options', body: delimitUntrusted('seeded_options', 'Options proposed before the council.', renderOptions(brief().seedOptions), { flatten: true }) }] : []),
    ...(brief().constraints.length > 0
      ? [{ title: 'Accepted precedents', body: delimitUntrusted('precedents', 'Accepted architecture decisions and project state that an answer must not contradict.', brief().constraints.map((c) => ({ label: `${c.ref} ${c.title}`, text: c.excerpt })), { maxEntryChars: MAX_CONTEXT_CHARS }) }]
      : []),
    ...(input.context.length > 0 ? [{ title: 'Repository context', body: delimitUntrusted('repository_context', 'Read-only repository excerpts and verified research findings.', input.context, { maxEntryChars: MAX_CONTEXT_CHARS }) }] : []),
  ];

  let step = nextCouncilStep(state);
  let synthesis: CouncilSynthesis | null = state.synthesis;
  for (let guard = 0; guard < 12 && step !== 'done'; guard++) {
    const bound = step === 'synthesis' || step === 'brief' ? null : boundHit();
    if (bound) {
      synthesis = boundedSynthesis(state, bound.reason, bound.detail);
      await append({ round: 0, kind: 'synthesis', role: 'orchestrator', stance: 'orchestrator', body: synthesis as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
      break;
    }
    switch (step) {
      case 'brief': {
        const body: CouncilBrief = {
          question: input.question.slice(0, 2_000),
          decisionType: input.decisionType,
          members: [...input.members].slice(0, 3),
          seedOptions: input.seedOptions.slice(0, 4).map((o) => ({ ...o })),
          constraints: input.constraints.slice(0, 5),
          risk: input.agent.risk,
          threshold: input.rule.threshold,
          rounds: input.bounds.rounds,
        };
        await append({ round: 0, kind: 'brief', role: 'orchestrator', stance: 'orchestrator', body: body as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        break;
      }
      case 'proposals': {
        // Round 1 is blind: nobody sees another member's position.
        const missing = brief().members.filter((role) => !state.proposals.some((p) => p.role === role));
        const outcomes = await Promise.all(missing.map(async (role) => ({ role, outcome: await call<CouncilProposal>(AGENT_DEFINITIONS.council_proposal, role, briefSections(role)) })));
        for (const { role, outcome } of outcomes) await append({ round: 1, kind: 'proposal', role, stance: 'member', ...turnOf(outcome) });
        if (outcomes.some((o) => !o.outcome.ok && o.outcome.kind === 'budget_paused')) {
          synthesis = boundedSynthesis(state, 'budget', 'the session or run budget paused a council call');
          await append({ round: 0, kind: 'synthesis', role: 'orchestrator', stance: 'orchestrator', body: synthesis as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        }
        await progress();
        break;
      }
      case 'critique': {
        const members = state.proposals.filter((p) => p.body.ok);
        const positions = members.map((m) => {
          const output = (m.body as { ok: true; output: CouncilProposal }).output;
          return {
            label: `${m.role} recommends ${output.recommendedOptionId}`,
            text: [
              `Options: ${output.options.map((o) => `${o.id}: ${o.summary}`).join(' | ')}`,
              `Claims: ${output.claims.map((c) => `${c.text} ${renderEvidence(c.evidence)}`).join(' | ')}`,
              `Assumptions: ${output.assumptions.join(' | ')}`,
            ].join(' '),
          };
        });
        const sections = [...briefSections(null), { title: 'Member positions', body: delimitUntrusted('member_positions', 'Round-1 positions of the council members (roles only).', positions, { flatten: true, maxEntryChars: 2_500 }) }];
        const providers = [...new Set(members.map((m) => m.provider).filter((p): p is string => p !== null))];
        const models = [...new Set(members.map((m) => m.modelId).filter((m): m is string => m !== null))];
        // Prefer another provider, then another model; only then accept the members' model (and park later).
        let outcome = await call<CouncilCritique>(AGENT_DEFINITIONS.council_critique, 'critic', sections, { avoidProviders: providers });
        if (!outcome.ok && outcome.kind === 'no_model') outcome = await call<CouncilCritique>(AGENT_DEFINITIONS.council_critique, 'critic', sections, { avoidModelIds: models });
        if (!outcome.ok && outcome.kind === 'no_model') outcome = await call<CouncilCritique>(AGENT_DEFINITIONS.council_critique, 'critic', sections);
        await append({ round: 1, kind: 'critique', role: 'critic', stance: 'critic', ...turnOf(outcome) });
        await progress();
        if (!outcome.ok && outcome.kind === 'budget_paused') {
          synthesis = boundedSynthesis(state, 'budget', 'the session or run budget paused the critic');
          await append({ round: 0, kind: 'synthesis', role: 'orchestrator', stance: 'orchestrator', body: synthesis as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        }
        break;
      }
      case 'evidence_1': {
        const items = await verifyEvidence(roundOneEvidence(state), input.evidence);
        await append({ round: 1, kind: 'evidence_result', role: 'orchestrator', stance: 'orchestrator', body: { round: 1, items }, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        break;
      }
      case 'experiment': {
        await append({ round: 1, kind: 'experiment', role: 'orchestrator', stance: 'orchestrator', body: (await runExperiment(deps, input, state)) as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        break;
      }
      case 'votes': {
        const members = state.proposals.filter((p) => p.body.ok && !state.votes.some((v) => v.role === p.role));
        const options = mergeOptions(state.brief, state.proposals);
        const verified = new Map((state.evidence1 ?? []).map((e) => [e.id, e]));
        const critique = state.critique?.body.ok ? state.critique.body.output : null;
        const outcomes = await Promise.all(
          members.map(async (member) => {
            const own = (member.body as { ok: true; output: CouncilProposal }).output;
            const others = state.proposals
              .filter((p) => p.body.ok && p.role !== member.role)
              .map((p) => {
                const output = (p.body as { ok: true; output: CouncilProposal }).output;
                return { label: `${p.role} recommends ${output.recommendedOptionId}`, text: output.claims.map((c, ci) => `${c.text} ${c.evidence.map((_, i) => `(${proposalEvidenceId(p.role, ci, i)}: ${verified.get(proposalEvidenceId(p.role, ci, i))?.status ?? 'unverified'})`).join(' ')}`).join(' | ') };
              });
            const objections = (critique?.objections ?? []).map((o) => ({
              label: `${o.id} (${o.severity}, ${o.kind}) against ${o.targetOptionId}`,
              text: `${o.claim} ${o.evidence.map((_, i) => `(${objectionEvidenceId(o.id, i)}: ${verified.get(objectionEvidenceId(o.id, i))?.status ?? 'unverified'})`).join(' ')}`,
            }));
            const checks = state.experiment && !state.experiment.skipped ? state.experiment.results.map((r) => ({ label: `${checkEvidenceId(r.name)} for ${r.optionId}`, text: `${r.passed ? 'passed' : 'failed'}: ${r.detail}` })) : [];
            const sections: AgentInput['sections'] = [
              ...briefSections(member.role),
              { title: 'All options', body: delimitUntrusted('council_options', 'Options after round 1.', renderOptions(options.values()), { flatten: true }) },
              { title: 'Your round-1 recommendation', body: own.recommendedOptionId },
              { title: 'Other members', body: delimitUntrusted('member_positions', 'Round-1 positions of the other members with verification status of their evidence.', others, { flatten: true, maxEntryChars: 2_000 }) },
              { title: 'Objections', body: delimitUntrusted('objections', 'Objections raised by the critic with verification status.', objections, { flatten: true }) },
              ...(checks.length > 0 ? [{ title: 'Executed checks', body: delimitUntrusted('checks', 'Results of executed project checks.', checks, { flatten: true }) }] : []),
            ];
            return { role: member.role, outcome: await call<CouncilVote>(AGENT_DEFINITIONS.council_vote, member.role, sections) };
          }),
        );
        for (const { role, outcome } of outcomes) await append({ round: 2, kind: 'vote', role, stance: 'member', ...turnOf(outcome) });
        await progress();
        if (outcomes.some((o) => !o.outcome.ok && o.outcome.kind === 'budget_paused')) {
          synthesis = boundedSynthesis(state, 'budget', 'the session or run budget paused a council vote');
          await append({ round: 0, kind: 'synthesis', role: 'orchestrator', stance: 'orchestrator', body: synthesis as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        }
        break;
      }
      case 'evidence_2': {
        const items = await verifyEvidence(roundTwoEvidence(state), input.evidence);
        await append({ round: 2, kind: 'evidence_result', role: 'orchestrator', stance: 'orchestrator', body: { round: 2, items }, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        break;
      }
      case 'synthesis': {
        synthesis = decideCouncil(state, input.rule);
        await append({ round: 0, kind: 'synthesis', role: 'orchestrator', stance: 'orchestrator', body: synthesis as unknown as Record<string, unknown>, modelId: null, provider: null, costUsd: 0, tokens: 0 });
        break;
      }
    }
    step = nextCouncilStep(state);
  }

  synthesis ??= state.synthesis ?? boundedSynthesis(state, 'timeout', 'the council did not converge within its step bound');
  await progress();
  const finished =
    (await councils.finish(current.id, {
      status: synthesis.outcome,
      chosenOptionId: synthesis.chosenOptionId,
      confidence: synthesis.confidence,
      parkReason: synthesis.parkReason,
      diversity: synthesis.diversity,
      finishedAt: clock.now(),
    })) ?? (await councils.get(current.id))!;
  if (current.status === 'running') {
    await deps.events?.emit({
      type: 'council.finished',
      projectId: input.projectId,
      taskId: input.agent.scope.taskId,
      runId: input.runId,
      payload: { councilId: current.id, requestId: input.requestId, outcome: synthesis.outcome, diversity: synthesis.diversity, confidence: synthesis.confidence, parkReason: synthesis.parkReason },
    });
  }
  return { council: finished, synthesis, costUsd: round6(spentUsd), tokens: spentTokens };
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** At most one experiment: the first blocking/major objection whose falsifier is an allow-listed check. */
async function runExperiment(deps: CouncilRunnerDeps, input: CouncilRunInput, state: CouncilState): Promise<ExperimentBody> {
  const critique = state.critique?.body.ok ? state.critique.body.output : null;
  const allowed = new Set(input.allowedChecks.map((c) => c.toLowerCase()));
  const candidate = critique?.objections.find((o) => (o.severity === 'blocking' || o.severity === 'major') && o.falsifier !== null && allowed.has(o.falsifier.toLowerCase()));
  if (!candidate) return { skipped: true, reason: 'no objection names an allow-listed check as falsifier' };
  if (!deps.experiments) return { skipped: true, reason: `experiment "${candidate.falsifier}" skipped: no sandbox is available` };
  const result = await deps.experiments.run({ projectId: input.projectId, runId: input.runId, check: candidate.falsifier!.toLowerCase(), optionId: candidate.targetOptionId, objectionId: candidate.id });
  if (!result) return { skipped: true, reason: `experiment "${candidate.falsifier}" could not run` };
  return { skipped: false, results: [{ ...result, detail: result.detail.slice(0, 500), objectionId: candidate.id, optionId: candidate.targetOptionId }] };
}
