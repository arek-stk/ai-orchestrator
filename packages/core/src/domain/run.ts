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
  /** Redacted, truncated failure output handed to the debug agent. */
  output: string;
  at: string;
}

/**
 * Everything a run has produced so far. Persisted after every step so a crashed worker resumes
 * exactly where it stopped. Agent outputs are stored as validated JSON and re-parsed on read.
 */
export interface RunCheckpoint {
  outputs: Partial<Record<'analysis' | 'plan' | 'design' | 'build' | 'tests' | 'debug' | 'review' | 'security' | 'release', unknown>>;
  designDecisionId: string | null;
  changeset: FileChange[];
  /** Incremented on every change-set modification; prevents empty or duplicate commits. */
  changesetVersion: number;
  /** The build agent already produced the current change set (avoids re-building after an approval). */
  buildComplete: boolean;
  /** Review/security/tool feedback the next IMPLEMENT pass must address. */
  feedback: string[];
  verification: VerificationReport | null;
  failures: FailureRecord[];
  /** Stage to continue with after DEBUG. */
  resumeStage: RunStage | null;
  branch: string | null;
  baseSha: string | null;
  pendingCommitSha: string | null;
  pendingCommitVersion: number;
  commitSha: string | null;
  committedVersion: number;
  prNumber: number | null;
  prUrl: string | null;
  ciAttempts: number;
  ciPolls: number;
  deployDispatchedAt: string | null;
  pendingApprovalId: string | null;
  approvedActions: string[];
  notes: string[];
  /** Total time the run spent PARKED waiting for a human (autopilot); excluded from the runtime stop condition. */
  parkedMs?: number;
  /** Final result label, e.g. pr_ready, changes_ready, plan_ready, decomposed, deployed. */
  outcome: string | null;
}

export function emptyCheckpoint(): RunCheckpoint {
  return {
    outputs: {},
    designDecisionId: null,
    changeset: [],
    changesetVersion: 0,
    buildComplete: false,
    feedback: [],
    verification: null,
    failures: [],
    resumeStage: null,
    branch: null,
    baseSha: null,
    pendingCommitSha: null,
    pendingCommitVersion: 0,
    commitSha: null,
    committedVersion: 0,
    prNumber: null,
    prUrl: null,
    ciAttempts: 0,
    ciPolls: 0,
    deployDispatchedAt: null,
    pendingApprovalId: null,
    approvedActions: [],
    notes: [],
    outcome: null,
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
  /** Autopilot session that started this run (null: started by a human or outside a session). */
  sessionId: string | null;
  /** Loop-backs (debug, review feedback, stage retries). Normal stage progression does not count. */
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
