import type { TaskStatus } from '../domain/enums';
import type { AssigneeType, Task } from '../domain/task';
import type { TaskPatch } from '../ports';

// Kanban board rules (ADR-030 stage 2). The board is a view over tasks: a column is derived from the task status, and
// a move is translated into a status/hold patch. Pure and IO-free; the BoardService applies the result.

export const BOARD_COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABELS: Readonly<Record<BoardColumn, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Statuses the scheduler considers (the orchestrator starts runs only for these). */
export const SCHEDULABLE_TASK_STATUSES: readonly TaskStatus[] = ['BACKLOG', 'READY'];

/** Columns a human may move orchestrator-owned tasks into; the pipeline moves them through the others. */
export const HUMAN_COLUMNS_FOR_ORCHESTRATOR_TASKS: readonly BoardColumn[] = ['backlog', 'ready', 'cancelled'];

/** Columns whose tasks are owned by the pipeline while the orchestrator is the assignee. */
const PIPELINE_COLUMNS: ReadonlySet<BoardColumn> = new Set(['in_progress', 'review', 'done']);

/** Status a column stands for when a person or an external AI owns the task (no pipeline run involved). */
const ASSIGNEE_STATUS: Readonly<Record<BoardColumn, TaskStatus>> = {
  backlog: 'BACKLOG',
  ready: 'READY',
  in_progress: 'RUNNING',
  review: 'WAITING_APPROVAL',
  blocked: 'BLOCKED',
  done: 'DONE',
  cancelled: 'CANCELLED',
};

export type BoardTask = Pick<Task, 'status' | 'prNumber' | 'assigneeType' | 'assigneeId' | 'schedulingHold'>;

/** The column a task appears in. An orchestrator task with an open pull request is in review while CI runs. */
export function columnOf(task: Pick<Task, 'status' | 'prNumber' | 'assigneeType'>): BoardColumn {
  switch (task.status) {
    case 'BACKLOG':
      return 'backlog';
    case 'READY':
      return 'ready';
    case 'RUNNING':
      return task.assigneeType === 'orchestrator' && task.prNumber !== null ? 'review' : 'in_progress';
    case 'WAITING_CHILDREN':
    case 'PAUSED':
      return 'in_progress';
    case 'WAITING_APPROVAL':
      return 'review';
    case 'BLOCKED':
    case 'FAILED':
      return 'blocked';
    case 'DONE':
      return 'done';
    case 'CANCELLED':
      return 'cancelled';
  }
}

/** Whether the scheduler may pick the task (status, owner and hold; dependencies and leases are checked separately). */
export function isSchedulable(task: Pick<Task, 'status' | 'assigneeType' | 'schedulingHold'>): boolean {
  return SCHEDULABLE_TASK_STATUSES.includes(task.status) && task.assigneeType === 'orchestrator' && !task.schedulingHold;
}

export interface BoardActor {
  /** User id. */
  id: string;
  /** Display name used in room notices and hold reasons. */
  name: string;
  /** Global admin or owner: may move tasks of other assignees through their columns. */
  admin: boolean;
}

export type MoveErrorCode = 'pipeline_controlled' | 'active_run' | 'not_assignee' | 'release_requires_ready' | 'release_requires_orchestrator';

export interface MoveRequest {
  task: BoardTask;
  to: BoardColumn;
  actor: BoardActor;
  /** The task has a non-terminal pipeline run (queued, running, waiting, paused or parked). */
  hasActiveRun: boolean;
  /** Explicitly let the scheduler pick the task (clears the hold). Only for orchestrator tasks moved to Ready. */
  release?: boolean;
  now: Date;
}

export type MovePlan =
  | {
      ok: true;
      from: BoardColumn;
      to: BoardColumn;
      /** Status, hold and bookkeeping changes; empty for a reorder within a column. */
      patch: TaskPatch;
      /** Active runs must be cancelled (a running orchestrator task moved to Cancelled). */
      cancelRuns: boolean;
      schedulableBefore: boolean;
      schedulableAfter: boolean;
    }
  | { ok: false; code: MoveErrorCode; message: string };

const deny = (code: MoveErrorCode, message: string): MovePlan => ({ ok: false, code, message });

/**
 * Plans a card move. Rules:
 * * Orchestrator tasks: people move them between Backlog, Ready and Cancelled, retry blocked ones and reopen cancelled
 *   ones; In progress, Review and Done belong to the pipeline. Cancelling a task with an active run cancels the run.
 * * Tasks of people or external AIs: the assignee (or an admin) moves them through every column; nobody else may move
 *   them into or out of In progress, Review and Done.
 * * Hold (no accidental runs): moving a card to Backlog puts it on hold. Moving it to Ready keeps the hold it had; a
 *   card that was not schedulable before (blocked, cancelled) arrives on hold. Only `release: true` clears the hold.
 */
export function planMove(request: MoveRequest): MovePlan {
  const { task, to, actor, hasActiveRun, release = false } = request;
  const from = columnOf({ ...task, assigneeType: task.assigneeType });
  const orchestratorOwned = task.assigneeType === 'orchestrator';
  const schedulableBefore = isSchedulable(task);

  if (release && to !== 'ready') return deny('release_requires_ready', 'only a move to Ready can release a task to the scheduler');
  if (release && !orchestratorOwned) return deny('release_requires_orchestrator', 'only tasks assigned to the orchestrator can be released to the scheduler');

  const result = (patch: TaskPatch, cancelRuns = false): MovePlan => {
    const next = { status: patch.status ?? task.status, assigneeType: task.assigneeType, schedulingHold: patch.schedulingHold ?? task.schedulingHold };
    return { ok: true, from, to, patch, cancelRuns, schedulableBefore, schedulableAfter: isSchedulable(next) };
  };

  if (!orchestratorOwned) {
    if (hasActiveRun) return deny('active_run', 'the task still has an active pipeline run; cancel it first');
    const touchesAssigneeColumns = PIPELINE_COLUMNS.has(from) || PIPELINE_COLUMNS.has(to);
    if (from !== to && touchesAssigneeColumns && !actor.admin && !(task.assigneeType === 'user' && task.assigneeId === actor.id)) {
      return deny('not_assignee', 'only the assignee or an admin moves this task into or out of In progress, Review and Done');
    }
    if (from === to) return result({});
    const status = ASSIGNEE_STATUS[to];
    return result({
      status,
      ...(to === 'ready' ? { readySince: request.now } : {}),
      ...(from === 'blocked' ? { blockedReason: null } : {}),
    });
  }

  // Orchestrator-owned tasks.
  if (from === to) {
    // Reordering never changes the status; releasing a held Ready card in place is allowed.
    return result(release && task.schedulingHold ? { schedulingHold: false, holdReason: null } : {});
  }
  if (to === 'cancelled') {
    if (from === 'done') return deny('pipeline_controlled', 'finished tasks cannot be cancelled');
    return result({ status: 'CANCELLED' }, hasActiveRun);
  }
  if (PIPELINE_COLUMNS.has(to) || to === 'blocked') {
    return deny('pipeline_controlled', `the orchestrator moves its tasks to ${BOARD_COLUMN_LABELS[to]}; assign the task to a person to move it manually`);
  }
  // to is backlog or ready
  if (PIPELINE_COLUMNS.has(from)) return deny('pipeline_controlled', `the task is ${BOARD_COLUMN_LABELS[from]}; the pipeline moves it on (cancel it to stop the run)`);
  if (hasActiveRun) return deny('active_run', 'the task still has an active pipeline run; cancel it first');

  const status: TaskStatus = to === 'backlog' ? 'BACKLOG' : 'READY';
  const reopened = from === 'blocked' || from === 'cancelled';
  const patch: TaskPatch = { status, ...(reopened ? { blockedReason: null } : {}), ...(to === 'ready' ? { readySince: request.now } : {}) };
  if (to === 'backlog') {
    patch.schedulingHold = true;
    patch.holdReason = `Moved to Backlog by ${actor.name}`;
  } else if (release) {
    patch.schedulingHold = false;
    patch.holdReason = null;
  } else if (reopened && !task.schedulingHold) {
    // A blocked or cancelled task was not going to run; moving it to Ready must not start a run by itself.
    patch.schedulingHold = true;
    patch.holdReason = `Moved to Ready by ${actor.name}; release it to let the orchestrator start`;
  }
  return result(patch);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export const POSITION_STEP = 1000;
/** Below this gap between neighbours the column is renumbered. */
export const MIN_POSITION_GAP = 1e-6;

export type OrderableTask = Pick<Task, 'id' | 'boardPosition' | 'priority' | 'createdAt'>;

/** Column order: explicit positions first (ascending), then priority (descending) and age. */
export function compareBoardOrder(a: OrderableTask, b: OrderableTask): number {
  if (a.boardPosition !== null && b.boardPosition !== null && a.boardPosition !== b.boardPosition) return a.boardPosition - b.boardPosition;
  if (a.boardPosition !== null && b.boardPosition === null) return -1;
  if (a.boardPosition === null && b.boardPosition !== null) return 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const age = a.createdAt.getTime() - b.createdAt.getTime();
  return age !== 0 ? age : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface PositionPlan {
  /** Position of the moved task. */
  position: number;
  /** Other tasks of the column that need a new position (renumbering); empty in the common case. */
  renumber: Array<{ id: string; position: number }>;
}

/**
 * Position for a task inserted at `index` into `column` (the column's tasks without the moved one, in board order).
 * Uses the midpoint between neighbours; renumbers the column when a neighbour has no position or the gap is exhausted.
 */
export function planPosition(column: readonly OrderableTask[], index: number | undefined): PositionPlan {
  const ordered = [...column].sort(compareBoardOrder);
  const at = index === undefined ? ordered.length : Math.max(0, Math.min(Math.trunc(index), ordered.length));
  const before = at > 0 ? ordered[at - 1]! : null;
  const after = at < ordered.length ? ordered[at]! : null;
  const unpositioned = (before !== null && before.boardPosition === null) || (after !== null && after.boardPosition === null);
  if (!unpositioned) {
    const low = before?.boardPosition ?? null;
    const high = after?.boardPosition ?? null;
    if (low === null && high === null) return { position: POSITION_STEP, renumber: [] };
    if (low === null) return { position: high! - POSITION_STEP, renumber: [] };
    if (high === null) return { position: low + POSITION_STEP, renumber: [] };
    if (high - low > MIN_POSITION_GAP * 2) return { position: low + (high - low) / 2, renumber: [] };
  }
  const renumber: Array<{ id: string; position: number }> = [];
  let position = 0;
  let slot = 1;
  for (let i = 0; i <= ordered.length; i++) {
    if (i === at) position = slot++ * POSITION_STEP;
    const task = ordered[i];
    if (!task) continue;
    const next = slot++ * POSITION_STEP;
    if (task.boardPosition !== next) renumber.push({ id: task.id, position: next });
  }
  return { position, renumber };
}

// ---------------------------------------------------------------------------
// Work in progress
// ---------------------------------------------------------------------------

export interface WipState {
  count: number;
  /** null: no limit for this column. */
  limit: number | null;
  atLimit: boolean;
  exceeded: boolean;
}

/** WIP indication. In progress is limited by the project's `maxConcurrentTasks` (ADR-030); other columns are unlimited. */
export function wipState(column: BoardColumn, count: number, maxConcurrentTasks: number): WipState {
  const limit = column === 'in_progress' ? Math.max(1, maxConcurrentTasks) : null;
  return { count, limit, atLimit: limit !== null && count >= limit, exceeded: limit !== null && count > limit };
}

/** Assignee types the board accepts today; external AI identities arrive with the MCP server (stage 3). */
export const ASSIGNABLE_TYPES: readonly AssigneeType[] = ['orchestrator', 'user'];
