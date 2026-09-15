import type { RunStatus } from '../domain/enums';
import type { Approval, Decision } from '../domain/records';
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
  totals: DigestRunCounts & { pullRequests: number; decisions: number };
  /** Run counts per project, so viewers restricted to some projects get totals of their projects only. */
  projects: Array<DigestRunCounts & { projectId: string }>;
  pullRequests: Array<{ runId: string; taskId: string; projectId: string; taskTitle: string; number: number; url: string | null; outcome: string | null }>;
  parkedApprovals: Array<{ approvalId: string; projectId: string; runId: string | null; taskId: string | null; taskTitle: string | null; action: string; reason: string; status: Approval['status']; expiresAt: string | null; decidedBy: string | null }>;
  failures: Array<{ runId: string; taskId: string; projectId: string; taskTitle: string; status: RunStatus; reason: string }>;
  decisions: Array<{ decisionId: string; projectId: string; taskId: string | null; question: string; decision: string; confidence: number; createdAt: string }>;
  costs: { totalUsd: number; budgetUsd: number; budgetUsedPct: number; byProject: Array<{ projectId: string; costUsd: number }> };
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

  const decisions = input.decisions
    .filter((d) => d.runId !== null && runIds.has(d.runId))
    .sort(byTimeThenId((d) => d.createdAt.getTime(), (d) => d.id))
    .map((d) => ({ decisionId: d.id, projectId: d.projectId, taskId: d.taskId, question: d.question, decision: d.decision, confidence: d.confidence, createdAt: d.createdAt.toISOString() }));

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
    totals: { ...countRuns(runs), pullRequests: pullRequests.length, decisions: decisions.length },
    projects,
    pullRequests: pullRequests.slice(0, MAX_ITEMS),
    parkedApprovals: parkedApprovals.slice(0, MAX_ITEMS),
    failures: failures.slice(0, MAX_ITEMS),
    decisions: decisions.slice(0, MAX_ITEMS),
    costs: { totalUsd, budgetUsd: session.budgetUsd, budgetUsedPct: budgetPct(totalUsd, session.budgetUsd), byProject },
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
  const byProject = keep(digest.costs.byProject);
  const totalUsd = money(byProject.reduce((sum, c) => sum + c.costUsd, 0));
  return {
    ...digest,
    stop: { ...digest.stop, detail: null },
    pullRequests,
    parkedApprovals: keep(digest.parkedApprovals),
    failures: keep(digest.failures),
    decisions,
    projects,
    totals: { ...sumCounts(projects), pullRequests: pullRequests.length, decisions: decisions.length },
    costs: { budgetUsd: digest.costs.budgetUsd, byProject, totalUsd, budgetUsedPct: budgetPct(totalUsd, digest.costs.budgetUsd) },
  };
}
