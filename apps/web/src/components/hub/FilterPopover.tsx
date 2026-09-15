'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { activeFilterCount } from '@/lib/hub/filter';
import { DEFAULT_FILTERS, INTEGRATION_LABELS, type HubFilters, type IntegrationType } from '@/lib/hub/types';
import { cx } from '../ui';
import { usePopover } from './hooks';

const CONNECTION_OPTIONS: Array<{ value: HubFilters['connection']; label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'connected', label: 'Verbunden' },
  { value: 'unconnected', label: 'Nicht verbunden' },
];

const rowClass = 'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] text-ink transition-[background-color] duration-150 ease-out hover:bg-hub-card-2';
const controlClass = 'h-4 w-4 shrink-0 cursor-pointer accent-[var(--hub-cta)]';

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function FilterPopover({ filters, onChange }: { filters: HubFilters; onChange: (filters: HubFilters) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count = activeFilterCount(filters);
  const name = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  usePopover(open, rootRef, close);

  const toggleIntegration = (value: IntegrationType, checked: boolean) =>
    onChange({ ...filters, integrations: checked ? [...filters.integrations, value] : filters.integrations.filter((item) => item !== value) });

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={count > 0 ? `Filter, ${count} aktiv` : 'Filter'}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'relative inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-xl border bg-hub-card px-3 text-[13px] text-ink shadow-hub-card transition-[border-color,background-color] duration-150 ease-out hover:border-hub-line-strong',
          open || count > 0 ? 'border-hub-cta' : 'border-hub-line',
        )}
      >
        <SlidersHorizontal aria-hidden="true" size={16} className="text-ink-2" />
        <span className="hidden sm:inline">Filter</span>
        {count > 0 ? (
          <span aria-hidden="true" className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hub-cta px-1 text-[11px] font-semibold text-white">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Filter"
          className="hub-fade-enter absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-hub-line-strong bg-hub-card p-2 shadow-pop"
        >
          <div className="flex flex-col gap-3 p-1">
            <Group legend="Verbindungsstatus">
              {CONNECTION_OPTIONS.map((option) => (
                <label key={option.value} className={rowClass}>
                  <input type="radio" name={name} className={controlClass} checked={filters.connection === option.value} onChange={() => onChange({ ...filters, connection: option.value })} />
                  {option.label}
                </label>
              ))}
            </Group>
            <Group legend="Nutzung">
              <label className={rowClass}>
                <input type="checkbox" className={controlClass} checked={filters.orchestratorOnly} onChange={(event) => onChange({ ...filters, orchestratorOnly: event.target.checked })} />
                <span>
                  Orchestrator-Integration
                  <span className="block text-xs text-ink-2">Nativ oder OpenAI-kompatibel</span>
                </span>
              </label>
              <label className={rowClass}>
                <input type="checkbox" className={controlClass} checked={filters.apiOnly} onChange={(event) => onChange({ ...filters, apiOnly: event.target.checked })} />
                Offizielle API verfügbar
              </label>
            </Group>
            <Group legend="Integrationstyp">
              {(Object.keys(INTEGRATION_LABELS) as IntegrationType[]).map((value) => (
                <label key={value} className={rowClass}>
                  <input type="checkbox" className={controlClass} checked={filters.integrations.includes(value)} onChange={(event) => toggleIntegration(value, event.target.checked)} />
                  {INTEGRATION_LABELS[value]}
                </label>
              ))}
            </Group>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-hub-line px-1 pt-2">
            <button
              type="button"
              disabled={count === 0}
              onClick={() => onChange(DEFAULT_FILTERS)}
              className="inline-flex h-9 items-center rounded-lg px-2.5 text-[13px] text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink disabled:pointer-events-none disabled:opacity-50"
            >
              Zurücksetzen
            </button>
            <button
              type="button"
              onClick={() => close(true)}
              className="inline-flex h-9 items-center rounded-lg bg-hub-cta px-3.5 text-[13px] font-medium text-white transition-[background-color] duration-150 ease-out hover:bg-hub-cta-hover"
            >
              Fertig
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
