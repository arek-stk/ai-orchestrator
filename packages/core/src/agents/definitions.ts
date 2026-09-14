import type { z } from 'zod';
import { findCycle } from '../dag/dag';
import type { AgentRole } from '../domain/enums';
import type { Task } from '../domain/task';
import type { ContextFile } from '../context/context-builder';
import type { ReasoningEffort } from '../models/provider';
import { normalizeRepoPath, UnsafePathError } from '../security/paths';
import { redactSecrets } from '../security/secrets';
import { DEFAULT_TOOL_PERMISSIONS, type ToolName } from '../tools/tool-router';
import {
  AnalysisOutputSchema,
  BlockerAnalysisSchema,
  BuildOutputSchema,
  DebugOutputSchema,
  DesignOpinionSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  SecurityOutputSchema,
  SynthesisOutputSchema,
  TestOutputSchema,
  type BuildOutput,
  type DebugOutput,
  type DesignOpinion,
  type FileChangeOutput,
  type PlanOutput,
  type ReviewOutput,
  type SecurityOutput,
  type TestOutput,
} from './schemas';

export type AgentKey =
  | 'analyze'
  | 'plan'
  | 'design_opinion'
  | 'build'
  | 'test'
  | 'debug'
  | 'review'
  | 'security_audit'
  | 'synthesize'
  | 'blocker_analysis';

export interface AgentDefinition<S extends z.ZodType = z.ZodType> {
  key: AgentKey;
  role: AgentRole;
  name: string;
  schemaName: string;
  schema: S;
  /** Stable, cacheable instructions. Never interpolate volatile data here. */
  systemPrompt: string;
  expectedOutputTokens: number;
  effort: ReasoningEffort;
  tools: readonly ToolName[];
  /** Deterministic checks beyond the schema; returns issues (empty = valid). */
  verify?(output: z.infer<S>): string[];
}

/** Everything an agent sees. Rendered into the (volatile) user message. */
export interface AgentInput {
  project: { name: string; description: string; languages: readonly string[] };
  task: Pick<Task, 'title' | 'goal' | 'kind' | 'risk' | 'estimatedComplexity' | 'acceptanceCriteria'>;
  question?: string;
  sections: ReadonlyArray<{ title: string; body: string }>;
  files: readonly ContextFile[];
}

function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function renderAgentInput(input: AgentInput): string {
  const lines: string[] = ['## Project', `Name: ${input.project.name}`];
  if (input.project.description) lines.push(`Description: ${input.project.description}`);
  if (input.project.languages.length > 0) lines.push(`Languages: ${input.project.languages.join(', ')}`);

  const { task } = input;
  lines.push('', '## Task', `Title: ${task.title}`, `Kind: ${task.kind}`, `Risk: ${task.risk}`, `Complexity: ${task.estimatedComplexity}`, 'Goal:', task.goal);
  if (task.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (input.question) lines.push('', '## Question', input.question);
  for (const section of input.sections) lines.push('', `## ${section.title}`, section.body);
  if (input.files.length > 0) {
    lines.push('', '## Relevant files');
    for (const file of input.files) {
      const fence = fenceFor(file.content);
      lines.push(`### ${file.path} (${file.mode === 'full' ? 'full content' : 'summary'})`, fence, file.content, fence);
    }
  }
  return redactSecrets(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

function verifyChanges(changes: readonly FileChangeOutput[], label: string): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    let path: string;
    try {
      path = normalizeRepoPath(change.path);
    } catch (error) {
      issues.push(`${label}: ${error instanceof UnsafePathError ? error.message : String(error)}`);
      continue;
    }
    if (seen.has(path)) issues.push(`${label}: duplicate change for ${path}`);
    seen.add(path);
    if (change.action !== 'delete' && (change.content === null || change.content.length === 0)) {
      issues.push(`${label}: ${path} is ${change.action}d without content`);
    }
    if (change.content && /(\/\/|#)\s*\.\.\.\s*(rest|existing|unchanged)/i.test(change.content)) {
      issues.push(`${label}: ${path} contains a placeholder instead of full content`);
    }
  }
  return issues;
}

function verifyPlan(output: PlanOutput): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const task of output.tasks) {
    if (keys.has(task.key)) issues.push(`duplicate task key ${task.key}`);
    keys.add(task.key);
  }
  for (const task of output.tasks) {
    for (const dep of task.dependsOn) if (!keys.has(dep)) issues.push(`task ${task.key} depends on unknown key ${dep}`);
  }
  const cycle = findCycle(output.tasks.map((t) => ({ id: t.key, dependencies: t.dependsOn })));
  if (cycle) issues.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return issues;
}

function verifyDesign(output: DesignOpinion): string[] {
  return output.options.some((o) => o.id === output.recommendedOptionId)
    ? []
    : [`recommended option ${output.recommendedOptionId} is not among the options`];
}

function verifyBuild(output: BuildOutput): string[] {
  return output.changes.length === 0 ? ['build produced no changes'] : verifyChanges(output.changes, 'build');
}

function verifyTests(output: TestOutput): string[] {
  return verifyChanges(output.testFiles, 'tests');
}

function verifyDebug(output: DebugOutput): string[] {
  if (output.isInfrastructureIssue) return output.fix.length > 0 ? ['infrastructure issue must not change code'] : [];
  return output.fix.length === 0 ? ['code failure diagnosed but no fix proposed'] : verifyChanges(output.fix, 'fix');
}

function verifyReview(output: ReviewOutput): string[] {
  const blocking = output.issues.filter((i) => i.severity === 'critical' || i.severity === 'high');
  if (output.verdict === 'approve' && blocking.length > 0) return ['review approves despite critical/high issues'];
  if (output.verdict === 'request_changes' && output.issues.length === 0) return ['review requests changes without issues'];
  return [];
}

function verifySecurity(output: SecurityOutput): string[] {
  const blocking = output.findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  return blocking && output.verdict === 'pass' ? ['security passes despite high/critical findings'] : [];
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const PREAMBLE = [
  'You are a specialist agent in an autonomous software delivery system.',
  'The orchestrator gives you one bounded job. You advise or produce artifacts; the orchestrator makes decisions.',
  'Respond only with JSON that matches the provided schema.',
  'Base every claim on the provided context. When information is missing, say so in the relevant field instead of guessing.',
  'Never output secrets or credentials.',
  'confidence is your calibrated probability (0 to 1) that your output is correct and sufficient.',
].join('\n');

const prompt = (name: string, body: string) => `${PREAMBLE}\n\nRole: ${name}\n\n${body}`;

export const AGENT_DEFINITIONS = {
  analyze: {
    key: 'analyze',
    role: 'project_analyst',
    name: 'Project Analyst',
    schemaName: 'analysis_output',
    schema: AnalysisOutputSchema,
    systemPrompt: prompt(
      'Project Analyst',
      'Summarise the project state relevant to the task: architecture, conventions, the paths that matter, risks and technical debt. Be compact: later agents read your summary instead of the repository.',
    ),
    expectedOutputTokens: 3_000,
    effort: 'low',
    tools: DEFAULT_TOOL_PERMISSIONS.project_analyst,
  },
  plan: {
    key: 'plan',
    role: 'planner',
    name: 'Planning Agent',
    schemaName: 'plan_output',
    schema: PlanOutputSchema,
    systemPrompt: prompt(
      'Planning Agent',
      'Turn the task into an executable plan. Split into sub-tasks only when they can be built and verified independently, and express ordering through dependsOn keys. Every acceptance criterion must be objectively checkable. Set requiresDesign when an architectural choice with real trade-offs is involved.',
    ),
    expectedOutputTokens: 4_000,
    effort: 'medium',
    tools: DEFAULT_TOOL_PERMISSIONS.planner,
    verify: verifyPlan,
  },
  design_opinion: {
    key: 'design_opinion',
    role: 'architect',
    name: 'Design Specialist',
    schemaName: 'design_opinion_output',
    schema: DesignOpinionSchema,
    systemPrompt: prompt(
      'Design Specialist',
      'Evaluate the question from the perspective named in the input. Offer two or three genuinely different options when the context allows, recommend one and explain the trade-off. If positions from other specialists are provided, reconsider them honestly and change your recommendation only for substantive reasons.',
    ),
    expectedOutputTokens: 3_000,
    effort: 'high',
    tools: DEFAULT_TOOL_PERMISSIONS.architect,
    verify: verifyDesign,
  },
  build: {
    key: 'build',
    role: 'builder',
    name: 'Build Agent',
    schemaName: 'build_output',
    schema: BuildOutputSchema,
    systemPrompt: prompt(
      'Build Agent',
      'Implement the plan as a minimal, complete change set. Provide full file contents for created or updated files: no diffs, no placeholders, no elided sections. Only touch paths inside the repository and within the task scope, and follow the project conventions. Add or update tests for behaviour you change. If a previous attempt failed, fix the described cause instead of rewriting unrelated code.',
    ),
    expectedOutputTokens: 32_000,
    effort: 'high',
    tools: DEFAULT_TOOL_PERMISSIONS.builder,
    verify: verifyBuild,
  },
  test: {
    key: 'test',
    role: 'tester',
    name: 'Test Agent',
    schemaName: 'test_output',
    schema: TestOutputSchema,
    systemPrompt: prompt(
      'Test Agent',
      'Write tests that verify the acceptance criteria against the change set: happy paths, edge cases, and regression tests for any fixed bug. Use the existing test framework and conventions of the project. Return complete test files.',
    ),
    expectedOutputTokens: 16_000,
    effort: 'medium',
    tools: DEFAULT_TOOL_PERMISSIONS.tester,
    verify: verifyTests,
  },
  debug: {
    key: 'debug',
    role: 'debugger',
    name: 'Debug Agent',
    schemaName: 'debug_output',
    schema: DebugOutputSchema,
    systemPrompt: prompt(
      'Debug Agent',
      'A verification step failed. Work like a debugger: reproduce from the failure output, identify the root cause with evidence from the code, then propose the smallest fix. If the failure comes from infrastructure (network, CI runner, rate limits, missing credentials) rather than code, set isInfrastructureIssue to true and return no fix. Do not repeat fixes listed as previously failed.',
    ),
    expectedOutputTokens: 16_000,
    effort: 'high',
    tools: DEFAULT_TOOL_PERMISSIONS.debugger,
    verify: verifyDebug,
  },
  review: {
    key: 'review',
    role: 'reviewer',
    name: 'Code Review Agent',
    schemaName: 'review_output',
    schema: ReviewOutputSchema,
    systemPrompt: prompt(
      'Code Review Agent',
      'Review the change set like a senior engineer: correctness, security, performance, maintainability, test quality and regressions. Check every acceptance criterion and cite evidence. Request changes only for issues that matter and rate severity honestly. Approve when the change is correct and complete, even if you have minor suggestions.',
    ),
    expectedOutputTokens: 4_000,
    effort: 'medium',
    tools: DEFAULT_TOOL_PERMISSIONS.reviewer,
    verify: verifyReview,
  },
  security_audit: {
    key: 'security_audit',
    role: 'security',
    name: 'Security Agent',
    schemaName: 'security_output',
    schema: SecurityOutputSchema,
    systemPrompt: prompt(
      'Security Agent',
      'Audit the change set for vulnerabilities: authentication and authorization flaws, injection (SQL, command, template), XSS, CSRF, SSRF, insecure deserialization, secrets in code, unsafe dependencies, sensitive data exposure and missing input validation. Report only concrete findings tied to the code, each with remediation. The verdict is fail when any high or critical finding exists.',
    ),
    expectedOutputTokens: 4_000,
    effort: 'high',
    tools: DEFAULT_TOOL_PERMISSIONS.security,
    verify: verifySecurity,
  },
  synthesize: {
    key: 'synthesize',
    role: 'orchestrator',
    name: 'Orchestrator (decision synthesis)',
    schemaName: 'synthesis_output',
    schema: SynthesisOutputSchema,
    systemPrompt: prompt(
      'Orchestrator',
      'Specialist opinions on a decision are provided. Weigh evidence, not votes. Choose an option, state why, list the strongest dissent and give a calibrated confidence.',
    ),
    expectedOutputTokens: 2_000,
    effort: 'high',
    tools: [],
  },
  blocker_analysis: {
    key: 'blocker_analysis',
    role: 'orchestrator',
    name: 'Orchestrator (blocker analysis)',
    schemaName: 'blocker_analysis_output',
    schema: BlockerAnalysisSchema,
    systemPrompt: prompt(
      'Orchestrator',
      'A pipeline run is blocked after repeated failures or exhausted limits. Explain why, what information is missing, whether a materially different approach is worth trying, and whether a human decision is required.',
    ),
    expectedOutputTokens: 2_000,
    effort: 'medium',
    tools: [],
  },
} as const satisfies Record<AgentKey, AgentDefinition>;

export type AgentDefinitions = typeof AGENT_DEFINITIONS;
