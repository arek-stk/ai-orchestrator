'use client';

import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  CalendarClock,
  CirclePause,
  EllipsisVertical,
  Flag,
  SquareKanban,
  Lock,
  LockOpen,
  Pencil,
  Play,
  Plus,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useApi } from '@/hooks/use-api';
import { api, errorMessage } from '@/lib/api';
import {
  allLabels,
  applyLocalMove,
  assigneeName,
  canMoveTo,
  COLUMN_HINTS,
  COLUMN_LABELS,
  columnOf,
  dropIndex,
  EMPTY_FILTERS,
  formatDay,
  fullColumnIndex,
  initials,
  isHeld,
  matchesFilters,
  moveOptionLabel,
  moveOptions,
  parseDay,
  parseLabels,
  todayDay,
  type BoardFilters,
  type Viewer,
} from '@/lib/board';
import { formatUsd, humanize } from '@/lib/format';
import {
  BOARD_COLUMNS,
  ESTIMATE_POINTS,
  TASK_KINDS,
  type BoardColumn,
  type BoardResponse,
  type EstimatePoints,
  type Lease,
  type MoveResponse,
  type Task,
  type TaskKind,
} from '@/lib/types';
import { MenuButton, Modal, type MenuAction } from './overlay';
import { hasRole, useSession } from './providers';
import { Button, Chip, cx, EmptyState, ErrorBanner, Field, inputClass, Loading, OrchestratorMark, Refreshable, textareaClass, Toggle } from './ui';

// Kanban board (ADR-030 stage 2). A view over tasks: columns come from task status. Cards move by native HTML5 drag and
// drop or through each card's "Move to …" menu (keyboard and touch). Moves never start work by themselves: a card only
// becomes schedulable through an explicit, confirmed release. The server is authoritative and answers every move.

type ColumnIds = Record<BoardColumn, string[]>;

const LIVE_PREFIXES = ['task.', 'milestone.', 'lease.', 'pipeline.', 'approval.', 'github.pr.'];
const PIPELINE_OWNED: ReadonlySet<BoardColumn> = new Set(['in_progress', 'review']);

function columnIdsOf(data: BoardResponse): ColumnIds {
  return Object.fromEntries(data.columns.map((c) => [c.id, c.taskIds])) as ColumnIds;
}

export function BoardTab({ projectId }: { projectId: string }) {
  const { user } = useSession();
  const canOperate = hasRole(user, 'operator');
  const viewer: Viewer = useMemo(() => ({ id: user?.id ?? null, admin: hasRole(user, 'admin') }), [user]);
  const path = `/api/projects/${encodeURIComponent(projectId)}/board`;
  const board = useApi<BoardResponse>(path, { live: (event) => event.projectId === projectId && LIVE_PREFIXES.some((prefix) => event.type.startsWith(prefix)) });

  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [showCancelled, setShowCancelled] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<ColumnIds | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ column: BoardColumn; index: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState<Task | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Task | null>(null);
  const [claimingPaths, setClaimingPaths] = useState(false);
  /** Card whose menu button gets focus back after a keyboard move re-rendered it in another column. */
  const [focusCard, setFocusCard] = useState<string | null>(null);

  const data = board.data;
  const tasksById = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const columnIds = optimistic ?? (data ? columnIdsOf(data) : null);
  const milestoneTitles = useMemo(() => new Map((data?.milestones ?? []).map((m) => [m.id, m.title])), [data]);
  const taskLeases = useMemo(() => new Map((data?.leases ?? []).filter((l) => l.scope === 'task' && l.taskId).map((l) => [l.taskId!, l])), [data]);
  const labels = useMemo(() => allLabels(data?.tasks ?? []), [data]);
  const visibleColumns = BOARD_COLUMNS.filter((c) => c !== 'cancelled' || showCancelled);
  const filtered = filters.milestone !== '' || filters.assignee !== '' || filters.label !== '';

  useEffect(() => {
    if (!focusCard || pending) return;
    const button = document.querySelector<HTMLButtonElement>(`[data-card-id="${CSS.escape(focusCard)}"] button[aria-haspopup="menu"]`);
    button?.focus({ preventScroll: false });
    setFocusCard(null);
  }, [focusCard, pending, board.data]);

  const reload = board.reload;
  const mutate = useCallback(
    async (key: string, fn: () => Promise<string | null>) => {
      setPending(key);
      setError(null);
      try {
        const message = await fn();
        if (message) setAnnouncement(message);
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        setAnnouncement(`Not changed: ${message}`);
      } finally {
        await reload();
        setOptimistic(null);
        setPending(null);
      }
    },
    [reload],
  );

  if (!data || !columnIds) {
    return (
      <>
        <ErrorBanner error={board.error} onRetry={() => void board.reload()} />
        {board.error ? null : <Loading label="Loading board" />}
      </>
    );
  }

  const visibleIds = (column: BoardColumn) => columnIds[column].filter((id) => {
    const task = tasksById.get(id);
    return task !== undefined && matchesFilters(task, filters);
  });

  const move = (task: Task, to: BoardColumn, index: number | undefined, release = false) => {
    const from = columnOf(task);
    const target = columnIds[to].filter((id) => id !== task.id);
    const at = index ?? target.length;
    setOptimistic(applyLocalMove(columnIds, task.id, to, at));
    void mutate(task.id, async () => {
      const result = await api<MoveResponse>(`/api/projects/${encodeURIComponent(projectId)}/board/cards/${encodeURIComponent(task.id)}/move`, {
        method: 'POST',
        body: { to, release, ...(index !== undefined ? { index } : {}) },
      });
      const position = `position ${Math.min(at, target.length) + 1} of ${target.length + 1}`;
      const parts = [from === to ? `Moved “${task.title}” to ${position} in ${COLUMN_LABELS[to]}.` : `Moved “${task.title}” from ${COLUMN_LABELS[from]} to ${COLUMN_LABELS[to]}, ${position}.`];
      if (result.mayStartRun) parts.push('Released: the orchestrator may start it on its next scheduler tick.');
      else if (isHeld(result.task)) parts.push('It stays on hold until someone releases it.');
      if (result.cancelledRuns > 0) parts.push(`${result.cancelledRuns} pipeline run(s) cancelled.`);
      if (result.wip.exceeded) parts.push(`${COLUMN_LABELS[to]} is over its WIP limit (${result.wip.count} of ${result.wip.limit}).`);
      return parts.join(' ');
    });
  };

  const requestMove = (task: Task, to: BoardColumn, index: number | undefined) => {
    const from = columnOf(task);
    if (to === 'cancelled' && task.assigneeType === 'orchestrator' && PIPELINE_OWNED.has(from)) {
      setConfirmCancel(task);
      return;
    }
    move(task, to, index);
  };

  const release = (task: Task) =>
    void mutate(task.id, async () => {
      if (columnOf(task) === 'ready') {
        await api(`/api/tasks/${encodeURIComponent(task.id)}/release`, { method: 'POST', body: {} });
        return `Released “${task.title}”: the orchestrator may start it on its next scheduler tick.`;
      }
      setOptimistic(applyLocalMove(columnIds, task.id, 'ready', columnIds.ready.length));
      await api(`/api/projects/${encodeURIComponent(projectId)}/board/cards/${encodeURIComponent(task.id)}/move`, { method: 'POST', body: { to: 'ready', release: true } });
      return `Moved “${task.title}” to Ready and released it: the orchestrator may start it on its next scheduler tick.`;
    });

  const hold = (task: Task) =>
    void mutate(task.id, async () => {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/hold`, { method: 'POST', body: {} });
      return `“${task.title}” is on hold. The orchestrator will not start it until someone releases it.`;
    });

  const claim = (task: Task, lease: Lease | undefined) =>
    void mutate(task.id, async () => {
      if (lease) {
        const result = await api<{ broken: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/leases/${encodeURIComponent(lease.id)}/release`, { method: 'POST', body: {} });
        return result.broken ? `Broke ${lease.holderName}'s claim on “${task.title}”.` : `Released your claim on “${task.title}”.`;
      }
      await api(`/api/projects/${encodeURIComponent(projectId)}/leases`, { method: 'POST', body: { scope: 'task', taskId: task.id } });
      return `You claimed “${task.title}” for 30 minutes. The orchestrator will not start it while the claim lasts.`;
    });

  // ---------------------------------------------------------------------------
  // Native drag and drop
  // ---------------------------------------------------------------------------

  const draggedTask = dragging ? tasksById.get(dragging) : undefined;

  const locate = (event: DragEvent<HTMLElement>, column: BoardColumn) => {
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')].filter((el) => el.dataset.cardId !== dragging);
    const midpoints = cards.map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const visibleIndex = dropIndex(midpoints, event.clientY);
    return { visibleIndex, index: fullColumnIndex(columnIds[column], visibleIds(column), visibleIndex, dragging ?? '') };
  };

  const onDragOver = (event: DragEvent<HTMLElement>, column: BoardColumn) => {
    if (!draggedTask || !canMoveTo(draggedTask, column, viewer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const { visibleIndex } = locate(event, column);
    if (dropTarget?.column !== column || dropTarget.index !== visibleIndex) setDropTarget({ column, index: visibleIndex });
  };

  const onDrop = (event: DragEvent<HTMLElement>, column: BoardColumn) => {
    if (!draggedTask || !canMoveTo(draggedTask, column, viewer)) return;
    event.preventDefault();
    const { index } = locate(event, column);
    const current = columnIds[column].indexOf(draggedTask.id);
    setDragging(null);
    setDropTarget(null);
    if (columnOf(draggedTask) === column && current === index) return;
    requestMove(draggedTask, column, index);
  };

  const cardActions = (task: Task): MenuAction[] => {
    if (!canOperate) return [];
    const from = columnOf(task);
    const actions: MenuAction[] = [];
    for (const option of moveOptions(task, viewer, BOARD_COLUMNS)) {
      actions.push({
        key: `${option.to}:${option.release}`,
        label: moveOptionLabel(option, from),
        icon: option.release ? Play : option.to === 'cancelled' ? Ban : undefined,
        danger: option.to === 'cancelled',
        onSelect: () => {
          if (option.release) {
            setConfirmRelease(task);
            return;
          }
          setFocusCard(task.id);
          requestMove(task, option.to, undefined);
        },
      });
    }
    const ids = columnIds[from];
    const position = ids.indexOf(task.id);
    if (position > 0) {
      actions.push({ key: 'top', label: 'Move to top', icon: ArrowUpToLine, onSelect: () => (setFocusCard(task.id), move(task, from, 0)) });
      actions.push({ key: 'up', label: 'Move up', icon: ArrowUp, onSelect: () => (setFocusCard(task.id), move(task, from, position - 1)) });
    }
    if (position >= 0 && position < ids.length - 1) actions.push({ key: 'down', label: 'Move down', icon: ArrowDown, onSelect: () => (setFocusCard(task.id), move(task, from, position + 1)) });
    if (task.assigneeType === 'orchestrator' && !task.schedulingHold && ['BACKLOG', 'READY', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      actions.push({ key: 'hold', label: 'Put on hold', icon: CirclePause, onSelect: () => hold(task) });
    }
    const lease = taskLeases.get(task.id);
    if (!lease) actions.push({ key: 'claim', label: 'Claim for 30 minutes', icon: Lock, onSelect: () => claim(task, undefined) });
    else if (lease.holderId === viewer.id || viewer.admin) actions.push({ key: 'unclaim', label: lease.holderId === viewer.id ? 'Release my claim' : `Break ${lease.holderName}'s claim`, icon: LockOpen, onSelect: () => claim(task, lease) });
    actions.push({ key: 'edit', label: 'Edit details…', icon: Pencil, onSelect: () => setEditing(task.id) });
    return actions;
  };

  const editingTask = editing ? tasksById.get(editing) : undefined;
  const pathLeases = data.leases.filter((l) => l.scope === 'paths');
  const today = todayDay();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <Field label="Milestone" htmlFor="board-filter-milestone" className="w-[11rem]">
            <select id="board-filter-milestone" className={inputClass} value={filters.milestone} onChange={(e) => setFilters({ ...filters, milestone: e.target.value })}>
              <option value="">All milestones</option>
              <option value="none">No milestone</option>
              {data.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assignee" htmlFor="board-filter-assignee" className="w-[10rem]">
            <select id="board-filter-assignee" className={inputClass} value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
              <option value="">Everyone</option>
              <option value="orchestrator">Orchestrator</option>
              {data.assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.login}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label" htmlFor="board-filter-label" className="w-[9rem]">
            <select id="board-filter-label" className={inputClass} value={filters.label} onChange={(e) => setFilters({ ...filters, label: e.target.value })}>
              <option value="">All labels</option>
              {labels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)} className="mb-0.5">
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={showCancelled} onChange={setShowCancelled} label="Show cancelled" />
          {canOperate ? (
            <>
              <Button icon={Lock} onClick={() => setClaimingPaths(true)}>
                Claim paths
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                Add card
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-[13px] text-ink-2 [text-wrap:pretty]">
        Moving a card never starts work by itself. Cards in Backlog and new cards stay <span className="font-medium text-ink">on hold</span> until someone releases them; the
        orchestrator moves its own cards through In progress, Review and Done.{canOperate ? ' Drag cards, or use a card’s menu to move it with the keyboard or on touch screens.' : ''}
      </p>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <ErrorBanner error={board.error} onRetry={() => void board.reload()} />

      {pathLeases.length > 0 ? <PathClaims leases={pathLeases} viewer={viewer} canOperate={canOperate} onRelease={(lease) => void mutate(lease.id, async () => {
        const result = await api<{ broken: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/leases/${encodeURIComponent(lease.id)}/release`, { method: 'POST', body: {} });
        return result.broken ? `Broke ${lease.holderName}'s path claim.` : 'Released your path claim.';
      })} /> : null}

      <Refreshable busy={board.refreshing && !optimistic}>
        <div role="region" aria-label="Board columns" tabIndex={0} className="relative -mx-4 max-w-[calc(100%+2rem)] snap-x snap-mandatory overflow-x-auto px-4 pb-3 sm:mx-0 sm:max-w-full sm:snap-none sm:px-0">
          <div className="flex min-w-max items-start gap-3">
            {visibleColumns.map((column) => {
              const ids = visibleIds(column);
              const total = columnIds[column].length;
              const limit = column === 'in_progress' ? Math.max(1, data.maxConcurrentTasks) : null;
              const droppable = draggedTask ? canMoveTo(draggedTask, column, viewer) : false;
              const headingId = `board-col-${column}`;
              let slots = 0;
              return (
                <section
                  key={column}
                  aria-labelledby={headingId}
                  className={cx(
                    'flex w-[min(84vw,17.5rem)] shrink-0 snap-start flex-col rounded-[10px] border bg-surface-2/50 transition-[border-color,background-color] duration-150 ease-out',
                    dropTarget?.column === column ? 'border-accent bg-accent-soft/40' : 'border-line',
                    draggedTask && !droppable && 'opacity-60',
                  )}
                >
                  <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                    <div className="min-w-0">
                      <h3 id={headingId} className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                        {COLUMN_LABELS[column]}
                        <span className="tabular rounded-full bg-surface px-1.5 text-[11px] font-normal leading-4 text-ink-2">
                          {filtered && ids.length !== total ? `${ids.length} of ${total}` : total}
                          <span className="sr-only"> cards</span>
                        </span>
                      </h3>
                      <p className="mt-0.5 text-[11px] leading-4 text-ink-2">{COLUMN_HINTS[column]}</p>
                    </div>
                    {limit !== null ? <WipChip count={total} limit={limit} /> : null}
                  </header>
                  <ul
                    aria-labelledby={headingId}
                    onDragOver={(e) => onDragOver(e, column)}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
                    }}
                    onDrop={(e) => onDrop(e, column)}
                    className="flex min-h-24 flex-col gap-2 px-2 pb-2"
                  >
                    {ids.length === 0 && !(dropTarget?.column === column) ? (
                      <li className="rounded-lg border border-dashed border-line px-3 py-5 text-center text-xs text-ink-2">{filtered && total > 0 ? 'No cards match the filters' : 'No cards'}</li>
                    ) : null}
                    {ids.map((id) => {
                        const task = tasksById.get(id)!;
                        const slot = id === dragging ? -1 : slots++;
                        return (
                          <BoardCardItem
                            key={id}
                            task={task}
                            dragged={id === dragging}
                            showIndicator={slot >= 0 && dropTarget?.column === column && dropTarget.index === slot}
                            milestoneTitle={task.milestoneId ? (milestoneTitles.get(task.milestoneId) ?? null) : null}
                            assignee={assigneeName(task, data.assignees)}
                            lease={taskLeases.get(id)}
                            today={today}
                            busy={pending === id}
                            draggable={canOperate && moveOptions(task, viewer, BOARD_COLUMNS).length + columnIds[columnOf(task)].length > 1}
                            actions={cardActions(task)}
                            onOpen={() => setEditing(id)}
                            onRelease={canOperate && isHeld(task) ? () => setConfirmRelease(task) : undefined}
                            onDragStart={(event) => {
                              event.dataTransfer.setData('text/plain', id);
                              event.dataTransfer.effectAllowed = 'move';
                              // Defer so the browser captures the drag image before the card is hidden.
                              requestAnimationFrame(() => setDragging(id));
                            }}
                            onDragEnd={() => {
                              setDragging(null);
                              setDropTarget(null);
                            }}
                          />
                        );
                      })}
                    {dropTarget?.column === column && dropTarget.index >= slots ? <DropIndicator /> : null}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </Refreshable>

      {data.tasks.length === 0 ? (
        <EmptyState
          icon={SquareKanban}
          title="The board is empty."
          hint={canOperate ? 'Add a card to plan work. New cards wait on hold until you release them.' : 'An operator can add the first card.'}
        />
      ) : null}

      {creating ? <NewCardDialog projectId={projectId} data={data} onClose={() => setCreating(false)} onCreated={(message) => void mutate('create', async () => message)} /> : null}
      {editingTask ? (
        <CardDialog
          key={editingTask.id}
          projectId={projectId}
          task={editingTask}
          data={data}
          canOperate={canOperate}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            void mutate(editingTask.id, async () => message);
          }}
        />
      ) : null}
      {confirmRelease ? (
        <ConfirmDialog
          title={`Release “${confirmRelease.title}”?`}
          description={`The orchestrator may start a pipeline run on its next scheduler tick. A run of this task can spend up to ${formatUsd(confirmRelease.maxCost)} of the project budget.`}
          confirmLabel={columnOf(confirmRelease) === 'ready' ? 'Release' : 'Move to Ready and release'}
          cancelLabel="Keep on hold"
          icon={Play}
          onCancel={() => setConfirmRelease(null)}
          onConfirm={() => {
            const task = confirmRelease;
            setConfirmRelease(null);
            release(task);
          }}
        />
      ) : null}
      {confirmCancel ? (
        <ConfirmDialog
          title={`Cancel “${confirmCancel.title}”?`}
          description="Its active pipeline run is cancelled. Work already published (branches, pull requests) stays; you can reopen the card later."
          confirmLabel="Cancel task"
          cancelLabel="Keep running"
          icon={Ban}
          danger
          onCancel={() => setConfirmCancel(null)}
          onConfirm={() => {
            const task = confirmCancel;
            setConfirmCancel(null);
            move(task, 'cancelled', undefined);
          }}
        />
      ) : null}
      {claimingPaths ? <ClaimPathsDialog projectId={projectId} onClose={() => setClaimingPaths(false)} onClaimed={(message) => void mutate('claim', async () => message)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function DropIndicator() {
  return <li aria-hidden="true" className="h-1 rounded-full bg-accent" />;
}

function WipChip({ count, limit }: { count: number; limit: number }) {
  const exceeded = count > limit;
  const atLimit = count >= limit;
  const label = exceeded ? `Over WIP limit: ${count} of ${limit}` : atLimit ? `At WIP limit: ${count} of ${limit}` : `WIP ${count} of ${limit}`;
  return (
    <span
      title={`Work in progress limit (the project's maximum of concurrent tasks): ${label}`}
      className={cx(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
        exceeded ? 'border-critical/40 bg-critical-soft text-ink' : atLimit ? 'border-warning/50 bg-warning-soft text-ink' : 'border-line bg-surface text-ink-2',
      )}
    >
      {exceeded || atLimit ? <TriangleAlert aria-hidden="true" size={11} className={exceeded ? 'text-critical' : 'text-warning'} /> : null}
      <span aria-hidden="true" className="tabular">
        {count}/{limit}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Avatar({ task, name }: { task: Task; name: string }) {
  if (task.assigneeType === 'orchestrator') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft" title="Orchestrator">
        <OrchestratorMark size={13} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-ink-2">
      {initials(name)}
    </span>
  );
}

function BoardCardItem({
  task,
  dragged,
  showIndicator,
  milestoneTitle,
  assignee,
  lease,
  today,
  busy,
  draggable,
  actions,
  onOpen,
  onRelease,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  dragged: boolean;
  showIndicator: boolean;
  milestoneTitle: string | null;
  assignee: string;
  lease: Lease | undefined;
  today: string;
  busy: boolean;
  draggable: boolean;
  actions: MenuAction[];
  onOpen: () => void;
  onRelease: (() => void) | undefined;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}) {
  const held = isHeld(task);
  const due = parseDay(task.dueDate);
  const overdue = due !== null && task.dueDate! < today && !['DONE', 'CANCELLED'].includes(task.status);
  const status = STATUS_NOTE[task.status];
  return (
    <>
      {showIndicator ? <DropIndicator /> : null}
      <li
        data-card-id={task.id}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-busy={busy || undefined}
        className={cx(
          'rounded-lg border border-line bg-surface p-3 transition-[opacity,border-color,box-shadow] duration-150 ease-out hover:border-line-strong',
          draggable && 'cursor-grab active:cursor-grabbing',
          (busy || dragged) && 'opacity-50',
        )}
      >
        <div className="flex items-start gap-1.5">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left text-[13px] font-medium leading-5 text-ink [overflow-wrap:anywhere] hover:underline">
            {task.title}
          </button>
          <MenuButton label={`Actions for ${task.title}`} icon={EllipsisVertical} actions={actions} className="-mr-1 -mt-0.5" />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {status ? <Chip className="border-transparent bg-surface-2">{status}</Chip> : null}
          <Chip>{humanize(task.kind)}</Chip>
          <Chip title="Priority">P{task.priority}</Chip>
          {task.estimatePoints !== null ? <Chip title="Estimate in points">{task.estimatePoints} pts</Chip> : null}
          {milestoneTitle ? (
            <Chip title="Milestone" className="max-w-full">
              <Flag aria-hidden="true" size={11} />
              <span className="truncate">{milestoneTitle}</span>
            </Chip>
          ) : null}
          {task.labels.map((label) => (
            <Chip key={label} className="max-w-full bg-surface-2/70">
              <span className="truncate">{label}</span>
            </Chip>
          ))}
          {task.dueDate ? (
            <Chip title={overdue ? 'Overdue' : 'Due date'} className={overdue ? 'border-critical/40 text-ink' : undefined}>
              <CalendarClock aria-hidden="true" size={11} className={overdue ? 'text-critical' : undefined} />
              {overdue ? 'Overdue · ' : 'Due '}
              {formatDay(task.dueDate)}
            </Chip>
          ) : null}
        </div>
        {task.blockedReason && columnOf(task) === 'blocked' ? <p className="mt-2 line-clamp-2 text-xs text-ink-2">{task.blockedReason}</p> : null}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
            <Avatar task={task} name={assignee} />
            <span className="truncate">{assignee}</span>
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {lease ? (
              <Chip title={`Claimed until ${new Date(lease.expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`}>
                <Lock aria-hidden="true" size={11} />
                {lease.holderName}
              </Chip>
            ) : null}
            {held ? (
              <Chip title={task.holdReason ?? 'On hold'} className="border-warning/50 bg-warning-soft text-ink">
                <CirclePause aria-hidden="true" size={11} className="text-warning" />
                On hold
              </Chip>
            ) : null}
            {onRelease ? (
              <Button size="sm" variant="ghost" icon={Play} onClick={onRelease} disabled={busy} aria-label={`Release “${task.title}” to the orchestrator`}>
                Release
              </Button>
            ) : null}
          </span>
        </div>
      </li>
    </>
  );
}

const STATUS_NOTE: Partial<Record<Task['status'], string>> = {
  PAUSED: 'Paused',
  WAITING_CHILDREN: 'Waiting for sub-tasks',
  WAITING_APPROVAL: 'Waiting for approval',
  FAILED: 'Failed',
};

function PathClaims({ leases, viewer, canOperate, onRelease }: { leases: Lease[]; viewer: Viewer; canOperate: boolean; onRelease: (lease: Lease) => void }) {
  return (
    <section aria-label="Path claims" className="rounded-[10px] border border-line bg-surface px-4 py-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <Lock aria-hidden="true" size={13} className="text-ink-2" />
        Claimed paths
      </h3>
      <p className="mt-0.5 text-xs text-ink-2">The orchestrator waits before changing files someone has claimed.</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {leases.map((lease) => (
          <li key={lease.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 text-ink [overflow-wrap:anywhere]">
              <span className="font-medium">{lease.holderName}</span> · <span className="font-mono text-[12px]">{lease.pathGlobs.join(', ')}</span>
              <span className="text-ink-2"> · until {new Date(lease.expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
              {lease.reason ? <span className="text-ink-2"> · {lease.reason}</span> : null}
            </span>
            {canOperate && (lease.holderId === viewer.id || viewer.admin) ? (
              <Button size="sm" variant={lease.holderId === viewer.id ? 'secondary' : 'danger'} icon={LockOpen} onClick={() => onRelease(lease)}>
                {lease.holderId === viewer.id ? 'Release' : 'Break claim'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  icon,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  icon: LucideIcon;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      role="alertdialog"
      size="sm"
      title={title}
      description={description}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} icon={icon} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

interface PlanningDraft {
  assignee: string;
  milestoneId: string;
  estimate: string;
  labels: string;
  dueDate: string;
}

function PlanningFields({ idPrefix, draft, setDraft, data, disabled }: { idPrefix: string; draft: PlanningDraft; setDraft: (draft: PlanningDraft) => void; data: BoardResponse; disabled: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Assignee" htmlFor={`${idPrefix}-assignee`} hint={draft.assignee === 'orchestrator' ? 'The orchestrator works on it after a release.' : 'People move their own cards.'}>
        <select id={`${idPrefix}-assignee`} className={inputClass} disabled={disabled} value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}>
          <option value="orchestrator">Orchestrator</option>
          {data.assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.login}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Milestone" htmlFor={`${idPrefix}-milestone`}>
        <select id={`${idPrefix}-milestone`} className={inputClass} disabled={disabled} value={draft.milestoneId} onChange={(e) => setDraft({ ...draft, milestoneId: e.target.value })}>
          <option value="">No milestone</option>
          {data.milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Estimate" htmlFor={`${idPrefix}-estimate`}>
        <select id={`${idPrefix}-estimate`} className={inputClass} disabled={disabled} value={draft.estimate} onChange={(e) => setDraft({ ...draft, estimate: e.target.value })}>
          <option value="">Not estimated</option>
          {ESTIMATE_POINTS.map((p) => (
            <option key={p} value={p}>
              {p} {p === 1 ? 'point' : 'points'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Due date" htmlFor={`${idPrefix}-due`}>
        <input id={`${idPrefix}-due`} type="date" className={inputClass} disabled={disabled} value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
      </Field>
      <Field label="Labels" htmlFor={`${idPrefix}-labels`} hint="Comma-separated, up to 10." className="sm:col-span-2">
        <input id={`${idPrefix}-labels`} className={inputClass} disabled={disabled} value={draft.labels} maxLength={450} onChange={(e) => setDraft({ ...draft, labels: e.target.value })} placeholder="ui, search" />
      </Field>
    </div>
  );
}

const assigneeBody = (value: string) => (value === 'orchestrator' ? { type: 'orchestrator' as const } : { type: 'user' as const, id: value });

function CardDialog({ projectId, task, data, canOperate, onClose, onSaved }: { projectId: string; task: Task; data: BoardResponse; canOperate: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const initial: PlanningDraft = {
    assignee: task.assigneeType === 'orchestrator' ? 'orchestrator' : (task.assigneeId ?? 'orchestrator'),
    milestoneId: task.milestoneId ?? '',
    estimate: task.estimatePoints === null ? '' : String(task.estimatePoints),
    labels: task.labels.join(', '),
    dueDate: task.dueDate ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const patch: Record<string, unknown> = {};
    if (draft.assignee !== initial.assignee) patch.assignee = assigneeBody(draft.assignee);
    if (draft.milestoneId !== initial.milestoneId) patch.milestoneId = draft.milestoneId || null;
    if (draft.estimate !== initial.estimate) patch.estimatePoints = draft.estimate ? (Number(draft.estimate) as EstimatePoints) : null;
    if (draft.labels !== initial.labels) patch.labels = parseLabels(draft.labels);
    if (draft.dueDate !== initial.dueDate) patch.dueDate = draft.dueDate || null;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/board/cards/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: patch });
      onSaved(`Saved “${task.title}”.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const formId = `card-${task.id}`;
  return (
    <Modal
      title={task.title}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          {COLUMN_LABELS[columnOf(task)]}
          {isHeld(task) ? <Chip className="border-warning/50 bg-warning-soft text-ink">On hold</Chip> : null}
        </span>
      }
      busy={busy}
      onClose={onClose}
      footer={
        canOperate ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" busy={busy}>
              Save
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <p className="whitespace-pre-wrap text-[13px] text-ink-2 [overflow-wrap:anywhere]">{task.goal}</p>
        {isHeld(task) && task.holdReason ? <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-ink">{task.holdReason}</p> : null}
        {task.assigneeType === 'orchestrator' && draft.assignee !== 'orchestrator' ? (
          <p className="text-xs text-ink-2">Assigned to a person, the orchestrator stops considering this card.</p>
        ) : null}
        {task.assigneeType !== 'orchestrator' && draft.assignee === 'orchestrator' ? (
          <p className="text-xs text-ink-2">Handed to the orchestrator, the card stays on hold until someone releases it.</p>
        ) : null}
        <PlanningFields idPrefix={formId} draft={draft} setDraft={setDraft} data={data} disabled={!canOperate || busy} />
        {error ? (
          <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function NewCardDialog({ projectId, data, onClose, onCreated }: { projectId: string; data: BoardResponse; onClose: () => void; onCreated: (message: string) => void }) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<TaskKind>('feature');
  const [priority, setPriority] = useState(5);
  const [column, setColumn] = useState<'backlog' | 'ready'>('backlog');
  const [draft, setDraft] = useState<PlanningDraft>({ assignee: 'orchestrator', milestoneId: '', estimate: '', labels: '', dueDate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/board/cards`, {
        method: 'POST',
        body: {
          title,
          goal,
          kind,
          priority,
          column,
          assignee: assigneeBody(draft.assignee),
          milestoneId: draft.milestoneId || null,
          estimatePoints: draft.estimate ? Number(draft.estimate) : null,
          labels: parseLabels(draft.labels),
          dueDate: draft.dueDate || null,
        },
      });
      onClose();
      onCreated(`Added “${title}” to ${COLUMN_LABELS[column]}${draft.assignee === 'orchestrator' ? ' on hold' : ''}.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add card"
      description="Orchestrator cards start on hold: nothing runs until someone releases the card."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="new-card" variant="primary" icon={Plus} busy={busy}>
            Add card
          </Button>
        </>
      }
    >
      <form id="new-card" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field label="Title" htmlFor="new-card-title">
          <input id="new-card-title" className={inputClass} required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Goal" htmlFor="new-card-goal" hint="What should be true when this is done?">
          <textarea id="new-card-goal" className={textareaClass} required minLength={3} maxLength={5000} rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Column" htmlFor="new-card-column">
            <select id="new-card-column" className={inputClass} value={column} onChange={(e) => setColumn(e.target.value as 'backlog' | 'ready')} disabled={busy}>
              <option value="backlog">Backlog</option>
              <option value="ready">Ready</option>
            </select>
          </Field>
          <Field label="Kind" htmlFor="new-card-kind">
            <select id="new-card-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as TaskKind)} disabled={busy}>
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" htmlFor="new-card-priority">
            <input id="new-card-priority" type="number" min={1} max={10} className={inputClass} value={priority} onChange={(e) => setPriority(Number(e.target.value))} disabled={busy} />
          </Field>
        </div>
        <PlanningFields idPrefix="new-card" draft={draft} setDraft={setDraft} data={data} disabled={busy} />
        {error ? (
          <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function ClaimPathsDialog({ projectId, onClose, onClaimed }: { projectId: string; onClose: () => void; onClaimed: (message: string) => void }) {
  const [paths, setPaths] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const globs = paths
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/leases`, { method: 'POST', body: { scope: 'paths', paths: globs, reason, ttlMinutes: minutes } });
      onClose();
      onClaimed(`Claimed ${globs.length} path pattern(s) for ${minutes} minutes.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Claim paths"
      description="While your claim lasts, the orchestrator waits instead of changing these files. Claims expire automatically."
      busy={busy}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="claim-paths" variant="primary" icon={Lock} busy={busy}>
            Claim
          </Button>
        </>
      }
    >
      <form id="claim-paths" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field label="Path patterns" htmlFor="claim-paths-globs" hint="One per line, relative to the repository. * matches within a folder, ** across folders.">
          <textarea id="claim-paths-globs" className={cx(textareaClass, 'font-mono')} rows={3} required value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="src/auth/**" disabled={busy} />
        </Field>
        <Field label="Reason (optional)" htmlFor="claim-paths-reason">
          <input id="claim-paths-reason" className={inputClass} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Duration" htmlFor="claim-paths-minutes">
          <select id="claim-paths-minutes" className={inputClass} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={busy}>
            {[30, 60, 120, 240, 480].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </Field>
        {error ? (
          <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
