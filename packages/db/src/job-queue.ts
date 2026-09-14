import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { systemClock, type Clock, type EnqueueJob, type JobQueue } from '@orch/core';
import type { Db } from './client';
import { jobs, type JobStatus } from './schema';

export interface ClaimedJob {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface ClaimOptions {
  limit?: number;
  leaseMs?: number;
  types?: readonly string[];
}

export interface FailOptions {
  /** false → dead-letter immediately (e.g. validation errors that retrying cannot fix). */
  retryable?: boolean;
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Durable job queue on PostgreSQL (ADR-004).
 * - Claiming uses FOR UPDATE SKIP LOCKED, so many workers can poll concurrently.
 * - A claimed job holds a lease; if the worker crashes the lease expires and the job is re-claimed.
 * - Failures retry with exponential backoff until maxAttempts, then the job is dead-lettered.
 */
export class PgJobQueue implements JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async enqueue(job: EnqueueJob): Promise<void> {
    const insert = this.db.insert(jobs).values({
      type: job.type,
      payload: job.payload,
      runAt: job.runAt ?? this.clock.now(),
      maxAttempts: job.maxAttempts ?? 5,
      dedupeKey: job.dedupeKey ?? null,
    });
    if (job.dedupeKey) {
      await insert.onConflictDoNothing({
        target: jobs.dedupeKey,
        where: sql`status in ('queued', 'running')`,
      });
    } else {
      await insert;
    }
  }

  async claim(workerId: string, options: ClaimOptions = {}): Promise<ClaimedJob[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));
    return this.db.transaction(async (tx) => {
      const claimable = or(
        and(eq(jobs.status, 'queued'), lte(jobs.runAt, now)),
        and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now)),
      )!;
      const where = options.types && options.types.length > 0 ? and(claimable, inArray(jobs.type, [...options.types])) : claimable;
      const candidates = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(where)
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(options.limit ?? 1)
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return [];

      const claimed = await tx
        .update(jobs)
        .set({
          status: 'running',
          lockedBy: workerId,
          lockedUntil: leaseUntil,
          attempts: sql`${jobs.attempts} + 1`,
          updatedAt: now,
        })
        .where(
          inArray(
            jobs.id,
            candidates.map((c) => c.id),
          ),
        )
        .returning();
      return claimed.map((row) => ({
        id: row.id,
        type: row.type,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
      }));
    });
  }

  async complete(id: number, workerId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.db
      .update(jobs)
      .set({ status: 'succeeded', finishedAt: now, updatedAt: now, lockedBy: null, lockedUntil: null })
      .where(and(eq(jobs.id, id), eq(jobs.lockedBy, workerId), eq(jobs.status, 'running')))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async fail(id: number, workerId: string, error: string, options: FailOptions = {}): Promise<JobStatus | null> {
    const now = this.clock.now();
    const [job] = await this.db
      .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.lockedBy, workerId), eq(jobs.status, 'running')))
      .limit(1);
    if (!job) return null;

    const retry = (options.retryable ?? true) && job.attempts < job.maxAttempts;
    const status: JobStatus = retry ? 'queued' : 'dead';
    await this.db
      .update(jobs)
      .set({
        status,
        lastError: error.slice(0, 4000),
        runAt: retry ? new Date(now.getTime() + backoffMs(job.attempts)) : undefined,
        finishedAt: retry ? null : now,
        lockedBy: null,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(eq(jobs.id, id));
    return status;
  }

  async extendLease(id: number, workerId: string, leaseMs: number = DEFAULT_LEASE_MS): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ lockedUntil: new Date(this.clock.now().getTime() + leaseMs) })
      .where(and(eq(jobs.id, id), eq(jobs.lockedBy, workerId), eq(jobs.status, 'running')))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async stats(): Promise<Record<JobStatus, number>> {
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`cast(count(*) as int)` })
      .from(jobs)
      .groupBy(jobs.status);
    const result: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
    for (const row of rows) result[row.status] = Number(row.count);
    return result;
  }
}
