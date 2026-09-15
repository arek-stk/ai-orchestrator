import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_DEFINITIONS, DEFAULT_MODEL_CONFIGS, ProviderError, type ModelConfig, type StructuredRequest } from '@orch/core';
import { createDemoResponders, slugOf } from '../demo/responders';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';
import { parseStructuredText, unwrapJsonFence } from './json-schema';
import { MockProvider } from './mock';
import { OpenAIProvider } from './openai';
import { DefaultProviderResolver, type ProviderCredential } from './resolver';

const AnswerSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  steps: z.array(z.object({ title: z.string(), done: z.boolean() })).min(1),
});
const answer = { answer: '42', confidence: 0.9, steps: [{ title: 'think', done: true }] };

function model(provider: ModelConfig['provider'], modelId: string): ModelConfig {
  return { ...DEFAULT_MODEL_CONFIGS[1]!, id: `${provider}/${modelId}`, provider, modelId };
}

function requestFor(m: ModelConfig): StructuredRequest<z.infer<typeof AnswerSchema>> {
  return {
    model: m,
    system: 'You are a precise assistant.',
    messages: [{ role: 'user', content: 'What is six times seven?' }],
    schema: AnswerSchema,
    schemaName: 'answer_output',
    maxOutputTokens: 2000,
    effort: 'low',
  };
}

// ---------------------------------------------------------------------------
// Fake provider APIs on a local HTTP server: verifies request shaping and response mapping
// through the real SDKs without API keys or network access.
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
const received: Record<string, any> = {};

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : null));
  });
}

function sse(res: ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '';
    if (url.startsWith('/v1/messages')) {
      received.anthropic = { body, headers: req.headers };
      if (body.model === 'rate-limited') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      const text = JSON.stringify(answer);
      sse(res, [
        {
          type: 'message_start',
          message: {
            id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 10) } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(10) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } },
        { type: 'message_stop' },
      ]);
      return;
    }
    if (url.startsWith('/v1/chat/completions')) {
      received.openai = { body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer), refusal: null } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
        }),
      );
      return;
    }
    if (url.includes(':generateContent')) {
      received.google = { body, url };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 15, thoughtsTokenCount: 5, cachedContentTokenCount: 10, totalTokenCount: 100 },
          modelVersion: 'gemini-test-001',
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('provider adapters', () => {
  it('Anthropic: streams structured output, caches the system prompt and maps usage', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl, maxRetries: 0 });
    const result = await provider.generateStructured(requestFor(model('anthropic', 'claude-sonnet-5')));

    expect(result.data).toEqual(answer);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheReadTokens: 50, cacheWriteTokens: 10 });
    const body = received.anthropic.body;
    expect(body.stream).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.effort).toBe('low');
  });

  it('Anthropic: enables server-side refusal fallbacks on Opus 5 only', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl, maxRetries: 0 });
    const result = await provider.generateStructured(requestFor(model('anthropic', 'claude-opus-5')));
    expect(result.data).toEqual(answer);
    expect(received.anthropic.body.fallbacks).toBe('default');
    expect(String(received.anthropic.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');

    await provider.generateStructured(requestFor(model('anthropic', 'claude-sonnet-5')));
    expect(received.anthropic.body.fallbacks).toBeUndefined();
    expect(received.anthropic.headers['anthropic-beta']).toBeUndefined();
  });

  it('Anthropic: omits effort for models that do not support it and maps rate limits', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: baseUrl, maxRetries: 0 });
    await provider.generateStructured(requestFor(model('anthropic', 'claude-haiku-4-5')));
    expect(received.anthropic.body.output_config.effort).toBeUndefined();

    await expect(provider.generateStructured(requestFor(model('anthropic', 'rate-limited')))).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'rate_limited',
      provider: 'anthropic',
    });
  });

  it('OpenAI: sends a strict JSON schema and separates cached prompt tokens', async () => {
    const provider = new OpenAIProvider({ kind: 'openai', apiKey: 'test-key', baseURL: `${baseUrl}/v1`, maxRetries: 0 });
    const m = { ...model('openai', 'gpt-test'), capabilities: { ...model('openai', 'x').capabilities, reasoning: true } };
    const result = await provider.generateStructured(requestFor(m));

    expect(result.data).toEqual(answer);
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 });
    const body = received.openai.body;
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('answer_output');
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.reasoning_effort).toBe('low');
  });

  it('OpenAI-compatible endpoints (e.g. Ollama) use max_tokens and no reasoning effort', async () => {
    const provider = new OpenAIProvider({ kind: 'openai-compatible', apiKey: 'not-needed', baseURL: `${baseUrl}/v1`, maxRetries: 0 });
    await provider.generateStructured(requestFor(model('openai-compatible', 'llama-local')));
    expect(received.openai.body.max_tokens).toBe(2000);
    expect(received.openai.body.max_completion_tokens).toBeUndefined();
    expect(received.openai.body.reasoning_effort).toBeUndefined();
  });

  it('Google: requests JSON output with a schema and counts thinking tokens as output', async () => {
    const provider = new GoogleProvider({ apiKey: 'test-key', baseUrl });
    const result = await provider.generateStructured(requestFor(model('google', 'gemini-test')));

    expect(result.data).toEqual(answer);
    expect(result.usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 });
    expect(result.providerModelId).toBe('gemini-test-001');
    const config = received.google.body.generationConfig ?? received.google.body.config ?? received.google.body;
    expect(JSON.stringify(config)).toContain('application/json');
    expect(received.google.url).toContain('gemini-test');
  });
});

describe('mock provider', () => {
  const mockModel = DEFAULT_MODEL_CONFIGS.find((m) => m.id === 'mock/balanced')!;

  it('produces schema-valid output from the schema alone', async () => {
    const result = await new MockProvider().generateStructured({ ...requestFor(mockModel) });
    expect(AnswerSchema.safeParse(result.data).success).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('uses registered responders and rejects invalid canned output', async () => {
    const provider = new MockProvider({ responders: { answer_output: () => answer } });
    expect((await provider.generateStructured(requestFor(mockModel))).data).toEqual(answer);

    const broken = new MockProvider({ responders: { answer_output: () => ({ answer: 1 }) } });
    await expect(broken.generateStructured(requestFor(mockModel))).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('provider resolver', () => {
  const credentials: ProviderCredential[] = [
    { id: 'prv_anthropic', kind: 'anthropic', apiKey: 'sk-ant-test', baseUrl: null, enabled: true },
    { id: 'prv_ollama', kind: 'openai-compatible', apiKey: null, baseUrl: 'http://localhost:11434/v1', enabled: true },
    { id: 'prv_openai_off', kind: 'openai', apiKey: 'sk-test', baseUrl: null, enabled: false },
    { id: 'prv_compat_broken', kind: 'openai-compatible', apiKey: 'x', baseUrl: null, enabled: true },
  ];
  const resolver = new DefaultProviderResolver(() => credentials);

  it('resolves configured providers and caches adapters', () => {
    const sonnet = DEFAULT_MODEL_CONFIGS[1]!;
    const first = resolver.get(sonnet);
    expect(first?.kind).toBe('anthropic');
    expect(resolver.get(sonnet)).toBe(first);
    expect(resolver.get({ ...model('openai-compatible', 'llama'), providerConfigId: 'prv_ollama' })?.kind).toBe('openai-compatible');
  });

  it('returns null for missing, disabled or incomplete credentials', () => {
    expect(resolver.get(model('google', 'gemini'))).toBeNull();
    expect(resolver.isAvailable(model('openai', 'gpt'))).toBe(false);
    expect(resolver.get({ ...model('openai-compatible', 'x'), providerConfigId: 'prv_compat_broken' })).toBeNull();
    expect(resolver.get(DEFAULT_MODEL_CONFIGS.find((m) => m.provider === 'mock')!)?.kind).toBe('mock');
  });

  it('rebuilds an adapter when its credential changes and keeps accounts with the same key apart', () => {
    let accounts: ProviderCredential[] = [
      { id: 'prv_a', kind: 'anthropic', apiKey: 'sk-ant-one', baseUrl: null, enabled: true },
      { id: 'prv_b', kind: 'anthropic', apiKey: 'sk-ant-one', baseUrl: null, enabled: true },
    ];
    const rotating = new DefaultProviderResolver(() => accounts);
    const pinned = (id: string) => ({ ...model('anthropic', 'claude'), providerConfigId: id });

    const first = rotating.get(pinned('prv_a'));
    expect(first?.kind).toBe('anthropic');
    expect(rotating.get(pinned('prv_a'))).toBe(first);
    const other = rotating.get(pinned('prv_b'));
    expect(other).not.toBe(first);

    accounts = [{ ...accounts[0]!, apiKey: 'sk-ant-two' }, accounts[1]!];
    const rotated = rotating.get(pinned('prv_a'));
    expect(rotated).not.toBe(first);
    expect(rotating.get(pinned('prv_a'))).toBe(rotated);
    expect(rotating.get(pinned('prv_b'))).toBe(other);

    accounts = [{ ...accounts[0]!, baseUrl: 'http://127.0.0.1:1' }, accounts[1]!];
    const moved = rotating.get(pinned('prv_a'));
    expect(moved).not.toBe(rotated);
    expect(rotating.get(pinned('prv_a'))).toBe(moved);

    rotating.clear();
    expect(rotating.get(pinned('prv_a'))).not.toBe(moved);
  });
});

describe('demo responders', () => {
  const demoModel = DEFAULT_MODEL_CONFIGS.find((m) => m.id === 'mock/balanced')!;
  const responders = createDemoResponders();
  const userPrompt = [
    '## Task',
    'Title: Add CSV export for orders',
    'Kind: feature',
    'Risk: medium',
    'Complexity: complex',
    'Goal:',
    'Export orders as CSV',
    '',
    'Acceptance criteria:',
    '- Export contains a header row',
    '- Dates use ISO 8601',
    '',
    '## Your perspective',
    'security',
  ].join('\n');

  it.each(Object.values(AGENT_DEFINITIONS).map((d) => [d.schemaName, d] as const))('%s satisfies the agent schema and checks', async (_name, definition) => {
    const provider = new MockProvider({ responders });
    const result = await provider.generateStructured({
      model: demoModel,
      system: definition.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      schema: definition.schema as z.ZodType<unknown>,
      schemaName: definition.schemaName,
      maxOutputTokens: definition.expectedOutputTokens,
    });
    expect(responders[definition.schemaName]).toBeDefined();
    const verify = (definition as { verify?: (output: unknown) => string[] }).verify;
    expect(verify ? verify(result.data) : []).toEqual([]);
  });
});

describe('demo slugs', () => {
  // The regex chain slugOf used before it became linear; kept as the behavioural reference on normal input.
  const legacySlugOf = (title: string) =>
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'change';

  it('matches the previous slugs on normal titles', () => {
    const titles = ['Add CSV export for orders', '  --Fix: login (SSO)!--  ', '!!!', '', 'Crème brûlée 🚀', `${'x'.repeat(39)} tail`, 'a_b-c.d 123'];
    for (const title of titles) expect(slugOf(title)).toBe(legacySlugOf(title));
    expect(slugOf('Add CSV export for orders')).toBe('add-csv-export-for-orders');
    expect(slugOf(`${'x'.repeat(39)} tail`)).toBe(`${'x'.repeat(39)}-`);
    expect(slugOf('!!!')).toBe('change');
  });

  it('builds demo file paths from hostile titles in linear time', () => {
    const responders = createDemoResponders();
    const started = Date.now();
    for (const title of [`${'-'.repeat(50_000)}x`, `${'a-'.repeat(25_000)}!`, `${' -'.repeat(25_000)}`]) {
      const request = { messages: [{ role: 'user', content: `Title: ${title}` }] } as StructuredRequest<unknown>;
      const output = responders.build_output!(request) as { changes: Array<{ path: string }> };
      expect(output.changes[0]!.path).toBe(`src/features/${slugOf(title)}.ts`);
    }
    expect(slugOf(`${'-'.repeat(50_000)}x`)).toBe('x');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('parseStructuredText', () => {
  it('accepts fenced JSON and rejects invalid output', () => {
    expect(parseStructuredText('```json\n' + JSON.stringify(answer) + '\n```', AnswerSchema, 'openai-compatible', 'a')).toEqual(answer);
    expect(() => parseStructuredText('not json', AnswerSchema, 'openai', 'a')).toThrow(ProviderError);
    expect(() => parseStructuredText('{"answer":"x"}', AnswerSchema, 'openai', 'a')).toThrow(/confidence/);
  });

  it('unwraps fences exactly like the previous regex', () => {
    // The fence regex used before unwrapJsonFence; kept as the behavioural reference on normal input.
    const legacy = (text: string) => {
      const trimmed = text.trim();
      return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
    };
    const samples = [
      '{"a":1}',
      '```json\n{"a":1}\n```',
      '```JSON {"a":1}```',
      '  ```Json\t[1, 2]\t```  ',
      '```\n{}\n```',
      '```js\n{}\n```',
      '```jsonx\n{}\n```',
      '````\n{}\n````',
      '```json\n\n  {"a": "```"}  \n\n```',
      '``` {} ```',
      '``````',
      '```json```',
      '`````',
      '```json``',
      '```{"a":1}',
      '{"a":1}```',
      '```   ```',
    ];
    for (const sample of samples) expect(unwrapJsonFence(sample)).toBe(legacy(sample));
    expect(unwrapJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('rejects hostile fenced output in linear time', () => {
    const started = Date.now();
    for (const text of [`\`\`\`${' '.repeat(50_000)}`, `\`\`\`json${'\n'.repeat(50_000)}x`, `\`\`\`${' '.repeat(50_000)}\`\`\``, '```'.repeat(20_000)]) {
      expect(() => parseStructuredText(text, AnswerSchema, 'openai-compatible', 'a')).toThrow(ProviderError);
    }
    expect(unwrapJsonFence(`\`\`\`${' '.repeat(50_000)}\`\`\``)).toBe('');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
