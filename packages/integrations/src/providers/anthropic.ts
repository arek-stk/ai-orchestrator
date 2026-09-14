import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProviderError, type ModelProvider, type StructuredRequest, type StructuredResponse } from '@orch/core';
import { parseStructuredText } from './json-schema';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Models that accept `output_config.effort` (Haiku 4.5 and older Sonnets reject it). */
const EFFORT_CAPABLE = /claude-(?:opus-(?:4-[5-9]|5)|sonnet-(?:4-6|5)|fable|mythos)/;

export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? undefined,
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const { model } = request;
    const effort = request.effort && EFFORT_CAPABLE.test(model.modelId) ? request.effort : undefined;
    const base = {
      model: model.modelId,
      max_tokens: Math.min(request.maxOutputTokens, model.maxOutputTokens),
      // Stable system prompt first, marked cacheable (prefix caching).
      system: [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }],
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    let result: FinalMessage;
    try {
      // Streaming avoids HTTP timeouts on large outputs; only the final message is needed.
      if (SERVER_FALLBACK_CAPABLE.test(model.modelId)) {
        // Server-side refusal fallback: a declined request is re-run on a fallback model in the same call.
        const message = await this.client.beta.messages
          .stream(
            {
              ...base,
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              output_config: { format: betaZodOutputFormat(request.schema), ...(effort ? { effort } : {}) },
            },
            { signal: request.signal },
          )
          .finalMessage();
        result = normalize(message);
      } else {
        const message = await this.client.messages
          .stream(
            { ...base, output_config: { format: zodOutputFormat(request.schema), ...(effort ? { effort } : {}) } },
            { signal: request.signal },
          )
          .finalMessage();
        result = normalize(message);
      }
    } catch (error) {
      throw mapAnthropicError(error);
    }

    if (result.stopReason === 'refusal') {
      throw new ProviderError('refusal', 'model declined the request', 'anthropic');
    }
    if (result.stopReason === 'max_tokens') {
      throw new ProviderError('invalid_output', 'output truncated at max_tokens', 'anthropic');
    }

    return {
      data: parseStructuredText(result.text, request.schema, 'anthropic', request.schemaName),
      usage: result.usage,
      stopReason: result.stopReason,
      providerModelId: result.model,
    };
  }
}

/** Models on which server-side refusal fallbacks are enabled by default. */
const SERVER_FALLBACK_CAPABLE = /^claude-(?:opus-5|fable-5|fable-5-1)$/;

interface FinalMessage {
  text: string;
  stopReason: string | null;
  model: string;
  usage: StructuredResponse<unknown>['usage'];
}

interface MessageLike {
  content: ReadonlyArray<{ type: string }>;
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

function normalize(message: MessageLike): FinalMessage {
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    stopReason: message.stop_reason,
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function mapAnthropicError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const make = (kind: ProviderError['kind'], message: string) => new ProviderError(kind, message, 'anthropic', { cause: error });
  // Most specific first.
  if (error instanceof Anthropic.APIUserAbortError) return make('timeout', 'request aborted');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return make('timeout', 'request timed out');
  if (error instanceof Anthropic.APIConnectionError) return make('unavailable', 'connection to Anthropic failed');
  if (error instanceof Anthropic.RateLimitError) return make('rate_limited', error.message);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return make('auth', error.message);
  }
  if (error instanceof Anthropic.NotFoundError) return make('unavailable', `model not available: ${error.message}`);
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) {
    return make('invalid_request', error.message);
  }
  if (error instanceof Anthropic.APIError) {
    return make((error.status ?? 500) >= 500 ? 'unavailable' : 'unknown', error.message);
  }
  return make('unknown', error instanceof Error ? error.message : String(error));
}
