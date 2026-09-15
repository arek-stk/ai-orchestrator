import type { z } from 'zod';
import { requiresApproval } from '../approval/policy';
import type { AgentRole, AutonomyLevel } from '../domain/enums';
import type { GatedAction, Project, ProjectCommand } from '../domain/project';
import type { FileChange } from '../domain/run';
import { isProtectedBranch, isSensitivePath, isValidBranchName, normalizeRepoPath, UnsafePathError } from '../security/paths';
import { findSecrets } from '../security/secrets';

export const TOOL_NAMES = [
  'repository.read',
  'repository.search',
  'repository.write',
  'git.branch',
  'git.commit',
  'git.push',
  'github.pr.create',
  'github.pr.read',
  'ci.status',
  'ci.rerun',
  'test.run',
  'build.run',
  'lint.run',
  'dependency.scan',
  'security.scan',
  'docs.write',
  'research.web',
  'deploy.run',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const READ: readonly ToolName[] = ['repository.read', 'repository.search'];
const CODE: readonly ToolName[] = [...READ, 'repository.write', 'test.run', 'build.run', 'lint.run'];

/** Least-privilege defaults (spec §17). Overridable per deployment. */
export const DEFAULT_TOOL_PERMISSIONS: Readonly<Record<AgentRole, readonly ToolName[]>> = Object.freeze({
  orchestrator: [...READ, 'git.branch', 'git.commit', 'git.push', 'github.pr.create', 'github.pr.read', 'ci.status', 'ci.rerun', 'deploy.run'],
  project_analyst: [...READ, 'dependency.scan'],
  planner: READ,
  architect: READ,
  builder: CODE,
  frontend: CODE,
  backend: CODE,
  database: [...READ, 'repository.write', 'test.run'],
  security: [...READ, 'dependency.scan', 'security.scan'],
  tester: [...READ, 'repository.write', 'test.run'],
  debugger: [...CODE, 'ci.status'],
  reviewer: [...READ, 'github.pr.read'],
  researcher: ['research.web'],
  documentation: [...READ, 'docs.write'],
  devops: [...READ, 'ci.status', 'ci.rerun', 'build.run'],
  release: ['repository.read', 'ci.status', 'github.pr.read', 'deploy.run'],
});

export type ToolDenialReason = 'unknown_tool' | 'permission' | 'autonomy' | 'invalid_input' | 'security' | 'approval_required' | 'budget';

export class ToolDeniedError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: ToolDenialReason,
    readonly detail: string,
    readonly gatedAction?: GatedAction,
  ) {
    super(`${tool} denied (${reason}): ${detail}`);
    this.name = 'ToolDeniedError';
  }
}

/** The run's staged change set; tools write here instead of the real repository. */
export interface ToolWorkspace {
  apply(change: FileChange): void;
  changes(): FileChange[];
}

export interface ToolContext {
  project: Pick<Project, 'id' | 'repo' | 'profile' | 'autonomyLevel' | 'settings'>;
  agentRole: AgentRole;
  taskId: string | null;
  runId: string | null;
  /** Gated actions a human already approved for this run. */
  approvedActions: readonly string[];
  workspace?: ToolWorkspace;
}

export interface ToolDefinition<A, R> {
  name: ToolName;
  description: string;
  input: z.ZodType<A>;
  minAutonomy: AutonomyLevel;
  /** When set, execution needs an approval unless the project's gates allow it. */
  gatedAction?: GatedAction;
  estimateCostUsd?: (args: A, ctx: ToolContext) => number;
  /** Tool-specific security checks. Throw ToolDeniedError or UnsafePathError to deny. */
  guard?: (args: A, ctx: ToolContext) => void;
  /**
   * Approval that depends on the arguments or the staged workspace, e.g. new dependencies (ADR-031). Denied unless
   * `grant` is among the run's approved actions; the policy's hard rules apply.
   */
  approvalCheck?: (args: A, ctx: ToolContext) => Promise<ToolApprovalRequirement | null>;
  execute: (args: A, ctx: ToolContext) => Promise<R>;
}

export interface ToolApprovalRequirement {
  action: GatedAction;
  /** Entry in `approvedActions` that covers exactly this requirement. */
  grant: string;
  detail: string;
}

export interface ToolAuditEntry {
  tool: string;
  agentRole: AgentRole;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  outcome: 'allowed' | 'denied' | 'failed';
  reason?: string;
  durationMs: number;
  costUsd: number;
}

export interface ToolRouterOptions {
  permissions?: Partial<Record<AgentRole, readonly ToolName[]>>;
  audit?: (entry: ToolAuditEntry) => void | Promise<void>;
  budgetHeadroomUsd?: (ctx: ToolContext) => Promise<number>;
  now?: () => number;
}

/**
 * Single choke point for every side effect an agent causes (spec §17):
 * permission → autonomy → input validation → security guard → approval gate → cost → execute → audit.
 */
export class ToolRouter {
  private readonly tools = new Map<ToolName, ToolDefinition<unknown, unknown>>();
  private readonly permissions: Readonly<Record<AgentRole, readonly ToolName[]>>;

  constructor(private readonly options: ToolRouterOptions = {}) {
    this.permissions = { ...DEFAULT_TOOL_PERMISSIONS, ...options.permissions } as Record<AgentRole, readonly ToolName[]>;
  }

  register<A, R>(tool: ToolDefinition<A, R>): this {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition<unknown, unknown>);
    return this;
  }

  allowedTools(role: AgentRole): ToolName[] {
    return (this.permissions[role] ?? []).filter((name) => this.tools.has(name));
  }

  async invoke<R = unknown>(name: ToolName, rawArgs: unknown, ctx: ToolContext): Promise<R> {
    const now = this.options.now ?? Date.now;
    const started = now();
    const audit = async (outcome: ToolAuditEntry['outcome'], extra: { reason?: string; costUsd?: number } = {}) => {
      await this.options.audit?.({
        tool: name,
        agentRole: ctx.agentRole,
        projectId: ctx.project.id,
        taskId: ctx.taskId,
        runId: ctx.runId,
        outcome,
        durationMs: now() - started,
        costUsd: extra.costUsd ?? 0,
        ...(extra.reason ? { reason: extra.reason } : {}),
      });
    };
    const deny = async (reason: ToolDenialReason, detail: string, gatedAction?: GatedAction): Promise<never> => {
      await audit('denied', { reason: `${reason}: ${detail}` });
      throw new ToolDeniedError(name, reason, detail, gatedAction);
    };

    const tool = this.tools.get(name);
    if (!tool) return deny('unknown_tool', 'tool is not registered');
    if (!(this.permissions[ctx.agentRole] ?? []).includes(name)) {
      return deny('permission', `role ${ctx.agentRole} may not use ${name}`);
    }
    if (ctx.project.autonomyLevel < tool.minAutonomy) {
      return deny('autonomy', `requires autonomy level ${tool.minAutonomy}, project is at ${ctx.project.autonomyLevel}`);
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      return deny('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    }
    const args = parsed.data;

    try {
      tool.guard?.(args, ctx);
    } catch (error) {
      if (error instanceof ToolDeniedError) return deny(error.reason, error.detail, error.gatedAction);
      if (error instanceof UnsafePathError) return deny('security', error.message);
      throw error;
    }

    if (
      tool.gatedAction &&
      requiresApproval({ action: tool.gatedAction, autonomyLevel: ctx.project.autonomyLevel, gates: ctx.project.settings.approvalGates }) &&
      !ctx.approvedActions.includes(tool.gatedAction)
    ) {
      return deny('approval_required', `${tool.gatedAction} requires human approval`, tool.gatedAction);
    }

    if (tool.approvalCheck) {
      let requirement: ToolApprovalRequirement | null;
      try {
        requirement = await tool.approvalCheck(args, ctx);
      } catch (error) {
        if (error instanceof ToolDeniedError) return deny(error.reason, error.detail, error.gatedAction);
        await audit('failed', { reason: `approval check: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      if (
        requirement &&
        requiresApproval({ action: requirement.action, autonomyLevel: ctx.project.autonomyLevel, gates: ctx.project.settings.approvalGates }) &&
        !ctx.approvedActions.includes(requirement.grant)
      ) {
        return deny('approval_required', requirement.detail, requirement.action);
      }
    }

    const costUsd = tool.estimateCostUsd?.(args, ctx) ?? 0;
    if (costUsd > 0 && this.options.budgetHeadroomUsd) {
      const headroom = await this.options.budgetHeadroomUsd(ctx);
      if (costUsd > headroom) return deny('budget', `estimated $${costUsd.toFixed(4)} exceeds headroom $${headroom.toFixed(4)}`);
    }

    try {
      const result = await tool.execute(args, ctx);
      await audit('allowed', { costUsd });
      return result as R;
    } catch (error) {
      await audit('failed', { reason: error instanceof Error ? error.message : String(error), costUsd });
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Reusable guards
// ---------------------------------------------------------------------------

/** Normalises a path an agent wants to write; sensitive files need the secrets_permissions approval. */
export function guardWritablePath(path: string, ctx: ToolContext, tool: ToolName = 'repository.write'): string {
  const normalized = normalizeRepoPath(path);
  if (isSensitivePath(normalized) && !ctx.approvedActions.includes('secrets_permissions')) {
    throw new ToolDeniedError(tool, 'approval_required', `${normalized} is a sensitive file`, 'secrets_permissions');
  }
  return normalized;
}

export function guardNoSecrets(content: string, tool: ToolName): void {
  const [finding] = findSecrets(content);
  if (finding) throw new ToolDeniedError(tool, 'security', `content contains a secret-looking value (${finding.name})`);
}

/** Feature branches only: never the default branch or a protected pattern. */
export function guardWritableBranch(branch: string, ctx: ToolContext, tool: ToolName): void {
  if (!isValidBranchName(branch)) throw new ToolDeniedError(tool, 'security', `invalid branch name "${branch}"`);
  const repo = ctx.project.repo;
  if (!repo) throw new ToolDeniedError(tool, 'security', 'project has no repository');
  if (isProtectedBranch(branch, repo.defaultBranch, ctx.project.profile.protectedBranches)) {
    throw new ToolDeniedError(tool, 'security', `branch "${branch}" is protected`);
  }
}

/** Sandbox commands come only from the project profile allow-list, never from agent output. */
export function resolveProjectCommand(command: ProjectCommand, ctx: ToolContext, tool: ToolName): string {
  const resolved = ctx.project.profile.commands[command];
  if (!resolved) throw new ToolDeniedError(tool, 'security', `command "${command}" is not allow-listed in the project profile`);
  return resolved;
}
