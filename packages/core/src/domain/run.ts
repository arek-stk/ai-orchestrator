import type { RunStage, RunStatus, StageStatus } from './enums';
import type { StopConditions } from './project';
import type { StagePlanItem } from '../pipeline/stage-planner';

export interface StageState {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  attempts: number;
}

export interface FileChange {
  path: string;
  action: 'create' | 'update' | 'delete';
  /** Full new file content for create/update. */
  content?: string;
  rationale?: string;
}

export interface VerificationReport {
  status: 'passed' | 'failed' | 'deferred' | 'skipped';
  source: 'sandbox' | 'ci' | 'none';
  summary: string;
  fingerprint?: string;
  /** Redacted, truncated output. */
  output?: string;
}

export interface FailureRecord {
  stage: RunStage;
  summary: string;
  fingerprint: string;
  at: string;
}

/**
 * Everything a run has produced so far. Persisted after every step so a crashed worker resumes
 * exactly where it stopped. Agent outputs are stored as validated JSON and re-parsed on read.
 */
export interface RunCheckpoint {
  outputs: Partial<Record<'analysis' | 'plan' | 'design' | 'build' | 'tests' | 'debug' | 'review' | 'security', unknown>>;
  designDecisionId: string | null;
  changeset: FileChange[];
  verification: VerificationReport | null;
  failures: FailureRecord[];
  branch: string | null;
  baseSha: string | null;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  ciAttempts: number;
  pendingApprovalId: string | null;
  approvedActions: string[];
  notes: string[];
}

export function emptyCheckpoint(): RunCheckpoint {
  return {
    outputs: {},
    designDecisionId: null,
    changeset: [],
    verification: null,
    failures: [],
    branch: null,
    baseSha: null,
    commitSha: null,
    prNumber: null,
    prUrl: null,
    ciAttempts: 0,
    pendingApprovalId: null,
    approvedActions: [],
    notes: [],
  };
}

export interface PipelineRun {
  id: string;
  taskId: string;
  projectId: string;
  status: RunStatus;
  currentStage: RunStage | null;
  stagePlan: StagePlanItem[];
  stageStates: Partial<Record<RunStage, StageState>>;
  iterations: number;
  debugAttempts: number;
  costUsd: number;
  tokens: number;
  limits: StopConditions;
  checkpoint: RunCheckpoint;
  error: string | null;
  blockedReason: string | null;
  /** When WAITING on something time-based (e.g. CI polling), the earliest time to resume. */
  resumeAt: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
  /** Optimistic concurrency token. */
  version: number;
}
