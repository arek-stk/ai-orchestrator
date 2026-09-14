'use client';

import { useState } from 'react';
import { AgentRunsTable, useProjectNames } from '@/components/domain';
import { Card, Chip, cx, EmptyState, ErrorBanner, Field, inputClass, Loading, PageHeader, Refreshable, TableWrap, td, th } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { qs } from '@/lib/api';
import { formatTokens, humanize } from '@/lib/format';
import { AGENT_ROLES, type AgentDefinitionInfo, type AgentRun, type DomainEvent } from '@/lib/types';

const agentEvent = (e: DomainEvent) => e.type.startsWith('agent.');

export default function AgentsPage() {
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const projectNames = useProjectNames();
  const running = useApi<{ agentRuns: AgentRun[] }>('/api/agents?status=running&limit=100', { live: agentEvent });
  const recent = useApi<{ agentRuns: AgentRun[] }>(`/api/agents${qs({ role, status, limit: 200 })}`, { live: agentEvent });
  const definitions = useApi<{ agents: AgentDefinitionInfo[] }>('/api/agents/definitions');

  return (
    <>
      <PageHeader title="Agents" description="Agent runs across all projects and the agent definitions the orchestrator uses." />
      <div className="flex flex-col gap-6">
        <Card title="Running now" description="Model calls currently in flight.">
          <ErrorBanner error={running.error} onRetry={() => void running.reload()} />
          {!running.data ? (
            running.error ? null : <Loading />
          ) : (
            <Refreshable busy={running.refreshing}>
              <AgentRunsTable agentRuns={running.data.agentRuns} projectNames={projectNames} showProject emptyTitle="No agents running" />
            </Refreshable>
          )}
        </Card>

        <Card title="Recent agent runs">
          <div className="mb-4 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
            <Field label="Role" htmlFor="filter-role" className="w-48">
              <select id="filter-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">All roles</option>
                {AGENT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status" htmlFor="filter-status" className="w-40">
              <select id="filter-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </Field>
          </div>
          <ErrorBanner error={recent.error} onRetry={() => void recent.reload()} />
          {!recent.data ? (
            recent.error ? null : <Loading />
          ) : (
            <Refreshable busy={recent.refreshing}>
              <AgentRunsTable agentRuns={recent.data.agentRuns} projectNames={projectNames} showProject emptyTitle="No agent runs match these filters" />
            </Refreshable>
          )}
        </Card>

        <Card title="Agent definitions">
          <ErrorBanner error={definitions.error} onRetry={() => void definitions.reload()} />
          {!definitions.data ? (
            definitions.error ? null : <Loading />
          ) : definitions.data.agents.length === 0 ? (
            <EmptyState title="No agent definitions" />
          ) : (
            <TableWrap label="Agent definitions">
              <thead>
                <tr>
                  <th scope="col" className={th}>Name</th>
                  <th scope="col" className={th}>Role</th>
                  <th scope="col" className={th}>Output schema</th>
                  <th scope="col" className={th}>Effort</th>
                  <th scope="col" className={cx(th, 'text-right')}>Expected output</th>
                  <th scope="col" className={th}>Tools</th>
                </tr>
              </thead>
              <tbody>
                {definitions.data.agents.map((agent) => (
                  <tr key={agent.key}>
                    <td className={cx(td, 'font-medium')}>{agent.name}</td>
                    <td className={td}>{humanize(agent.role)}</td>
                    <td className={cx(td, 'font-mono text-xs')}>{agent.schemaName}</td>
                    <td className={td}>{humanize(agent.effort)}</td>
                    <td className={cx(td, 'tabular text-right')}>{formatTokens(agent.expectedOutputTokens)} tokens</td>
                    <td className={td}>
                      {agent.tools.length === 0 ? (
                        <span className="text-ink-2">None</span>
                      ) : (
                        <div className="flex max-w-md flex-wrap gap-1">
                          {agent.tools.map((tool) => (
                            <Chip key={tool} className="font-mono">
                              {tool}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
