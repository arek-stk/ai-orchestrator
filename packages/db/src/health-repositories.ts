import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  AgentCacheEntry,
  AgentCacheStore,
  CachedAgentOutput,
  FileSummaryStore,
  HealthScan,
  HealthScanPatch,
  HealthScanRepository,
  HealthScanTrigger,
  ImprovementProposal,
  NewProposal,
  ProposalFilter,
  ProposalRepository,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import { NotFoundError } from './repositories';
import * as t from './schema';

// Persistence for orchestration intelligence: health scans, improvement proposals, the agent output cache and
// file summaries (spec §14, §31).

function toScan(row: typeof t.healthScans.$inferSelect): HealthScan {
  return { ...row };
}

function toProposal(row: typeof t.improvementProposals.$inferSelect): ImprovementProposal {
  return { ...row };
}

export class DrizzleHealthScanRepository implements HealthScanRepository {
  constructor(private readonly db: Db) {}

  async create(input: { projectId: string; trigger: HealthScanTrigger; requestedBy: string | null }): Promise<HealthScan> {
    const [row] = await this.db
      .insert(t.healthScans)
      .values({ id: newId('hsc'), projectId: input.projectId, trigger: input.trigger, requestedBy: input.requestedBy })
      .returning();
    return toScan(row!);
  }

  async get(id: string): Promise<HealthScan | null> {
    const [row] = await this.db.select().from(t.healthScans).where(eq(t.healthScans.id, id)).limit(1);
    return row ? toScan(row) : null;
  }

  async list(projectId: string, limit = 20): Promise<HealthScan[]> {
    const rows = await this.db
      .select()
      .from(t.healthScans)
      .where(eq(t.healthScans.projectId, projectId))
      .orderBy(desc(t.healthScans.createdAt), desc(t.healthScans.id))
      .limit(limit);
    return rows.map(toScan);
  }

  async findActive(projectId: string): Promise<HealthScan | null> {
    const [row] = await this.db
      .select()
      .from(t.healthScans)
      .where(and(eq(t.healthScans.projectId, projectId), inArray(t.healthScans.status, ['queued', 'running'])))
      .orderBy(desc(t.healthScans.createdAt))
      .limit(1);
    return row ? toScan(row) : null;
  }

  async update(id: string, patch: HealthScanPatch): Promise<HealthScan> {
    const [row] = await this.db.update(t.healthScans).set(patch).where(eq(t.healthScans.id, id)).returning();
    if (!row) throw new NotFoundError('health scan', id);
    return toScan(row);
  }
}

export class DrizzleProposalRepository implements ProposalRepository {
  constructor(private readonly db: Db) {}

  async upsert(proposal: NewProposal): Promise<{ proposal: ImprovementProposal; created: boolean }> {
    const now = new Date();
    const [row] = await this.db
      .insert(t.improvementProposals)
      .values({ id: newId('imp'), ...proposal })
      .onConflictDoUpdate({
        target: [t.improvementProposals.projectId, t.improvementProposals.fingerprint],
        // Only the sighting is recorded: content and decisions of an existing proposal stay as they are.
        set: { occurrences: sql`${t.improvementProposals.occurrences} + 1`, updatedAt: now },
      })
      .returning();
    return { proposal: toProposal(row!), created: row!.occurrences === 1 };
  }

  async get(id: string): Promise<ImprovementProposal | null> {
    const [row] = await this.db.select().from(t.improvementProposals).where(eq(t.improvementProposals.id, id)).limit(1);
    return row ? toProposal(row) : null;
  }

  async list(filter: ProposalFilter): Promise<ImprovementProposal[]> {
    const conditions: SQL[] = [];
    if (filter.projectId) conditions.push(eq(t.improvementProposals.projectId, filter.projectId));
    if (filter.statuses && filter.statuses.length > 0) conditions.push(inArray(t.improvementProposals.status, [...filter.statuses]));
    const rows = await this.db
      .select()
      .from(t.improvementProposals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(t.improvementProposals.priority), desc(t.improvementProposals.roiScore), asc(t.improvementProposals.createdAt))
      .limit(filter.limit ?? 200);
    return rows.map(toProposal);
  }

  async accept(id: string, input: { taskId: string; decidedBy: string; auto: boolean }): Promise<ImprovementProposal | null> {
    const now = new Date();
    const [row] = await this.db
      .update(t.improvementProposals)
      .set({ status: 'accepted', taskId: input.taskId, decidedBy: input.decidedBy, autoAccepted: input.auto, decidedAt: now, updatedAt: now })
      .where(and(eq(t.improvementProposals.id, id), eq(t.improvementProposals.status, 'proposed')))
      .returning();
    return row ? toProposal(row) : null;
  }

  async dismiss(id: string, input: { decidedBy: string; reason: string | null }): Promise<ImprovementProposal | null> {
    const now = new Date();
    const [row] = await this.db
      .update(t.improvementProposals)
      .set({ status: 'dismissed', decidedBy: input.decidedBy, dismissReason: input.reason, decidedAt: now, updatedAt: now })
      .where(and(eq(t.improvementProposals.id, id), eq(t.improvementProposals.status, 'proposed')))
      .returning();
    return row ? toProposal(row) : null;
  }
}

export class DrizzleAgentCacheStore implements AgentCacheStore {
  constructor(private readonly db: Db) {}

  async get(key: string, now: Date): Promise<AgentCacheEntry | null> {
    const [row] = await this.db
      .select()
      .from(t.cacheEntries)
      .where(and(eq(t.cacheEntries.key, key), or(isNull(t.cacheEntries.expiresAt), gt(t.cacheEntries.expiresAt, now))))
      .limit(1);
    if (!row) return null;
    return { key: row.key, projectId: row.projectId, kind: row.kind, contentHash: row.contentHash, value: row.value as CachedAgentOutput, expiresAt: row.expiresAt };
  }

  async set(entry: AgentCacheEntry): Promise<void> {
    const values = { projectId: entry.projectId, kind: entry.kind, contentHash: entry.contentHash, value: entry.value, expiresAt: entry.expiresAt, createdAt: new Date(), hits: 0 };
    await this.db
      .insert(t.cacheEntries)
      .values({ key: entry.key, ...values })
      .onConflictDoUpdate({ target: t.cacheEntries.key, set: values });
  }

  async recordHit(key: string): Promise<void> {
    await this.db
      .update(t.cacheEntries)
      .set({ hits: sql`${t.cacheEntries.hits} + 1` })
      .where(eq(t.cacheEntries.key, key));
  }

  /** Removes expired entries; returns how many were deleted. */
  async purgeExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(t.cacheEntries)
      .where(sql`${t.cacheEntries.expiresAt} is not null and ${t.cacheEntries.expiresAt} <= ${now}`)
      .returning({ key: t.cacheEntries.key });
    return rows.length;
  }

  async stats(projectId?: string): Promise<{ entries: number; hits: number }> {
    const [row] = await this.db
      .select({ entries: sql<number>`cast(count(*) as int)`, hits: sql<number>`coalesce(sum(${t.cacheEntries.hits}), 0)` })
      .from(t.cacheEntries)
      .where(projectId ? eq(t.cacheEntries.projectId, projectId) : undefined);
    return { entries: Number(row?.entries ?? 0), hits: Number(row?.hits ?? 0) };
  }
}

export class DrizzleFileSummaryStore implements FileSummaryStore {
  constructor(private readonly db: Db) {}

  async updateSummaries(projectId: string, summaries: ReadonlyArray<{ path: string; sha: string; summary: string }>): Promise<number> {
    let updated = 0;
    for (const entry of summaries) {
      // Guarded by the blob sha: a summary of an outdated blob must never be attached to newer content.
      const rows = await this.db
        .update(t.repoFiles)
        .set({ summary: entry.summary, summarySha: entry.sha, updatedAt: new Date() })
        .where(and(eq(t.repoFiles.projectId, projectId), eq(t.repoFiles.path, entry.path), eq(t.repoFiles.sha, entry.sha)))
        .returning({ path: t.repoFiles.path });
      updated += rows.length;
    }
    return updated;
  }
}

export interface HealthRepositories {
  healthScans: DrizzleHealthScanRepository;
  proposals: DrizzleProposalRepository;
  agentCache: DrizzleAgentCacheStore;
  fileSummaries: DrizzleFileSummaryStore;
}

export function createHealthRepositories(db: Db): HealthRepositories {
  return {
    healthScans: new DrizzleHealthScanRepository(db),
    proposals: new DrizzleProposalRepository(db),
    agentCache: new DrizzleAgentCacheStore(db),
    fileSummaries: new DrizzleFileSummaryStore(db),
  };
}
