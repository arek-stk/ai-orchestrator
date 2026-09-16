import type { Clock, EventRecorder, TaskRepository } from '../ports';
import { sanitizeInline } from '../room/content';
import type { BoardActor } from './board';
import {
  DEFAULT_LEASE_TTL_MS,
  leaseExpiry,
  MAX_ACTIVE_LEASES_PER_PROJECT,
  type Lease,
  type LeaseRepository,
  type LeaseScope,
} from './leases';

// Lease use cases (ADR-030 stage 2): people claim tasks or path globs; the scheduler skips foreign task leases and the
// pipeline waits on overlapping path leases. Leases are bounded in time; admins can break them (audited by the caller).

export type LeaseErrorCode = 'lease_not_found' | 'task_not_found' | 'lease_conflict' | 'not_lease_holder' | 'lease_not_active' | 'lease_limit';

export class LeaseError extends Error {
  constructor(
    readonly code: LeaseErrorCode,
    message: string,
    readonly conflicts: Lease[] = [],
  ) {
    super(message);
    this.name = 'LeaseError';
  }
}

export interface LeaseServiceDeps {
  leases: LeaseRepository;
  tasks: Pick<TaskRepository, 'get'>;
  /** Should be the room-projecting recorder so lease changes reach the Project Room. */
  events: EventRecorder;
  clock: Clock;
}

export interface AcquireLeaseInput {
  projectId: string;
  actor: BoardActor;
  scope: LeaseScope;
  taskId?: string | null;
  /** Normalised globs (LeaseGlobsSchema) for path leases. */
  pathGlobs?: string[];
  reason?: string;
  ttlMs?: number;
}

export class LeaseService {
  constructor(private readonly deps: LeaseServiceDeps) {}

  list(projectId: string): Promise<Lease[]> {
    return this.deps.leases.listActive({ projectId, limit: MAX_ACTIVE_LEASES_PER_PROJECT }, this.deps.clock.now());
  }

  private async projectLease(projectId: string, leaseId: string): Promise<Lease> {
    const lease = await this.deps.leases.get(leaseId);
    if (!lease || lease.projectId !== projectId) throw new LeaseError('lease_not_found', 'lease not found');
    return lease;
  }

  /** Acquires a lease for the acting user. Re-acquiring a task lease the user already holds extends it. */
  async acquire(input: AcquireLeaseInput): Promise<{ lease: Lease; created: boolean }> {
    const { projectId, actor, scope } = input;
    const now = this.deps.clock.now();
    const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    let taskId: string | null = null;
    if (scope === 'task') {
      const task = input.taskId ? await this.deps.tasks.get(input.taskId) : null;
      if (!task || task.projectId !== projectId) throw new LeaseError('task_not_found', 'task not found');
      taskId = task.id;
    }
    const active = await this.deps.leases.listActive({ projectId, limit: MAX_ACTIVE_LEASES_PER_PROJECT + 1 }, now);
    const own = scope === 'task' ? active.find((l) => l.scope === 'task' && l.taskId === taskId && l.holderType === 'user' && l.holderId === actor.id) : undefined;
    if (own) {
      const extended = await this.deps.leases.heartbeat(own.id, leaseExpiry(now, ttlMs, own.createdAt), now);
      if (extended) return { lease: extended, created: false };
    }
    if (active.length >= MAX_ACTIVE_LEASES_PER_PROJECT) throw new LeaseError('lease_limit', `a project has at most ${MAX_ACTIVE_LEASES_PER_PROJECT} active leases`);

    const result = await this.deps.leases.acquire(
      {
        projectId,
        holderType: 'user',
        holderId: actor.id,
        holderName: sanitizeInline(actor.name, 100) || 'unknown',
        scope,
        taskId,
        pathGlobs: scope === 'paths' ? (input.pathGlobs ?? []) : [],
        reason: sanitizeInline(input.reason ?? '', 300),
        expiresAt: leaseExpiry(now, ttlMs),
      },
      now,
    );
    if (!result.lease) {
      const holders = [...new Set(result.conflicts.map((l) => l.holderName))].join(', ');
      throw new LeaseError('lease_conflict', `already leased by ${holders}`, result.conflicts);
    }
    const { lease } = result;
    await this.deps.events.emit({
      type: 'lease.acquired',
      projectId,
      taskId: lease.taskId,
      runId: null,
      payload: { leaseId: lease.id, scope: lease.scope, holderType: lease.holderType, holderName: lease.holderName, paths: lease.pathGlobs, expiresAt: lease.expiresAt.toISOString(), reason: lease.reason },
    });
    return { lease, created: true };
  }

  /** Extends the acting user's lease (bounded by the maximum lease duration). */
  async heartbeat(input: { projectId: string; leaseId: string; actor: BoardActor; ttlMs?: number }): Promise<Lease> {
    const lease = await this.projectLease(input.projectId, input.leaseId);
    if (lease.holderType !== 'user' || lease.holderId !== input.actor.id) throw new LeaseError('not_lease_holder', 'only the holder can extend a lease');
    const now = this.deps.clock.now();
    const extended = await this.deps.leases.heartbeat(lease.id, leaseExpiry(now, input.ttlMs ?? DEFAULT_LEASE_TTL_MS, lease.createdAt), now);
    if (!extended) throw new LeaseError('lease_not_active', 'the lease was released or has expired');
    return extended;
  }

  /** Releases a lease. The holder releases; an admin may break someone else's lease (`broken: true`). */
  async release(input: { projectId: string; leaseId: string; actor: BoardActor }): Promise<{ lease: Lease; broken: boolean }> {
    const lease = await this.projectLease(input.projectId, input.leaseId);
    const holder = lease.holderType === 'user' && lease.holderId === input.actor.id;
    if (!holder && !input.actor.admin) throw new LeaseError('not_lease_holder', 'only the holder or an admin can release this lease');
    const now = this.deps.clock.now();
    const ended = await this.deps.leases.end(lease.id, input.actor.id, holder ? 'released' : 'broken', now);
    if (!ended) throw new LeaseError('lease_not_active', 'the lease was already released or has expired');
    await this.deps.events.emit({
      type: 'lease.released',
      projectId: lease.projectId,
      taskId: lease.taskId,
      runId: null,
      payload: { leaseId: lease.id, scope: lease.scope, holderType: lease.holderType, holderName: lease.holderName, broken: !holder, by: input.actor.name },
    });
    return { lease: ended, broken: !holder };
  }

  /** Ends expired leases (scheduler tick). Bounded per call; each lease emits exactly one `lease.expired`. */
  async reap(limit = 100): Promise<number> {
    const now = this.deps.clock.now();
    let reaped = 0;
    for (const lease of await this.deps.leases.listExpired(now, limit)) {
      const ended = await this.deps.leases.end(lease.id, 'system', 'expired', now);
      if (!ended) continue;
      reaped++;
      await this.deps.events.emit({
        type: 'lease.expired',
        projectId: lease.projectId,
        taskId: lease.taskId,
        runId: null,
        payload: { leaseId: lease.id, scope: lease.scope, holderType: lease.holderType, holderName: lease.holderName },
      });
    }
    return reaped;
  }
}
