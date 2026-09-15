import type { z } from 'zod';
import { dependencyApprovalDetails, dependencyApprovalGrant, describeDependencyFindings, detectDependencyAdditions } from '../approval/dependencies';
import { detectGatedActions, requiresApproval } from '../approval/policy';
import { runCouncil } from '../agents/council';
import { AGENT_DEFINITIONS, type AgentInput } from '../agents/definitions';
import { deferredApprovalExpiry, type AutopilotSession } from '../autopilot/session';
import type { AgentFailure } from '../agents/runtime';
import {
  AnalysisOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  SecurityOutputSchema,
  type AnalysisOutput,
  type FileChangeOutput,
  type PlanOutput,
} from '../agents/schemas';
import { buildContext, rankFiles, type ContextFile, type IndexedFile } from '../context/context-builder';
import { summarizeFiles } from '../context/file-summarizer';
import { parallelLayers } from '../dag/dag';
import type { AgentRole, Risk, RunStage } from '../domain/enums';
import type { GatedAction, Project } from '../domain/project';
import type { ApprovalAction } from '../domain/records';
import type { PipelineRun } from '../domain/run';
import { TaskInputSchema, type Task } from '../domain/task';
import { totalTokens, type TokenUsage } from '../models/types';
import { isSecurityRelevant } from '../pipeline/stage-planner';
import type { SandboxRunResult } from '../sandbox/port';
import { findSecrets, redactSecrets } from '../security/secrets';
import { ToolDeniedError, type ToolContext, type ToolRouter, type ToolWorkspace } from '../tools/tool-router';
import { childTaskKind, isPlanned, mergeChanges, questionKey, renderChangeset, truncate } from './helpers';
import type { OrchestratorDeps, OrchestratorOptions } from './orchestrator';
import { failureFingerprint } from '../memory/fingerprint';

export type StageOutcome =
  | { kind: 'passed'; summary: string }
  /** Verification failed: debug, then continue with `resumeStage`. */
  | { kind: 'retry'; resumeStage: RunStage; summary: string; failureOutput: string }
  /** Change set must be reworked by IMPLEMENT with this feedback. */
  | { kind: 'feedback'; summary: string; feedback: string[] }
  /** The stage itself failed (agent error, invalid output); run it again later. */
  | { kind: 'retry_stage'; summary: string }
  | { kind: 'wait'; summary: string; resumeAt: Date | null; approvalId?: string }
  /** Autopilot: a deferred approval parks the run for a human without holding a concurrency slot. */
  | { kind: 'parked'; summary: string; approvalId: string; sessionId: string; action: ApprovalAction; reason: string; expiresAt: Date | null }
  | { kind: 'paused'; reason: string }
  | { kind: 'blocked'; reason: string }
  /** The run completes early with this outcome (e.g. decomposed into sub-tasks). */
  | { kind: 'finished'; outcome: string; summary: string };

export interface StageContext {
  deps: OrchestratorDeps;
  options: OrchestratorOptions;
  tools: ToolRouter;
  run: PipelineRun;
  task: Task;
  /** Project as seen by this run: with an active autopilot session, autonomy is capped and every gate is hard. */
  project: Project;
  now: Date;
  /** The run's autopilot session while it is active; null outside sessions. */
  session: AutopilotSession | null;
}

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

const passed = (summary: string): StageOutcome => ({ kind: 'passed', summary });

export function parseOutput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | null {
  if (value === undefined || value === null) return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function toolContext(ctx: StageContext, role: AgentRole, workspace?: ToolWorkspace): ToolContext {
  return {
    project: ctx.project,
    agentRole: role,
    taskId: ctx.task.id,
    runId: ctx.run.id,
    approvedActions: ctx.run.checkpoint.approvedActions,
    sessionId: ctx.run.sessionId,
    ...(workspace ? { workspace } : {}),
  };
}

export function workspaceFor(run: PipelineRun): ToolWorkspace {
  return {
    apply: (change) => {
      run.checkpoint.changeset = mergeChanges(run.checkpoint.changeset, [change]);
      run.checkpoint.changesetVersion++;
    },
    changes: () => run.checkpoint.changeset,
  };
}

export function baseInput(ctx: StageContext, sections: AgentInput['sections'], files: readonly ContextFile[] = [], question?: string): AgentInput {
  return {
    project: { name: ctx.project.name, description: ctx.project.description, languages: ctx.project.profile.languages },
    task: ctx.task,
    sections,
    files,
    ...(question ? { question } : {}),
  };
}

export function agentCommon(ctx: StageContext) {
  return {
    scope: { projectId: ctx.project.id, taskId: ctx.task.id, runId: ctx.run.id },
    complexity: ctx.task.estimatedComplexity,
    risk: ctx.task.risk,
    projectRoleOverrides: ctx.project.settings.modelOverrides,
    runBudgetRemainingUsd: Math.max(0, ctx.run.limits.maxCostUsd - ctx.run.costUsd),
  };
}

export function track(ctx: StageContext, spend: { costUsd: number; usage: TokenUsage }): void {
  ctx.run.costUsd += spend.costUsd;
  ctx.run.tokens += totalTokens(spend.usage);
}

export function onAgentFailure(ctx: StageContext, failure: AgentFailure<unknown>): StageOutcome {
  switch (failure.kind) {
    case 'budget_paused':
      return { kind: 'paused', reason: `Budget: ${failure.error}` };
    case 'no_model':
      return { kind: 'blocked', reason: `No eligible model: ${failure.error}` };
    case 'provider':
      return { kind: 'wait', summary: `Model provider unavailable: ${truncate(failure.error, 300)}`, resumeAt: new Date(ctx.now.getTime() + ctx.options.waitRetryMs) };
    default:
      return { kind: 'retry_stage', summary: `${failure.kind}: ${truncate([failure.error, ...failure.issues].join('; '), 500)}` };
  }
}

export async function requestApproval(ctx: StageContext, action: ApprovalAction, reason: string, details: Record<string, unknown>, risk?: Risk): Promise<StageOutcome> {
  return requestRunApproval(ctx, { action, reason, details, risk: risk ?? (ctx.task.risk === 'low' ? 'medium' : ctx.task.risk) });
}

export interface RunApprovalRequest {
  action: ApprovalAction;
  reason: string;
  risk: Risk;
  details: Record<string, unknown>;
}

/**
 * Creates an approval for a run. Outside a session it blocks the run (WAITING, ADR-023 expiry). Inside an active
 * autopilot session it is deferred: the run parks without a slot and the approval stays valid until the session ends
 * plus the return grace period (never beyond the hard maximum). Only a human can decide either kind.
 */
export async function requestRunApproval(
  target: Pick<StageContext, 'deps' | 'options' | 'run' | 'task' | 'project' | 'session' | 'now'>,
  request: RunApprovalRequest,
): Promise<StageOutcome> {
  const { deps, options, run, task, project, session } = target;
  const expiresAt = session
    ? deferredApprovalExpiry({
        requestedAt: target.now,
        ttlMs: options.approvalTtlMs,
        sessionEndsAt: session.endsAt,
        returnGraceMs: options.autopilot.returnGraceMs,
        maxApprovalLifetimeMs: options.autopilot.maxApprovalLifetimeMs,
      })
    : null;
  const mode = session ? 'deferred' : 'blocking';
  const approval = await deps.approvals.create({
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    action: request.action,
    reason: request.reason,
    risk: request.risk,
    details: request.details,
    mode,
    sessionId: session?.id ?? null,
    expiresAt,
  });
  await deps.events.emit({
    type: 'approval.required',
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    payload: { approvalId: approval.id, action: request.action, risk: approval.risk, reason: request.reason, mode },
  });
  if (session) {
    return {
      kind: 'parked',
      summary: `Parked for human approval: ${request.action}`,
      approvalId: approval.id,
      sessionId: session.id,
      action: request.action,
      reason: request.reason,
      expiresAt,
    };
  }
  return { kind: 'wait', summary: `Waiting for human approval: ${request.action}`, resumeAt: null, approvalId: approval.id };
}

/**
 * ADR-031: every new dependency waits for a human, at every autonomy level and whatever the gate configuration says.
 * An approval covers exactly the set of additions it was requested for (fingerprint); anything added later needs a
 * new approval. Grants live in the run checkpoint, so they are never reused by another run or task.
 */
export async function dependencyGate(ctx: StageContext): Promise<StageOutcome | null> {
  const { project, run } = ctx;
  if (run.checkpoint.changeset.length === 0) return null;
  const repo = project.repo;
  const ref = run.checkpoint.baseSha ?? repo?.defaultBranch ?? null;
  const detection = await detectDependencyAdditions(run.checkpoint.changeset, (path) =>
    repo && ref ? ctx.deps.github.getFileContent(repo, path, ref) : Promise.resolve(null),
  );
  if (!detection.fingerprint || run.checkpoint.approvedActions.includes(dependencyApprovalGrant(detection.fingerprint))) return null;
  if (!requiresApproval({ action: 'dependency_addition', autonomyLevel: project.autonomyLevel, gates: project.settings.approvalGates })) return null;
  const details = dependencyApprovalDetails(detection);
  return requestApproval(ctx, 'dependency_addition', describeDependencyFindings(detection.findings), { ...details }, details.highRisk ? 'high' : undefined);
}

async function applyChanges(
  ctx: StageContext,
  role: AgentRole,
  changes: readonly FileChangeOutput[],
  tool: 'repository.write' | 'docs.write' = 'repository.write',
): Promise<StageOutcome | null> {
  const workspace = workspaceFor(ctx.run);
  for (const change of changes) {
    try {
      await ctx.tools.invoke(
        tool,
        { path: change.path, action: change.action, content: change.content, rationale: change.rationale },
        toolContext(ctx, role, workspace),
      );
    } catch (error) {
      if (!(error instanceof ToolDeniedError)) throw error;
      if (error.reason === 'approval_required' && error.gatedAction) {
        return requestApproval(ctx, error.gatedAction, error.detail, { path: change.path });
      }
      return { kind: 'feedback', summary: `Change rejected by the tool router: ${error.detail}`, feedback: [`Rejected change, do not repeat: ${error.detail}`] };
    }
  }
  return null;
}

async function loadIndex(ctx: StageContext): Promise<IndexedFile[]> {
  const stored = await ctx.deps.repoFiles.list(ctx.project.id);
  if (stored.length > 0 || !ctx.project.repo) return stored;
  const result = await ctx.deps.repoIndex.refresh(ctx.project.id, ctx.project.repo, ctx.project.repo.defaultBranch);
  ctx.run.checkpoint.baseSha ??= result.headSha;
  return result.files;
}

function contentLoader(ctx: StageContext): (path: string) => Promise<string | null> {
  return async (path) => {
    const staged = ctx.run.checkpoint.changeset.find((c) => c.path === path);
    if (staged) return staged.action === 'delete' ? null : (staged.content ?? null);
    const repo = ctx.project.repo;
    if (!repo) return null;
    return ctx.deps.github.getFileContent(repo, path, ctx.run.checkpoint.baseSha ?? repo.defaultBranch);
  };
}

function summarizeTree(files: readonly IndexedFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const top = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '(root)';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([dir, n]) => `- ${dir}: ${n} files`);
  return [`${files.length} files in total.`, ...lines].join('\n');
}

function analysisSection(analysis: AnalysisOutput | null): AgentInput['sections'] {
  if (!analysis) return [];
  return [
    {
      title: 'Project analysis',
      body: [
        analysis.summary,
        `Architecture: ${analysis.architecture}`,
        analysis.conventions.length > 0 ? `Conventions: ${analysis.conventions.join('; ')}` : '',
        analysis.relevantPaths.length > 0 ? `Relevant paths: ${analysis.relevantPaths.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// INTAKE / ANALYZE / PLAN / DESIGN
// ---------------------------------------------------------------------------

export const intakeStage: StageHandler = async (ctx) => {
  if (ctx.task.goal.trim().length < 3) return { kind: 'blocked', reason: 'Task goal is empty; clarification required.' };
  const criteria = ctx.task.acceptanceCriteria.length;
  return passed(criteria > 0 ? `Task accepted with ${criteria} acceptance criteria.` : 'Task accepted; the plan will derive acceptance criteria.');
};

export const analyzeStage: StageHandler = async (ctx) => {
  const { deps, project, run, task } = ctx;
  if (!project.repo) return passed('No repository connected; nothing to analyze.');

  const index = await deps.repoIndex.refresh(project.id, project.repo, project.repo.defaultBranch);
  run.checkpoint.baseSha = index.headSha;

  const cacheKey = `analysis:${index.headSha}`;
  const [cached] = await deps.memories.search(project.id, { scope: 'project', key: cacheKey, limit: 1 });
  const reusable = cached ? parseOutput(AnalysisOutputSchema, safeJson(cached.content)) : null;
  if (reusable) {
    run.checkpoint.outputs.analysis = reusable;
    return passed(`Reused cached analysis for ${index.headSha.slice(0, 7)} (no model call).`);
  }

  // Best effort (spec §31): summaries of the task's most relevant files, reused while their blob sha is unchanged.
  let files = index.files;
  if (deps.fileSummaries) {
    const summarized = await summarizeFiles({
      runtime: deps.runtime,
      store: deps.fileSummaries,
      project,
      files,
      loadContent: contentLoader(ctx),
      scope: { projectId: project.id, taskId: task.id, runId: run.id },
      priorityPaths: rankFiles({ task, files, tokenBudget: ctx.options.analysisTokenBudget }).map((r) => r.path),
      maxBatches: 1,
      runBudgetRemainingUsd: Math.max(0, run.limits.maxCostUsd - run.costUsd),
    });
    track(ctx, summarized);
    if (summarized.summaries.size > 0) files = files.map((f) => (summarized.summaries.has(f.path) ? { ...f, summary: summarized.summaries.get(f.path)! } : f));
  }

  const context = await buildContext({ task, files, tokenBudget: ctx.options.analysisTokenBudget }, contentLoader(ctx));
  const outcome = await deps.runtime.run({
    ...agentCommon(ctx),
    definition: AGENT_DEFINITIONS.analyze,
    input: baseInput(ctx, [{ title: 'Repository', body: summarizeTree(files) }], context.files),
  });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);

  run.checkpoint.outputs.analysis = outcome.output;
  const content = JSON.stringify(outcome.output);
  await deps.memories.upsert({ projectId: project.id, scope: 'project', kind: 'analysis', key: cacheKey, content, tags: ['analysis'] });
  await deps.memories.upsert({ projectId: project.id, scope: 'project', kind: 'analysis', key: 'analysis:latest', content, tags: ['analysis'] });
  return passed(`Analyzed ${index.files.length} files (${index.fetched} fetched, ${index.reused} reused).`);
};

export const planStage: StageHandler = async (ctx) => {
  const { deps, project, run } = ctx;
  const analysis = parseOutput(AnalysisOutputSchema, run.checkpoint.outputs.analysis);
  const conventions = await deps.memories.search(project.id, { scope: 'project', kind: 'convention', limit: 20 });
  const failures = await deps.memories.search(project.id, { scope: 'failure', limit: 8 });
  // Research only exists when it was requested explicitly for this task.
  const research = (await deps.memories.search(project.id, { scope: 'task', kind: 'research', limit: 20 })).filter((m) => m.taskId === ctx.task.id).slice(0, 3);

  const sections: AgentInput['sections'] = [
    ...analysisSection(analysis),
    ...(conventions.length > 0 ? [{ title: 'Project conventions', body: conventions.map((c) => `- ${c.content}`).join('\n') }] : []),
    ...(failures.length > 0 ? [{ title: 'Known failures in this project', body: failures.map((f) => `- ${truncate(f.content, 300)}`).join('\n') }] : []),
    ...(research.length > 0 ? [{ title: 'Research notes', body: research.map((r) => truncate(r.content, 3_000)).join('\n\n') }] : []),
  ];

  const outcome = await deps.runtime.run({ ...agentCommon(ctx), definition: AGENT_DEFINITIONS.plan, input: baseInput(ctx, sections) });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);

  const plan = outcome.output;
  run.checkpoint.outputs.plan = plan;
  if (ctx.task.acceptanceCriteria.length === 0 && plan.acceptanceCriteria.length > 0) {
    ctx.task = await deps.tasks.update(ctx.task.id, { acceptanceCriteria: plan.acceptanceCriteria.slice(0, 30) });
  }

  const decomposable = plan.tasks.length > 1 && ctx.task.estimatedComplexity === 'complex' && ctx.task.parentId === null && project.autonomyLevel >= 2;
  if (decomposable) return decompose(ctx, plan);
  return passed(`Plan with ${plan.tasks.length} step(s), ${plan.risks.length} risk(s).`);
};

async function decompose(ctx: StageContext, plan: PlanOutput): Promise<StageOutcome> {
  const { deps, task, project } = ctx;
  const order = parallelLayers(plan.tasks.map((t) => ({ id: t.key, dependencies: t.dependsOn }))).flat();
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const ids = new Map<string, string>();
  const share = plan.tasks.length;

  for (const key of order) {
    const sub = byKey.get(key)!;
    const title = sub.title.length >= 3 ? sub.title : `${sub.title} – ${task.title}`;
    const child = await deps.tasks.create(
      project.id,
      TaskInputSchema.parse({
        title: truncate(title, 200),
        goal: sub.description.length >= 3 ? sub.description : `${title} for: ${task.goal}`,
        kind: childTaskKind(sub.role),
        priority: task.priority,
        dependencies: sub.dependsOn.map((dep) => ids.get(dep)!).filter(Boolean),
        acceptanceCriteria: sub.acceptanceCriteria,
        risk: task.risk,
        estimatedComplexity: 'medium',
        tokenBudget: Math.max(50_000, Math.floor(task.tokenBudget / share)),
        maxCost: Math.max(0.5, Math.round((task.maxCost / share) * 100) / 100),
        maxAttempts: task.maxAttempts,
        parentId: task.id,
      }),
      null,
    );
    ids.set(key, child.id);
    await deps.events.emit({ type: 'task.created', projectId: project.id, taskId: child.id, runId: ctx.run.id, payload: { title: child.title } });
  }

  ctx.task = await deps.tasks.update(task.id, { status: 'WAITING_CHILDREN' });
  return { kind: 'finished', outcome: 'decomposed', summary: `Split into ${plan.tasks.length} sub-tasks with dependencies.` };
}

function councilMembers(task: Task, plan: PlanOutput | null): AgentRole[] {
  if (task.estimatedComplexity !== 'complex' && task.risk !== 'high') return ['architect'];
  const members: AgentRole[] = ['architect'];
  if (isSecurityRelevant(task)) members.push('security');
  if ((plan?.touchesAreas ?? []).some((area) => /\b(db|database|schema|migration|sql)\b/i.test(area))) members.push('database');
  if (members.length === 1) members.push('backend');
  return members.slice(0, 3);
}

export const designStage: StageHandler = async (ctx) => {
  const { deps, project, run, task } = ctx;
  if (run.checkpoint.designDecisionId) return passed('Design decision already recorded.');

  const plan = parseOutput(PlanOutputSchema, run.checkpoint.outputs.plan);
  const approach = plan?.approach ?? task.goal;
  const question = `Which design should be used for "${task.title}"? Proposed approach: ${truncate(approach, 600)}`;
  const key = questionKey(['design', task.title, approach]);
  const { council } = project.settings;

  const reusable = await deps.decisions.findByQuestionKey(project.id, key);
  if (reusable && reusable.confidence >= council.confidenceThreshold) {
    run.checkpoint.designDecisionId = reusable.id;
    return passed(`Reused earlier decision ${reusable.id} (${Math.round(reusable.confidence * 100)}% confidence, no model call).`);
  }

  const members = councilMembers(task, plan);
  const sections: AgentInput['sections'] = plan
    ? [{ title: 'Plan', body: JSON.stringify({ approach: plan.approach, tasks: plan.tasks.map((t) => ({ key: t.key, title: t.title, role: t.role })), risks: plan.risks }, null, 2) }]
    : [];

  const result = await runCouncil(
    {
      question,
      members,
      baseInput: baseInput(ctx, sections),
      scope: { projectId: project.id, taskId: task.id, runId: run.id },
      complexity: task.estimatedComplexity,
      risk: task.risk,
      settings: members.length === 1 ? { ...council, maxRounds: 1 } : council,
      projectRoleOverrides: project.settings.modelOverrides,
    },
    deps.runtime,
    deps.clock,
  );
  run.costUsd += result.costUsd;
  run.tokens += result.tokens;
  if (result.rounds.length === 0) return { kind: 'retry_stage', summary: `Council produced no opinions: ${truncate(result.failures.join('; '), 400)}` };

  const opinions = result.rounds.at(-1)!;
  const chosen = result.synthesis.options.find((o) => o.id === result.synthesis.chosenOptionId);
  let decision = {
    text: chosen ? `${chosen.id}: ${chosen.summary}` : 'No option selected',
    chosenOptionId: result.synthesis.chosenOptionId,
    reason: `Council stopped (${result.stoppedBecause}) with ${Math.round(result.synthesis.agreement * 100)}% agreement.`,
    confidence: result.synthesis.confidence,
    dissent: result.synthesis.dissent.map((d) => `${d.role} preferred ${d.optionId}: ${d.rationale}`),
  };
  let costUsd = result.costUsd;

  if (result.escalate) {
    const synthesis = await deps.runtime.run({
      ...agentCommon(ctx),
      definition: AGENT_DEFINITIONS.synthesize,
      input: baseInput(
        ctx,
        [
          ...sections,
          {
            title: 'Specialist opinions',
            body: JSON.stringify(
              opinions.map((o) => ({ role: o.role, recommendedOptionId: o.output.recommendedOptionId, confidence: o.output.confidence, rationale: o.output.rationale, options: o.output.options })),
              null,
              2,
            ),
          },
        ],
        [],
        question,
      ),
    });
    track(ctx, synthesis);
    costUsd += synthesis.costUsd;
    if (synthesis.ok) {
      decision = {
        text: synthesis.output.decision,
        chosenOptionId: synthesis.output.chosenOptionId,
        reason: synthesis.output.reason,
        confidence: synthesis.output.confidence,
        dissent: synthesis.output.dissent,
      };
    }
  }

  const record = await deps.decisions.create({
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    question,
    questionKey: key,
    options: result.synthesis.options,
    consulted: opinions.map((o) => ({
      role: o.role,
      modelId: o.modelId,
      position: truncate(o.output.rationale, 500),
      optionId: o.output.recommendedOptionId,
      confidence: o.output.confidence,
    })),
    evidence: [`Council stopped: ${result.stoppedBecause}`, ...decision.dissent.map((d) => `Dissent: ${d}`)],
    decision: decision.text,
    chosenOptionId: decision.chosenOptionId,
    reason: decision.reason,
    confidence: decision.confidence,
    costUsd,
    supersedesId: reusable?.id ?? null,
  });
  run.checkpoint.designDecisionId = record.id;
  await deps.events.emit({
    type: 'decision.made',
    projectId: project.id,
    taskId: task.id,
    runId: run.id,
    payload: { decisionId: record.id, question, confidence: record.confidence },
  });

  const confidencePct = Math.round(decision.confidence * 100);
  if (
    decision.confidence < council.confidenceThreshold &&
    requiresApproval({ action: 'architecture_change', autonomyLevel: project.autonomyLevel, gates: project.settings.approvalGates })
  ) {
    return requestApproval(ctx, 'architecture_change', `Design confidence ${confidencePct}% is below the ${Math.round(council.confidenceThreshold * 100)}% threshold.`, {
      decisionId: record.id,
      question,
    });
  }
  return passed(`Decision: ${truncate(decision.text, 200)} (${confidencePct}% confidence).`);
};

// ---------------------------------------------------------------------------
// IMPLEMENT / TEST / DEBUG / REVIEW / SECURITY / VERIFY
// ---------------------------------------------------------------------------

export const implementStage: StageHandler = async (ctx) => {
  const { deps, project, run, task } = ctx;

  if (!run.checkpoint.buildComplete) {
    const files = await loadIndex(ctx);
    const plan = parseOutput(PlanOutputSchema, run.checkpoint.outputs.plan);
    const analysis = parseOutput(AnalysisOutputSchema, run.checkpoint.outputs.analysis);
    const decision = run.checkpoint.designDecisionId ? await deps.decisions.get(run.checkpoint.designDecisionId) : null;
    const knownPaths = new Set(files.map((f) => f.path));
    const pinned = [...new Set([...run.checkpoint.changeset.map((c) => c.path), ...(analysis?.relevantPaths ?? []).filter((p) => knownPaths.has(p))])];
    const hints = [...run.checkpoint.feedback, ...run.checkpoint.failures.slice(-3).map((f) => `${f.summary}\n${f.output}`)];
    const context = await buildContext({ task, files, tokenBudget: ctx.options.contextTokenBudget, pinnedPaths: pinned, hints }, contentLoader(ctx));

    const sections: AgentInput['sections'] = [
      ...analysisSection(analysis),
      ...(plan ? [{ title: 'Plan', body: JSON.stringify({ approach: plan.approach, tasks: plan.tasks, acceptanceCriteria: plan.acceptanceCriteria }, null, 2) }] : []),
      ...(decision ? [{ title: 'Design decision (binding)', body: `${decision.decision}\nReason: ${decision.reason}` }] : []),
      ...(run.checkpoint.changeset.length > 0
        ? [{ title: 'Current change set (return complete files; unchanged files may be omitted)', body: run.checkpoint.changeset.map((c) => `- ${c.action} ${c.path}`).join('\n') }]
        : []),
      ...(run.checkpoint.feedback.length > 0 ? [{ title: 'Feedback that must be addressed', body: run.checkpoint.feedback.map((f) => `- ${f}`).join('\n') }] : []),
      ...(run.checkpoint.notes.some((n) => n.startsWith('fix:'))
        ? [{ title: 'Previous fix attempts', body: run.checkpoint.notes.filter((n) => n.startsWith('fix:')).slice(-3).join('\n') }]
        : []),
    ];

    // Documentation tasks go to the documentation specialist, which may only write documentation files.
    const docs = task.kind === 'docs';
    const common = { ...agentCommon(ctx), priorFailures: run.debugAttempts, input: baseInput(ctx, sections, context.files) };
    const outcome = docs
      ? await deps.runtime.run({ ...common, definition: AGENT_DEFINITIONS.documentation })
      : await deps.runtime.run({ ...common, definition: AGENT_DEFINITIONS.build });
    track(ctx, outcome);
    if (!outcome.ok) return onAgentFailure(ctx, outcome);

    run.checkpoint.outputs.build = outcome.output;
    const rejected = docs
      ? await applyChanges(ctx, 'documentation', outcome.output.changes, 'docs.write')
      : await applyChanges(ctx, 'builder', outcome.output.changes);
    if (rejected) return rejected;
    run.checkpoint.feedback = [];
    run.checkpoint.buildComplete = true;
  }

  const pending = detectGatedActions(run.checkpoint.changeset, { criticalPaths: project.profile.criticalPaths }).filter(
    (gate) =>
      requiresApproval({ action: gate.action, autonomyLevel: project.autonomyLevel, gates: project.settings.approvalGates }) &&
      !run.checkpoint.approvedActions.includes(gate.action),
  );
  const gate = pending[0];
  if (gate) {
    return requestApproval(ctx, gate.action, `${gate.reason}: ${gate.paths.slice(0, 5).join(', ')}`, { paths: gate.paths, allGates: pending.map((g) => g.action) });
  }
  const dependencies = await dependencyGate(ctx);
  if (dependencies) return dependencies;
  return passed(`${run.checkpoint.changeset.length} file(s) in the change set.`);
};

const VERIFICATION_ORDER = ['install', 'typecheck', 'lint', 'build', 'test'] as const;

export const testStage: StageHandler = async (ctx) => {
  const { deps, project, run } = ctx;

  if (!run.checkpoint.outputs.tests) {
    const outcome = await deps.runtime.run({
      ...agentCommon(ctx),
      definition: AGENT_DEFINITIONS.test,
      input: baseInput(ctx, [{ title: 'Change set', body: renderChangeset(run.checkpoint.changeset, 80_000) }]),
    });
    track(ctx, outcome);
    if (!outcome.ok) return onAgentFailure(ctx, outcome);
    run.checkpoint.outputs.tests = outcome.output;
    const rejected = await applyChanges(ctx, 'tester', outcome.output.testFiles);
    if (rejected) return rejected;
  }

  const { checks, commands } = project.profile;
  const enabled: Record<(typeof VERIFICATION_ORDER)[number], boolean> = {
    install: true,
    typecheck: checks.typecheck,
    lint: checks.lint,
    build: checks.build,
    test: checks.test,
  };
  const toRun = VERIFICATION_ORDER.filter((name) => enabled[name] && commands[name]);
  const ciPlanned = isPlanned(run.stagePlan, 'CI');

  if (!deps.sandbox.available || !toRun.includes('test') || !run.checkpoint.baseSha) {
    run.checkpoint.verification = {
      status: 'deferred',
      source: ciPlanned ? 'ci' : 'none',
      summary: ciPlanned ? 'No sandbox run; CI verifies the change.' : 'Tests could not be executed (no sandbox, no CI).',
    };
    return passed(run.checkpoint.verification.summary);
  }

  // The tester may have changed manifests; nothing unapproved reaches the sandbox install.
  const dependencies = await dependencyGate(ctx);
  if (dependencies) return dependencies;

  const result = await ctx.tools.invoke<SandboxRunResult>(
    'test.run',
    { commands: toRun, ref: run.checkpoint.baseSha },
    toolContext(ctx, 'tester', workspaceFor(run)),
  );
  if (result.infrastructureError) {
    return { kind: 'wait', summary: `Sandbox infrastructure error: ${truncate(result.infrastructureError, 300)}`, resumeAt: new Date(ctx.now.getTime() + ctx.options.waitRetryMs) };
  }

  const output = redactSecrets(result.results.map((r) => `$ ${r.name} (exit ${r.exitCode})\n${r.output}`).join('\n\n'));
  const base = { projectId: project.id, taskId: ctx.task.id, runId: run.id };
  if (result.passed) {
    run.checkpoint.verification = { status: 'passed', source: 'sandbox', summary: `${toRun.join(', ')} passed` };
    await deps.events.emit({ type: 'test.passed', ...base, payload: { summary: run.checkpoint.verification.summary } });
    return passed(run.checkpoint.verification.summary);
  }

  const failed = result.results.find((r) => r.exitCode !== 0);
  const fingerprint = failureFingerprint(failed?.output ?? output);
  const summary = `${result.failedCommand ?? 'verification'} failed`;
  run.checkpoint.verification = { status: 'failed', source: 'sandbox', summary, fingerprint, output: truncate(output, 8_000) };
  await deps.events.emit({ type: 'test.failed', ...base, payload: { summary, fingerprint } });
  return { kind: 'retry', resumeStage: 'TEST', summary, failureOutput: truncate(failed?.output ?? output, 20_000) };
};

export const debugStage: StageHandler = async (ctx) => {
  const { deps, project, run, task } = ctx;
  const last = run.checkpoint.failures.at(-1);
  if (!last) return passed('Nothing to debug.');

  const repeats = run.checkpoint.failures.filter((f) => f.fingerprint === last.fingerprint).length;
  const [known] = await deps.memories.search(project.id, { scope: 'failure', key: last.fingerprint, limit: 1 });
  const previousFixes = run.checkpoint.notes.filter((n) => n.startsWith('fix:')).slice(-3);
  const files = await loadIndex(ctx);
  const context = await buildContext(
    { task, files, tokenBudget: ctx.options.contextTokenBudget, pinnedPaths: run.checkpoint.changeset.map((c) => c.path), hints: [last.output] },
    contentLoader(ctx),
  );

  const sections: AgentInput['sections'] = [
    { title: 'Failure', body: `Stage: ${last.stage}\nOccurrences of this exact failure in this run: ${repeats}\n\n${last.output || last.summary}` },
    ...(previousFixes.length > 0 || known
      ? [{ title: 'Previously failed fixes (do not repeat)', body: [...previousFixes, ...(known ? [`Memory: ${truncate(known.content, 800)}`] : [])].join('\n') }]
      : []),
    { title: 'Change set', body: run.checkpoint.changeset.map((c) => `- ${c.action} ${c.path}`).join('\n') || '(empty)' },
  ];

  const outcome = await deps.runtime.run({
    ...agentCommon(ctx),
    priorFailures: run.debugAttempts,
    definition: AGENT_DEFINITIONS.debug,
    input: baseInput(ctx, sections, context.files),
  });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);
  run.checkpoint.outputs.debug = outcome.output;

  if (outcome.output.isInfrastructureIssue) {
    run.checkpoint.notes.push(`infra: ${truncate(outcome.output.rootCause, 300)}`);
    return passed('Diagnosed an infrastructure issue; retrying without code changes.');
  }

  const rejected = await applyChanges(ctx, 'debugger', outcome.output.fix);
  if (rejected) return rejected;
  run.checkpoint.notes.push(`fix: ${truncate(outcome.output.rootCause, 300)} (${outcome.output.fix.map((f) => f.path).join(', ')})`);
  await deps.memories.upsert({
    projectId: project.id,
    scope: 'failure',
    taskId: task.id,
    kind: `${last.stage.toLowerCase()}_failure`,
    key: last.fingerprint,
    content: JSON.stringify({ summary: last.summary, rootCause: outcome.output.rootCause, fix: outcome.output.fix.map((f) => f.path), repeats }),
    tags: [last.stage],
  });
  return passed(`Root cause: ${truncate(outcome.output.rootCause, 300)}`);
};

export const reviewStage: StageHandler = async (ctx) => {
  const { deps, project, run, task } = ctx;
  const base = { projectId: project.id, taskId: task.id, runId: run.id };
  await deps.events.emit({ type: 'review.requested', ...base, payload: { stage: 'REVIEW' } });

  const plan = parseOutput(PlanOutputSchema, run.checkpoint.outputs.plan);
  const outcome = await deps.runtime.run({
    ...agentCommon(ctx),
    definition: AGENT_DEFINITIONS.review,
    input: baseInput(ctx, [
      ...(plan ? [{ title: 'Plan approach', body: plan.approach }] : []),
      { title: 'Verification', body: run.checkpoint.verification?.summary ?? 'not run' },
      { title: 'Change set', body: renderChangeset(run.checkpoint.changeset, 120_000) },
    ]),
  });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);

  const review = outcome.output;
  run.checkpoint.outputs.review = review;
  await deps.events.emit({ type: 'review.completed', ...base, payload: { verdict: review.verdict, issues: review.issues.length } });

  const unmet = review.acceptanceCriteria.filter((c) => !c.met);
  if (review.verdict === 'request_changes' || unmet.length > 0) {
    const feedback = [
      ...review.issues.filter((i) => i.severity !== 'low').map((i) => `[${i.severity}] ${i.path ?? 'general'}: ${i.description} → ${i.suggestion}`),
      ...unmet.map((c) => `Unmet acceptance criterion: ${c.criterion} (${c.evidence})`),
    ];
    return { kind: 'feedback', summary: `Review requested changes (${feedback.length} item(s)).`, feedback };
  }
  return passed(`Approved: ${truncate(review.summary, 200)}`);
};

export const securityStage: StageHandler = async (ctx) => {
  const { deps, run } = ctx;
  const outcome = await deps.runtime.run({
    ...agentCommon(ctx),
    definition: AGENT_DEFINITIONS.security_audit,
    input: baseInput(ctx, [{ title: 'Change set', body: renderChangeset(run.checkpoint.changeset, 120_000) }]),
  });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);

  const audit = outcome.output;
  run.checkpoint.outputs.security = audit;
  if (audit.verdict === 'fail') {
    const feedback = audit.findings
      .filter((f) => f.severity !== 'low')
      .map((f) => `[security/${f.severity}] ${f.category} in ${f.path ?? 'change set'}: ${f.description} → ${f.remediation}`);
    return { kind: 'feedback', summary: `Security audit failed (${feedback.length} finding(s)).`, feedback };
  }
  return passed(`Security audit passed${audit.findings.length > 0 ? ` with ${audit.findings.length} low finding(s)` : ''}.`);
};

/** Definition of Done (spec §33), deterministic — no model call. */
export const verifyStage: StageHandler = async (ctx) => {
  const { run } = ctx;
  const { checkpoint } = run;
  const issues: string[] = [];

  const secrets = checkpoint.changeset.flatMap((c) => (c.content ? findSecrets(c.content).map((f) => `${c.path} (${f.name})`) : []));
  if (secrets.length > 0) return { kind: 'blocked', reason: `Secret-looking values in the change set: ${secrets.join(', ')}` };

  if (checkpoint.changeset.length === 0) issues.push('The change set is empty.');
  if (isPlanned(run.stagePlan, 'REVIEW') && parseOutput(ReviewOutputSchema, checkpoint.outputs.review)?.verdict !== 'approve') {
    issues.push('Code review has not approved the change.');
  }
  if (isPlanned(run.stagePlan, 'SECURITY') && parseOutput(SecurityOutputSchema, checkpoint.outputs.security)?.verdict !== 'pass') {
    issues.push('Security audit has not passed.');
  }
  if (checkpoint.verification?.status === 'failed') issues.push('Verification commands are failing.');
  if (issues.length > 0) return { kind: 'feedback', summary: `Definition of Done not met: ${issues.join(' ')}`, feedback: issues };

  if (!isPlanned(run.stagePlan, 'COMMIT')) {
    checkpoint.outcome = checkpoint.verification?.status === 'passed' ? 'changes_ready' : 'changes_ready_unverified';
  }
  const verification = checkpoint.verification?.status ?? 'skipped';
  return passed(`Definition of Done satisfied (verification: ${verification}).`);
};

export function recordFailure(run: PipelineRun, stage: RunStage, summary: string, output: string, now: Date): string {
  const fingerprint = failureFingerprint(output || summary);
  run.checkpoint.failures = [
    ...run.checkpoint.failures,
    { stage, summary: truncate(summary, 500), fingerprint, output: truncate(redactSecrets(output), 20_000), at: now.toISOString() },
  ].slice(-20);
  return fingerprint;
}

export function gatedActionsPendingApproval(run: PipelineRun): GatedAction[] {
  return run.checkpoint.approvedActions as GatedAction[];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
