import type { z } from 'zod';
import type { ModelConfig, ProviderKind, TokenUsage } from './types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface StructuredRequest<T> {
  model: ModelConfig;
  /** Stable instructions. Kept byte-identical across calls so providers can cache the prefix. */
  system: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** Identifier for the output schema, e.g. "plan_output". */
  schemaName: string;
  maxOutputTokens: number;
  /** Mapped to the provider's reasoning/thinking controls where supported. */
  effort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface StructuredResponse<T> {
  data: T;
  usage: TokenUsage;
  stopReason: string | null;
  /** Model id reported by the provider (may differ from the request, e.g. aliases or fallbacks). */
  providerModelId: string;
}

/** Port implemented by every provider adapter (ADR-005). Adapters translate; they never route. */
export interface ModelProvider {
  readonly kind: ProviderKind;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}

export type ProviderErrorKind =
  | 'unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'auth'
  | 'invalid_request'
  | 'refusal'
  | 'invalid_output'
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly provider: ProviderKind,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }

  /** Whether trying a different model/provider may succeed. */
  get fallbackEligible(): boolean {
    return this.kind !== 'invalid_request';
  }
}

export interface ProviderResolver {
  /** Returns the adapter for a model, or null when its provider is not configured. */
  get(model: ModelConfig): ModelProvider | null;
}
