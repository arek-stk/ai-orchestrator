import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  normalizeRepoPath,
  redactSecrets,
  type CommitFileChange,
  type GitHubPort,
  type SandboxCommandResult,
  type SandboxPort,
  type SandboxRunRequest,
  type SandboxRunResult,
} from '@orch/core';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The binary could not be started at all (e.g. docker not installed). */
  spawnError: string | null;
}

export type ExecFn = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<ExecResult>;

/** Runs a fixed binary with an argument array — never through a host shell. */
export const nodeExec: ExecFn = (file, args, { timeoutMs }) =>
  new Promise((resolvePromise) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({ exitCode: 0, stdout, stderr, timedOut: false, spawnError: null });
        return;
      }
      const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
      if (typeof failure.code === 'string') {
        resolvePromise({ exitCode: -1, stdout, stderr, timedOut: false, spawnError: `${failure.code}: ${failure.message}` });
        return;
      }
      resolvePromise({ exitCode: typeof failure.code === 'number' ? failure.code : 1, stdout, stderr, timedOut: failure.killed === true, spawnError: null });
    });
  });

export interface DockerSandboxOptions {
  github: GitHubPort;
  /**
   * Docker network used when a request needs registry access (dependency installation). It must restrict egress
   * (e.g. only a package-registry proxy; no link-local, RFC 1918 or metadata endpoints). Unset → such requests
   * are refused instead of silently getting full internet access.
   */
  egressNetwork?: string | null;
  image?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  maxFiles?: number;
  maxBytes?: number;
  dockerBinary?: string;
  workRoot?: string;
  exec?: ExecFn;
}

export interface DockerArgsInput {
  containerName: string;
  workspace: string;
  image: string;
  command: string;
  /** Docker network name; `none` disables networking. */
  network: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
}

/** Hardened `docker run` arguments (spec §25): no capabilities, read-only root, resource limits, non-root. */
export function buildDockerArgs(input: DockerArgsInput): string[] {
  return [
    'run',
    '--rm',
    '--name', input.containerName,
    '--network', input.network,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=1g',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(input.pidsLimit),
    '--memory', input.memory,
    '--cpus', input.cpus,
    '--user', '1000:1000',
    '--env', 'HOME=/tmp',
    '--env', 'CI=true',
    '--mount', `type=bind,source=${input.workspace},target=/workspace`,
    '--workdir', '/workspace',
    input.image,
    'sh', '-c', input.command,
  ];
}

/** Writes the repository snapshot plus the change set into `root`, refusing any path that escapes it. */
export async function materializeWorkspace(root: string, files: ReadonlyMap<string, string>, changes: readonly CommitFileChange[]): Promise<number> {
  const merged = new Map<string, string>();
  for (const [path, content] of files) merged.set(normalizeRepoPath(path), content);
  for (const change of changes) {
    const path = normalizeRepoPath(change.path);
    if (change.action === 'delete') merged.delete(path);
    else merged.set(path, change.content ?? '');
  }

  const base = resolve(root);
  for (const [path, content] of merged) {
    const target = resolve(base, ...path.split('/'));
    if (!target.startsWith(base + sep)) throw new Error(`refusing to write outside the workspace: ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return merged.size;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

const infrastructure = (message: string, results: SandboxCommandResult[] = []): SandboxRunResult => ({
  passed: false,
  results,
  failedCommand: null,
  infrastructureError: message,
});

/**
 * Executes allow-listed verification commands in throwaway containers (ADR-006). The workspace is a
 * temporary directory built from the repository snapshot and the run's change set; it is always removed.
 */
export class DockerSandbox implements SandboxPort {
  private readonly exec: ExecFn;
  private readonly docker: string;

  private constructor(
    private readonly options: DockerSandboxOptions,
    readonly available: boolean,
  ) {
    this.exec = options.exec ?? nodeExec;
    this.docker = options.dockerBinary ?? 'docker';
  }

  /** Probes the Docker daemon once; an unavailable daemon yields a sandbox with `available = false`. */
  static async detect(options: DockerSandboxOptions): Promise<DockerSandbox> {
    const exec = options.exec ?? nodeExec;
    const probe = await exec(options.dockerBinary ?? 'docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
    return new DockerSandbox(options, probe.spawnError === null && probe.exitCode === 0);
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    if (!this.available) return infrastructure('docker daemon is not available');
    const egress = this.options.egressNetwork ?? null;
    if (request.network === 'registry' && !egress) {
      return infrastructure('dependency installation needs network access: configure SANDBOX_EGRESS_NETWORK (a Docker network restricted to a package-registry proxy)');
    }
    const network = request.network === 'registry' ? egress! : 'none';

    const workspace = await mkdtemp(join(this.options.workRoot ?? tmpdir(), 'orch-sandbox-'));
    try {
      try {
        await materializeWorkspace(workspace, await this.snapshot(request), request.changes);
      } catch (error) {
        return infrastructure(`workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const results: SandboxCommandResult[] = [];
      for (const { name, command } of request.commands) {
        const containerName = `orch-${randomUUID()}`;
        const started = Date.now();
        const result = await this.exec(
          this.docker,
          buildDockerArgs({
            containerName,
            workspace,
            image: this.options.image ?? 'node:22-bookworm-slim',
            command,
            network,
            memory: this.options.memory ?? '2g',
            cpus: this.options.cpus ?? '2',
            pidsLimit: this.options.pidsLimit ?? 512,
          }),
          { timeoutMs: request.timeoutMs },
        );
        if (result.timedOut) await this.exec(this.docker, ['kill', containerName], { timeoutMs: 15_000 });

        // 125: docker itself failed; 126/127: the image cannot execute the command (misconfigured image).
        if (result.spawnError || [125, 126, 127].includes(result.exitCode)) {
          return infrastructure(`docker could not run "${name}": ${result.spawnError ?? tail(result.stderr.trim(), 500)}`, results);
        }

        const output = redactSecrets(tail(`${result.stdout}\n${result.stderr}`.trim(), 16_000)) + (result.timedOut ? '\n[timed out]' : '');
        results.push({ name, exitCode: result.timedOut ? 124 : result.exitCode, output, durationMs: Date.now() - started });
        if (result.timedOut || result.exitCode !== 0) return { passed: false, results, failedCommand: name, infrastructureError: null };
      }
      return { passed: true, results, failedCommand: null, infrastructureError: null };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async snapshot(request: SandboxRunRequest): Promise<Map<string, string>> {
    const maxFiles = this.options.maxFiles ?? 5_000;
    const maxBytes = this.options.maxBytes ?? 50 * 1024 * 1024;
    const tree = await this.options.github.getTree(request.repo, request.ref);
    if (tree.entries.length > maxFiles) throw new Error(`repository has ${tree.entries.length} files; sandbox limit is ${maxFiles}`);
    const total = tree.entries.reduce((sum, e) => sum + e.size, 0);
    if (total > maxBytes) throw new Error(`repository is ${total} bytes; sandbox limit is ${maxBytes}`);

    const files = new Map<string, string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < tree.entries.length) {
        const entry = tree.entries[cursor++]!;
        const content = await this.options.github.getFileContent(request.repo, entry.path, tree.headSha);
        if (content !== null) files.set(entry.path, content);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, tree.entries.length) }, worker));
    return files;
  }
}
