import type { UserRole } from '../domain/enums';
import type { Approval } from '../domain/records';
import { ROLE_RANK } from './access';
import { remoteDecisionPolicy, type DecisionVia } from './remote-approval';

// One authorization function for every decision path (in-app route, confirm page, Telegram callback), evaluated at
// decision time. A remote path can never grant what the in-app path would deny (threat T17 in the plan).

export type DecisionStatus = 'approved' | 'rejected';

export interface AuthorizeDecisionInput {
  user: { id: string; role: UserRole };
  /** Effective project role at decision time (ADR-022); null when the project is not visible. */
  projectRole: UserRole | null;
  approval: Pick<Approval, 'id' | 'action' | 'risk' | 'status' | 'requestedAt' | 'expiresAt'>;
  decision: DecisionStatus;
  via: DecisionVia;
  remoteApprovalsEnabled: boolean;
  now: Date;
  /** APPROVAL_TTL_HOURS in ms (≤ 0 disables TTL-based expiry, ADR-023). */
  approvalTtlMs: number;
}

export type AuthorizeDecisionCode = 'not_found' | 'forbidden' | 'owner_required' | 'not_pending' | 'expired' | 'remote_disabled' | 'confirm_page_only' | 'in_app_only';

export type AuthorizeDecisionResult = { ok: true } | { ok: false; code: AuthorizeDecisionCode; status: 403 | 404 | 409 | 410; reason: string };

export function approvalExpiresAt(approval: Pick<Approval, 'requestedAt' | 'expiresAt'>, approvalTtlMs: number): Date | null {
  if (approval.expiresAt) return approval.expiresAt;
  return approvalTtlMs > 0 ? new Date(approval.requestedAt.getTime() + approvalTtlMs) : null;
}

export function authorizeDecision(input: AuthorizeDecisionInput): AuthorizeDecisionResult {
  const { user, approval } = input;
  if (input.projectRole === null) return { ok: false, code: 'not_found', status: 404, reason: 'approval not found' };
  if (ROLE_RANK[user.role] < ROLE_RANK.admin) return { ok: false, code: 'forbidden', status: 403, reason: 'requires the admin role' };
  if (ROLE_RANK[input.projectRole] < ROLE_RANK.admin) return { ok: false, code: 'forbidden', status: 403, reason: 'requires the admin role on this project' };
  if (approval.action === 'production_deploy' && input.decision === 'approved' && user.role !== 'owner') {
    return { ok: false, code: 'owner_required', status: 403, reason: 'production deployments must be approved by an owner' };
  }
  if (approval.status !== 'pending') return { ok: false, code: 'not_pending', status: 409, reason: 'approval was already decided' };
  const expiresAt = approvalExpiresAt(approval, input.approvalTtlMs);
  if (expiresAt && expiresAt.getTime() <= input.now.getTime()) return { ok: false, code: 'expired', status: 410, reason: 'approval has expired' };
  const policy = remoteDecisionPolicy({
    action: approval.action,
    risk: approval.risk,
    decision: input.decision === 'approved' ? 'approve' : 'reject',
    via: input.via,
    remoteApprovalsEnabled: input.remoteApprovalsEnabled,
  });
  if (!policy.allowed) return { ok: false, code: policy.code, status: 403, reason: policy.reason };
  return { ok: true };
}
