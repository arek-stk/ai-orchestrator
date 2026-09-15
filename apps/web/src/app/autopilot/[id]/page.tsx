'use client';

import { useParams } from 'next/navigation';
import { CircleParking, FlaskConical, GitPullRequest, Plane, TriangleAlert } from 'lucide-react';
import { autopilotEvent, formatRemaining, KillSwitch, sessionStopText, StopButton } from '@/components/autopilot';
import { ApprovalStatusBadge, RunStatusBadge, useProjectNames } from '@/components/domain';
import { hasRole, useSession } from '@/components/providers';
import { useBreadcrumb } from '@/components/shell';
import { Card, EmptyState, ErrorBanner, KeyValues, Loading, Meter, PageHeader, Refreshable, RelativeTime, StatTile, StatusBadge, TableWrap, td, TextLink, th, useNow } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { formatAbsolute, formatConfidence, formatUsd, humanize } from '@/lib/format';
import { autopilotStatusTone, budgetTone } from '@/lib/status';
import type { AutopilotDigest, AutopilotSessionView } from '@/lib/types';

export default function AutopilotSessionPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const { user } = useSession();
  const now = useNow(30_000);
  const projectNames = useProjectNames();
  const session = useApi<{ session: AutopilotSessionView }>(id ? `/api/autopilot/sessions/${encodeURIComponent(id)}` : null, { live: autopilotEvent });
  const digest = useApi<{ digest: AutopilotDigest }>(id ? `/api/autopilot/sessions/${encodeURIComponent(id)}/digest` : null, { live: autopilotEvent });
  const active = session.data?.session.status === 'active';
  useBreadcrumb([{ label: 'Autopilot', href: '/autopilot' }, { label: active ? 'Active session' : 'While you were away' }]);

  const reload = () => {
    void session.reload();
    void digest.reload();
  };
  const project = (projectId: string) => <TextLink href={`/projects/${projectId}`}>{projectNames.get(projectId) ?? 'Project'}</TextLink>;

  if (!session.data || !digest.data) {
    return (
      <>
        <ErrorBanner error={session.error ?? digest.error} onRetry={reload} />
        {session.error || digest.error ? null : <Loading rows={6} />}
      </>
    );
  }

  const s = session.data.session;
  const d = digest.data.digest;
  const budget = budgetTone(d.costs.budgetUsedPct);
  const canAct = hasRole(user, 'operator');

  return (
    <>
      <PageHeader
        title={active ? 'Autopilot session' : 'While you were away'}
        description={
          <>
            {formatAbsolute(d.window.startsAt)} to {formatAbsolute(d.window.endedAt ?? d.window.endsAt)}.{' '}
            {active ? `${formatRemaining(s.endsAt, now)}.` : null} All figures are aggregates of recorded runs, approvals and the usage ledger; nothing here is AI-written.
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={autopilotStatusTone(s.status)} label={humanize(s.status)} {...(active ? { icon: Plane } : {})} />
            {d.demo ? <StatusBadge tone="warning" icon={FlaskConical} label="Demo session (mock models)" /> : null}
            <span className="text-xs text-ink-2">{sessionStopText(s)}</span>
          </div>
        }
        actions={
          active && canAct ? (
            <>
              <StopButton sessionId={s.id} onDone={reload} />
              <KillSwitch sessionId={s.id} onDone={reload} />
            </>
          ) : null
        }
      />

      <Refreshable busy={digest.refreshing} className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Runs started" value={<span className="tabular">{d.totals.runsStarted}</span>} sublabel={`${d.totals.inProgress} in progress`} />
          <StatTile label="Succeeded" value={<span className="tabular">{d.totals.succeeded}</span>} />
          <StatTile label="Pull requests" value={<span className="tabular">{d.totals.pullRequests}</span>} icon={GitPullRequest} />
          <StatTile label="Parked for you" value={<span className="tabular">{d.parkedApprovals.filter((a) => a.status === 'pending').length}</span>} sublabel={`${d.totals.parked} parked runs`} icon={CircleParking} />
          <StatTile label="Blocked or failed" value={<span className="tabular">{d.totals.failed}</span>} icon={TriangleAlert} />
          <StatTile label="Decisions" value={<span className="tabular">{d.totals.decisions}</span>} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Budget">
            <Meter
              label="Session budget"
              pct={d.costs.budgetUsedPct}
              tone={budget.tone}
              statusLabel={budget.label}
              valueText={
                <span className="tabular">
                  {formatUsd(d.costs.totalUsd)} of {formatUsd(d.costs.budgetUsd)}
                </span>
              }
            />
            {d.costs.byProject.length > 0 ? (
              <ul className="mt-4 divide-y divide-line text-[13px]">
                {d.costs.byProject.map((row) => (
                  <li key={row.projectId} className="flex items-center justify-between gap-3 py-2">
                    {project(row.projectId)}
                    <span className="tabular">{formatUsd(row.costUsd)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          <Card title="Session">
            <KeyValues
              items={[
                { label: 'Autonomy ceiling', value: `Level ${s.autonomyCeiling} (never raised)` },
                { label: 'Tasks picked up', value: s.maxTaskRisk === 'low' ? 'Low risk only' : 'Low and medium risk' },
                { label: 'Parked runs per project', value: s.maxParkedRuns },
                { label: 'Quiet hours', value: s.quietHours ? s.quietHours.windows.map((w) => `${w.from}–${w.to}`).join(', ') + ` (${s.quietHours.timeZone})` : 'None' },
                { label: 'Stop reason', value: d.stop.reason ? humanize(d.stop.reason) : 'n/a' },
                { label: 'Stopped by', value: d.stop.by ?? 'n/a' },
              ]}
            />
            {d.stop.detail ? <p className="mt-3 text-[13px] text-ink-2">{d.stop.detail}</p> : null}
          </Card>
        </div>

        <Card title="Built" description="Pull requests opened during the session. Nothing was merged.">
          {d.pullRequests.length === 0 ? (
            <EmptyState icon={GitPullRequest} title="No pull requests" />
          ) : (
            <TableWrap label="Pull requests">
              <thead>
                <tr>
                  <th scope="col" className={th}>Task</th>
                  <th scope="col" className={th}>Project</th>
                  <th scope="col" className={th}>Pull request</th>
                  <th scope="col" className={th}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {d.pullRequests.map((pr) => (
                  <tr key={pr.runId}>
                    <td className={td}>
                      <TextLink href={`/runs/${pr.runId}`}>{pr.taskTitle}</TextLink>
                    </td>
                    <td className={td}>{project(pr.projectId)}</td>
                    <td className={td}>{pr.url ? <TextLink href={pr.url} external>#{pr.number}</TextLink> : `#${pr.number}`}</td>
                    <td className={`${td} text-ink-2`}>{humanize(pr.outcome ?? 'open')}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card
          title="Parked for you"
          description="Gated actions the autopilot did not take. Decide them on the approvals page; nothing is approved automatically."
          actions={<TextLink href="/approvals">Open approvals</TextLink>}
        >
          {d.parkedApprovals.length === 0 ? (
            <EmptyState icon={CircleParking} title="Nothing parked" />
          ) : (
            <ul className="divide-y divide-line">
              {d.parkedApprovals.map((approval) => (
                <li key={approval.approvalId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">
                      {humanize(approval.action)}
                      {approval.taskTitle ? <span className="font-normal text-ink-2"> · {approval.taskTitle}</span> : null}
                    </p>
                    <p className="mt-0.5 text-[13px] text-ink-2">{approval.reason}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-2">
                      {project(approval.projectId)}
                      {approval.runId ? <TextLink href={`/runs/${approval.runId}`}>View run</TextLink> : null}
                      {approval.status === 'pending' && approval.expiresAt ? (
                        <span>
                          Expires <RelativeTime value={approval.expiresAt} />
                        </span>
                      ) : approval.decidedBy ? (
                        <span>By {approval.decidedBy}</span>
                      ) : null}
                    </p>
                  </div>
                  <ApprovalStatusBadge status={approval.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Failures and stops" description="Runs that ended blocked or failed, with their recorded reason.">
          {d.failures.length === 0 ? (
            <EmptyState title="No blocked or failed runs" />
          ) : (
            <ul className="divide-y divide-line">
              {d.failures.map((failure) => (
                <li key={failure.runId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <TextLink href={`/runs/${failure.runId}`} className="text-[13px] font-medium">
                      {failure.taskTitle}
                    </TextLink>
                    <p className="mt-0.5 break-words text-[13px] text-ink-2">{failure.reason}</p>
                    <p className="mt-1 text-xs text-ink-2">{project(failure.projectId)}</p>
                  </div>
                  <RunStatusBadge status={failure.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {d.decisions.length > 0 ? (
          <Card title="Decisions" description="Design decisions recorded by session runs.">
            <ul className="divide-y divide-line">
              {d.decisions.map((decision) => (
                <li key={decision.decisionId} className="py-3">
                  <p className="text-[13px] font-medium text-ink">{decision.question}</p>
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {decision.decision} · {formatConfidence(decision.confidence)} confidence
                  </p>
                  <p className="mt-1 text-xs text-ink-2">{project(decision.projectId)}</p>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </Refreshable>
    </>
  );
}
