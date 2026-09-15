// Live implementation on top of the orchestrator API: provider accounts (/api/providers), the model registry
// (/api/models) and the usage ledger (/api/costs). Connecting a native or OpenAI-compatible tool stores a provider
// account through the admin-only PUT /api/providers/:id, which encrypts the key at rest (AES-256-GCM).

import { api, ApiError } from '../api';
import type { CostsResponse, ModelsResponse, ProviderInfo } from '../types';
import { HUB_CATALOG, findTool } from './catalog';
import { supportsOrchestrator } from './filter';
import {
  browserStorage,
  HubError,
  readJson,
  validateBaseUrl,
  writeJson,
  type ConnectInput,
  type ConnectRequirements,
  type HubService,
  type StorageLike,
} from './service';
import type { AIConnection, AITool, ModelList, ToolModel, ToolUsage } from './types';

/** Non-secret display preference (the model shown as default in the Hub). */
export const LIVE_MODEL_PREFS_KEY = 'orch-hub-model-preferences-v1';
const USAGE_WINDOW_DAYS = 30;
const TIER_LABELS: Record<string, string> = { fast: 'schnell', balanced: 'ausgewogen', reasoning: 'Reasoning' };

type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
type RegistryModel = ModelsResponse['models'][number];

interface Snapshot {
  providers: ProviderInfo[];
  models: RegistryModel[];
}

export interface ApiHubOptions {
  /** Whether the signed-in user holds the admin role (provider accounts are admin-only on the server). */
  canManage: boolean;
  fetcher?: Fetcher;
  storage?: StorageLike | null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return null;
  }
}

function usable(provider: ProviderInfo): boolean {
  return provider.enabled && (provider.kind === 'openai-compatible' ? provider.baseUrl !== null : provider.hasApiKey);
}

export function hubProviderId(tool: AITool): string {
  return `hub-${tool.id}`;
}

/** The provider account that backs a tool, if any. Usable accounts win over disabled ones. */
export function matchProvider(tool: AITool, providers: readonly ProviderInfo[]): ProviderInfo | null {
  let candidates: ProviderInfo[] = [];
  if (tool.integration === 'native' && tool.providerKind) {
    candidates = providers.filter((provider) => provider.kind === tool.providerKind);
  } else if (tool.integration === 'openai-compatible') {
    const host = hostOf(tool.baseUrl);
    candidates = providers.filter((provider) => provider.kind === 'openai-compatible' && (provider.id === hubProviderId(tool) || (host !== null && hostOf(provider.baseUrl) === host)));
  }
  return candidates.find(usable) ?? candidates[0] ?? null;
}

/** Registry models the orchestrator would route through this tool's account (mirrors DefaultProviderResolver). */
export function registryModelsFor(tool: AITool, provider: ProviderInfo | null, snapshot: Snapshot): RegistryModel[] {
  if (tool.integration === 'native' && tool.providerKind) return snapshot.models.filter((model) => model.provider === tool.providerKind);
  if (tool.integration !== 'openai-compatible' || !provider) return [];
  // The server lists stored accounts before environment ones but resolves environment credentials first.
  const ordered = [...snapshot.providers.filter((p) => p.source === 'environment'), ...snapshot.providers.filter((p) => p.source === 'settings')];
  const defaultCompatible = ordered.find((p) => p.kind === 'openai-compatible' && p.enabled)?.id;
  return snapshot.models.filter(
    (model) => model.provider === 'openai-compatible' && (model.providerConfigId === provider.id || (model.providerConfigId === null && defaultCompatible === provider.id)),
  );
}

export class ApiHubService implements HubService {
  readonly mode = 'live' as const;
  private readonly canManage: boolean;
  private readonly fetcher: Fetcher;
  private readonly storage: StorageLike | null;

  constructor(options: ApiHubOptions) {
    this.canManage = options.canManage;
    this.fetcher = options.fetcher ?? ((path, init) => api(path, init));
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
  }

  private async snapshot(): Promise<Snapshot> {
    const [providers, models] = await Promise.all([
      this.fetcher<{ providers: ProviderInfo[] }>('/api/providers'),
      this.fetcher<ModelsResponse>('/api/models'),
    ]);
    return { providers: providers.providers, models: models.models };
  }

  private preferences(): Record<string, string> {
    return readJson<Record<string, string>>(this.storage, LIVE_MODEL_PREFS_KEY) ?? {};
  }

  private toConnection(tool: AITool, snapshot: Snapshot): AIConnection | null {
    const provider = matchProvider(tool, snapshot.providers);
    if (!provider) return null;
    const models = registryModelsFor(tool, provider, snapshot).filter((model) => model.enabled);
    const routable = models.filter((model) => model.available);
    const isUsable = usable(provider);
    const preferred = this.preferences()[tool.id];
    const selectedModel = models.some((model) => model.id === preferred) ? (preferred ?? null) : (routable[0]?.id ?? models[0]?.id ?? null);
    let detail: string | undefined;
    if (!provider.enabled) detail = 'Der Zugang ist deaktiviert.';
    else if (!isUsable) detail = provider.kind === 'openai-compatible' ? 'Für den Zugang ist keine Basis-URL hinterlegt.' : 'Für den Zugang ist kein API-Schlüssel hinterlegt.';
    else if (routable.length === 0) detail = 'In der Modell-Registry ist noch kein aktiviertes Modell für diesen Zugang.';
    return {
      toolId: tool.id,
      status: isUsable ? 'connected' : 'error',
      connectedAt: null,
      selectedModel,
      orchestratorEnabled: isUsable && routable.length > 0,
      source: provider.source,
      providerId: provider.id,
      ...(detail ? { detail } : {}),
    };
  }

  async listTools(): Promise<AITool[]> {
    return HUB_CATALOG;
  }

  async listConnections(): Promise<AIConnection[]> {
    const snapshot = await this.snapshot();
    return HUB_CATALOG.flatMap((tool) => {
      const connection = supportsOrchestrator(tool) ? this.toConnection(tool, snapshot) : null;
      return connection ? [connection] : [];
    });
  }

  async listModels(toolId: string): Promise<ModelList> {
    const tool = findTool(toolId);
    if (!tool) return { source: 'none', models: [] };
    if (supportsOrchestrator(tool)) {
      const snapshot = await this.snapshot();
      const registry = registryModelsFor(tool, matchProvider(tool, snapshot.providers), snapshot);
      if (registry.length > 0) {
        return {
          source: 'registry',
          models: registry.map(
            (model): ToolModel => ({
              id: model.id,
              label: model.displayName,
              note: [model.modelId, TIER_LABELS[model.tier] ?? model.tier, !model.enabled ? 'deaktiviert' : !model.available ? 'nicht verfügbar' : null].filter(Boolean).join(' · '),
            }),
          ),
        };
      }
    }
    return tool.models.length > 0 ? { source: 'examples', models: tool.models } : { source: 'none', models: [] };
  }

  async getUsage(toolId: string): Promise<ToolUsage | null> {
    const tool = findTool(toolId);
    if (!tool || !supportsOrchestrator(tool)) return null;
    const [snapshot, costs] = await Promise.all([this.snapshot(), this.fetcher<CostsResponse>(`/api/costs?days=${USAGE_WINDOW_DAYS}`)]);
    let rows: CostsResponse['byModel'];
    if (tool.integration === 'native') {
      rows = costs.byModel.filter((row) => row.provider === tool.providerKind);
    } else {
      const modelIds = new Set(registryModelsFor(tool, matchProvider(tool, snapshot.providers), snapshot).map((model) => model.modelId));
      rows = costs.byModel.filter((row) => row.provider === 'openai-compatible' && modelIds.has(row.modelId));
    }
    const calls = rows.reduce((sum, row) => sum + row.calls, 0);
    if (calls === 0) return null;
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const costUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const share = costs.summary.costUsd > 0 ? costUsd / costs.summary.costUsd : costs.summary.tokens > 0 ? tokens / costs.summary.tokens : 0;
    return { windowDays: USAGE_WINDOW_DAYS, tokens, calls, costUsd, share: Math.max(0, Math.min(1, share)) };
  }

  connectRequirements(tool: AITool): ConnectRequirements {
    if (tool.integration === 'planned') return { kind: 'unsupported', reason: 'Die Integration in den Orchestrator ist geplant und noch nicht verfügbar.' };
    if (tool.integration === 'no-public-api') return { kind: 'unsupported', reason: 'Es gibt keinen offiziellen API-Zugang, über den der Orchestrator das Tool nutzen könnte.' };
    if (!this.canManage) {
      return { kind: 'forbidden', reason: 'Zugänge zu Modell-Providern verwalten nur Admins und Owner. Bitte wende dich an einen Admin.' };
    }
    if (tool.integration === 'native') return { kind: 'credentials', apiKey: 'required', baseUrl: null };
    return { kind: 'credentials', apiKey: tool.id === 'ollama' ? 'optional' : 'required', baseUrl: tool.baseUrl ?? '' };
  }

  async connect(input: ConnectInput): Promise<AIConnection> {
    const tool = findTool(input.toolId);
    if (!tool) throw new HubError('validation', 'Unbekanntes Tool.');
    const requirements = this.connectRequirements(tool);
    if (requirements.kind === 'forbidden') throw new HubError('forbidden', requirements.reason);
    if (requirements.kind !== 'credentials') throw new HubError('unsupported', requirements.kind === 'unsupported' ? requirements.reason : 'Nicht verfügbar.');
    const apiKey = input.apiKey?.trim() ?? '';
    if (requirements.apiKey === 'required' && apiKey.length < 8) throw new HubError('validation', 'Bitte gib einen gültigen API-Schlüssel ein.');
    const baseUrl = requirements.baseUrl !== null ? (input.baseUrl ?? '').trim() : null;
    if (baseUrl !== null) {
      const problem = validateBaseUrl(baseUrl);
      if (problem) throw new HubError('validation', problem);
    }

    const before = await this.snapshot();
    const existing = matchProvider(tool, before.providers);
    const providerId = existing && existing.source === 'settings' ? existing.id : hubProviderId(tool);
    try {
      await this.fetcher(`/api/providers/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        body: {
          kind: tool.integration === 'native' ? tool.providerKind : 'openai-compatible',
          name: tool.name.slice(0, 80),
          baseUrl,
          enabled: true,
          ...(apiKey ? { apiKey } : {}),
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) throw new HubError('forbidden', 'Zugänge zu Modell-Providern verwalten nur Admins und Owner.');
      throw new HubError('failed', error instanceof Error ? error.message : 'Die Verbindung konnte nicht gespeichert werden.');
    }

    if (input.selectedModel) writeJson(this.storage, LIVE_MODEL_PREFS_KEY, { ...this.preferences(), [tool.id]: input.selectedModel });
    const connection = this.toConnection(tool, await this.snapshot());
    if (!connection) throw new HubError('failed', 'Der Zugang wurde gespeichert, ist aber noch nicht sichtbar. Bitte lade die Seite neu.');
    return connection;
  }

  async disconnect(toolId: string): Promise<void> {
    const tool = findTool(toolId);
    if (!tool) throw new HubError('validation', 'Unbekanntes Tool.');
    if (!this.canManage) throw new HubError('forbidden', 'Zugänge zu Modell-Providern verwalten nur Admins und Owner.');
    const snapshot = await this.snapshot();
    const provider = matchProvider(tool, snapshot.providers);
    if (!provider) return;
    if (provider.source === 'environment') {
      throw new HubError('unsupported', 'Dieser Zugang ist über Umgebungsvariablen des Servers konfiguriert und lässt sich nur dort entfernen.');
    }
    try {
      await this.fetcher(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) throw new HubError('forbidden', 'Zugänge zu Modell-Providern verwalten nur Admins und Owner.');
      throw new HubError('failed', error instanceof Error ? error.message : 'Die Verbindung konnte nicht getrennt werden.');
    }
  }

  async selectModel(toolId: string, modelId: string): Promise<AIConnection | null> {
    const tool = findTool(toolId);
    if (!tool) return null;
    writeJson(this.storage, LIVE_MODEL_PREFS_KEY, { ...this.preferences(), [toolId]: modelId });
    return this.toConnection(tool, await this.snapshot());
  }
}
