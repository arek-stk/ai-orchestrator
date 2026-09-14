import { and, desc, asc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  ConcurrentModificationError,
  emptyCheckpoint,
  type AgentRun,
  type AgentRunFilter,
  type AgentRunRepository,
  type AgentRunResult,
  type AnyDomainEvent,
  type Approval,
  type ApprovalRepository,
  type ApprovalStatus,
  type Decision,
  type DecisionRepository,
  type EmitEvent,
  type EventType,
  type MemoryItem,
  type MemoryQuery,
  type MemoryRepository,
  type NewAgentRun,
  type NewApproval,
  type NewDecision,
  type NewMemory,
  type NewProject,
  type NewRun,
  type PipelineRun,
  type Project,
  type ProjectPatch,
  type ProjectRepository,
  type RunFilter,
  type RunRepository,
  type RunStatus,
  type Task,
  type TaskFilter,
  type TaskInput,
  type TaskPatch,
  type TaskRepository,
  type TaskStatus,
  type UsageEntry,
  type UsageRepository,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import { toAgentRun, toApproval, toDecision, toMemory, toProject, toRun, toTask } from './mappers';
import * as t from './schema';

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------

export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Project | null> {
    const [row] = await this.db.select().from(t.projects).where(eq(t.projects.id, id)).limit(1);
    return row ? toProject(row) : null;
  }

  async getBySlug(slug: string): Promise<Project | null> {
    const [row] = await this.db.select().from(t.projects).where(eq(t.projects.slug, slug)).limit(1);
    return row ? toProject(row) : null;
  }

  async list(): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(t.projects)
      .where(isNull(t.projects.archivedAt))
      .orderBy(desc(t.projects.priority), asc(t.projects.name));
    return rows.map(toProject);
  }

  async create(input: NewProject): Promise<Project> {
    const [row] = await this.db
      .insert(t.projects)
      .values({
        id: newId('prj'),
        slug: input.slug,
        name: input.name,
        description: input.description,
        repoOwner: input.repo?.owner ?? null,
        repoName: input.repo?.name ?? null,
        defaultBranch: input.repo?.defaultBranch ?? null,
        priority: input.priority,
        autonomyLevel: input.autonomyLevel,
        budgetUsd: input.budgetUsd,
        profile: input.profile,
        settings: input.settings,
      })
      .returning();
    return toProject(row!);
  }

  async update(id: string, patch: ProjectPatch): Promise<Project> {
    const values: Partial<typeof t.projects.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.priority !== undefined) values.priority = patch.priority;
    if (patch.autonomyLevel !== undefined) values.autonomyLevel = patch.autonomyLevel;
    if (patch.healthScore !== undefined) values.healthScore = patch.healthScore;
    if (patch.budgetUsd !== undefined) values.budgetUsd = patch.budgetUsd;
    if (patch.profile !== undefined) values.profile = patch.profile;
    if (patch.settings !== undefined) values.settings = patch.settings;
    if (patch.lastScheduledAt !== undefined) values.lastScheduledAt = patch.lastScheduledAt;
    if (patch.repo !== undefined) {
      values.repoOwner = patch.repo?.owner ?? null;
      values.repoName = patch.repo?.name ?? null;
      values.defaultBranch = patch.repo?.defaultBranch ?? null;
    }
    const [row] = await this.db.update(t.projects).set(values).where(eq(t.projects.id, id)).returning();
    if (!row) throw new NotFoundError('project', id);
    return toProject(row);
  }

  async addUsage(id: string, costUsd: number, tokens: number): Promise<void> {
    await this.db
      .update(t.projects)
      .set({
        spentUsd: sql`${t.projects.spentUsd} + ${costUsd}`,
        tokensUsed: sql`${t.projects.tokensUsed} + ${Math.round(tokens)}`,
      })
      .where(eq(t.projects.id, id));
  }
}

// ---------------------------------------------------------------------------

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Task | null> {
    const [row] = await this.db.select().from(t.tasks).where(eq(t.tasks.id, id)).limit(1);
    return row ? toTask(row) : null;
  }

  async list(filter: TaskFilter): Promise<Task[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.tasks.projectId, filter.projectId));
    if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(t.tasks.status, [...filter.statuses]));
    if (filter.parentId === null) conditions.push(isNull(t.tasks.parentId));
    else if (filter.parentId !== undefined) conditions.push(eq(t.tasks.parentId, filter.parentId));
    const rows = await this.db
      .select()
      .from(t.tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.tasks.priority), asc(t.tasks.createdAt))
      .limit(filter.limit ?? 500);
    return rows.map(toTask);
  }

  async statuses(ids: readonly string[]): Promise<Map<string, TaskStatus>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: t.tasks.id, status: t.tasks.status })
      .from(t.tasks)
      .where(inArray(t.tasks.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  async create(projectId: string, input: TaskInput, createdBy: string | null): Promise<Task> {
    const now = new Date();
    const [row] = await this.db
      .insert(t.tasks)
      .values({
        id: newId('tsk'),
        projectId,
        parentId: input.parentId,
        title: input.title,
        goal: input.goal,
        kind: input.kind,
        status: 'READY',
        priority: input.priority,
        dependencies: input.dependencies,
        acceptanceCriteria: input.acceptanceCriteria,
        risk: input.risk,
        estimatedComplexity: input.estimatedComplexity,
        tokenBudget: input.tokenBudget,
        maxCost: input.maxCost,
        maxAttempts: input.maxAttempts,
        readySince: now,
        createdBy,
      })
      .returning();
    return toTask(row!);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const [row] = await this.db
      .update(t.tasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(t.tasks.id, id))
      .returning();
    if (!row) throw new NotFoundError('task', id);
    return toTask(row);
  }

  async addUsage(id: string, costUsd: number, tokens: number): Promise<void> {
    await this.db
      .update(t.tasks)
      .set({
        costUsd: sql`${t.tasks.costUsd} + ${costUsd}`,
        tokensUsed: sql`${t.tasks.tokensUsed} + ${Math.round(tokens)}`,
      })
      .where(eq(t.tasks.id, id));
  }
}

// ---------------------------------------------------------------------------

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: Db) {}

  async create(run: NewRun): Promise<PipelineRun> {
    const [row] = await this.db
      .insert(t.pipelineRuns)
      .values({
        id: newId('run'),
        taskId: run.taskId,
        projectId: run.projectId,
        stagePlan: run.stagePlan,
        limits: run.limits,
        checkpoint: emptyCheckpoint(),
      })
      .returning();
    return toRun(row!);
  }

  async get(id: string): Promise<PipelineRun | null> {
    const [row] = await this.db.select().from(t.pipelineRuns).where(eq(t.pipelineRuns.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async list(filter: RunFilter): Promise<PipelineRun[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.pipelineRuns.projectId, filter.projectId));
    if (filter.taskId) conditions.push(eq(t.pipelineRuns.taskId, filter.taskId));
    if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(t.pipelineRuns.status, [...filter.statuses]));
    const rows = await this.db
      .select()
      .from(t.pipelineRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.pipelineRuns.startedAt))
      .limit(filter.limit ?? 100);
    return rows.map(toRun);
  }

  async save(run: PipelineRun): Promise<PipelineRun> {
    const [row] = await this.db
      .update(t.pipelineRuns)
      .set({
        status: run.status,
        currentStage: run.currentStage,
        stagePlan: run.stagePlan,
        stageStates: run.stageStates,
        iterations: run.iterations,
        debugAttempts: run.debugAttempts,
        costUsd: run.costUsd,
        tokens: Math.round(run.tokens),
        limits: run.limits,
        checkpoint: run.checkpoint,
        error: run.error,
        blockedReason: run.blockedReason,
        resumeAt: run.resumeAt,
        finishedAt: run.finishedAt,
        updatedAt: new Date(),
        version: run.version + 1,
      })
      .where(and(eq(t.pipelineRuns.id, run.id), eq(t.pipelineRuns.version, run.version)))
      .returning();
    if (!row) throw new ConcurrentModificationError('pipeline run', run.id);
    return toRun(row);
  }

  async countByProject(statuses: readonly RunStatus[]): Promise<Map<string, number>> {
    if (statuses.length === 0) return new Map();
    const rows = await this.db
      .select({ projectId: t.pipelineRuns.projectId, count: sql<number>`cast(count(*) as int)` })
      .from(t.pipelineRuns)
      .where(inArray(t.pipelineRuns.status, [...statuses]))
      .groupBy(t.pipelineRuns.projectId);
    return new Map(rows.map((r) => [r.projectId, Number(r.count)]));
  }
}

// ---------------------------------------------------------------------------

export class DrizzleAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: Db) {}

  async start(run: NewAgentRun): Promise<AgentRun> {
    const [row] = await this.db
      .insert(t.agentRuns)
      .values({
        id: newId('agr'),
        runId: run.runId,
        taskId: run.taskId,
        projectId: run.projectId,
        role: run.role,
        inputSummary: run.inputSummary,
        modelConfigId: run.modelConfigId ?? null,
        provider: run.provider ?? null,
        modelId: run.modelId ?? null,
      })
      .returning();
    return toAgentRun(row!);
  }

  async finish(id: string, result: AgentRunResult): Promise<void> {
    await this.db
      .update(t.agentRuns)
      .set({
        status: result.status,
        output: result.output,
        confidence: result.confidence,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: result.costUsd,
        toolsUsed: result.toolsUsed,
        durationMs: Math.round(result.durationMs),
        error: result.error,
        modelConfigId: result.modelConfigId,
        provider: result.provider,
        modelId: result.modelId,
        finishedAt: new Date(),
      })
      .where(eq(t.agentRuns.id, id));
  }

  async list(filter: AgentRunFilter): Promise<AgentRun[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.agentRuns.projectId, filter.projectId));
    if (filter.runId) conditions.push(eq(t.agentRuns.runId, filter.runId));
    if (filter.role) conditions.push(eq(t.agentRuns.role, filter.role));
    if (filter.status) conditions.push(eq(t.agentRuns.status, filter.status));
    const rows = await this.db
      .select()
      .from(t.agentRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.agentRuns.startedAt))
      .limit(filter.limit ?? 100);
    return rows.map(toAgentRun);
  }
}

// ---------------------------------------------------------------------------

export class DrizzleDecisionRepository implements DecisionRepository {
  constructor(private readonly db: Db) {}

  async create(decision: NewDecision): Promise<Decision> {
    const [row] = await this.db
      .insert(t.decisions)
      .values({ id: newId('dec'), ...decision })
      .returning();
    return toDecision(row!);
  }

  async get(id: string): Promise<Decision | null> {
    const [row] = await this.db.select().from(t.decisions).where(eq(t.decisions.id, id)).limit(1);
    return row ? toDecision(row) : null;
  }

  async list(filter: { projectId?: string; taskId?: string; limit?: number }): Promise<Decision[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.decisions.projectId, filter.projectId));
    if (filter.taskId) conditions.push(eq(t.decisions.taskId, filter.taskId));
    const rows = await this.db
      .select()
      .from(t.decisions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.decisions.createdAt))
      .limit(filter.limit ?? 100);
    return rows.map(toDecision);
  }

  async findByQuestionKey(projectId: string, questionKey: string): Promise<Decision | null> {
    const [row] = await this.db
      .select()
      .from(t.decisions)
      .where(and(eq(t.decisions.projectId, projectId), eq(t.decisions.questionKey, questionKey)))
      .orderBy(desc(t.decisions.createdAt))
      .limit(1);
    return row ? toDecision(row) : null;
  }
}

// ---------------------------------------------------------------------------

export class DrizzleMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Db) {}

  async upsert(item: NewMemory): Promise<MemoryItem> {
    const now = new Date();
    const [row] = await this.db
      .insert(t.memories)
      .values({
        id: newId('mem'),
        projectId: item.projectId,
        scope: item.scope,
        taskId: item.taskId ?? null,
        kind: item.kind,
        key: item.key,
        content: item.content,
        tags: item.tags ?? [],
      })
      .onConflictDoUpdate({
        target: [t.memories.projectId, t.memories.scope, t.memories.key],
        set: {
          content: item.content,
          kind: item.kind,
          tags: item.tags ?? [],
          taskId: item.taskId ?? null,
          hits: sql`${t.memories.hits} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    return toMemory(row!);
  }

  async search(projectId: string, query: MemoryQuery): Promise<MemoryItem[]> {
    const conditions: SQL[] = [eq(t.memories.projectId, projectId)];
    if (query.scope) conditions.push(eq(t.memories.scope, query.scope));
    if (query.kind) conditions.push(eq(t.memories.kind, query.kind));
    if (query.key) conditions.push(eq(t.memories.key, query.key));
    if (query.text) {
      const pattern = `%${escapeLike(query.text)}%`;
      conditions.push(or(ilike(t.memories.content, pattern), ilike(t.memories.key, pattern))!);
    }
    const rows = await this.db
      .select()
      .from(t.memories)
      .where(and(...conditions))
      .orderBy(desc(t.memories.updatedAt))
      .limit(query.limit ?? 50);
    return rows.map(toMemory);
  }
}

// ---------------------------------------------------------------------------

export class DrizzleApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Db) {}

  async create(approval: NewApproval): Promise<Approval> {
    const [row] = await this.db
      .insert(t.approvals)
      .values({ id: newId('apr'), ...approval })
      .returning();
    return toApproval(row!);
  }

  async get(id: string): Promise<Approval | null> {
    const [row] = await this.db.select().from(t.approvals).where(eq(t.approvals.id, id)).limit(1);
    return row ? toApproval(row) : null;
  }

  async list(filter: { projectId?: string; status?: ApprovalStatus; limit?: number }): Promise<Approval[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.approvals.projectId, filter.projectId));
    if (filter.status) conditions.push(eq(t.approvals.status, filter.status));
    const rows = await this.db
      .select()
      .from(t.approvals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.approvals.requestedAt))
      .limit(filter.limit ?? 100);
    return rows.map(toApproval);
  }

  /** Oldest pending approvals requested before `before` (approval expiry, ADR-023). */
  async listPendingBefore(before: Date, limit: number): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(t.approvals)
      .where(and(eq(t.approvals.status, 'pending'), sql`${t.approvals.requestedAt} <= ${before}`))
      .orderBy(asc(t.approvals.requestedAt))
      .limit(limit);
    return rows.map(toApproval);
  }

  async decide(id: string, status: 'approved' | 'rejected' | 'expired', decidedBy: string, comment: string | null): Promise<Approval | null> {
    const [row] = await this.db
      .update(t.approvals)
      .set({ status, decidedBy, comment, decidedAt: new Date() })
      .where(and(eq(t.approvals.id, id), eq(t.approvals.status, 'pending')))
      .returning();
    return row ? toApproval(row) : null;
  }
}

// ---------------------------------------------------------------------------

export class DrizzleUsageRepository implements UsageRepository {
  constructor(private readonly db: Db) {}

  async record(entry: UsageEntry): Promise<void> {
    await this.db.insert(t.usageLedger).values({
      projectId: entry.projectId,
      taskId: entry.taskId,
      agentRunId: entry.agentRunId,
      provider: entry.provider,
      modelId: entry.modelId,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costUsd: entry.costUsd,
    });
  }

  async totalCostSince(since: Date, projectId?: string): Promise<number> {
    const conditions: SQL[] = [gte(t.usageLedger.createdAt, since)];
    if (projectId) conditions.push(eq(t.usageLedger.projectId, projectId));
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${t.usageLedger.costUsd}), 0)` })
      .from(t.usageLedger)
      .where(and(...conditions));
    return Number(row?.total ?? 0);
  }
}

// ---------------------------------------------------------------------------

export interface EventQuery {
  afterId?: number;
  projectId?: string;
  taskId?: string;
  runId?: string;
  types?: readonly EventType[];
  limit?: number;
  order?: 'asc' | 'desc';
}

export class DrizzleEventStore {
  constructor(private readonly db: Db) {}

  async append<T extends EventType>(event: EmitEvent<T>): Promise<AnyDomainEvent> {
    const [row] = await this.db
      .insert(t.events)
      .values({
        type: event.type,
        projectId: event.projectId,
        taskId: event.taskId,
        runId: event.runId,
        payload: event.payload as unknown as Record<string, unknown>,
      })
      .returning();
    return toEvent(row!);
  }

  async list(query: EventQuery = {}): Promise<AnyDomainEvent[]> {
    const conditions: SQL[] = [];
    if (query.afterId !== undefined) conditions.push(sql`${t.events.id} > ${query.afterId}`);
    if (query.projectId) conditions.push(eq(t.events.projectId, query.projectId));
    if (query.taskId) conditions.push(eq(t.events.taskId, query.taskId));
    if (query.runId) conditions.push(eq(t.events.runId, query.runId));
    if (query.types && query.types.length > 0) conditions.push(inArray(t.events.type, [...query.types]));
    const rows = await this.db
      .select()
      .from(t.events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(query.order === 'desc' ? desc(t.events.id) : asc(t.events.id))
      .limit(query.limit ?? 200);
    return rows.map(toEvent);
  }
}

function toEvent(row: typeof t.events.$inferSelect): AnyDomainEvent {
  return {
    id: String(row.id),
    type: row.type,
    projectId: row.projectId,
    taskId: row.taskId,
    runId: row.runId,
    payload: row.payload,
    createdAt: row.createdAt,
  } as AnyDomainEvent;
}

// ---------------------------------------------------------------------------

export interface Repositories {
  projects: DrizzleProjectRepository;
  tasks: DrizzleTaskRepository;
  runs: DrizzleRunRepository;
  agentRuns: DrizzleAgentRunRepository;
  decisions: DrizzleDecisionRepository;
  memories: DrizzleMemoryRepository;
  approvals: DrizzleApprovalRepository;
  usage: DrizzleUsageRepository;
  events: DrizzleEventStore;
}

export function createRepositories(db: Db): Repositories {
  return {
    projects: new DrizzleProjectRepository(db),
    tasks: new DrizzleTaskRepository(db),
    runs: new DrizzleRunRepository(db),
    agentRuns: new DrizzleAgentRunRepository(db),
    decisions: new DrizzleDecisionRepository(db),
    memories: new DrizzleMemoryRepository(db),
    approvals: new DrizzleApprovalRepository(db),
    usage: new DrizzleUsageRepository(db),
    events: new DrizzleEventStore(db),
  };
}
