import { z } from 'zod';

/** Provider adapters shipped with the orchestrator (ADR-005). */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'openai-compatible', 'mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const MODEL_TIERS = ['fast', 'balanced', 'reasoning'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const LATENCY_CLASSES = ['low', 'medium', 'high'] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
}

export interface ModelCapabilities {
  structuredOutput: boolean;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

/** A model is data, not code: editable at runtime (Settings → Models). */
export interface ModelConfig {
  /** Registry id, e.g. "anthropic/claude-opus-5". */
  id: string;
  provider: ProviderKind;
  /** Which configured provider account to use; null = the default account of that kind. */
  providerConfigId: string | null;
  /** Model id as the provider API expects it. */
  modelId: string;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  latency: LatencyClass;
  /** 0–100 heuristics used by the router. Editable defaults, not benchmarks. */
  codingScore: number;
  reasoningScore: number;
  capabilities: ModelCapabilities;
  enabled: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  enabled: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export const ModelConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._:\/-]{1,150}$/, 'id must look like "provider/model"'),
  provider: z.enum(PROVIDER_KINDS),
  providerConfigId: z.string().min(1).nullable().default(null),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120),
  tier: z.enum(MODEL_TIERS),
  contextWindow: z.number().int().min(1_000).max(10_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  pricing: z.object({
    inputPerMTok: z.number().min(0).max(10_000),
    outputPerMTok: z.number().min(0).max(10_000),
    cacheReadPerMTok: z.number().min(0).max(10_000).nullable(),
    cacheWritePerMTok: z.number().min(0).max(10_000).nullable(),
  }),
  latency: z.enum(LATENCY_CLASSES),
  codingScore: z.number().min(0).max(100),
  reasoningScore: z.number().min(0).max(100),
  capabilities: z.object({
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    tools: z.boolean(),
    reasoning: z.boolean(),
  }),
  enabled: z.boolean(),
});
