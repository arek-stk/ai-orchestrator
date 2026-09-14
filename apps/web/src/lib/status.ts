import type { AgentRunStatus, ApprovalStatus, ProjectStatus, RunStatus, StageStatus, TaskStatus, VerificationReport } from './types';

/**
 * Semantic tone for a state. good/warning/serious/critical are the reserved status colors; accent marks
 * in-progress work; muted is idle/skipped. The UI always renders a tone with an icon and a text label.
 */
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'accent' | 'muted';

export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case 'SUCCEEDED':
      return 'good';
    case 'RUNNING':
    case 'QUEUED':
      return 'accent';
    case 'WAITING':
    case 'PAUSED':
      return 'warning';
    case 'BLOCKED':
      return 'serious';
    case 'FAILED':
      return 'critical';
    default:
      return 'muted';
  }
}

export function taskStatusTone(status: TaskStatus): Tone {
  switch (status) {
    case 'DONE':
      return 'good';
    case 'RUNNING':
      return 'accent';
    case 'WAITING_APPROVAL':
    case 'WAITING_CHILDREN':
    case 'PAUSED':
      return 'warning';
    case 'BLOCKED':
      return 'serious';
    case 'FAILED':
      return 'critical';
    default:
      return 'muted';
  }
}

export function projectStatusTone(status: ProjectStatus): Tone {
  switch (status) {
    case 'DEPLOYED':
    case 'READY_FOR_RELEASE':
      return 'good';
    case 'PLANNING':
    case 'ANALYZING':
    case 'BUILDING':
    case 'TESTING':
    case 'REVIEWING':
    case 'DEBUGGING':
      return 'accent';
    case 'WAITING':
    case 'PAUSED':
      return 'warning';
    case 'BLOCKED':
      return 'serious';
    case 'FAILED':
      return 'critical';
    default:
      return 'muted';
  }
}

export function stageStatusTone(status: StageStatus): Tone {
  switch (status) {
    case 'passed':
      return 'good';
    case 'running':
      return 'accent';
    case 'waiting':
      return 'warning';
    case 'failed':
      return 'critical';
    default:
      return 'muted';
  }
}

export function agentStatusTone(status: AgentRunStatus): Tone {
  return status === 'succeeded' ? 'good' : status === 'failed' ? 'critical' : 'accent';
}

export function approvalStatusTone(status: ApprovalStatus): Tone {
  return status === 'approved' ? 'good' : status === 'rejected' ? 'critical' : status === 'pending' ? 'warning' : 'muted';
}

export function verificationTone(status: VerificationReport['status']): Tone {
  return status === 'passed' ? 'good' : status === 'failed' ? 'critical' : status === 'deferred' ? 'warning' : 'muted';
}

export function riskTone(risk: string): Tone {
  return risk === 'high' ? 'critical' : risk === 'medium' ? 'warning' : 'good';
}

/** Meter severity for a percentage of budget used. */
export function budgetTone(pct: number): { tone: Tone; label: string } {
  if (pct >= 90) return { tone: 'critical', label: 'Budget nearly exhausted' };
  if (pct >= 70) return { tone: 'warning', label: 'Approaching budget' };
  return { tone: 'accent', label: 'Within budget' };
}

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED'];
