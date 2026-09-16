import { and, asc, desc, eq, gte, inArray, isNotNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  AutopilotConflictError,
  TERMINAL_RUN_STATUSES,
  type AutopilotDigestInput,
  type AutopilotSession,
  type AutopilotSessionFilter,
  type AutopilotSessionFinish,
  type AutopilotSessionRepository,
  type AutopilotSessionStats,
  type NewAutopilotSession,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import { toApproval, toDecision, toRun } from './mappers';
import * as t from './schema';

// Persistence for autopilot sessions (docs/plans/autopilot.md, stage 1). Spend is attributed through the ledger's agent
// runs to the session's pipeline runs, so digest numbers are the ledger sums of the session.

const HOUR_MS = 60 * 60 * 1000;
/** Bounds for the per-session aggregates (a session is time-boxed; these are far above realistic volumes). */
const MAX_RUNS = 1000;
const MAX_TRAIL = 200;

export function toAutopilotSession(row: typeof t.autopilotSessions.$inferSelect): AutopilotSession {
  return { ...row };
}

export class DrizzleAutopilotSessionRepository implements AutopilotSessionRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewAutopilotSession): Promise<AutopilotSession> {
    return this.db.transaction(async (tx) => {
      const id = newId('aps');
      const [row] = await tx
        .insert(t.autopilotSessions)
        .values({
          id,
          startedBy: input.startedBy,
          projectIds: input.projectIds,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          budgetUsd: input.budgetUsd,
          autonomyCeiling: input.autonomyCeiling,
          maxTaskRisk: input.maxTaskRisk,
          maxConcurrentRuns: input.maxConcurrentRuns,
          maxParkedRuns: input.maxParkedRuns,
          quietHours: input.quietHours,
          stopPolicy: input.stopPolicy,
          demo: input.demo,
        })
        .returning();
      // The partial unique index makes "one active session per project" atomic; a conflict rolls the session back.
      const inserted = await tx
        .insert(t.autopilotSessionProjects)
        .values(input.projectIds.map((projectId) => ({ sessionId: id, projectId })))
        .onConflictDoNothing({ target: t.autopilotSessionProjects.projectId, where: sql`status = 'active'` })
        .returning({ projectId: t.autopilotSessionProjects.projectId });
      if (inserted.length !== input.projectIds.length) {
        const ok = new Set(inserted.map((r) => r.projectId));
        throw new AutopilotConflictError(input.projectIds.filter((projectId) => !ok.has(projectId)));
      }
      return toAutopilotSession(row!);
    });
  }

  async get(id: string): Promise<AutopilotSession | null> {
    const [row] = await this.db.select().from(t.autopilotSessions).where(eq(t.autopilotSessions.id, id)).limit(1);
    return row ? toAutopilotSession(row) : null;
  }

  async list(filter: AutopilotSessionFilter): Promise<AutopilotSession[]> {
    const conditions: SQL[] = [];
    if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(t.autopilotSessions.status, [...filter.statuses]));
    if (filter.projectIds) {
      if (filter.projectIds.length === 0) return [];
      const inScope = this.db
        .select({ id: t.autopilotSessionProjects.sessionId })
        .from(t.autopilotSessionProjects)
        .where(inArray(t.autopilotSessionProjects.projectId, [...filter.projectIds]));
      conditions.push(inArray(t.autopilotSessions.id, inScope));
    }
    const rows = await this.db
      .select()
      .from(t.autopilotSessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.autopilotSessions.createdAt), desc(t.autopilotSessions.id))
      .limit(filter.limit ?? 100);
    return rows.map(toAutopilotSession);
  }

  async finish(id: string, patch: AutopilotSessionFinish): Promise<AutopilotSession | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(t.autopilotSessions)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(t.autopilotSessions.id, id), eq(t.autopilotSessions.status, 'active')))
        .returning();
      if (!row) return null;
      await tx.update(t.autopilotSessionProjects).set({ status: 'ended' }).where(eq(t.autopilotSessionProjects.sessionId, id));
      return toAutopilotSession(row);
    });
  }

  /** Ledger spend of the session's runs from `since` until the session ended (open-ended while it is active). */
  private async ledgerSpend(session: AutopilotSession, since: Date | null): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${t.usageLedger.costUsd}), 0)` })
      .from(t.usageLedger)
      .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.usageLedger.agentRunId))
      .innerJoin(t.pipelineRuns, eq(t.pipelineRuns.id, t.agentRuns.runId))
      .where(and(...this.ledgerConditions(session, since)));
    return Number(row?.total ?? 0);
  }

  private ledgerConditions(session: AutopilotSession, since: Date | null): SQL[] {
    const conditions: SQL[] = [eq(t.pipelineRuns.sessionId, session.id)];
    if (since) conditions.push(gte(t.usageLedger.createdAt, since));
    if (session.endedAt) conditions.push(lte(t.usageLedger.createdAt, session.endedAt));
    return conditions;
  }

  async spentUsd(session: AutopilotSession): Promise<number> {
    return this.ledgerSpend(session, null);
  }

  async stats(session: AutopilotSession, now: Date): Promise<AutopilotSessionStats> {
    const hourAgo = new Date(Math.max(session.startsAt.getTime(), now.getTime() - HOUR_MS));
    const denialWindowStart = new Date(Math.max(session.startsAt.getTime(), now.getTime() - session.stopPolicy.securityDenialWindowMs));
    const sessionRunIds = this.db.select({ id: t.pipelineRuns.id }).from(t.pipelineRuns).where(eq(t.pipelineRuns.sessionId, session.id));

    const [spentUsd, spentLastHourUsd, finished, ci, denials] = await Promise.all([
      this.ledgerSpend(session, null),
      this.ledgerSpend(session, hourAgo),
      this.db
        .select({ runId: t.pipelineRuns.id, status: t.pipelineRuns.status, finishedAt: t.pipelineRuns.finishedAt })
        .from(t.pipelineRuns)
        .where(
          and(eq(t.pipelineRuns.sessionId, session.id), inArray(t.pipelineRuns.status, [...TERMINAL_RUN_STATUSES]), isNotNull(t.pipelineRuns.finishedAt)),
        )
        .orderBy(desc(t.pipelineRuns.finishedAt), desc(t.pipelineRuns.id))
        .limit(MAX_TRAIL),
      this.db
        .select({ type: t.events.type, payload: t.events.payload })
        .from(t.events)
        .where(and(inArray(t.events.type, ['ci.passed', 'ci.failed']), inArray(t.events.runId, sessionRunIds)))
        .orderBy(desc(t.events.id))
        .limit(MAX_TRAIL),
      // Tool audit entries are written by the server's tool router audit with the session id in `details`.
      this.db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(t.auditLogs)
        .where(
          and(
            like(t.auditLogs.action, 'tool.%.denied'),
            gte(t.auditLogs.createdAt, denialWindowStart),
            sql`${t.auditLogs.details} ->> 'sessionId' = ${session.id}`,
            sql`${t.auditLogs.details} ->> 'reason' like 'security%'`,
          ),
        ),
    ]);

    return {
      spentUsd,
      spentLastHourUsd,
      finishedRuns: finished.reverse().map((r) => ({ runId: r.runId, status: r.status, finishedAt: r.finishedAt! })),
      ciResults: ci.reverse().map((e) => ({
        passed: e.type === 'ci.passed',
        classification: e.type === 'ci.failed' && typeof e.payload.classification === 'string' ? e.payload.classification : null,
      })),
      securityDenials: Number(denials[0]?.count ?? 0),
    };
  }

  async digestInput(session: AutopilotSession): Promise<AutopilotDigestInput> {
    const runRows = await this.db
      .select()
      .from(t.pipelineRuns)
      .where(eq(t.pipelineRuns.sessionId, session.id))
      .orderBy(asc(t.pipelineRuns.startedAt), asc(t.pipelineRuns.id))
      .limit(MAX_RUNS);
    const runs = runRows.map(toRun);
    const runIds = runs.map((r) => r.id);

    const [approvalRows, decisionRows, requestRows, costRows] = await Promise.all([
      this.db.select().from(t.approvals).where(eq(t.approvals.sessionId, session.id)).orderBy(asc(t.approvals.requestedAt)).limit(MAX_RUNS),
      this.db
        .select()
        .from(t.decisions)
        .where(runIds.length > 0 ? or(eq(t.decisions.sessionId, session.id), inArray(t.decisions.runId, runIds)) : eq(t.decisions.sessionId, session.id))
        .limit(MAX_RUNS),
      this.db.select().from(t.decisionRequests).where(eq(t.decisionRequests.sessionId, session.id)).orderBy(asc(t.decisionRequests.createdAt)).limit(MAX_RUNS),
      this.db
        .select({ projectId: t.pipelineRuns.projectId, costUsd: sql<number>`coalesce(sum(${t.usageLedger.costUsd}), 0)` })
        .from(t.usageLedger)
        .innerJoin(t.agentRuns, eq(t.agentRuns.id, t.usageLedger.agentRunId))
        .innerJoin(t.pipelineRuns, eq(t.pipelineRuns.id, t.agentRuns.runId))
        .where(and(...this.ledgerConditions(session, null)))
        .groupBy(t.pipelineRuns.projectId),
    ]);
    const approvals = approvalRows.map(toApproval);

    const taskIds = [...new Set([...runs.map((r) => r.taskId), ...approvals.flatMap((a) => (a.taskId ? [a.taskId] : []))])];
    const titles = taskIds.length > 0 ? await this.db.select({ id: t.tasks.id, title: t.tasks.title }).from(t.tasks).where(inArray(t.tasks.id, taskIds)) : [];

    return {
      session,
      runs: runs.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        projectId: r.projectId,
        status: r.status,
        costUsd: r.costUsd,
        blockedReason: r.blockedReason,
        prNumber: r.checkpoint.prNumber,
        prUrl: r.checkpoint.prUrl,
        outcome: r.checkpoint.outcome,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      taskTitles: new Map(titles.map((row) => [row.id, row.title])),
      approvals,
      decisions: decisionRows.map(toDecision),
      decisionRequests: requestRows.map((row) => ({ ...row })),
      costByProject: costRows.map((row) => ({ projectId: row.projectId, costUsd: Number(row.costUsd) })),
    };
  }
}
