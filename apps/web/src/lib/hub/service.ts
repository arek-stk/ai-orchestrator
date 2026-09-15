// The UI consumes the AI Hub only through HubService, so real integrations plug in without touching components.
// Implementations: ApiHubService (live orchestrator data, api-service.ts) and MockHubService (demo, mock-service.ts);
// createHubService (create-service.ts) picks one.

import type { AIConnection, AITool, ModelList, ToolUsage } from './types';

export type HubMode = 'live' | 'demo';

/** What the connect flow must ask for before `connect` can succeed. */
export type ConnectRequirements =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'forbidden'; reason: string }
  /** Simulated connection: no credentials are requested or stored. */
  | { kind: 'demo' }
  /** Credentials go to the orchestrator server only (stored AES-256-GCM encrypted), never to browser storage. */
  | { kind: 'credentials'; apiKey: 'required' | 'optional'; baseUrl: string | null };

export interface ConnectInput {
  toolId: string;
  selectedModel: string | null;
  /** Held in memory for the single request; never persisted or logged by the client. */
  apiKey?: string;
  baseUrl?: string;
}

export interface HubService {
  readonly mode: HubMode;
  listTools(): Promise<AITool[]>;
  listConnections(): Promise<AIConnection[]>;
  listModels(toolId: string): Promise<ModelList>;
  /** Real usage from the orchestrator, or null when there is none. Never estimated. */
  getUsage(toolId: string): Promise<ToolUsage | null>;
  connectRequirements(tool: AITool): ConnectRequirements;
  connect(input: ConnectInput): Promise<AIConnection>;
  disconnect(toolId: string): Promise<void>;
  selectModel(toolId: string, modelId: string): Promise<AIConnection | null>;
}

export type HubErrorCode = 'forbidden' | 'unsupported' | 'validation' | 'failed';

export class HubError extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage when accessible (private mode and SSR return null). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readJson<T>(storage: StorageLike | null, key: string): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the state simply does not persist.
  }
}

/** Only for human-readable validation of an OpenAI-compatible base URL; the server validates again. */
export function validateBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'Bitte gib eine gültige URL ein, z. B. https://api.example.com/v1.';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return 'Nur HTTPS-Adressen (oder http://localhost für lokale Modelle) sind erlaubt.';
  if (url.username || url.password) return 'Die URL darf keine Zugangsdaten enthalten.';
  return null;
}
