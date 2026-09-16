import { findLeaseConflicts, isLeaseActive, type Lease, type LeaseRepository } from '../board/leases';
import type { Milestone, MilestoneRepository } from '../board/milestones';
import { systemClock, type Clock, type TaskRepository } from '../ports';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory milestones and leases with the semantics of the Drizzle repositories: deleting a milestone detaches its
 * tasks, lease acquisition checks conflicts atomically, ending a lease happens once.
 */
export function createMemoryBoardStore(deps: { tasks: TaskRepository; clock?: Clock }) {
  const clock = deps.clock ?? systemClock;
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;
  const milestoneMap = new Map<string, Milestone>();
  const leaseMap = new Map<string, Lease>();

  const milestones: MilestoneRepository = {
    create: async (projectId, input, createdBy) => {
      const now = clock.now();
      const milestone: Milestone = { ...clone(input), id: id('mst'), projectId, createdBy, createdAt: now, updatedAt: now };
      milestoneMap.set(milestone.id, milestone);
      return clone(milestone);
    },
    get: async (milestoneId) => clone(milestoneMap.get(milestoneId) ?? null),
    list: async (projectId) =>
      clone([...milestoneMap.values()].filter((m) => m.projectId === projectId).sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())),
    update: async (milestoneId, patch) => {
      const milestone = milestoneMap.get(milestoneId);
      if (!milestone) throw new Error(`milestone ${milestoneId} not found`);
      Object.assign(milestone, clone(patch), { updatedAt: clock.now() });
      return clone(milestone);
    },
    delete: async (milestoneId) => {
      const milestone = milestoneMap.get(milestoneId);
      if (!milestone) return false;
      milestoneMap.delete(milestoneId);
      for (const task of await deps.tasks.list({ projectId: milestone.projectId, limit: 10_000 })) {
        if (task.milestoneId === milestoneId) await deps.tasks.update(task.id, { milestoneId: null });
      }
      return true;
    },
  };

  const leases: LeaseRepository & { all(): Lease[] } = {
    all: () => clone([...leaseMap.values()]),
    acquire: async (input, now) => {
      const active = [...leaseMap.values()].filter((l) => l.projectId === input.projectId && isLeaseActive(l, now));
      const conflicts = findLeaseConflicts(active, input, now);
      if (conflicts.length > 0) return { lease: null, conflicts: clone(conflicts) };
      const lease: Lease = { ...clone(input), id: id('lse'), heartbeatAt: now, createdAt: now, releasedAt: null, releasedBy: null, endReason: null };
      leaseMap.set(lease.id, lease);
      return { lease: clone(lease), conflicts: [] };
    },
    get: async (leaseId) => clone(leaseMap.get(leaseId) ?? null),
    listActive: async (filter, now) =>
      clone(
        [...leaseMap.values()]
          .filter((l) => isLeaseActive(l, now))
          .filter((l) => (!filter.projectId || l.projectId === filter.projectId) && (!filter.scope || l.scope === filter.scope) && (!filter.taskId || l.taskId === filter.taskId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, filter.limit ?? 500),
      ),
    heartbeat: async (leaseId, expiresAt, now) => {
      const lease = leaseMap.get(leaseId);
      if (!lease || !isLeaseActive(lease, now)) return null;
      lease.expiresAt = expiresAt;
      lease.heartbeatAt = now;
      return clone(lease);
    },
    end: async (leaseId, by, reason, now) => {
      const lease = leaseMap.get(leaseId);
      if (!lease || lease.releasedAt !== null) return null;
      // A holder cannot release a lease that already expired; the reaper ends it as expired.
      if (reason !== 'expired' && !isLeaseActive(lease, now)) return null;
      Object.assign(lease, { releasedAt: now, releasedBy: by, endReason: reason });
      return clone(lease);
    },
    listExpired: async (now, limit) =>
      clone(
        [...leaseMap.values()]
          .filter((l) => l.releasedAt === null && l.expiresAt.getTime() <= now.getTime())
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
          .slice(0, limit),
      ),
  };

  return { milestones, leases };
}
