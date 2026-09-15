'use client';

import { FlaskConical, Info, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHubService } from '@/lib/hub/create-service';
import { applyHubQuery, categoryCounts, isOrchestratorUsable, subcategoryCounts, type ConnectionMap } from '@/lib/hub/filter';
import type { HubMode } from '@/lib/hub/service';
import { DEFAULT_FILTERS, DEFAULT_QUERY, type AIConnection, type AITool, type HubQuery } from '@/lib/hub/types';
import { parseHubQuery, serializeHubQuery } from '@/lib/hub/url-state';
import { hasRole, useSession } from '../providers';
import { cx } from '../ui';
import { ActionArrow, actionBase, actionClass } from './AICard';
import { AICardGrid } from './AICardGrid';
import { AIDetailPanelInline, AIDetailPanelOverlay } from './AIDetailPanel';
import { CategoryFilter } from './CategoryFilter';
import { ConfirmDialog } from './ConfirmDialog';
import { ConnectedAI } from './ConnectedAI';
import { ConnectModal } from './ConnectModal';
import { FilterPopover } from './FilterPopover';
import { useMediaQuery } from './hooks';
import { HubHeader } from './HubHeader';
import { HubHero } from './HubHero';
import { HubCardSkeletons, HubEmptyState, HubErrorState } from './HubStates';
import { HubMark } from './primitives';
import { SearchBar } from './SearchBar';
import { SortSelect } from './SortSelect';

interface Selection {
  id: string;
  /** `auto` = preselected for the persistent panel; only user selections open the overlay on narrow screens. */
  origin: 'auto' | 'user';
  section: 'connection' | null;
  nonce: number;
}

function isDefaultQuery(query: HubQuery): boolean {
  return serializeHubQuery(query) === '';
}

export function AIHub() {
  const params = useSearchParams();
  const { user, health } = useSession();
  const canManage = hasRole(user, 'admin');
  const sourceParam = params.get('source');
  const mode: HubMode = sourceParam === 'demo' || sourceParam === 'live' ? sourceParam : health?.demoMode ? 'demo' : 'live';
  const simulateError = params.get('simulateError') === '1';
  const service = useMemo(() => createHubService({ mode, canManage, ...(simulateError ? { failureRate: 1 } : {}) }), [mode, canManage, simulateError]);

  const [query, setQuery] = useState<HubQuery>(() => parseHubQuery(params));
  const [tools, setTools] = useState<AITool[]>([]);
  const [connections, setConnections] = useState<ConnectionMap>(() => new Map());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [reloading, setReloading] = useState(false);
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<{ id: string; busy: boolean; error: string | null } | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [shortcutLabel, setShortcutLabel] = useState('Strg K');

  const isWide = useMediaQuery('(min-width: 1280px)');
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestRef = useRef(0);
  const autoSelected = useRef(false);
  const focusFirstCard = useRef(false);

  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setReloading(true);
    try {
      const [nextTools, nextConnections] = await Promise.all([service.listTools(), service.listConnections()]);
      if (request !== requestRef.current) return;
      setTools(nextTools);
      setConnections(new Map(nextConnections.map((connection) => [connection.toolId, connection])));
      setStatus('ready');
      setVersion((value) => value + 1);
    } catch (error) {
      if (request !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : 'Unbekannter Fehler.');
      setStatus('error');
    } finally {
      if (request === requestRef.current) setReloading(false);
    }
  }, [service]);

  useEffect(() => {
    setStatus('loading');
    autoSelected.current = false;
    void load();
  }, [load]);

  const refreshConnections = useCallback(async () => {
    try {
      const next = await service.listConnections();
      setConnections(new Map(next.map((connection) => [connection.toolId, connection])));
      setVersion((value) => value + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Verbindungen konnten nicht aktualisiert werden.');
    }
  }, [service, notify]);

  // Shareable URL state, debounced so typing does not flood history.replaceState.
  useEffect(() => {
    const current = window.location.search.replace(/^\?/, '');
    const next = serializeHubQuery(query, new URLSearchParams(current));
    if (next === current) return;
    const handle = window.setTimeout(() => window.history.replaceState(window.history.state, '', `${window.location.pathname}${next ? `?${next}` : ''}`), 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcutLabel('⌘K');
  }, []);

  const focusSearch = useCallback(() => {
    const input = searchRef.current;
    if (!input) return;
    input.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusSearch]);

  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(handle);
  }, [toast]);

  const visible = useMemo(() => applyHubQuery(tools, connections, query), [tools, connections, query]);
  const counts = useMemo(() => categoryCounts(tools, connections, query), [tools, connections, query]);
  const subCounts = useMemo(() => subcategoryCounts(tools, connections, query), [tools, connections, query]);
  const connectedCount = useMemo(() => tools.filter((tool) => connections.get(tool.id)?.status === 'connected').length, [tools, connections]);
  const usableCount = useMemo(() => tools.filter((tool) => isOrchestratorUsable(tool, connections.get(tool.id))).length, [tools, connections]);

  // Preselect the first connected tool once for the persistent panel.
  useEffect(() => {
    if (status !== 'ready' || autoSelected.current) return;
    autoSelected.current = true;
    const first = tools.find((tool) => connections.get(tool.id)?.status === 'connected');
    if (first) setSelection((current) => current ?? { id: first.id, origin: 'auto', section: null, nonce: 0 });
  }, [status, tools, connections]);

  useEffect(() => {
    if (!focusFirstCard.current || status !== 'ready') return;
    focusFirstCard.current = false;
    requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      listRef.current?.querySelector<HTMLElement>('[data-hub-card-title]')?.focus({ preventScroll: true });
    });
  }, [visible, status]);

  const toolById = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  const selectedTool = selection ? (toolById.get(selection.id) ?? null) : null;
  const overlayOpen = !isWide && selection?.origin === 'user' && selectedTool !== null;
  const connectTool = connectId ? (toolById.get(connectId) ?? null) : null;
  const disconnectTool = disconnect ? (toolById.get(disconnect.id) ?? null) : null;

  const openTool = useCallback((tool: AITool, section?: 'connection') => setSelection({ id: tool.id, origin: 'user', section: section ?? null, nonce: Date.now() }), []);
  const updateQuery = useCallback((patch: Partial<HubQuery>) => setQuery((current) => ({ ...current, ...patch })), []);
  const resetQuery = useCallback(() => setQuery(DEFAULT_QUERY), []);

  const showConnectable = useCallback(() => {
    focusFirstCard.current = true;
    setQuery((current) => ({ ...current, q: '', category: 'all', sub: null, filters: { ...DEFAULT_FILTERS, connection: 'unconnected', orchestratorOnly: true } }));
  }, []);

  const canDisconnect = useCallback(
    (tool: AITool) => {
      const connection = connections.get(tool.id);
      if (!connection || connection.status === 'available') return false;
      return mode === 'demo' ? true : canManage && connection.source !== 'environment';
    },
    [connections, mode, canManage],
  );

  const onConnected = useCallback(
    (connection: AIConnection) => {
      setConnections((current) => new Map(current).set(connection.toolId, connection));
      setVersion((value) => value + 1);
      void refreshConnections();
    },
    [refreshConnections],
  );

  const confirmDisconnect = async () => {
    if (!disconnect || !disconnectTool) return;
    setDisconnect({ ...disconnect, busy: true, error: null });
    try {
      await service.disconnect(disconnect.id);
      setDisconnect(null);
      notify(`${disconnectTool.name} wurde getrennt.`);
      await refreshConnections();
    } catch (error) {
      setDisconnect({ ...disconnect, busy: false, error: error instanceof Error ? error.message : 'Trennen fehlgeschlagen.' });
    }
  };

  const onSelectModel = useCallback(
    (tool: AITool, modelId: string) => {
      void service
        .selectModel(tool.id, modelId)
        .then((connection) => {
          if (connection) setConnections((current) => new Map(current).set(tool.id, connection));
        })
        .catch(() => notify('Das Modell konnte nicht gespeichert werden.'));
    },
    [service, notify],
  );

  const sourceHref = (value: HubMode) => {
    const next = new URLSearchParams(params.toString());
    next.set('source', value);
    return `/hub?${next.toString()}`;
  };

  const panelProps = {
    connection: selectedTool ? connections.get(selectedTool.id) : undefined,
    service,
    version,
    focusSection: selection?.section ?? null,
    focusNonce: selection?.nonce ?? 0,
    canDisconnect: selectedTool ? canDisconnect(selectedTool) : false,
    onConnect: (tool: AITool) => setConnectId(tool.id),
    onDisconnect: (tool: AITool) => setDisconnect({ id: tool.id, busy: false, error: null }),
    onSelectModel,
  };

  const loading = status === 'loading';
  const filtered = !isDefaultQuery({ ...query, sort: DEFAULT_QUERY.sort });

  return (
    <div lang="de" className="xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-6">
        <HubHeader mode={mode} shortcutLabel={shortcutLabel} onSearch={focusSearch} />
        <HubHero total={tools.length} connected={connectedCount} usable={usableCount} loading={loading} />

        {mode === 'demo' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-hub-line bg-hub-card px-4 py-3 text-[13px]">
            <FlaskConical aria-hidden="true" size={16} className="shrink-0 self-start text-warning sm:self-center" />
            {/* The basis makes the link wrap below the text on phones instead of squeezing the sentence. */}
            <p className="min-w-0 flex-1 basis-[15rem] text-ink-2">
              <span className="font-medium text-ink">Demo-Modus.</span> Verbindungen werden nur in diesem Browser simuliert; es werden keine Zugangsdaten abgefragt oder gespeichert.
            </p>
            <Link href={sourceHref('live')} replace scroll={false} className="inline-flex h-9 items-center rounded-lg px-2 font-medium text-link underline-offset-2 hover:underline">
              Echte Orchestrator-Daten anzeigen
            </Link>
          </div>
        ) : health?.demoMode || !canManage ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-hub-line bg-hub-card px-4 py-3 text-[13px]">
            <Info aria-hidden="true" size={16} className="shrink-0 self-start text-ink-2 sm:self-center" />
            <p className="min-w-0 flex-1 basis-[15rem] text-ink-2">
              {health?.demoMode
                ? 'Noch kein echter Modell-Provider konfiguriert. Der Orchestrator nutzt Mock-Modelle, bis du OpenAI, Anthropic, Google oder einen OpenAI-kompatiblen Endpunkt verbindest.'
                : 'Du kannst den Katalog ansehen. Zugänge zu Modell-Providern verwalten nur Admins und Owner.'}
            </p>
            {health?.demoMode ? (
              <Link href={sourceHref('demo')} replace scroll={false} className="inline-flex h-9 items-center rounded-lg px-2 font-medium text-link underline-offset-2 hover:underline">
                Demo ansehen
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-4">
          <CategoryFilter
            category={query.category}
            sub={query.sub}
            counts={counts}
            subCounts={subCounts}
            onCategory={(category) => updateQuery({ category, sub: null })}
            onSub={(sub) => updateQuery({ sub })}
          />
          <div className="flex items-center gap-2">
            <SearchBar value={query.q} onChange={(q) => updateQuery({ q })} inputRef={searchRef} shortcutLabel={shortcutLabel} />
            <SortSelect value={query.sort} onChange={(sort) => updateQuery({ sort })} />
            <FilterPopover filters={query.filters} onChange={(filters) => updateQuery({ filters })} />
          </div>
          <ConnectedAI tools={tools} connections={connections} loading={loading} onOpen={openTool} onAdd={showConnectable} />
        </div>

        <section ref={resultsRef} aria-labelledby="hub-results-heading" className="scroll-mt-20">
          <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-2">
            <h2 id="hub-results-heading" className="sr-only">
              KI-Tools
            </h2>
            <p aria-live="polite" className="tabular text-[13px] text-ink-2">
              {loading ? 'Lade KI-Tools …' : status === 'error' ? '' : `${visible.length} ${visible.length === 1 ? 'KI-Tool' : 'KI-Tools'}${filtered ? ' gefunden' : ''}`}
            </p>
            {filtered && status === 'ready' ? (
              <button type="button" onClick={resetQuery} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-2 transition-[color,background-color] duration-150 ease-out hover:bg-hub-card-2 hover:text-ink">
                <RotateCcw aria-hidden="true" size={13} />
                Filter zurücksetzen
              </button>
            ) : null}
          </div>
          {loading ? (
            <HubCardSkeletons />
          ) : status === 'error' ? (
            <HubErrorState message={loadError} onRetry={() => void load()} busy={reloading} />
          ) : visible.length === 0 ? (
            <HubEmptyState query={query.q} onReset={resetQuery} />
          ) : (
            <AICardGrid
              tools={visible}
              connections={connections}
              selectedId={isWide ? (selection?.id ?? null) : null}
              canDisconnect={canDisconnect}
              listRef={listRef}
              onOpen={openTool}
              onConnect={(tool) => setConnectId(tool.id)}
              onDisconnect={(tool) => setDisconnect({ id: tool.id, busy: false, error: null })}
            />
          )}
        </section>

        <section aria-labelledby="hub-promo" className="hub-hero flex flex-col gap-4 overflow-hidden rounded-3xl border border-hub-line px-5 py-5 sm:flex-row sm:items-center sm:px-6">
          <span aria-hidden="true" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-hub-line bg-hub-card">
            <HubMark size={30} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="hub-promo" className="text-[15px] font-semibold text-ink">
              Mehr Möglichkeiten mit KI
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">Verbinde deine Lieblings-KIs und lass sie gemeinsam für dich arbeiten.</p>
          </div>
          <button type="button" onClick={showConnectable} className={cx(actionBase, actionClass.connect, 'self-start sm:self-auto')}>
            Jetzt verbinden
            <ActionArrow />
          </button>
        </section>
      </div>

      <AIDetailPanelInline {...panelProps} tool={selectedTool} onClose={() => setSelection(null)} onBrowse={showConnectable} />

      {overlayOpen && selectedTool ? <AIDetailPanelOverlay {...panelProps} tool={selectedTool} onClose={() => setSelection(null)} /> : null}

      <ConnectModal tool={connectTool} service={service} connection={connectTool ? connections.get(connectTool.id) : undefined} onClose={() => setConnectId(null)} onConnected={onConnected} />

      {disconnect && disconnectTool ? (
        <ConfirmDialog
          title={`${disconnectTool.name} trennen?`}
          description={
            mode === 'demo'
              ? 'Die simulierte Verbindung wird aus diesem Browser entfernt.'
              : 'Der gespeicherte Zugang wird vom Server gelöscht. Agenten können Modelle dieses Zugangs danach nicht mehr verwenden.'
          }
          confirmLabel="Trennen"
          busy={disconnect.busy}
          error={disconnect.error}
          onConfirm={() => void confirmDisconnect()}
          onCancel={() => setDisconnect(null)}
        />
      ) : null}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[70] flex justify-center px-4">
        {toast ? (
          <p key={toast.id} className="hub-modal-enter rounded-xl border border-hub-line-strong bg-hub-card px-4 py-2.5 text-[13px] text-ink shadow-pop">
            {toast.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
