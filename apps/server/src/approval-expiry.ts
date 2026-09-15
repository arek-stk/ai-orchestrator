import { ConcurrentModificationError } from '@orch/core';
import type { Container } from './container';

const HOUR_MS = 60 * 60 * 1000;
/** Approvals expired per scheduler tick; the rest follow on the next tick. */
export const MAX_EXPIRIES_PER_TICK = 100;

export interface ExpiryLogger {
  warn(details: object, message?: string): void;
}

/**
 * Expires pending approvals (ADR-023): blocking approvals older than APPROVAL_TTL_HOURS, deferred autopilot approvals
 * at their `expires_at` (session end plus grace, capped; ADR-034). The run waiting on the approval is blocked with a
 * clear reason by the orchestrator; an event and an audit entry are always written.
 */
export async function expireApprovals(container: Container, log?: ExpiryLogger): Promise<number> {
  const ttlMs = container.config.approvalTtlMs;
  if (ttlMs <= 0) return 0;
  const now = container.clock.now();
  const hours = Math.round((ttlMs / HOUR_MS) * 10) / 10;
  const due = await container.repos.approvals.listDue(now, ttlMs, MAX_EXPIRIES_PER_TICK);

  let expired = 0;
  for (const approval of due) {
    const comment = approval.expiresAt
      ? `no decision before ${approval.expiresAt.toISOString()} (autopilot session end plus grace period)`
      : `no decision within ${hours}h (APPROVAL_TTL_HOURS)`;
    const decided = await container.repos.approvals.decide(approval.id, 'expired', 'system', comment);
    if (!decided) continue; // decided by a human in the meantime
    expired++;
    container.metrics.approvalsExpired.inc({ action: approval.action });

    let handled = false;
    try {
      handled = (await container.orchestrator.onApprovalDecided(approval.id)) !== null;
    } catch (error) {
      if (!(error instanceof ConcurrentModificationError)) throw error;
      log?.warn({ approvalId: approval.id, runId: approval.runId }, 'run changed while expiring its approval');
    }
    if (!handled) {
      // No waiting run (already finished or cancelled): still record the transition on the event stream.
      await container.events.emit({
        type: 'approval.decided',
        projectId: approval.projectId,
        taskId: approval.taskId,
        runId: approval.runId,
        payload: { approvalId: approval.id, status: 'expired', by: 'system' },
      });
    }
    await container.admin.audit.record({
      actorType: 'system',
      actorId: 'scheduler',
      action: 'approval.expired',
      target: approval.id,
      details: {
        projectId: approval.projectId,
        runId: approval.runId,
        action: approval.action,
        mode: approval.mode,
        sessionId: approval.sessionId,
        expiresAt: approval.expiresAt?.toISOString() ?? null,
        ttlHours: hours,
        runBlocked: handled,
      },
    });
  }
  return expired;
}
