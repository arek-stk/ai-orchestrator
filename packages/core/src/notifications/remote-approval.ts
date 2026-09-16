import { createHash } from 'node:crypto';
import type { Risk } from '../domain/enums';
import type { Approval, ApprovalAction } from '../domain/records';

// Remote approval policy (owner decision 2026-09-16, ADR-038). Pure and exhaustively tested.
//
//   Tier A: one tap from Telegram, or the confirm page.
//   Tier B: only the confirm page in the logged-in app, after the details were shown.
//   Tier C: never remotely; decided on /approvals with the full findings.
//   Reject: allowed everywhere with one tap (fail-safe: the run blocks with a reason and can be retried).
//   Remote approvals are off until the user enables them; `risk = high` moves an action one tier stricter.

export type RemoteApprovalTier = 'A' | 'B' | 'C';

/**
 * Every approval action the orchestrator can request, mapped explicitly. `satisfies` makes the compiler reject a new
 * gated action until it has a tier here.
 */
export const REMOTE_APPROVAL_TIERS = {
  // A: reversible. A PR is not a merge, cost is capped by budgets, architecture changes still pass review and CI.
  publish_changes: 'A',
  architecture_change: 'A',
  high_cost: 'A',
  // B: reversible with effort; the decider must see paths and reasons first.
  database_migration: 'B',
  external_service: 'B',
  critical_infrastructure: 'B',
  // C: irreversible or supply-chain relevant. Merges run under the production_deploy gate.
  production_deploy: 'C',
  dependency_addition: 'C',
  secrets_permissions: 'C',
  destructive_data: 'C',
} as const satisfies Record<ApprovalAction, RemoteApprovalTier>;

const STRICTER: Record<RemoteApprovalTier, RemoteApprovalTier> = { A: 'B', B: 'C', C: 'C' };

/** Tier of an approval; unknown actions are tier C (deny by default). */
export function remoteApprovalTier(action: string, risk: Risk | string): RemoteApprovalTier {
  const base: RemoteApprovalTier = Object.prototype.hasOwnProperty.call(REMOTE_APPROVAL_TIERS, action) ? REMOTE_APPROVAL_TIERS[action as ApprovalAction] : 'C';
  return risk === 'high' ? STRICTER[base] : base;
}

/** web: the existing /approvals page in the app (not remote). confirm_page: /approve/[token]. telegram: inline button. */
export const DECISION_VIAS = ['web', 'confirm_page', 'telegram'] as const;
export type DecisionVia = (typeof DECISION_VIAS)[number];

export type RemoteDecision = 'approve' | 'reject';

export type RemotePolicyResult = { allowed: true } | { allowed: false; code: 'remote_disabled' | 'confirm_page_only' | 'in_app_only'; reason: string };

export interface RemotePolicyInput {
  action: string;
  risk: Risk | string;
  decision: RemoteDecision;
  via: DecisionVia;
  /** The deciding user's "approvals from outside the app" setting (default off). */
  remoteApprovalsEnabled: boolean;
}

export function remoteDecisionPolicy(input: RemotePolicyInput): RemotePolicyResult {
  if (input.via === 'web') return { allowed: true };
  if (input.decision === 'reject') return { allowed: true };
  if (!input.remoteApprovalsEnabled) {
    return { allowed: false, code: 'remote_disabled', reason: 'Approvals from outside the app are turned off in your notification settings.' };
  }
  const tier = remoteApprovalTier(input.action, input.risk);
  if (tier === 'C') return { allowed: false, code: 'in_app_only', reason: 'This action can only be approved on the Approvals page in the app.' };
  if (tier === 'B' && input.via !== 'confirm_page') {
    return { allowed: false, code: 'confirm_page_only', reason: 'This action can only be approved on the confirmation page in the app.' };
  }
  return { allowed: true };
}

/** Which one-tap buttons a platform message may carry for this approval. Reject is always offered. */
export function oneTapButtons(action: string, risk: Risk | string, remoteApprovalsEnabled: boolean): { approve: boolean; reject: true } {
  return { approve: remoteApprovalsEnabled && remoteApprovalTier(action, risk) === 'A', reject: true };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * SHA-256 over the canonical content of an approval. Action tokens are bound to it, so a token issued for one version
 * of a request cannot decide a changed or different one.
 */
export function approvalDigest(approval: Pick<Approval, 'id' | 'action' | 'risk' | 'details' | 'requestedAt' | 'runId' | 'projectId'>): string {
  return createHash('sha256')
    .update(canonical({ id: approval.id, projectId: approval.projectId, action: approval.action, risk: approval.risk, details: approval.details, requestedAt: approval.requestedAt, runId: approval.runId }))
    .digest('hex');
}
