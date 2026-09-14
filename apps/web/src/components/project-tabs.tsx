'use client';

import { Ban, FileCode, GitBranch, GitCommitHorizontal, GitPullRequest, Lightbulb, ListTodo, Play, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useApi, useAction } from '@/hooks/use-api';
import { useLiveEvents } from '@/hooks/use-live-events';
import { api, errorMessage } from '@/lib/api';
import { formatAbsolute, formatTokens, formatUsd, humanize, shortSha } from '@/lib/format';
import { verificationTone } from '@/lib/status';
import {
  COMPLEXITIES,
  RISKS,
  TASK_KINDS,
  TASK_STATUSES,
  type AgentRun,
  type CostsResponse,
  type DomainEvent,
  type PipelineRun,
  type ProjectDetailResponse,
  type Task,
  type TaskStatus,
} from '@/lib/types';
import { BarList, ChartCard, ColumnChart, dailySeries, formatUsdTick } from './charts';
import { AgentRunsTable, DecisionCard, EventFeed, RunStatusBadge, StageRail, TaskStatusBadge } from './domain';
import { hasRole, useSession } from './providers';
import {
  Button,
  Card,
  Chip,
  cx,
  EmptyState,
  ErrorBanner,
  Field,
  inputClass,
  KeyValues,
  Loading,
  Refreshable,
  RelativeTime,
  StatTile,
  StatusBadge,
  TableWrap,
  td,
  textareaClass,
  TextLink,
  th,
} from './ui';

type DetailProps = { detail: ProjectDetailResponse };

function taskTitles(detail: ProjectDetailResponse): Map<string, string> {
  return new Map(detail.tasks.map((t) => [t.id, t.title]));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function OverviewTab({ detail }: DetailProps) {
  const { project, tasks, runs, decisions, costs30d, approvals } = detail;
  const titles = taskTitles(detail);
  const activeRuns = runs.filter((r) => ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED'].includes(r.status));
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const blocked = tasks.filter((t) => t.status === 'BLOCKED').length;
  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Open tasks" value={tasks.length - done - tasks.filter((t) => ['FAILED', 'CANCELLED'].includes(t.status)).length} sublabel={`${done} done`} />
        <StatTile label="Blocked tasks" value={blocked} />
        <StatTile label="Active runs" value={activeRuns.length} sublabel={`${runs.length} recent runs`} />
        <StatTile label="Pending approvals" value={pendingApprovals} />
        <StatTile label="Spent" value={formatUsd(project.spentUsd)} sublabel={`of ${formatUsd(project.budgetUsd)} budget`} />
        <StatTile label="Cost (30 days)" value={formatUsd(costs30d.costUsd)} sublabel={`${formatTokens(costs30d.tokens)} tokens`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Active runs" className="xl:col-span-3">
          {activeRuns.length === 0 ? (
            <EmptyState title="No active runs" hint="Start a ready task from the Tasks tab, or wait for the scheduler." />
          ) : (
            <ul className="divide-y divide-line">
              {activeRuns.map((run) => (
                <li key={run.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <TextLink href={`/runs/${run.id}`} className="font-medium">
                      {titles.get(run.taskId) ?? 'Run'}
                    </TextLink>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <StageRail run={run} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent decisions" className="xl:col-span-2">
          {decisions.length === 0 ? (
            <EmptyState icon={Lightbulb} title="No decisions yet" />
          ) : (
            <ul className="divide-y divide-line">
              {decisions.slice(0, 5).map((decision) => (
                <li key={decision.id} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium text-ink">{decision.question}</p>
                  <p className="mt-0.5 text-sm text-ink-2">{decision.decision}</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {Math.round(decision.confidence * 100)}% confidence · <RelativeTime value={decision.createdAt} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function PipelineTab({ detail }: DetailProps) {
  const titles = taskTitles(detail);
  if (detail.runs.length === 0) return <EmptyState title="No pipeline runs yet" hint="Runs appear when a task starts." />;
  return (
    <ul className="flex flex-col gap-3">
      {detail.runs.map((run) => (
        <li key={run.id} className="rounded-[10px] border border-line bg-surface px-5 py-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <TextLink href={`/runs/${run.id}`} className="font-medium">
                {titles.get(run.taskId) ?? run.taskId}
              </TextLink>
              <p className="mt-0.5 text-xs text-ink-2">
                Started <RelativeTime value={run.startedAt} /> · {formatUsd(run.costUsd)} · {formatTokens(run.tokens)} tokens
                {run.currentStage ? ` · current stage ${run.currentStage}` : ''}
              </p>
            </div>
            <RunStatusBadge status={run.status} />
          </div>
          <StageRail run={run} />
          {run.blockedReason || run.error ? <p className="mt-2 text-xs text-ink-2">{run.blockedReason ?? run.error}</p> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const CANCELLABLE: TaskStatus[] = ['BACKLOG', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_CHILDREN', 'PAUSED', 'BLOCKED'];

function NewTaskForm({ projectId, tasks, onDone, onCancel }: { projectId: string; tasks: Task[]; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    title: '',
    goal: '',
    kind: 'feature' as string,
    priority: 5,
    risk: 'medium' as string,
    estimatedComplexity: 'medium' as string,
    acceptance: '',
    dependencies: [] as string[],
    maxCost: 5,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
        method: 'POST',
        body: {
          title: form.title.trim(),
          goal: form.goal.trim(),
          kind: form.kind,
          priority: form.priority,
          risk: form.risk,
          estimatedComplexity: form.estimatedComplexity,
          acceptanceCriteria: form.acceptance
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          dependencies: form.dependencies,
          maxCost: form.maxCost,
        },
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const candidates = tasks.filter((t) => !['CANCELLED'].includes(t.status));

  return (
    <Card title="New task" className="mb-6">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 md:grid-cols-2">
        <Field label="Title" htmlFor="nt-title" className="md:col-span-2">
          <input id="nt-title" required minLength={3} maxLength={200} className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Goal" htmlFor="nt-goal" className="md:col-span-2">
          <textarea id="nt-goal" required minLength={3} maxLength={5000} rows={3} className={textareaClass} value={form.goal} onChange={(e) => set('goal', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind" htmlFor="nt-kind">
            <select id="nt-kind" className={inputClass} value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority (1-10)" htmlFor="nt-priority">
            <input id="nt-priority" type="number" min={1} max={10} className={inputClass} value={form.priority} onChange={(e) => set('priority', Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Risk" htmlFor="nt-risk">
            <select id="nt-risk" className={inputClass} value={form.risk} onChange={(e) => set('risk', e.target.value)}>
              {RISKS.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Complexity" htmlFor="nt-complexity">
            <select id="nt-complexity" className={inputClass} value={form.estimatedComplexity} onChange={(e) => set('estimatedComplexity', e.target.value)}>
              {COMPLEXITIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max cost (USD)" htmlFor="nt-cost">
            <input id="nt-cost" type="number" min={0.01} step="0.01" className={inputClass} value={form.maxCost} onChange={(e) => set('maxCost', Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Acceptance criteria" htmlFor="nt-acceptance" hint="One criterion per line.">
          <textarea id="nt-acceptance" rows={4} className={textareaClass} value={form.acceptance} onChange={(e) => set('acceptance', e.target.value)} />
        </Field>
        <fieldset className="min-w-0">
          <legend className="text-xs font-medium text-ink-2">Dependencies</legend>
          {candidates.length === 0 ? (
            <p className="mt-1 text-xs text-ink-2">No other tasks in this project.</p>
          ) : (
            <div className="mt-1 max-h-32 overflow-auto rounded-md border border-line-strong px-2.5 py-1.5">
              {candidates.map((t) => (
                <label key={t.id} className="flex items-center gap-2 py-0.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={form.dependencies.includes(t.id)}
                    onChange={(e) => set('dependencies', e.target.checked ? [...form.dependencies, t.id] : form.dependencies.filter((d) => d !== t.id))}
                  />
                  <span className="truncate">{t.title}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error ? <ErrorBanner error={error} className="md:col-span-2" /> : null}
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit" variant="primary" busy={busy}>
            Create task
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export function TasksTab({ detail, reload }: DetailProps & { reload: () => Promise<void> }) {
  const { user } = useSession();
  const canOperate = hasRole(user, 'operator');
  const [creating, setCreating] = useState(false);
  const action = useAction();
  const titles = taskTitles(detail);
  const latestRun = useMemo(() => {
    const map = new Map<string, PipelineRun>();
    for (const run of detail.runs) if (!map.has(run.taskId)) map.set(run.taskId, run);
    return map;
  }, [detail.runs]);

  const groups = TASK_STATUSES.map((status) => ({ status, tasks: detail.tasks.filter((t) => t.status === status).sort((a, b) => b.priority - a.priority) })).filter((g) => g.tasks.length > 0);

  const act = (task: Task, verb: 'start' | 'retry' | 'cancel') =>
    void action.run(`${verb}:${task.id}`, async () => {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/${verb}`, { method: 'POST', body: {} });
      await reload();
    });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">{detail.tasks.length} tasks</p>
        {canOperate && !creating ? (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New task
          </Button>
        ) : null}
      </div>
      {creating ? (
        <NewTaskForm
          projectId={detail.project.id}
          tasks={detail.tasks}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void reload();
          }}
        />
      ) : null}
      <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-4" />
      {groups.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet."
          hint={canOperate ? 'Create a task to give the agents work.' : 'An operator can create the first task.'}
          action={
            canOperate && !creating ? (
              <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                New task
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.status} aria-label={humanize(group.status)}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-2">
                <TaskStatusBadge status={group.status} />
                <span className="tabular">{group.tasks.length}</span>
              </h3>
              <ul className="divide-y divide-line rounded-[10px] border border-line bg-surface">
                {group.tasks.map((task) => {
                  const run = latestRun.get(task.id);
                  return (
                    <li key={task.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">{task.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{task.goal}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Chip>{humanize(task.kind)}</Chip>
                          <Chip>Priority {task.priority}</Chip>
                          <Chip>{humanize(task.risk)} risk</Chip>
                          <Chip>{humanize(task.estimatedComplexity)}</Chip>
                          <Chip>
                            Attempts {task.attempts}/{task.maxAttempts}
                          </Chip>
                          {task.costUsd > 0 ? <Chip>{formatUsd(task.costUsd)}</Chip> : null}
                          {task.dependencies.length > 0 ? <Chip title={task.dependencies.map((d) => titles.get(d) ?? d).join(', ')}>Depends on {task.dependencies.length}</Chip> : null}
                        </div>
                        {task.blockedReason ? (
                          <p className="mt-2 rounded-md bg-serious-soft px-2.5 py-1.5 text-xs text-ink">
                            <span className="font-medium">Blocked:</span> {task.blockedReason}
                          </p>
                        ) : null}
                        {task.acceptanceCriteria.length > 0 ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">Acceptance criteria ({task.acceptanceCriteria.length})</summary>
                            <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">
                              {task.acceptanceCriteria.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {run ? (
                          <TextLink href={`/runs/${run.id}`} className="text-xs">
                            Latest run
                          </TextLink>
                        ) : null}
                        {canOperate && (task.status === 'READY' || task.status === 'BACKLOG') ? (
                          <Button size="sm" icon={Play} busy={action.pending === `start:${task.id}`} onClick={() => act(task, 'start')}>
                            Start
                          </Button>
                        ) : null}
                        {canOperate && ['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status) ? (
                          <Button size="sm" icon={RotateCcw} busy={action.pending === `retry:${task.id}`} onClick={() => act(task, 'retry')}>
                            Retry
                          </Button>
                        ) : null}
                        {canOperate && CANCELLABLE.includes(task.status) ? (
                          <Button size="sm" variant="danger" icon={Ban} busy={action.pending === `cancel:${task.id}`} onClick={() => act(task, 'cancel')}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function AgentsTab({ projectId }: { projectId: string }) {
  const { data, error, refreshing, reload } = useApi<{ agentRuns: AgentRun[] }>(`/api/agents?projectId=${encodeURIComponent(projectId)}&limit=200`, {
    live: (e) => e.projectId === projectId && e.type.startsWith('agent.'),
  });
  return (
    <Card title="Agent runs">
      <ErrorBanner error={error} onRetry={() => void reload()} />
      {!data ? error ? null : <Loading /> : (
        <Refreshable busy={refreshing}>
          <AgentRunsTable agentRuns={data.agentRuns} emptyTitle="No agents have worked on this project yet" />
        </Refreshable>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function GitHubTab({ detail }: DetailProps) {
  const { project } = detail;
  const titles = taskTitles(detail);
  const repoUrl = project.repo ? `https://github.com/${project.repo.owner}/${project.repo.name}` : null;
  const runs = detail.runs.filter((r) => r.checkpoint.branch || r.checkpoint.prUrl || r.checkpoint.commitSha || r.checkpoint.changeset.length > 0);

  if (!project.repo) return <EmptyState title="No repository connected" hint="An admin can connect a repository in Settings." />;
  if (runs.length === 0) return <EmptyState icon={GitBranch} title="No branches or pull requests yet" hint="Runs at autonomy level 3+ publish branches and pull requests." />;

  return (
    <div className="flex flex-col gap-3">
      {runs.map((run) => {
        const cp = run.checkpoint;
        const sha = cp.commitSha ?? cp.pendingCommitSha;
        return (
          <article key={run.id} className="rounded-[10px] border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <TextLink href={`/runs/${run.id}`} className="font-medium">
                {titles.get(run.taskId) ?? run.taskId}
              </TextLink>
              <RunStatusBadge status={run.status} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <GitBranch aria-hidden="true" size={14} className="text-muted" />
                {cp.branch && repoUrl ? (
                  <TextLink href={`${repoUrl}/tree/${cp.branch}`} external className="font-mono text-xs">
                    {cp.branch}
                  </TextLink>
                ) : (
                  <span>No branch</span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <GitPullRequest aria-hidden="true" size={14} className="text-muted" />
                {cp.prUrl ? (
                  <TextLink href={cp.prUrl} external>
                    Pull request #{cp.prNumber}
                  </TextLink>
                ) : (
                  <span>No pull request</span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5 text-ink-2">
                <GitCommitHorizontal aria-hidden="true" size={14} className="text-muted" />
                {sha && repoUrl ? (
                  <TextLink href={`${repoUrl}/commit/${sha}`} external className="font-mono text-xs">
                    {shortSha(sha)}
                  </TextLink>
                ) : (
                  <span>No commit</span>
                )}
                {!cp.commitSha && cp.pendingCommitSha ? <span className="text-xs">(pending)</span> : null}
              </span>
              {cp.outcome ? <Chip>Outcome: {humanize(cp.outcome)}</Chip> : null}
            </div>
            {cp.changeset.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">Change set ({cp.changeset.length} files)</summary>
                <ul className="mt-2 divide-y divide-line">
                  {cp.changeset.map((file) => (
                    <li key={`${file.action}:${file.path}`} className="flex flex-wrap items-start gap-2 px-3 py-1.5 text-sm">
                      <FileCode aria-hidden="true" size={14} className="mt-0.5 text-muted" />
                      <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{file.path}</span>
                      <Chip>{file.action}</Chip>
                      {file.rationale ? <p className="w-full pl-6 text-xs text-ink-2">{file.rationale}</p> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export function TestsTab({ detail }: DetailProps) {
  const titles = taskTitles(detail);
  const runs = detail.runs.filter((r) => r.checkpoint.verification || r.checkpoint.failures.length > 0);
  if (runs.length === 0) return <EmptyState title="No verification reports yet" hint="Reports appear after the TEST and VERIFY stages run." />;
  return (
    <div className="flex flex-col gap-3">
      {runs.map((run) => {
        const report = run.checkpoint.verification;
        return (
          <article key={run.id} className="rounded-[10px] border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <TextLink href={`/runs/${run.id}`} className="font-medium">
                  {titles.get(run.taskId) ?? run.taskId}
                </TextLink>
                <p className="mt-0.5 text-xs text-ink-2">
                  Run started <RelativeTime value={run.startedAt} />
                </p>
              </div>
              {report ? (
                <div className="flex flex-wrap gap-2">
                  <StatusBadge tone={verificationTone(report.status)} label={humanize(report.status)} />
                  <Chip>Source: {report.source}</Chip>
                </div>
              ) : (
                <Chip>No verification report</Chip>
              )}
            </div>
            {report ? (
              <div className="mt-3">
                <p className="text-sm text-ink">{report.summary}</p>
                {report.fingerprint ? <p className="mt-1 font-mono text-xs text-ink-2">Fingerprint {report.fingerprint}</p> : null}
                {report.output ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">Output</summary>
                    <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[12px] text-ink-2">{report.output}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
            {run.checkpoint.failures.length > 0 ? <FailureList failures={run.checkpoint.failures} /> : null}
          </article>
        );
      })}
    </div>
  );
}

export function FailureList({ failures }: { failures: PipelineRun['checkpoint']['failures'] }) {
  return (
    <div className="mt-3">
      <h4 className="text-xs font-medium text-ink-2">Failures ({failures.length})</h4>
      <ul className="mt-1 divide-y divide-line">
        {failures.map((failure, index) => (
          <li key={`${failure.fingerprint}-${index}`} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm text-ink">
                <StatusBadge tone="critical" label={failure.stage} />
                {failure.summary}
              </span>
              <span className="text-xs text-ink-2" title={formatAbsolute(failure.at)}>
                <RelativeTime value={failure.at} />
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-ink-2">Fingerprint {failure.fingerprint}</p>
            {failure.output ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">Output</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[12px] text-ink-2">{failure.output}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function LogsTab({ projectId }: { projectId: string }) {
  const history = useApi<{ events: DomainEvent[] }>(`/api/events?projectId=${encodeURIComponent(projectId)}&limit=300`);
  const filter = useMemo(() => (e: DomainEvent) => e.projectId === projectId, [projectId]);
  const live = useLiveEvents(filter);
  const [hideTicks, setHideTicks] = useState(true);

  const events = useMemo(() => {
    const merged = new Map<string, DomainEvent>();
    for (const event of [...live.events, ...(history.data?.events ?? [])]) {
      const key = event.id ?? `${event.type}-${event.createdAt}`;
      if (!merged.has(key)) merged.set(key, event);
    }
    return [...merged.values()]
      .filter((e) => !hideTicks || e.type !== 'scheduler.tick')
      .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [live.events, history.data, hideTicks]);

  return (
    <Card
      title="Event log"
      description="Project history, updated live."
      actions={
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={hideTicks} onChange={(e) => setHideTicks(e.target.checked)} />
          Hide scheduler ticks
        </label>
      }
    >
      <ErrorBanner error={history.error} onRetry={() => void history.reload()} />
      {!history.data && !history.error ? <Loading /> : <EventFeed events={events} emptyTitle="No events for this project" />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function DecisionsTab({ detail }: DetailProps) {
  if (detail.decisions.length === 0) return <EmptyState icon={Lightbulb} title="No decisions yet" hint="Design decisions and council outcomes are recorded here." />;
  return (
    <div className="flex flex-col gap-3">
      {detail.decisions.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

export function CostsTab({ projectId }: { projectId: string }) {
  const days = 30;
  const { data, error, refreshing, reload } = useApi<CostsResponse>(`/api/costs?days=${days}&projectId=${encodeURIComponent(projectId)}`, {
    live: (e) => e.projectId === projectId && e.type === 'agent.completed',
  });
  if (!data) return error ? <ErrorBanner error={error} onRetry={() => void reload()} /> : <Loading />;
  const series = dailySeries(data.byDay, days);
  const models = [...data.byModel].sort((a, b) => b.costUsd - a.costUsd);
  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner error={error} onRetry={() => void reload()} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Cost (30 days)" value={formatUsd(data.summary.costUsd)} />
        <StatTile label="Tokens (30 days)" value={formatTokens(data.summary.tokens)} />
        <StatTile label="Model calls (30 days)" value={data.summary.calls.toLocaleString('en-US')} />
      </div>
      <ChartCard
        title="Daily cost, last 30 days"
        busy={refreshing}
        empty={data.summary.costUsd === 0 && data.byDay.length === 0}
        columns={['Day', 'Cost']}
        rows={series.map((d) => [d.fullLabel ?? d.label, formatUsd(d.value)])}
      >
        <ColumnChart data={series} format={formatUsd} formatTick={formatUsdTick} label="Daily cost" />
      </ChartCard>
      <ChartCard
        title="Cost by model, last 30 days"
        busy={refreshing}
        empty={models.length === 0}
        columns={['Model', 'Provider', 'Calls', 'Tokens', 'Cost']}
        rows={models.map((m) => [m.modelId, m.provider, m.calls.toLocaleString('en-US'), formatTokens(m.tokens), formatUsd(m.costUsd)])}
      >
        <BarList data={models.map((m) => ({ key: `${m.provider}/${m.modelId}`, label: m.modelId, fullLabel: `${m.provider}/${m.modelId}`, value: m.costUsd }))} format={formatUsd} formatTick={formatUsdTick} label="Cost by model" />
      </ChartCard>
    </div>
  );
}

