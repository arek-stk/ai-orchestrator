import type { ProjectCommand } from '../domain/project';
import type { CommitFileChange, RepoCoordinates } from '../github/port';

export interface SandboxRunRequest {
  projectId: string;
  repo: RepoCoordinates;
  /** Commit the workspace is checked out at before the change set is applied. */
  ref: string;
  changes: CommitFileChange[];
  /** Resolved from the project profile allow-list only. */
  commands: Array<{ name: ProjectCommand; command: string }>;
  timeoutMs: number;
  /** `registry` allows package-registry egress for installs; everything else runs offline. */
  network: 'none' | 'registry';
}

export interface SandboxCommandResult {
  name: ProjectCommand;
  exitCode: number;
  /** Redacted tail of stdout/stderr. */
  output: string;
  durationMs: number;
}

export interface SandboxRunResult {
  passed: boolean;
  results: SandboxCommandResult[];
  failedCommand: ProjectCommand | null;
  /** Set when the sandbox itself failed (image pull, docker daemon, timeout of the runner). */
  infrastructureError: string | null;
}

/** Isolated execution of verification commands (spec §24, §25). Never runs on the host. */
export interface SandboxPort {
  readonly available: boolean;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export const unavailableSandbox: SandboxPort = {
  available: false,
  run: async () => {
    throw new Error('sandbox is not available');
  },
};
