import type { StructuredRequest } from '@orch/core';
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

function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'change'
  );
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

    blocker_analysis_output: () => ({
      why: 'Verification kept failing with the same fingerprint after the maximum number of debug attempts.',
      missingInformation: ['Expected behaviour for edge cases'],
      alternativeApproach: 'Split the task into smaller, independently testable steps.',
      needsHuman: true,
      confidence: 0.7,
    }),
  };
}
