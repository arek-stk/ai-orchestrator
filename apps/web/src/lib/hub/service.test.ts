import { describe, expect, it } from 'vitest';
import type { CostsResponse, ModelsResponse, ProviderInfo } from '../types';
import { ApiHubService, LIVE_MODEL_PREFS_KEY, matchProvider } from './api-service';
import { HUB_CATALOG, findTool } from './catalog';
import { DEMO_STORAGE_KEY, MockHubService } from './mock-service';
import { HubError, validateBaseUrl, type StorageLike } from './service';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

describe('MockHubService', () => {
  const create = (storage: StorageLike | null = new MemoryStorage(), failureRate = 0) => new MockHubService({ latencyMs: [0, 0], storage, failureRate, now: () => new Date('2026-09-15T10:00:00Z') });

  it('preconnects a small demo set and persists connections', async () => {
    const storage = new MemoryStorage();
    const service = create(storage);
    expect((await service.listConnections()).map((c) => c.toolId).sort()).toEqual(['chatgpt', 'claude']);
    await service.connect({ toolId: 'mistral', selectedModel: 'mistral-small' });
    expect(JSON.parse(storage.getItem(DEMO_STORAGE_KEY)!).mistral).toMatchObject({ status: 'connected', demo: true, selectedModel: 'mistral-small' });
    await service.disconnect('claude');
    expect((await create(storage).listConnections()).map((c) => c.toolId).sort()).toEqual(['chatgpt', 'mistral']);
  });

  it('never accepts credentials, rejects tools without orchestrator integration and reports no usage', async () => {
    const service = create();
    await expect(service.connect({ toolId: 'claude', selectedModel: null, apiKey: 'sk-secret-value' })).rejects.toBeInstanceOf(HubError);
    await expect(service.connect({ toolId: 'midjourney', selectedModel: null })).rejects.toMatchObject({ code: 'unsupported' });
    expect(service.connectRequirements(findTool('runway')!).kind).toBe('unsupported');
    expect(await service.getUsage()).toBeNull();
  });

  it('works without storage and simulates failures when configured', async () => {
    await expect(create(null).listConnections()).resolves.toHaveLength(2);
    await expect(create(null, 1).listTools()).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('ApiHubService', () => {
  const model = (patch: Partial<ModelsResponse['models'][number]>): ModelsResponse['models'][number] => ({
    id: 'anthropic:claude-sonnet-5',
    provider: 'anthropic',
    providerConfigId: null,
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    tier: 'balanced',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: null, cacheWritePerMTok: null },
    latency: 'medium',
    codingScore: 0.9,
    reasoningScore: 0.9,
    capabilities: { structuredOutput: true, vision: true, tools: true, reasoning: true },
    enabled: true,
    available: true,
    ...patch,
  });

  function setup(options: { providers?: ProviderInfo[]; models?: ModelsResponse['models']; costs?: CostsResponse; canManage?: boolean } = {}) {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let providers = options.providers ?? [];
    const fetcher = async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const method = init.method ?? 'GET';
      calls.push({ path, method, ...(init.body !== undefined ? { body: init.body } : {}) });
      if (path === '/api/providers') return { providers } as T;
      if (path === '/api/models') return { demoMode: false, models: options.models ?? [] } as T;
      if (path.startsWith('/api/costs')) return (options.costs ?? { since: '', summary: { costUsd: 0, tokens: 0, calls: 0 }, byDay: [], byModel: [], byProject: [] }) as T;
      if (method === 'PUT') {
        const id = decodeURIComponent(path.split('/').pop()!);
        const body = init.body as { kind: ProviderInfo['kind']; name: string; baseUrl: string | null; apiKey?: string };
        providers = [...providers.filter((p) => p.id !== id), { id, kind: body.kind, name: body.name, baseUrl: body.baseUrl, enabled: true, hasApiKey: Boolean(body.apiKey), source: 'settings' }];
        return { provider: {} } as T;
      }
      if (method === 'DELETE') {
        providers = providers.filter((p) => p.id !== decodeURIComponent(path.split('/').pop()!));
        return { ok: true } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const storage = new MemoryStorage();
    const service = new ApiHubService({ canManage: options.canManage ?? true, fetcher, storage });
    return { service, calls, storage };
  }

  const envAnthropic: ProviderInfo = { id: 'env:anthropic', kind: 'anthropic', name: 'anthropic (environment)', baseUrl: null, enabled: true, hasApiKey: true, source: 'environment' };

  it('derives connections from real provider accounts and the model registry', async () => {
    const { service } = setup({ providers: [envAnthropic], models: [model({})] });
    const connections = await service.listConnections();
    expect(connections).toEqual([expect.objectContaining({ toolId: 'claude', status: 'connected', orchestratorEnabled: true, source: 'environment', selectedModel: 'anthropic:claude-sonnet-5' })]);
    expect((await service.listModels('claude')).source).toBe('registry');
    expect((await service.listModels('mistral')).source).toBe('examples');
  });

  it('is not orchestrator-usable without an available model and flags unusable accounts', async () => {
    const disabled: ProviderInfo = { id: 'hub-gemini', kind: 'google', name: 'Gemini', baseUrl: null, enabled: false, hasApiKey: true, source: 'settings' };
    const { service } = setup({ providers: [envAnthropic, disabled], models: [model({ available: false })] });
    const connections = await service.listConnections();
    expect(connections.find((c) => c.toolId === 'claude')).toMatchObject({ status: 'connected', orchestratorEnabled: false });
    expect(connections.find((c) => c.toolId === 'gemini')).toMatchObject({ status: 'error', orchestratorEnabled: false });
  });

  it('stores credentials only through the admin provider endpoint and keeps only the model preference locally', async () => {
    const { service, calls, storage } = setup({ models: [] });
    const connection = await service.connect({ toolId: 'groq', selectedModel: 'llama', apiKey: 'gsk_secret_value', baseUrl: 'https://api.groq.com/openai/v1' });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ path: '/api/providers/hub-groq', body: { kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_secret_value', enabled: true } });
    expect(connection).toMatchObject({ toolId: 'groq', status: 'connected', orchestratorEnabled: false });
    expect([...storage.map.values()].join('')).not.toContain('gsk_secret_value');
    expect(JSON.parse(storage.getItem(LIVE_MODEL_PREFS_KEY)!)).toEqual({ groq: 'llama' });
  });

  it('validates input and enforces roles and environment-managed accounts', async () => {
    const { service } = setup({ providers: [envAnthropic] });
    await expect(service.connect({ toolId: 'claude', selectedModel: null, apiKey: 'short' })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.connect({ toolId: 'ollama', selectedModel: null, baseUrl: 'http://example.com/v1' })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.connect({ toolId: 'runway', selectedModel: null })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(service.disconnect('claude')).rejects.toMatchObject({ code: 'unsupported' });
    const viewer = setup({ canManage: false }).service;
    expect(viewer.connectRequirements(findTool('claude')!).kind).toBe('forbidden');
    await expect(viewer.connect({ toolId: 'claude', selectedModel: null, apiKey: 'sk-long-enough' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports real usage per provider or null when there is none', async () => {
    const costs: CostsResponse = {
      since: '',
      summary: { costUsd: 4, tokens: 5000, calls: 12 },
      byDay: [],
      byModel: [
        { provider: 'anthropic', modelId: 'claude-sonnet-5', costUsd: 3, tokens: 4000, calls: 9 },
        { provider: 'mock', modelId: 'mock-fast', costUsd: 1, tokens: 1000, calls: 3 },
      ],
      byProject: [],
    };
    const { service } = setup({ providers: [envAnthropic], models: [model({})], costs });
    expect(await service.getUsage('claude')).toEqual({ windowDays: 30, tokens: 4000, calls: 9, costUsd: 3, share: 0.75 });
    expect(await service.getUsage('chatgpt')).toBeNull();
    expect(await service.getUsage('midjourney')).toBeNull();
  });

  it('matches OpenAI-compatible accounts by id or base URL host', () => {
    const tool = findTool('ollama')!;
    const byHost: ProviderInfo = { id: 'local', kind: 'openai-compatible', name: 'Local', baseUrl: 'http://localhost:11434/v1', enabled: true, hasApiKey: false, source: 'settings' };
    expect(matchProvider(tool, [byHost])?.id).toBe('local');
    expect(matchProvider(findTool('groq')!, [byHost])).toBeNull();
    expect(HUB_CATALOG.length).toBeGreaterThan(30);
  });
});

describe('validateBaseUrl', () => {
  it('allows https and local http only', () => {
    expect(validateBaseUrl('https://api.mistral.ai/v1')).toBeNull();
    expect(validateBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(validateBaseUrl('http://api.example.com')).not.toBeNull();
    expect(validateBaseUrl('https://user:pw@api.example.com')).not.toBeNull();
    expect(validateBaseUrl('not a url')).not.toBeNull();
  });
});
