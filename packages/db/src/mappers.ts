import {
  defaultProjectProfile,
  defaultProjectSettings,
  emptyCheckpoint,
  HARD_GATED_ACTIONS,
  type AgentRun,
  type Approval,
  type Decision,
  type MemoryItem,
  type PipelineRun,
  type Project,
  type Task,
} from '@orch/core';
import type { agentRuns, approvals, decisions, memories, pipelineRuns, projects, tasks } from './schema';

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof pipelineRuns.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export function toProject(row: ProjectRow): Project {
  const profileDefaults = defaultProjectProfile();
  const settingsDefaults = defaultProjectSettings();
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    repo:
      row.repoOwner && row.repoName
        ? { owner: row.repoOwner, name: row.repoName, defaultBranch: row.defaultBranch ?? 'main' }
        : null,
    status: row.status,
    priority: row.priority,
    autonomyLevel: row.autonomyLevel,
    healthScore: row.healthScore,
    budgetUsd: row.budgetUsd,
    spentUsd: row.spentUsd,
    tokensUsed: row.tokensUsed,
    // Merge with defaults so rows written by older versions gain newly introduced fields.
    profile: { ...profileDefaults, ...row.profile, checks: { ...profileDefaults.checks, ...row.profile.checks } },
    settings: {
      ...settingsDefaults,
      ...row.settings,
      stopConditions: { ...settingsDefaults.stopConditions, ...row.settings.stopConditions },
      council: { ...settingsDefaults.council, ...row.settings.council },
      // Hard gates (ADR-031) stay enabled even if a stored configuration says otherwise.
      approvalGates: { ...settingsDefaults.approvalGates, ...row.settings.approvalGates, ...Object.fromEntries(HARD_GATED_ACTIONS.map((action) => [action, true])) },
    },
    lastScheduledAt: row.lastScheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    title: row.title,
    goal: row.goal,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    dependencies: row.dependencies,
    acceptanceCriteria: row.acceptanceCriteria,
    risk: row.risk,
    estimatedComplexity: row.estimatedComplexity,
    tokenBudget: row.tokenBudget,
    maxCost: row.maxCost,
    maxAttempts: row.maxAttempts,
    attempts: row.attempts,
    costUsd: row.costUsd,
    tokensUsed: row.tokensUsed,
    branch: row.branch,
    prNumber: row.prNumber,
    blockedReason: row.blockedReason,
    readySince: row.readySince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRun(row: RunRow): PipelineRun {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    status: row.status,
    currentStage: row.currentStage,
    stagePlan: row.stagePlan,
    stageStates: row.stageStates,
    iterations: row.iterations,
    debugAttempts: row.debugAttempts,
    costUsd: row.costUsd,
    tokens: row.tokens,
    limits: row.limits,
    checkpoint: { ...emptyCheckpoint(), ...row.checkpoint },
    error: row.error,
    blockedReason: row.blockedReason,
    resumeAt: row.resumeAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    projectId: row.projectId,
    role: row.role,
    modelConfigId: row.modelConfigId,
    provider: row.provider,
    modelId: row.modelId,
    status: row.status,
    inputSummary: row.inputSummary,
    output: row.output ?? null,
    confidence: row.confidence,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    },
    costUsd: row.costUsd,
    toolsUsed: row.toolsUsed,
    durationMs: row.durationMs,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    cacheHit: row.cacheHit,
  };
}

export function toDecision(row: DecisionRow): Decision {
  return { ...row };
}

export function toMemory(row: MemoryRow): MemoryItem {
  return { ...row };
}

export function toApproval(row: ApprovalRow): Approval {
  return { ...row };
}
