// Demo implementation: simulated latency and optional failures, connection state in localStorage. It never asks for,
// accepts or stores credentials, and never reports usage numbers.

import { HUB_CATALOG, findTool } from './catalog';
import { supportsOrchestrator } from './filter';
import { browserStorage, HubError, readJson, writeJson, type ConnectInput, type ConnectRequirements, type HubService, type StorageLike } from './service';
import type { AIConnection, AITool, ModelList, ToolUsage } from './types';

export const DEMO_STORAGE_KEY = 'orch-hub-demo-connections-v1';
/** Preconnected in a fresh demo: the providers the demo orchestrator stands in for with its mock models. */
export const DEMO_PRECONNECTED = ['chatgpt', 'claude'] as const;

export interface MockHubOptions {
  /** Inclusive latency range in ms. */
  latencyMs?: [number, number];
  /** Probability (0–1) that a call fails with a simulated error, to exercise error states. */
  failureRate?: number;
  storage?: StorageLike | null;
  random?: () => number;
  now?: () => Date;
}

export class MockHubService implements HubService {
  readonly mode = 'demo' as const;
  private readonly latency: [number, number];
  private readonly failureRate: number;
  private readonly storage: StorageLike | null;
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(options: MockHubOptions = {}) {
    this.latency = options.latencyMs ?? [250, 650];
    this.failureRate = Math.max(0, Math.min(1, options.failureRate ?? 0));
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
  }

  private async simulate(): Promise<void> {
    const [min, max] = this.latency;
    const ms = min + Math.round(this.random() * Math.max(0, max - min));
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.failureRate > 0 && this.random() < this.failureRate) {
      throw new HubError('failed', 'Simulierter Fehler im Demo-Modus. Bitte versuche es erneut.');
    }
  }

  private load(): Record<string, AIConnection> {
    const stored = readJson<Record<string, AIConnection>>(this.storage, DEMO_STORAGE_KEY);
    if (stored && typeof stored === 'object') return stored;
    const seededAt = this.now().toISOString();
    return Object.fromEntries(
      DEMO_PRECONNECTED.map((toolId) => [
        toolId,
        { toolId, status: 'connected', connectedAt: seededAt, selectedModel: findTool(toolId)?.models[0]?.id ?? null, orchestratorEnabled: true, demo: true } satisfies AIConnection,
      ]),
    );
  }

  private save(connections: Record<string, AIConnection>): void {
    writeJson(this.storage, DEMO_STORAGE_KEY, connections);
  }

  async listTools(): Promise<AITool[]> {
    await this.simulate();
    return HUB_CATALOG;
  }

  async listConnections(): Promise<AIConnection[]> {
    await this.simulate();
    return Object.values(this.load());
  }

  async listModels(toolId: string): Promise<ModelList> {
    const tool = findTool(toolId);
    return tool && tool.models.length > 0 ? { source: 'examples', models: tool.models } : { source: 'none', models: [] };
  }

  async getUsage(): Promise<ToolUsage | null> {
    return null;
  }

  connectRequirements(tool: AITool): ConnectRequirements {
    if (!supportsOrchestrator(tool)) {
      return { kind: 'unsupported', reason: tool.integration === 'planned' ? 'Die Integration ist geplant und noch nicht verfügbar.' : 'Es gibt keinen offiziellen API-Zugang.' };
    }
    return { kind: 'demo' };
  }

  async connect(input: ConnectInput): Promise<AIConnection> {
    const tool = findTool(input.toolId);
    if (!tool) throw new HubError('validation', 'Unbekanntes Tool.');
    const requirements = this.connectRequirements(tool);
    if (requirements.kind !== 'demo') throw new HubError('unsupported', requirements.kind === 'unsupported' ? requirements.reason : 'Nicht verfügbar.');
    if (input.apiKey || input.baseUrl) throw new HubError('validation', 'Der Demo-Modus nimmt keine Zugangsdaten an.');
    await this.simulate();
    const connection: AIConnection = {
      toolId: tool.id,
      status: 'connected',
      connectedAt: this.now().toISOString(),
      selectedModel: input.selectedModel,
      orchestratorEnabled: true,
      demo: true,
    };
    this.save({ ...this.load(), [tool.id]: connection });
    return connection;
  }

  async disconnect(toolId: string): Promise<void> {
    await this.simulate();
    const connections = this.load();
    delete connections[toolId];
    this.save(connections);
  }

  async selectModel(toolId: string, modelId: string): Promise<AIConnection | null> {
    const connections = this.load();
    const current = connections[toolId];
    if (!current) return null;
    const next = { ...current, selectedModel: modelId };
    this.save({ ...connections, [toolId]: next });
    return next;
  }
}
