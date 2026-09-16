import { and, asc, eq, gt, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  findLeaseConflicts,
  type AcquireResult,
  type Lease,
  type LeaseEndReason,
  type LeaseFilter,
  type LeaseRepository,
  type Milestone,
  type MilestoneInput,
  type MilestonePatch,
  type MilestoneRepository,
  type NewLease,
} from '@orch/core';
import type { Db } from './client';
import { newId } from './ids';
import { NotFoundError } from './repositories';
import * as t from './schema';

// Milestones and leases (ADR-030 stage 2).

function toMilestone(row: typeof t.milestones.$inferSelect): Milestone {
  return { ...row };
}

function toLease(row: typeof t.leases.$inferSelect): Lease {
  return { ...row };
}

export class DrizzleMilestoneRepository implements MilestoneRepository {
  constructor(private readonly db: Db) {}

  async create(projectId: string, input: MilestoneInput & { position: number }, createdBy: string | null): Promise<Milestone> {
    const [row] = await this.db
      .insert(t.milestones)
      .values({
        id: newId('mst'),
        projectId,
        title: input.title,
        description: input.description,
        status: input.status,
        startDate: input.startDate,
        dueDate: input.dueDate,
        position: input.position,
        createdBy,
      })
      .returning();
    return toMilestone(row!);
  }

  async get(id: string): Promise<Milestone | null> {
    const [row] = await this.db.select().from(t.milestones).where(eq(t.milestones.id, id)).limit(1);
    return row ? toMilestone(row) : null;
  }

  async list(projectId: string): Promise<Milestone[]> {
    const rows = await this.db.select().from(t.milestones).where(eq(t.milestones.projectId, projectId)).orderBy(asc(t.milestones.position), asc(t.milestones.createdAt)).limit(500);
    return rows.map(toMilestone);
  }

  async update(id: string, patch: MilestonePatch): Promise<Milestone> {
    const [row] = await this.db
      .update(t.milestones)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(t.milestones.id, id))
      .returning();
    if (!row) throw new NotFoundError('milestone', id);
    return toMilestone(row);
  }

  async delete(id: string): Promise<boolean> {
    // tasks.milestone_id is ON DELETE SET NULL, so the tasks stay.
    const rows = await this.db.delete(t.milestones).where(eq(t.milestones.id, id)).returning({ id: t.milestones.id });
    return rows.length > 0;
  }
}

export class DrizzleLeaseRepository implements LeaseRepository {
  constructor(private readonly db: Db) {}

  async acquire(input: NewLease, now: Date): Promise<AcquireResult> {
    return this.db.transaction(async (tx) => {
      // Serialises acquisitions per project (also across processes): lock the project row for this transaction.
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      const active = await tx
        .select()
        .from(t.leases)
        .where(and(eq(t.leases.projectId, input.projectId), isNull(t.leases.releasedAt), gt(t.leases.expiresAt, now)))
        .limit(1000);
      const conflicts = findLeaseConflicts(active.map(toLease), input, now);
      if (conflicts.length > 0) return { lease: null, conflicts };
      const [row] = await tx
        .insert(t.leases)
        .values({ id: newId('lse'), ...input, heartbeatAt: now, createdAt: now })
        .returning();
      return { lease: toLease(row!), conflicts: [] as [] };
    });
  }

  async get(id: string): Promise<Lease | null> {
    const [row] = await this.db.select().from(t.leases).where(eq(t.leases.id, id)).limit(1);
    return row ? toLease(row) : null;
  }

  async listActive(filter: LeaseFilter, now: Date): Promise<Lease[]> {
    const conditions: SQL[] = [isNull(t.leases.releasedAt), gt(t.leases.expiresAt, now)];
    if (filter.projectId) conditions.push(eq(t.leases.projectId, filter.projectId));
    if (filter.scope) conditions.push(eq(t.leases.scope, filter.scope));
    if (filter.taskId) conditions.push(eq(t.leases.taskId, filter.taskId));
    const rows = await this.db
      .select()
      .from(t.leases)
      .where(and(...conditions))
      .orderBy(asc(t.leases.createdAt), asc(t.leases.id))
      .limit(filter.limit ?? 500);
    return rows.map(toLease);
  }

  async heartbeat(id: string, expiresAt: Date, now: Date): Promise<Lease | null> {
    const [row] = await this.db
      .update(t.leases)
      .set({ expiresAt, heartbeatAt: now })
      .where(and(eq(t.leases.id, id), isNull(t.leases.releasedAt), gt(t.leases.expiresAt, now)))
      .returning();
    return row ? toLease(row) : null;
  }

  async end(id: string, by: string, reason: LeaseEndReason, now: Date): Promise<Lease | null> {
    // Only the reaper ends expired leases; holders cannot release (and re-announce) a lease that already expired.
    const conditions: SQL[] = [eq(t.leases.id, id), isNull(t.leases.releasedAt)];
    if (reason !== 'expired') conditions.push(gt(t.leases.expiresAt, now));
    const [row] = await this.db
      .update(t.leases)
      .set({ releasedAt: now, releasedBy: by, endReason: reason })
      .where(and(...conditions))
      .returning();
    return row ? toLease(row) : null;
  }

  async listExpired(now: Date, limit: number): Promise<Lease[]> {
    const rows = await this.db
      .select()
      .from(t.leases)
      .where(and(isNull(t.leases.releasedAt), lte(t.leases.expiresAt, now)))
      .orderBy(asc(t.leases.expiresAt))
      .limit(limit);
    return rows.map(toLease);
  }
}

export interface BoardRepositories {
  milestones: DrizzleMilestoneRepository;
  leases: DrizzleLeaseRepository;
}

export function createBoardRepositories(db: Db): BoardRepositories {
  return { milestones: new DrizzleMilestoneRepository(db), leases: new DrizzleLeaseRepository(db) };
}
