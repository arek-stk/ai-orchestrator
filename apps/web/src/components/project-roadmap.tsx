'use client';

import { CalendarRange, Flag, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useApi } from '@/hooks/use-api';
import { api, errorMessage } from '@/lib/api';
import { COLUMN_LABELS, formatDay, roadmapLayout } from '@/lib/board';
import { humanize } from '@/lib/format';
import type { Tone } from '@/lib/status';
import { MILESTONE_STATUSES, type BoardColumn, type Milestone, type MilestoneStatus } from '@/lib/types';
import { Modal } from './overlay';
import { hasRole, useSession } from './providers';
import { Button, Card, Chip, cx, EmptyState, ErrorBanner, Field, inputClass, Loading, Meter, Refreshable, StatusBadge, textareaClass, useNow } from './ui';

// Milestones and roadmap (ADR-030 stage 2): create and edit milestones, see progress derived from their tasks, and a
// month timeline of milestones over time. The timeline is decorative for screen readers; every row states its dates and
// progress as text.

const STATUS_TONE: Record<MilestoneStatus, Tone> = { planned: 'muted', active: 'accent', done: 'good' };
const PROGRESS_COLUMNS: BoardColumn[] = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done'];

export function RoadmapTab({ projectId }: { projectId: string }) {
  const { user } = useSession();
  const canOperate = hasRole(user, 'operator');
  const milestones = useApi<{ milestones: Milestone[] }>(`/api/projects/${encodeURIComponent(projectId)}/milestones`, {
    live: (event) => event.projectId === projectId && (event.type === 'milestone.updated' || event.type.startsWith('task.')),
  });
  const [editing, setEditing] = useState<Milestone | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(60_000);
  const list = milestones.data?.milestones;
  const layout = useMemo(() => (list ? roadmapLayout(list, now) : null), [list, now]);

  if (!list || !layout) {
    return (
      <>
        <ErrorBanner error={milestones.error} onRetry={() => void milestones.reload()} />
        {milestones.error ? null : <Loading label="Loading milestones" />}
      </>
    );
  }

  const remove = async (milestone: Milestone) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestone.id)}`, { method: 'DELETE' });
      setAnnouncement(`Deleted milestone “${milestone.title}”. Its tasks remain on the board.`);
      setDeleting(null);
      await milestones.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-2">
          {list.length === 1 ? '1 milestone' : `${list.length} milestones`}. Progress counts the milestone’s tasks (by points when every task is estimated).
        </p>
        {canOperate ? (
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            New milestone
          </Button>
        ) : null}
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {list.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No milestones yet."
          hint={canOperate ? 'Group board cards into milestones with dates to see them on the roadmap.' : 'An operator can plan the first milestone.'}
          action={
            canOperate ? (
              <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
                New milestone
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Refreshable busy={milestones.refreshing}>
          <Card title="Roadmap" description="Milestones over time. Today is marked with a vertical line." bodyClassName="px-0 py-3 sm:px-5">
            {layout.rows.length === 0 ? (
              <p className="px-5 text-[13px] text-ink-2 sm:px-0">Add start or due dates to milestones to place them on the timeline.</p>
            ) : (
              <div role="region" aria-label="Roadmap timeline" tabIndex={0} className="relative overflow-x-auto px-5 sm:px-0">
                <div className="min-w-[36rem]">
                  <div aria-hidden="true" className="relative ml-[35%] h-6 border-b border-line text-[11px] text-ink-2">
                    {layout.months.map((month) => (
                      <span key={`${month.label}-${month.left}`} className="absolute top-0 whitespace-nowrap border-l border-line pl-1" style={{ left: `${month.left}%` }}>
                        {month.label}
                      </span>
                    ))}
                  </div>
                  <ul className="flex flex-col">
                    {layout.rows.map((row) => (
                      <li key={row.milestone.id} className="flex items-center gap-0 border-b border-line py-2 last:border-b-0">
                        <div className="w-[35%] min-w-0 pr-3">
                          <p className="truncate text-[13px] font-medium text-ink">{row.milestone.title}</p>
                          <p className="text-xs text-ink-2">
                            {row.range} · {row.milestone.progress.pct}% done
                            {row.overdue ? (
                              <span className="ml-1 inline-flex items-center gap-0.5 text-ink">
                                <TriangleAlert aria-hidden="true" size={11} className="text-critical" />
                                overdue
                              </span>
                            ) : null}
                            <span className="sr-only">, {humanize(row.milestone.status)}</span>
                          </p>
                        </div>
                        <div aria-hidden="true" className="relative h-7 flex-1">
                          {layout.months.map((month) => (
                            <span key={month.left} className="absolute inset-y-0 border-l border-grid" style={{ left: `${month.left}%` }} />
                          ))}
                          {layout.today !== null ? <span className="absolute inset-y-[-8px] z-[1] border-l-2 border-accent" style={{ left: `${layout.today}%` }} /> : null}
                          {row.marker ? (
                            <span
                              className={cx('absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border', row.overdue ? 'border-critical bg-critical-soft' : 'border-accent bg-accent-soft')}
                              style={{ left: `${row.left}%` }}
                            />
                          ) : (
                            <span
                              className={cx(
                                'absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-full border',
                                row.milestone.status === 'done' ? 'border-good/50 bg-good-soft' : row.overdue ? 'border-critical/50 bg-critical-soft' : 'border-accent/50 bg-accent-soft',
                              )}
                              style={{ left: `${row.left}%`, width: `${row.width}%` }}
                            >
                              <span className={cx('block h-full', row.milestone.status === 'done' ? 'bg-good' : row.overdue ? 'bg-critical' : 'bg-accent')} style={{ width: `${row.milestone.progress.pct}%` }} />
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {layout.unscheduled.length > 0 ? (
              <p className="mt-3 px-5 text-xs text-ink-2 sm:px-0">
                Not on the timeline (no dates): {layout.unscheduled.map((m) => m.title).join(', ')}
              </p>
            ) : null}
          </Card>

          <ul className="mt-5 grid gap-3 md:grid-cols-2">
            {list.map((milestone) => (
              <li key={milestone.id}>
                <MilestoneCard milestone={milestone} canOperate={canOperate} onEdit={() => setEditing(milestone)} onDelete={() => setDeleting(milestone)} />
              </li>
            ))}
          </ul>
        </Refreshable>
      )}

      {editing ? (
        <MilestoneDialog
          projectId={projectId}
          milestone={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setAnnouncement(message);
            void milestones.reload();
          }}
        />
      ) : null}
      {deleting ? (
        <Modal
          role="alertdialog"
          size="sm"
          title={`Delete “${deleting.title}”?`}
          description="The milestone is removed from the roadmap. Its tasks stay on the board without a milestone."
          busy={busy}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button onClick={() => setDeleting(null)} disabled={busy}>
                Keep milestone
              </Button>
              <Button variant="danger" icon={Trash2} busy={busy} onClick={() => void remove(deleting)}>
                Delete milestone
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function MilestoneCard({ milestone, canOperate, onEdit, onDelete }: { milestone: Milestone; canOperate: boolean; onEdit: () => void; onDelete: () => void }) {
  const { progress } = milestone;
  const dates =
    milestone.startDate && milestone.dueDate
      ? `${formatDay(milestone.startDate)} – ${formatDay(milestone.dueDate, true)}`
      : milestone.dueDate
        ? `Due ${formatDay(milestone.dueDate, true)}`
        : milestone.startDate
          ? `From ${formatDay(milestone.startDate, true)}`
          : 'No dates';
  const tone: Tone = milestone.status === 'done' ? 'good' : progress.byColumn.blocked > 0 ? 'serious' : 'accent';
  return (
    <article className="flex h-full flex-col gap-3 rounded-[10px] border border-line bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink [overflow-wrap:anywhere]">{milestone.title}</h3>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-2">
            <CalendarRange aria-hidden="true" size={12} />
            {dates}
          </p>
        </div>
        <StatusBadge tone={STATUS_TONE[milestone.status]} label={humanize(milestone.status)} />
      </div>
      {milestone.description ? <p className="whitespace-pre-wrap text-[13px] text-ink-2 [overflow-wrap:anywhere]">{milestone.description}</p> : null}
      <Meter
        label="Progress"
        pct={progress.pct}
        tone={tone}
        valueText={
          progress.points > 0 ? (
            <span className="tabular">
              {progress.done}/{progress.total} tasks · {progress.pointsDone}/{progress.points} pts
            </span>
          ) : (
            <span className="tabular">
              {progress.done}/{progress.total} tasks
            </span>
          )
        }
        statusLabel={progress.total === 0 ? 'No tasks yet' : `${progress.pct}% done${progress.byColumn.blocked > 0 ? `, ${progress.byColumn.blocked} blocked` : ''}`}
        detail={progress.unestimated > 0 ? <span>{progress.unestimated} without estimate</span> : undefined}
      />
      <div className="flex flex-wrap gap-1">
        {PROGRESS_COLUMNS.filter((c) => progress.byColumn[c] > 0).map((column) => (
          <Chip key={column}>
            {COLUMN_LABELS[column]} <span className="tabular">{progress.byColumn[column]}</span>
          </Chip>
        ))}
      </div>
      {canOperate ? (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button size="sm" icon={Pencil} onClick={onEdit} aria-label={`Edit milestone “${milestone.title}”`}>
            Edit
          </Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={onDelete} aria-label={`Delete milestone “${milestone.title}”`}>
            Delete
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function MilestoneDialog({ projectId, milestone, onClose, onSaved }: { projectId: string; milestone: Milestone | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [title, setTitle] = useState(milestone?.title ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [status, setStatus] = useState<MilestoneStatus>(milestone?.status ?? 'planned');
  const [startDate, setStartDate] = useState(milestone?.startDate ?? '');
  const [dueDate, setDueDate] = useState(milestone?.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidRange = Boolean(startDate && dueDate && startDate > dueDate);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalidRange) return;
    setBusy(true);
    setError(null);
    const body = { title, description, status, startDate: startDate || null, dueDate: dueDate || null };
    try {
      if (milestone) {
        await api(`/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestone.id)}`, { method: 'PATCH', body });
        onSaved(`Saved milestone “${title}”.`);
      } else {
        await api(`/api/projects/${encodeURIComponent(projectId)}/milestones`, { method: 'POST', body });
        onSaved(`Created milestone “${title}”.`);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={milestone ? 'Edit milestone' : 'New milestone'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="milestone-form" variant="primary" busy={busy} disabled={invalidRange}>
            {milestone ? 'Save' : 'Create milestone'}
          </Button>
        </>
      }
    >
      <form id="milestone-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field label="Title" htmlFor="milestone-title">
          <input id="milestone-title" className={inputClass} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </Field>
        <Field label="Description" htmlFor="milestone-description">
          <textarea id="milestone-description" className={textareaClass} rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Status" htmlFor="milestone-status">
            <select id="milestone-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as MilestoneStatus)} disabled={busy}>
              {MILESTONE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start date" htmlFor="milestone-start">
            <input id="milestone-start" type="date" className={inputClass} value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Due date" htmlFor="milestone-due">
            <input
              id="milestone-due"
              type="date"
              className={inputClass}
              value={dueDate}
              min={startDate || undefined}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={busy}
              aria-invalid={invalidRange || undefined}
              aria-describedby={invalidRange ? 'milestone-dates-error' : undefined}
            />
          </Field>
        </div>
        {invalidRange ? (
          <p id="milestone-dates-error" className="text-xs text-critical">
            The due date must not be before the start date.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-[13px] text-ink">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
