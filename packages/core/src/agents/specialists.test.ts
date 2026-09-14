import { describe, expect, it } from 'vitest';
import { defaultProjectProfile, defaultProjectSettings } from '../domain/project';
import type { ModelProvider, StructuredRequest } from '../models/provider';
import type { ModelConfig } from '../models/types';
import { createOrchestratorTools } from '../orchestrator/tools';
import { unavailableSandbox } from '../sandbox/port';
import { isDocumentationPath } from '../security/paths';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { createMemoryStore } from '../testing/memory-store';
import { ToolDeniedError, type ToolContext } from '../tools/tool-router';
import { agentCacheKey, NON_CACHEABLE_AGENT_KEYS } from './cache';
import { AGENT_DEFINITIONS, type AgentDefinition, type AgentInput } from './definitions';
import { AgentRuntime } from './runtime';
import type { AnalysisOutput, ProposalItem } from './schemas';

const model: ModelConfig = {
  id: 'mock/test',
  provider: 'mock',
  providerConfigId: null,
  modelId: 'test',
  displayName: 'Test',
  tier: 'reasoning',
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWritePerMTok: null },
  latency: 'low',
  codingScore: 95,
  reasoningScore: 95,
  capabilities: { structuredOutput: true, vision: false, tools: true, reasoning: true },
  enabled: true,
};

const analysis: AnalysisOutput = { summary: 'shop', architecture: 'layers', relevantPaths: [], conventions: [], risks: [], techDebt: [], confidence: 0.8 };

function harness(respond: (request: StructuredRequest<unknown>) => unknown = () => analysis) {
  let time = Date.parse('2026-09-14T10:00:00Z');
  const clock = { now: () => new Date(time) };
  const store = createMemoryStore(clock);
  const calls: string[] = [];
  const provider: ModelProvider = {
    kind: 'mock',
    async generateStructured<T>(request: StructuredRequest<T>) {
      calls.push(request.schemaName);
      return {
        data: request.schema.parse(respond(request as StructuredRequest<unknown>)),
        usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: 'end_turn',
        providerModelId: 'test',
      };
    },
  };
  const runtime = new AgentRuntime({
    models: () => [model],
    providers: { get: () => provider },
    agentRuns: store.agentRuns,
    usage: store.usage,
    addProjectUsage: async () => {},
    addTaskUsage: async () => {},
    events: store.events,
    budgetScopes: async () => [],
    globalRoleOverrides: () => ({}),
    clock,
    cache: store.agentCache,
  });
  return { store, runtime, calls, advance: (ms: number) => (time += ms) };
}

const input: AgentInput = {
  project: { name: 'Shop', description: '', languages: ['TypeScript'] },
  task: { title: 'Analyze', goal: 'Understand the shop', kind: 'chore', risk: 'low', estimatedComplexity: 'simple', acceptanceCriteria: [] },
  sections: [],
  files: [],
};
const scope = { projectId: 'prj_1', taskId: null, runId: null };

describe('agent output cache', () => {
  it('serves a repeated identical request from the cache and records the savings', async () => {
    const h = harness();
    const first = await h.runtime.run({ definition: AGENT_DEFINITIONS.analyze, input, scope, complexity: 'simple', risk: 'low' });
    const second = await h.runtime.run({ definition: AGENT_DEFINITIONS.analyze, input, scope, complexity: 'simple', risk: 'low' });

    expect(first.ok && first.cached).toBeFalsy();
    expect(second).toMatchObject({ ok: true, cached: true, costUsd: 0 });
    expect(h.calls).toEqual(['analysis_output']);
    const [miss, hit] = h.store.ledger;
    expect(miss!.cacheHit).toBeUndefined();
    expect(hit).toMatchObject({ cacheHit: true, costUsd: 0 });
    expect(hit!.savedUsd).toBeCloseTo(miss!.costUsd);
    expect([...h.store.agentCache.entries.values()][0]!.hits).toBe(1);
    expect(h.store.events.log.at(-1)).toMatchObject({ type: 'agent.completed', payload: { cached: true } });
  });

  it('misses after the TTL, for other projects and for changed prompts', async () => {
    const h = harness();
    const run = (overrides: Partial<{ input: AgentInput; projectId: string }> = {}) =>
      h.runtime.run({ definition: AGENT_DEFINITIONS.analyze, input: overrides.input ?? input, scope: { ...scope, projectId: overrides.projectId ?? 'prj_1' }, complexity: 'simple', risk: 'low' });
    await run();
    await run({ projectId: 'prj_2' });
    await run({ input: { ...input, task: { ...input.task, goal: 'Something else' } } });
    h.advance(25 * 60 * 60 * 1000);
    await run();
    expect(h.calls).toHaveLength(4);
  });

  it('never caches code-changing agents, even when misconfigured with a TTL', async () => {
    const h = harness(() => ({ summary: 'x', changes: [{ path: 'src/a.ts', action: 'create', content: 'export {};\n', rationale: 'r' }], notes: [], confidence: 0.9 }));
    const build = { ...AGENT_DEFINITIONS.build, cacheTtlMs: 60_000 } as AgentDefinition<typeof AGENT_DEFINITIONS.build.schema>;
    await h.runtime.run({ definition: build, input, scope, complexity: 'simple', risk: 'low' });
    await h.runtime.run({ definition: build, input, scope, complexity: 'simple', risk: 'low' });
    expect(h.calls).toHaveLength(2);
    expect(h.store.agentCache.entries.size).toBe(0);
    for (const key of ['build', 'test', 'debug', 'review', 'security_audit', 'documentation', 'release_readiness']) expect(NON_CACHEABLE_AGENT_KEYS.has(key)).toBe(true);
  });

  it('treats cached values that no longer pass the schema as a miss', async () => {
    const h = harness();
    const key = agentCacheKey({ projectId: 'prj_1', definitionKey: 'analyze', modelId: model.id, systemPrompt: AGENT_DEFINITIONS.analyze.systemPrompt, prompt: '' });
    expect(key.startsWith('agent:analyze:')).toBe(true);
    await h.runtime.run({ definition: AGENT_DEFINITIONS.analyze, input, scope, complexity: 'simple', risk: 'low' });
    for (const entry of h.store.agentCache.entries.values()) entry.value = { ...entry.value, output: { broken: true } };
    await h.runtime.run({ definition: AGENT_DEFINITIONS.analyze, input, scope, complexity: 'simple', risk: 'low' });
    expect(h.calls).toHaveLength(2);
  });
});

const proposal: ProposalItem = {
  key: 'cart-tests',
  category: 'missing_tests',
  title: 'Add tests for the cart module',
  description: 'cart.ts has no tests',
  rationale: 'Most imported module',
  evidence: ['src/cart.ts is imported by 3 files and has no test file'],
  affectedPaths: ['src/cart.ts'],
  impact: 'high',
  effort: 'small',
  risk: 'low',
  acceptanceCriteria: ['cartTotal is covered by unit tests'],
};

describe('specialist verification', () => {
  it('health scan proposals need evidence, criteria, unique keys and safe paths', () => {
    const verify = AGENT_DEFINITIONS.health_scan.verify;
    expect(verify({ summary: 'ok', proposals: [proposal], confidence: 0.8 })).toEqual([]);
    const issues = verify({ summary: 'bad', proposals: [proposal, { ...proposal, evidence: [], acceptanceCriteria: [], affectedPaths: ['../etc/passwd'] }], confidence: 0.8 });
    expect(issues.join('\n')).toMatch(/duplicate key/);
    expect(issues.join('\n')).toMatch(/no evidence/);
    expect(issues.join('\n')).toMatch(/no acceptance criteria/);
    expect(issues.join('\n')).toMatch(/path traversal/);
  });

  it('devops suggestions follow the same grounding rules', () => {
    expect(AGENT_DEFINITIONS.devops_review.verify({ summary: 's', suggestions: [{ ...proposal, area: 'ci', evidence: [] }], confidence: 0.7 })).toHaveLength(1);
  });

  it('documentation changes are restricted to documentation files', () => {
    const verify = AGENT_DEFINITIONS.documentation.verify;
    const doc = { path: 'README.md', action: 'update' as const, content: '# Shop\n', rationale: 'usage' };
    expect(verify({ summary: 's', changes: [doc], notes: [], confidence: 0.9 })).toEqual([]);
    expect(verify({ summary: 's', changes: [], notes: [], confidence: 0.9 })).toEqual(['documentation produced no changes']);
    expect(verify({ summary: 's', changes: [{ ...doc, path: 'src/index.ts' }], notes: [], confidence: 0.9 }).join()).toMatch(/not a documentation file/);
    expect(['README.md', 'docs/guide.md', 'CHANGELOG.md', 'api/openapi.yaml'].every(isDocumentationPath)).toBe(true);
    expect(['src/index.ts', '.env', 'docs/secrets/key.pem', 'package.json'].some(isDocumentationPath)).toBe(false);
  });

  it('release readiness verdicts must agree with checks and blockers', () => {
    const verify = AGENT_DEFINITIONS.release_readiness.verify;
    const checks = [{ name: 'tests' as const, status: 'fail' as const, detail: 'failing' }];
    expect(verify({ verdict: 'ready', summary: 's', checks, blockers: [], confidence: 0.9 })).toEqual(['release is ready despite failing checks or blockers']);
    expect(verify({ verdict: 'not_ready', summary: 's', checks, blockers: [], confidence: 0.9 })).toEqual(['release is not ready without naming blockers']);
    expect(verify({ verdict: 'not_ready', summary: 's', checks, blockers: ['tests failing'], confidence: 0.9 })).toEqual([]);
  });

  it('research needs a recommendation and either findings or limitations', () => {
    const verify = AGENT_DEFINITIONS.research.verify;
    expect(verify({ question: 'q', findings: [], recommendation: 'use x', limitations: [], openQuestions: [], confidence: 0.5 })).toHaveLength(1);
    expect(verify({ question: 'q', findings: [{ claim: 'x works', source: 'README.md', confidence: 0.7 }], recommendation: 'use x', limitations: [], openQuestions: [], confidence: 0.7 })).toEqual([]);
  });

  it('gives specialists least-privilege tools; research and release cannot write or deploy', () => {
    expect(AGENT_DEFINITIONS.research.tools).toEqual([]);
    expect(AGENT_DEFINITIONS.release_readiness.tools).not.toContain('deploy.run');
    expect(AGENT_DEFINITIONS.documentation.tools).not.toContain('repository.write');
  });
});

describe('docs.write tool', () => {
  const github = new InMemoryGitHub();
  github.seed({ owner: 'acme', name: 'shop' }, { 'README.md': '# Shop\n' });
  const tools = createOrchestratorTools({ github, sandbox: unavailableSandbox, sandboxTimeoutMs: 1000 });
  const staged: Array<{ path: string }> = [];
  const ctx = (role: ToolContext['agentRole']): ToolContext => ({
    project: { id: 'prj_1', repo: { owner: 'acme', name: 'shop', defaultBranch: 'main' }, profile: defaultProjectProfile(), autonomyLevel: 2, settings: defaultProjectSettings() },
    agentRole: role,
    taskId: 't',
    runId: 'r',
    approvedActions: [],
    workspace: { apply: (change) => void staged.push(change), changes: () => [] },
  });

  it('lets the documentation agent stage documentation files only', async () => {
    await tools.invoke('docs.write', { path: 'docs/usage.md', action: 'create', content: '# Usage\n' }, ctx('documentation'));
    expect(staged.map((c) => c.path)).toEqual(['docs/usage.md']);
    await expect(tools.invoke('docs.write', { path: 'src/index.ts', action: 'create', content: 'x' }, ctx('documentation'))).rejects.toBeInstanceOf(ToolDeniedError);
    await expect(tools.invoke('repository.write', { path: 'README.md', action: 'update', content: 'x' }, ctx('documentation'))).rejects.toMatchObject({ reason: 'permission' });
    await expect(tools.invoke('docs.write', { path: 'README.md', action: 'update', content: 'x' }, ctx('builder'))).rejects.toMatchObject({ reason: 'permission' });
  });
});
