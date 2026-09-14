'use client';

import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { DecisionCard, useProjectNames } from '@/components/domain';
import { EmptyState, ErrorBanner, Field, inputClass, Loading, PageHeader, Refreshable } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { qs } from '@/lib/api';
import type { Decision } from '@/lib/types';

export default function DecisionsPage() {
  const [projectId, setProjectId] = useState('');
  const projectNames = useProjectNames();
  const { data, error, refreshing, reload } = useApi<{ decisions: Decision[] }>(`/api/decisions${qs({ projectId })}`, {
    live: (e) => e.type === 'decision.made',
  });

  return (
    <>
      <PageHeader title="Decisions" description="The decision trace: what was asked, which options were weighed, who was consulted and why an option won." />
      <div className="mb-5 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
        <Field label="Project" htmlFor="decision-project" className="w-64">
          <select id="decision-project" className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {[...projectNames.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorBanner error={error} onRetry={() => void reload()} className="mb-4" />
      {!data ? (
        error ? null : <Loading />
      ) : data.decisions.length === 0 ? (
        <EmptyState icon={Lightbulb} title="No decisions recorded" hint="Decisions are recorded when agents design a change or the council is consulted." />
      ) : (
        <Refreshable busy={refreshing} className="flex flex-col gap-3">
          {data.decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} {...(projectNames.get(decision.projectId) ? { projectName: projectNames.get(decision.projectId)! } : {})} />
          ))}
        </Refreshable>
      )}
    </>
  );
}
