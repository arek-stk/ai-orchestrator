import type { BoardAssignee, BoardColumn, Milestone, Task, TaskStatus } from './types';

// Pure board and roadmap helpers for the web UI. The server (packages/core/src/board/board.ts) is authoritative; the
// client mirrors its move rules only to offer the right destinations and to explain refusals up front.

export const COLUMN_LABELS: Readonly<Record<BoardColumn, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const COLUMN_HINTS: Readonly<Record<BoardColumn, string>> = {
  backlog: 'Planned work. Cards here are on hold.',
  ready: 'Queued for work. Held cards wait for a release.',
  in_progress: 'Being worked on by the orchestrator or a person.',
  review: 'Pull request open or waiting for approval.',
  blocked: 'Needs attention: blocked or failed.',
  done: 'Finished.',
  cancelled: 'Stopped. Move a card back to Backlog or Ready to reopen it.',
};

const PIPELINE_COLUMNS: ReadonlySet<BoardColumn> = new Set(['in_progress', 'review', 'done']);

export function columnOf(task: Pick<Task, 'status' | 'prNumber' | 'assigneeType'>): BoardColumn {
  const map: Record<TaskStatus, BoardColumn> = {
    BACKLOG: 'backlog',
    READY: 'ready',
    RUNNING: task.assigneeType === 'orchestrator' && task.prNumber !== null ? 'review' : 'in_progress',
    WAITING_CHILDREN: 'in_progress',
    PAUSED: 'in_progress',
    WAITING_APPROVAL: 'review',
    BLOCKED: 'blocked',
    FAILED: 'blocked',
    DONE: 'done',
    CANCELLED: 'cancelled',
  };
  return map[task.status];
}

export interface Viewer {
  id: string | null;
  admin: boolean;
}

export interface MoveOption {
  to: BoardColumn;
  release: boolean;
}

/** Whether a person may move the card to `to` (mirrors the server rules; the server still decides). */
export function canMoveTo(task: Pick<Task, 'status' | 'prNumber' | 'assigneeType' | 'assigneeId'>, to: BoardColumn, viewer: Viewer): boolean {
  const from = columnOf(task);
  if (from === to) return true;
  if (task.assigneeType !== 'orchestrator') {
    if (!(PIPELINE_COLUMNS.has(from) || PIPELINE_COLUMNS.has(to))) return true;
    return viewer.admin || (task.assigneeType === 'user' && task.assigneeId !== null && task.assigneeId === viewer.id);
  }
  if (to === 'cancelled') return from !== 'done';
  if (PIPELINE_COLUMNS.has(to) || to === 'blocked') return false;
  return !PIPELINE_COLUMNS.has(from);
}

/** Destinations for the "Move to …" menu, including the explicit release for held or reopened orchestrator cards. */
export function moveOptions(task: Pick<Task, 'status' | 'prNumber' | 'assigneeType' | 'assigneeId' | 'schedulingHold'>, viewer: Viewer, columns: readonly BoardColumn[]): MoveOption[] {
  const from = columnOf(task);
  const options: MoveOption[] = [];
  for (const to of columns) {
    if (to === from || !canMoveTo(task, to, viewer)) continue;
    options.push({ to, release: false });
  }
  const releasable = task.assigneeType === 'orchestrator' && (from === 'ready' ? task.schedulingHold : from === 'backlog' || from === 'blocked' || from === 'cancelled');
  if (releasable && columns.includes('ready')) options.push({ to: 'ready', release: true });
  return options;
}

export function moveOptionLabel(option: MoveOption, from: BoardColumn): string {
  if (option.release) return from === 'ready' ? 'Release to the orchestrator' : 'Move to Ready and release';
  return `Move to ${COLUMN_LABELS[option.to]}`;
}

/** Whether the card is waiting for a release before the orchestrator may start it. */
export function isHeld(task: Pick<Task, 'status' | 'assigneeType' | 'schedulingHold'>): boolean {
  return task.assigneeType === 'orchestrator' && task.schedulingHold && (task.status === 'BACKLOG' || task.status === 'READY');
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/**
 * Insertion index for a pointer at `y` over a column whose cards (without the dragged one) have these vertical
 * midpoints, top to bottom.
 */
export function dropIndex(midpoints: readonly number[], y: number): number {
  let index = 0;
  while (index < midpoints.length && y > midpoints[index]!) index++;
  return index;
}

/** Applies a move to the column lists locally (optimistic update); returns new id lists per column. */
export function applyLocalMove(columns: Readonly<Record<BoardColumn, readonly string[]>>, taskId: string, to: BoardColumn, index: number): Record<BoardColumn, string[]> {
  const next = Object.fromEntries(Object.entries(columns).map(([column, ids]) => [column, ids.filter((id) => id !== taskId)])) as Record<BoardColumn, string[]>;
  const target = next[to];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, taskId);
  return next;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface BoardFilters {
  /** Milestone id, `none` for cards without a milestone, or empty for all. */
  milestone: string;
  /** `orchestrator`, a user id, `unassigned-people`… or empty for all. */
  assignee: string;
  label: string;
}

export const EMPTY_FILTERS: BoardFilters = { milestone: '', assignee: '', label: '' };

export function matchesFilters(task: Pick<Task, 'milestoneId' | 'assigneeType' | 'assigneeId' | 'labels'>, filters: BoardFilters): boolean {
  if (filters.milestone === 'none' ? task.milestoneId !== null : filters.milestone && task.milestoneId !== filters.milestone) return false;
  if (filters.assignee === 'orchestrator' ? task.assigneeType !== 'orchestrator' : filters.assignee && task.assigneeId !== filters.assignee) return false;
  if (filters.label && !task.labels.some((label) => label.toLowerCase() === filters.label.toLowerCase())) return false;
  return true;
}

export function allLabels(tasks: ReadonlyArray<Pick<Task, 'labels'>>): string[] {
  const byKey = new Map<string, string>();
  for (const task of tasks) for (const label of task.labels) if (!byKey.has(label.toLowerCase())) byKey.set(label.toLowerCase(), label);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** Comma-separated input to a label list (trimmed, deduplicated case-insensitively, at most 10). */
export function parseLabels(input: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of input.split(',')) {
    const label = raw.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
  }
  return labels.slice(0, 10);
}

export function assigneeName(task: Pick<Task, 'assigneeType' | 'assigneeId'>, assignees: readonly BoardAssignee[]): string {
  if (task.assigneeType === 'orchestrator') return 'Orchestrator';
  const person = assignees.find((a) => a.id === task.assigneeId);
  return person?.login ?? (task.assigneeType === 'external_ai' ? 'External AI' : 'Former member');
}

export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

// ---------------------------------------------------------------------------
// Dates and roadmap
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` to UTC midnight (ms); null when invalid. */
export function parseDay(value: string | null | undefined): number | null {
  if (!value || value.length !== 10) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : null;
}

export function formatDay(value: string | null | undefined, withYear = false): string {
  const time = parseDay(value);
  if (time === null) return '';
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function todayDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface RoadmapRow {
  milestone: Milestone;
  /** Left edge and width in percent of the timeline. */
  left: number;
  width: number;
  /** Only a due date: rendered as a marker at `left`. */
  marker: boolean;
  overdue: boolean;
  /** Human-readable date range for screen readers and small screens. */
  range: string;
}

export interface RoadmapLayout {
  start: number;
  end: number;
  months: Array<{ label: string; left: number }>;
  today: number | null;
  rows: RoadmapRow[];
  unscheduled: Milestone[];
}

/** Places dated milestones on a month-aligned timeline that always includes today. */
export function roadmapLayout(milestones: readonly Milestone[], now: number = Date.now()): RoadmapLayout {
  const today = parseDay(todayDay(now))!;
  const dated = milestones.filter((m) => parseDay(m.startDate) !== null || parseDay(m.dueDate) !== null);
  const unscheduled = milestones.filter((m) => !dated.includes(m));
  const points = [today, ...dated.flatMap((m) => [parseDay(m.startDate), parseDay(m.dueDate)]).filter((t): t is number => t !== null)];
  const min = new Date(Math.min(...points));
  const max = new Date(Math.max(...points));
  const start = Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1);
  const end = Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 1);
  const span = Math.max(end - start, DAY_MS);
  const pct = (time: number) => ((time - start) / span) * 100;

  const months: RoadmapLayout['months'] = [];
  for (let cursor = new Date(start); cursor.getTime() < end; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const label = cursor.toLocaleDateString('en-US', { month: 'short', ...(cursor.getUTCMonth() === 0 || months.length === 0 ? { year: 'numeric' } : {}), timeZone: 'UTC' });
    months.push({ label, left: pct(cursor.getTime()) });
  }

  const rows = dated.map((milestone): RoadmapRow => {
    const from = parseDay(milestone.startDate);
    const due = parseDay(milestone.dueDate);
    const marker = from === null;
    const left = pct(from ?? due!);
    // A milestone with only a start date runs to the end of its month.
    const until = due ?? Date.UTC(new Date(from!).getUTCFullYear(), new Date(from!).getUTCMonth() + 1, 1);
    const width = marker ? 0 : Math.max(pct(until + DAY_MS) - left, 0.8);
    const overdue = due !== null && due < today && milestone.status !== 'done';
    const range = from !== null && due !== null ? `${formatDay(milestone.startDate)} – ${formatDay(milestone.dueDate, true)}` : from !== null ? `from ${formatDay(milestone.startDate, true)}` : `due ${formatDay(milestone.dueDate, true)}`;
    return { milestone, left, width, marker, overdue, range };
  });
  return { start, end, months, today: pct(today), rows, unscheduled };
}

/**
 * Maps a drop position among the visible (filtered) cards of a column to the index in the full column, both without
 * the moved card: the card lands directly before the visible card it was dropped on, or after the last visible card.
 */
export function fullColumnIndex(fullIds: readonly string[], visibleIds: readonly string[], visibleIndex: number, movedId: string): number {
  const full = fullIds.filter((id) => id !== movedId);
  const visible = visibleIds.filter((id) => id !== movedId);
  if (visible.length === 0) return full.length;
  if (visibleIndex < visible.length) return Math.max(0, full.indexOf(visible[visibleIndex]!));
  return full.indexOf(visible[visible.length - 1]!) + 1;
}
