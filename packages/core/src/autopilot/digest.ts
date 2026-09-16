import type { RunStatus } from '../domain/enums';
import type { Approval, Decision, DecisionOrigin, DecisionStatus } from '../domain/records';
import type { CouncilDiversity } from './council-protocol';
import type { DecisionRequest, DecisionRequestStatus, LadderAdvisory, LadderRung } from './ladder';
import type { AutopilotSession } from './session';

/** Records a digest is computed from. Repositories return them; the builder never reads anything else. */
export interface AutopilotDigestInput {
  session: AutopilotSession;
  runs: ReadonlyArray<{
    id: string;
    taskId: string;
    projectId: string;
    status: RunStatus;
    costUsd: number;
    blockedReason: string | null;
    prNumber: number | null;
    prUrl: string | null;
    outcome: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
  taskTitles: ReadonlyMap<string, string>;
  approvals: readonly Approval[];
  decisions: readonly Decision[];
  /** Decision requests (ladder questions) of the session. */
  decisionRequests: readonly DecisionRequest[];
  /** Ledger spend of session runs while the session was active, per project. */
  costByProject: ReadonlyArray<{ projectId: string; costUsd: number }>;
}

export interface AutopilotDigest {
  sessionId: string;
  /** The session end, or the evaluation time for an active session. */
  asOf: string;
  status: AutopilotSession['status'];
  demo: boolean;
  window: { startsAt: string; endsAt: string; endedAt: string | null };
  stop: { reason: string | null; detail: string | null; by: string | null };
  totals: DigestRunCounts & { pullRequests: number; decisions: number; decisionsToReview: number; questionsParked: number };
  /** Run counts per project, so viewers restricted to some projects get totals of their projects only. */
  projects: Array<DigestRunCounts & { projectId: string }>;
  pullRequests: Array<{ runId: string; taskId: string; projectId: string; taskTitle: string; number: number; url: string | null; outcome: string | null }>;
  parkedApprovals: Array<{ approvalId: string; projectId: string; runId: string | null; taskId: string | null; taskTitle: string | null; action: string; reason: string; status: Approval['status']; expiresAt: string | null; decidedBy: string | null }>;
  failures: Array<{ runId: string; taskId: string; projectId: string; taskTitle: string; status: RunStatus; reason: string }>;
  decisions: DigestDecision[];
  /** Questions the ladder handled: answered (with the rung that settled them) and parked for a human. */
  questions: DigestQuestion[];
  /** decisionsUsd: ledger spend of the decision ladder (precedent checks, research, councils), part of totalUsd. */
  costs: { totalUsd: number; budgetUsd: number; budgetUsedPct: number; decisionsUsd: number; byProject: Array<{ projectId: string; costUsd: number }> };
}

export interface DigestDecision {
  decisionId: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  question: string;
  decision: string;
  reason: string;
  confidence: number;
  origin: DecisionOrigin;
  /** provisional decisions wait for a human to confirm or reject them. */
  status: DecisionStatus;
  requestId: string | null;
  councilId: string | null;
  adrRefs: string[];
  diversity: CouncilDiversity | null;
  singleProvider: boolean;
  dissent: string[];
  reviewedBy: string | null;
  reviewComment: string | null;
  createdAt: string;
}

export interface DigestQuestion {
  requestId: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  runId: string | null;
  kind: string;
  question: string;
  status: DecisionRequestStatus;
  rung: LadderRung | null;
  trail: Array<{ rung: LadderRung; outcome: string; detail: string }>;
  parkReason: string | null;
  advisory: LadderAdvisory | null;
  decisionId: string | null;
  approvalId: string | null;
  councilId: string | null;
  costUsd: number;
  createdAt: string;
}

export interface DigestRunCounts {
  runsStarted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inProgress: number;
  parked: number;
}

const MAX_ITEMS = 200;

function countRuns(runs: ReadonlyArray<{ status: RunStatus }>): DigestRunCounts {
  const count = (statuses: readonly RunStatus[]) => runs.filter((r) => statuses.includes(r.status)).length;
  return {
    runsStarted: runs.length,
    succeeded: count(['SUCCEEDED']),
    failed: count(['BLOCKED', 'FAILED']),
    cancelled: count(['CANCELLED']),
    inProgress: count(['QUEUED', 'RUNNING', 'WAITING', 'PAUSED']),
    parked: count(['PARKED']),
  };
}

function sumCounts(items: readonly DigestRunCounts[]): DigestRunCounts {
  const total: DigestRunCounts = { runsStarted: 0, succeeded: 0, failed: 0, cancelled: 0, inProgress: 0, parked: 0 };
  for (const item of items) for (const key of Object.keys(total) as Array<keyof DigestRunCounts>) total[key] += item[key];
  return total;
}

const money = (value: number) => Math.round(value * 1e6) / 1e6;
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const byTimeThenId = <T>(time: (item: T) => number, id: (item: T) => string) => (a: T, b: T) => time(a) - time(b) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

/**
 * The deterministic return digest ("While you were away"). A pure function of the records: the same records in any
 * order produce the same digest, and every number is an aggregate of them (no model-written text).
 */
export function buildAutopilotDigest(input: AutopilotDigestInput, now: Date): AutopilotDigest {
  const { session } = input;
  const title = (taskId: string | null) => (taskId ? (input.taskTitles.get(taskId) ?? taskId) : null);
  const runs = [...input.runs].sort(byTimeThenId((r) => r.startedAt.getTime(), (r) => r.id));
  const runIds = new Set(runs.map((r) => r.id));

  const pullRequests = runs
    .filter((r) => r.prNumber !== null)
    .map((r) => ({ runId: r.id, taskId: r.taskId, projectId: r.projectId, taskTitle: title(r.taskId)!, number: r.prNumber!, url: r.prUrl, outcome: r.outcome }));

  const failures = runs
    .filter((r) => r.status === 'BLOCKED' || r.status === 'FAILED')
    .map((r) => ({ runId: r.id, taskId: r.taskId, projectId: r.projectId, taskTitle: title(r.taskId)!, status: r.status, reason: r.blockedReason ?? 'no reason recorded' }));

  const parkedApprovals = input.approvals
    .filter((a) => a.sessionId === session.id && a.mode === 'deferred')
    .sort(byTimeThenId((a) => a.requestedAt.getTime(), (a) => a.id))
    .map((a) => ({
      approvalId: a.id,
      projectId: a.projectId,
      runId: a.runId,
      taskId: a.taskId,
      taskTitle: title(a.taskId),
      action: a.action,
      reason: a.reason,
      status: a.status,
      expiresAt: iso(a.expiresAt),
      decidedBy: a.decidedBy,
    }));

  const requests = input.decisionRequests.filter((r) => r.sessionId === session.id);
  const requestById = new Map(requests.map((r) => [r.id, r]));
  const decisions: DigestDecision[] = input.decisions
    .filter((d) => d.sessionId === session.id || (d.runId !== null && runIds.has(d.runId)))
    .sort(byTimeThenId((d) => d.createdAt.getTime(), (d) => d.id))
    .map((d) => {
      const answer = d.requestId ? (requestById.get(d.requestId)?.answer ?? null) : null;
      return {
        decisionId: d.id,
        projectId: d.projectId,
        taskId: d.taskId,
        runId: d.runId,
        question: d.question,
        decision: d.decision,
        reason: d.reason,
        confidence: d.confidence,
        origin: d.origin,
        status: d.status,
        requestId: d.requestId,
        councilId: d.councilId,
        adrRefs: [...d.adrRefs],
        diversity: answer?.diversity ?? null,
        singleProvider: answer?.singleProvider ?? false,
        dissent: answer ? [...answer.dissent] : [],
        reviewedBy: d.reviewedBy,
        reviewComment: d.reviewComment,
        createdAt: d.createdAt.toISOString(),
      };
    });
  const questions: DigestQuestion[] = [...requests]
    .sort(byTimeThenId((r) => r.createdAt.getTime(), (r) => r.id))
    .map((r) => ({
      requestId: r.id,
      projectId: r.projectId,
      taskId: r.taskId,
      taskTitle: title(r.taskId),
      runId: r.runId,
      kind: r.kind,
      question: r.question,
      status: r.status,
      rung: r.rung,
      trail: r.trail.map((step) => ({ rung: step.rung, outcome: step.outcome, detail: step.detail })),
      parkReason: r.parkReason,
      advisory: r.advisory,
      decisionId: r.decisionId,
      approvalId: r.approvalId,
      councilId: r.councilId,
      costUsd: money(r.costUsd),
      createdAt: r.createdAt.toISOString(),
    }));

  const byProject = [...input.costByProject]
    .map((c) => ({ projectId: c.projectId, costUsd: money(c.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || (a.projectId < b.projectId ? -1 : 1));
  const totalUsd = money(byProject.reduce((sum, c) => sum + c.costUsd, 0));

  const projects = [...new Set([...session.projectIds, ...runs.map((r) => r.projectId)])]
    .sort()
    .map((projectId) => ({ projectId, ...countRuns(runs.filter((r) => r.projectId === projectId)) }));
  return {
    sessionId: session.id,
    asOf: (session.endedAt ?? now).toISOString(),
    status: session.status,
    demo: session.demo,
    window: { startsAt: session.startsAt.toISOString(), endsAt: session.endsAt.toISOString(), endedAt: iso(session.endedAt) },
    stop: { reason: session.stopReason, detail: session.stopDetail, by: session.stoppedBy },
    totals: { ...countRuns(runs), pullRequests: pullRequests.length, ...decisionTotals(decisions, questions) },
    projects,
    pullRequests: pullRequests.slice(0, MAX_ITEMS),
    parkedApprovals: parkedApprovals.slice(0, MAX_ITEMS),
    failures: failures.slice(0, MAX_ITEMS),
    decisions: decisions.slice(0, MAX_ITEMS),
    questions: questions.slice(0, MAX_ITEMS),
    costs: { totalUsd, budgetUsd: session.budgetUsd, budgetUsedPct: budgetPct(totalUsd, session.budgetUsd), decisionsUsd: money(questions.reduce((sum, q) => sum + q.costUsd, 0)), byProject },
  };
}

function decisionTotals(decisions: readonly DigestDecision[], questions: readonly DigestQuestion[]) {
  return {
    decisions: decisions.length,
    decisionsToReview: decisions.filter((d) => d.status === 'provisional').length,
    questionsParked: questions.filter((q) => q.status === 'parked').length,
  };
}

function budgetPct(totalUsd: number, budgetUsd: number): number {
  return budgetUsd > 0 ? Math.min(100, Math.round((totalUsd / budgetUsd) * 1000) / 10) : 0;
}

/**
 * Removes everything outside the viewer's projects (per-project ACL, ADR-022). null = everything visible.
 * Every aggregate is recomputed from the visible projects only: counts, spend and the budget share. The stop detail is
 * a session-wide aggregate (e.g. total spend, failure streak across projects), so a partial view omits it.
 */
export function filterAutopilotDigest(digest: AutopilotDigest, visible: ReadonlySet<string> | null): AutopilotDigest {
  if (visible === null) return digest;
  const keep = <T extends { projectId: string }>(items: T[]) => items.filter((item) => visible.has(item.projectId));
  const projects = keep(digest.projects);
  if (projects.length === digest.projects.length) return digest;
  const pullRequests = keep(digest.pullRequests);
  const decisions = keep(digest.decisions);
  const questions = keep(digest.questions);
  const byProject = keep(digest.costs.byProject);
  const totalUsd = money(byProject.reduce((sum, c) => sum + c.costUsd, 0));
  return {
    ...digest,
    stop: { ...digest.stop, detail: null },
    pullRequests,
    parkedApprovals: keep(digest.parkedApprovals),
    failures: keep(digest.failures),
    decisions,
    questions,
    projects,
    totals: { ...sumCounts(projects), pullRequests: pullRequests.length, ...decisionTotals(decisions, questions) },
    costs: { budgetUsd: digest.costs.budgetUsd, byProject, totalUsd, budgetUsedPct: budgetPct(totalUsd, digest.costs.budgetUsd), decisionsUsd: money(questions.reduce((sum, q) => sum + q.costUsd, 0)) },
  };
}
