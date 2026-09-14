import type { ModelConfig, TokenUsage } from './types';

/** Cheap, provider-neutral token estimate (~4 characters per token). Used for routing and budgets only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function computeCostUsd(model: Pick<ModelConfig, 'pricing'>, usage: TokenUsage): number {
  const { pricing } = model;
  const cacheRead = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWrite = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000
  );
}

export function estimateCostUsd(model: Pick<ModelConfig, 'pricing'>, inputTokens: number, outputTokens: number): number {
  return computeCostUsd(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/** In-memory view over the model_configs table. Replaced wholesale when settings change. */
export class ModelRegistry {
  private models = new Map<string, ModelConfig>();

  constructor(models: readonly ModelConfig[] = []) {
    this.replaceAll(models);
  }

  replaceAll(models: readonly ModelConfig[]): void {
    this.models = new Map(models.map((m) => [m.id, m]));
  }

  get(id: string): ModelConfig | undefined {
    return this.models.get(id);
  }

  list(): ModelConfig[] {
    return [...this.models.values()];
  }

  enabled(): ModelConfig[] {
    return this.list().filter((m) => m.enabled);
  }
}

const anthropicCapabilities = { structuredOutput: true, vision: true, tools: true, reasoning: true };
const mockCapabilities = { structuredOutput: true, vision: false, tools: true, reasoning: true };

/**
 * Seed rows for model_configs. Scores are routing heuristics and pricing is USD per million tokens;
 * both are editable in Settings → Models. Other providers are added there with their own pricing.
 * Cache pricing follows Anthropic's multipliers (read ≈ 0.1× input, 5-minute write ≈ 1.25× input).
 */
export const DEFAULT_MODEL_CONFIGS: readonly ModelConfig[] = Object.freeze([
  {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'anthropic',
    providerConfigId: null,
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    latency: 'low',
    codingScore: 72,
    reasoningScore: 68,
    capabilities: anthropicCapabilities,
    enabled: true,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    providerConfigId: null,
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    latency: 'medium',
    codingScore: 90,
    reasoningScore: 87,
    capabilities: anthropicCapabilities,
    enabled: true,
  },
  {
    id: 'anthropic/claude-opus-5',
    provider: 'anthropic',
    providerConfigId: null,
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    tier: 'reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    latency: 'high',
    codingScore: 96,
    reasoningScore: 96,
    capabilities: anthropicCapabilities,
    enabled: true,
  },
  {
    id: 'mock/fast',
    provider: 'mock',
    providerConfigId: null,
    modelId: 'mock-fast',
    displayName: 'Mock (fast tier)',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    latency: 'low',
    codingScore: 72,
    reasoningScore: 68,
    capabilities: mockCapabilities,
    enabled: false,
  },
  {
    id: 'mock/balanced',
    provider: 'mock',
    providerConfigId: null,
    modelId: 'mock-balanced',
    displayName: 'Mock (balanced tier)',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    latency: 'low',
    codingScore: 90,
    reasoningScore: 87,
    capabilities: mockCapabilities,
    enabled: false,
  },
  {
    id: 'mock/reasoning',
    provider: 'mock',
    providerConfigId: null,
    modelId: 'mock-reasoning',
    displayName: 'Mock (reasoning tier)',
    tier: 'reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    latency: 'low',
    codingScore: 96,
    reasoningScore: 96,
    capabilities: mockCapabilities,
    enabled: false,
  },
] satisfies ModelConfig[]);
