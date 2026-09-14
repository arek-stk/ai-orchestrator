import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGitHub, UnsafePathError, type SandboxRunRequest } from '@orch/core';
import { buildDockerArgs, DockerSandbox, materializeWorkspace, type ExecFn } from './docker';

const repo = { owner: 'acme', name: 'shop' };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-test-'));
  dirs.push(dir);
  return dir;
}

describe('buildDockerArgs', () => {
  it('hardens the container and never uses a host shell', () => {
    const args = buildDockerArgs({
      containerName: 'orch-1',
      workspace: 'C:\\Temp\\ws',
      image: 'node:22-bookworm-slim',
      command: 'npm test',
      network: 'none',
      memory: '2g',
      cpus: '2',
      pidsLimit: 512,
    });
    for (const flag of ['--read-only', '--rm', 'no-new-privileges']) expect(args).toContain(flag);
    expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none']);
    expect(args).toContain('type=bind,source=C:\\Temp\\ws,target=/workspace');
    expect(args.slice(-3)).toEqual(['sh', '-c', 'npm test']);
  });
});

describe('materializeWorkspace', () => {
  it('writes snapshot plus change set and applies deletions', async () => {
    const root = await tempDir();
    const count = await materializeWorkspace(
      root,
      new Map([
        ['src/a.ts', 'a'],
        ['src/old.ts', 'old'],
      ]),
      [
        { path: 'src/b.ts', action: 'create', content: 'b' },
        { path: 'src/old.ts', action: 'delete' },
      ],
    );
    expect(count).toBe(2);
    expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('b');
    expect(existsSync(join(root, 'src', 'old.ts'))).toBe(false);
  });

  it('refuses paths that escape the workspace', async () => {
    const root = await tempDir();
    await expect(materializeWorkspace(root, new Map(), [{ path: '../escape.txt', action: 'create', content: 'x' }])).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe('DockerSandbox', () => {
  function request(commands: SandboxRunRequest['commands']): SandboxRunRequest {
    return { projectId: 'prj', repo, ref: 'main', changes: [{ path: 'src/new.ts', action: 'create', content: 'export {}' }], commands, timeoutMs: 60_000, network: 'none' };
  }

  function setup(results: Array<Partial<Awaited<ReturnType<ExecFn>>>>) {
    const github = new InMemoryGitHub();
    github.seed(repo, { 'package.json': '{}', 'src/index.ts': 'export {}' });
    const calls: string[][] = [];
    let workspaceSeen: string[] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'info' || args[0] === 'kill') return { exitCode: 0, stdout: '29.2.0', stderr: '', timedOut: false, spawnError: null };
      const mount = args.find((a) => a.startsWith('type=bind'))!;
      const source = mount.slice('type=bind,source='.length, mount.indexOf(',target='));
      workspaceSeen = await readdir(join(source, 'src'));
      const next = results.shift() ?? {};
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...next };
    };
    return { github, calls, exec, workspace: () => workspaceSeen };
  }

  it('reports unavailable when the docker daemon cannot be reached', async () => {
    const exec: ExecFn = async () => ({ exitCode: -1, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT: docker not found' });
    const sandbox = await DockerSandbox.detect({ github: new InMemoryGitHub(), exec });
    expect(sandbox.available).toBe(false);
    expect((await sandbox.run(request([{ name: 'test', command: 'npm test' }]))).infrastructureError).toMatch(/not available/);
  });

  it('runs commands in order against snapshot + change set and stops at the first failure', async () => {
    const workRoot = await tempDir();
    const s = setup([{}, { exitCode: 1, stdout: 'FAIL src/new.test.ts', stderr: '' }]);
    const sandbox = await DockerSandbox.detect({ github: s.github, exec: s.exec, workRoot });

    const result = await sandbox.run(
      request([
        { name: 'typecheck', command: 'npx tsc --noEmit' },
        { name: 'test', command: 'npm test' },
        { name: 'build', command: 'npm run build' },
      ]),
    );
    expect(result).toMatchObject({ passed: false, failedCommand: 'test', infrastructureError: null });
    expect(result.results.map((r) => r.name)).toEqual(['typecheck', 'test']);
    expect(result.results[1]!.output).toContain('FAIL src/new.test.ts');
    expect(s.workspace().sort()).toEqual(['index.ts', 'new.ts']);
    // Workspace is cleaned up.
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('classifies docker failures as infrastructure errors', async () => {
    const s = setup([{ exitCode: 125, stderr: 'Unable to find image' }]);
    const sandbox = await DockerSandbox.detect({ github: s.github, exec: s.exec, workRoot: await tempDir() });
    const result = await sandbox.run(request([{ name: 'test', command: 'npm test' }]));
    expect(result.infrastructureError).toMatch(/Unable to find image/);
    expect(result.failedCommand).toBeNull();
  });

  it('kills timed out containers and reports exit code 124', async () => {
    const s = setup([{ exitCode: 1, timedOut: true }]);
    const sandbox = await DockerSandbox.detect({ github: s.github, exec: s.exec, workRoot: await tempDir() });
    const result = await sandbox.run(request([{ name: 'test', command: 'npm test' }]));
    expect(result.results[0]).toMatchObject({ exitCode: 124 });
    expect(s.calls.some((c) => c[0] === 'kill')).toBe(true);
  });
});
