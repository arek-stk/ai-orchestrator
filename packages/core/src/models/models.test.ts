import { describe, expect, it } from 'vitest';
import { computeCostUsd, DEFAULT_MODEL_CONFIGS, estimateTokens, ModelRegistry } from './registry';
import { NoEligibleModelError, requiredTier, selectModel, type RoutingRequest } from './router';
import type { ModelConfig } from './types';

const anthropic = DEFAULT_MODEL_CONFIGS.filter((m) => m.provider === 'anthropic');
const allAvailable = () => true;

const localModel: ModelConfig = {
  id: 'openai-compatible/qwen-coder',
  provider: 'openai-compatible',
  providerConfigId: 'prv_local',
  modelId: 'qwen-coder',
  displayName: 'Local Qwen Coder',
  tier: 'balanced',
  contextWindow: 128_000,
  maxOutputTokens: 32_000,
  pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: null, cacheWritePerMTok: null },
  latency: 'medium',
  codingScore: 82,
  reasoningScore: 75,
  capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: false },
  enabled: true,
};

function request(extra: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    role: 'builder',
    complexity: 'medium',
    risk: 'medium',
    estimatedInputTokens: 20_000,
    expectedOutputTokens: 8_000,
    ...extra,
  };
}

describe('cost accounting', () => {
  it('prices input, output and cache tokens per million', () => {
    const opus = anthropic.find((m) => m.modelId === 'claude-opus-5')!;
    const cost = computeCostUsd(opus, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(5 + 2.5 + 1);
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
  });

  it('registry exposes only enabled models', () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_CONFIGS);
    expect(registry.enabled().every((m) => m.provider === 'anthropic')).toBe(true);
    expect(registry.get('mock/fast')?.enabled).toBe(false);
  });
});

describe('model router', () => {
  it('derives the required tier from role, complexity, risk and failures', () => {
    expect(requiredTier({ role: 'documentation', complexity: 'simple', risk: 'low' })).toBe('fast');
    expect(requiredTier({ role: 'builder', complexity: 'medium', risk: 'medium' })).toBe('balanced');
    expect(requiredTier({ role: 'builder', complexity: 'medium', risk: 'medium', priorFailures: 1 })).toBe('reasoning');
    expect(requiredTier({ role: 'project_analyst', complexity: 'simple', risk: 'high' })).toBe('reasoning');
  });

  it('uses a small model for simple work and a strong one for architecture', () => {
    expect(selectModel(request({ role: 'documentation', complexity: 'simple' }), anthropic, allAvailable).model.modelId).toBe('claude-haiku-4-5');
    expect(selectModel(request({ role: 'builder' }), anthropic, allAvailable).model.modelId).toBe('claude-sonnet-5');
    expect(selectModel(request({ role: 'architect', complexity: 'complex' }), anthropic, allAvailable).model.modelId).toBe('claude-opus-5');
  });

  it('escalates to a stronger model after a failed attempt', () => {
    expect(selectModel(request({ priorFailures: 1 }), anthropic, allAvailable).model.modelId).toBe('claude-opus-5');
  });

  it('prefers the cheapest model that meets the floor across providers', () => {
    const decision = selectModel(request({ role: 'documentation' }), [...anthropic, localModel], allAvailable);
    expect(decision.model.id).toBe(localModel.id);
    expect(decision.belowQualityFloor).toBe(false);
  });

  it('honours pins and role overrides, and explains ignored ones', () => {
    const pinned = selectModel(request({ pinnedModelId: 'anthropic/claude-haiku-4-5' }), anthropic, allAvailable);
    expect(pinned).toMatchObject({ source: 'pinned', belowQualityFloor: true });

    const override = selectModel(request({ roleOverrideModelId: localModel.id }), [...anthropic, localModel], allAvailable);
    expect(override.source).toBe('override');

    const ignored = selectModel(request({ roleOverrideModelId: 'nope/unknown' }), anthropic, allAvailable);
    expect(ignored.source).toBe('auto');
    expect(ignored.reason).toContain('override model nope/unknown ignored');
  });

  it('skips unconfigured providers and builds a cross-provider fallback chain', () => {
    const models = [...anthropic, localModel];
    const decision = selectModel(request(), models, (m) => m.provider !== 'openai-compatible');
    expect(decision.candidates.find((c) => c.modelId === localModel.id)?.reason).toContain('not configured');

    // The free local model meets the builder floor, so it wins; the fallback chain starts with another provider.
    const withLocal = selectModel(request({ excludeModelIds: ['anthropic/claude-sonnet-5'] }), models, allAvailable);
    expect(withLocal.model.id).toBe(localModel.id);
    expect(withLocal.fallbacks[0]?.provider).toBe('anthropic');
    expect(withLocal.fallbacks.map((m) => m.id)).not.toContain('anthropic/claude-sonnet-5');
  });

  it('degrades below the quality floor when the budget is tight', () => {
    // Haiku ≈ $0.06, Sonnet ≈ $0.12 for 20k in / 8k out.
    const decision = selectModel(request({ maxCostUsd: 0.07 }), anthropic, allAvailable);
    expect(decision.model.modelId).toBe('claude-haiku-4-5');
    expect(decision.belowQualityFloor).toBe(true);
  });

  it('throws when nothing fits, flagging budget exhaustion', () => {
    expect(() => selectModel(request({ maxCostUsd: 0.0001 }), anthropic, allAvailable)).toThrowError(
      expect.objectContaining({ name: 'NoEligibleModelError', budgetLimited: true }),
    );
    expect(() => selectModel(request({ estimatedInputTokens: 5_000_000 }), anthropic, allAvailable)).toThrow(NoEligibleModelError);
  });
});
