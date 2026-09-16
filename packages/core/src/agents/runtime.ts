import type { z } from 'zod';
import { checkBudget, type BudgetScope } from '../budget/budget-guard';
import type { AgentRole, Complexity, Risk } from '../domain/enums';
import { ProviderError, type ProviderResolver } from '../models/provider';
import { computeCostUsd, estimateTokens } from '../models/registry';
import { NoEligibleModelError, selectModel, type RoutingDecision } from '../models/router';
import { addUsage, totalTokens, ZERO_USAGE, type ModelConfig, type TokenUsage } from '../models/types';
import { systemClock, type AgentRunRepository, type Clock, type EventRecorder, type UsageRepository } from '../ports';
import { agentCacheKey, agentPromptHash, NON_CACHEABLE_AGENT_KEYS, type AgentCacheStore } from './cache';
import { renderAgentInput, type AgentDefinition, type AgentInput } from './definitions';

export interface AgentScope {
  projectId: string;
  taskId: string | null;
  runId: string | null;
}

export interface AgentRuntimeDeps {
  models: () => readonly ModelConfig[];
  providers: ProviderResolver;
  agentRuns: AgentRunRepository;
  usage: UsageRepository;
  addProjectUsage: (projectId: string, costUsd: number, tokens: number) => Promise<void>;
  addTaskUsage: (taskId: string, costUsd: number, tokens: number) => Promise<void>;
  events: EventRecorder;
  /** Global / project / task budget scopes for the call (computed by the composition root). */
  budgetScopes: (scope: AgentScope) => Promise<BudgetScope[]>;
  /** Global agent-role → model overrides from settings. */
  globalRoleOverrides: () => Partial<Record<AgentRole, string>>;
  clock?: Clock;
  timeoutMs?: number;
  /** Maximum models tried per call (primary + fallbacks). */
  maxModelAttempts?: number;
  /** Agent output cache for definitions with `cacheTtlMs` (spec §31). Absent = no caching. */
  cache?: AgentCacheStore;
}

export interface RunAgentRequest<S extends z.ZodType> {
  definition: AgentDefinition<S>;
  /** Role override, e.g. a security specialist giving a design opinion. */
  role?: AgentRole;
  input: AgentInput;
  scope: AgentScope;
  complexity: Complexity;
  risk: Risk;
  priorFailures?: number;
  projectRoleOverrides?: Partial<Record<AgentRole, string>>;
  pinnedModelId?: string | null;
  /** Remaining run-level budget, enforced in addition to global/project/task scopes. */
  runBudgetRemainingUsd?: number | null;
  /**
   * Restricts routing and the fallback chain to these registry models, e.g. a workflow node bound to one provider
   * account must never be answered by another vendor. Absent = every model.
   */
  allowedModelIds?: readonly string[];
}

export type AgentFailureKind = 'budget_paused' | 'no_model' | 'provider' | 'invalid_output' | 'verification';

export interface AgentSuccess<T> {
  ok: true;
  output: T;
  confidence: number | null;
  agentRunId: string;
  model: ModelConfig;
  routing: RoutingDecision;
  /** Total usage of the call, including billed failed attempts on other models. */
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
  /** Served from the agent output cache: no model call, zero cost. */
  cached?: boolean;
}

export interface AgentFailure<T> {
  ok: false;
  kind: AgentFailureKind;
  error: string;
  agentRunId: string | null;
  issues: string[];
  /** Present for verification failures: the output was produced but did not pass checks. */
  output?: T;
  model: ModelConfig | null;
  usage: TokenUsage;
  costUsd: number;
}

export type AgentOutcome<T> = AgentSuccess<T> | AgentFailure<T>;

interface Spend {
  usage: TokenUsage;
  costUsd: number;
}

/**
 * Runs one agent call: budget gate → model routing → provider call with cross-provider fallback →
 * schema + semantic verification → persistence of agent run, usage ledger and events.
 * Every billed token is accounted for, including attempts that failed after the provider charged.
 */
export class AgentRuntime {
  private readonly clock: Clock;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async run<S extends z.ZodType>(request: RunAgentRequest<S>): Promise<AgentOutcome<z.infer<S>>> {
    const { definition, scope } = request;
    const role = request.role ?? definition.role;
    const userPrompt = renderAgentInput(request.input);
    const estimatedInputTokens = estimateTokens(definition.systemPrompt + userPrompt);
    const emit = this.deps.events.emit.bind(this.deps.events);
    const base = { projectId: scope.projectId, taskId: scope.taskId, runId: scope.runId };

    const route = (maxCostUsd: number | null): RoutingDecision =>
      selectModel(
        {
          role,
          complexity: request.complexity,
          risk: request.risk,
          estimatedInputTokens,
          expectedOutputTokens: definition.expectedOutputTokens,
          needs: { structuredOutput: true },
          priorFailures: request.priorFailures ?? 0,
          maxCostUsd,
          pinnedModelId: request.pinnedModelId ?? null,
          roleOverrideModelId: request.projectRoleOverrides?.[role] ?? this.deps.globalRoleOverrides()[role] ?? null,
        },
        request.allowedModelIds ? this.deps.models().filter((model) => request.allowedModelIds!.includes(model.id)) : this.deps.models(),
        (model) => this.deps.providers.get(model) !== null,
      );

    const fail = (kind: AgentFailureKind, error: string, extra: Partial<AgentFailure<z.infer<S>>> = {}): AgentFailure<z.infer<S>> => ({
      ok: false,
      kind,
      error,
      agentRunId: null,
      issues: [],
      model: null,
      usage: { ...ZERO_USAGE },
      costUsd: 0,
      ...extra,
    });

    // 1. Route and gate on budget before any spend.
    let routing: RoutingDecision;
    try {
      routing = route(null);
    } catch (error) {
      if (error instanceof NoEligibleModelError) return fail('no_model', error.message);
      throw error;
    }

    // A cache hit costs nothing, so it is served before the budget gate.
    const cache = this.deps.cache;
    const cacheTtlMs = definition.cacheTtlMs ?? 0;
    const cacheKey =
      cache && cacheTtlMs > 0 && !NON_CACHEABLE_AGENT_KEYS.has(definition.key)
        ? agentCacheKey({ projectId: scope.projectId, definitionKey: definition.key, modelId: routing.model.id, systemPrompt: definition.systemPrompt, prompt: userPrompt })
        : null;
    if (cache && cacheKey) {
      const hit = await this.serveFromCache(cache, cacheKey, request, role, routing);
      if (hit) return hit;
    }

    const scopes = await this.deps.budgetScopes(scope);
    if (request.runBudgetRemainingUsd !== undefined && request.runBudgetRemainingUsd !== null) {
      scopes.push({ scope: 'agent', limitUsd: request.runBudgetRemainingUsd, spentUsd: 0 });
    }
    const budget = checkBudget({ estimatedCostUsd: routing.estimatedCostUsd, scopes });
    if (budget.decision === 'pause') {
      await emit({ type: 'budget.exhausted', ...base, payload: { scope: budget.limitingScope, reason: budget.reason } });
      return fail('budget_paused', budget.reason);
    }
    if (budget.decision === 'degrade') {
      try {
        routing = route(budget.headroomUsd);
      } catch (error) {
        if (!(error instanceof NoEligibleModelError)) throw error;
        await emit({ type: 'budget.exhausted', ...base, payload: { scope: budget.limitingScope, reason: budget.reason } });
        return fail('budget_paused', `${budget.reason}; no cheaper model fits`);
      }
    }

    // 2. Call the provider, falling back across the routing chain.
    const agentRun = await this.deps.agentRuns.start({
      ...base,
      role,
      inputSummary: `${definition.name}: ${request.input.task.title}`.slice(0, 500),
      modelConfigId: routing.model.id,
      provider: routing.model.provider,
      modelId: routing.model.modelId,
    });
    await emit({ type: 'agent.started', ...base, payload: { agentRunId: agentRun.id, role, modelId: routing.model.id } });

    const started = this.clock.now().getTime();
    const chain = [routing.model, ...routing.fallbacks].slice(0, this.deps.maxModelAttempts ?? 3);
    const attemptErrors: string[] = [];
    let failedSpend: Spend = { usage: { ...ZERO_USAGE }, costUsd: 0 };
    let served: { model: ModelConfig; data: z.infer<S>; usage: TokenUsage } | null = null;
    let lastError: ProviderError | null = null;

    for (const model of chain) {
      const provider = this.deps.providers.get(model);
      if (!provider) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 10 * 60_000);
      try {
        const response = await provider.generateStructured({
          model,
          system: definition.systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          schema: definition.schema,
          schemaName: definition.schemaName,
          maxOutputTokens: Math.min(definition.expectedOutputTokens, model.maxOutputTokens),
          effort: definition.effort,
          signal: controller.signal,
        });
        served = { model, data: response.data as z.infer<S>, usage: response.usage };
        break;
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError('unknown', error instanceof Error ? error.message : String(error), model.provider, { cause: error });
        lastError = providerError;
        attemptErrors.push(`${model.id}: ${providerError.kind}: ${providerError.message}`);
        if (providerError.usage) {
          const spend = await this.recordSpend(model, providerError.usage, base, agentRun.id);
          failedSpend = { usage: addUsage(failedSpend.usage, spend.usage), costUsd: failedSpend.costUsd + spend.costUsd };
        }
        if (!providerError.fallbackEligible) break;
      } finally {
        clearTimeout(timer);
      }
    }

    const durationMs = this.clock.now().getTime() - started;

    if (!served) {
      const kind: AgentFailureKind = lastError?.kind === 'invalid_output' ? 'invalid_output' : 'provider';
      const error = attemptErrors.join(' | ') || 'no provider available for the routed models';
      await this.deps.agentRuns.finish(agentRun.id, {
        status: 'failed',
        output: null,
        confidence: null,
        usage: failedSpend.usage,
        costUsd: failedSpend.costUsd,
        toolsUsed: [],
        durationMs,
        error,
        modelConfigId: routing.model.id,
        provider: routing.model.provider,
        modelId: routing.model.modelId,
      });
      await emit({ type: 'agent.failed', ...base, payload: { agentRunId: agentRun.id, role, modelId: routing.model.id, error } });
      return fail(kind, error, { agentRunId: agentRun.id, model: routing.model, usage: failedSpend.usage, costUsd: failedSpend.costUsd });
    }

    // 3. Account for spend and verify the output.
    const { model, data } = served;
    const servedSpend = await this.recordSpend(model, served.usage, base, agentRun.id);
    const usage = addUsage(servedSpend.usage, failedSpend.usage);
    const costUsd = servedSpend.costUsd + failedSpend.costUsd;
    const confidence = readConfidence(data);
    const issues = definition.verify ? definition.verify(data) : [];
    const succeeded = issues.length === 0;

    await this.deps.agentRuns.finish(agentRun.id, {
      status: succeeded ? 'succeeded' : 'failed',
      output: data,
      confidence,
      usage,
      costUsd,
      toolsUsed: [],
      durationMs,
      error: succeeded ? null : `verification: ${issues.join('; ')}`,
      modelConfigId: model.id,
      provider: model.provider,
      modelId: model.modelId,
    });

    if (!succeeded) {
      await emit({
        type: 'agent.failed',
        ...base,
        payload: { agentRunId: agentRun.id, role, modelId: model.id, error: `verification: ${issues.join('; ')}` },
      });
      return fail('verification', 'output failed verification', { agentRunId: agentRun.id, issues, output: data, model, usage, costUsd });
    }

    // Only outputs of the model the key was computed for are cached; a fallback model answers a different key.
    if (cache && cacheKey && model.id === routing.model.id) {
      try {
        await cache.set({
          key: cacheKey,
          projectId: scope.projectId,
          kind: `agent:${definition.key}`,
          contentHash: agentPromptHash(definition.systemPrompt, userPrompt),
          value: { output: data, confidence, costUsd, usage, modelId: model.id },
          expiresAt: new Date(this.clock.now().getTime() + cacheTtlMs),
        });
      } catch {
        // The cache is an optimisation; a failed write must not fail an agent call that already succeeded.
      }
    }

    await emit({
      type: 'agent.completed',
      ...base,
      payload: { agentRunId: agentRun.id, role, modelId: model.id, costUsd, tokens: totalTokens(usage), confidence },
    });
    return { ok: true, output: data, confidence, agentRunId: agentRun.id, model, routing, usage, costUsd, durationMs };
  }

  /**
   * Serves a cached output after re-validating it against the current schema and checks. The hit is recorded
   * as an agent run and a zero-cost ledger row carrying the saved amount, so dashboards can show savings.
   */
  private async serveFromCache<S extends z.ZodType>(
    cache: AgentCacheStore,
    key: string,
    request: RunAgentRequest<S>,
    role: AgentRole,
    routing: RoutingDecision,
  ): Promise<AgentSuccess<z.infer<S>> | null> {
    const { definition, scope } = request;
    const entry = await cache.get(key, this.clock.now());
    if (!entry) return null;
    const parsed = definition.schema.safeParse(entry.value.output);
    if (!parsed.success) return null;
    const data = parsed.data as z.infer<S>;
    if (definition.verify && definition.verify(data).length > 0) return null;

    const base = { projectId: scope.projectId, taskId: scope.taskId, runId: scope.runId };
    const { model } = routing;
    const confidence = readConfidence(data);
    const agentRun = await this.deps.agentRuns.start({
      ...base,
      role,
      inputSummary: `${definition.name} (cached): ${request.input.task.title}`.slice(0, 500),
      modelConfigId: model.id,
      provider: model.provider,
      modelId: model.modelId,
    });
    await this.deps.agentRuns.finish(agentRun.id, {
      status: 'succeeded',
      output: data,
      confidence,
      usage: { ...ZERO_USAGE },
      costUsd: 0,
      toolsUsed: [],
      durationMs: 0,
      error: null,
      modelConfigId: model.id,
      provider: model.provider,
      modelId: model.modelId,
      cacheHit: true,
    });
    await this.deps.usage.record({
      ...base,
      agentRunId: agentRun.id,
      provider: model.provider,
      modelId: model.modelId,
      usage: { ...ZERO_USAGE },
      costUsd: 0,
      cacheHit: true,
      savedUsd: entry.value.costUsd,
    });
    await cache.recordHit(key);
    await this.deps.events.emit({
      type: 'agent.completed',
      ...base,
      payload: { agentRunId: agentRun.id, role, modelId: model.id, costUsd: 0, tokens: 0, confidence, cached: true, savedUsd: entry.value.costUsd },
    });
    return { ok: true, output: data, confidence, agentRunId: agentRun.id, model, routing, usage: { ...ZERO_USAGE }, costUsd: 0, durationMs: 0, cached: true };
  }

  /** Writes one ledger entry and adds the spend to project and task totals. */
  private async recordSpend(
    model: ModelConfig,
    usage: TokenUsage,
    base: { projectId: string; taskId: string | null; runId: string | null },
    agentRunId: string,
  ): Promise<Spend> {
    const costUsd = computeCostUsd(model, usage);
    const tokens = totalTokens(usage);
    await this.deps.usage.record({
      projectId: base.projectId,
      taskId: base.taskId,
      agentRunId,
      provider: model.provider,
      modelId: model.modelId,
      usage,
      costUsd,
    });
    await this.deps.addProjectUsage(base.projectId, costUsd, tokens);
    if (base.taskId) await this.deps.addTaskUsage(base.taskId, costUsd, tokens);
    return { usage, costUsd };
  }
}

function readConfidence(data: unknown): number | null {
  if (typeof data === 'object' && data !== null && 'confidence' in data) {
    const value = (data as { confidence: unknown }).confidence;
    return typeof value === 'number' ? value : null;
  }
  return null;
}
