'use client';

import { Bell, Search } from 'lucide-react';
import Link from 'next/link';
import { useApi } from '@/hooks/use-api';
import type { HubMode } from '@/lib/hub/service';
import type { Approval } from '@/lib/types';
import { useSession } from '../providers';
import { cx } from '../ui';
import { HubMark } from './primitives';

function SystemStatus({ mode }: { mode: HubMode }) {
  const { health } = useSession();
  const state = !health
    ? { dot: 'bg-muted', label: 'Status unbekannt', title: 'Der Server-Status konnte nicht abgefragt werden.' }
    : health.demoMode
      ? { dot: 'bg-warning', label: 'Demo-Modus', title: 'Kein echter Modell-Provider konfiguriert: Agenten laufen mit Mock-Modellen.' }
      : { dot: 'bg-good', label: 'System bereit', title: 'Der Orchestrator nutzt echte Modell-Provider.' };
  return (
    <span
      title={`${state.label}: ${state.title}${mode === 'demo' ? ' Der Hub zeigt simulierte Verbindungen.' : ''}`}
      className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-hub-line bg-hub-card px-3 text-[13px] text-ink"
    >
      <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', state.dot)} />
      {/* Label visible from 640px, collapsed to the dot next to the detail panel (1280–1535px), always announced. */}
      <span className="sr-only sm:not-sr-only xl:sr-only 2xl:not-sr-only">{state.label}</span>
    </span>
  );
}

export function HubHeader({ mode, shortcutLabel, onSearch }: { mode: HubMode; shortcutLabel: string; onSearch: () => void }) {
  const pending = useApi<{ approvals: Approval[] }>('/api/approvals?status=pending', { live: (event) => event.type.startsWith('approval.') });
  const count = pending.data?.approvals.length ?? 0;

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
      <div className="flex min-w-0 items-start gap-3.5">
        <HubMark size={42} />
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[30px]">AI Hub</h1>
            <span className="inline-flex h-5 items-center rounded-full bg-hub-cta px-2 text-[11px] font-semibold text-white">Neu</span>
          </div>
          <p className="mt-1 max-w-xl text-[14px] text-ink-2">Verbinde die besten KI-Modelle und Tools – zentral an einem Ort.</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSearch}
          aria-label={`KI suchen (${shortcutLabel})`}
          aria-keyshortcuts="Meta+K Control+K"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center gap-2.5 rounded-xl border border-hub-line bg-hub-card text-[13px] text-ink-2 transition-[border-color,color] duration-150 ease-out hover:border-hub-line-strong hover:text-ink md:w-64 md:justify-start md:px-3 xl:w-44 2xl:w-72"
        >
          <Search aria-hidden="true" size={16} className="shrink-0" />
          <span className="hidden flex-1 truncate text-left md:inline">Suche nach KI, Funktion oder Tool …</span>
          <kbd aria-hidden="true" className="hidden h-6 items-center rounded-md border border-hub-line bg-hub-card-2 px-1.5 font-sans text-[11px] md:inline-flex">
            {shortcutLabel}
          </kbd>
        </button>
        <Link
          href="/approvals"
          aria-label={count > 0 ? `Benachrichtigungen: ${count} offene Freigaben` : 'Benachrichtigungen: keine offenen Freigaben'}
          className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-hub-line bg-hub-card text-ink-2 transition-[border-color,color] duration-150 ease-out hover:border-hub-line-strong hover:text-ink"
        >
          <Bell aria-hidden="true" size={16} />
          {count > 0 ? (
            <span aria-hidden="true" className="tabular absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-hub-cta px-1 text-[10.5px] font-semibold text-white ring-2 ring-page">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Link>
        <SystemStatus mode={mode} />
      </div>
    </header>
  );
}
