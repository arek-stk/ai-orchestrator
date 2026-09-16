import type { ProjectStatus, Risk, TaskStatus } from '../domain/enums';
import { dependencyState } from '../dag/dag';

export interface SchedulableProject {
  id: string;
  priority: number;
  status: ProjectStatus;
  maxConcurrentTasks: number;
  budgetUsd: number;
  spentUsd: number;
  lastScheduledAt: Date | null;
}

export interface SchedulableTask {
  id: string;
  projectId: string;
  priority: number;
  status: TaskStatus;
  dependencies: readonly string[];
  risk: Risk;
  readySince: Date | null;
  createdAt: Date;
  /** Held tasks are never selected (ADR-030 board rule, planning assistant). Absent = not held. */
  schedulingHold?: boolean;
  /** Only orchestrator-owned tasks are selected. Absent = orchestrator. */
  assigneeType?: 'orchestrator' | 'user' | 'external_ai';
}

export interface SchedulerWeights {
  projectPriority: number;
  taskPriority: number;
  agingPerMinute: number;
  agingCap: number;
  starvationPerMinute: number;
  starvationCap: number;
  risk: Record<Risk, number>;
  costPressure: number;
  /** Subtracted per task already picked for the same project in this tick (round-robin effect). */
  sameProjectPenalty: number;
}

export const DEFAULT_SCHEDULER_WEIGHTS: Readonly<SchedulerWeights> = Object.freeze({
  projectPriority: 10,
  taskPriority: 4,
  agingPerMinute: 0.5,
  agingCap: 60,
  starvationPerMinute: 0.25,
  starvationCap: 40,
  risk: { low: 1, medium: 0, high: -2 },
  costPressure: 20,
  sameProjectPenalty: 15,
});

export interface SchedulerInput {
  now: Date;
  projects: readonly SchedulableProject[];
  /** Candidate tasks (any status; only BACKLOG/READY are schedulable). */
  tasks: readonly SchedulableTask[];
  /** Status of every task that may appear as a dependency (including finished ones). */
  taskStatuses: ReadonlyMap<string, TaskStatus>;
  runningTasksByProject: ReadonlyMap<string, number>;
  globalCapacity: number;
  globalRunning: number;
  globalBudgetExhausted: boolean;
  /** Tasks with an active task lease of a person or external AI (ADR-030). */
  leasedTaskIds?: ReadonlySet<string>;
  weights?: Partial<SchedulerWeights>;
}

export interface ScoreBreakdown {
  project: number;
  task: number;
  aging: number;
  starvation: number;
  risk: number;
  costPressure: number;
  total: number;
}

export interface ScheduledTask {
  taskId: string;
  projectId: string;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface SkippedTask {
  taskId: string;
  projectId: string;
  reason: string;
}

export interface ScheduleResult {
  selected: ScheduledTask[];
  skipped: SkippedTask[];
}

const SCHEDULABLE: ReadonlySet<TaskStatus> = new Set(['BACKLOG', 'READY']);

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 60_000);
}

export function scoreTask(
  task: SchedulableTask,
  project: SchedulableProject,
  now: Date,
  weights: SchedulerWeights = DEFAULT_SCHEDULER_WEIGHTS,
): ScoreBreakdown {
  const projectScore = project.priority * weights.projectPriority;
  const taskScore = task.priority * weights.taskPriority;
  const aging = Math.min(weights.agingCap, minutesBetween(task.readySince ?? task.createdAt, now) * weights.agingPerMinute);
  const starvation =
    project.lastScheduledAt === null
      ? weights.starvationCap
      : Math.min(weights.starvationCap, minutesBetween(project.lastScheduledAt, now) * weights.starvationPerMinute);
  const risk = weights.risk[task.risk];
  const spentRatio = project.budgetUsd > 0 ? Math.min(1, project.spentUsd / project.budgetUsd) : 0;
  const costPressure = -spentRatio * weights.costPressure;
  const total = projectScore + taskScore + aging + starvation + risk + costPressure;
  return { project: projectScore, task: taskScore, aging, starvation, risk, costPressure, total };
}

interface Candidate extends ScheduledTask {
  createdAt: Date;
}

/**
 * Picks the next tasks to start. Priority-driven, but aging and starvation bonuses guarantee that
 * low-priority projects are eventually served, and a same-project penalty spreads capacity.
 */
export function schedule(input: SchedulerInput): ScheduleResult {
  const weights: SchedulerWeights = { ...DEFAULT_SCHEDULER_WEIGHTS, ...input.weights };
  const projects = new Map(input.projects.map((p) => [p.id, p]));
  const statusById = new Map(input.taskStatuses);
  for (const task of input.tasks) if (!statusById.has(task.id)) statusById.set(task.id, task.status);

  const candidates: Candidate[] = [];
  const skipped: SkippedTask[] = [];
  const skip = (task: SchedulableTask, reason: string) =>
    skipped.push({ taskId: task.id, projectId: task.projectId, reason });

  for (const task of input.tasks) {
    if (!SCHEDULABLE.has(task.status)) continue;
    if (task.schedulingHold) {
      skip(task, 'scheduling_hold');
      continue;
    }
    if (task.assigneeType !== undefined && task.assigneeType !== 'orchestrator') {
      skip(task, `assigned_to_${task.assigneeType}`);
      continue;
    }
    if (input.leasedTaskIds?.has(task.id)) {
      skip(task, 'task_leased');
      continue;
    }
    const project = projects.get(task.projectId);
    if (!project) {
      skip(task, 'project_not_found');
      continue;
    }
    if (input.globalBudgetExhausted) {
      skip(task, 'global_budget_exhausted');
      continue;
    }
    if (project.status === 'PAUSED') {
      skip(task, 'project_paused');
      continue;
    }
    if (project.budgetUsd > 0 && project.spentUsd >= project.budgetUsd) {
      skip(task, 'project_budget_exhausted');
      continue;
    }
    const deps = dependencyState(task.dependencies, statusById);
    if (deps.failed.length > 0) {
      skip(task, `dependency_failed:${deps.failed.join(',')}`);
      continue;
    }
    if (deps.missing.length > 0) {
      skip(task, `dependency_missing:${deps.missing.join(',')}`);
      continue;
    }
    if (deps.waitingOn.length > 0) {
      skip(task, `waiting_on_dependencies:${deps.waitingOn.join(',')}`);
      continue;
    }
    const breakdown = scoreTask(task, project, input.now, weights);
    candidates.push({
      taskId: task.id,
      projectId: task.projectId,
      score: breakdown.total,
      breakdown,
      createdAt: task.createdAt,
    });
  }

  let globalFree = Math.max(0, input.globalCapacity - input.globalRunning);
  const running = new Map(input.runningTasksByProject);
  const picks = new Map<string, number>();
  const selected: ScheduledTask[] = [];
  const remaining = [...candidates];

  while (globalFree > 0 && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const project = projects.get(candidate.projectId)!;
      if ((running.get(candidate.projectId) ?? 0) >= project.maxConcurrentTasks) continue;
      const effective = candidate.score - (picks.get(candidate.projectId) ?? 0) * weights.sameProjectPenalty;
      const best = bestIndex >= 0 ? remaining[bestIndex]! : undefined;
      const better =
        effective > bestScore ||
        (effective === bestScore &&
          best !== undefined &&
          (candidate.createdAt.getTime() < best.createdAt.getTime() ||
            (candidate.createdAt.getTime() === best.createdAt.getTime() && candidate.taskId < best.taskId)));
      if (better) {
        bestIndex = i;
        bestScore = effective;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    const { createdAt: _createdAt, ...scheduled } = chosen!;
    selected.push({ ...scheduled, score: bestScore });
    running.set(scheduled.projectId, (running.get(scheduled.projectId) ?? 0) + 1);
    picks.set(scheduled.projectId, (picks.get(scheduled.projectId) ?? 0) + 1);
    globalFree--;
  }

  for (const candidate of remaining) {
    const project = projects.get(candidate.projectId)!;
    const reason =
      (running.get(candidate.projectId) ?? 0) >= project.maxConcurrentTasks
        ? 'project_concurrency_limit'
        : 'global_capacity_reached';
    skipped.push({ taskId: candidate.taskId, projectId: candidate.projectId, reason });
  }

  return { selected, skipped };
}
