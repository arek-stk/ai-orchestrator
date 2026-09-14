import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { ProviderError, type ModelProvider, type StructuredRequest, type StructuredResponse } from '@orch/core';
import { parseStructuredText } from './json-schema';

export interface OpenAIProviderOptions {
  /** `openai-compatible` covers Ollama, LM Studio, vLLM, OpenRouter, Mistral, DeepSeek, Groq, … */
  kind: 'openai' | 'openai-compatible';
  apiKey: string;
  baseURL?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
}

export class OpenAIProvider implements ModelProvider {
  readonly kind: 'openai' | 'openai-compatible';
  private readonly client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.kind = options.kind;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? undefined,
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const { model } = request;
    const maxTokens = Math.min(request.maxOutputTokens, model.maxOutputTokens);
    const native = this.kind === 'openai';

    let completion: OpenAI.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: model.modelId,
          messages: [
            { role: 'system', content: request.system },
            ...request.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          response_format: zodResponseFormat(request.schema, request.schemaName),
          // Compatible servers generally still expect the classic parameter name.
          ...(native ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
          ...(native && request.effort && model.capabilities.reasoning ? { reasoning_effort: request.effort } : {}),
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw mapOpenAIError(error, this.kind);
    }

    const choice = completion.choices[0];
    if (!choice) throw new ProviderError('invalid_output', 'response contained no choices', this.kind);
    if (choice.message.refusal || choice.finish_reason === 'content_filter') {
      throw new ProviderError('refusal', choice.message.refusal ?? 'content filtered', this.kind);
    }
    if (choice.finish_reason === 'length') {
      throw new ProviderError('invalid_output', 'output truncated at max tokens', this.kind);
    }

    const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      data: parseStructuredText(choice.message.content ?? '', request.schema, this.kind, request.schemaName),
      usage: {
        inputTokens: Math.max(0, (completion.usage?.prompt_tokens ?? 0) - cached),
        outputTokens: completion.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      stopReason: choice.finish_reason,
      providerModelId: completion.model,
    };
  }
}

function mapOpenAIError(error: unknown, kind: 'openai' | 'openai-compatible'): ProviderError {
  if (error instanceof ProviderError) return error;
  const make = (errorKind: ProviderError['kind'], message: string) => new ProviderError(errorKind, message, kind, { cause: error });
  if (error instanceof OpenAI.APIUserAbortError) return make('timeout', 'request aborted');
  if (error instanceof OpenAI.APIConnectionTimeoutError) return make('timeout', 'request timed out');
  if (error instanceof OpenAI.APIConnectionError) return make('unavailable', 'connection failed');
  if (error instanceof OpenAI.RateLimitError) return make('rate_limited', error.message);
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) return make('auth', error.message);
  if (error instanceof OpenAI.NotFoundError) return make('unavailable', `model not available: ${error.message}`);
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.UnprocessableEntityError) {
    return make('invalid_request', error.message);
  }
  if (error instanceof OpenAI.APIError) return make((error.status ?? 500) >= 500 ? 'unavailable' : 'unknown', error.message);
  return make('unknown', error instanceof Error ? error.message : String(error));
}
