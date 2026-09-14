'use client';

import { ShieldCheck } from 'lucide-react';
import { ApprovalCard, ApprovalStatusBadge, RiskBadge, useProjectNames } from '@/components/domain';
import { Card, EmptyState, ErrorBanner, Loading, PageHeader, Refreshable, RelativeTime, TableWrap, td, TextLink, th } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { humanize } from '@/lib/format';
import type { Approval, DomainEvent } from '@/lib/types';

const approvalEvent = (e: DomainEvent) => e.type.startsWith('approval.');

export default function ApprovalsPage() {
  const projectNames = useProjectNames();
  const pending = useApi<{ approvals: Approval[] }>('/api/approvals?status=pending', { live: approvalEvent });
  const all = useApi<{ approvals: Approval[] }>('/api/approvals', { live: approvalEvent });
  const history = (all.data?.approvals ?? []).filter((a) => a.status !== 'pending');

  const reloadBoth = () => {
    void pending.reload();
    void all.reload();
  };

  return (
    <>
      <PageHeader title="Approvals" description="Gated actions wait here until an admin decides. Production deployments need an owner." />
      <div className="flex flex-col gap-8">
        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="mb-3 text-sm font-semibold text-ink">
            Pending {pending.data ? <span className="tabular font-normal text-ink-2">({pending.data.approvals.length})</span> : null}
          </h2>
          <ErrorBanner error={pending.error} onRetry={() => void pending.reload()} />
          {!pending.data ? (
            pending.error ? null : <Loading />
          ) : pending.data.approvals.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No approvals waiting" hint="Pipelines that hit an approval gate will show up here." />
          ) : (
            <Refreshable busy={pending.refreshing} className="grid gap-3 lg:grid-cols-2">
              {pending.data.approvals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} {...(projectNames.get(approval.projectId) ? { projectName: projectNames.get(approval.projectId)! } : {})} onDecided={reloadBoth} />
              ))}
            </Refreshable>
          )}
        </section>

        <Card title="History" description="Decided and expired approvals.">
          <ErrorBanner error={all.error} onRetry={() => void all.reload()} />
          {!all.data ? (
            all.error ? null : <Loading />
          ) : history.length === 0 ? (
            <EmptyState title="No decided approvals yet" />
          ) : (
            <Refreshable busy={all.refreshing}>
              <TableWrap label="Approval history">
                <thead>
                  <tr>
                    <th scope="col" className={th}>Action</th>
                    <th scope="col" className={th}>Project</th>
                    <th scope="col" className={th}>Risk</th>
                    <th scope="col" className={th}>Status</th>
                    <th scope="col" className={th}>Decided by</th>
                    <th scope="col" className={th}>Comment</th>
                    <th scope="col" className={th}>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((approval) => (
                    <tr key={approval.id}>
                      <td className={td}>
                        <div className="font-medium">{humanize(approval.action)}</div>
                        <p className="max-w-xs text-xs text-ink-2">{approval.reason}</p>
                        {approval.runId ? (
                          <TextLink href={`/runs/${approval.runId}`} className="text-xs">
                            View run
                          </TextLink>
                        ) : null}
                      </td>
                      <td className={td}>
                        <TextLink href={`/projects/${approval.projectId}`}>{projectNames.get(approval.projectId) ?? 'Project'}</TextLink>
                      </td>
                      <td className={td}>
                        <RiskBadge risk={approval.risk} />
                      </td>
                      <td className={td}>
                        <ApprovalStatusBadge status={approval.status} />
                      </td>
                      <td className={td}>{approval.decidedBy ?? 'n/a'}</td>
                      <td className={td}>
                        <span className="text-ink-2">{approval.comment ?? ''}</span>
                      </td>
                      <td className={td}>
                        <RelativeTime value={approval.decidedAt ?? approval.requestedAt} className="text-ink-2" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Refreshable>
          )}
        </Card>
      </div>
    </>
  );
}
