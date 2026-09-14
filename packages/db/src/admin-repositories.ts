import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { IndexedFile, ModelConfig, ProviderKind, RepoFileStore, UserRole } from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import * as t from './schema';

// Repositories used by the server (identity, configuration, audit, statistics). The orchestrator ports live
// in repositories.ts.

export type UserRecord = typeof t.users.$inferSelect;

export interface SessionUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  sessionId: string;
}

const countExpr = sql<number>`cast(count(*) as int)`;

export class DrizzleUserRepository {
  constructor(private readonly db: Db) {}

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: countExpr }).from(t.users);
    return Number(row?.n ?? 0);
  }

  async get(id: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(t.users).where(eq(t.users.id, id)).limit(1);
    return row ?? null;
  }

  async list(): Promise<UserRecord[]> {
    return this.db.select().from(t.users).orderBy(t.users.createdAt);
  }

  /** First user of the installation becomes owner; later GitHub users start as viewers. */
  async upsertGithubUser(input: { githubId: number; login: string; name: string | null; email: string | null; avatarUrl: string | null }): Promise<UserRecord> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [existing] = await tx.select().from(t.users).where(eq(t.users.githubId, input.githubId)).limit(1);
      if (existing) {
        const [updated] = await tx
          .update(t.users)
          .set({ login: input.login, name: input.name, email: input.email, avatarUrl: input.avatarUrl, lastLoginAt: now })
          .where(eq(t.users.id, existing.id))
          .returning();
        return updated!;
      }
      const [row] = await tx.select({ n: countExpr }).from(t.users);
      const [created] = await tx
        .insert(t.users)
        .values({ id: newId('usr'), ...input, role: Number(row?.n ?? 0) === 0 ? 'owner' : 'viewer', lastLoginAt: now })
        .returning();
      return created!;
    });
  }

  /** Local development only (guarded by the server config). */
  async upsertDevUser(login: string): Promise<UserRecord> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [existing] = await tx.select().from(t.users).where(eq(t.users.login, login)).limit(1);
      if (existing) {
        const [updated] = await tx.update(t.users).set({ lastLoginAt: now }).where(eq(t.users.id, existing.id)).returning();
        return updated!;
      }
      const [row] = await tx.select({ n: countExpr }).from(t.users);
      const [created] = await tx
        .insert(t.users)
        .values({ id: newId('usr'), login, name: login, role: Number(row?.n ?? 0) === 0 ? 'owner' : 'operator', lastLoginAt: now })
        .returning();
      return created!;
    });
  }

  async setRole(id: string, role: UserRole): Promise<UserRecord | null> {
    const [row] = await this.db.update(t.users).set({ role }).where(eq(t.users.id, id)).returning();
    return row ?? null;
  }
}

export class DrizzleSessionRepository {
  constructor(private readonly db: Db) {}

  async create(input: { userId: string; tokenHash: string; expiresAt: Date; ip: string | null; userAgent: string | null }): Promise<string> {
    const id = newId('ses');
    await this.db.insert(t.sessions).values({ id, ...input });
    return id;
  }

  async findUser(tokenHash: string, now: Date): Promise<SessionUser | null> {
    const [row] = await this.db
      .select({ sessionId: t.sessions.id, id: t.users.id, login: t.users.login, name: t.users.name, avatarUrl: t.users.avatarUrl, role: t.users.role })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.sessions.userId, t.users.id))
      .where(and(eq(t.sessions.tokenHash, tokenHash), sql`${t.sessions.expiresAt} > ${now}`))
      .limit(1);
    return row ?? null;
  }

  async delete(tokenHash: string): Promise<void> {
    await this.db.delete(t.sessions).where(eq(t.sessions.tokenHash, tokenHash));
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.delete(t.sessions).where(eq(t.sessions.userId, userId));
  }

  async deleteExpired(now: Date): Promise<number> {
    const rows = await this.db.delete(t.sessions).where(lt(t.sessions.expiresAt, now)).returning({ id: t.sessions.id });
    return rows.length;
  }
}

export type ProviderConfigRecord = typeof t.providerConfigs.$inferSelect;

export class DrizzleProviderConfigRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ProviderConfigRecord[]> {
    return this.db.select().from(t.providerConfigs).orderBy(t.providerConfigs.name);
  }

  async get(id: string): Promise<ProviderConfigRecord | null> {
    const [row] = await this.db.select().from(t.providerConfigs).where(eq(t.providerConfigs.id, id)).limit(1);
    return row ?? null;
  }

  /** `apiKeyEncrypted: undefined` keeps the stored key; `null` removes it. */
  async upsert(input: { id: string; kind: ProviderKind; name: string; baseUrl: string | null; enabled: boolean; apiKeyEncrypted?: string | null }): Promise<ProviderConfigRecord> {
    const now = new Date();
    const values = { kind: input.kind, name: input.name, baseUrl: input.baseUrl, enabled: input.enabled, updatedAt: now };
    const [row] = await this.db
      .insert(t.providerConfigs)
      .values({ id: input.id, ...values, apiKeyEncrypted: input.apiKeyEncrypted ?? null })
      .onConflictDoUpdate({
        target: t.providerConfigs.id,
        set: { ...values, ...(input.apiKeyEncrypted !== undefined ? { apiKeyEncrypted: input.apiKeyEncrypted } : {}) },
      })
      .returning();
    return row!;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(t.providerConfigs).where(eq(t.providerConfigs.id, id)).returning({ id: t.providerConfigs.id });
    return rows.length > 0;
  }
}

function toModelConfig(row: typeof t.modelConfigs.$inferSelect): ModelConfig {
  return {
    id: row.id,
    provider: row.provider,
    providerConfigId: row.providerConfigId,
    modelId: row.modelId,
    displayName: row.displayName,
    tier: row.tier,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    pricing: {
      inputPerMTok: row.inputPerMTok,
      outputPerMTok: row.outputPerMTok,
      cacheReadPerMTok: row.cacheReadPerMTok,
      cacheWritePerMTok: row.cacheWritePerMTok,
    },
    latency: row.latency,
    codingScore: row.codingScore,
    reasoningScore: row.reasoningScore,
    capabilities: row.capabilities,
    enabled: row.enabled,
  };
}

function modelValues(model: ModelConfig) {
  return {
    provider: model.provider,
    providerConfigId: model.providerConfigId,
    modelId: model.modelId,
    displayName: model.displayName,
    tier: model.tier,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputPerMTok: model.pricing.inputPerMTok,
    outputPerMTok: model.pricing.outputPerMTok,
    cacheReadPerMTok: model.pricing.cacheReadPerMTok,
    cacheWritePerMTok: model.pricing.cacheWritePerMTok,
    latency: model.latency,
    codingScore: model.codingScore,
    reasoningScore: model.reasoningScore,
    capabilities: model.capabilities,
    enabled: model.enabled,
  };
}

export class DrizzleModelConfigRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ModelConfig[]> {
    const rows = await this.db.select().from(t.modelConfigs).orderBy(t.modelConfigs.provider, t.modelConfigs.displayName);
    return rows.map(toModelConfig);
  }

  /** Inserts shipped defaults without overwriting operator edits. */
  async seedDefaults(models: readonly ModelConfig[]): Promise<void> {
    if (models.length === 0) return;
    await this.db
      .insert(t.modelConfigs)
      .values(models.map((m) => ({ id: m.id, ...modelValues(m) })))
      .onConflictDoNothing({ target: t.modelConfigs.id });
  }

  async upsert(model: ModelConfig): Promise<ModelConfig> {
    const values = modelValues(model);
    const [row] = await this.db
      .insert(t.modelConfigs)
      .values({ id: model.id, ...values })
      .onConflictDoUpdate({ target: t.modelConfigs.id, set: { ...values, updatedAt: new Date() } })
      .returning();
    return toModelConfig(row!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(t.modelConfigs).where(eq(t.modelConfigs.id, id)).returning({ id: t.modelConfigs.id });
    return rows.length > 0;
  }
}

export class DrizzleSettingsRepository {
  constructor(private readonly db: Db) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(t.settings).where(eq(t.settings.key, key)).limit(1);
    return row ? (row.value as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(t.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: t.settings.key, set: { value, updatedAt: new Date() } });
  }
}

export type AuditLogRecord = typeof t.auditLogs.$inferSelect;

export class DrizzleAuditLogRepository {
  constructor(private readonly db: Db) {}

  async record(entry: { actorType: 'user' | 'agent' | 'system'; actorId: string | null; action: string; target: string | null; details?: Record<string, unknown>; ip?: string | null }): Promise<void> {
    await this.db.insert(t.auditLogs).values({ ...entry, details: entry.details ?? {}, ip: entry.ip ?? null });
  }

  async list(filter: { limit?: number; actorId?: string; action?: string } = {}): Promise<AuditLogRecord[]> {
    const conditions: SQL[] = [];
    if (filter.actorId) conditions.push(eq(t.auditLogs.actorId, filter.actorId));
    if (filter.action) conditions.push(eq(t.auditLogs.action, filter.action));
    return this.db
      .select()
      .from(t.auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.auditLogs.id))
      .limit(filter.limit ?? 200);
  }
}

export class DrizzleRepoFileStore implements RepoFileStore {
  constructor(private readonly db: Db) {}

  async list(projectId: string): Promise<IndexedFile[]> {
    const rows = await this.db.select().from(t.repoFiles).where(eq(t.repoFiles.projectId, projectId));
    // A summary only counts while it was produced for the current blob.
    return rows.map((r) => ({ path: r.path, sha: r.sha, size: r.size, summary: r.summarySha === r.sha ? r.summary : null, symbols: r.symbols, imports: r.imports }));
  }

  async replace(projectId: string, files: readonly IndexedFile[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(t.repoFiles).where(eq(t.repoFiles.projectId, projectId));
      for (let i = 0; i < files.length; i += 500) {
        const chunk = files.slice(i, i + 500);
        await tx.insert(t.repoFiles).values(
          chunk.map((f) => ({
            projectId,
            path: f.path,
            sha: f.sha,
            size: f.size,
            summary: f.summary ?? null,
            summarySha: f.summary ? f.sha : null,
            symbols: [...(f.symbols ?? [])],
            imports: [...(f.imports ?? [])],
          })),
        );
      }
    });
  }
}

export class UsageStatsRepository {
  constructor(private readonly db: Db) {}

  /** `projectId` may be a list of projects (per-project access control, ADR-022). */
  private where(since: Date, projectId?: string | readonly string[]): SQL {
    const conditions: SQL[] = [gte(t.usageLedger.createdAt, since)];
    if (typeof projectId === 'string') conditions.push(eq(t.usageLedger.projectId, projectId));
    else if (projectId) conditions.push(projectId.length > 0 ? inArray(t.usageLedger.projectId, [...projectId]) : sql`false`);
    return and(...conditions)!;
  }

  private readonly tokens = sql<number>`coalesce(sum(${t.usageLedger.inputTokens} + ${t.usageLedger.outputTokens} + ${t.usageLedger.cacheReadTokens} + ${t.usageLedger.cacheWriteTokens}), 0)`;
  private readonly cost = sql<number>`coalesce(sum(${t.usageLedger.costUsd}), 0)`;

  async summary(since: Date, projectId?: string | readonly string[]): Promise<{ costUsd: number; tokens: number; calls: number; cacheHits: number; savedUsd: number }> {
    const [row] = await this.db
      .select({
        costUsd: this.cost,
        tokens: this.tokens,
        calls: countExpr,
        cacheHits: sql<number>`cast(count(*) filter (where ${t.usageLedger.cacheHit}) as int)`,
        savedUsd: sql<number>`coalesce(sum(${t.usageLedger.savedUsd}), 0)`,
      })
      .from(t.usageLedger)
      .where(this.where(since, projectId));
    return {
      costUsd: Number(row?.costUsd ?? 0),
      tokens: Number(row?.tokens ?? 0),
      calls: Number(row?.calls ?? 0),
      cacheHits: Number(row?.cacheHits ?? 0),
      savedUsd: Number(row?.savedUsd ?? 0),
    };
  }

  async byDay(since: Date, projectId?: string | readonly string[]): Promise<Array<{ day: string; costUsd: number; tokens: number }>> {
    const day = sql<string>`to_char(date_trunc('day', ${t.usageLedger.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ day, costUsd: this.cost, tokens: this.tokens })
      .from(t.usageLedger)
      .where(this.where(since, projectId))
      .groupBy(day)
      .orderBy(day);
    return rows.map((r) => ({ day: r.day, costUsd: Number(r.costUsd), tokens: Number(r.tokens) }));
  }

  async byModel(since: Date, projectId?: string | readonly string[]): Promise<Array<{ provider: string; modelId: string; costUsd: number; tokens: number; calls: number }>> {
    const rows = await this.db
      .select({ provider: t.usageLedger.provider, modelId: t.usageLedger.modelId, costUsd: this.cost, tokens: this.tokens, calls: countExpr })
      .from(t.usageLedger)
      .where(this.where(since, projectId))
      .groupBy(t.usageLedger.provider, t.usageLedger.modelId);
    return rows.map((r) => ({ ...r, costUsd: Number(r.costUsd), tokens: Number(r.tokens), calls: Number(r.calls) })).sort((a, b) => b.costUsd - a.costUsd);
  }

  async byProject(since: Date): Promise<Array<{ projectId: string | null; costUsd: number; tokens: number }>> {
    const rows = await this.db
      .select({ projectId: t.usageLedger.projectId, costUsd: this.cost, tokens: this.tokens })
      .from(t.usageLedger)
      .where(this.where(since))
      .groupBy(t.usageLedger.projectId);
    return rows.map((r) => ({ projectId: r.projectId, costUsd: Number(r.costUsd), tokens: Number(r.tokens) })).sort((a, b) => b.costUsd - a.costUsd);
  }
}

export interface ProjectMembership {
  projectId: string;
  userId: string;
  role: UserRole;
  createdAt: Date;
}

export interface ProjectMemberView extends ProjectMembership {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  globalRole: UserRole;
}

/** Per-project membership (ADR-022), backed by the `project_members` table. */
export class DrizzleProjectMemberRepository {
  constructor(private readonly db: Db) {}

  async listForProject(projectId: string): Promise<ProjectMemberView[]> {
    return this.db
      .select({
        projectId: t.projectMembers.projectId,
        userId: t.projectMembers.userId,
        role: t.projectMembers.role,
        createdAt: t.projectMembers.createdAt,
        login: t.users.login,
        name: t.users.name,
        avatarUrl: t.users.avatarUrl,
        globalRole: t.users.role,
      })
      .from(t.projectMembers)
      .innerJoin(t.users, eq(t.projectMembers.userId, t.users.id))
      .where(eq(t.projectMembers.projectId, projectId))
      .orderBy(t.users.login);
  }

  async listForUser(userId: string, limit = 500): Promise<ProjectMembership[]> {
    return this.db.select().from(t.projectMembers).where(eq(t.projectMembers.userId, userId)).orderBy(t.projectMembers.projectId).limit(limit);
  }

  async upsert(input: { projectId: string; userId: string; role: UserRole }): Promise<ProjectMembership> {
    const [row] = await this.db
      .insert(t.projectMembers)
      .values(input)
      .onConflictDoUpdate({ target: [t.projectMembers.projectId, t.projectMembers.userId], set: { role: input.role } })
      .returning();
    return row!;
  }

  async remove(projectId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.projectMembers)
      .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, userId)))
      .returning({ userId: t.projectMembers.userId });
    return rows.length > 0;
  }
}

/** Cheap aggregate counts for the metrics endpoint (ADR-021). */
export class OperationalStatsRepository {
  constructor(private readonly db: Db) {}

  async runsByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.select({ status: t.pipelineRuns.status, n: countExpr }).from(t.pipelineRuns).groupBy(t.pipelineRuns.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async activeAgentRuns(): Promise<number> {
    const [row] = await this.db.select({ n: countExpr }).from(t.agentRuns).where(eq(t.agentRuns.status, 'running'));
    return Number(row?.n ?? 0);
  }

  async pendingApprovals(): Promise<number> {
    const [row] = await this.db.select({ n: countExpr }).from(t.approvals).where(eq(t.approvals.status, 'pending'));
    return Number(row?.n ?? 0);
  }
}

export interface AdminRepositories {
  users: DrizzleUserRepository;
  sessions: DrizzleSessionRepository;
  providers: DrizzleProviderConfigRepository;
  models: DrizzleModelConfigRepository;
  settings: DrizzleSettingsRepository;
  audit: DrizzleAuditLogRepository;
  repoFiles: DrizzleRepoFileStore;
  stats: UsageStatsRepository;
  members: DrizzleProjectMemberRepository;
  ops: OperationalStatsRepository;
}

export function createAdminRepositories(db: Db): AdminRepositories {
  return {
    users: new DrizzleUserRepository(db),
    sessions: new DrizzleSessionRepository(db),
    providers: new DrizzleProviderConfigRepository(db),
    models: new DrizzleModelConfigRepository(db),
    settings: new DrizzleSettingsRepository(db),
    audit: new DrizzleAuditLogRepository(db),
    repoFiles: new DrizzleRepoFileStore(db),
    stats: new UsageStatsRepository(db),
    members: new DrizzleProjectMemberRepository(db),
    ops: new OperationalStatsRepository(db),
  };
}
