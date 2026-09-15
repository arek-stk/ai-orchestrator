'use client';

import { ArrowUpRight, Check, ChevronDown, CircleAlert, Info, MousePointerClick, Settings2, Unplug, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { supportsOrchestrator } from '@/lib/hub/filter';
import { formatCompactDe, formatCountDe, formatShareDe, formatUsdDe } from '@/lib/hub/format';
import { API_LABELS, connectionBadge, orchestratorState, primaryAction } from '@/lib/hub/presentation';
import type { HubService } from '@/lib/hub/service';
import { CATEGORY_LABELS, INTEGRATION_LABELS, type AIConnection, type AITool, type ModelList, type ToolUsage } from '@/lib/hub/types';
import { cx, Skeleton } from '../ui';
import { ActionArrow, actionBase, actionClass } from './AICard';
import { useDialog } from './hooks';
import { HubMark, LogoTile, StatePill, TONE_TEXT_CLASS } from './primitives';

export interface DetailPanelProps {
  tool: AITool | null;
  connection: AIConnection | undefined;
  service: HubService;
  /** Bumped whenever connections change, so models and usage reload. */
  version: number;
  focusSection: 'connection' | null;
  focusNonce: number;
  canDisconnect: boolean;
  onClose: () => void;
  onConnect: (tool: AITool) => void;
  onDisconnect: (tool: AITool) => void;
  onSelectModel: (tool: AITool, modelId: string) => void;
}

function Section({ title, children, id, headingRef }: { title: string; children: ReactNode; id?: string; headingRef?: React.Ref<HTMLHeadingElement> }) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-4 border-t border-hub-line pt-5">
      <h3 ref={headingRef} id={headingId} tabIndex={headingRef ? -1 : undefined} className="text-[13px] font-semibold text-ink focus-visible:outline-none">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'warning'; children: ReactNode }) {
  const Icon = tone === 'warning' ? CircleAlert : Info;
  return (
    <div className={cx('flex gap-2.5 rounded-xl px-3 py-2.5 text-[13px] leading-snug text-ink', tone === 'warning' ? 'bg-warning-soft' : 'bg-hub-card-2 border border-hub-line')}>
      <Icon aria-hidden="true" size={15} className={cx('mt-0.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-ink-2')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx(actionBase, actionClass.learn, className)}>
      {children}
      <ActionArrow external />
      <span className="sr-only">(öffnet in neuem Tab)</span>
    </a>
  );
}

function useToolData(service: HubService, tool: AITool | null, version: number) {
  const [models, setModels] = useState<{ toolId: string; list: ModelList } | null>(null);
  const [usage, setUsage] = useState<{ toolId: string; state: 'ready' | 'error'; value: ToolUsage | null } | null>(null);
  const [retry, setRetry] = useState(0);
  const toolId = tool?.id ?? null;

  useEffect(() => {
    if (!toolId) return;
    let cancelled = false;
    service
      .listModels(toolId)
      .then((list) => !cancelled && setModels({ toolId, list }))
      .catch(() => !cancelled && setModels({ toolId, list: { source: 'none', models: [] } }));
    service
      .getUsage(toolId)
      .then((value) => !cancelled && setUsage({ toolId, state: 'ready', value }))
      .catch(() => !cancelled && setUsage({ toolId, state: 'error', value: null }));
    return () => {
      cancelled = true;
    };
  }, [service, toolId, version, retry]);

  return {
    models: models?.toolId === toolId ? models.list : null,
    usage: usage?.toolId === toolId ? usage : null,
    retryUsage: () => {
      setUsage(null);
      setRetry((value) => value + 1);
    },
  };
}

function ModelsSection({ tool, connection, models, onSelectModel }: { tool: AITool; connection: AIConnection | undefined; models: ModelList | null; onSelectModel: (modelId: string) => void }) {
  const selectId = useId();
  if (!models) {
    return (
      <Section title="Modelle">
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="mt-2 h-4 w-2/3" />
      </Section>
    );
  }
  if (models.models.length === 0) {
    return (
      <Section title="Modelle">
        <p className="text-[13px] text-ink-2">{tool.modelsNote ?? 'Für dieses Tool sind keine Modellangaben hinterlegt.'}</p>
      </Section>
    );
  }
  const connected = connection?.status === 'connected';
  const selected = models.models.find((model) => model.id === connection?.selectedModel) ?? (connected ? models.models[0] : undefined);
  const others = models.models.filter((model) => model.id !== selected?.id);
  const sourceHint = models.source === 'registry' ? 'Aus der Modell-Registry des Orchestrators.' : 'Beispiele. Welche Modelle verfügbar sind, hängt von deinem Zugang ab.';

  return (
    <Section title="Modelle">
      {connected && selected ? (
        <div>
          <label htmlFor={selectId} className="text-xs text-ink-2">
            Standardmodell im Hub
          </label>
          <div className="relative mt-1">
            <select
              id={selectId}
              value={selected.id}
              onChange={(event) => onSelectModel(event.target.value)}
              className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-hub-line bg-hub-card-2 pl-3 pr-9 text-[13px] text-ink transition-[border-color] duration-150 ease-out hover:border-hub-line-strong focus-visible:border-hub-cta"
            >
              {models.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2" />
          </div>
          {models.source === 'registry' ? <p className="mt-1.5 text-xs text-ink-2">Welche Modelle Agenten nutzen, entscheidet der Orchestrator über Routing und Rollen-Overrides.</p> : null}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className={connected && selected ? 'mt-4' : undefined}>
          {connected && selected ? <p className="text-xs text-ink-2">Weitere Modelle</p> : null}
          <ul className="mt-1.5 divide-y divide-hub-line overflow-hidden rounded-xl border border-hub-line">
            {others.slice(0, 6).map((model) => (
              <li key={model.id} className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-ink">{model.label}</span>
                {model.note ? <span className="shrink-0 truncate text-xs text-ink-2">{model.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
        {models.source === 'examples' ? <span className="rounded-md border border-hub-line px-1.5 py-px text-[11px] font-medium">Beispiele</span> : null}
        {sourceHint}
      </p>
    </Section>
  );
}

function UsageSection({ service, usage, onRetry }: { service: HubService; usage: { state: 'ready' | 'error'; value: ToolUsage | null } | null; onRetry: () => void }) {
  if (!usage) {
    return (
      <Section title="Nutzung">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-2 rounded-full" />
      </Section>
    );
  }
  if (usage.state === 'error') {
    return (
      <Section title="Nutzung">
        <p className="text-[13px] text-ink-2">Nutzungsdaten konnten nicht geladen werden.</p>
        <button type="button" onClick={onRetry} className="mt-2 inline-flex h-9 items-center rounded-lg px-2 text-[13px] font-medium text-ink underline-offset-2 hover:underline">
          Erneut versuchen
        </button>
      </Section>
    );
  }
  const value = usage.value;
  if (!value) {
    return (
      <Section title="Nutzung">
        <div className="rounded-xl border border-dashed border-hub-line-strong px-3 py-3">
          <p className="text-[13px] font-medium text-ink">Noch keine Nutzungsdaten</p>
          <p className="mt-0.5 text-xs text-ink-2">
            {service.mode === 'demo' ? 'Im Demo-Modus werden keine Nutzungsdaten erfasst.' : 'Sobald Agenten Modelle dieses Zugangs nutzen, erscheinen hier Tokens und Kosten der letzten 30 Tage.'}
          </p>
        </div>
      </Section>
    );
  }
  const pct = Math.round(value.share * 1000) / 10;
  return (
    <Section title="Nutzung">
      <dl className="grid grid-cols-3 gap-2">
        {[
          { label: 'Tokens', text: formatCompactDe(value.tokens) },
          { label: 'Aufrufe', text: formatCountDe(value.calls) },
          { label: 'Kosten', text: formatUsdDe(value.costUsd) },
        ].map((item) => (
          <div key={item.label} className="min-w-0 rounded-xl bg-hub-card-2 px-2.5 py-2">
            <dt className="text-[11px] text-ink-2">{item.label}</dt>
            <dd className="tabular truncate text-[14px] font-semibold text-ink">{item.text}</dd>
          </div>
        ))}
      </dl>
      <div
        role="meter"
        aria-label="Anteil an den Modellkosten des Orchestrators"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={formatShareDe(value.share)}
        className="mt-3 h-2 overflow-hidden rounded-full bg-hub-card-2"
      >
        <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--hub-connected),var(--hub-cyan))]" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="tabular mt-1.5 text-xs text-ink-2">{formatShareDe(value.share)} der Modellkosten des Orchestrators · letzte {value.windowDays} Tage</p>
    </Section>
  );
}

function DetailContent({
  tool,
  connection,
  service,
  version,
  canDisconnect,
  onConnect,
  onDisconnect,
  onSelectModel,
  headingId,
  connectionHeadingRef,
  closeButton,
}: Omit<DetailPanelProps, 'tool' | 'onClose' | 'focusSection' | 'focusNonce'> & {
  tool: AITool;
  headingId: string;
  connectionHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  closeButton?: ReactNode;
}) {
  const { models, usage, retryUsage } = useToolData(service, tool, version);
  const badge = connectionBadge(tool, connection);
  const orchestrator = orchestratorState(tool, connection);
  const action = primaryAction(tool, connection);
  const requirements = service.connectRequirements(tool);
  const hasConnection = connection !== undefined && connection.status !== 'available';

  const scrollToConnection = () => {
    const heading = connectionHeadingRef.current;
    if (!heading) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3.5">
        <LogoTile logo={tool.logo} name={tool.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[19px] font-semibold leading-6 tracking-[-0.015em] text-ink">
            {tool.name}
          </h2>
          <p className="text-[13px] text-ink-2">{tool.provider}</p>
          <StatePill tone={badge.tone} label={badge.label} className="mt-2" />
        </div>
        {closeButton}
      </div>

      <p className="text-[14px] leading-relaxed text-ink-2">{tool.tagline}</p>

      <ul aria-label="Schlagwörter" className="-mt-1 flex flex-wrap gap-1.5">
        {tool.tags.map((tag) => (
          <li key={tag} className="inline-flex h-6 items-center rounded-md border border-hub-line bg-hub-card-2 px-2 text-[11.5px] text-ink-2">
            {tag}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        {action === 'connect' ? (
          <button type="button" onClick={() => onConnect(tool)} className={cx(actionBase, actionClass.connect, 'h-11 w-full')}>
            Jetzt verbinden
            <ActionArrow />
          </button>
        ) : action === 'manage' ? (
          <button type="button" onClick={scrollToConnection} className={cx(actionBase, actionClass.manage, 'h-11 w-full')}>
            <Settings2 aria-hidden="true" size={15} />
            Verbindung verwalten
          </button>
        ) : (
          <Notice tone="info">
            {tool.integration === 'planned'
              ? 'Die Integration in den Orchestrator ist geplant. Bis dahin nutzt du das Tool direkt beim Anbieter.'
              : tool.api === 'limited'
                ? 'Es gibt keine offene API, über die der Orchestrator das Tool nutzen könnte.'
                : 'Kein offizieller API-Zugang. Das Tool lässt sich nur direkt beim Anbieter nutzen.'}
          </Notice>
        )}
        <p className="flex items-center gap-1.5 text-xs">
          <span className="text-ink-2">Orchestrator:</span>
          <span className={cx('font-medium', TONE_TEXT_CLASS[orchestrator.tone])}>{orchestrator.label}</span>
        </p>
      </div>

      <Section title="Fähigkeiten">
        <ul className="flex flex-col gap-2">
          {tool.capabilities.map((capability) => (
            <li key={capability.label} className="flex gap-2.5 text-[13px] text-ink">
              <Check aria-hidden="true" size={15} strokeWidth={2.4} className="mt-0.5 shrink-0 text-hub-connected" />
              <span>
                {capability.label}
                {capability.detail ? <span className="text-ink-2"> · {capability.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <ModelsSection tool={tool} connection={connection} models={models} onSelectModel={(modelId) => onSelectModel(tool, modelId)} />

      {supportsOrchestrator(tool) ? <UsageSection service={service} usage={usage} onRetry={retryUsage} /> : null}

      <Section title="Details">
        <dl className="flex flex-col divide-y divide-hub-line text-[13px]">
          {[
            { label: 'Anbieter', value: tool.provider },
            { label: 'Kategorie', value: tool.categories.map((category) => CATEGORY_LABELS[category]).join(', ') },
            { label: 'API', value: API_LABELS[tool.api] },
            { label: 'Integration', value: INTEGRATION_LABELS[tool.integration] },
            { label: 'Preis', value: tool.pricing },
            { label: 'Status', value: badge.label },
          ].map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
              <dt className="shrink-0 text-ink-2">{row.label}</dt>
              <dd className="min-w-0 text-right text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {hasConnection ? (
        <Section title="Verbindung" headingRef={connectionHeadingRef}>
          <div className="flex flex-col gap-3">
            <dl className="flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Quelle</dt>
                <dd className="text-right text-ink">{connection?.demo ? 'Demo (dieser Browser)' : connection?.source === 'environment' ? 'Umgebungsvariablen des Servers' : 'Einstellungen (verschlüsselt)'}</dd>
              </div>
              {connection?.connectedAt ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-2">Verbunden seit</dt>
                  <dd className="tabular text-right text-ink">{new Date(connection.connectedAt).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}</dd>
                </div>
              ) : null}
            </dl>
            {connection?.detail ? <Notice tone="warning">{connection.detail}</Notice> : null}
            {connection?.source === 'environment' ? <Notice tone="info">Dieser Zugang ist über Umgebungsvariablen konfiguriert und lässt sich nur auf dem Server ändern.</Notice> : null}
            {requirements.kind === 'forbidden' ? <Notice tone="info">{requirements.reason}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              {requirements.kind === 'credentials' ? (
                <button type="button" onClick={() => onConnect(tool)} className={cx(actionBase, actionClass.details)}>
                  Zugang aktualisieren
                </button>
              ) : null}
              {canDisconnect ? (
                <button type="button" onClick={() => onDisconnect(tool)} className={cx(actionBase, 'border border-hub-line-strong text-ink hover:border-critical/50 hover:bg-critical-soft')}>
                  <Unplug aria-hidden="true" size={14} className="text-critical" />
                  Trennen
                </button>
              ) : null}
              {service.mode === 'live' ? (
                <Link href="/settings" className={cx(actionBase, 'text-ink-2 hover:bg-hub-card-2 hover:text-ink')}>
                  Provider & Modelle
                </Link>
              ) : null}
            </div>
          </div>
        </Section>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-hub-line pt-5">
        <ExternalLink href={tool.website} className="flex-1">
          Mehr erfahren
        </ExternalLink>
        {tool.docsUrl ? (
          <ExternalLink href={tool.docsUrl} className="flex-1">
            Dokumentation
          </ExternalLink>
        ) : null}
      </div>
    </div>
  );
}

function useConnectionFocus(focusSection: 'connection' | null, focusNonce: number, ref: React.RefObject<HTMLHeadingElement | null>) {
  useEffect(() => {
    if (focusSection !== 'connection' || focusNonce === 0) return;
    const frame = requestAnimationFrame(() => {
      const heading = ref.current;
      if (!heading) return;
      heading.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSection, focusNonce, ref]);
}

/** Persistent right column from 1280px. Shows a hint until a tool is selected. */
export function AIDetailPanelInline(props: DetailPanelProps & { onBrowse: () => void }) {
  const headingId = useId();
  const scrollRef = useRef<HTMLElement>(null);
  const connectionHeadingRef = useRef<HTMLHeadingElement>(null);
  useConnectionFocus(props.focusSection, props.focusNonce, connectionHeadingRef);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [props.tool?.id]);

  return (
    <aside
      ref={scrollRef}
      aria-label={props.tool ? `Details: ${props.tool.name}` : 'KI-Details'}
      className="sticky top-[76px] hidden max-h-[calc(100dvh-100px)] overflow-y-auto overscroll-contain rounded-3xl border border-hub-line bg-hub-card p-5 shadow-hub-card xl:block"
    >
      {props.tool ? (
        <div key={props.tool.id} className="hub-fade-enter">
          <DetailContent {...props} tool={props.tool} headingId={headingId} connectionHeadingRef={connectionHeadingRef} />
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 py-16 text-center">
          <HubMark size={48} />
          <h2 className="mt-4 text-[15px] font-semibold text-ink">Wähle eine KI aus</h2>
          <p className="mt-1 text-[13px] text-ink-2">Klicke auf eine Karte, um Fähigkeiten, Modelle, Nutzung und Verbindungsoptionen zu sehen.</p>
          <button type="button" onClick={props.onBrowse} className={cx(actionBase, actionClass.details, 'mt-5')}>
            <MousePointerClick aria-hidden="true" size={14} />
            Verbindbare KI anzeigen
          </button>
        </div>
      )}
    </aside>
  );
}

/** Slide-over from the right on tablets, full-screen sheet on phones. */
export function AIDetailPanelOverlay(props: DetailPanelProps & { tool: AITool }) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const connectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const initialFocusRef = props.focusSection === 'connection' ? connectionHeadingRef : closeRef;
  useDialog({ open: true, containerRef: dialogRef, onClose: props.onClose, initialFocusRef });

  return (
    <div className="fixed inset-0 z-50">
      <div aria-hidden="true" className="hub-fade-enter absolute inset-0 bg-[var(--hub-backdrop)]" onClick={props.onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="hub-panel-enter absolute inset-0 flex flex-col bg-hub-card shadow-pop focus-visible:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[440px] sm:border-l sm:border-hub-line-strong"
      >
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <DetailContent
            {...props}
            headingId={headingId}
            connectionHeadingRef={connectionHeadingRef}
            closeButton={
              <button
                ref={closeRef}
                type="button"
                aria-label="Details schließen"
                onClick={props.onClose}
                className="-mr-1.5 -mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink"
              >
                <X aria-hidden="true" size={18} />
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
