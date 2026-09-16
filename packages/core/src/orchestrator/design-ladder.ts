import type { AgentInput } from '../agents/definitions';
import type { CouncilOption, PlanOutput } from '../agents/schemas';
import { councilParticipants, type CouncilRepository, type CouncilTurnSink, type ExperimentRunner } from '../autopilot/council-protocol';
import type { EvidenceSources } from '../autopilot/evidence';
import {
  DecisionLadder,
  decisionRequestFingerprint,
  DEFAULT_LADDER_SETTINGS,
  type DecisionRequest,
  type DecisionRequestRepository,
  type LadderRung,
  type LadderSettings,
} from '../autopilot/ladder';
import { buildPrecedents, DECISIONS_DOC_PATH, MAX_PRECEDENT_DOC_CHARS, parseAdrSections, STATE_DOC_PATH } from '../autopilot/precedents';
import { buildContext } from '../context/context-builder';
import type { DecisionOrigin } from '../domain/records';
import { isSecurityRelevant } from '../pipeline/stage-planner';
import { truncate } from './helpers';
import { baseInput, loadIndex, requestApproval, type StageContext, type StageOutcome } from './stages';

// DESIGN inside an active autopilot session (docs/plans/autopilot.md stage 2+3): the design question climbs the
// decision ladder instead of the stage-1 council. Answers become provisional decisions for the return digest; anything
// the ladder cannot settle is parked as a deferred `architecture_change` approval with the council's analysis attached
// as advisory. The council never approves: only a human decision on that approval lets the run continue.

export interface DecisionLadderWiring {
  requests: DecisionRequestRepository;
  councils: CouncilRepository;
  sink?: CouncilTurnSink;
  experiments?: ExperimentRunner;
  settings?: Partial<LadderSettings>;
  onError?: (error: unknown) => void;
}

const ORIGIN_BY_RUNG: Record<Exclude<LadderRung, 'human'>, DecisionOrigin> = {
  memory: 'autopilot_precedent',
  research: 'autopilot_research',
  council: 'autopilot_council',
};

const CHECKS = new Set(['test', 'lint', 'typecheck', 'build']);
const RESEARCH_TOKEN_BUDGET = 12_000;

export async function designInSession(ctx: StageContext, input: { question: string; approach: string; plan: PlanOutput | null; sections: AgentInput['sections'] }): Promise<StageOutcome> {
  const { deps, project, run, task } = ctx;
  const wiring = deps.decisionLadder!;
  const session = ctx.session!;

  // Re-entry: the request of this run was answered, or parked and then approved by a human.
  if (run.checkpoint.decisionRequestId) {
    const existing = await wiring.requests.get(run.checkpoint.decisionRequestId);
    if (existing?.decisionId && (existing.status === 'answered' || existing.status === 'answered_by_human')) {
      run.checkpoint.designDecisionId = existing.decisionId;
      return { kind: 'passed', summary: `Decision ${existing.decisionId} already recorded for this question.` };
    }
    if (existing?.status === 'parked' && run.checkpoint.approvedActions.includes('architecture_change')) return humanAnswered(ctx, wiring, existing, input.approach);
  }

  const seed: CouncilOption = { id: 'proposed', summary: truncate(input.approach, 900), reversibility: 'moderate', blastRadius: 'medium', estimatedCost: 'medium' };
  const { request, created } = await wiring.requests.open({
    projectId: project.id,
    sessionId: session.id,
    taskId: task.id,
    runId: run.id,
    kind: 'design_choice',
    nature: 'judgment',
    question: input.question,
    options: [seed],
    fingerprint: decisionRequestFingerprint(project.id, 'design_choice', input.question),
  });
  run.checkpoint.decisionRequestId = request.id;
  if (created) {
    await deps.events.emit({ type: 'decision_request.created', projectId: project.id, taskId: task.id, runId: run.id, payload: { requestId: request.id, sessionId: session.id, kind: request.kind, question: truncate(request.question, 300) } });
  }
  if (request.status === 'answered' && request.decisionId) {
    // Another run asked the same question and it was already settled.
    run.checkpoint.designDecisionId = request.decisionId;
    return { kind: 'passed', summary: `Reused the answer of decision request ${request.id}.` };
  }

  const repo = project.repo;
  const ref = run.checkpoint.baseSha ?? repo?.defaultBranch ?? null;
  const readFile = async (path: string) => (repo && ref ? deps.github.getFileContent(repo, path, ref) : null);
  const readDoc = async (path: string) => {
    try {
      return (await readFile(path))?.slice(0, MAX_PRECEDENT_DOC_CHARS) ?? null;
    } catch {
      return null;
    }
  };
  const [decisionsDoc, stateDoc, decisions, index] = await Promise.all([
    readDoc(DECISIONS_DOC_PATH),
    readDoc(STATE_DOC_PATH),
    deps.decisions.list({ projectId: project.id, limit: 200 }),
    repo ? loadIndex(ctx) : Promise.resolve([]),
  ]);
  const adrs = decisionsDoc ? parseAdrSections(decisionsDoc) : [];
  const evidence: EvidenceSources = {
    indexPaths: new Set(index.map((f) => f.path)),
    readFile,
    adrs: new Map(adrs.map((a) => [a.id, a])),
    decisions: new Map(decisions.map((d) => [d.id, d])),
    stateDoc,
    checks: new Map(),
  };
  const research = index.length > 0 ? await buildContext({ task, files: index, tokenBudget: Math.min(ctx.options.analysisTokenBudget, RESEARCH_TOKEN_BUDGET), hints: [input.approach], maxFiles: 12 }, readFile) : null;

  const settings: LadderSettings = { ...DEFAULT_LADDER_SETTINGS, ...wiring.settings };
  const ladder = new DecisionLadder({
    runtime: deps.runtime,
    requests: wiring.requests,
    councils: wiring.councils,
    clock: deps.clock,
    events: deps.events,
    ...(wiring.sink ? { sink: wiring.sink } : {}),
    ...(wiring.experiments ? { experiments: wiring.experiments } : {}),
    ...(wiring.onError ? { onError: wiring.onError } : {}),
  });
  const { council } = project.settings;
  const result = await ladder.resolve({
    request,
    session: { id: session.id, budgetUsd: session.budgetUsd },
    agent: {
      baseInput: baseInput(ctx, input.sections),
      scope: { projectId: project.id, taskId: task.id, runId: run.id },
      complexity: task.estimatedComplexity,
      risk: task.risk,
      projectRoleOverrides: project.settings.modelOverrides,
    },
    precedents: buildPrecedents({ adrs, stateDoc, decisions }),
    evidence,
    researchFiles: research?.files ?? [],
    members: councilParticipants('design_choice', input.plan?.touchesAreas ?? []),
    council: { maxRounds: council.maxRounds, maxTokens: council.maxTokens, timeoutMs: council.timeoutMs, confidenceThreshold: council.confidenceThreshold },
    settings,
    runBudgetRemainingUsd: Math.max(0, run.limits.maxCostUsd - run.costUsd),
    allowedChecks: Object.keys(project.profile.commands).filter((name) => CHECKS.has(name)),
    policyPark: isSecurityRelevant(task) || task.risk === 'high' ? 'security-relevant or high-risk design: the council may only advise, a human decides' : null,
  });
  run.costUsd += result.costUsd;
  run.tokens += result.tokens;

  if (result.kind === 'answered') {
    const { answer } = result;
    const record = await deps.decisions.create({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      question: input.question,
      questionKey: request.fingerprint,
      options: request.options.map((o) => ({ id: o.id, summary: o.summary, pros: [], cons: [] })),
      consulted: [],
      evidence: [...answer.evidence, ...answer.dissent.map((d) => `Dissent: ${d}`)].slice(0, 30),
      decision: answer.text,
      chosenOptionId: answer.chosenOptionId,
      reason: answer.rationale,
      confidence: answer.confidence,
      costUsd: result.request.costUsd,
      supersedesId: null,
      origin: ORIGIN_BY_RUNG[result.rung === 'human' ? 'council' : result.rung],
      status: 'provisional',
      sessionId: session.id,
      requestId: request.id,
      councilId: result.request.councilId,
      adrRefs: answer.adrRefs,
    });
    await wiring.requests.update(request.id, { decisionId: record.id });
    run.checkpoint.designDecisionId = record.id;
    await deps.events.emit({ type: 'decision.made', projectId: project.id, taskId: task.id, runId: run.id, payload: { decisionId: record.id, question: input.question, confidence: record.confidence } });
    await deps.events.emit({ type: 'decision_request.resolved', projectId: project.id, taskId: task.id, runId: run.id, payload: { requestId: request.id, sessionId: session.id, rung: result.rung, decisionId: record.id } });
    return { kind: 'passed', summary: `Provisional decision via ${result.rung}: ${truncate(answer.text, 200)} (${Math.round(answer.confidence * 100)}% confidence; confirm or reject in the digest).` };
  }

  // Parked: a human decides through a deferred approval. The council's analysis is advisory only.
  const leading = result.advisory?.leadingOptionId ? `the leading option ${result.advisory.leadingOptionId}` : 'the planned approach';
  const outcome = await requestApproval(
    ctx,
    'architecture_change',
    `Design question parked for a human (${result.reason.replace(/_/g, ' ')}): ${truncate(result.detail, 400)} Approve to continue with ${leading}; reject to block the task.`,
    { decisionRequestId: request.id, parkReason: result.reason, rung: result.rung, advisory: result.advisory, question: truncate(input.question, 600) },
  );
  const approvalId = outcome.kind === 'parked' || outcome.kind === 'wait' ? (outcome.approvalId ?? null) : null;
  await wiring.requests.update(request.id, { approvalId });
  await deps.events.emit({ type: 'decision_request.parked', projectId: project.id, taskId: task.id, runId: run.id, payload: { requestId: request.id, sessionId: session.id, rung: result.rung, reason: result.reason, approvalId } });
  return outcome;
}

/** A human approved the parked design question: the run continues with the advisory option and the answer is recorded. */
async function humanAnswered(ctx: StageContext, wiring: DecisionLadderWiring, request: DecisionRequest, approach: string): Promise<StageOutcome> {
  const { deps, project, run, task } = ctx;
  const approval = request.approvalId ? await deps.approvals.get(request.approvalId) : null;
  const by = approval?.decidedBy ?? 'a human';
  const text = request.advisory?.leadingOptionId ? `${request.advisory.leadingOptionId}: ${request.advisory.summary}` : `Proceed with the planned approach: ${truncate(approach, 600)}`;
  const record = await deps.decisions.create({
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    question: request.question,
    questionKey: request.fingerprint,
    options: request.options.map((o) => ({ id: o.id, summary: o.summary, pros: [], cons: [] })),
    consulted: [],
    evidence: [`Parked (${request.parkReason ?? 'unresolved'}) and approved by ${by}`],
    decision: text,
    chosenOptionId: request.advisory?.leadingOptionId ?? null,
    reason: `The autopilot parked this question; ${by} approved continuing${approval?.comment ? `: ${approval.comment}` : '.'}`,
    confidence: 1,
    costUsd: request.costUsd,
    supersedesId: null,
    origin: 'human',
    status: 'active',
    sessionId: request.sessionId,
    requestId: request.id,
    councilId: request.councilId,
    adrRefs: [],
  });
  await wiring.requests.update(request.id, { status: 'answered_by_human', rung: 'human', decisionId: record.id, resolvedAt: deps.clock.now() });
  run.checkpoint.designDecisionId = record.id;
  await deps.events.emit({ type: 'decision.made', projectId: project.id, taskId: task.id, runId: run.id, payload: { decisionId: record.id, question: request.question, confidence: 1 } });
  await deps.events.emit({ type: 'decision_request.resolved', projectId: project.id, taskId: task.id, runId: run.id, payload: { requestId: request.id, sessionId: request.sessionId, rung: 'human', decisionId: record.id } });
  return { kind: 'passed', summary: `Design question answered by ${by}: ${truncate(text, 200)}.` };
}
