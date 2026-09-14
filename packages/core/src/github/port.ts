import type { CiJob } from '../ci/classifier';

export interface RepoCoordinates {
  owner: string;
  name: string;
}

export interface RepoTreeEntry {
  path: string;
  /** Blob SHA; unchanged SHA means cached summaries stay valid. */
  sha: string;
  size: number;
}

export interface RepoTree {
  headSha: string;
  entries: RepoTreeEntry[];
  truncated: boolean;
}

export interface CommitFileChange {
  path: string;
  action: 'create' | 'update' | 'delete';
  content?: string;
}

export type CheckState = 'none' | 'pending' | 'success' | 'failure';

export interface CheckReport {
  state: CheckState;
  conclusion: string | null;
  jobs: CiJob[];
  /** Tail of failing job logs, already truncated. */
  logExcerpt: string;
  url: string | null;
  /** Workflow run ids that can be re-run. */
  runIds: number[];
}

export interface PullRequestRef {
  number: number;
  url: string;
  /** false when an existing open PR for the head branch was updated. */
  created: boolean;
}

export interface WorkflowRunRef {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  url: string | null;
}

/**
 * Everything the orchestrator needs from GitHub (ADR-006). Commits are created through the Git Data API,
 * so no local clone is required. Implementations: Octokit (integrations) and InMemoryGitHub (tests, demo).
 */
export interface GitHubPort {
  getBranchSha(repo: RepoCoordinates, branch: string): Promise<string | null>;
  getTree(repo: RepoCoordinates, ref: string): Promise<RepoTree>;
  getFileContent(repo: RepoCoordinates, path: string, ref: string): Promise<string | null>;
  createBranch(repo: RepoCoordinates, branch: string, fromSha: string): Promise<void>;
  /** Creates a commit object on top of `parentSha` without moving any ref. */
  createCommit(repo: RepoCoordinates, input: { parentSha: string; message: string; changes: CommitFileChange[] }): Promise<string>;
  /** Fast-forwards a branch to `sha` (never forced). */
  updateBranch(repo: RepoCoordinates, branch: string, sha: string): Promise<void>;
  upsertPullRequest(repo: RepoCoordinates, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestRef>;
  getChecks(repo: RepoCoordinates, sha: string): Promise<CheckReport>;
  rerunFailedChecks(repo: RepoCoordinates, runIds: number[]): Promise<void>;
  mergePullRequest(repo: RepoCoordinates, number: number): Promise<string>;
  dispatchWorkflow(repo: RepoCoordinates, workflow: string, ref: string): Promise<void>;
  getLatestWorkflowRun(repo: RepoCoordinates, workflow: string, branch: string): Promise<WorkflowRunRef | null>;
}

/** Transient GitHub outage or rate limit: the run waits and retries instead of failing. */
export class GitHubUnavailableError extends Error {
  readonly retryAfterMs: number | null;

  constructor(message: string, options: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, { cause: options.cause });
    this.name = 'GitHubUnavailableError';
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}
