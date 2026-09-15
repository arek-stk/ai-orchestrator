'use client';

import { ArrowLeft, Check, CircleCheck, FlaskConical, KeyRound, LoaderCircle, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { HubError, validateBaseUrl, type HubService } from '@/lib/hub/service';
import { INTEGRATION_LABELS, type AIConnection, type AITool, type ModelList } from '@/lib/hub/types';
import { cx } from '../ui';
import { ActionArrow, actionBase, actionClass } from './AICard';
import { useDialog } from './hooks';
import { LogoTile } from './primitives';

const STEPS = ['Verbindung herstellen', 'Berechtigungen', 'Modell auswählen', 'Fertig'] as const;

export function Stepper({ current }: { current: number }) {
  return (
    <div>
      <ol aria-label="Fortschritt" className="grid grid-cols-4 gap-2">
        {STEPS.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={label} aria-current={active ? 'step' : undefined} className="min-w-0">
              <div className={cx('h-1 rounded-full transition-[background-color] duration-300 ease-out', index <= current ? 'bg-hub-cta' : 'bg-hub-card-2')} />
              <div className="mt-2 flex items-start gap-1.5">
                <span
                  aria-hidden="true"
                  className={cx(
                    'tabular inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                    done ? 'bg-hub-cta text-white' : active ? 'border border-hub-cta text-ink' : 'border border-hub-line-strong text-ink-2',
                  )}
                >
                  {done ? <Check size={12} strokeWidth={3} /> : index + 1}
                </span>
                <span aria-hidden="true" className={cx('hidden pt-0.5 text-[11.5px] leading-tight sm:inline', active ? 'font-medium text-ink' : 'text-ink-2')}>
                  {label}
                </span>
                <span className="sr-only">
                  {label}
                  {done ? ' (abgeschlossen)' : ''}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <p aria-hidden="true" className="mt-2 text-xs text-ink-2 sm:hidden">
        Schritt {current + 1} von {STEPS.length}: <span className="font-medium text-ink">{STEPS[current]}</span>
      </p>
    </div>
  );
}

function Callout({ tone, icon: Icon, title, children }: { tone: 'info' | 'warning' | 'critical'; icon: typeof Check; title: string; children: ReactNode }) {
  return (
    <div className={cx('flex gap-3 rounded-2xl px-4 py-3', tone === 'info' ? 'border border-hub-line bg-hub-card-2' : tone === 'warning' ? 'bg-warning-soft' : 'bg-critical-soft')}>
      <Icon aria-hidden="true" size={17} className={cx('mt-0.5 shrink-0', tone === 'info' ? 'text-ink-2' : tone === 'warning' ? 'text-warning' : 'text-critical')} />
      <div className="min-w-0 text-[13px] text-ink">
        <p className="font-medium">{title}</p>
        <div className="mt-0.5 text-ink-2">{children}</div>
      </div>
    </div>
  );
}

const fieldClass =
  'h-11 w-full min-w-0 rounded-xl border bg-hub-card-2 px-3 text-[14px] text-ink transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-ink-2 focus-visible:border-hub-cta focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-hub-cta/20 disabled:opacity-60';

function ConnectDialog({ tool, service, connection, onClose, onConnected }: { tool: AITool; service: HubService; connection: AIConnection | undefined; onClose: () => void; onConnected: (connection: AIConnection) => void }) {
  const requirements = service.connectRequirements(tool);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const keyId = useId();
  const urlId = useId();
  const keyErrorId = useId();
  const urlErrorId = useId();

  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(requirements.kind === 'credentials' ? (requirements.baseUrl ?? '') : '');
  const [demoAck, setDemoAck] = useState(false);
  const [allowAgents, setAllowAgents] = useState(true);
  const [errors, setErrors] = useState<{ apiKey?: string; baseUrl?: string; ack?: string; agents?: string }>({});
  const [models, setModels] = useState<ModelList | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(connection?.selectedModel ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<AIConnection | null>(null);
  const firstRender = useRef(true);

  useDialog({ open: true, containerRef: dialogRef, onClose, closeOnEscape: !submitting });

  useEffect(() => {
    let cancelled = false;
    service
      .listModels(tool.id)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel((current) => (current && list.models.some((model) => model.id === current) ? current : (list.models[0]?.id ?? null)));
      })
      .catch(() => !cancelled && setModels({ source: 'none', models: [] }));
    return () => {
      cancelled = true;
    };
  }, [service, tool.id]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // The key only lives in this component's state and is dropped on success and unmount.
  useEffect(() => () => setApiKey(''), []);

  const blocked = requirements.kind === 'forbidden' || requirements.kind === 'unsupported';

  const validateStep = (index: number): boolean => {
    const next: typeof errors = {};
    if (index === 0) {
      if (requirements.kind === 'demo' && !demoAck) next.ack = 'Bitte bestätige, dass es sich um eine Demo-Verbindung handelt.';
      if (requirements.kind === 'credentials') {
        const key = apiKey.trim();
        if (requirements.apiKey === 'required' && key.length === 0) next.apiKey = 'Bitte gib deinen API-Schlüssel ein.';
        else if (key.length > 0 && (key.length < 8 || /\s/.test(key))) next.apiKey = 'Der Schlüssel wirkt unvollständig. Bitte prüfe ihn.';
        if (requirements.baseUrl !== null) {
          const problem = validateBaseUrl(baseUrl);
          if (problem) next.baseUrl = problem;
        }
      }
    }
    if (index === 1 && !allowAgents) next.agents = 'Ohne diese Berechtigung kann der Orchestrator den Zugang nicht nutzen.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const connected = await service.connect({
        toolId: tool.id,
        selectedModel,
        ...(requirements.kind === 'credentials' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(requirements.kind === 'credentials' && requirements.baseUrl !== null ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey('');
      setResult(connected);
      setStep(3);
      onConnected(connected);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Die Verbindung ist fehlgeschlagen.';
      if (error instanceof HubError && error.code === 'validation') {
        setErrors({ apiKey: message });
        setStep(0);
      } else {
        setSubmitError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting || blocked) return;
    if (step < 2) {
      if (validateStep(step)) setStep(step + 1);
      return;
    }
    if (step === 2) void submit();
  };

  const heading = (text: string) => (
    <h3 ref={stepHeadingRef} tabIndex={-1} className="text-[15px] font-semibold text-ink focus-visible:outline-none">
      {text}
    </h3>
  );

  let body: ReactNode;
  if (step === 0) {
    body = (
      <div className="flex flex-col gap-4">
        {heading('Verbindung herstellen')}
        {requirements.kind === 'unsupported' ? (
          <Callout tone="info" icon={ShieldAlert} title="Verbinden ist nicht möglich">
            {requirements.reason}
          </Callout>
        ) : requirements.kind === 'forbidden' ? (
          <Callout tone="warning" icon={ShieldAlert} title="Admin-Rolle erforderlich">
            {requirements.reason}
          </Callout>
        ) : requirements.kind === 'demo' ? (
          <>
            <Callout tone="info" icon={FlaskConical} title="Demo-Verbindung">
              Diese Verbindung wird nur simuliert und in diesem Browser gespeichert. Es werden keine Zugangsdaten abgefragt oder gespeichert, und der Orchestrator nutzt weiterhin seine
              Mock-Modelle.
            </Callout>
            <div>
              <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={demoAck}
                  onChange={(event) => setDemoAck(event.target.checked)}
                  aria-invalid={errors.ack ? true : undefined}
                  aria-describedby={errors.ack ? keyErrorId : undefined}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hub-cta)]"
                />
                Ich verstehe, dass dies eine simulierte Verbindung ist.
              </label>
              {errors.ack ? (
                <p id={keyErrorId} className="mt-1 text-xs text-critical">
                  {errors.ack}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">
              {connection && connection.status !== 'available' ? 'Ein gespeicherter Zugang wird ersetzt. ' : ''}
              Der Schlüssel wird nur an deinen Orchestrator-Server gesendet und dort verschlüsselt gespeichert (AES-256-GCM). Er wird weder im Browser gespeichert noch erneut angezeigt.
            </p>
            {requirements.baseUrl !== null ? (
              <div>
                <label htmlFor={urlId} className="text-xs font-medium text-ink-2">
                  Basis-URL
                </label>
                <input
                  id={urlId}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  aria-invalid={errors.baseUrl ? true : undefined}
                  aria-describedby={errors.baseUrl ? urlErrorId : undefined}
                  className={cx(fieldClass, 'mt-1 font-mono text-[13px]', errors.baseUrl ? 'border-critical' : 'border-hub-line')}
                />
                {errors.baseUrl ? (
                  <p id={urlErrorId} className="mt-1 text-xs text-critical">
                    {errors.baseUrl}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-ink-2">OpenAI-kompatibler Endpunkt von {tool.provider}, laut offizieller Dokumentation.</p>
                )}
              </div>
            ) : null}
            <div>
              <label htmlFor={keyId} className="text-xs font-medium text-ink-2">
                API-Schlüssel{requirements.apiKey === 'optional' ? ' (optional)' : ''}
              </label>
              <div className="relative mt-1">
                <KeyRound aria-hidden="true" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
                <input
                  id={keyId}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  aria-invalid={errors.apiKey ? true : undefined}
                  aria-describedby={errors.apiKey ? keyErrorId : undefined}
                  placeholder={requirements.apiKey === 'optional' ? 'Für lokale Instanzen meist nicht nötig' : 'Schlüssel einfügen'}
                  className={cx(fieldClass, 'pl-9 font-mono text-[13px]', errors.apiKey ? 'border-critical' : 'border-hub-line')}
                />
              </div>
              {errors.apiKey ? (
                <p id={keyErrorId} className="mt-1 text-xs text-critical">
                  {errors.apiKey}
                </p>
              ) : tool.docsUrl ? (
                <p className="mt-1 text-xs text-ink-2">
                  Den Schlüssel erstellst du im Konto bei {tool.provider}.{' '}
                  <a href={tool.docsUrl} target="_blank" rel="noopener noreferrer" className="text-link underline-offset-2 hover:underline">
                    Dokumentation<span className="sr-only"> (öffnet in neuem Tab)</span>
                  </a>
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  } else if (step === 1) {
    body = (
      <div className="flex flex-col gap-4">
        {heading('Berechtigungen')}
        <div className="flex flex-col gap-1 rounded-2xl border border-hub-line p-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2.5 transition-[background-color] duration-150 ease-out hover:bg-hub-card-2">
            <input
              type="checkbox"
              checked={allowAgents}
              onChange={(event) => setAllowAgents(event.target.checked)}
              aria-invalid={errors.agents ? true : undefined}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hub-cta)]"
            />
            <span className="text-[13px]">
              <span className="font-medium text-ink">Agenten dürfen Modelle dieses Zugangs aufrufen</span>
              <span className="mt-0.5 block text-ink-2">Der Orchestrator wählt pro Aufgabe das passende Modell. Budgets und Freigaben gelten weiterhin.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-xl px-2 py-2.5">
            <input type="checkbox" checked disabled className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hub-cta)]" />
            <span className="text-[13px]">
              <span className="font-medium text-ink">Aufrufe werden im Nutzungs- und Kostenprotokoll erfasst</span>
              <span className="mt-0.5 block text-ink-2">Immer aktiv, damit Kosten nachvollziehbar bleiben.</span>
            </span>
          </label>
        </div>
        {errors.agents ? <p className="text-xs text-critical">{errors.agents}</p> : null}
        <p className="text-xs text-ink-2">
          {service.mode === 'demo'
            ? 'Simuliert: Es werden keine echten Modellaufrufe ausgeführt.'
            : 'Provider-Zugänge gelten für alle Projekte. Die Änderung wird im Audit-Log protokolliert.'}
        </p>
      </div>
    );
  } else if (step === 2) {
    body = (
      <div className="flex flex-col gap-4">
        {heading('Modell auswählen')}
        {!models ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-2">
            <LoaderCircle aria-hidden="true" size={15} className="animate-spin" /> Modelle werden geladen …
          </div>
        ) : models.models.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            {service.mode === 'live' ? 'Für diesen Zugang sind noch keine Modelle in der Registry. Du kannst sie später in den Einstellungen anlegen.' : (tool.modelsNote ?? 'Keine Modellangaben hinterlegt.')}
          </p>
        ) : (
          <fieldset>
            <legend className="text-xs text-ink-2">
              {models.source === 'registry' ? 'Modelle aus der Registry des Orchestrators' : 'Beispiele – welche Modelle verfügbar sind, hängt von deinem Zugang ab'}
            </legend>
            <div className="mt-2 flex flex-col gap-1.5">
              {models.models.map((model) => (
                <label
                  key={model.id}
                  className={cx(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-[border-color,background-color] duration-150 ease-out',
                    selectedModel === model.id ? 'border-hub-cta bg-hub-card-2' : 'border-hub-line hover:border-hub-line-strong',
                  )}
                >
                  <input type="radio" name="hub-model" checked={selectedModel === model.id} onChange={() => setSelectedModel(model.id)} disabled={submitting} className="h-4 w-4 shrink-0 accent-[var(--hub-cta)]" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{model.label}</span>
                  {model.note ? <span className="shrink-0 truncate text-xs text-ink-2">{model.note}</span> : null}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-2">Die Auswahl ist das Standardmodell für die Anzeige im Hub. Welche Modelle Agenten nutzen, steuert der Orchestrator über Routing und Rollen-Overrides.</p>
          </fieldset>
        )}
        {submitError ? (
          <div role="alert">
            <Callout tone="critical" icon={TriangleAlert} title="Verbindung fehlgeschlagen">
              {submitError}
            </Callout>
          </div>
        ) : null}
      </div>
    );
  } else {
    const usable = result?.orchestratorEnabled === true;
    body = (
      <div className="flex flex-col items-center py-4 text-center">
        <span aria-hidden="true" className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-hub-connected-soft text-hub-connected">
          <CircleCheck size={28} />
        </span>
        <h3 ref={stepHeadingRef} tabIndex={-1} className="mt-4 text-[17px] font-semibold text-ink focus-visible:outline-none">
          {tool.name} wurde erfolgreich verbunden
        </h3>
        <p className="mt-1.5 max-w-sm text-[13px] text-ink-2">
          {result?.demo
            ? 'Demo-Verbindung: Im Orchestrator laufen Agenten weiterhin mit Mock-Modellen.'
            : usable
              ? 'Der Orchestrator kann ab sofort Modelle dieses Zugangs verwenden.'
              : (result?.detail ?? 'Der Zugang ist gespeichert.')}
        </p>
        {!result?.demo && !usable ? (
          <Link href="/settings" className="mt-2 text-[13px] text-link underline-offset-2 hover:underline">
            Modelle in den Einstellungen anlegen
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div aria-hidden="true" className="hub-fade-enter absolute inset-0 bg-[var(--hub-backdrop)] backdrop-blur-[2px]" onClick={() => !submitting && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="hub-modal-enter relative flex h-[100dvh] w-full flex-col overflow-hidden border-hub-line-strong bg-hub-card shadow-pop focus-visible:outline-none sm:h-auto sm:max-h-[min(760px,calc(100dvh-3rem))] sm:max-w-[560px] sm:rounded-3xl sm:border"
      >
        <div className="px-5 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6 sm:pt-6">
          <div className="flex items-start gap-3">
            <LogoTile logo={tool.logo} name={tool.name} />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[18px] font-semibold leading-6 tracking-[-0.015em] text-ink">
                {tool.name} verbinden
              </h2>
              <p id={descriptionId} className="text-[13px] text-ink-2">
                {tool.provider} · {INTEGRATION_LABELS[tool.integration]}
                {service.mode === 'demo' ? ' · Demo' : ''}
              </p>
            </div>
            <button
              type="button"
              aria-label="Dialog schließen"
              onClick={onClose}
              disabled={submitting}
              className="-mr-1.5 -mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink disabled:opacity-50"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <div className="mt-5">
            <Stepper current={step} />
          </div>
        </div>

        <form id={`${titleId}-form`} onSubmit={onSubmit} noValidate className="min-h-0 flex-1 overflow-y-auto border-t border-hub-line px-5 py-5 sm:px-6" aria-busy={submitting}>
          {body}
        </form>

        <div className="flex items-center justify-between gap-2 border-t border-hub-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
          {step === 3 ? (
            <>
              <button type="button" onClick={onClose} className={cx(actionBase, 'text-ink-2 hover:bg-hub-card-2 hover:text-ink')}>
                Schließen
              </button>
              <Link href="/" className={cx(actionBase, actionClass.connect)}>
                Zum AI Orchestrator
                <ActionArrow />
              </Link>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={submitting} className={cx(actionBase, 'text-ink-2 hover:bg-hub-card-2 hover:text-ink disabled:opacity-50')}>
                Abbrechen
              </button>
              <div className="flex items-center gap-2">
                {step > 0 ? (
                  <button type="button" onClick={() => setStep(step - 1)} disabled={submitting} className={cx(actionBase, actionClass.details, 'disabled:opacity-50')}>
                    <ArrowLeft aria-hidden="true" size={14} />
                    Zurück
                  </button>
                ) : null}
                {requirements.kind === 'unsupported' ? (
                  <a href={tool.website} target="_blank" rel="noopener noreferrer" className={cx(actionBase, actionClass.learn)}>
                    Mehr erfahren
                    <ActionArrow external />
                    <span className="sr-only">(öffnet in neuem Tab)</span>
                  </a>
                ) : (
                  <button type="submit" form={`${titleId}-form`} disabled={blocked || submitting || (step === 2 && !models)} className={cx(actionBase, actionClass.connect, 'min-w-[7.5rem] disabled:opacity-50')}>
                    {submitting ? (
                      <>
                        <LoaderCircle aria-hidden="true" size={14} className="animate-spin" />
                        Verbinde …
                      </>
                    ) : step === 2 ? (
                      <>
                        Verbinden
                        <ActionArrow />
                      </>
                    ) : (
                      'Weiter'
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {submitting ? `${tool.name} wird verbunden …` : `Schritt ${step + 1} von ${STEPS.length}: ${STEPS[step]}`}
        </p>
      </div>
    </div>
  );
}

export function ConnectModal({ tool, ...props }: { tool: AITool | null; service: HubService; connection: AIConnection | undefined; onClose: () => void; onConnected: (connection: AIConnection) => void }) {
  if (!tool) return null;
  return <ConnectDialog key={tool.id} tool={tool} {...props} />;
}
