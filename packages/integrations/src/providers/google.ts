import { ApiError, GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { ProviderError, type ModelProvider, type StructuredRequest, type StructuredResponse } from '@orch/core';
import { parseStructuredText, toProviderJsonSchema } from './json-schema';

export interface GoogleProviderOptions {
  apiKey: string;
  /** Override for proxies and tests. */
  baseUrl?: string | null;
  timeoutMs?: number;
}

const REFUSAL_FINISH = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

export class GoogleProvider implements ModelProvider {
  readonly kind = 'google' as const;
  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;

  constructor(options: GoogleProviderOptions) {
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {}),
    });
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const { model } = request;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: model.modelId,
        contents: request.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: toProviderJsonSchema(request.schema),
          maxOutputTokens: Math.min(request.maxOutputTokens, model.maxOutputTokens),
          abortSignal: signal,
        },
      });
    } catch (error) {
      throw mapGoogleError(error);
    }

    if (response.promptFeedback?.blockReason) {
      throw new ProviderError('refusal', `prompt blocked: ${response.promptFeedback.blockReason}`, 'google');
    }
    const finishReason = response.candidates?.[0]?.finishReason ?? null;
    if (finishReason && REFUSAL_FINISH.has(finishReason)) {
      throw new ProviderError('refusal', `generation stopped: ${finishReason}`, 'google');
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new ProviderError('invalid_output', 'output truncated at max tokens', 'google');
    }

    const usage = response.usageMetadata;
    const cached = usage?.cachedContentTokenCount ?? 0;
    return {
      data: parseStructuredText(response.text ?? '', request.schema, 'google', request.schemaName),
      usage: {
        inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
        // Thinking tokens are billed as output.
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      stopReason: finishReason,
      providerModelId: response.modelVersion ?? model.modelId,
    };
  }
}

function mapGoogleError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const make = (kind: ProviderError['kind'], message: string) => new ProviderError(kind, message, 'google', { cause: error });
  if (error instanceof ApiError) {
    if (error.status === 429) return make('rate_limited', error.message);
    if (error.status === 401 || error.status === 403) return make('auth', error.message);
    if (error.status === 404) return make('unavailable', `model not available: ${error.message}`);
    if (error.status >= 500) return make('unavailable', error.message);
    if (error.status === 400) return make('invalid_request', error.message);
    return make('unknown', error.message);
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return make('timeout', 'request timed out or was aborted');
  }
  if (error instanceof TypeError) return make('unavailable', `connection failed: ${error.message}`);
  return make('unknown', error instanceof Error ? error.message : String(error));
}
