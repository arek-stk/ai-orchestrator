'use client';

import { useState } from 'react';
import { BarList, ChartCard, ColumnChart, dailySeries, formatUsdTick } from '@/components/charts';
import { useProjectNames } from '@/components/domain';
import { cx, ErrorBanner, Loading, PageHeader, StatTile } from '@/components/ui';
import { useApi } from '@/hooks/use-api';
import { formatNumber, formatTokens, formatUsd, formatUsdCompact } from '@/lib/format';
import type { CostsResponse } from '@/lib/types';

const RANGES = [7, 30, 90] as const;

export default function CostsPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const projectNames = useProjectNames();
  const { data, error, refreshing, reload } = useApi<CostsResponse>(`/api/costs?days=${days}`, { live: (e) => e.type === 'agent.completed' });

  const series = data ? dailySeries(data.byDay, days) : [];
  const models = data ? [...data.byModel].sort((a, b) => b.costUsd - a.costUsd) : [];
  const projects = data ? [...data.byProject].sort((a, b) => b.costUsd - a.costUsd) : [];
  const projectLabel = (id: string | null) => (id ? (projectNames.get(id) ?? id) : 'Unattributed');

  return (
    <>
      <PageHeader title="Costs" description="Model spend by day, model and project." />

      {/* One filter row scoping everything below */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-md border border-line bg-surface p-0.5">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              role="radio"
              aria-checked={days === range}
              onClick={() => setDays(range)}
              className={cx('h-7 rounded px-3 text-sm', days === range ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:text-ink')}
            >
              Last {range} days
            </button>
          ))}
        </div>
        {refreshing && data ? <span className="text-xs text-ink-2" role="status">Updating…</span> : null}
      </div>

      <ErrorBanner error={error} onRetry={() => void reload()} className="mb-6" />
      {!data ? (
        error ? null : <Loading />
      ) : (
        <div className={cx('flex flex-col gap-6 transition-opacity duration-200', refreshing && 'opacity-60')} aria-busy={refreshing}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label="Cost" value={formatUsdCompact(data.summary.costUsd)} sublabel={`Last ${days} days`} />
            <StatTile label="Tokens" value={formatTokens(data.summary.tokens)} sublabel={`Last ${days} days`} />
            <StatTile label="Model calls" value={formatNumber(data.summary.calls)} sublabel={`Last ${days} days`} />
          </div>

          <ChartCard
            title="Daily cost"
            description={`Total model spend per day (UTC), last ${days} days.`}
            empty={data.byDay.length === 0}
            columns={['Day', 'Cost']}
            rows={series.map((d) => [d.fullLabel ?? d.label, formatUsd(d.value)])}
          >
            <ColumnChart data={series} format={formatUsd} formatTick={formatUsdTick} label="Daily cost" />
          </ChartCard>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard
              title="Cost by model"
              empty={models.length === 0}
              columns={['Model', 'Provider', 'Calls', 'Tokens', 'Cost']}
              rows={models.map((m) => [m.modelId, m.provider, formatNumber(m.calls), formatTokens(m.tokens), formatUsd(m.costUsd)])}
            >
              <BarList
                data={models.map((m) => ({ key: `${m.provider}/${m.modelId}`, label: m.modelId, fullLabel: `${m.provider}/${m.modelId}`, value: m.costUsd }))}
                format={formatUsd}
                formatTick={formatUsdTick}
                label="Cost by model"
              />
            </ChartCard>
            <ChartCard
              title="Cost by project"
              empty={projects.length === 0}
              columns={['Project', 'Tokens', 'Cost']}
              rows={projects.map((p) => [projectLabel(p.projectId), formatTokens(p.tokens), formatUsd(p.costUsd)])}
            >
              <BarList
                data={projects.map((p) => ({ key: p.projectId ?? 'none', label: projectLabel(p.projectId), value: p.costUsd }))}
                format={formatUsd}
                formatTick={formatUsdTick}
                label="Cost by project"
              />
            </ChartCard>
          </div>
        </div>
      )}
    </>
  );
}
