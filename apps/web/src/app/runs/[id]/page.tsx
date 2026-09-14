'use client';

import { Ban, Bot, GitBranch, GitCommitHorizontal, GitPullRequest, Play } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { AgentRunsTable, ApprovalCard, EventFeed, RunStatusBadge, StageRail, stageSteps } from '@/components/domain';
import { useBreadcrumb } from '@/components/shell';
import { FailureList } from '@/components/project-tabs';
import { hasRole, useSession } from '@/components/providers';
import { Button, Card, Chip, EmptyState, ErrorBanner, KeyValues, Loading, PageHeader, Refreshable, RelativeTime, StatusBadge, TextLink, ToneIcon } from '@/components/ui';
import { useAction, useApi } from '@/hooks/use-api';
import { useLiveEvents } from '@/hooks/use-live-events';
import { api } from '@/lib/api';
import { formatDuration, formatTokens, formatUsd, humanize, shortSha } from '@/lib/format';
import { ACTIVE_RUN_STATUSES, stageStatusTone, verificationTone } from '@/lib/status';
import type { DomainEvent, ProjectDetailResponse, RunDetailResponse } from '@/lib/types';

function durationBetween(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  return Number.isFinite(s) && Number.isFinite(e) ? formatDuration(e - s) : null;
}

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const { user } = useSession();
  const canOperate = hasRole(user, 'operator');
  const detail = useApi<RunDetailResponse>(id ? `/api/runs/${encodeURIComponent(id)}` : null, {
    live: (event) => event.runId === id || event.type.startsWith('approval.'),
  });
  const projectId = detail.data?.run.projectId;
  const project = useApi<ProjectDetailResponse>(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : null);
  const liveFilter = useMemo(() => (event: DomainEvent) => event.runId === id, [id]);
  const live = useLiveEvents(liveFilter);
  const action = useAction();
  useBreadcrumb(
    detail.data
      ? [
          { label: 'Projects', href: '/projects' },
          { label: project.data?.project.name ?? 'Project', href: `/projects/${detail.data.run.projectId}?tab=pipeline` },
          { label: `Run ${detail.data.run.id.slice(-6)}` },
        ]
      : null,
  );

  const events = useMemo(() => {
    const merged = new Map<string, DomainEvent>();
    for (const event of [...live.events, ...(detail.data?.events ?? [])]) {
      const key = event.id ?? `${event.type}-${event.createdAt}`;
      if (!merged.has(key)) merged.set(key, event);
    }
    return [...merged.values()].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [live.events, detail.data]);

  const data = detail.data;
  if (!data) {
    return (
      <>
        <ErrorBanner error={detail.error} onRetry={() => void detail.reload()} />
        {detail.error ? null : <Loading label="Loading run" />}
      </>
    );
  }

  const { run, task, agentRuns, approvals } = data;
  const cp = run.checkpoint;
  const steps = stageSteps(run);
  const projectName = project.data?.project.name;
  const repo = project.data?.project.repo;
  const repoUrl = repo ? `https://github.com/${repo.owner}/${repo.name}` : null;
  const active = ACTIVE_RUN_STATUSES.includes(run.status);

  const post = (verb: 'cancel' | 'resume') =>
    void action.run(verb, async () => {
      await api(`/api/runs/${encodeURIComponent(run.id)}/${verb}`, { method: 'POST', body: {} });
      await detail.reload();
    });

  return (
    <>
      <PageHeader
        title={task?.title ?? 'Pipeline run'}
        description={task?.goal}
        actions={
          canOperate ? (
            <>
              {run.status === 'PAUSED' ? (
                <Button icon={Play} busy={action.pending === 'resume'} onClick={() => post('resume')}>
                  Resume run
                </Button>
              ) : null}
              {active ? (
                <Button variant="danger" icon={Ban} busy={action.pending === 'cancel'} onClick={() => post('cancel')}>
                  Cancel run
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <ErrorBanner error={action.error} onDismiss={action.clearError} className="mb-4" />
      <ErrorBanner error={detail.error} onRetry={() => void detail.reload()} className="mb-4" />

      <Refreshable busy={detail.refreshing} className="flex flex-col gap-6">
        <Card>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            {run.currentStage ? <Chip>Current stage: {run.currentStage}</Chip> : null}
            {cp.outcome ? <Chip>Outcome: {humanize(cp.outcome)}</Chip> : null}
          </div>
          <KeyValues
            items={[
              { label: 'Cost', value: <span className="tabular">{formatUsd(run.costUsd)}</span> },
              { label: 'Tokens', value: <span className="tabular">{formatTokens(run.tokens)}</span> },
              { label: 'Iterations', value: <span className="tabular">{`${run.iterations} / ${run.limits.maxIterations}`}</span> },
              { label: 'Debug attempts', value: <span className="tabular">{`${run.debugAttempts} / ${run.limits.maxDebugAttempts}`}</span> },
              { label: 'Started', value: <RelativeTime value={run.startedAt} /> },
              { label: run.finishedAt ? 'Finished' : 'Running for', value: run.finishedAt ? <RelativeTime value={run.finishedAt} /> : (durationBetween(run.startedAt, null) ?? 'n/a') },
              { label: 'Cost limit', value: <span className="tabular">{formatUsd(run.limits.maxCostUsd)}</span> },
              { label: 'Resume at', value: run.resumeAt ? <RelativeTime value={run.resumeAt} /> : 'n/a' },
            ]}
          />
          {run.blockedReason || run.error ? (
            <div className="mt-4 flex items-start gap-2 rounded-md bg-serious-soft px-3 py-2 text-sm text-ink">
              <ToneIcon tone={run.error ? 'critical' : 'serious'} className="mt-0.5" />
              <div>
                {run.blockedReason ? (
                  <p>
                    <span className="font-medium">Blocked:</span> {run.blockedReason}
                  </p>
                ) : null}
                {run.error ? (
                  <p>
                    <span className="font-medium">Error:</span> {run.error}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>

        <div className="grid gap-6 xl:grid-cols-5">
          <Card title="Stage timeline" className="xl:col-span-3" description="All planned stages, including skipped ones and inserted debug passes.">
            <div className="mb-6">
              <StageRail run={run} size="lg" />
            </div>
            {steps.length === 0 ? (
              <EmptyState title="No stages planned yet" />
            ) : (
              <ol className="relative">
                {steps.map((step, index) => {
                  const tone = stageStatusTone(step.status);
                  const duration = step.startedAt ? durationBetween(step.startedAt, step.finishedAt) : null;
                  return (
                    <li key={`${step.stage}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
                      {index < steps.length - 1 ? <span aria-hidden="true" className="absolute left-[7px] top-5 bottom-0 w-px bg-grid" /> : null}
                      <ToneIcon tone={tone} size={15} className="relative mt-0.5 bg-surface" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className={step.status === 'skipped' ? 'text-sm font-medium text-ink-2' : 'text-sm font-medium text-ink'}>{step.stage}</span>
                          <span className="text-xs text-ink-2">{humanize(step.status)}</span>
                          {step.attempts > 1 ? <span className="text-xs text-ink-2">· {step.attempts} attempts</span> : null}
                          {duration ? <span className="tabular text-xs text-ink-2">· {duration}</span> : null}
                          {run.currentStage === step.stage && active ? <Chip className="h-5">current</Chip> : null}
                        </div>
                        {step.summary ? <p className="mt-0.5 text-sm text-ink-2">{step.summary}</p> : null}
                        {(step.status === 'skipped' || step.status === 'pending') && step.reason && step.reason !== step.summary ? <p className="mt-0.5 text-xs text-ink-2">{step.reason}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Card title="Checkpoint" className="xl:col-span-2">
            <ul className="flex flex-col gap-2 text-sm">
              <li className="flex items-center gap-2 text-ink-2">
                <GitBranch aria-hidden="true" size={14} className="text-muted" />
                {cp.branch ? (
                  repoUrl ? (
                    <TextLink href={`${repoUrl}/tree/${cp.branch}`} external className="font-mono text-xs">
                      {cp.branch}
                    </TextLink>
                  ) : (
                    <span className="font-mono text-xs text-ink">{cp.branch}</span>
                  )
                ) : (
                  'No branch'
                )}
              </li>
              <li className="flex items-center gap-2 text-ink-2">
                <GitPullRequest aria-hidden="true" size={14} className="text-muted" />
                {cp.prUrl ? (
                  <TextLink href={cp.prUrl} external>
                    Pull request #{cp.prNumber}
                  </TextLink>
                ) : (
                  'No pull request'
                )}
              </li>
              <li className="flex items-center gap-2 text-ink-2">
                <GitCommitHorizontal aria-hidden="true" size={14} className="text-muted" />
                {cp.commitSha ? (
                  repoUrl ? (
                    <TextLink href={`${repoUrl}/commit/${cp.commitSha}`} external className="font-mono text-xs">
                      {shortSha(cp.commitSha)}
                    </TextLink>
                  ) : (
                    <span className="font-mono text-xs text-ink">{shortSha(cp.commitSha)}</span>
                  )
                ) : cp.pendingCommitSha ? (
                  <span className="font-mono text-xs">{shortSha(cp.pendingCommitSha)} (pending)</span>
                ) : (
                  'No commit'
                )}
              </li>
            </ul>

            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-xs font-medium text-ink-2">Verification</h3>
              {cp.verification ? (
                <div className="mt-1.5">
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge tone={verificationTone(cp.verification.status)} label={humanize(cp.verification.status)} />
                    <Chip>Source: {cp.verification.source}</Chip>
                  </div>
                  <p className="mt-1.5 text-sm text-ink">{cp.verification.summary}</p>
                  {cp.verification.fingerprint ? <p className="mt-1 font-mono text-xs text-ink-2">Fingerprint {cp.verification.fingerprint}</p> : null}
                </div>
              ) : (
                <p className="mt-1 text-sm text-ink-2">Not verified yet.</p>
              )}
            </div>

            {cp.failures.length > 0 ? <FailureList failures={cp.failures} /> : null}

            {cp.notes.length > 0 || cp.feedback.length > 0 ? (
              <div className="mt-4 border-t border-line pt-4">
                <h3 className="text-xs font-medium text-ink-2">Notes and feedback</h3>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink-2">
                  {[...cp.notes, ...cp.feedback].map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-xs font-medium text-ink-2">Change set ({cp.changeset.length} files)</h3>
              {cp.changeset.length === 0 ? (
                <p className="mt-1 text-sm text-ink-2">No file changes yet.</p>
              ) : (
                <ul className="mt-1 divide-y divide-line">
                  {cp.changeset.map((file) => (
                    <li key={`${file.action}:${file.path}`} className="flex items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{file.path}</span>
                      <Chip>{file.action}</Chip>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        {approvals.length > 0 ? (
          <section aria-label="Approvals for this run" className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink">Approvals</h2>
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} {...(projectName ? { projectName } : {})} onDecided={() => void detail.reload()} />
            ))}
          </section>
        ) : null}

        <Card title="Agent runs">
          {agentRuns.length === 0 ? <EmptyState icon={Bot} title="No agents have run yet" /> : <AgentRunsTable agentRuns={agentRuns} />}
        </Card>

        <Card title="Events" description="Run event log, updated live.">
          <EventFeed events={events} emptyTitle="No events for this run" />
        </Card>
      </Refreshable>
    </>
  );
}
