'use client';

import {
  BookOpen,
  Bot,
  Bug,
  Check,
  CirclePause,
  Cloud,
  Compass,
  Database,
  Eye,
  FlaskConical,
  Hammer,
  ListChecks,
  Minus,
  Monitor,
  Rocket,
  ScanSearch,
  Search,
  Server,
  ShieldCheck,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useApi } from '@/hooks/use-api';
import { useLiveRefresh } from '@/hooks/use-live-events';
import { api } from '@/lib/api';
import { describeEvent, eventHref, eventTone } from '@/lib/event-text';
import { formatConfidence, formatDuration, formatTokens, formatUsd, humanize } from '@/lib/format';
import { agentStatusTone, approvalStatusTone, projectStatusTone, riskTone, runStatusTone, stageStatusTone, taskStatusTone } from '@/lib/status';
import type {
  AgentRole,
  AgentRun,
  AgentRunStatus,
  Approval,
  ApprovalStatus,
  Decision,
  DomainEvent,
  PipelineRun,
  ProjectListItem,
  ProjectStatus,
  RunStage,
  RunStatus,
  StageStatus,
  Task,
  TaskStatus,
} from '@/lib/types';
import { hasRole, useSession } from './providers';
import { Button, Chip, cx, EmptyState, JsonDetails, Mono, RelativeTime, StatusBadge, StatusDot, TableWrap, td, textareaClass, TextLink, th, ToneIcon } from './ui';

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge tone={runStatusTone(status)} label={humanize(status)} {...(status === 'PAUSED' ? { icon: CirclePause } : {})} />;
}

export function TaskStatusBadge({ status, title }: { status: TaskStatus; title?: string }) {
  return <StatusBadge tone={taskStatusTone(status)} label={humanize(status)} {...(title ? { title } : {})} {...(status === 'PAUSED' ? { icon: CirclePause } : {})} />;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <StatusBadge tone={projectStatusTone(status)} label={humanize(status)} {...(status === 'PAUSED' ? { icon: CirclePause } : {})} />;
}

export function AgentStatusBadge({ status }: { status: AgentRunStatus }) {
  return <StatusBadge tone={agentStatusTone(status)} label={humanize(status)} />;
}

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  return <StatusBadge tone={approvalStatusTone(status)} label={humanize(status)} />;
}

export function RiskBadge({ risk }: { risk: string }) {
  return <StatusBadge tone={riskTone(risk)} label={`${humanize(risk)} risk`} {...(risk === 'low' ? { icon: Minus } : {})} />;
}

export const ROLE_ICON: Record<AgentRole, LucideIcon> = {
  orchestrator: Workflow,
  project_analyst: ScanSearch,
  planner: ListChecks,
  architect: Compass,
  builder: Hammer,
  frontend: Monitor,
  backend: Server,
  database: Database,
  security: ShieldCheck,
  tester: FlaskConical,
  debugger: Bug,
  reviewer: Eye,
  researcher: Search,
  documentation: BookOpen,
  devops: Cloud,
  release: Rocket,
};

export function RoleLabel({ role }: { role: AgentRole }) {
  const Icon = ROLE_ICON[role] ?? Bot;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-ink-2">
        <Icon size={13} />
      </span>
      <span className="font-medium text-ink">{humanize(role)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stage Rail (signature element)
// ---------------------------------------------------------------------------

export interface StageStep {
  stage: RunStage;
  status: StageStatus;
  reason: string;
  summary: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Planned stages in order, with DEBUG inserted after the stage that failed (if the run debugged). */
export function stageSteps(run: PipelineRun): StageStep[] {
  const steps: StageStep[] = (run.stagePlan ?? []).map((item) => {
    const state = run.stageStates?.[item.stage];
    return {
      stage: item.stage,
      status: state?.status ?? (item.run ? 'pending' : 'skipped'),
      reason: item.reason,
      summary: state?.summary ?? null,
      attempts: state?.attempts ?? 0,
      startedAt: state?.startedAt ?? null,
      finishedAt: state?.finishedAt ?? null,
    };
  });
  const debug = run.stageStates?.DEBUG;
  if (debug) {
    const failedStage = run.checkpoint?.failures?.[0]?.stage;
    let index = failedStage ? steps.findIndex((s) => s.stage === failedStage) : -1;
    if (index < 0) index = steps.findIndex((s) => s.stage === 'TEST');
    steps.splice(index < 0 ? steps.length : index + 1, 0, {
      stage: 'DEBUG',
      status: debug.status,
      reason: `Inserted after a failure (${run.debugAttempts} debug attempt${run.debugAttempts === 1 ? '' : 's'}).`,
      summary: debug.summary,
      attempts: debug.attempts,
      startedAt: debug.startedAt,
      finishedAt: debug.finishedAt,
    });
  }
  return steps;
}

const SEGMENT_CLASS: Record<StageStatus, string> = {
  passed: 'bg-accent',
  running: 'bg-accent pulse',
  waiting: 'bg-warning',
  failed: 'bg-critical',
  skipped: 'border border-line-strong bg-transparent',
  pending: 'bg-grid',
};

/**
 * A run's planned stages as a compact rail of equal segments. One tab stop; arrow keys move between segments,
 * and hover/focus shows the stage name, status and summary. The current stage is named in text beside the rail.
 */
export function StageRail({ run, size = 'sm', showLabel = true, className }: { run: PipelineRun; size?: 'sm' | 'lg'; showLabel?: boolean; className?: string }) {
  const steps = useMemo(() => stageSteps(run), [run]);
  const [active, setActive] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  if (steps.length === 0) return <p className="text-xs text-ink-2">No stage plan yet.</p>;

  const lg = size === 'lg';
  const n = steps.length;
  let currentIndex = steps.findIndex((s) => s.stage === run.currentStage && s.status !== 'passed' && s.status !== 'skipped');
  if (currentIndex < 0) currentIndex = steps.findIndex((s) => s.status === 'running' || s.status === 'waiting' || s.status === 'failed');
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined;
  const passed = steps.filter((s) => s.status === 'passed').length;
  const planned = steps.filter((s) => s.status !== 'skipped').length;
  const safeFocus = Math.min(focusIndex, n - 1);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = Math.min(n - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else if (event.key === 'Escape') setActive(null);
    if (next < 0) return;
    event.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  const label = current ? current.stage : run.status === 'SUCCEEDED' ? 'Done' : run.status === 'QUEUED' ? 'Queued' : humanize(run.status);
  const labelStatus = current ? humanize(current.status) : null;

  return (
    <div className={cx('flex min-w-0 items-center gap-3', className)}>
      <div role="list" aria-label={`Pipeline stages: ${passed} of ${planned} passed`} className="relative flex min-w-[7rem] flex-1 gap-[2px]" onMouseLeave={() => setActive(null)}>
        {steps.map((step, index) => {
          const isCurrent = index === currentIndex;
          return (
            <div
              key={`${step.stage}-${index}`}
              role="listitem"
              ref={(el) => {
                refs.current[index] = el;
              }}
              tabIndex={index === safeFocus ? 0 : -1}
              aria-label={`${step.stage}: ${humanize(step.status)}${step.summary ? `. ${step.summary}` : step.status === 'skipped' ? `. ${step.reason}` : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
              onMouseEnter={() => setActive(index)}
              onFocus={() => {
                setActive(index);
                setFocusIndex(index);
              }}
              onBlur={() => setActive(null)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cx('relative flex min-w-0 flex-1 flex-col justify-center rounded-[3px] focus-visible:outline-offset-1', lg ? 'pb-0.5 pt-2' : 'h-5')}
            >
              <div className={cx('w-full rounded-[2px]', lg ? 'h-2' : 'h-1.5', SEGMENT_CLASS[step.status])} />
              {lg ? (
                <span className={cx('mt-1.5 truncate font-mono text-[11px] leading-none', isCurrent ? 'font-semibold text-ink' : 'text-ink-2', step.status === 'skipped' && 'line-through decoration-axis')} title={step.stage}>
                  {step.stage}
                </span>
              ) : null}
              {active === index ? (
                <div
                  role="tooltip"
                  className={cx(
                    'pointer-events-none absolute bottom-full z-20 mb-1.5 w-max max-w-64 rounded-md border border-line bg-surface px-2.5 py-2 text-left shadow-pop',
                    index < 2 ? 'left-0' : index > n - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] font-semibold text-ink">{step.stage}</span>
                    <span className="inline-flex items-center gap-1 text-xs text-ink-2">
                      <StatusDot tone={stageStatusTone(step.status)} />
                      {humanize(step.status)}
                    </span>
                  </div>
                  {step.summary ? <p className="mt-1 text-xs text-ink-2">{step.summary}</p> : null}
                  {step.status === 'skipped' || step.status === 'pending' ? <p className="mt-1 text-xs text-ink-2">{step.reason}</p> : null}
                  {step.attempts > 1 ? <p className="mt-1 text-xs text-ink-2">{step.attempts} attempts</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {showLabel ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-ink-2">
          <Mono className="text-ink">{label}</Mono>
          {labelStatus ? <span> · {labelStatus}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event feed
// ---------------------------------------------------------------------------

export function EventFeed({
  events,
  emptyTitle = 'No events yet',
  projectNames,
  live = true,
  limit,
}: {
  events: DomainEvent[];
  emptyTitle?: string;
  projectNames?: Map<string, string>;
  live?: boolean;
  limit?: number;
}) {
  const shown = limit ? events.slice(0, limit) : events;
  if (shown.length === 0) return <EmptyState title={emptyTitle} hint="Events appear here as the orchestrator works." />;
  return (
    <ul aria-live={live ? 'polite' : undefined} aria-relevant="additions" className="divide-y divide-line">
      {shown.map((event, index) => {
        const href = eventHref(event);
        const projectName = event.projectId ? projectNames?.get(event.projectId) : undefined;
        return (
          <li key={event.id ?? `${event.type}-${event.createdAt}-${index}`} className="enter flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
            <ToneIcon tone={eventTone(event)} size={13} className="mt-[3px]" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13px] text-ink">
                {href ? (
                  <TextLink href={href} className="text-ink hover:text-link">
                    {describeEvent(event)}
                  </TextLink>
                ) : (
                  describeEvent(event)
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-2">
                <Mono>{event.type}</Mono>
                {projectName ? <span>{projectName}</span> : null}
              </p>
            </div>
            <RelativeTime value={event.createdAt} className="tabular shrink-0 text-xs text-ink-2" />
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function useProjectNames(live = false) {
  const { data } = useApi<{ projects: ProjectListItem[] }>('/api/projects', live ? { live: (e) => e.type.startsWith('project.') } : {});
  return useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p.name])), [data]);
}

/** Task titles for the given projects (runs only carry task ids). */
export function useTaskTitles(projectIds: string[]): Map<string, string> {
  const key = [...new Set(projectIds)].sort().join(',');
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [version, setVersion] = useState(0);
  useLiveRefresh((e) => e.type === 'task.created', () => setVersion((v) => v + 1));

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.all(key.split(',').map((id) => api<{ tasks: Task[] }>(`/api/projects/${encodeURIComponent(id)}/tasks`).catch(() => ({ tasks: [] as Task[] })))).then((results) => {
      if (cancelled) return;
      setTitles((previous) => {
        const next = new Map(previous);
        for (const result of results) for (const task of result.tasks) next.set(task.id, task.title);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  return titles;
}

// ---------------------------------------------------------------------------
// Agent runs table
// ---------------------------------------------------------------------------

export function AgentRunsTable({ agentRuns, projectNames, showProject = false, emptyTitle = 'No agent runs yet' }: { agentRuns: AgentRun[]; projectNames?: Map<string, string>; showProject?: boolean; emptyTitle?: string }) {
  if (agentRuns.length === 0) return <EmptyState icon={Bot} title={emptyTitle} />;
  return (
    <TableWrap label="Agent runs">
      <thead>
        <tr>
          <th scope="col" className={th}>Role</th>
          {showProject ? <th scope="col" className={th}>Project</th> : null}
          <th scope="col" className={th}>Model</th>
          <th scope="col" className={th}>Status</th>
          <th scope="col" className={cx(th, 'text-right')}>Tokens</th>
          <th scope="col" className={cx(th, 'text-right')}>Cost</th>
          <th scope="col" className={cx(th, 'text-right')}>Confidence</th>
          <th scope="col" className={cx(th, 'text-right')}>Duration</th>
          <th scope="col" className={th}>Started</th>
        </tr>
      </thead>
      <tbody>
        {agentRuns.map((agent) => {
          const tokens = agent.usage.inputTokens + agent.usage.outputTokens + agent.usage.cacheReadTokens + agent.usage.cacheWriteTokens;
          return (
            <tr key={agent.id}>
              <td className={td}>
                <RoleLabel role={agent.role} />
                {agent.runId ? (
                  <div className="mt-1 pl-8">
                    <TextLink href={`/runs/${agent.runId}`} className="text-xs">
                      View run
                    </TextLink>
                  </div>
                ) : null}
              </td>
              {showProject ? (
                <td className={cx(td, 'max-w-[12rem] truncate')}>
                  <TextLink href={`/projects/${agent.projectId}`} title={projectNames?.get(agent.projectId)}>
                    {projectNames?.get(agent.projectId) ?? 'Project'}
                  </TextLink>
                </td>
              ) : null}
              <td className={cx(td, 'max-w-[14rem] truncate')}>
                <Mono title={agent.modelId ?? undefined}>{agent.modelId ?? 'n/a'}</Mono>
              </td>
              <td className={td}>
                <AgentStatusBadge status={agent.status} />
                {agent.error ? <p className="mt-1 max-w-xs break-words text-xs text-ink-2">{agent.error}</p> : null}
              </td>
              <td className={cx(td, 'tabular text-right')}>{formatTokens(tokens)}</td>
              <td className={cx(td, 'tabular text-right')}>{formatUsd(agent.costUsd)}</td>
              <td className={cx(td, 'tabular text-right')}>{formatConfidence(agent.confidence)}</td>
              <td className={cx(td, 'tabular text-right')}>{agent.status === 'running' ? 'running' : formatDuration(agent.durationMs)}</td>
              <td className={cx(td, 'text-ink-2')}>
                <RelativeTime value={agent.startedAt} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </TableWrap>
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function DecisionCard({ decision, projectName }: { decision: Decision; projectName?: string }) {
  const chosen = decision.options.find((o) => o.id === decision.chosenOptionId);
  return (
    <article className="rounded-[10px] border border-line bg-surface p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{decision.question}</h3>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
            {projectName ? <TextLink href={`/projects/${decision.projectId}`}>{projectName}</TextLink> : null}
            {decision.runId ? <TextLink href={`/runs/${decision.runId}`}>View run</TextLink> : null}
            <RelativeTime value={decision.createdAt} />
            <span className="tabular">Cost {formatUsd(decision.costUsd)}</span>
          </p>
        </div>
        <Chip title="Decision confidence">
          <span className="tabular font-medium text-ink">{formatConfidence(decision.confidence)}</span> confidence
        </Chip>
      </header>

      <div className="mt-4 border-l-2 border-accent pl-3">
        <p className="text-xs font-medium text-ink-2">Decision</p>
        <p className="mt-0.5 text-[13px] font-medium text-ink">{decision.decision || chosen?.summary || 'n/a'}</p>
        {decision.reason ? <p className="mt-1 text-[13px] text-ink-2">{decision.reason}</p> : null}
      </div>

      {decision.options.length > 0 ? (
        <div className="mt-5">
          <h4 className="text-xs font-medium text-ink-2">Options considered</h4>
          <ul className="mt-1 divide-y divide-line">
            {decision.options.map((option) => {
              const isChosen = option.id === decision.chosenOptionId;
              return (
                <li key={option.id} className="py-2.5">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                    <Mono className="text-ink-2">{option.id}</Mono>
                    <span>{option.summary}</span>
                    {isChosen ? (
                      <span className="inline-flex h-5 items-center gap-1 rounded-full bg-accent-soft px-2 text-[11px] font-medium text-ink">
                        <Check aria-hidden="true" size={11} className="text-accent" />
                        Chosen
                      </span>
                    ) : null}
                  </p>
                  {option.pros.length > 0 || option.cons.length > 0 ? (
                    <div className="mt-1.5 grid gap-x-6 gap-y-1 text-xs text-ink-2 sm:grid-cols-2">
                      <ul className="space-y-0.5">
                        {option.pros.map((pro) => (
                          <li key={pro} className="flex gap-1.5">
                            <Check aria-hidden="true" size={12} className="mt-0.5 shrink-0 text-good" />
                            <span>
                              <span className="sr-only">Pro: </span>
                              {pro}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <ul className="space-y-0.5">
                        {option.cons.map((con) => (
                          <li key={con} className="flex gap-1.5">
                            <X aria-hidden="true" size={12} className="mt-0.5 shrink-0 text-critical" />
                            <span>
                              <span className="sr-only">Con: </span>
                              {con}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {decision.consulted.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-ink-2">Consulted agents</h4>
          <ul className="mt-1 divide-y divide-line">
            {decision.consulted.map((agent, index) => (
              <li key={`${agent.role}-${index}`} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px]">
                    <RoleLabel role={agent.role} />
                    {agent.modelId ? <Mono className="text-ink-2">{agent.modelId}</Mono> : null}
                  </p>
                  <p className="mt-1 pl-8 text-[13px] text-ink-2">{agent.position}</p>
                </div>
                <span className="tabular text-xs text-ink-2">
                  {agent.optionId ? `Option ${agent.optionId} · ` : ''}
                  {formatConfidence(agent.confidence)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function ApprovalCard({ approval, projectName, onDecided }: { approval: Approval; projectName?: string; onDecided?: () => void }) {
  const { user } = useSession();
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDecide = hasRole(user, 'admin');
  const needsOwner = approval.action === 'production_deploy' && user?.role !== 'owner';
  const commentId = `approval-comment-${approval.id}`;

  const decide = async (status: 'approved' | 'rejected') => {
    setPending(status);
    setError(null);
    try {
      await api(`/api/approvals/${encodeURIComponent(approval.id)}/decide`, { method: 'POST', body: { status, comment: comment.trim() ? comment.trim() : null } });
      onDecided?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <article className="rounded-[10px] border border-line bg-surface p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{humanize(approval.action)}</h3>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
            <TextLink href={`/projects/${approval.projectId}`}>{projectName ?? 'Project'}</TextLink>
            {approval.taskId ? <TextLink href={`/projects/${approval.projectId}?tab=tasks`}>Task</TextLink> : null}
            {approval.runId ? <TextLink href={`/runs/${approval.runId}`}>View run</TextLink> : null}
            <span>
              Requested <RelativeTime value={approval.requestedAt} />
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RiskBadge risk={approval.risk} />
          <ApprovalStatusBadge status={approval.status} />
        </div>
      </header>
      <p className="mt-3 text-[13px] text-ink">{approval.reason}</p>
      {Object.keys(approval.details ?? {}).length > 0 ? (
        <div className="mt-3">
          <JsonDetails value={approval.details} summary="Request details" />
        </div>
      ) : null}

      {approval.status === 'pending' ? (
        <div className="mt-4 border-t border-line pt-4">
          {canDecide ? (
            <>
              <label htmlFor={commentId} className="text-xs font-medium text-ink-2">
                Comment (optional)
              </label>
              <textarea id={commentId} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} className={cx(textareaClass, 'mt-1')} placeholder="Why approve or reject?" />
              {error ? (
                <p role="alert" className="mt-2 flex items-start gap-1.5 text-[13px] text-ink">
                  <ToneIcon tone="critical" className="mt-0.5" />
                  {error}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={Check} busy={pending === 'approved'} disabled={pending !== null || needsOwner} onClick={() => void decide('approved')}>
                  Approve
                </Button>
                <Button variant="danger" icon={X} busy={pending === 'rejected'} disabled={pending !== null} onClick={() => void decide('rejected')}>
                  Reject
                </Button>
                {needsOwner ? <span className="text-xs text-ink-2">Production deployments must be approved by an owner.</span> : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-ink-2">Deciding approvals requires the admin role. You are signed in as {user?.role ?? 'viewer'}.</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-2">
          {humanize(approval.status)} by {approval.decidedBy ?? 'n/a'} <RelativeTime value={approval.decidedAt} />
          {approval.comment ? <span className="mt-1 block text-[13px] text-ink">&ldquo;{approval.comment}&rdquo;</span> : null}
        </p>
      )}
    </article>
  );
}
