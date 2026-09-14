import type { AgentRole, Complexity, Risk } from '../domain/enums';
import { estimateCostUsd } from './registry';
import type { ModelCapabilities, ModelConfig, ModelTier } from './types';

export interface RoutingRequest {
  role: AgentRole;
  complexity: Complexity;
  risk: Risk;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  needs?: Partial<ModelCapabilities>;
  /** Failed attempts so far for this step; each one raises the quality floor. */
  priorFailures?: number;
  /** Remaining budget headroom; models whose estimate exceeds it are ineligible. */
  maxCostUsd?: number | null;
  /** Explicit pin for this run (highest precedence). */
  pinnedModelId?: string | null;
  /** Project role override, else global role override (resolved by the caller). */
  roleOverrideModelId?: string | null;
  /** Models that already failed for this step (e.g. provider outage). */
  excludeModelIds?: readonly string[];
}

export interface CandidateEvaluation {
  modelId: string;
  eligible: boolean;
  reason: string;
  quality: number;
  estimatedCostUsd: number;
}

export interface RoutingDecision {
  model: ModelConfig;
  source: 'pinned' | 'override' | 'auto';
  estimatedCostUsd: number;
  quality: number;
  qualityFloor: number;
  belowQualityFloor: boolean;
  reason: string;
  /** Ordered fallback chain, preferring other providers first. */
  fallbacks: ModelConfig[];
  candidates: CandidateEvaluation[];
}

export class NoEligibleModelError extends Error {
  constructor(
    readonly candidates: CandidateEvaluation[],
    readonly budgetLimited: boolean,
  ) {
    super(
      budgetLimited
        ? 'No model fits the remaining budget'
        : `No eligible model: ${candidates.map((c) => `${c.modelId} (${c.reason})`).join('; ') || 'registry is empty'}`,
    );
    this.name = 'NoEligibleModelError';
  }
}

const TIERS: readonly ModelTier[] = ['fast', 'balanced', 'reasoning'];
const TIER_QUALITY_FLOOR: Record<ModelTier, number> = { fast: 55, balanced: 80, reasoning: 92 };

export const ROLE_BASE_TIER: Readonly<Record<AgentRole, ModelTier>> = Object.freeze({
  orchestrator: 'reasoning',
  project_analyst: 'fast',
  planner: 'balanced',
  architect: 'reasoning',
  builder: 'balanced',
  frontend: 'balanced',
  backend: 'balanced',
  database: 'balanced',
  security: 'reasoning',
  tester: 'balanced',
  debugger: 'balanced',
  reviewer: 'balanced',
  researcher: 'balanced',
  documentation: 'fast',
  devops: 'balanced',
  release: 'balanced',
});

const CODING_ROLES: ReadonlySet<AgentRole> = new Set(['builder', 'frontend', 'backend', 'database', 'tester', 'debugger', 'devops']);
const REASONING_ROLES: ReadonlySet<AgentRole> = new Set(['orchestrator', 'planner', 'architect', 'security', 'reviewer']);
const LATENCY_RANK = { low: 0, medium: 1, high: 2 } as const;

export function requiredTier(request: Pick<RoutingRequest, 'role' | 'complexity' | 'risk' | 'priorFailures'>): ModelTier {
  let index = TIERS.indexOf(ROLE_BASE_TIER[request.role]);
  if (request.complexity === 'simple') index -= 1;
  if (request.complexity === 'complex') index += 1;
  if (request.risk === 'high') index = Math.max(index, 1) + 1;
  index += Math.min(2, request.priorFailures ?? 0);
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, index))]!;
}

export function modelQuality(model: Pick<ModelConfig, 'codingScore' | 'reasoningScore'>, role: AgentRole): number {
  if (CODING_ROLES.has(role)) return model.codingScore;
  if (REASONING_ROLES.has(role)) return model.reasoningScore;
  return (model.codingScore + model.reasoningScore) / 2;
}

/**
 * Cost-aware model selection (spec §8, §30; ADR-005).
 * Precedence: run pin → role override → automatic routing. Automatic routing picks the cheapest
 * eligible model that meets the quality floor for the role/complexity/risk/failure history.
 */
export function selectModel(
  request: RoutingRequest,
  models: readonly ModelConfig[],
  isProviderAvailable: (model: ModelConfig) => boolean,
): RoutingDecision {
  const floor = TIER_QUALITY_FLOOR[requiredTier(request)];
  const excluded = new Set(request.excludeModelIds ?? []);
  const requiredContext = request.estimatedInputTokens + request.expectedOutputTokens;

  const candidates: CandidateEvaluation[] = models.map((model) => {
    const quality = modelQuality(model, request.role);
    const estimatedCostUsd = estimateCostUsd(model, request.estimatedInputTokens, request.expectedOutputTokens);
    const reject = (reason: string): CandidateEvaluation => ({ modelId: model.id, eligible: false, reason, quality, estimatedCostUsd });

    if (!model.enabled) return reject('disabled');
    if (excluded.has(model.id)) return reject('excluded after failure');
    if (!isProviderAvailable(model)) return reject(`provider ${model.provider} not configured`);
    if (model.contextWindow < requiredContext) return reject(`context window ${model.contextWindow} < ${requiredContext}`);
    if (model.maxOutputTokens < request.expectedOutputTokens) return reject(`max output ${model.maxOutputTokens} < ${request.expectedOutputTokens}`);
    for (const [capability, needed] of Object.entries(request.needs ?? {}) as [keyof ModelCapabilities, boolean][]) {
      if (needed && !model.capabilities[capability]) return reject(`missing capability ${capability}`);
    }
    if (request.maxCostUsd !== undefined && request.maxCostUsd !== null && estimatedCostUsd > request.maxCostUsd) {
      return reject(`estimated $${estimatedCostUsd.toFixed(4)} exceeds budget $${request.maxCostUsd.toFixed(4)}`);
    }
    return { modelId: model.id, eligible: true, reason: 'eligible', quality, estimatedCostUsd };
  });

  const byId = new Map(models.map((m) => [m.id, m]));
  const evaluation = new Map(candidates.map((c) => [c.modelId, c]));
  const eligible = candidates.filter((c) => c.eligible);

  const buildFallbacks = (chosen: ModelConfig): ModelConfig[] =>
    eligible
      .filter((c) => c.modelId !== chosen.id)
      .sort((a, b) => {
        const providerA = byId.get(a.modelId)!.provider === chosen.provider ? 1 : 0;
        const providerB = byId.get(b.modelId)!.provider === chosen.provider ? 1 : 0;
        return providerA - providerB || b.quality - a.quality || a.estimatedCostUsd - b.estimatedCostUsd;
      })
      .slice(0, 3)
      .map((c) => byId.get(c.modelId)!);

  const decide = (candidate: CandidateEvaluation, source: RoutingDecision['source'], reason: string): RoutingDecision => {
    const model = byId.get(candidate.modelId)!;
    return {
      model,
      source,
      estimatedCostUsd: candidate.estimatedCostUsd,
      quality: candidate.quality,
      qualityFloor: floor,
      belowQualityFloor: candidate.quality < floor,
      reason,
      fallbacks: buildFallbacks(model),
      candidates,
    };
  };

  const notes: string[] = [];
  for (const [id, source] of [
    [request.pinnedModelId, 'pinned'],
    [request.roleOverrideModelId, 'override'],
  ] as const) {
    if (!id) continue;
    const candidate = evaluation.get(id);
    if (candidate?.eligible) return decide(candidate, source, `${source} model`);
    notes.push(`${source} model ${id} ignored: ${candidate?.reason ?? 'unknown model'}`);
  }

  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  const meetsFloor = eligible
    .filter((c) => c.quality >= floor)
    .sort(
      (a, b) =>
        a.estimatedCostUsd - b.estimatedCostUsd ||
        b.quality - a.quality ||
        LATENCY_RANK[byId.get(a.modelId)!.latency] - LATENCY_RANK[byId.get(b.modelId)!.latency],
    );
  if (meetsFloor.length > 0) {
    return decide(meetsFloor[0]!, 'auto', `cheapest model meeting quality floor ${floor}${suffix}`);
  }

  if (eligible.length > 0) {
    const best = [...eligible].sort((a, b) => b.quality - a.quality || a.estimatedCostUsd - b.estimatedCostUsd)[0]!;
    return decide(best, 'auto', `no model meets quality floor ${floor}; using best available${suffix}`);
  }

  const budgetLimited = candidates.some((c) => c.reason.startsWith('estimated $'));
  throw new NoEligibleModelError(candidates, budgetLimited);
}
