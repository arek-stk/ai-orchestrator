import { and, asc, desc, eq, inArray, like, sql, type SQL } from 'drizzle-orm';
import {
  ConcurrentModificationError,
  type NewWorkflow,
  type NewWorkflowRun,
  type NewWorkflowStep,
  type Workflow,
  type WorkflowArtifact,
  type WorkflowArtifactMeta,
  type WorkflowPatch,
  type WorkflowRepository,
  type WorkflowRun,
  type WorkflowRunPatch,
  type WorkflowRunRepository,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepPatch,
  type WorkflowVersion,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import * as t from './schema';

// Persistence for workflows (ADR-037): definitions with an append-only version history, runs with step records and
// artifacts. Cost figures of a run are the sums of its steps, which come from the agent runtime's ledger accounting.

const toWorkflow = (row: typeof t.workflows.$inferSelect): Workflow => ({ ...row });
const toVersion = (row: typeof t.workflowVersions.$inferSelect): WorkflowVersion => ({ ...row });
const toRun = (row: typeof t.workflowRuns.$inferSelect): WorkflowRun => ({ ...row });
const toStep = ({ position: _position, ...row }: typeof t.workflowRunSteps.$inferSelect): WorkflowStep => ({ ...row });
const toArtifact = (row: typeof t.workflowArtifacts.$inferSelect): WorkflowArtifact => ({ ...row });

export class DrizzleWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewWorkflow): Promise<Workflow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.workflows)
        .values({ id: newId('wfl'), ...input, version: 1, updatedBy: input.createdBy })
        .returning();
      await tx.insert(t.workflowVersions).values({ workflowId: row!.id, version: 1, name: row!.name, definition: row!.definition, createdBy: input.createdBy });
      return toWorkflow(row!);
    });
  }

  async get(id: string): Promise<Workflow | null> {
    const [row] = await this.db.select().from(t.workflows).where(eq(t.workflows.id, id)).limit(1);
    return row ? toWorkflow(row) : null;
  }

  async list(filter: { projectIds?: readonly string[]; limit: number }): Promise<Workflow[]> {
    if (filter.projectIds && filter.projectIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(t.workflows)
      .where(filter.projectIds ? inArray(t.workflows.projectId, [...filter.projectIds]) : undefined)
      .orderBy(desc(t.workflows.updatedAt), desc(t.workflows.id))
      .limit(filter.limit);
    return rows.map(toWorkflow);
  }

  async update(id: string, patch: WorkflowPatch, expectedVersion: number, updatedBy: string | null): Promise<Workflow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(t.workflows)
        .set({ ...patch, version: sql`${t.workflows.version} + 1`, updatedBy, updatedAt: new Date() })
        .where(and(eq(t.workflows.id, id), eq(t.workflows.version, expectedVersion)))
        .returning();
      if (!row) throw new ConcurrentModificationError('workflow', id);
      await tx.insert(t.workflowVersions).values({ workflowId: id, version: row.version, name: row.name, definition: row.definition, createdBy: updatedBy });
      return toWorkflow(row);
    });
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(t.workflows).where(eq(t.workflows.id, id)).returning({ id: t.workflows.id });
    return rows.length > 0;
  }

  async listVersions(id: string, limit: number): Promise<WorkflowVersion[]> {
    const rows = await this.db.select().from(t.workflowVersions).where(eq(t.workflowVersions.workflowId, id)).orderBy(desc(t.workflowVersions.version)).limit(limit);
    return rows.map(toVersion);
  }
}

export class DrizzleWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: Db) {}

  async create(run: NewWorkflowRun, steps: readonly NewWorkflowStep[]): Promise<WorkflowRun> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.workflowRuns)
        .values({ id: newId('wfr'), ...run })
        .returning();
      if (steps.length > 0) {
        await tx.insert(t.workflowRunSteps).values(
          steps.map((step, position) => ({
            id: newId('wfs'),
            runId: row!.id,
            position,
            ...step,
            finishedAt: step.status === 'pending' ? null : row!.createdAt,
          })),
        );
      }
      return toRun(row!);
    });
  }

  async get(id: string): Promise<WorkflowRun | null> {
    const [row] = await this.db.select().from(t.workflowRuns).where(eq(t.workflowRuns.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async list(filter: { workflowId?: string; projectId?: string; sessionId?: string; statuses?: readonly WorkflowRunStatus[]; limit: number }): Promise<WorkflowRun[]> {
    const conditions: SQL[] = [];
    if (filter.workflowId) conditions.push(eq(t.workflowRuns.workflowId, filter.workflowId));
    if (filter.projectId) conditions.push(eq(t.workflowRuns.projectId, filter.projectId));
    if (filter.sessionId) conditions.push(eq(t.workflowRuns.sessionId, filter.sessionId));
    if (filter.statuses) conditions.push(inArray(t.workflowRuns.status, [...filter.statuses]));
    const rows = await this.db
      .select()
      .from(t.workflowRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.workflowRuns.createdAt), desc(t.workflowRuns.id))
      .limit(filter.limit);
    return rows.map(toRun);
  }

  async update(id: string, patch: WorkflowRunPatch, onlyIf?: readonly WorkflowRunStatus[]): Promise<WorkflowRun | null> {
    const conditions: SQL[] = [eq(t.workflowRuns.id, id)];
    if (onlyIf) conditions.push(inArray(t.workflowRuns.status, [...onlyIf]));
    const [row] = await this.db.update(t.workflowRuns).set(patch).where(and(...conditions)).returning();
    return row ? toRun(row) : null;
  }

  async listSteps(runId: string): Promise<WorkflowStep[]> {
    const rows = await this.db.select().from(t.workflowRunSteps).where(eq(t.workflowRunSteps.runId, runId)).orderBy(asc(t.workflowRunSteps.position));
    return rows.map(toStep);
  }

  async updateStep(runId: string, nodeId: string, patch: WorkflowStepPatch): Promise<WorkflowStep> {
    const [row] = await this.db
      .update(t.workflowRunSteps)
      .set(patch)
      .where(and(eq(t.workflowRunSteps.runId, runId), eq(t.workflowRunSteps.nodeId, nodeId)))
      .returning();
    if (!row) throw new Error(`step ${nodeId} of run ${runId} not found`);
    return toStep(row);
  }

  async addArtifact(input: Omit<WorkflowArtifact, 'id' | 'createdAt' | 'size'>): Promise<WorkflowArtifactMeta> {
    // One artifact per node: a restarted step replaces its previous output.
    const [row] = await this.db
      .insert(t.workflowArtifacts)
      .values({ id: newId('wfa'), ...input, size: input.content.length })
      .onConflictDoUpdate({
        target: [t.workflowArtifacts.runId, t.workflowArtifacts.nodeId],
        set: { name: input.name, format: input.format, content: input.content, size: input.content.length, createdAt: new Date() },
      })
      .returning();
    const { content: _content, ...meta } = toArtifact(row!);
    return meta;
  }

  async listArtifacts(runId: string): Promise<WorkflowArtifactMeta[]> {
    const rows = await this.db
      .select({
        id: t.workflowArtifacts.id,
        runId: t.workflowArtifacts.runId,
        nodeId: t.workflowArtifacts.nodeId,
        name: t.workflowArtifacts.name,
        format: t.workflowArtifacts.format,
        size: t.workflowArtifacts.size,
        createdAt: t.workflowArtifacts.createdAt,
      })
      .from(t.workflowArtifacts)
      .where(eq(t.workflowArtifacts.runId, runId))
      .orderBy(asc(t.workflowArtifacts.createdAt), asc(t.workflowArtifacts.id));
    return rows;
  }

  async getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null> {
    const [row] = await this.db
      .select()
      .from(t.workflowArtifacts)
      .where(and(eq(t.workflowArtifacts.runId, runId), eq(t.workflowArtifacts.id, artifactId)))
      .limit(1);
    return row ? toArtifact(row) : null;
  }

  async sessionCostUsd(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${t.workflowRunSteps.costUsd}), 0)` })
      .from(t.workflowRunSteps)
      .innerJoin(t.workflowRuns, eq(t.workflowRuns.id, t.workflowRunSteps.runId))
      .where(eq(t.workflowRuns.sessionId, sessionId));
    return Number(row?.total ?? 0);
  }

  /** Ledger totals for a run's agent runs: the source of truth for cost and token figures in the UI. */
  async ledgerTotals(runId: string): Promise<{ costUsd: number; tokens: number; calls: number; byModel: Array<{ provider: string; modelId: string; costUsd: number; tokens: number; calls: number }> }> {
    const rows = await this.db
      .select({
        provider: t.usageLedger.provider,
        modelId: t.usageLedger.modelId,
        costUsd: sql<number>`coalesce(sum(${t.usageLedger.costUsd}), 0)`,
        tokens: sql<number>`coalesce(sum(${t.usageLedger.inputTokens} + ${t.usageLedger.outputTokens} + ${t.usageLedger.cacheReadTokens} + ${t.usageLedger.cacheWriteTokens}), 0)`,
        calls: sql<number>`cast(count(*) as int)`,
      })
      .from(t.usageLedger)
      .innerJoin(t.workflowRunSteps, eq(t.workflowRunSteps.agentRunId, t.usageLedger.agentRunId))
      .where(eq(t.workflowRunSteps.runId, runId))
      .groupBy(t.usageLedger.provider, t.usageLedger.modelId);
    const byModel = rows.map((r) => ({ provider: r.provider, modelId: r.modelId, costUsd: Number(r.costUsd), tokens: Number(r.tokens), calls: Number(r.calls) }));
    return {
      costUsd: byModel.reduce((sum, r) => sum + r.costUsd, 0),
      tokens: byModel.reduce((sum, r) => sum + r.tokens, 0),
      calls: byModel.reduce((sum, r) => sum + r.calls, 0),
      byModel,
    };
  }

  /** Workflow events of a run (Protokoll), oldest first, bounded. */
  async listEvents(projectId: string, runId: string, limit: number) {
    return this.db
      .select()
      .from(t.events)
      .where(and(eq(t.events.projectId, projectId), like(t.events.type, 'workflow.%'), sql`${t.events.payload}->>'workflowRunId' = ${runId}`))
      .orderBy(asc(t.events.id))
      .limit(limit);
  }
}

export interface WorkflowRepositories {
  workflows: DrizzleWorkflowRepository;
  runs: DrizzleWorkflowRunRepository;
}

export function createWorkflowRepositories(db: Db): WorkflowRepositories {
  return { workflows: new DrizzleWorkflowRepository(db), runs: new DrizzleWorkflowRunRepository(db) };
}
