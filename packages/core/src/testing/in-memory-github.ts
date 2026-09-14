import { createHash } from 'node:crypto';
import type {
  CheckReport,
  CommitFileChange,
  GitHubPort,
  PullRequestRef,
  RepoCoordinates,
  RepoTree,
  WorkflowRunRef,
} from '../github/port';

interface Commit {
  sha: string;
  parent: string | null;
  message: string;
  files: Map<string, string>;
}

interface PullRequest {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'merged';
}

interface RepoState {
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  pulls: PullRequest[];
  dispatched: Array<{ workflow: string; ref: string }>;
}

const SUCCESS: CheckReport = { state: 'success', conclusion: 'success', jobs: [], logExcerpt: '', url: null, runIds: [] };

/**
 * Deterministic GitHub stand-in for tests and demo mode. Behaves like the real API where it matters:
 * commits are immutable objects, branch updates must fast-forward, PRs are upserted per head branch.
 */
export class InMemoryGitHub implements GitHubPort {
  private readonly repos = new Map<string, RepoState>();
  private counter = 0;
  private readonly checkPolls = new Map<string, number>();
  private readonly workflowPolls = new Map<string, number>();
  private readonly pendingFailures = new Map<keyof GitHubPort, Error>();
  readonly reruns: number[][] = [];

  /** CI script: return the report for a commit on the n-th poll (0-based). Default: immediate success. */
  checks: (sha: string, poll: number) => CheckReport = () => SUCCESS;
  /** Deployment workflow script. Default: completed successfully. */
  workflowRun: (poll: number) => WorkflowRunRef = () => ({ id: 1, status: 'completed', conclusion: 'success', url: null });

  seed(repo: RepoCoordinates, files: Record<string, string>, branch = 'main'): string {
    const state: RepoState = { branches: new Map(), commits: new Map(), pulls: [], dispatched: [] };
    this.repos.set(this.key(repo), state);
    const sha = this.nextSha('seed');
    state.commits.set(sha, { sha, parent: null, message: 'initial', files: new Map(Object.entries(files)) });
    state.branches.set(branch, sha);
    return sha;
  }

  /** Makes the next call of `method` throw `error` once. */
  failNext(method: keyof GitHubPort, error: Error): void {
    this.pendingFailures.set(method, error);
  }

  branch(repo: RepoCoordinates, branch: string): string | undefined {
    return this.state(repo).branches.get(branch);
  }

  fileAt(repo: RepoCoordinates, sha: string, path: string): string | undefined {
    return this.state(repo).commits.get(sha)?.files.get(path);
  }

  pulls(repo: RepoCoordinates): readonly PullRequest[] {
    return this.state(repo).pulls;
  }

  commitCount(repo: RepoCoordinates): number {
    return this.state(repo).commits.size;
  }

  dispatched(repo: RepoCoordinates): ReadonlyArray<{ workflow: string; ref: string }> {
    return this.state(repo).dispatched;
  }

  // -------------------------------------------------------------------------

  async getBranchSha(repo: RepoCoordinates, branch: string): Promise<string | null> {
    this.maybeFail('getBranchSha');
    return this.state(repo).branches.get(branch) ?? null;
  }

  async getTree(repo: RepoCoordinates, ref: string): Promise<RepoTree> {
    this.maybeFail('getTree');
    const commit = this.resolve(repo, ref);
    return {
      headSha: commit.sha,
      entries: [...commit.files.entries()]
        .map(([path, content]) => ({ path, sha: hash(content), size: Buffer.byteLength(content) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      truncated: false,
    };
  }

  async getFileContent(repo: RepoCoordinates, path: string, ref: string): Promise<string | null> {
    this.maybeFail('getFileContent');
    return this.resolve(repo, ref).files.get(path) ?? null;
  }

  async createBranch(repo: RepoCoordinates, branch: string, fromSha: string): Promise<void> {
    this.maybeFail('createBranch');
    const state = this.state(repo);
    if (state.branches.has(branch)) throw new Error(`branch ${branch} already exists`);
    if (!state.commits.has(fromSha)) throw new Error(`unknown commit ${fromSha}`);
    state.branches.set(branch, fromSha);
  }

  async createCommit(repo: RepoCoordinates, input: { parentSha: string; message: string; changes: CommitFileChange[] }): Promise<string> {
    this.maybeFail('createCommit');
    const state = this.state(repo);
    const parent = state.commits.get(input.parentSha);
    if (!parent) throw new Error(`unknown parent ${input.parentSha}`);
    const files = new Map(parent.files);
    for (const change of input.changes) {
      if (change.action === 'delete') files.delete(change.path);
      else files.set(change.path, change.content ?? '');
    }
    const sha = this.nextSha(input.message);
    state.commits.set(sha, { sha, parent: parent.sha, message: input.message, files });
    return sha;
  }

  async updateBranch(repo: RepoCoordinates, branch: string, sha: string): Promise<void> {
    this.maybeFail('updateBranch');
    const state = this.state(repo);
    const current = state.branches.get(branch);
    if (!current) throw new Error(`branch ${branch} does not exist`);
    if (!this.isAncestor(state, current, sha)) throw new Error(`update of ${branch} is not a fast-forward`);
    state.branches.set(branch, sha);
  }

  async upsertPullRequest(repo: RepoCoordinates, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestRef> {
    this.maybeFail('upsertPullRequest');
    const state = this.state(repo);
    const existing = state.pulls.find((p) => p.head === input.head && p.state === 'open');
    if (existing) {
      existing.title = input.title;
      existing.body = input.body;
      return { number: existing.number, url: this.prUrl(repo, existing.number), created: false };
    }
    const number = state.pulls.length + 1;
    state.pulls.push({ number, ...input, state: 'open' });
    return { number, url: this.prUrl(repo, number), created: true };
  }

  async getChecks(_repo: RepoCoordinates, sha: string): Promise<CheckReport> {
    this.maybeFail('getChecks');
    const poll = this.checkPolls.get(sha) ?? 0;
    this.checkPolls.set(sha, poll + 1);
    return this.checks(sha, poll);
  }

  async rerunFailedChecks(_repo: RepoCoordinates, runIds: number[]): Promise<void> {
    this.maybeFail('rerunFailedChecks');
    this.reruns.push([...runIds]);
  }

  async mergePullRequest(repo: RepoCoordinates, number: number): Promise<string> {
    this.maybeFail('mergePullRequest');
    const state = this.state(repo);
    const pull = state.pulls.find((p) => p.number === number);
    if (!pull || pull.state !== 'open') throw new Error(`pull request #${number} is not open`);
    const headSha = state.branches.get(pull.head)!;
    state.branches.set(pull.base, headSha);
    pull.state = 'merged';
    return headSha;
  }

  async dispatchWorkflow(repo: RepoCoordinates, workflow: string, ref: string): Promise<void> {
    this.maybeFail('dispatchWorkflow');
    this.state(repo).dispatched.push({ workflow, ref });
  }

  async getLatestWorkflowRun(repo: RepoCoordinates, workflow: string): Promise<WorkflowRunRef | null> {
    this.maybeFail('getLatestWorkflowRun');
    if (!this.state(repo).dispatched.some((d) => d.workflow === workflow)) return null;
    const poll = this.workflowPolls.get(workflow) ?? 0;
    this.workflowPolls.set(workflow, poll + 1);
    return this.workflowRun(poll);
  }

  // -------------------------------------------------------------------------

  private key(repo: RepoCoordinates): string {
    return `${repo.owner}/${repo.name}`.toLowerCase();
  }

  private state(repo: RepoCoordinates): RepoState {
    const state = this.repos.get(this.key(repo));
    if (!state) throw new Error(`repository ${repo.owner}/${repo.name} not found`);
    return state;
  }

  private resolve(repo: RepoCoordinates, ref: string): Commit {
    const state = this.state(repo);
    const sha = state.branches.get(ref) ?? ref;
    const commit = state.commits.get(sha);
    if (!commit) throw new Error(`unknown ref ${ref}`);
    return commit;
  }

  private isAncestor(state: RepoState, ancestor: string, sha: string): boolean {
    let cursor: string | null = sha;
    while (cursor) {
      if (cursor === ancestor) return true;
      cursor = state.commits.get(cursor)?.parent ?? null;
    }
    return false;
  }

  private nextSha(seed: string): string {
    return hash(`${seed}:${++this.counter}`) + '0'.repeat(24);
  }

  private prUrl(repo: RepoCoordinates, number: number): string {
    return `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
  }

  private maybeFail(method: keyof GitHubPort): void {
    const error = this.pendingFailures.get(method);
    if (error) {
      this.pendingFailures.delete(method);
      throw error;
    }
  }
}

function hash(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}
