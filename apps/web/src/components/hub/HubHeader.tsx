'use client';

import { Bell, Search } from 'lucide-react';
import Link from 'next/link';
import { useApi } from '@/hooks/use-api';
import type { HubMode } from '@/lib/hub/service';
import type { Approval } from '@/lib/types';
import { useSession } from '../providers';
import { cx } from '../ui';
import { HubMark, NEW_BADGE_CLASS } from './primitives';

/** Dot plus a short visible word; screen readers get "Systemstatus: …" and the tooltip explains the state. */
function SystemStatus({ mode }: { mode: HubMode }) {
  const { health } = useSession();
  const state = !health
    ? { dot: 'bg-critical', short: 'Störung', long: 'Server-Status nicht abrufbar', title: 'Der Server-Status konnte nicht abgefragt werden.' }
    : health.demoMode
      ? { dot: 'bg-warning', short: 'Demo', long: 'Demo-Modus', title: 'Kein echter Modell-Provider konfiguriert: Agenten laufen mit Mock-Modellen.' }
      : { dot: 'bg-good', short: 'System OK', long: 'System bereit', title: 'Der Orchestrator nutzt echte Modell-Provider.' };
  return (
    <span
      role="status"
      title={`Systemstatus: ${state.long}. ${state.title}${mode === 'demo' ? ' Der Hub zeigt simulierte Verbindungen.' : ''}`}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-hub-line bg-hub-card px-3 text-[13px] font-medium text-ink"
    >
      <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', state.dot)} />
      <span aria-hidden="true">{state.short}</span>
      <span className="sr-only">Systemstatus: {state.long}</span>
    </span>
  );
}

export function HubHeader({ mode, shortcutLabel, onSearch }: { mode: HubMode; shortcutLabel: string; onSearch: () => void }) {
  const pending = useApi<{ approvals: Approval[] }>('/api/approvals?status=pending', { live: (event) => event.type.startsWith('approval.') });
  const count = pending.data?.approvals.length ?? 0;

  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-3 sm:gap-3.5">
        <span className="hidden sm:block">
          <HubMark size={42} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[30px]">AI Hub</h1>
          <span className={NEW_BADGE_CLASS}>Neu</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* The search field sits right below on phones, so the trigger only shows from 640px. */}
          <button
            type="button"
            onClick={onSearch}
            aria-label={`KI suchen (${shortcutLabel})`}
            aria-keyshortcuts="Meta+K Control+K"
            className="hidden h-10 shrink-0 items-center gap-2 rounded-xl border border-hub-line bg-hub-card pl-3 pr-2 text-[13px] text-ink-2 transition-[border-color,color] duration-150 ease-out hover:border-hub-line-strong hover:text-ink sm:inline-flex"
          >
            <Search aria-hidden="true" size={16} className="shrink-0" />
            <span>Suchen</span>
            <kbd aria-hidden="true" className="inline-flex h-6 items-center rounded-md border border-hub-line bg-hub-card-2 px-1.5 font-sans text-[11px]">
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
      </div>
      <p className="max-w-xl text-[14px] text-ink-2 sm:pl-14">Verbinde die besten KI-Modelle und Tools – zentral an einem Ort.</p>
    </header>
  );
}
