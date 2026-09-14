import { z } from 'zod';
import { PROJECT_COMMANDS } from '../domain/project';
import type { GitHubPort, PullRequestRef, RepoCoordinates } from '../github/port';
import type { SandboxPort } from '../sandbox/port';
import { isDocumentationPath } from '../security/paths';
import {
  guardNoSecrets,
  guardWritableBranch,
  guardWritablePath,
  resolveProjectCommand,
  ToolDeniedError,
  ToolRouter,
  type ToolAuditEntry,
  type ToolContext,
  type ToolName,
  type ToolWorkspace,
} from '../tools/tool-router';

export interface OrchestratorToolDeps {
  github: GitHubPort;
  sandbox: SandboxPort;
  sandboxTimeoutMs: number;
  audit?: (entry: ToolAuditEntry) => void | Promise<void>;
}

function repoOf(ctx: ToolContext, tool: ToolName): RepoCoordinates {
  if (!ctx.project.repo) throw new ToolDeniedError(tool, 'security', 'project has no repository');
  return ctx.project.repo;
}

function workspaceOf(ctx: ToolContext, tool: ToolName): ToolWorkspace {
  if (!ctx.workspace) throw new ToolDeniedError(tool, 'security', 'no workspace bound to this call');
  return ctx.workspace;
}

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/i, 'expected a commit sha');

/**
 * The concrete tools behind the ToolRouter. Every side effect of the pipeline — staging files, git writes,
 * PRs, CI, sandbox runs, deployments — goes through here, so permissions, guards and audit always apply.
 */
export function createOrchestratorTools(deps: OrchestratorToolDeps): ToolRouter {
  return new ToolRouter({ audit: deps.audit })
    .register({
      name: 'repository.write',
      description: 'Stage a file change in the run workspace',
      input: z.object({
        path: z.string().min(1).max(500),
        action: z.enum(['create', 'update', 'delete']),
        content: z.string().max(400_000).nullable().optional(),
        rationale: z.string().max(1000).optional(),
      }),
      minAutonomy: 2,
      guard: (args, ctx) => {
        guardWritablePath(args.path, ctx);
        if (args.action !== 'delete' && !args.content) throw new ToolDeniedError('repository.write', 'invalid_input', `${args.path}: content required`);
        if (args.content) guardNoSecrets(args.content, 'repository.write');
      },
      execute: async (args, ctx) => {
        const path = guardWritablePath(args.path, ctx);
        workspaceOf(ctx, 'repository.write').apply({
          path,
          action: args.action,
          ...(args.action !== 'delete' && args.content ? { content: args.content } : {}),
          ...(args.rationale ? { rationale: args.rationale } : {}),
        });
        return { path };
      },
    })
    .register({
      name: 'docs.write',
      description: 'Stage a documentation file change (Markdown, docs folders, API descriptions) in the run workspace',
      input: z.object({
        path: z.string().min(1).max(500),
        action: z.enum(['create', 'update', 'delete']),
        content: z.string().max(400_000).nullable().optional(),
        rationale: z.string().max(1000).optional(),
      }),
      minAutonomy: 2,
      guard: (args, ctx) => {
        const path = guardWritablePath(args.path, ctx, 'docs.write');
        if (!isDocumentationPath(path)) throw new ToolDeniedError('docs.write', 'security', `${path} is not a documentation file`);
        if (args.action !== 'delete' && !args.content) throw new ToolDeniedError('docs.write', 'invalid_input', `${path}: content required`);
        if (args.content) guardNoSecrets(args.content, 'docs.write');
      },
      execute: async (args, ctx) => {
        const path = guardWritablePath(args.path, ctx, 'docs.write');
        workspaceOf(ctx, 'docs.write').apply({
          path,
          action: args.action,
          ...(args.action !== 'delete' && args.content ? { content: args.content } : {}),
          ...(args.rationale ? { rationale: args.rationale } : {}),
        });
        return { path };
      },
    })
    .register({
      name: 'git.branch',
      description: 'Create a feature branch',
      input: z.object({ branch: z.string().min(1).max(200), fromSha: Sha }),
      minAutonomy: 3,
      guard: (args, ctx) => guardWritableBranch(args.branch, ctx, 'git.branch'),
      execute: async (args, ctx) => {
        await deps.github.createBranch(repoOf(ctx, 'git.branch'), args.branch, args.fromSha);
        return { branch: args.branch };
      },
    })
    .register({
      name: 'git.commit',
      description: 'Create a commit from the staged change set',
      input: z.object({ branch: z.string().min(1).max(200), parentSha: Sha, message: z.string().min(1).max(5000) }),
      minAutonomy: 3,
      guard: (args, ctx) => {
        guardWritableBranch(args.branch, ctx, 'git.commit');
        for (const change of workspaceOf(ctx, 'git.commit').changes()) {
          guardWritablePath(change.path, ctx, 'git.commit');
          if (change.content) guardNoSecrets(change.content, 'git.commit');
        }
      },
      execute: async (args, ctx) => ({
        sha: await deps.github.createCommit(repoOf(ctx, 'git.commit'), {
          parentSha: args.parentSha,
          message: args.message,
          changes: workspaceOf(ctx, 'git.commit').changes(),
        }),
      }),
    })
    .register({
      name: 'git.push',
      description: 'Fast-forward a feature branch to a commit',
      input: z.object({ branch: z.string().min(1).max(200), sha: Sha }),
      minAutonomy: 3,
      guard: (args, ctx) => guardWritableBranch(args.branch, ctx, 'git.push'),
      execute: async (args, ctx) => {
        await deps.github.updateBranch(repoOf(ctx, 'git.push'), args.branch, args.sha);
        return { sha: args.sha };
      },
    })
    .register({
      name: 'github.pr.create',
      description: 'Open or update the pull request for a feature branch',
      input: z.object({ head: z.string().min(1).max(200), base: z.string().min(1).max(200), title: z.string().min(1).max(250), body: z.string().max(60_000) }),
      minAutonomy: 3,
      guard: (args, ctx) => {
        guardWritableBranch(args.head, ctx, 'github.pr.create');
        if (args.base !== ctx.project.repo?.defaultBranch) {
          throw new ToolDeniedError('github.pr.create', 'security', 'pull requests must target the default branch');
        }
      },
      execute: (args, ctx): Promise<PullRequestRef> => deps.github.upsertPullRequest(repoOf(ctx, 'github.pr.create'), args),
    })
    .register({
      name: 'ci.status',
      description: 'Read CI checks for a commit',
      input: z.object({ sha: Sha }),
      minAutonomy: 3,
      execute: (args, ctx) => deps.github.getChecks(repoOf(ctx, 'ci.status'), args.sha),
    })
    .register({
      name: 'ci.rerun',
      description: 'Re-run failed CI jobs (infrastructure failures only)',
      input: z.object({ runIds: z.array(z.number().int().positive()).max(20) }),
      minAutonomy: 3,
      execute: async (args, ctx) => {
        await deps.github.rerunFailedChecks(repoOf(ctx, 'ci.rerun'), args.runIds);
        return { rerun: args.runIds.length };
      },
    })
    .register({
      name: 'test.run',
      description: 'Run allow-listed verification commands in the sandbox',
      input: z.object({ commands: z.array(z.enum(PROJECT_COMMANDS)).min(1).max(PROJECT_COMMANDS.length), ref: Sha }),
      minAutonomy: 2,
      guard: (args, ctx) => {
        if (!deps.sandbox.available) throw new ToolDeniedError('test.run', 'security', 'sandbox is not available');
        for (const command of args.commands) resolveProjectCommand(command, ctx, 'test.run');
      },
      execute: (args, ctx) =>
        deps.sandbox.run({
          projectId: ctx.project.id,
          repo: repoOf(ctx, 'test.run'),
          ref: args.ref,
          changes: workspaceOf(ctx, 'test.run').changes(),
          commands: args.commands.map((name) => ({ name, command: resolveProjectCommand(name, ctx, 'test.run') })),
          timeoutMs: deps.sandboxTimeoutMs,
          network: args.commands.includes('install') ? 'registry' : 'none',
        }),
    })
    .register({
      name: 'deploy.run',
      description: 'Merge the pull request and dispatch the deploy workflow',
      input: z.object({ prNumber: z.number().int().positive(), workflow: z.string().min(1).max(200), ref: z.string().min(1).max(200) }),
      minAutonomy: 4,
      gatedAction: 'production_deploy',
      guard: (args, ctx) => {
        if (args.workflow !== ctx.project.profile.deployWorkflow) {
          throw new ToolDeniedError('deploy.run', 'security', 'workflow is not the configured deploy workflow');
        }
        if (args.ref !== ctx.project.repo?.defaultBranch) throw new ToolDeniedError('deploy.run', 'security', 'deployments run from the default branch');
      },
      execute: async (args, ctx) => {
        const repo = repoOf(ctx, 'deploy.run');
        const mergeSha = await deps.github.mergePullRequest(repo, args.prNumber);
        await deps.github.dispatchWorkflow(repo, args.workflow, args.ref);
        return { mergeSha };
      },
    });
}
