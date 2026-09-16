import { AGENT_DEFINITIONS } from '../agents/definitions';
import type { AgentRuntime } from '../agents/runtime';
import { approvalGrant } from '../approval/dependencies';
import type { AutopilotAuditEntry, AutopilotSessionRepository } from '../autopilot/service';
import { applyAutopilotSession, DEFAULT_AUTOPILOT_LIMITS, sessionTaskEligibility, type AutopilotLimits, type AutopilotSession } from '../autopilot/session';
import type { FileSummaryStore } from '../context/file-summarizer';
import type { DecisionLadderWiring } from './design-ladder';
import {
  NON_TERMINAL_RUN_STATUSES,
  SLOT_HOLDING_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type RunStage,
  type RunStatus,
  type StageStatus,
} from '../domain/enums';
import type { Project } from '../domain/project';
import type { PipelineRun } from '../domain/run';
import type { Task } from '../domain/task';
import { GitHubUnavailableError, type GitHubPort } from '../github/port';
import { planStages } from '../pipeline/stage-planner';
import { canAttemptDebug, checkStopConditions } from '../pipeline/stop-conditions';
import {
  ConcurrentModificationError,
  type ApprovalRepository,
  type Clock,
  type DecisionRepository,
  type EventRecorder,
  type JobQueue,
  type MemoryRepository,
  type ProjectRepository,
  type RunRepository,
  type TaskRepository,
} from '../ports';
import type { RepoFileStore, RepoIndexer } from '../repo-index/indexer';
import type { SandboxPort } from '../sandbox/port';
import { schedule, type SkippedTask } from '../scheduler/scheduler';
import type { ToolAuditEntry, ToolRouter } from '../tools/tool-router';
import { commitStage, ciStage, deployStage, monitorStage, prStage, pushStage } from './delivery';
import { defaultOutcome, nextPlannedStage, STAGE_PROJECT_STATUS, truncate } from './helpers';
import {
  analyzeStage,
  debugStage,
  designStage,
  implementStage,
  intakeStage,
  planStage,
  recordFailure,
  requestRunApproval,
  reviewStage,
  securityStage,
  testStage,
  verifyStage,
  type StageHandler,
  type StageOutcome,
} from './stages';
import { createOrchestratorTools } from './tools';

export interface OrchestratorOptions {
  contextTokenBudget: number;
  analysisTokenBudget: number;
  ciPollIntervalMs: number;
  maxCiPollsWithoutChecks: number;
  maxCiInfraRetries: number;
  maxStageAttempts: number;
  waitRetryMs: number;
  sandboxTimeoutMs: number;
  /** RUNNING runs untouched for this long get a new step job (lost job after a crash). */
  stalledRunMs: number;
  globalCapacity: number;
  /** APPROVAL_TTL_HOURS (ADR-023); used to compute the expiry of deferred approvals. ≤ 0 disables expiry. */
  approvalTtlMs: number;
  /** Autopilot bounds used by the pipeline (autonomy cap, deferred approval expiry). */
  autopilot: Pick<AutopilotLimits, 'maxAutonomy' | 'returnGraceMs' | 'maxApprovalLifetimeMs'>;
}

export const DEFAULT_ORCHESTRATOR_OPTIONS: Readonly<OrchestratorOptions> = Object.freeze({
  contextTokenBudget: 60_000,
  analysisTokenBudget: 16_000,
  ciPollIntervalMs: 60_000,
  maxCiPollsWithoutChecks: 10,
  maxCiInfraRetries: 2,
  maxStageAttempts: 3,
  waitRetryMs: 120_000,
  sandboxTimeoutMs: 15 * 60_000,
  stalledRunMs: 10 * 60_000,
  globalCapacity: 4,
  approvalTtlMs: 72 * 60 * 60 * 1000,
  autopilot: {
    maxAutonomy: DEFAULT_AUTOPILOT_LIMITS.maxAutonomy,
    returnGraceMs: DEFAULT_AUTOPILOT_LIMITS.returnGraceMs,
    maxApprovalLifetimeMs: DEFAULT_AUTOPILOT_LIMITS.maxApprovalLifetimeMs,
  },
});

export interface OrchestratorDeps {
  projects: ProjectRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  decisions: DecisionRepository;
  memories: MemoryRepository;
  approvals: ApprovalRepository;
  events: EventRecorder;
  queue: JobQueue;
  clock: Clock;
  runtime: AgentRuntime;
  github: GitHubPort;
  sandbox: SandboxPort;
  repoIndex: RepoIndexer;
  repoFiles: RepoFileStore;
  /** Enables file summaries in ANALYZE (spec §31). */
  fileSummaries?: FileSummaryStore;
  toolAudit?: (entry: ToolAuditEntry) => void | Promise<void>;
  globalBudgetExhausted?: () => Promise<boolean>;
  /** Autopilot sessions (away mode). Absent: the pipeline behaves as without sessions. */
  autopilotSessions?: AutopilotSessionRepository;
  /**
   * Decision ladder and council protocol v2 for questions of session runs (autopilot stage 2). Absent: DESIGN in a
   * session uses the stage-1 behaviour (bounded council, approval below the threshold).
   */
  decisionLadder?: DecisionLadderWiring;
  /** Audit trail for autopilot run transitions (started in a session, parked, unparked, paused by a kill). */
  audit?: (entry: AutopilotAuditEntry) => Promise<void>;
  options?: Partial<OrchestratorOptions>;
}

export type StepResult = { next: 'continue' } | { next: 'wait'; resumeAt: Date | null } | { next: 'done'; status: RunStatus };

export const PIPELINE_STEP_JOB = 'pipeline.step';
export const SCHEDULER_TICK_JOB = 'scheduler.tick';

/** Runs a kill switch pauses; parked runs already wait for a human and paused ones are stopped. */
const PAUSABLE: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING'];

const HANDLERS: Readonly<Record<RunStage, StageHandler>> = {
  INTAKE: intakeStage,
  ANALYZE: analyzeStage,
  PLAN: planStage,
  DESIGN: designStage,
  IMPLEMENT: implementStage,
  TEST: testStage,
  REVIEW: reviewStage,
  SECURITY: securityStage,
  VERIFY: verifyStage,
  COMMIT: commitStage,
  PUSH: pushStage,
  PR: prStage,
  CI: ciStage,
  DEPLOY: deployStage,
  MONITOR: monitorStage,
  DEBUG: debugStage,
};

/**
 * The orchestrator decision loop (spec §28) as a durable state machine: every `step` executes one stage
 * of one run, persists the checkpoint and schedules the next step as a job. Loops (debugging, review
 * feedback, stage retries) are bounded by the run's stop conditions; nothing runs unbounded in memory.
 */
export class Orchestrator {
  readonly tools: ToolRouter;
  readonly options: OrchestratorOptions;

  constructor(private readonly deps: OrchestratorDeps) {
    this.options = { ...DEFAULT_ORCHESTRATOR_OPTIONS, ...deps.options };
    const sessions = deps.autopilotSessions;
    this.tools = createOrchestratorTools({
      github: deps.github,
      sandbox: deps.sandbox,
      sandboxTimeoutMs: this.options.sandboxTimeoutMs,
      audit: deps.toolAudit,
      ...(sessions ? { sessionGuard: async (id: string) => ((await sessions.get(id))?.status === 'killed' ? `autopilot session ${id} was killed` : null) } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Picks tasks with the scheduler and starts runs for them; also re-enqueues stalled runs. */
  async tick(): Promise<{ started: string[]; recovered: number; skipped: SkippedTask[] }> {
    const now = this.deps.clock.now();
    const [projects, candidates, sessions] = await Promise.all([
      this.deps.projects.list(),
      this.deps.tasks.list({ statuses: ['READY', 'BACKLOG'], limit: 1000 }),
      this.deps.autopilotSessions ? this.deps.autopilotSessions.list({ statuses: ['active'], limit: 200 }) : Promise.resolve([]),
    ]);

    // Projects in an active session only get tasks the autopilot may pick up.
    const sessionByProject = new Map<string, AutopilotSession>();
    for (const session of sessions) for (const projectId of session.projectIds) sessionByProject.set(projectId, session);
    const parked = sessions.length > 0 ? await this.deps.runs.countByProject(['PARKED']) : new Map<string, number>();
    const spent = new Map<string, number>();
    const sessionSkips: SkippedTask[] = [];
    const eligible: Task[] = [];
    for (const task of candidates) {
      const session = sessionByProject.get(task.projectId);
      if (!session) {
        eligible.push(task);
        continue;
      }
      if (!spent.has(session.id)) spent.set(session.id, await this.deps.autopilotSessions!.spentUsd(session, now));
      const reason = sessionTaskEligibility({ task, session, now, spentUsd: spent.get(session.id)!, parkedRuns: parked.get(task.projectId) ?? 0 });
      if (reason) sessionSkips.push({ taskId: task.id, projectId: task.projectId, reason });
      else eligible.push(task);
    }

    const dependencyIds = [...new Set(eligible.flatMap((t) => t.dependencies))];
    const [statuses, slotHolding, running] = await Promise.all([
      this.deps.tasks.statuses(dependencyIds),
      this.deps.runs.countByProject(SLOT_HOLDING_RUN_STATUSES),
      this.deps.runs.countByProject(['QUEUED', 'RUNNING']),
    ]);

    const result = schedule({
      now,
      projects: projects.map((p) => ({
        id: p.id,
        priority: p.priority,
        status: p.status,
        maxConcurrentTasks: p.settings.maxConcurrentTasks,
        budgetUsd: p.budgetUsd,
        spentUsd: p.spentUsd,
        lastScheduledAt: p.lastScheduledAt,
      })),
      tasks: eligible,
      taskStatuses: statuses,
      // PARKED runs wait for a human and hold no slot, so parked approvals never stall a project.
      runningTasksByProject: slotHolding,
      globalCapacity: this.options.globalCapacity,
      globalRunning: [...running.values()].reduce((a, b) => a + b, 0),
      globalBudgetExhausted: (await this.deps.globalBudgetExhausted?.()) ?? false,
    });

    const skipped = [...sessionSkips, ...result.skipped];
    const sessionSlots = new Map<string, number>();
    const started: string[] = [];
    for (const selected of result.selected) {
      const session = sessionByProject.get(selected.projectId);
      if (session?.maxConcurrentRuns) {
        if (!sessionSlots.has(session.id)) {
          sessionSlots.set(session.id, (await this.deps.runs.list({ sessionId: session.id, statuses: SLOT_HOLDING_RUN_STATUSES, limit: 100 })).length);
        }
        if (sessionSlots.get(session.id)! >= session.maxConcurrentRuns) {
          skipped.push({ taskId: selected.taskId, projectId: selected.projectId, reason: 'autopilot_concurrency_limit' });
          continue;
        }
      }
      const run = await this.startTask(selected.taskId, session ? { sessionId: session.id } : {});
      if (run) {
        started.push(run.id);
        if (session) sessionSlots.set(session.id, (sessionSlots.get(session.id) ?? 0) + 1);
      }
    }
    if (started.length > 0) {
      await this.deps.events.emit({
        type: 'scheduler.tick',
        projectId: null,
        taskId: null,
        runId: null,
        payload: { selected: started.length, skipped: skipped.length },
      });
    }
    return { started, recovered: await this.recoverStalledRuns(now), skipped };
  }

  /** Starts a run. With `sessionId` the run belongs to that active autopilot session (capped autonomy, hard gates). */
  async startTask(taskId: string, options: { sessionId?: string } = {}): Promise<PipelineRun | null> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || (task.status !== 'READY' && task.status !== 'BACKLOG')) return null;
    const baseProject = await this.deps.projects.get(task.projectId);
    if (!baseProject) return null;
    const existing = await this.deps.runs.list({ taskId, statuses: NON_TERMINAL_RUN_STATUSES, limit: 1 });
    if (existing.length > 0) return null;

    let session: AutopilotSession | null = null;
    if (options.sessionId) {
      const found = (await this.deps.autopilotSessions?.get(options.sessionId)) ?? null;
      // The session ended between the scheduler decision and the start: the next tick decides again.
      if (!found || found.status !== 'active' || !found.projectIds.includes(baseProject.id)) return null;
      session = found;
    }
    const project = session ? applyAutopilotSession(baseProject, session, this.options.autopilot) : baseProject;

    const now = this.deps.clock.now();
    const plan = planStages(task, project);
    let run = await this.deps.runs.create({
      taskId,
      projectId: project.id,
      stagePlan: plan,
      limits: { ...project.settings.stopConditions, maxCostUsd: Math.min(project.settings.stopConditions.maxCostUsd, task.maxCost) },
      sessionId: session?.id ?? null,
    });
    for (const item of plan) {
      if (!item.run) run.stageStates[item.stage] = { status: 'skipped', startedAt: null, finishedAt: null, summary: item.reason, attempts: 0 };
    }
    run.status = 'RUNNING';
    run.currentStage = nextPlannedStage(plan, null);
    run = await this.deps.runs.save(run);

    await this.deps.tasks.update(task.id, { status: 'RUNNING', attempts: task.attempts + 1, blockedReason: null });
    await this.deps.projects.update(project.id, { lastScheduledAt: now });
    await this.deps.events.emit({ type: 'task.started', projectId: project.id, taskId: task.id, runId: run.id, payload: { runId: run.id } });
    if (session) {
      const payload = { sessionId: session.id, effectiveAutonomy: project.autonomyLevel, baseAutonomy: baseProject.autonomyLevel };
      await this.deps.events.emit({ type: 'autopilot.run.started', projectId: project.id, taskId: task.id, runId: run.id, payload });
      await this.audit('autopilot.run.start', run.id, { ...payload, projectId: project.id, taskId: task.id });
    }
    await this.enqueueStep(run);
    return run;
  }

  private async recoverStalledRuns(now: Date): Promise<number> {
    const runs = await this.deps.runs.list({ statuses: ['RUNNING', 'WAITING'], limit: 500 });
    let recovered = 0;
    for (const run of runs) {
      const stalled = run.status === 'RUNNING' && now.getTime() - run.updatedAt.getTime() > this.options.stalledRunMs;
      const due = run.status === 'WAITING' && !run.checkpoint.pendingApprovalId && run.resumeAt !== null && run.resumeAt.getTime() <= now.getTime() - this.options.stalledRunMs;
      if (stalled || due) {
        await this.enqueueStep(run);
        recovered++;
      }
    }
    return recovered;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async step(runId: string): Promise<StepResult> {
    const loaded = await this.deps.runs.get(runId);
    if (!loaded) return { next: 'done', status: 'CANCELLED' };
    const run = loaded;
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { next: 'done', status: run.status };

    const now = this.deps.clock.now();
    if (run.status === 'PAUSED' || run.status === 'PARKED') return { next: 'wait', resumeAt: null };
    if (run.status === 'WAITING') {
      if (run.checkpoint.pendingApprovalId) return { next: 'wait', resumeAt: null };
      if (run.resumeAt && run.resumeAt.getTime() > now.getTime()) return { next: 'wait', resumeAt: run.resumeAt };
    }

    const [task, baseProject, session] = await Promise.all([
      this.deps.tasks.get(run.taskId),
      this.deps.projects.get(run.projectId),
      run.sessionId && this.deps.autopilotSessions ? this.deps.autopilotSessions.get(run.sessionId) : Promise.resolve(null),
    ]);
    if (!task || !baseProject) {
      run.status = 'FAILED';
      run.error = 'task or project no longer exists';
      run.finishedAt = now;
      return this.persist(run, { next: 'done', status: 'FAILED' });
    }

    // Safety net for a kill that lost a race against this run: never execute a stage of a killed session.
    if (session?.status === 'killed') {
      const reason = `Autopilot session ${session.id} was killed.`;
      run.status = 'PAUSED';
      run.resumeAt = null;
      run.checkpoint.notes.push(`paused: ${reason}`);
      await this.deps.tasks.update(task.id, { status: 'PAUSED', blockedReason: reason });
      return this.persist(run, { next: 'wait', resumeAt: null });
    }
    // A run started in a session keeps the capped autonomy and hard gates until it finishes, also after a graceful
    // stop: ending a session only ever removes autonomy. Approvals are deferred (parked) only while it is active.
    // A human resume detaches the run from an ended session (see `resume`).
    const activeSession = session?.status === 'active' ? session : null;
    const project = session ? applyAutopilotSession(baseProject, session, this.options.autopilot) : baseProject;

    const stop = checkStopConditions({ ...run, parkedMs: run.checkpoint.parkedMs ?? 0 }, run.limits, now);
    if (stop.stop) {
      await this.block(run, task, project, `Stop condition "${stop.reason}" reached: ${stop.detail}.`);
      return this.persist(run, { next: 'done', status: run.status });
    }

    const { highCostThresholdUsd, approvalGates } = project.settings;
    if (approvalGates.high_cost && highCostThresholdUsd > 0 && run.costUsd >= highCostThresholdUsd && !run.checkpoint.approvedActions.includes('high_cost')) {
      const outcome = await requestRunApproval(
        { deps: this.deps, options: this.options, run, task, project, session: activeSession, now },
        { action: 'high_cost', reason: `Run has spent $${run.costUsd.toFixed(2)}, above the $${highCostThresholdUsd.toFixed(2)} threshold.`, risk: 'medium', details: { costUsd: run.costUsd } },
      );
      return this.persist(run, await this.apply(run, task, project, run.currentStage ?? 'INTAKE', outcome, now));
    }

    const stage = run.currentStage ?? nextPlannedStage(run.stagePlan, null);
    if (!stage) {
      await this.complete(run, task, project, defaultOutcome(run.checkpoint));
      return this.persist(run, { next: 'done', status: run.status });
    }

    run.status = 'RUNNING';
    run.resumeAt = null;
    run.currentStage = stage;
    const state = run.stageStates[stage];
    if (!state || (state.status !== 'running' && state.status !== 'waiting')) {
      run.stageStates[stage] = { status: 'running', startedAt: now.toISOString(), finishedAt: null, summary: null, attempts: (state?.attempts ?? 0) + 1 };
      await this.deps.events.emit({ type: 'pipeline.stage.started', projectId: project.id, taskId: task.id, runId: run.id, payload: { stage } });
      if (project.status !== STAGE_PROJECT_STATUS[stage]) await this.deps.projects.update(project.id, { status: STAGE_PROJECT_STATUS[stage] });
    } else {
      state.status = 'running';
    }

    const ctx = { deps: this.deps, options: this.options, tools: this.tools, run, task, project, now, session: activeSession };
    let outcome: StageOutcome;
    try {
      outcome = await HANDLERS[stage](ctx);
    } catch (error) {
      if (error instanceof ConcurrentModificationError) throw error;
      outcome =
        error instanceof GitHubUnavailableError
          ? { kind: 'wait', summary: `GitHub unavailable: ${error.message}`, resumeAt: new Date(now.getTime() + (error.retryAfterMs ?? this.options.waitRetryMs)) }
          : { kind: 'retry_stage', summary: `Unexpected error: ${truncate(error instanceof Error ? error.message : String(error), 500)}` };
    }

    return this.persist(run, await this.apply(run, ctx.task, project, stage, outcome, now));
  }

  /** Resumes a run after a human decided on its pending approval (WAITING, or PARKED by the autopilot). */
  async onApprovalDecided(approvalId: string): Promise<StepResult | null> {
    const approval = await this.deps.approvals.get(approvalId);
    if (!approval?.runId || approval.status === 'pending') return null;
    const run = await this.deps.runs.get(approval.runId);
    // A cancelled or finished run keeps its checkpoint; a late decision (or expiry) must not reopen or block it.
    if (!run || TERMINAL_RUN_STATUSES.has(run.status) || run.checkpoint.pendingApprovalId !== approval.id) return null;
    const [task, project] = await Promise.all([this.deps.tasks.get(run.taskId), this.deps.projects.get(run.projectId)]);
    if (!task || !project) return null;

    const status = approval.status === 'approved' ? 'approved' : approval.status === 'expired' ? 'expired' : 'rejected';
    await this.deps.events.emit({
      type: 'approval.decided',
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      payload: { approvalId: approval.id, status, by: approval.decidedBy ?? 'unknown' },
    });
    run.checkpoint.pendingApprovalId = null;
    if (run.status === 'PARKED') {
      // Waiting for a human while away is not run time: without this, approving after a long absence would block the
      // run on max_runtime immediately.
      const parkedFor = Math.max(0, this.deps.clock.now().getTime() - approval.requestedAt.getTime());
      run.checkpoint.parkedMs = (run.checkpoint.parkedMs ?? 0) + parkedFor;
      await this.deps.events.emit({ type: 'autopilot.run.unparked', projectId: project.id, taskId: task.id, runId: run.id, payload: { sessionId: run.sessionId, approvalId: approval.id, status } });
      await this.audit('autopilot.run.unpark', run.id, { sessionId: run.sessionId, approvalId: approval.id, status, by: approval.decidedBy ?? 'unknown' });
    }

    if (approval.status !== 'approved') {
      const note = approval.comment ? `: ${approval.comment}` : '';
      const reason =
        approval.status === 'expired'
          ? `Approval for ${approval.action} expired without a decision${note}. Retry the task to request a new approval.`
          : `${approval.action} was rejected by ${approval.decidedBy ?? 'a reviewer'}${note}.`;
      await this.block(run, task, project, reason);
      return this.persist(run, { next: 'done', status: run.status });
    }

    // Dependency approvals grant exactly the approved set of additions (ADR-031), not the action as a whole.
    const grant = approvalGrant(approval);
    if (grant && !run.checkpoint.approvedActions.includes(grant)) run.checkpoint.approvedActions.push(grant);
    run.status = 'RUNNING';
    run.resumeAt = null;
    await this.deps.tasks.update(task.id, { status: 'RUNNING' });
    return this.persist(run, { next: 'continue' });
  }

  /**
   * Resumes a PAUSED run (e.g. after the budget was raised). Resuming is a human action: a run of a session that is no
   * longer active is detached from it and continues with the project's own autonomy and gates.
   */
  async resume(runId: string): Promise<StepResult | null> {
    const run = await this.deps.runs.get(runId);
    if (!run || run.status !== 'PAUSED') return null;
    if (run.sessionId && this.deps.autopilotSessions) {
      const session = await this.deps.autopilotSessions.get(run.sessionId);
      if (!session || session.status !== 'active') {
        run.checkpoint.notes.push(`detached from autopilot session ${run.sessionId} (${session?.status ?? 'missing'}) on resume`);
        await this.audit('autopilot.run.detach', run.id, { sessionId: run.sessionId, sessionStatus: session?.status ?? null });
        run.sessionId = null;
      }
    }
    run.status = 'RUNNING';
    await this.deps.tasks.update(run.taskId, { status: 'RUNNING' });
    return this.persist(run, { next: 'continue' });
  }

  /** Pauses an in-flight run (kill switch). Bounded retries; a run that keeps racing is paused by its next step. */
  async pause(runId: string, reason: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await this.deps.runs.get(runId);
      if (!run || !PAUSABLE.includes(run.status)) return false;
      run.status = 'PAUSED';
      run.resumeAt = null;
      run.checkpoint.notes.push(`paused: ${truncate(reason, 300)}`);
      try {
        await this.deps.runs.save(run);
      } catch (error) {
        if (error instanceof ConcurrentModificationError) continue;
        throw error;
      }
      await this.deps.tasks.update(run.taskId, { status: 'PAUSED', blockedReason: truncate(reason, 2000) });
      await this.audit('autopilot.run.pause', run.id, { sessionId: run.sessionId, reason: truncate(reason, 500) });
      return true;
    }
    return false;
  }

  async cancel(runId: string, reason: string): Promise<boolean> {
    const run = await this.deps.runs.get(runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
    run.status = 'CANCELLED';
    run.error = reason;
    run.finishedAt = this.deps.clock.now();
    await this.deps.runs.save(run);
    await this.deps.tasks.update(run.taskId, { status: 'CANCELLED', blockedReason: reason });
    await this.refreshProjectStatus(run.projectId, run.id, 'IDLE');
    return true;
  }

  // -------------------------------------------------------------------------
  // Outcome handling
  // -------------------------------------------------------------------------

  private async apply(run: PipelineRun, task: Task, project: Project, stage: RunStage, outcome: StageOutcome, now: Date): Promise<StepResult> {
    const base = { projectId: project.id, taskId: task.id, runId: run.id };
    const mark = async (status: StageStatus, summary: string) => {
      const state = (run.stageStates[stage] ??= { status, startedAt: now.toISOString(), finishedAt: null, summary: null, attempts: 1 });
      state.status = status;
      state.summary = truncate(summary, 1000);
      if (status !== 'waiting' && status !== 'running') {
        state.finishedAt = now.toISOString();
        await this.deps.events.emit({ type: 'pipeline.stage.completed', ...base, payload: { stage, status, summary: state.summary } });
      }
    };
    const loopBack = async (reason: string): Promise<boolean> => {
      if (!canAttemptDebug(run, run.limits)) {
        await this.block(run, task, project, `Gave up after ${run.debugAttempts} repair attempt(s): ${reason}`);
        return false;
      }
      run.debugAttempts++;
      run.iterations++;
      return true;
    };

    switch (outcome.kind) {
      case 'passed': {
        await mark('passed', outcome.summary);
        const next = stage === 'DEBUG' ? run.checkpoint.resumeStage : nextPlannedStage(run.stagePlan, stage);
        if (stage === 'DEBUG') run.checkpoint.resumeStage = null;
        if (!next) {
          await this.complete(run, task, project, defaultOutcome(run.checkpoint));
          return { next: 'done', status: run.status };
        }
        run.currentStage = next;
        return { next: 'continue' };
      }

      case 'retry': {
        await mark('failed', outcome.summary);
        recordFailure(run, stage, outcome.summary, outcome.failureOutput, now);
        if (!(await loopBack(outcome.summary))) return { next: 'done', status: run.status };
        run.checkpoint.resumeStage = outcome.resumeStage;
        run.currentStage = 'DEBUG';
        return { next: 'continue' };
      }

      case 'feedback': {
        await mark('failed', outcome.summary);
        if (!(await loopBack(outcome.summary))) return { next: 'done', status: run.status };
        run.checkpoint.feedback = outcome.feedback.slice(0, 40);
        run.checkpoint.buildComplete = false;
        run.currentStage = 'IMPLEMENT';
        return { next: 'continue' };
      }

      case 'retry_stage': {
        const attempts = run.stageStates[stage]?.attempts ?? 1;
        await mark('failed', outcome.summary);
        if (attempts >= this.options.maxStageAttempts) {
          await this.block(run, task, project, `${stage} failed ${attempts} time(s): ${outcome.summary}`);
          return { next: 'done', status: run.status };
        }
        run.iterations++;
        run.status = 'WAITING';
        run.resumeAt = new Date(now.getTime() + Math.min(this.options.waitRetryMs, 15_000 * attempts));
        run.checkpoint.notes.push(`retry ${stage}: ${truncate(outcome.summary, 300)}`);
        return { next: 'wait', resumeAt: run.resumeAt };
      }

      case 'wait': {
        await mark('waiting', outcome.summary);
        run.status = 'WAITING';
        run.resumeAt = outcome.resumeAt;
        if (outcome.approvalId) {
          run.checkpoint.pendingApprovalId = outcome.approvalId;
          await this.deps.tasks.update(task.id, { status: 'WAITING_APPROVAL' });
          await this.deps.projects.update(project.id, { status: 'WAITING' });
        }
        return { next: 'wait', resumeAt: outcome.resumeAt };
      }

      case 'parked': {
        // Deferred approval inside an autopilot session: the human still decides, but the run frees its slot and the
        // project is not marked as waiting, so the scheduler continues with other work.
        await mark('waiting', outcome.summary);
        run.status = 'PARKED';
        run.resumeAt = null;
        run.checkpoint.pendingApprovalId = outcome.approvalId;
        run.checkpoint.notes.push(`parked for a human: ${truncate(outcome.reason, 300)}`);
        await this.deps.tasks.update(task.id, { status: 'WAITING_APPROVAL' });
        const payload = { sessionId: outcome.sessionId, approvalId: outcome.approvalId, action: outcome.action, reason: truncate(outcome.reason, 500), expiresAt: outcome.expiresAt?.toISOString() ?? null };
        await this.deps.events.emit({ type: 'autopilot.run.parked', ...base, payload });
        await this.audit('autopilot.run.park', run.id, { ...payload, projectId: project.id, taskId: task.id });
        await this.refreshProjectStatus(project.id, run.id, 'IDLE');
        return { next: 'wait', resumeAt: null };
      }

      case 'paused': {
        await mark('waiting', outcome.reason);
        run.status = 'PAUSED';
        run.checkpoint.notes.push(`paused: ${truncate(outcome.reason, 300)}`);
        await this.deps.tasks.update(task.id, { status: 'PAUSED', blockedReason: outcome.reason });
        return { next: 'wait', resumeAt: null };
      }

      case 'blocked': {
        await mark('failed', outcome.reason);
        await this.block(run, task, project, outcome.reason);
        return { next: 'done', status: run.status };
      }

      case 'finished': {
        await mark('passed', outcome.summary);
        await this.complete(run, task, project, outcome.outcome);
        return { next: 'done', status: run.status };
      }
    }
  }

  private async complete(run: PipelineRun, task: Task, project: Project, outcome: string): Promise<void> {
    const now = this.deps.clock.now();
    run.status = 'SUCCEEDED';
    run.currentStage = null;
    run.finishedAt = now;
    run.checkpoint.outcome = outcome;

    if (outcome !== 'decomposed') {
      await this.deps.tasks.update(task.id, { status: 'DONE', blockedReason: null });
      await this.completeParentIfDone(task);
    }
    await this.deps.events.emit({ type: 'task.completed', projectId: project.id, taskId: task.id, runId: run.id, payload: { runId: run.id, outcome } });
    await this.deps.memories.upsert({
      projectId: project.id,
      scope: 'task',
      taskId: task.id,
      kind: 'result',
      key: `task:${task.id}:result`,
      content: JSON.stringify({ outcome, branch: run.checkpoint.branch, pr: run.checkpoint.prUrl, costUsd: run.costUsd, files: run.checkpoint.changeset.map((c) => c.path) }),
      tags: [outcome],
    });
    await this.refreshProjectStatus(project.id, run.id, outcome === 'deployed' ? 'DEPLOYED' : 'IDLE');
  }

  private async completeParentIfDone(task: Task): Promise<void> {
    if (!task.parentId) return;
    const siblings = await this.deps.tasks.list({ parentId: task.parentId });
    if (siblings.length > 0 && siblings.every((s) => s.id === task.id || s.status === 'DONE')) {
      const parent = await this.deps.tasks.update(task.parentId, { status: 'DONE' });
      await this.deps.events.emit({ type: 'task.completed', projectId: parent.projectId, taskId: parent.id, runId: null, payload: { runId: '', outcome: 'children_done' } });
    }
  }

  private async block(run: PipelineRun, task: Task, project: Project, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    run.status = 'BLOCKED';
    run.blockedReason = truncate(reason, 2000);
    run.finishedAt = now;

    // Blocker analysis (spec §7): why, what is missing, alternatives, human needed? Best effort only.
    let analysis: string | undefined;
    const outcome = await this.deps.runtime.run({
      definition: AGENT_DEFINITIONS.blocker_analysis,
      input: {
        project: { name: project.name, description: project.description, languages: project.profile.languages },
        task,
        sections: [
          { title: 'Block reason', body: reason },
          { title: 'Stage history', body: Object.entries(run.stageStates).map(([s, st]) => `- ${s}: ${st?.status} ${st?.summary ?? ''}`).join('\n') },
          { title: 'Failures', body: run.checkpoint.failures.map((f) => `- ${f.stage} ${f.fingerprint}: ${f.summary}`).join('\n') || '(none)' },
        ],
        files: [],
      },
      scope: { projectId: project.id, taskId: task.id, runId: run.id },
      complexity: 'simple',
      risk: 'low',
      projectRoleOverrides: project.settings.modelOverrides,
    });
    run.costUsd += outcome.costUsd;
    if (outcome.ok) {
      analysis = `${outcome.output.why}${outcome.output.alternativeApproach ? ` Alternative: ${outcome.output.alternativeApproach}` : ''}${outcome.output.needsHuman ? ' Human decision required.' : ''}`;
      run.checkpoint.notes.push(`blocker analysis: ${truncate(analysis, 1000)}`);
      await this.deps.memories.upsert({
        projectId: project.id,
        scope: 'task',
        taskId: task.id,
        kind: 'blocker',
        key: `task:${task.id}:blocker`,
        content: JSON.stringify(outcome.output),
        tags: ['blocked'],
      });
    }

    await this.deps.tasks.update(task.id, { status: 'BLOCKED', blockedReason: truncate(reason, 2000) });
    await this.deps.events.emit({
      type: 'task.blocked',
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      payload: { reason: truncate(reason, 1000), ...(analysis ? { analysis: truncate(analysis, 1000) } : {}) },
    });
    await this.deps.events.emit({ type: 'project.blocked', projectId: project.id, taskId: task.id, runId: run.id, payload: { reason: truncate(reason, 500) } });
    await this.deps.projects.update(project.id, { status: 'BLOCKED' });
  }

  private async refreshProjectStatus(projectId: string, finishedRunId: string, idleStatus: 'IDLE' | 'DEPLOYED'): Promise<void> {
    const active = (await this.deps.runs.list({ projectId, statuses: SLOT_HOLDING_RUN_STATUSES, limit: 10 })).filter((r) => r.id !== finishedRunId);
    if (active.length === 0) await this.deps.projects.update(projectId, { status: idleStatus });
  }

  private async persist(run: PipelineRun, result: StepResult): Promise<StepResult> {
    const saved = await this.deps.runs.save(run);
    if (result.next === 'continue') await this.enqueueStep(saved);
    else if (result.next === 'wait' && result.resumeAt) await this.enqueueStep(saved, result.resumeAt);
    return result;
  }

  private async audit(action: string, target: string, details: Record<string, unknown>): Promise<void> {
    await this.deps.audit?.({ actorType: 'system', actorId: 'orchestrator', action, target, details });
  }

  private enqueueStep(run: Pick<PipelineRun, 'id' | 'version'>, runAt?: Date): Promise<void> {
    return this.deps.queue.enqueue({
      type: PIPELINE_STEP_JOB,
      payload: { runId: run.id },
      ...(runAt ? { runAt } : {}),
      dedupeKey: `run:${run.id}:${run.version}`,
    });
  }
}
