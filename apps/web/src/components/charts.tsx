'use client';

import { ChartColumn, Table2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { niceTicks } from '@/lib/format';
import { Button, cx, EmptyState, TableWrap, td, th } from './ui';

export interface Datum {
  key: string;
  label: string;
  /** Longer label for tooltips and tables. */
  fullLabel?: string;
  value: number;
}

/**
 * Chart container: title names the (single) series, a toggle swaps the plot for an accessible table view.
 */
export function ChartCard({
  title,
  description,
  columns,
  rows,
  children,
  busy,
  empty,
  className,
  bare,
}: {
  title: string;
  description?: ReactNode;
  columns: string[];
  rows: Array<Array<ReactNode>>;
  children: ReactNode;
  busy?: boolean;
  empty?: boolean;
  className?: string;
  /** Render without card chrome (for a chart embedded in another card). */
  bare?: boolean;
}) {
  const [tableView, setTableView] = useState(false);
  return (
    <section aria-label={title} className={cx('min-w-0', !bare && 'rounded-[10px] border border-line bg-surface', className)}>
      <div className={cx('flex flex-wrap items-start justify-between gap-3', !bare && 'px-5 pt-4')}>
        <div className="min-w-0">
          <h2 className={cx('font-semibold text-ink', bare ? 'text-xs text-ink-2' : 'text-[13px]')}>{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] text-ink-2">{description}</p> : null}
        </div>
        {!empty ? (
          <Button size="sm" variant="ghost" icon={tableView ? ChartColumn : Table2} aria-pressed={tableView} onClick={() => setTableView((v) => !v)}>
            {tableView ? 'Chart view' : 'Table view'}
          </Button>
        ) : null}
      </div>
      <div aria-busy={busy} className={cx(bare ? 'pt-3' : 'px-5 pb-5 pt-4', 'transition-opacity duration-150 ease-out', busy && 'opacity-60')}>
        {empty ? (
          <EmptyState title="No data for this range" hint="Costs appear once agents have made model calls." />
        ) : tableView ? (
          <TableWrap label={`${title} table`}>
            <thead>
              <tr>
                {columns.map((column, i) => (
                  <th key={column} scope="col" className={cx(th, i > 0 && 'text-right')}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={cx(td, 'tabular', c > 0 && 'text-right')}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function useRovingFocus(count: number) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const onKeyDown = (event: KeyboardEvent, index: number, horizontal: boolean) => {
    const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
    let next = -1;
    if (event.key === forward) next = Math.min(count - 1, index + 1);
    else if (event.key === back) next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next < 0) return;
    event.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };
  return { refs, focusIndex: Math.min(focusIndex, Math.max(0, count - 1)), setFocusIndex, onKeyDown };
}

const TOP_RESERVE = 22;
const X_BAND = 22;

/** Vertical columns from a single baseline (e.g. daily cost). Single series, series-1. */
export function ColumnChart({ data, format, formatTick, height = 220, label }: { data: Datum[]; format: (v: number) => string; formatTick?: (v: number) => string; height?: number; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const { refs, focusIndex, setFocusIndex, onKeyDown } = useRovingFocus(data.length);
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const plotHeight = height - TOP_RESERVE;
  const maxIndex = max > 0 ? data.findIndex((d) => d.value === max) : -1;
  const n = data.length;
  const maxLabels = n <= 10 ? n : 7;
  const labelEvery = Math.max(1, Math.ceil(n / maxLabels));
  const tickText = formatTick ?? format;
  const activeDatum = active !== null ? data[active] : undefined;
  const pct = (v: number) => (top > 0 ? (v / top) * 100 : 0);

  return (
    <figure aria-label={label} className="m-0 flex gap-2">
      {/* y-axis ticks */}
      <div aria-hidden="true" className="relative w-12 shrink-0" style={{ height: height }}>
        <div className="absolute inset-x-0 bottom-0" style={{ height: plotHeight }}>
          {ticks.map((t) => (
            <span key={t} className="tabular absolute right-1 translate-y-1/2 whitespace-nowrap text-[11px] leading-none text-ink-2" style={{ bottom: `${pct(t)}%` }}>
              {tickText(t)}
            </span>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
          <div className="absolute inset-x-0 bottom-0" style={{ height: plotHeight }}>
            {ticks.map((t) => (
              <div key={t} aria-hidden="true" className={cx('absolute inset-x-0 h-px', t === 0 ? 'bg-axis' : 'bg-grid')} style={{ bottom: `${pct(t)}%` }} />
            ))}
          </div>

          <div className="absolute inset-x-0 bottom-0 flex items-stretch gap-[2px]" style={{ height }} role="list" aria-label={label}>
            {data.map((d, i) => {
              const h = pct(d.value);
              const isActive = active === i;
              return (
                <div
                  key={d.key}
                  role="listitem"
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  tabIndex={i === focusIndex ? 0 : -1}
                  aria-label={`${d.fullLabel ?? d.label}: ${format(d.value)}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => {
                    setActive(i);
                    setFocusIndex(i);
                  }}
                  onBlur={() => setActive(null)}
                  onKeyDown={(e) => onKeyDown(e, i, true)}
                  className="relative flex min-w-0 flex-1 cursor-default justify-center rounded-sm focus-visible:outline-offset-0"
                >
                  <div className="absolute inset-x-0 bottom-0 flex justify-center" style={{ height: plotHeight }}>
                    <div className="relative flex h-full w-full max-w-6 items-end">
                      <div
                        className={cx('w-full rounded-t-[4px] bg-series-1 transition-[filter]', isActive && 'brightness-110 saturate-150')}
                        style={{ height: `${h}%`, minHeight: d.value > 0 ? 1 : 0 }}
                      />
                      {i === maxIndex ? (
                        <span
                          aria-hidden="true"
                          className={cx(
                            'tabular pointer-events-none absolute whitespace-nowrap text-[11px] font-medium leading-none text-ink',
                            i < 2 ? 'left-0' : i > n - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                          )}
                          style={{ bottom: `calc(${h}% + 5px)` }}
                        >
                          {format(d.value)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {activeDatum && active !== null ? (
            <div
              role="tooltip"
              className={cx(
                'pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-pop',
                (active + 0.5) / n < 0.2 ? 'translate-x-0' : (active + 0.5) / n > 0.8 ? '-translate-x-full' : '-translate-x-1/2',
              )}
              style={{ left: `${((active + 0.5) / n) * 100}%` }}
            >
              <div className="tabular whitespace-nowrap text-sm font-semibold text-ink">{format(activeDatum.value)}</div>
              <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-2">
                <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded bg-series-1" />
                {activeDatum.fullLabel ?? activeDatum.label}
              </div>
            </div>
          ) : null}
        </div>

        {/* x-axis label band */}
        <div aria-hidden="true" className="flex gap-[2px]" style={{ height: X_BAND }}>
          {data.map((d, i) => (
            <div key={d.key} className="relative min-w-0 flex-1">
              {i % labelEvery === 0 ? (
                <span className={cx('absolute top-1.5 whitespace-nowrap text-[11px] leading-none text-ink-2', i === 0 ? 'left-0' : i > n - labelEvery ? 'right-0' : 'left-1/2 -translate-x-1/2')}>
                  {d.label}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

/** Horizontal ranked bars (e.g. cost by model). Single series, series-1; the max bar is direct-labeled. */
export function BarList({ data, format, formatTick, label }: { data: Datum[]; format: (v: number) => string; formatTick?: (v: number) => string; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const { refs, focusIndex, setFocusIndex, onKeyDown } = useRovingFocus(data.length);
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const pct = (v: number) => (top > 0 ? (v / top) * 100 : 0);
  const maxIndex = max > 0 ? data.findIndex((d) => d.value === max) : -1;
  const tickText = formatTick ?? format;

  return (
    <figure aria-label={label} className="m-0 grid grid-cols-[minmax(4.5rem,11rem)_minmax(0,1fr)] gap-x-3" onMouseLeave={() => setActive(null)}>
      <div aria-hidden="true">
        {data.map((d) => (
          <div key={d.key} className="flex h-8 items-center">
            <span className="truncate text-xs text-ink-2" title={d.fullLabel ?? d.label}>
              {d.label}
            </span>
          </div>
        ))}
      </div>

      <div className="min-w-0 pr-16">
        <div className="relative">
          {ticks.map((t) => (
            <div key={t} aria-hidden="true" className={cx('absolute inset-y-0 w-px', t === 0 ? 'bg-axis' : 'bg-grid')} style={{ left: `${pct(t)}%` }} />
          ))}
          <div role="list" aria-label={label}>
            {data.map((d, i) => {
              const w = pct(d.value);
              const isActive = active === i;
              return (
                <div
                  key={d.key}
                  role="listitem"
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  tabIndex={i === focusIndex ? 0 : -1}
                  aria-label={`${d.fullLabel ?? d.label}: ${format(d.value)}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => {
                    setActive(i);
                    setFocusIndex(i);
                  }}
                  onBlur={() => setActive(null)}
                  onKeyDown={(e) => onKeyDown(e, i, false)}
                  className="relative flex h-8 items-center rounded-sm focus-visible:outline-offset-0"
                >
                  <div
                    className={cx('h-4 rounded-r-[4px] bg-series-1 transition-[filter]', isActive && 'brightness-110 saturate-150')}
                    style={{ width: `${w}%`, minWidth: d.value > 0 ? 1 : 0 }}
                  />
                  {i === maxIndex ? (
                    <span aria-hidden="true" className="tabular pointer-events-none absolute whitespace-nowrap pl-1.5 text-[11px] font-medium text-ink" style={{ left: `${w}%` }}>
                      {format(d.value)}
                    </span>
                  ) : null}
                  {isActive ? (
                    <div
                      role="tooltip"
                      className="pointer-events-none absolute bottom-full z-10 mb-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5 shadow-pop"
                      style={{ left: `${Math.min(w, 60)}%` }}
                    >
                      <div className="tabular whitespace-nowrap text-sm font-semibold text-ink">{format(d.value)}</div>
                      <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-2">
                        <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded bg-series-1" />
                        {d.fullLabel ?? d.label}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div aria-hidden="true" className="relative h-6">
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cx('tabular absolute top-1.5 whitespace-nowrap text-[11px] leading-none text-ink-2', i === 0 ? '' : '-translate-x-1/2')}
              style={{ left: `${pct(t)}%` }}
            >
              {tickText(t)}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One datum per UTC day for the last `days` days, zero-filled where the API has no row. */
export function dailySeries(byDay: Array<{ day: string; costUsd: number }>, days: number, now = Date.now()): Datum[] {
  const values = new Map<string, number>();
  for (const row of byDay) {
    const key = String(row.day).slice(0, 10);
    values.set(key, (values.get(key) ?? 0) + Number(row.costUsd));
  }
  const result: Datum[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const fullLabel = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    result.push({ key, label, fullLabel, value: values.get(key) ?? 0 });
  }
  return result;
}

/** Axis tick money: $0, $0.50, $2, $1.5K. */
export function formatUsdTick(value: number): string {
  if (value === 0) return '$0';
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  if (value >= 1) return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
  return `$${Number(value.toPrecision(2))}`;
}
