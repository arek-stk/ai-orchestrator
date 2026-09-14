import { z } from 'zod';
import {
  estimateTokens,
  ProviderError,
  type ModelProvider,
  type StructuredRequest,
  type StructuredResponse,
} from '@orch/core';
import { sampleFromJsonSchema } from './json-schema';

export type MockResponder = (request: StructuredRequest<unknown>) => unknown | Promise<unknown>;

export interface MockProviderOptions {
  /** Role-specific canned outputs keyed by schema name (e.g. "plan_output"). */
  responders?: Record<string, MockResponder>;
  /** Artificial latency so the dashboard shows agents "working" in demo mode. */
  latencyMs?: number;
}

/**
 * Deterministic, zero-cost provider for demo mode and tests (ADR-005). Output always passes the
 * request schema or the call fails with `invalid_output`, exactly like a real provider would.
 */
export class MockProvider implements ModelProvider {
  readonly kind = 'mock' as const;

  constructor(private readonly options: MockProviderOptions = {}) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    if (request.signal?.aborted) throw new ProviderError('timeout', 'request aborted', 'mock');
    if (this.options.latencyMs) await delay(this.options.latencyMs, request.signal);

    const responder = this.options.responders?.[request.schemaName];
    const hint = firstLine(request.messages.at(-1)?.content ?? request.schemaName);
    const raw = responder
      ? await responder(request as StructuredRequest<unknown>)
      : sampleFromJsonSchema(z.toJSONSchema(request.schema, { io: 'output', unrepresentable: 'any' }) as object, { hint });

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError('invalid_output', `mock output does not match ${request.schemaName}: ${parsed.error.message}`, 'mock');
    }

    const inputText = request.system + request.messages.map((m) => m.content).join('\n');
    return {
      data: parsed.data,
      usage: {
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(JSON.stringify(raw)),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      stopReason: 'end_turn',
      providerModelId: request.model.modelId,
    };
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 80);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('timeout', 'request aborted', 'mock'));
      },
      { once: true },
    );
  });
}
