import { NON_TERMINAL_RUN_STATUSES } from '../domain/enums';
import type { EstimatePoints, NewTaskOptions, Task, TaskInput } from '../domain/task';
import type { Clock, EventRecorder, ProjectRepository, RunRepository, TaskPatch, TaskRepository } from '../ports';
import { truncate } from '../orchestrator/helpers';
import {
  BOARD_COLUMN_LABELS,
  BOARD_COLUMNS,
  columnOf,
  compareBoardOrder,
  isSchedulable,
  planMove,
  planPosition,
  wipState,
  type BoardActor,
  type BoardColumn,
  type MoveErrorCode,
  type WipState,
} from './board';
import type { Lease, LeaseRepository } from './leases';
import {
  MAX_MILESTONES_PER_PROJECT,
  milestoneProgress,
  nextMilestonePosition,
  type Milestone,
  type MilestoneInput,
  type MilestonePatch,
  type MilestoneProgress,
  type MilestoneRepository,
} from './milestones';

// Board use cases (ADR-030 stage 2): card moves, planning fields, holds and milestones. Authorization (RBAC and the
// per-project ACL) is the caller's job; this service enforces the board rules and emits events, which the room
// projection turns into deduplicated notices and the SSE stream delivers live.

export type BoardErrorCode =
  | MoveErrorCode
  | 'task_not_found'
  | 'project_not_found'
  | 'milestone_not_found'
  | 'invalid_assignee'
  | 'milestone_limit'
  | 'invalid_dates'
  | 'hold_not_applicable';

export class BoardError extends Error {
  constructor(
    readonly code: BoardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BoardError';
  }
}

export interface BoardServiceDeps {
  projects: Pick<ProjectRepository, 'get'>;
  tasks: TaskRepository;
  runs: Pick<RunRepository, 'list'>;
  milestones: MilestoneRepository;
  leases: Pick<LeaseRepository, 'listActive'>;
  /** Should be the room-projecting recorder so board changes reach the Project Room. */
  events: EventRecorder;
  clock: Clock;
  /** Cancels a pipeline run (Orchestrator.cancel). */
  cancelRun: (runId: string, reason: string) => Promise<boolean>;
}

/** Upper bound of tasks loaded for one board. */
export const MAX_BOARD_TASKS = 1000;

export interface BoardColumnView {
  id: BoardColumn;
  label: string;
  /** Task ids in board order. */
  taskIds: string[];
  wip: WipState;
}

export interface MilestoneView extends Milestone {
  progress: MilestoneProgress;
}

export interface BoardView {
  columns: BoardColumnView[];
  tasks: Task[];
  milestones: MilestoneView[];
  leases: Lease[];
  maxConcurrentTasks: number;
}

export type CardAssignee = { type: 'orchestrator' } | { type: 'user'; id: string };

export interface CardPatch {
  assignee?: CardAssignee;
  milestoneId?: string | null;
  estimatePoints?: EstimatePoints | null;
  labels?: string[];
  dueDate?: string | null;
}

/** Resolves a user who may own tasks in the project (display name), or null when the user is not assignable. */
export type AssigneeResolver = (userId: string) => Promise<{ name: string } | null>;

export interface MoveResult {
  task: Task;
  from: BoardColumn;
  to: BoardColumn;
  wip: WipState;
  schedulableBefore: boolean;
  schedulableAfter: boolean;
  /** The move made a task schedulable that was not before: the scheduler may start a run on its next tick. */
  mayStartRun: boolean;
  cancelledRuns: number;
}

export class BoardService {
  constructor(private readonly deps: BoardServiceDeps) {}

  private async projectTask(projectId: string, taskId: string): Promise<Task> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.projectId !== projectId) throw new BoardError('task_not_found', 'task not found');
    return task;
  }

  private async projectTasks(projectId: string): Promise<Task[]> {
    return this.deps.tasks.list({ projectId, limit: MAX_BOARD_TASKS });
  }

  async board(projectId: string): Promise<BoardView> {
    const project = await this.deps.projects.get(projectId);
    if (!project) throw new BoardError('project_not_found', 'project not found');
    const now = this.deps.clock.now();
    const [tasks, milestones, leases] = await Promise.all([this.projectTasks(projectId), this.deps.milestones.list(projectId), this.deps.leases.listActive({ projectId }, now)]);
    const grouped = new Map<BoardColumn, Task[]>(BOARD_COLUMNS.map((c) => [c, []]));
    for (const task of tasks) grouped.get(columnOf(task))!.push(task);
    const { maxConcurrentTasks } = project.settings;
    const columns = BOARD_COLUMNS.map((id) => {
      const inColumn = grouped.get(id)!.sort(compareBoardOrder);
      return { id, label: BOARD_COLUMN_LABELS[id], taskIds: inColumn.map((t) => t.id), wip: wipState(id, inColumn.length, maxConcurrentTasks) };
    });
    return { columns, tasks, milestones: this.withProgress(milestones, tasks), leases, maxConcurrentTasks };
  }

  private withProgress(milestones: Milestone[], tasks: Task[]): MilestoneView[] {
    return milestones.map((milestone) => ({ ...milestone, progress: milestoneProgress(tasks.filter((t) => t.milestoneId === milestone.id)) }));
  }

  async move(input: { projectId: string; taskId: string; to: BoardColumn; index?: number; release?: boolean; actor: BoardActor }): Promise<MoveResult> {
    const { projectId, actor } = input;
    const project = await this.deps.projects.get(projectId);
    if (!project) throw new BoardError('project_not_found', 'project not found');
    const task = await this.projectTask(projectId, input.taskId);
    const now = this.deps.clock.now();
    const activeRuns = await this.deps.runs.list({ taskId: task.id, statuses: NON_TERMINAL_RUN_STATUSES, limit: 10 });
    const plan = planMove({ task, to: input.to, actor, hasActiveRun: activeRuns.length > 0, release: input.release ?? false, now });
    if (!plan.ok) throw new BoardError(plan.code, plan.message);

    const all = await this.projectTasks(projectId);
    const column = all.filter((t) => t.id !== task.id && columnOf(t) === plan.to);
    const position = planPosition(column, input.index);
    for (const item of position.renumber) await this.deps.tasks.update(item.id, { boardPosition: item.position });

    let cancelledRuns = 0;
    if (plan.cancelRuns) {
      for (const run of activeRuns) if (await this.deps.cancelRun(run.id, `Cancelled on the board by ${actor.name}`)) cancelledRuns++;
    }
    const patch: TaskPatch = { ...plan.patch, boardPosition: position.position };
    const updated = await this.deps.tasks.update(task.id, patch);

    await this.deps.events.emit({
      type: 'task.moved',
      projectId,
      taskId: task.id,
      runId: null,
      payload: {
        title: truncate(updated.title, 200),
        from: plan.from,
        to: plan.to,
        fromStatus: task.status,
        toStatus: updated.status,
        position: position.position,
        schedulingHold: updated.schedulingHold,
        schedulable: plan.schedulableAfter,
        cancelledRuns,
        by: actor.name,
      },
    });
    const count = column.length + 1;
    return {
      task: updated,
      from: plan.from,
      to: plan.to,
      wip: wipState(plan.to, count, project.settings.maxConcurrentTasks),
      schedulableBefore: plan.schedulableBefore,
      schedulableAfter: plan.schedulableAfter,
      mayStartRun: !plan.schedulableBefore && plan.schedulableAfter,
      cancelledRuns,
    };
  }

  /** Creates a card. Orchestrator cards start on hold unless `release` is set, so adding work never starts a run by itself. */
  async createCard(input: {
    projectId: string;
    task: TaskInput;
    column: 'backlog' | 'ready';
    assignee?: CardAssignee;
    milestoneId?: string | null;
    estimatePoints?: EstimatePoints | null;
    labels?: string[];
    dueDate?: string | null;
    release?: boolean;
    actor: BoardActor;
    resolveAssignee: AssigneeResolver;
  }): Promise<Task> {
    const { projectId, actor } = input;
    const project = await this.deps.projects.get(projectId);
    if (!project) throw new BoardError('project_not_found', 'project not found');
    const assignee = input.assignee ?? { type: 'orchestrator' };
    if (assignee.type === 'user' && !(await input.resolveAssignee(assignee.id))) throw new BoardError('invalid_assignee', 'the user cannot be assigned tasks in this project');
    if (input.release && (assignee.type !== 'orchestrator' || input.column !== 'ready')) {
      throw new BoardError('release_requires_ready', 'only orchestrator cards created in Ready can be released to the scheduler');
    }
    if (input.milestoneId) await this.projectMilestone(projectId, input.milestoneId);
    const column = (await this.projectTasks(projectId)).filter((t) => columnOf(t) === input.column);
    const held = assignee.type === 'orchestrator' && !input.release;
    const options: NewTaskOptions = {
      status: input.column === 'backlog' ? 'BACKLOG' : 'READY',
      assigneeType: assignee.type,
      assigneeId: assignee.type === 'user' ? assignee.id : null,
      milestoneId: input.milestoneId ?? null,
      estimatePoints: input.estimatePoints ?? null,
      labels: input.labels ?? [],
      dueDate: input.dueDate ?? null,
      boardPosition: planPosition(column, undefined).position,
      schedulingHold: held,
      holdReason: held ? `Added on the board by ${actor.name}` : null,
    };
    const task = await this.deps.tasks.create(projectId, input.task, actor.id, options);
    await this.deps.events.emit({ type: 'task.created', projectId, taskId: task.id, runId: null, payload: { title: task.title } });
    return task;
  }

  async updateCard(input: { projectId: string; taskId: string; patch: CardPatch; actor: BoardActor; resolveAssignee: AssigneeResolver }): Promise<Task> {
    const { projectId, patch, actor } = input;
    const task = await this.projectTask(projectId, input.taskId);
    const update: TaskPatch = {};
    const fields: string[] = [];
    let assigneeName: string | null = null;

    const assignee = patch.assignee;
    const assigneeChanged = assignee !== undefined && (assignee.type !== task.assigneeType || (assignee.type === 'user' && assignee.id !== task.assigneeId));
    if (assignee && assigneeChanged) {
      const activeRuns = await this.deps.runs.list({ taskId: task.id, statuses: NON_TERMINAL_RUN_STATUSES, limit: 1 });
      if (activeRuns.length > 0) throw new BoardError('active_run', 'the task has an active pipeline run; cancel it before reassigning');
      const column = columnOf(task);
      if (assignee.type === 'orchestrator') {
        if (column === 'in_progress' || column === 'review' || column === 'done') {
          throw new BoardError('pipeline_controlled', `move the task to Backlog or Ready before assigning it to the orchestrator`);
        }
        update.assigneeType = 'orchestrator';
        update.assigneeId = null;
        // Handing work to the orchestrator never starts a run by itself.
        if (task.status === 'BACKLOG' || task.status === 'READY') {
          update.schedulingHold = true;
          update.holdReason = `Assigned to the orchestrator by ${actor.name}; release it to let the orchestrator start`;
        }
      } else {
        const resolved = await input.resolveAssignee(assignee.id);
        if (!resolved) throw new BoardError('invalid_assignee', 'the user cannot be assigned tasks in this project');
        assigneeName = resolved.name;
        update.assigneeType = 'user';
        update.assigneeId = assignee.id;
      }
    }
    if (patch.milestoneId !== undefined && patch.milestoneId !== task.milestoneId) {
      if (patch.milestoneId !== null) await this.projectMilestone(projectId, patch.milestoneId);
      update.milestoneId = patch.milestoneId;
      fields.push('milestoneId');
    }
    if (patch.estimatePoints !== undefined && patch.estimatePoints !== task.estimatePoints) {
      update.estimatePoints = patch.estimatePoints;
      fields.push('estimatePoints');
    }
    if (patch.labels !== undefined && JSON.stringify(patch.labels) !== JSON.stringify(task.labels)) {
      update.labels = patch.labels;
      fields.push('labels');
    }
    if (patch.dueDate !== undefined && patch.dueDate !== task.dueDate) {
      update.dueDate = patch.dueDate;
      fields.push('dueDate');
    }
    if (Object.keys(update).length === 0) return task;
    const updated = await this.deps.tasks.update(task.id, update);

    if (assigneeChanged) {
      await this.deps.events.emit({
        type: 'task.assigned',
        projectId,
        taskId: task.id,
        runId: null,
        payload: {
          title: truncate(updated.title, 200),
          assigneeType: updated.assigneeType,
          assigneeId: updated.assigneeId,
          assigneeName,
          previousType: task.assigneeType,
          previousId: task.assigneeId,
          schedulingHold: updated.schedulingHold,
          by: actor.name,
        },
      });
    }
    if (fields.length > 0) await this.deps.events.emit({ type: 'task.planning_updated', projectId, taskId: task.id, runId: null, payload: { fields, by: actor.name } });
    return updated;
  }

  /** Puts a task on hold or releases it to the scheduler. Releasing is the only way a held task becomes schedulable. */
  async setHold(input: { projectId: string; taskId: string; hold: boolean; reason?: string | null; actor: BoardActor }): Promise<{ task: Task; changed: boolean; mayStartRun: boolean }> {
    const { projectId, actor } = input;
    const task = await this.projectTask(projectId, input.taskId);
    if (input.hold) {
      if (!['BACKLOG', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)) {
        throw new BoardError('hold_not_applicable', `a ${task.status} task cannot be put on hold; pause or cancel its run instead`);
      }
    } else if (task.assigneeType !== 'orchestrator') {
      throw new BoardError('release_requires_orchestrator', 'only tasks assigned to the orchestrator can be released to the scheduler');
    }
    if (task.schedulingHold === input.hold) return { task, changed: false, mayStartRun: false };
    const reason = input.hold ? truncate(input.reason?.trim() || `Put on hold by ${actor.name}`, 500) : null;
    const updated = await this.deps.tasks.update(task.id, { schedulingHold: input.hold, holdReason: reason });
    await this.deps.events.emit({ type: 'task.hold_changed', projectId, taskId: task.id, runId: null, payload: { title: truncate(updated.title, 200), hold: input.hold, reason, by: actor.name } });
    return { task: updated, changed: true, mayStartRun: !isSchedulable(task) && isSchedulable(updated) };
  }

  // -------------------------------------------------------------------------
  // Milestones
  // -------------------------------------------------------------------------

  private async projectMilestone(projectId: string, milestoneId: string): Promise<Milestone> {
    const milestone = await this.deps.milestones.get(milestoneId);
    if (!milestone || milestone.projectId !== projectId) throw new BoardError('milestone_not_found', 'milestone not found');
    return milestone;
  }

  async milestones(projectId: string): Promise<MilestoneView[]> {
    const [milestones, tasks] = await Promise.all([this.deps.milestones.list(projectId), this.projectTasks(projectId)]);
    return this.withProgress(milestones, tasks);
  }

  async createMilestone(projectId: string, input: MilestoneInput, actor: BoardActor): Promise<Milestone> {
    if (!(await this.deps.projects.get(projectId))) throw new BoardError('project_not_found', 'project not found');
    const existing = await this.deps.milestones.list(projectId);
    if (existing.length >= MAX_MILESTONES_PER_PROJECT) throw new BoardError('milestone_limit', `a project has at most ${MAX_MILESTONES_PER_PROJECT} milestones`);
    const milestone = await this.deps.milestones.create(projectId, { ...input, position: nextMilestonePosition(existing) }, actor.id);
    await this.emitMilestone(milestone, 'created', null, actor);
    return milestone;
  }

  async updateMilestone(projectId: string, milestoneId: string, patch: MilestonePatch, actor: BoardActor): Promise<Milestone> {
    const current = await this.projectMilestone(projectId, milestoneId);
    const startDate = patch.startDate !== undefined ? patch.startDate : current.startDate;
    const dueDate = patch.dueDate !== undefined ? patch.dueDate : current.dueDate;
    if (startDate && dueDate && startDate > dueDate) throw new BoardError('invalid_dates', 'the start date must not be after the due date');
    const updated = await this.deps.milestones.update(milestoneId, patch);
    await this.emitMilestone(updated, 'updated', current.status, actor);
    return updated;
  }

  async deleteMilestone(projectId: string, milestoneId: string, actor: BoardActor): Promise<void> {
    const current = await this.projectMilestone(projectId, milestoneId);
    await this.deps.milestones.delete(milestoneId);
    await this.emitMilestone(current, 'deleted', current.status, actor);
  }

  private emitMilestone(milestone: Milestone, change: 'created' | 'updated' | 'deleted', previousStatus: Milestone['status'] | null, actor: BoardActor) {
    return this.deps.events.emit({
      type: 'milestone.updated',
      projectId: milestone.projectId,
      taskId: null,
      runId: null,
      payload: { milestoneId: milestone.id, title: truncate(milestone.title, 200), change, status: milestone.status, previousStatus, by: actor.name },
    });
  }
}
