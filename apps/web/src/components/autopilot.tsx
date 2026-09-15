'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleStop, OctagonX, Plane, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApi } from '@/hooks/use-api';
import { api, errorMessage } from '@/lib/api';
import { formatUsd, humanize } from '@/lib/format';
import type { AutopilotConfig, AutopilotSessionView, DomainEvent, ProjectListItem } from '@/lib/types';
import { hasRole, useSession } from './providers';
import { Button, cx, Field, IconButton, inputClass, ToneIcon, useNow } from './ui';

// Autopilot / away mode (ADR-034): start dialog, active-session banner, stop and kill switch.

export const autopilotEvent = (event: DomainEvent) =>
  event.type.startsWith('autopilot.') || event.type.startsWith('approval.') || event.type === 'agent.completed' || event.type === 'budget.exhausted';

const DURATION_PRESETS = [4, 10, 48];

/** "2 h 15 min left", "12 min left", "ending". */
export function formatRemaining(endsAt: string, now: number): string {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return 'ending';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min left` : `${hours} h left`;
}

export function formatClock(value: string): string {
  return new Date(value).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const killClass =
  'inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-critical px-2.5 text-xs font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-critical/90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-9';

// ---------------------------------------------------------------------------
// Stop and kill switch
// ---------------------------------------------------------------------------

/** Immediate kill with an explicit confirmation step. Pauses the session's runs; parked approvals stay with humans. */
export function KillSwitch({ sessionId, onDone, label = 'Kill switch' }: { sessionId: string; onDone?: () => void; label?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const kill = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/autopilot/kill', { method: 'POST', body: { sessionId } });
      setConfirming(false);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button type="button" className={killClass} onClick={() => setConfirming(true)}>
        <OctagonX aria-hidden="true" size={14} />
        {label}
      </button>
    );
  }
  return (
    <span role="group" aria-label="Confirm the kill switch" className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-ink">Pause every run of this session now?</span>
      <button ref={confirmRef} type="button" className={killClass} disabled={busy} aria-busy={busy || undefined} onClick={() => void kill()}>
        <OctagonX aria-hidden="true" size={14} />
        Confirm kill
      </button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-ink">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function StopButton({ sessionId, onDone }: { sessionId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/autopilot/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', body: {} });
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" icon={CircleStop} busy={busy} onClick={() => void stop()} title="Graceful stop: nothing new starts; running work finishes with its current limits">
        I&apos;m back
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-ink">
          {error}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export function useActiveAutopilot(enabled: boolean) {
  return useApi<{ sessions: AutopilotSessionView[] }>(enabled ? '/api/autopilot/sessions?status=active' : null, { live: autopilotEvent });
}

/** Global banner while a visible session is active: remaining time and budget, runs, parked work, stop, kill. */
export function AutopilotBanner() {
  const { user } = useSession();
  const active = useActiveAutopilot(Boolean(user));
  const now = useNow(30_000);
  const sessions = active.data?.sessions ?? [];
  if (sessions.length === 0) return null;
  const canAct = hasRole(user, 'operator');
  const reload = () => void active.reload();

  return (
    <section aria-label="Autopilot" className="border-b border-line bg-accent-soft">
      {sessions.map((session) => {
        const spent = session.progress.spentUsd;
        return (
          <div key={session.id} className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
            <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink">
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <Plane aria-hidden="true" size={15} className="text-accent" />
                Autopilot active{session.demo ? ' (demo)' : ''}
              </span>
              <span title={`Ends ${new Date(session.endsAt).toLocaleString('en-US')}`}>
                <span className="tabular">{formatRemaining(session.endsAt, now)}</span>
                <span className="text-ink-2"> · ends {formatClock(session.endsAt)}</span>
              </span>
              <span className="tabular">
                {spent === null ? 'Budget' : formatUsd(spent)} <span className="text-ink-2">of {formatUsd(session.budgetUsd)}</span>
              </span>
              <span className="tabular text-ink-2">
                {session.progress.activeRuns} running · {session.progress.parkedRuns} parked
              </span>
              <Link href={`/autopilot/${session.id}`} className="text-link underline-offset-2 hover:underline">
                Details
              </Link>
            </p>
            {canAct ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <StopButton sessionId={session.id} onDone={reload} />
                <KillSwitch sessionId={session.id} onDone={reload} />
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Start dialog
// ---------------------------------------------------------------------------

/** Header button for admins and owners; opens the start dialog. */
export function AutopilotButton() {
  const { user } = useSession();
  const canStart = hasRole(user, 'admin');
  const config = useApi<AutopilotConfig>(canStart ? '/api/autopilot/config' : null);
  const [open, setOpen] = useState(false);
  if (!canStart) return null;
  const disabled = config.data ? !config.data.enabled : true;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={Plane}
        disabled={disabled}
        title={config.data && !config.data.enabled ? 'The autopilot is disabled on this instance (AUTOPILOT_ENABLED)' : "I'm away: let the agents keep working within limits"}
        onClick={() => setOpen(true)}
      >
        <span className="hidden md:inline">Autopilot</span>
        <span className="sr-only md:hidden">Autopilot</span>
      </Button>
      {open && config.data ? <StartAutopilotDialog config={config.data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function effectiveLevel(projectLevel: number, config: AutopilotConfig): number {
  return Math.max(0, Math.min(projectLevel, config.maxAutonomy, 3));
}

export function StartAutopilotDialog({ config, onClose }: { config: AutopilotConfig; onClose: () => void }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const baseId = useId();
  const projects = useApi<{ projects: ProjectListItem[] }>('/api/projects');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hours, setHours] = useState(10);
  const [budget, setBudget] = useState(5);
  const [maxTaskRisk, setMaxTaskRisk] = useState<'low' | 'medium'>('medium');
  const [maxParkedRuns, setMaxParkedRuns] = useState(3);
  const [quiet, setQuiet] = useState(false);
  const [quietFrom, setQuietFrom] = useState('22:00');
  const [quietTo, setQuietTo] = useState('07:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selected.size === 0) {
      setError('Choose at least one project.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ session: AutopilotSessionView }>('/api/autopilot/sessions', {
        method: 'POST',
        body: {
          projectIds: [...selected],
          durationHours: hours,
          budgetUsd: budget,
          maxTaskRisk,
          maxParkedRuns,
          quietHours: quiet ? { timeZone, windows: [{ from: quietFrom, to: quietTo }] } : null,
        },
      });
      onClose();
      router.push(`/autopilot/${result.session.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const endsAt = new Date(Date.now() + hours * 3_600_000);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto rounded-[10px] border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/40"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-ink">
              <Plane aria-hidden="true" size={16} className="text-accent" />
              Start the autopilot
            </h2>
            <p className="mt-1 text-[13px] text-ink-2">
              While you are away, agents keep working on existing ready tasks within a time box and a budget. Anything gated is parked for you.
            </p>
          </div>
          <IconButton icon={X} label="Close" onClick={() => dialogRef.current?.close()} />
        </header>

        <div className="flex flex-col gap-5 px-5 py-4">
          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-ink-2">Projects</legend>
            {!projects.data ? (
              <p className="mt-2 text-[13px] text-ink-2">{projects.error ?? 'Loading projects…'}</p>
            ) : projects.data.projects.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-2">No projects yet.</p>
            ) : (
              <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
                {projects.data.projects.map((project) => {
                  const inputId = `${baseId}-project-${project.id}`;
                  const effective = effectiveLevel(project.autonomyLevel, config);
                  return (
                    <li key={project.id}>
                      <label htmlFor={inputId} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-surface-2">
                        <input id={inputId} type="checkbox" checked={selected.has(project.id)} onChange={() => toggle(project.id)} className="h-4 w-4 accent-[var(--accent-strong)]" />
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">{project.name}</span>
                        <span className="tabular text-xs text-ink-2" title="Autonomy is capped for the session and never raised">
                          Autonomy {project.autonomyLevel}
                          {effective !== project.autonomyLevel ? ` → ${effective} in session` : ''}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time box" htmlFor={`${baseId}-hours`} hint={`Ends ${endsAt.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · max ${config.maxHours} h`}>
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label="Duration presets" className="inline-flex gap-1">
                  {DURATION_PRESETS.filter((preset) => preset <= config.maxHours).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={hours === preset}
                      onClick={() => setHours(preset)}
                      className={cx(
                        'h-8 rounded-md border px-2.5 text-[13px] transition-[background-color,border-color] duration-150 ease-out pointer-coarse:h-9',
                        hours === preset ? 'border-accent-strong bg-accent-soft font-medium text-ink' : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2',
                      )}
                    >
                      {preset} h
                    </button>
                  ))}
                </div>
                <input
                  id={`${baseId}-hours`}
                  type="number"
                  min={0.25}
                  max={config.maxHours}
                  step={0.25}
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                  className={cx(inputClass, 'w-24')}
                />
              </div>
            </Field>
            <Field label="Budget (USD)" htmlFor={`${baseId}-budget`} hint={`At 90 % nothing new starts; at 100 % the session stops · max ${formatUsd(config.maxBudgetUsd)}`}>
              <input id={`${baseId}-budget`} type="number" min={0.01} max={config.maxBudgetUsd} step={0.5} value={budget} onChange={(e) => setBudget(Number(e.target.value))} className={inputClass} />
            </Field>
            <Field label="Tasks the autopilot may pick up" htmlFor={`${baseId}-risk`} hint="High-risk and security tasks are never picked up.">
              <select id={`${baseId}-risk`} value={maxTaskRisk} onChange={(e) => setMaxTaskRisk(e.target.value === 'low' ? 'low' : 'medium')} className={inputClass}>
                <option value="medium">Low and medium risk</option>
                <option value="low">Low risk only</option>
              </select>
            </Field>
            <Field label="Parked runs per project" htmlFor={`${baseId}-parked`} hint="No new run starts in a project once this many wait for you.">
              <input id={`${baseId}-parked`} type="number" min={1} max={10} step={1} value={maxParkedRuns} onChange={(e) => setMaxParkedRuns(Number(e.target.value))} className={inputClass} />
            </Field>
          </div>

          <fieldset className="min-w-0">
            <legend className="sr-only">Quiet hours</legend>
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="h-4 w-4 accent-[var(--accent-strong)]" />
              Quiet hours (no new runs start)
            </label>
            {quiet ? (
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <Field label="From" htmlFor={`${baseId}-quiet-from`}>
                  <input id={`${baseId}-quiet-from`} type="time" value={quietFrom} onChange={(e) => setQuietFrom(e.target.value)} className={cx(inputClass, 'w-32')} />
                </Field>
                <Field label="To" htmlFor={`${baseId}-quiet-to`}>
                  <input id={`${baseId}-quiet-to`} type="time" value={quietTo} onChange={(e) => setQuietTo(e.target.value)} className={cx(inputClass, 'w-32')} />
                </Field>
                <p className="pb-2 text-xs text-ink-2">Time zone {timeZone}</p>
              </div>
            ) : null}
          </fieldset>

          <section aria-labelledby={`${baseId}-parked-heading`} className="rounded-md border border-line bg-surface-2 px-4 py-3">
            <h3 id={`${baseId}-parked-heading`} className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              <ShieldCheck aria-hidden="true" size={14} className="text-good" />
              Always parked for a human
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-2">
              {config.parkedForHumans.map((item) => (
                <li key={item}>{item}</li>
              ))}
              <li>
                Parked approvals stay valid until the session ends plus {config.returnGraceHours} h (at least {config.approvalTtlHours} h). Parked runs free their slot, so other work continues.
              </li>
              <li>Stops automatically on time, budget, repeated failed runs, a red CI streak, unusual spend, or security denials (kill).</li>
            </ul>
          </section>

          {error ? (
            <p role="alert" className="flex items-start gap-1.5 text-[13px] text-ink">
              <ToneIcon tone="critical" className="mt-0.5" />
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={Plane} busy={busy} disabled={selected.size === 0}>
            Start autopilot
          </Button>
        </footer>
      </form>
    </dialog>
  );
}

export function sessionStopText(session: Pick<AutopilotSessionView, 'status' | 'stopReason' | 'stoppedBy'>): string {
  if (session.status === 'active') return 'Running';
  const reason = session.stopReason ? humanize(session.stopReason) : 'Stopped';
  return session.stoppedBy ? `${reason} · ${session.stoppedBy}` : reason;
}
