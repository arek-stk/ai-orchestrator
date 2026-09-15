'use client';

import { Plane } from 'lucide-react';
import { AutopilotButton, autopilotEvent, sessionStopText } from '@/components/autopilot';
import { useProjectNames } from '@/components/domain';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader, Refreshable, RelativeTime, StatusBadge, TableWrap, td, TextLink, th } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { formatUsd, humanize } from '@/lib/format';
import { autopilotStatusTone } from '@/lib/status';
import type { AutopilotSessionView } from '@/lib/types';

export default function AutopilotPage() {
  const projectNames = useProjectNames();
  const sessions = useApi<{ sessions: AutopilotSessionView[] }>('/api/autopilot/sessions?limit=50', { live: autopilotEvent });

  return (
    <>
      <PageHeader
        title="Autopilot"
        description="Time- and budget-boxed sessions in which agents keep working on existing tasks while you are away. Gated actions are parked for a human; merges and deployments never happen."
        actions={<AutopilotButton />}
      />
      <Card title="Sessions">
        <ErrorBanner error={sessions.error} onRetry={() => void sessions.reload()} />
        {!sessions.data ? (
          sessions.error ? null : <Loading />
        ) : sessions.data.sessions.length === 0 ? (
          <EmptyState icon={Plane} title="No autopilot sessions yet" hint="Admins can start one from the Autopilot button in the top bar." />
        ) : (
          <Refreshable busy={sessions.refreshing}>
            <TableWrap label="Autopilot sessions">
              <thead>
                <tr>
                  <th scope="col" className={th}>Session</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}>Projects</th>
                  <th scope="col" className={th}>Spend</th>
                  <th scope="col" className={th}>Runs</th>
                  <th scope="col" className={th}>Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.sessions.map((session) => (
                  <tr key={session.id}>
                    <td className={td}>
                      <TextLink href={`/autopilot/${session.id}`} className="font-medium">
                        {session.status === 'active' ? 'Active session' : 'While you were away'}
                      </TextLink>
                      {session.demo ? <span className="ml-2 text-xs text-ink-2">demo</span> : null}
                    </td>
                    <td className={td}>
                      <StatusBadge tone={autopilotStatusTone(session.status)} label={humanize(session.status)} />
                      <p className="mt-1 text-xs text-ink-2">{sessionStopText(session)}</p>
                    </td>
                    <td className={td}>{session.projectIds.map((id) => projectNames.get(id) ?? 'Project').join(', ')}</td>
                    <td className={`${td} tabular`}>
                      {session.progress.spentUsd === null ? 'n/a' : formatUsd(session.progress.spentUsd)} <span className="text-ink-2">of {formatUsd(session.budgetUsd)}</span>
                    </td>
                    <td className={`${td} tabular`}>
                      {session.progress.runsStarted} <span className="text-ink-2">· {session.progress.parkedRuns} parked</span>
                    </td>
                    <td className={`${td} text-ink-2`}>
                      <RelativeTime value={session.startsAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Refreshable>
        )}
      </Card>
    </>
  );
}
