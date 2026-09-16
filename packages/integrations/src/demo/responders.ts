import { dashSlug, type StructuredRequest } from '@orch/core';
import type { MockResponder } from '../providers/mock';

// Realistic canned outputs for demo mode (no API keys). Every responder returns data that satisfies
// the corresponding agent schema in @orch/core; the mock provider re-validates it.

function prompt(request: StructuredRequest<unknown>): string {
  return request.messages.at(-1)?.content ?? '';
}

function field(text: string, name: string, fallback: string): string {
  return new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1]?.trim() ?? fallback;
}

function criteria(text: string): string[] {
  const block = /Acceptance criteria:\n((?:- .+\n?)+)/.exec(text)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean);
}

/** Linear-time slug (the title comes from task text); keeps a dash left at the 40-character cut, as before. */
export function slugOf(title: string): string {
  return dashSlug(title).slice(0, 40) || 'change';
}

function camelOf(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function perspective(text: string): string {
  return /## Your perspective\n(\w+)/.exec(text)?.[1] ?? 'architect';
}

export function createDemoResponders(): Record<string, MockResponder> {
  return {
    analysis_output: (request) => {
      const text = prompt(request);
      return {
        summary: `Demo analysis for "${field(text, 'Title', 'task')}": modular TypeScript codebase with feature folders and colocated tests.`,
        architecture: 'Layered: HTTP routes → services → repositories. Shared utilities live in src/lib.',
        relevantPaths: ['src/features', 'src/lib'],
        conventions: ['Named exports', 'Vitest tests next to source files'],
        risks: ['Limited integration test coverage'],
        techDebt: ['Some modules lack input validation'],
        confidence: 0.78,
      };
    },

    plan_output: (request) => {
      const text = prompt(request);
      const title = field(text, 'Title', 'Change');
      const complexity = field(text, 'Complexity', 'medium') as 'simple' | 'medium' | 'complex';
      const accepted = criteria(text);
      const acceptance = accepted.length > 0 ? accepted : [`${title} works as described`, 'Existing tests keep passing'];
      return {
        goal: field(text, 'Title', title),
        approach: `Implement ${title} in a dedicated feature module with unit tests, keeping the public API backwards compatible.`,
        tasks: [
          { key: 'implement', title: `Implement ${title}`, description: 'Core logic and wiring', role: 'builder', dependsOn: [], acceptanceCriteria: acceptance },
          { key: 'tests', title: 'Cover with tests', description: 'Unit tests for happy path and edge cases', role: 'tester', dependsOn: ['implement'], acceptanceCriteria: ['Tests cover every acceptance criterion'] },
        ],
        risks: [{ description: 'Behaviour change for existing callers', severity: 'low', mitigation: 'Keep existing exports unchanged' }],
        acceptanceCriteria: acceptance,
        estimatedComplexity: complexity,
        requiresDesign: complexity === 'complex',
        touchesAreas: [`src/features/${slugOf(title)}`],
        openQuestions: [],
        confidence: 0.84,
      };
    },

    design_opinion_output: (request) => {
      const role = perspective(prompt(request));
      const confidence = role === 'security' ? 0.84 : role === 'architect' ? 0.88 : 0.8;
      return {
        options: [
          { id: 'option-a', summary: 'Extend the existing module behind a small interface', pros: ['Low risk', 'Fits current architecture'], cons: ['Less flexible later'] },
          { id: 'option-b', summary: 'Introduce a new service with its own storage', pros: ['Independent scaling'], cons: ['More moving parts', 'Migration needed'] },
        ],
        recommendedOptionId: 'option-a',
        rationale: `From the ${role} perspective option-a delivers the goal with the smallest blast radius.`,
        risks: ['Interface may need revision if requirements grow'],
        confidence,
      };
    },

    build_output: (request) => {
      const title = field(prompt(request), 'Title', 'change');
      const slug = slugOf(title);
      const fn = camelOf(slug);
      return {
        summary: `Adds the ${slug} feature module with a typed entry point and tests.`,
        changes: [
          {
            path: `src/features/${slug}.ts`,
            action: 'create',
            content: `/** ${title} */\nexport interface ${fn[0]!.toUpperCase()}${fn.slice(1)}Result {\n  ok: boolean;\n  message: string;\n}\n\nexport function ${fn}(input: string): { ok: boolean; message: string } {\n  const trimmed = input.trim();\n  if (trimmed.length === 0) return { ok: false, message: 'input required' };\n  return { ok: true, message: \`processed \${trimmed}\` };\n}\n`,
            rationale: 'Feature entry point',
          },
          {
            path: `src/features/${slug}.test.ts`,
            action: 'create',
            content: `import { describe, expect, it } from 'vitest';\nimport { ${fn} } from './${slug}';\n\ndescribe('${fn}', () => {\n  it('rejects empty input', () => {\n    expect(${fn}('  ').ok).toBe(false);\n  });\n  it('processes input', () => {\n    expect(${fn}('order-1')).toEqual({ ok: true, message: 'processed order-1' });\n  });\n});\n`,
            rationale: 'Unit tests for the feature',
          },
          // Demo of the dependency approval gate (ADR-031): tasks that mention a library, package or dependency add one.
          ...(/\b(?:dependency|dependencies|library|package)\b/i.test(title)
            ? [
                {
                  path: 'package.json',
                  action: 'update',
                  content: `${JSON.stringify({ name: 'demo-shop', type: 'module', scripts: { test: 'vitest run' }, dependencies: { zod: '^4.1.0' } }, null, 2)}\n`,
                  rationale: 'Schema validation library for parsing input',
                },
              ]
            : []),
        ],
        notes: ['Demo mode: generated by the mock provider'],
        confidence: 0.82,
      };
    },

    test_output: (request) => {
      const slug = slugOf(field(prompt(request), 'Title', 'change'));
      const fn = camelOf(slug);
      return {
        summary: 'Adds edge-case coverage.',
        testFiles: [
          {
            path: `src/features/${slug}.edge.test.ts`,
            action: 'create',
            content: `import { expect, it } from 'vitest';\nimport { ${fn} } from './${slug}';\n\nit('trims whitespace', () => {\n  expect(${fn}('  a  ').message).toBe('processed a');\n});\n`,
            rationale: 'Whitespace handling',
          },
        ],
        coverageNotes: ['Covers empty, padded and regular input'],
        confidence: 0.8,
      };
    },

    debug_output: (request) => {
      const slug = slugOf(field(prompt(request), 'Title', 'change'));
      const fn = camelOf(slug);
      return {
        reproduction: 'Ran the failing unit test from the verification output.',
        rootCause: 'Input was not trimmed before building the message.',
        evidence: [`src/features/${slug}.ts builds the message from the raw input`],
        isInfrastructureIssue: false,
        fix: [
          {
            path: `src/features/${slug}.ts`,
            action: 'update',
            content: `export function ${fn}(input: string): { ok: boolean; message: string } {\n  const trimmed = input.trim();\n  if (trimmed.length === 0) return { ok: false, message: 'input required' };\n  return { ok: true, message: \`processed \${trimmed}\` };\n}\n`,
            rationale: 'Use the trimmed value consistently',
          },
        ],
        confidence: 0.83,
      };
    },

    review_output: (request) => ({
      verdict: 'approve',
      summary: 'Change is small, typed and tested.',
      issues: [{ severity: 'low', path: null, description: 'Consider documenting the new module in the README.', suggestion: 'Add a short usage note.' }],
      acceptanceCriteria: criteria(prompt(request)).map((criterion) => ({ criterion, met: true, evidence: 'Covered by unit tests in the change set.' })),
      confidence: 0.86,
    }),

    security_output: () => ({
      verdict: 'pass',
      summary: 'No injection, secret exposure or authorization issues found in the change set.',
      findings: [],
      confidence: 0.83,
    }),

    synthesis_output: () => ({
      decision: 'Adopt option-a.',
      chosenOptionId: 'option-a',
      reason: 'Both specialists prefer the lower-risk extension of the existing module.',
      dissent: [],
      evidence: ['Unanimous recommendation with high confidence'],
      confidence: 0.86,
    }),

    health_scan_output: () => ({
      summary: 'Demo health scan: the codebase is small and readable; test coverage and input validation are the main gaps.',
      proposals: [
        {
          key: 'validate-cart-input',
          category: 'tech_debt',
          title: 'Validate cart item input',
          description: 'Reject negative prices and quantities when items are added to the cart.',
          rationale: 'Invalid items silently corrupt cart totals.',
          evidence: ['src/cart.ts accepts any price and quantity'],
          affectedPaths: ['src/cart.ts'],
          impact: 'medium',
          effort: 'small',
          risk: 'low',
          acceptanceCriteria: ['addToCart rejects negative prices', 'addToCart rejects non-positive quantities'],
        },
      ],
      confidence: 0.74,
    }),

    devops_output: () => ({
      summary: 'Demo DevOps review: CI can cache dependencies and pin third-party actions.',
      suggestions: [
        {
          key: 'ci-dependency-cache',
          area: 'ci',
          category: 'performance',
          title: 'Cache npm dependencies in CI',
          description: 'Enable the setup-node npm cache to speed up CI runs.',
          rationale: 'Every CI run installs dependencies from scratch.',
          evidence: ['CI workflow installs dependencies without a cache'],
          affectedPaths: ['.github/workflows/ci.yml'],
          impact: 'low',
          effort: 'small',
          risk: 'low',
          acceptanceCriteria: ['CI uses the npm cache of actions/setup-node'],
        },
      ],
      confidence: 0.7,
    }),

    file_summary_output: (request) => ({
      summaries: [...prompt(request).matchAll(/^### (.+?) \((?:full content|summary)\)$/gm)].slice(0, 20).map((match) => ({
        path: match[1]!,
        summary: `Demo summary of ${match[1]!}: module with its exported functions and types.`,
      })),
      confidence: 0.7,
    }),

    research_output: (request) => ({
      question: field(prompt(request), 'Title', 'research question'),
      findings: [{ claim: 'The repository already contains a feature module pattern that the change can follow.', source: 'src/index.ts', confidence: 0.7 }],
      recommendation: 'Follow the existing module pattern and verify the approach with a small spike before a larger change.',
      limitations: ['Demo mode: no external sources were consulted'],
      openQuestions: [],
      confidence: 0.65,
    }),

    documentation_output: (request) => {
      const title = field(prompt(request), 'Title', 'Documentation update');
      return {
        summary: `Documents: ${title}.`,
        changes: [{ path: 'README.md', action: 'update', content: `# Demo Shop\n\nA tiny e-commerce backend used to demonstrate the orchestrator.\n\n## Notes\n\n${title}.\n`, rationale: 'Keep the README current' }],
        notes: ['Demo mode: generated by the mock provider'],
        confidence: 0.8,
      };
    },

    release_readiness_output: () => ({
      verdict: 'ready',
      summary: 'Tests, review and CI passed; no migrations in the change set.',
      checks: [
        { name: 'tests', status: 'pass', detail: 'Verification passed.' },
        { name: 'ci', status: 'pass', detail: 'CI checks passed.' },
        { name: 'migrations', status: 'skipped', detail: 'No migrations in the change set.' },
      ],
      blockers: [],
      confidence: 0.8,
    }),

    blocker_analysis_output: () => ({
      why: 'Verification kept failing with the same fingerprint after the maximum number of debug attempts.',
      missingInformation: ['Expected behaviour for edge cases'],
      alternativeApproach: 'Split the task into smaller, independently testable steps.',
      needsHuman: true,
      confidence: 0.7,
    }),

    // Autopilot decision ladder and council protocol v2 (demo): no precedent applies, research leaves a judgment call,
    // and the council agrees on the smaller option with one minor objection from the critic.
    precedent_check_output: () => ({
      verdict: 'not_applicable',
      precedentRef: null,
      quote: null,
      answer: 'No recorded decision covers this question.',
      rationale: 'Demo mode: the precedents do not address this design question.',
      confidence: 0.7,
    }),

    decision_research_output: () => ({
      answer: 'The repository does not settle this design question on its own.',
      settled: false,
      citations: [],
      limitations: ['Choosing between the options is a judgment call for the council'],
      confidence: 0.5,
    }),

    council_proposal_output: (request) => {
      const role = /Your perspective: (\w+)/.exec(prompt(request))?.[1] ?? 'architect';
      return {
        options: [
          { id: 'option-a', summary: 'Extend the existing module behind a small interface', reversibility: 'easy', blastRadius: 'small', estimatedCost: 'low' },
          { id: 'option-b', summary: 'Introduce a new service with its own storage', reversibility: 'hard', blastRadius: 'large', estimatedCost: 'high' },
        ],
        recommendedOptionId: 'option-a',
        claims: [{ optionId: 'option-a', text: `From the ${role} perspective option-a keeps the change small and reversible.`, evidence: [] }],
        assumptions: ['Both options deliver the same user-visible behaviour'],
        confidence: 0.82,
      };
    },

    council_critique_output: () => ({
      objections: [
        {
          id: 'obj-interface',
          targetOptionId: 'option-a',
          severity: 'minor',
          kind: 'risk',
          claim: 'The small interface may need revision if requirements grow.',
          evidence: [],
          falsifier: null,
        },
      ],
      confidence: 0.6,
    }),

    council_vote_output: () => ({
      responses: [{ objectionId: 'obj-interface', stance: 'accept', argument: 'Acceptable: the interface is internal and easy to change.', evidence: [] }],
      optionId: 'option-a',
      changedBecause: null,
      confidence: 0.8,
    }),
  };
}
