import { AgentRuntime, type AgentRuntimeDeps } from '../agents/runtime';
import type { ModelProvider, ProviderResolver, StructuredRequest } from '../models/provider';
import type { ModelConfig, ProviderKind, TokenUsage } from '../models/types';
import type { Clock } from '../ports';
import type { MemoryStore } from './memory-store';

// Deterministic fake models for autopilot council and ladder tests: responses are scripted per schema name and the
// council role found in the prompt, and every call is recorded (model, provider, role, prompt).

export interface ScriptedCall {
  schemaName: string;
  role: string | null;
  modelId: string;
  provider: ProviderKind;
  prompt: string;
}

export type ScriptedResponder = (call: ScriptedCall) => unknown;

export function scriptedModel(id: string, provider: ProviderKind, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id,
    provider,
    providerConfigId: null,
    modelId: id.split('/')[1] ?? id,
    displayName: id,
    tier: 'reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWritePerMTok: null },
    latency: 'low',
    codingScore: 99,
    reasoningScore: 99,
    capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: true },
    enabled: true,
    ...overrides,
  };
}

/** The council role of a prompt: "Your perspective: <role>" for members, the critic marker otherwise. */
export function promptRole(prompt: string): string | null {
  if (prompt.includes('You are the critic.')) return 'critic';
  const marker = 'Your perspective: ';
  const index = prompt.indexOf(marker);
  if (index === -1) return null;
  return prompt.slice(index + marker.length).split('\n')[0]!.trim();
}

export interface ScriptedWorld {
  runtime: AgentRuntime;
  calls: ScriptedCall[];
  script: Record<string, ScriptedResponder>;
  /** Usage reported per call. */
  usage: TokenUsage;
  /** Called before each response (e.g. to move a fake clock). */
  beforeRespond?: (call: ScriptedCall) => void;
}

export function scriptedWorld(
  store: MemoryStore,
  clock: Clock,
  models: ModelConfig[],
  script: Record<string, ScriptedResponder>,
  options: { budgetScopes?: AgentRuntimeDeps['budgetScopes'] } = {},
): ScriptedWorld {
  const world: ScriptedWorld = { runtime: undefined as unknown as AgentRuntime, calls: [], script, usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const providerFor = (kind: ProviderKind): ModelProvider => ({
    kind,
    async generateStructured<T>(request: StructuredRequest<T>) {
      const prompt = request.messages.map((m) => m.content).join('\n');
      const call: ScriptedCall = { schemaName: request.schemaName, role: promptRole(prompt), modelId: request.model.id, provider: request.model.provider, prompt };
      world.calls.push(call);
      world.beforeRespond?.(call);
      const responder = world.script[request.schemaName];
      if (!responder) throw new Error(`no scripted response for ${request.schemaName}`);
      return { data: request.schema.parse(responder(call)), usage: { ...world.usage }, stopReason: 'end_turn', providerModelId: request.model.modelId };
    },
  });
  const providers: ProviderResolver = { get: (model) => providerFor(model.provider) };
  world.runtime = new AgentRuntime({
    models: () => models,
    providers,
    agentRuns: store.agentRuns,
    usage: store.usage,
    addProjectUsage: (id, cost, tokens) => store.projects.addUsage(id, cost, tokens),
    addTaskUsage: (id, cost, tokens) => store.tasks.addUsage(id, cost, tokens),
    events: store.events,
    budgetScopes: options.budgetScopes ?? (async () => []),
    globalRoleOverrides: () => ({}),
    clock,
  });
  return world;
}
