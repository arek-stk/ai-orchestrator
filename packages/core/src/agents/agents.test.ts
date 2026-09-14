import { describe, expect, it } from 'vitest';
import { DEFAULT_COUNCIL_SETTINGS } from '../domain/project';
import type { AgentRun, AgentRunResult, UsageEntry } from '../domain/records';
import { ProviderError, type ModelProvider, type ProviderResolver, type StructuredRequest } from '../models/provider';
import type { ModelConfig } from '../models/types';
import type { AgentRunRepository, EmitEvent, NewAgentRun } from '../ports';
import { LlmAgent } from './contract';
import { runCouncil, synthesizeOpinions } from './council';
import { AGENT_DEFINITIONS, renderAgentInput, type AgentInput } from './definitions';
import { AgentRuntime, type AgentRuntimeDeps } from './runtime';
import type { DesignOpinion, PlanOutput } from './schemas';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function modelConfig(id: string, provider: ModelConfig['provider'], inputPerMTok: number): ModelConfig {
  return {
    id,
    provider,
    providerConfigId: null,
    modelId: id.split('/')[1]!,
    displayName: id,
    tier: 'reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok, outputPerMTok: inputPerMTok * 5, cacheReadPerMTok: null, cacheWritePerMTok: null },
    latency: 'medium',
    codingScore: 95,
    reasoningScore: 95,
    capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: true },
    enabled: true,
  };
}

type Handler = (request: StructuredRequest<unknown>) => unknown;

class FakeProvider implements ModelProvider {
  readonly calls: StructuredRequest<unknown>[] = [];
  constructor(
    readonly kind: ModelConfig['provider'],
    private readonly handler: Handler,
  ) {}
  async generateStructured<T>(request: StructuredRequest<T>) {
    this.calls.push(request as StructuredRequest<unknown>);
    const result = this.handler(request as StructuredRequest<unknown>);
    if (result instanceof Error) throw result;
    return {
      data: request.schema.parse(result),
      usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
      providerModelId: request.model.modelId,
    };
  }
}

function harness(options: { handlers?: Partial<Record<ModelConfig['provider'], Handler>>; spent?: number } = {}) {
  const cheap = modelConfig('alpha/cheap', 'anthropic', 1);
  const pricey = modelConfig('beta/pricey', 'openai', 3);
  const providers = {
    anthropic: new FakeProvider('anthropic', options.handlers?.anthropic ?? (() => new Error('no handler'))),
    openai: new FakeProvider('openai', options.handlers?.openai ?? (() => new Error('no handler'))),
  };
  const resolver: ProviderResolver = { get: (m) => providers[m.provider as 'anthropic' | 'openai'] ?? null };
  const agentRuns: Array<AgentRun & { result?: AgentRunResult }> = [];
  const ledger: UsageEntry[] = [];
  const events: EmitEvent[] = [];
  const projectUsage: number[] = [];

  const agentRunRepo: AgentRunRepository = {
    start: async (run: NewAgentRun) => {
      const record = { ...run, id: `agr_${agentRuns.length + 1}`, status: 'running' } as AgentRun;
      agentRuns.push(record);
      return record;
    },
    finish: async (id, result) => {
      const record = agentRuns.find((r) => r.id === id)!;
      record.status = result.status;
      record.result = result;
    },
    list: async () => agentRuns,
  };

  const deps: AgentRuntimeDeps = {
    models: () => [cheap, pricey],
    providers: resolver,
    agentRuns: agentRunRepo,
    usage: { record: async (e) => void ledger.push(e), totalCostSince: async () => 0 },
    addProjectUsage: async (_id, cost) => void projectUsage.push(cost),
    addTaskUsage: async () => {},
    events: { emit: async (e) => void events.push(e) },
    budgetScopes: async () => [{ scope: 'project', limitUsd: 10, spentUsd: options.spent ?? 0 }],
    globalRoleOverrides: () => ({}),
  };
  return { runtime: new AgentRuntime(deps), providers, agentRuns, ledger, events, projectUsage, cheap, pricey };
}

const input: AgentInput = {
  project: { name: 'Shop', description: 'E-commerce', languages: ['TypeScript'] },
  task: { title: 'Add login', goal: 'Users can log in', kind: 'feature', risk: 'medium', estimatedComplexity: 'medium', acceptanceCriteria: ['401 on bad password'] },
  sections: [],
  files: [],
};
const scope = { projectId: 'prj_1', taskId: 'tsk_1', runId: 'run_1' };

const plan: PlanOutput = {
  goal: 'Login',
  approach: 'Session cookies',
  tasks: [
    { key: 'api', title: 'API', description: 'POST /login', role: 'backend', dependsOn: [], acceptanceCriteria: ['401 on bad password'] },
    { key: 'ui', title: 'UI', description: 'Form', role: 'frontend', dependsOn: ['api'], acceptanceCriteria: ['form posts'] },
  ],
  risks: [],
  acceptanceCriteria: ['401 on bad password'],
  estimatedComplexity: 'medium',
  requiresDesign: false,
  touchesAreas: ['auth'],
  openQuestions: [],
  confidence: 0.9,
};

// ---------------------------------------------------------------------------

describe('AgentRuntime', () => {
  it('routes, calls the provider, verifies and records spend', async () => {
    const h = harness({ handlers: { anthropic: () => plan } });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.plan, input, scope, complexity: 'medium', risk: 'medium' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output.tasks).toHaveLength(2);
    expect(outcome.model.id).toBe('alpha/cheap');
    expect(outcome.costUsd).toBeCloseTo((10_000 * 1 + 2_000 * 5) / 1_000_000);
    expect(h.agentRuns[0]).toMatchObject({ status: 'succeeded', role: 'planner' });
    expect(h.ledger).toHaveLength(1);
    expect(h.events.map((e) => e.type)).toEqual(['agent.started', 'agent.completed']);
    // Stable system prompt, volatile task data only in the user message.
    const call = h.providers.anthropic.calls[0]!;
    expect(call.system).toBe(AGENT_DEFINITIONS.plan.systemPrompt);
    expect(call.messages[0]!.content).toContain('Title: Add login');
  });

  it('falls back to another provider when the primary is unavailable', async () => {
    const h = harness({
      handlers: { anthropic: () => new ProviderError('unavailable', 'overloaded', 'anthropic'), openai: () => plan },
    });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.plan, input, scope, complexity: 'medium', risk: 'medium' });
    expect(outcome.ok && outcome.model.id).toBe('beta/pricey');
    expect(h.providers.anthropic.calls).toHaveLength(1);
  });

  it('bills tokens of failed attempts (e.g. truncated output) before falling back', async () => {
    const billed = { inputTokens: 10_000, outputTokens: 64_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const h = harness({
      handlers: {
        anthropic: () => new ProviderError('invalid_output', 'output truncated at max_tokens', 'anthropic', { usage: billed }),
        openai: () => plan,
      },
    });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.plan, input, scope, complexity: 'medium', risk: 'medium' });
    expect(outcome.ok).toBe(true);
    const truncatedCost = (10_000 * 1 + 64_000 * 5) / 1_000_000;
    const servedCost = (10_000 * 3 + 2_000 * 15) / 1_000_000;
    expect(h.ledger.map((e) => e.modelId)).toEqual(['cheap', 'pricey']);
    expect(outcome.costUsd).toBeCloseTo(truncatedCost + servedCost);
    expect(h.projectUsage.reduce((a, b) => a + b, 0)).toBeCloseTo(truncatedCost + servedCost);
  });

  it('does not fall back on invalid requests', async () => {
    const h = harness({
      handlers: { anthropic: () => new ProviderError('invalid_request', 'bad schema', 'anthropic'), openai: () => plan },
    });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.plan, input, scope, complexity: 'medium', risk: 'medium' });
    expect(outcome).toMatchObject({ ok: false, kind: 'provider' });
    expect(h.providers.openai.calls).toHaveLength(0);
    expect(h.events.at(-1)?.type).toBe('agent.failed');
  });

  it('pauses without calling a model when the budget is exhausted', async () => {
    const h = harness({ handlers: { anthropic: () => plan }, spent: 10 });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.plan, input, scope, complexity: 'medium', risk: 'medium' });
    expect(outcome).toMatchObject({ ok: false, kind: 'budget_paused' });
    expect(h.providers.anthropic.calls).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual(['budget.exhausted']);
  });

  it('treats outputs that fail semantic verification as failed attempts', async () => {
    const unsafeBuild = {
      summary: 'oops',
      changes: [{ path: '../../etc/passwd', action: 'update', content: 'root', rationale: 'x' }],
      notes: [],
      confidence: 0.4,
    };
    const h = harness({ handlers: { anthropic: () => unsafeBuild } });
    const outcome = await h.runtime.run({ definition: AGENT_DEFINITIONS.build, input, scope, complexity: 'medium', risk: 'medium' });
    expect(outcome).toMatchObject({ ok: false, kind: 'verification' });
    expect(!outcome.ok && outcome.issues.join()).toMatch(/path traversal/);
    expect(h.agentRuns[0]?.status).toBe('failed');
    // Spend is still accounted for.
    expect(h.ledger).toHaveLength(1);
  });

  it('plan verification rejects dependency cycles and unknown keys', () => {
    const cyclic = { ...plan, tasks: [{ ...plan.tasks[0]!, dependsOn: ['ui'] }, { ...plan.tasks[1]!, dependsOn: ['api', 'ghost'] }] };
    const issues = AGENT_DEFINITIONS.plan.verify(cyclic);
    expect(issues.join('\n')).toMatch(/unknown key ghost/);
    expect(issues.join('\n')).toMatch(/dependency cycle/);
  });

  it('renders input with safe fences and redaction', () => {
    const rendered = renderAgentInput({
      ...input,
      files: [{ path: 'README.md', mode: 'full', content: 'Use ```js blocks``` and token ghp_' + 'q'.repeat(36), tokens: 10, reasons: [] }],
    });
    expect(rendered).toContain('````');
    expect(rendered).not.toContain('ghp_q');
  });
});

describe('LlmAgent contract', () => {
  it('implements canHandle / plan / execute / verify', async () => {
    const h = harness({ handlers: { anthropic: () => plan } });
    const agent = new LlmAgent(AGENT_DEFINITIONS.plan, h.runtime, ['feature', 'bugfix']);
    expect(agent.canHandle({ kind: 'feature' })).toBe(true);
    expect(agent.canHandle({ kind: 'docs' })).toBe(false);
    expect((await agent.plan({ title: 'Add login' })).tools).toEqual(['repository.read', 'repository.search']);
    const outcome = await agent.execute({ title: 'Add login' }, { input, scope, complexity: 'medium', risk: 'medium' });
    expect(await agent.verify(outcome)).toEqual({ ok: true, issues: [] });
  });
});

describe('council', () => {
  const opinion = (optionId: string, confidence: number): DesignOpinion => ({
    options: [
      { id: 'option-a', summary: 'Server sessions', pros: ['revocable'], cons: ['state'] },
      { id: 'option-b', summary: 'JWT', pros: ['stateless'], cons: ['revocation'] },
    ],
    recommendedOptionId: optionId,
    rationale: `prefers ${optionId}`,
    risks: [],
    confidence,
  });

  it('synthesizes agreement-weighted confidence', () => {
    const synthesis = synthesizeOpinions([
      { role: 'architect', output: opinion('option-a', 0.9) },
      { role: 'security', output: opinion('option-a', 0.8) },
      { role: 'backend', output: opinion('option-b', 0.3) },
    ]);
    expect(synthesis.chosenOptionId).toBe('option-a');
    expect(synthesis.agreement).toBeCloseTo(1.7 / 2.0);
    expect(synthesis.confidence).toBeCloseTo((1.7 / 2.0) * 0.85);
    expect(synthesis.dissent).toEqual([{ role: 'backend', optionId: 'option-b', rationale: 'prefers option-b' }]);
    expect(synthesis.options).toHaveLength(2);
  });

  it('stops after one round on consensus', async () => {
    const h = harness({ handlers: { anthropic: () => opinion('option-a', 0.92) } });
    const result = await runCouncil(
      { question: 'Session strategy?', members: ['architect', 'security'], baseInput: input, scope, complexity: 'complex', risk: 'high', settings: DEFAULT_COUNCIL_SETTINGS },
      h.runtime,
    );
    expect(result).toMatchObject({ stoppedBecause: 'consensus', escalate: false });
    expect(result.rounds).toHaveLength(1);
    expect(h.providers.anthropic.calls[0]!.messages[0]!.content).toContain('## Your perspective\narchitect');
  });

  it('runs a bounded second round and escalates persistent disagreement', async () => {
    const h = harness({
      handlers: {
        anthropic: (req) => (req.messages[0]!.content.includes('## Your perspective\narchitect') ? opinion('option-a', 0.8) : opinion('option-b', 0.8)),
      },
    });
    const result = await runCouncil(
      { question: 'Session strategy?', members: ['architect', 'security'], baseInput: input, scope, complexity: 'complex', risk: 'high', settings: DEFAULT_COUNCIL_SETTINGS },
      h.runtime,
    );
    expect(result.rounds).toHaveLength(2);
    expect(result).toMatchObject({ stoppedBecause: 'max_rounds', escalate: true });
    expect(h.providers.anthropic.calls.at(-1)!.messages[0]!.content).toContain('Positions from other specialists');
    expect(h.providers.anthropic.calls).toHaveLength(4);
  });
});
