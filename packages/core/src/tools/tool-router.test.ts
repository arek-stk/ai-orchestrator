import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultProjectProfile, defaultProjectSettings } from '../domain/project';
import {
  guardNoSecrets,
  guardWritableBranch,
  guardWritablePath,
  resolveProjectCommand,
  ToolDeniedError,
  ToolRouter,
  type ToolAuditEntry,
  type ToolContext,
} from './tool-router';

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    project: {
      id: 'prj_1',
      repo: { owner: 'acme', name: 'shop', defaultBranch: 'main' },
      profile: { ...defaultProjectProfile(), commands: { test: 'npm test' }, protectedBranches: ['release/*'] },
      settings: defaultProjectSettings(),
      autonomyLevel: 3,
    },
    agentRole: 'builder',
    taskId: 'tsk_1',
    runId: 'run_1',
    approvedActions: [],
    ...extra,
  };
}

function setup() {
  const audit: ToolAuditEntry[] = [];
  const written: string[] = [];
  const router = new ToolRouter({ audit: (e) => void audit.push(e), budgetHeadroomUsd: async () => 1 })
    .register({
      name: 'repository.write',
      description: 'write a file',
      input: z.object({ path: z.string(), content: z.string() }),
      minAutonomy: 2,
      guard: (args, ctx) => {
        guardWritablePath(args.path, ctx);
        guardNoSecrets(args.content, 'repository.write');
      },
      execute: async (args) => {
        written.push(args.path);
        return { ok: true };
      },
    })
    .register({
      name: 'git.push',
      description: 'push branch',
      input: z.object({ branch: z.string() }),
      minAutonomy: 3,
      guard: (args, ctx) => guardWritableBranch(args.branch, ctx, 'git.push'),
      execute: async () => ({ pushed: true }),
    })
    .register({
      name: 'deploy.run',
      description: 'deploy',
      input: z.object({}),
      minAutonomy: 4,
      gatedAction: 'production_deploy',
      execute: async () => ({ deployed: true }),
    })
    .register({
      name: 'research.web',
      description: 'expensive research',
      input: z.object({ query: z.string() }),
      minAutonomy: 0,
      estimateCostUsd: () => 5,
      execute: async () => ({}),
    });
  return { router, audit, written };
}

describe('ToolRouter', () => {
  it('executes permitted tool calls and audits them', async () => {
    const { router, audit, written } = setup();
    await expect(router.invoke('repository.write', { path: 'src/cart.ts', content: 'export {}' }, context())).resolves.toEqual({ ok: true });
    expect(written).toEqual(['src/cart.ts']);
    expect(audit).toMatchObject([{ tool: 'repository.write', outcome: 'allowed', agentRole: 'builder' }]);
  });

  it('denies tools outside the role permission set', async () => {
    const { router, audit } = setup();
    await expect(router.invoke('repository.write', { path: 'a.ts', content: '' }, context({ agentRole: 'reviewer' }))).rejects.toMatchObject({
      reason: 'permission',
    });
    expect(audit[0]).toMatchObject({ outcome: 'denied' });
  });

  it('enforces autonomy levels', async () => {
    const { router } = setup();
    const ctx = context();
    ctx.project = { ...ctx.project, autonomyLevel: 1 };
    await expect(router.invoke('repository.write', { path: 'a.ts', content: '' }, ctx)).rejects.toMatchObject({ reason: 'autonomy' });
  });

  it('validates input and blocks unsafe paths, secrets and protected branches', async () => {
    const { router, written } = setup();
    await expect(router.invoke('repository.write', { path: 42 }, context())).rejects.toMatchObject({ reason: 'invalid_input' });
    await expect(router.invoke('repository.write', { path: '../../etc/passwd', content: '' }, context())).rejects.toMatchObject({ reason: 'security' });
    await expect(
      router.invoke('repository.write', { path: 'src/x.ts', content: `const t = "ghp_${'a'.repeat(36)}"` }, context()),
    ).rejects.toMatchObject({ reason: 'security' });
    await expect(router.invoke('repository.write', { path: '.env', content: 'A=1' }, context())).rejects.toMatchObject({
      reason: 'approval_required',
      gatedAction: 'secrets_permissions',
    });
    await expect(router.invoke('git.push', { branch: 'main' }, context({ agentRole: 'orchestrator' }))).rejects.toMatchObject({ reason: 'security' });
    await expect(router.invoke('git.push', { branch: 'release/2.0' }, context({ agentRole: 'orchestrator' }))).rejects.toMatchObject({ reason: 'security' });
    await expect(router.invoke('git.push', { branch: 'orchestrator/tsk-1' }, context({ agentRole: 'orchestrator' }))).resolves.toEqual({ pushed: true });
    expect(written).toEqual([]);
  });

  it('requires approval for gated actions until approved', async () => {
    const { router } = setup();
    const ctx = context({ agentRole: 'release' });
    ctx.project = { ...ctx.project, autonomyLevel: 4 };
    // production_deploy gate is enabled by default even at level 4.
    await expect(router.invoke('deploy.run', {}, ctx)).rejects.toBeInstanceOf(ToolDeniedError);
    await expect(router.invoke('deploy.run', {}, { ...ctx, approvedActions: ['production_deploy'] })).resolves.toEqual({ deployed: true });
  });

  it('denies calls that exceed the budget headroom', async () => {
    const { router } = setup();
    await expect(router.invoke('research.web', { query: 'x' }, context({ agentRole: 'researcher' }))).rejects.toMatchObject({ reason: 'budget' });
  });

  it('lists allowed tools per role and resolves allow-listed commands only', () => {
    const { router } = setup();
    expect(router.allowedTools('reviewer')).toEqual([]);
    expect(router.allowedTools('builder')).toEqual(['repository.write']);
    expect(resolveProjectCommand('test', context(), 'test.run')).toBe('npm test');
    expect(() => resolveProjectCommand('build', context(), 'build.run')).toThrow(/not allow-listed/);
  });
});
