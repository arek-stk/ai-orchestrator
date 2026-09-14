import { Octokit, RequestError } from 'octokit';
import {
  GitHubUnavailableError,
  redactSecrets,
  type CheckReport,
  type CheckState,
  type CiJob,
  type CommitFileChange,
  type GitHubPort,
  type PullRequestRef,
  type RepoCoordinates,
  type RepoTree,
  type WorkflowRunRef,
} from '@orch/core';

export interface OctokitGitHubOptions {
  token: string;
  /** GitHub Enterprise or test server. */
  baseUrl?: string;
  /** HTTP retries for transient 5xx responses (the job queue retries on top of this). */
  retries?: number;
  maxLogBytes?: number;
}

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const quietLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export interface CheckRunLike {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  html_url?: string | null;
  output?: { title?: string | null; summary?: string | null };
}

export interface WorkflowRunLike {
  id: number;
  status: string | null;
  conclusion: string | null;
  html_url?: string;
}

/** Folds check runs and workflow runs of a commit into one CI state. */
export function aggregateChecks(
  checkRuns: readonly CheckRunLike[],
  workflowRuns: readonly WorkflowRunLike[],
): { state: CheckState; conclusion: string | null; url: string | null; failedRunIds: number[] } {
  if (checkRuns.length === 0 && workflowRuns.length === 0) return { state: 'none', conclusion: null, url: null, failedRunIds: [] };
  if (checkRuns.some((r) => r.status !== 'completed') || workflowRuns.some((r) => r.status !== 'completed')) {
    return { state: 'pending', conclusion: null, url: null, failedRunIds: [] };
  }
  const failedCheck = checkRuns.find((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion));
  const failedRuns = workflowRuns.filter((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion));
  if (failedCheck || failedRuns.length > 0) {
    return {
      state: 'failure',
      conclusion: failedCheck?.conclusion ?? failedRuns[0]?.conclusion ?? 'failure',
      url: failedCheck?.details_url ?? failedCheck?.html_url ?? failedRuns[0]?.html_url ?? null,
      failedRunIds: failedRuns.map((r) => r.id),
    };
  }
  return { state: 'success', conclusion: 'success', url: null, failedRunIds: [] };
}

function tail(text: string, maxBytes: number): string {
  return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
}

function normalizeRunStatus(status: string | null): WorkflowRunRef['status'] {
  if (status === 'completed' || status === 'in_progress') return status;
  return 'queued';
}

/**
 * GitHubPort on the GitHub REST API (ADR-006). Commits are built with the Git Data API
 * (blobs → tree → commit → ref), so no clone and no host git process is needed.
 */
export class OctokitGitHub implements GitHubPort {
  private readonly octokit: InstanceType<typeof Octokit>;
  private readonly maxLogBytes: number;

  constructor(options: OctokitGitHubOptions) {
    this.octokit = new Octokit({
      auth: options.token,
      userAgent: 'ai-orchestrator',
      log: quietLog,
      request: { retries: options.retries ?? 2 },
      // Rate limits surface as GitHubUnavailableError; the run waits instead of blocking a worker.
      throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    this.maxLogBytes = options.maxLogBytes ?? 16_000;
  }

  async getBranchSha(repo: RepoCoordinates, branch: string): Promise<string | null> {
    const response = await this.orNullOn404(() => this.octokit.rest.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${branch}` }));
    return response?.data.object.sha ?? null;
  }

  async getTree(repo: RepoCoordinates, ref: string): Promise<RepoTree> {
    const sha = /^[0-9a-f]{40}$/i.test(ref) ? ref : await this.getBranchSha(repo, ref);
    if (!sha) throw new Error(`ref ${ref} not found in ${repo.owner}/${repo.name}`);
    const commit = await this.call(() => this.octokit.rest.git.getCommit({ owner: repo.owner, repo: repo.name, commit_sha: sha }));
    const tree = await this.call(() =>
      this.octokit.rest.git.getTree({ owner: repo.owner, repo: repo.name, tree_sha: commit.data.tree.sha, recursive: 'true' }),
    );
    return {
      headSha: sha,
      truncated: tree.data.truncated,
      entries: tree.data.tree
        .filter((entry) => entry.type === 'blob' && entry.path && entry.sha)
        .map((entry) => ({ path: entry.path!, sha: entry.sha!, size: entry.size ?? 0 })),
    };
  }

  async getFileContent(repo: RepoCoordinates, path: string, ref: string): Promise<string | null> {
    const response = await this.orNullOn404(() => this.octokit.rest.repos.getContent({ owner: repo.owner, repo: repo.name, path, ref }));
    if (!response) return null;
    const data = response.data;
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    // Files above 1 MB come without inline content; they are too large for model context anyway.
    if (typeof data.content !== 'string' || data.encoding !== 'base64' || data.content.length === 0) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  async createBranch(repo: RepoCoordinates, branch: string, fromSha: string): Promise<void> {
    await this.call(() => this.octokit.rest.git.createRef({ owner: repo.owner, repo: repo.name, ref: `refs/heads/${branch}`, sha: fromSha }));
  }

  async createCommit(repo: RepoCoordinates, input: { parentSha: string; message: string; changes: CommitFileChange[] }): Promise<string> {
    const { owner, name } = repo;
    const parent = await this.call(() => this.octokit.rest.git.getCommit({ owner, repo: name, commit_sha: input.parentSha }));

    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
    for (const change of input.changes) {
      if (change.action === 'delete') {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.call(() =>
        this.octokit.rest.git.createBlob({ owner, repo: name, content: Buffer.from(change.content ?? '', 'utf8').toString('base64'), encoding: 'base64' }),
      );
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.data.sha });
    }

    const newTree = await this.call(() => this.octokit.rest.git.createTree({ owner, repo: name, base_tree: parent.data.tree.sha, tree }));
    const commit = await this.call(() =>
      this.octokit.rest.git.createCommit({ owner, repo: name, message: input.message, tree: newTree.data.sha, parents: [input.parentSha] }),
    );
    return commit.data.sha;
  }

  async updateBranch(repo: RepoCoordinates, branch: string, sha: string): Promise<void> {
    await this.call(() => this.octokit.rest.git.updateRef({ owner: repo.owner, repo: repo.name, ref: `heads/${branch}`, sha, force: false }));
  }

  async upsertPullRequest(repo: RepoCoordinates, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestRef> {
    const { owner, name } = repo;
    const open = await this.call(() =>
      this.octokit.rest.pulls.list({ owner, repo: name, state: 'open', head: `${owner}:${input.head}`, base: input.base, per_page: 1 }),
    );
    const existing = open.data[0];
    if (existing) {
      await this.call(() => this.octokit.rest.pulls.update({ owner, repo: name, pull_number: existing.number, title: input.title, body: input.body }));
      return { number: existing.number, url: existing.html_url, created: false };
    }
    const created = await this.call(() =>
      this.octokit.rest.pulls.create({ owner, repo: name, head: input.head, base: input.base, title: input.title, body: input.body }),
    );
    return { number: created.data.number, url: created.data.html_url, created: true };
  }

  async getChecks(repo: RepoCoordinates, sha: string): Promise<CheckReport> {
    const { owner, name } = repo;
    const [checkRuns, workflowRuns] = await Promise.all([
      this.call(() => this.octokit.rest.checks.listForRef({ owner, repo: name, ref: sha, per_page: 100 })),
      this.call(() => this.octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo: name, head_sha: sha, per_page: 50 })),
    ]);
    const aggregate = aggregateChecks(checkRuns.data.check_runs, workflowRuns.data.workflow_runs);
    const jobs: CiJob[] = [];
    let logExcerpt = '';

    if (aggregate.state === 'failure') {
      for (const runId of aggregate.failedRunIds.slice(0, 3)) {
        const runJobs = await this.call(() => this.octokit.rest.actions.listJobsForWorkflowRun({ owner, repo: name, run_id: runId, filter: 'latest', per_page: 50 }));
        for (const job of runJobs.data.jobs) {
          jobs.push({ name: job.name, conclusion: job.conclusion ?? null, steps: (job.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion ?? null })) });
          if (job.conclusion !== 'failure' || logExcerpt.length >= this.maxLogBytes) continue;
          try {
            const log = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo: name, job_id: job.id });
            logExcerpt += `--- ${job.name} ---\n${tail(String(log.data), this.maxLogBytes - logExcerpt.length)}\n`;
          } catch (error) {
            // Logs can be expired or not yet available; classification falls back to job/step conclusions.
            logExcerpt += `--- ${job.name} --- (log unavailable: ${error instanceof Error ? error.message : String(error)})\n`;
          }
        }
      }
      if (logExcerpt.length === 0) {
        logExcerpt = checkRuns.data.check_runs
          .filter((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion))
          .map((r) => `${r.name}: ${r.output?.title ?? ''}\n${r.output?.summary ?? ''}`)
          .join('\n');
      }
    }

    return {
      state: aggregate.state,
      conclusion: aggregate.conclusion,
      jobs,
      logExcerpt: redactSecrets(tail(logExcerpt, this.maxLogBytes)),
      url: aggregate.url,
      runIds: aggregate.failedRunIds,
    };
  }

  async rerunFailedChecks(repo: RepoCoordinates, runIds: number[]): Promise<void> {
    for (const runId of runIds) {
      await this.call(() => this.octokit.rest.actions.reRunWorkflowFailedJobs({ owner: repo.owner, repo: repo.name, run_id: runId }));
    }
  }

  async mergePullRequest(repo: RepoCoordinates, number: number): Promise<string> {
    const response = await this.call(() =>
      this.octokit.rest.pulls.merge({ owner: repo.owner, repo: repo.name, pull_number: number, merge_method: 'squash' }),
    );
    return response.data.sha;
  }

  async dispatchWorkflow(repo: RepoCoordinates, workflow: string, ref: string): Promise<void> {
    await this.call(() => this.octokit.rest.actions.createWorkflowDispatch({ owner: repo.owner, repo: repo.name, workflow_id: workflow, ref }));
  }

  async getLatestWorkflowRun(repo: RepoCoordinates, workflow: string, branch: string): Promise<WorkflowRunRef | null> {
    const response = await this.orNullOn404(() =>
      this.octokit.rest.actions.listWorkflowRuns({ owner: repo.owner, repo: repo.name, workflow_id: workflow, branch, per_page: 1 }),
    );
    const run = response?.data.workflow_runs[0];
    if (!run) return null;
    return { id: run.id, status: normalizeRunStatus(run.status), conclusion: run.conclusion ?? null, url: run.html_url };
  }

  // -------------------------------------------------------------------------

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapGitHubError(error);
    }
  }

  private async orNullOn404<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await this.call(operation);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw error;
    }
  }
}

export function mapGitHubError(error: unknown): Error {
  if (error instanceof GitHubUnavailableError) return error;
  if (error instanceof RequestError) {
    const headers = error.response?.headers ?? {};
    const retryAfterSeconds = Number(headers['retry-after']);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 60_000;
    if (error.status === 429 || (error.status === 403 && headers['x-ratelimit-remaining'] === '0')) {
      return new GitHubUnavailableError(`GitHub rate limit reached: ${error.message}`, { cause: error, retryAfterMs });
    }
    if (error.status >= 500 || error.status === 0) {
      return new GitHubUnavailableError(`GitHub unavailable (${error.status}): ${error.message}`, { cause: error, retryAfterMs });
    }
    return error;
  }
  if (error instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(`${error.message} ${String(error.cause ?? '')}`)) {
    return new GitHubUnavailableError(`GitHub unreachable: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
