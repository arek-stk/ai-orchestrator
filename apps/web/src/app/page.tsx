'use client';

import { Activity, Bot, CircleAlert, FolderKanban, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { ChartCard, ColumnChart, dailySeries, formatUsdTick } from '@/components/charts';
import { EventFeed, RoleLabel, RunStatusBadge, StageRail, useProjectNames, useTaskTitles } from '@/components/domain';
import { Card, EmptyState, ErrorBanner, LinkButton, Loading, Meter, Mono, PageHeader, Refreshable, Skeleton, StatTile, TableWrap, td, TextLink, th, useNow, cx } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { useLiveEvents } from '@/hooks/use-live-events';
import { formatNumber, formatTokens, formatUsd } from '@/lib/format';
import { ACTIVE_RUN_STATUSES, budgetTone } from '@/lib/status';
import type { CostsResponse, DashboardResponse, DomainEvent, PipelineRun } from '@/lib/types';

const notTick = (event: DomainEvent) => event.type !== 'scheduler.tick';
const runEvent = (event: DomainEvent) => event.type.startsWith('pipeline.') || event.type.startsWith('task.') || event.type.startsWith('approval.') || event.type === 'agent.completed';

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export default function DashboardPage() {
  const dashboard = useApi<DashboardResponse>('/api/dashboard', { live: notTick });
  const runs = useApi<{ runs: PipelineRun[] }>('/api/runs?limit=100', { live: runEvent });
  const costs = useApi<CostsResponse>('/api/costs?days=14', { live: (e) => e.type === 'agent.completed' });
  const projectNames = useProjectNames(true);
  const live = useLiveEvents(notTick);
  const now = useNow();

  const activeRuns = useMemo(() => (runs.data?.runs ?? []).filter((run) => ACTIVE_RUN_STATUSES.includes(run.status)), [runs.data]);
  const taskTitles = useTaskTitles(activeRuns.map((r) => r.projectId));

  const feed = useMemo(() => {
    const merged = new Map<string, DomainEvent>();
    for (const event of [...live.events, ...(dashboard.data?.recentEvents ?? [])]) {
      if (event.type === 'scheduler.tick') continue;
      const key = event.id ?? `${event.type}-${event.createdAt}`;
      if (!merged.has(key)) merged.set(key, event);
    }
    return [...merged.values()].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 25);
  }, [live.events, dashboard.data]);

  const d = dashboard.data;
  const series = costs.data ? dailySeries(costs.data.byDay, 14) : [];

  if (!d) {
    return (
      <>
        <PageHeader title="Dashboard" description="What the orchestrator is doing right now." />
        <ErrorBanner error={dashboard.error} onRetry={() => void dashboard.reload()} className="mb-6" />
        {dashboard.error ? null : (
          <div className="flex flex-col gap-6" role="status">
            <span className="sr-only">Loading dashboard…</span>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[92px] rounded-[10px]" />
              ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              <Skeleton className="h-72 rounded-[10px]" />
              <Skeleton className="h-72 rounded-[10px]" />
            </div>
          </div>
        )}
      </>
    );
  }

  const blockedTasks = d.tasks.BLOCKED ?? 0;
  const severity = budgetTone(d.costs.budgetUsedPct);

  return (
    <>
      <PageHeader title="Dashboard" description="What the orchestrator is doing right now." />
      <ErrorBanner error={dashboard.error} onRetry={() => void dashboard.reload()} className="mb-6" />

      <Refreshable busy={dashboard.refreshing} className="flex flex-col gap-6">
        {d.approvals.pending > 0 || blockedTasks > 0 ? (
          <section aria-label="Needs you" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] border border-line bg-warning-soft px-4 py-3">
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink">
              <TriangleAlert aria-hidden="true" size={16} className="text-warning" />
              Needs you
            </span>
            <p className="flex-1 text-[13px] text-ink-2">
              {d.approvals.pending > 0 ? (
                <span>
                  <span className="tabular font-medium text-ink">{d.approvals.pending}</span> approval{d.approvals.pending === 1 ? '' : 's'} waiting
                </span>
              ) : null}
              {d.approvals.pending > 0 && blockedTasks > 0 ? <span aria-hidden="true"> · </span> : null}
              {blockedTasks > 0 ? (
                <span>
                  <span className="tabular font-medium text-ink">{blockedTasks}</span> blocked task{blockedTasks === 1 ? '' : 's'}
                </span>
              ) : null}
            </p>
            <div className="flex flex-wrap gap-2">
              {d.approvals.pending > 0 ? (
                <LinkButton href="/approvals" size="sm" variant="primary">
                  Review approvals
                </LinkButton>
              ) : null}
              {blockedTasks > 0 ? (
                <LinkButton href="/projects" size="sm">
                  Review blocked tasks
                </LinkButton>
              ) : null}
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Projects" value={formatNumber(d.projects.total)} sublabel={`${Object.entries(d.tasks).filter(([status]) => !['DONE', 'FAILED', 'CANCELLED'].includes(status)).reduce((sum, [, count]) => sum + count, 0)} open tasks`} href="/projects" icon={FolderKanban} />
          <StatTile label="Running" value={formatNumber(d.projects.running)} sublabel={`${d.pipelines.active} active pipelines`} icon={Activity} />
          <StatTile label="Blocked" value={formatNumber(d.projects.blocked)} sublabel={`${blockedTasks} blocked tasks`} icon={CircleAlert} />
          <StatTile label="Active agents" value={formatNumber(d.agents.active)} sublabel="Model calls in flight" href="/agents" icon={Bot} />
          <StatTile label="Pending approvals" value={formatNumber(d.approvals.pending)} sublabel={d.approvals.pending > 0 ? 'Waiting for a decision' : 'Nothing waiting'} href="/approvals" icon={ShieldCheck} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card
            title="Live pipelines"
            description={`${d.pipelines.active} active · ${d.pipelines.waiting} waiting · ${d.pipelines.succeeded7d} succeeded and ${d.pipelines.failed7d} failed in 7 days`}
            bodyClassName="px-5 pb-4 pt-3"
          >
            <Refreshable busy={runs.refreshing}>
              {runs.error ? (
                <ErrorBanner error={runs.error} onRetry={() => void runs.reload()} />
              ) : !runs.data ? (
                <Loading rows={4} />
              ) : activeRuns.length === 0 ? (
                <EmptyState icon={Activity} title="No pipelines running right now." hint="Runs start when the scheduler picks up a ready task." />
              ) : (
                <ul className="divide-y divide-line">
                  {activeRuns.map((run) => (
                    <li key={run.id} className="grid gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <TextLink href={`/runs/${run.id}`} className="block truncate text-[13px] font-medium text-ink hover:text-link" title={taskTitles.get(run.taskId)}>
                          {taskTitles.get(run.taskId) ?? 'Pipeline run'}
                        </TextLink>
                        <TextLink href={`/projects/${run.projectId}`} className="block truncate text-xs text-ink-2 hover:text-link">
                          {projectNames.get(run.projectId) ?? 'Project'}
                        </TextLink>
                      </div>
                      <StageRail run={run} />
                      <div className="flex items-center gap-3 text-xs text-ink-2 md:justify-end">
                        {run.status !== 'RUNNING' ? <RunStatusBadge status={run.status} /> : null}
                        <span className="tabular whitespace-nowrap" title="Elapsed">
                          {formatElapsed(now - new Date(run.startedAt).getTime())}
                        </span>
                        <span className="tabular w-16 whitespace-nowrap text-right text-ink" title="Cost so far">
                          {formatUsd(run.costUsd)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Refreshable>
          </Card>

          <Card title="Spend today" description="All projects against the global daily budget.">
            <Meter
              label="Cost today"
              pct={d.costs.budgetUsedPct}
              tone={d.costs.dailyBudgetUsd > 0 ? severity.tone : 'muted'}
              valueText={
                <>
                  <span className="text-2xl font-semibold tracking-[-0.01em] text-ink">{formatUsd(d.costs.todayUsd)}</span>
                  <span className="tabular"> of {formatUsd(d.costs.dailyBudgetUsd)}</span>
                </>
              }
              statusLabel={d.costs.dailyBudgetUsd > 0 ? `${severity.label} · ${Math.round(d.costs.budgetUsedPct)}%` : 'No daily budget set'}
              detail={<span className="tabular">{formatTokens(d.costs.tokensToday)} tokens · {formatNumber(d.costs.callsToday)} calls</span>}
            />
            <div className="mt-5 border-t border-line pt-4">
              {costs.error ? (
                <ErrorBanner error={costs.error} onRetry={() => void costs.reload()} />
              ) : !costs.data ? (
                <Loading rows={2} />
              ) : (
                <ChartCard
                  bare
                  title="Last 14 days"
                  busy={costs.refreshing}
                  empty={costs.data.byDay.length === 0}
                  columns={['Day', 'Cost']}
                  rows={series.map((s) => [s.fullLabel ?? s.label, formatUsd(s.value)])}
                >
                  <ColumnChart data={series} format={formatUsd} formatTick={formatUsdTick} height={132} label="Daily cost, last 14 days" />
                </ChartCard>
              )}
            </div>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Agents at work" description="Model calls currently in flight.">
            {d.agents.running.length === 0 ? (
              <EmptyState icon={Bot} title="No agents are working right now." />
            ) : (
              <TableWrap label="Agents at work">
                <thead>
                  <tr>
                    <th scope="col" className={th}>Role</th>
                    <th scope="col" className={th}>Model</th>
                    <th scope="col" className={th}>Project</th>
                    <th scope="col" className={cx(th, 'text-right')}>Running for</th>
                  </tr>
                </thead>
                <tbody>
                  {d.agents.running.map((agent) => (
                    <tr key={agent.id}>
                      <td className={td}>
                        <RoleLabel role={agent.role} />
                      </td>
                      <td className={cx(td, 'max-w-[11rem] truncate')}>
                        <Mono title={agent.modelId ?? undefined}>{agent.modelId ?? 'n/a'}</Mono>
                      </td>
                      <td className={cx(td, 'max-w-[10rem] truncate')}>
                        <TextLink href={agent.runId ? `/runs/${agent.runId}` : `/projects/${agent.projectId}`} title={projectNames.get(agent.projectId)}>
                          {projectNames.get(agent.projectId) ?? 'Project'}
                        </TextLink>
                      </td>
                      <td className={cx(td, 'tabular text-right text-ink-2')}>{formatElapsed(now - new Date(agent.startedAt).getTime())}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Card>

          <Card title="Activity" description="Live orchestrator events.">
            <EventFeed events={feed} projectNames={projectNames} />
          </Card>
        </div>
      </Refreshable>
    </>
  );
}
