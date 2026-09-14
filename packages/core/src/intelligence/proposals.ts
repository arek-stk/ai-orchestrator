import { createHash } from 'node:crypto';
import type { Effort, Impact, ImprovementCategory, ProposalItem } from '../agents/schemas';
import type { AutonomyLevel, Complexity, Risk, TaskKind } from '../domain/enums';
import { TaskInputSchema, type TaskInput } from '../domain/task';
import type { HealthSignals, ImprovementProposal, ProposalSource } from './types';

const IMPACT_WEIGHT: Readonly<Record<Impact, number>> = { low: 1, medium: 2, high: 3 };
const EFFORT_WEIGHT: Readonly<Record<Effort, number>> = { small: 1, medium: 2, large: 4 };
const RISK_WEIGHT: Readonly<Record<Risk, number>> = { low: 1, medium: 1.5, high: 2.5 };
const MAX_ROI = (IMPACT_WEIGHT.high * 10) / (EFFORT_WEIGHT.small * RISK_WEIGHT.low);
const MIN_ROI = (IMPACT_WEIGHT.low * 10) / (EFFORT_WEIGHT.large * RISK_WEIGHT.high);

/** Return on investment: value per unit of effort, discounted by risk. Range 1–30. */
export function roiScore(p: Pick<ProposalItem, 'impact' | 'effort' | 'risk'>): number {
  return Math.round(((IMPACT_WEIGHT[p.impact] * 10) / (EFFORT_WEIGHT[p.effort] * RISK_WEIGHT[p.risk])) * 100) / 100;
}

/** Maps ROI onto task priority 1–10 on a log scale, so doubling ROI always moves priority by the same step. */
export function priorityFromRoi(roi: number): number {
  const ratio = (Math.log(Math.max(MIN_ROI, roi)) - Math.log(MIN_ROI)) / (Math.log(MAX_ROI) - Math.log(MIN_ROI));
  return Math.max(1, Math.min(10, Math.round(1 + 9 * ratio)));
}

/** Same improvement across scans = same category and normalised title. */
export function proposalFingerprint(category: ImprovementCategory, title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${category}|${normalized}`).digest('hex').slice(0, 24);
}

export interface ScoredProposal extends ProposalItem {
  source: ProposalSource;
  fingerprint: string;
  roiScore: number;
  priority: number;
}

export function scoreProposal(item: ProposalItem, source: ProposalSource): ScoredProposal {
  const roi = roiScore(item);
  return { ...item, source, fingerprint: proposalFingerprint(item.category, item.title), roiScore: roi, priority: priorityFromRoi(roi) };
}

function keyOf(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'proposal'
  );
}

function proposal(item: Omit<ProposalItem, 'key'>): ProposalItem {
  return { key: keyOf(item.title), ...item };
}

/** Improvements that follow directly from the signals; the scan agent adds what heuristics cannot see. */
export function heuristicProposals(signals: HealthSignals): ProposalItem[] {
  const items: ProposalItem[] = [];

  const untested = signals.untestedModules.filter((m) => m.importers > 0 || signals.files.tests === 0).slice(0, 3);
  for (const module of untested) {
    items.push(
      proposal({
        category: 'missing_tests',
        title: `Add unit tests for ${module.path}`,
        description: `${module.path} has no matching test file. Add unit tests for its exported behaviour.`,
        rationale: module.importers > 0 ? `Imported by ${module.importers} file(s); regressions spread widely.` : 'The project has no tests at all.',
        evidence: [`No test file matches ${module.path}`, `${signals.files.tests} test file(s) for ${signals.files.source} source file(s)`],
        affectedPaths: [module.path],
        impact: module.importers >= 3 ? 'high' : 'medium',
        effort: 'small',
        risk: 'low',
        acceptanceCriteria: [`Tests cover the exported functions of ${module.path}`, 'The test suite passes'],
      }),
    );
  }

  if (signals.dependencies.unpinned.length > 0) {
    const listed = signals.dependencies.unpinned.slice(0, 8);
    items.push(
      proposal({
        category: 'outdated_dependencies',
        title: 'Pin unbounded dependency version ranges',
        description: 'Replace wildcard, "latest" and open-ended version ranges with bounded ranges and commit the lockfile.',
        rationale: 'Unbounded ranges make builds irreproducible and can pull breaking or compromised releases.',
        evidence: listed.map((d) => `${d.manifest}: ${d.name} "${d.range}"`),
        affectedPaths: [...new Set(listed.map((d) => d.manifest))],
        impact: 'medium',
        effort: 'small',
        risk: 'low',
        acceptanceCriteria: ['No dependency uses "*", "latest" or an open-ended range', 'Install and tests succeed with the pinned ranges'],
      }),
    );
  }

  if (signals.sensitiveFiles.length > 0) {
    items.push(
      proposal({
        category: 'security_risk',
        title: 'Remove committed sensitive files',
        description: 'Remove credential-like files from the repository, add them to .gitignore and rotate any exposed secrets.',
        rationale: 'Committed credentials can be read by anyone with repository access, including its history.',
        evidence: signals.sensitiveFiles.slice(0, 10).map((p) => `Sensitive file tracked: ${p}`),
        affectedPaths: signals.sensitiveFiles.slice(0, 10),
        impact: 'high',
        effort: 'small',
        // Rotation and history cleanup need a human; never auto-accepted.
        risk: 'medium',
        acceptanceCriteria: ['No sensitive files are tracked', '.gitignore excludes them', 'Exposed secrets are rotated'],
      }),
    );
  }

  if (!signals.docs.readme) {
    items.push(
      proposal({
        category: 'documentation',
        title: 'Add a README',
        description: 'Add a README with purpose, setup, commands and project structure.',
        rationale: 'Without a README contributors and agents lack the basic project context.',
        evidence: ['No README file at the repository root'],
        affectedPaths: ['README.md'],
        impact: 'medium',
        effort: 'small',
        risk: 'low',
        acceptanceCriteria: ['README.md explains purpose, setup and the main commands'],
      }),
    );
  } else if (!signals.docs.changelog && signals.files.source >= 10) {
    items.push(
      proposal({
        category: 'documentation',
        title: 'Add a changelog',
        description: 'Introduce CHANGELOG.md and record notable changes per release.',
        rationale: 'Release readiness checks and users rely on a changelog.',
        evidence: ['No CHANGELOG file at the repository root'],
        affectedPaths: ['CHANGELOG.md'],
        impact: 'low',
        effort: 'small',
        risk: 'low',
        acceptanceCriteria: ['CHANGELOG.md exists with an entry for the current version'],
      }),
    );
  }

  for (const failure of signals.failures.filter((f) => f.hits >= 2).slice(0, 2)) {
    items.push(
      proposal({
        category: 'tech_debt',
        title: `Fix recurring failure ${failure.key.slice(0, 12)}`,
        description: `A failure with fingerprint ${failure.key} recurred ${failure.hits} times: ${failure.summary}`,
        rationale: 'Recurring failures consume debug attempts and budget in every run that hits them.',
        evidence: [`Failure memory ${failure.key}: ${failure.hits} occurrences`],
        affectedPaths: [],
        impact: 'high',
        effort: 'medium',
        risk: 'medium',
        acceptanceCriteria: ['The failure no longer occurs in verification', 'A regression test covers it'],
      }),
    );
  }

  for (const path of signals.files.largeModules.slice(0, 2)) {
    items.push(
      proposal({
        category: 'tech_debt',
        title: `Split large module ${path}`,
        description: `${path} is very large. Extract cohesive parts into smaller modules without changing behaviour.`,
        rationale: 'Large modules are hard to review, test and fit into model context.',
        evidence: [`${path} exceeds 40 KB`],
        affectedPaths: [path],
        impact: 'medium',
        effort: 'large',
        risk: 'medium',
        acceptanceCriteria: ['No resulting module exceeds 40 KB', 'Behaviour and tests are unchanged'],
      }),
    );
  }

  return items;
}

export const CATEGORY_TASK_KIND: Readonly<Record<ImprovementCategory, TaskKind>> = {
  tech_debt: 'refactor',
  missing_tests: 'test',
  outdated_dependencies: 'chore',
  security_risk: 'security',
  performance: 'improvement',
  ux: 'improvement',
  documentation: 'docs',
};

const EFFORT_COMPLEXITY: Readonly<Record<Effort, Complexity>> = { small: 'simple', medium: 'medium', large: 'complex' };
const EFFORT_MAX_COST: Readonly<Record<Effort, number>> = { small: 2, medium: 5, large: 10 };

/** Improvements never outrank requested work: their task priority is capped at 5. */
export function proposalTaskInput(p: Pick<ImprovementProposal, 'title' | 'description' | 'rationale' | 'category' | 'priority' | 'acceptanceCriteria' | 'risk' | 'effort'>): TaskInput {
  const title = p.title.length >= 3 ? p.title.slice(0, 200) : `Improvement: ${p.title}`;
  const goal = [p.description, p.rationale ? `Why: ${p.rationale}` : ''].filter(Boolean).join('\n\n').slice(0, 5000);
  return TaskInputSchema.parse({
    title,
    goal: goal.length >= 3 ? goal : title,
    kind: CATEGORY_TASK_KIND[p.category],
    priority: Math.max(1, Math.min(5, p.priority)),
    acceptanceCriteria: p.acceptanceCriteria.map((c) => c.slice(0, 500)).filter((c) => c.trim().length > 0).slice(0, 30),
    risk: p.risk,
    estimatedComplexity: EFFORT_COMPLEXITY[p.effort],
    maxCost: EFFORT_MAX_COST[p.effort],
  });
}

/** "No unrequested large changes": only small, low-risk improvements start on their own, and only from level 3. */
export function isAutoAcceptable(p: Pick<ImprovementProposal, 'risk' | 'effort'>, autonomyLevel: AutonomyLevel): boolean {
  return autonomyLevel >= 3 && p.risk === 'low' && p.effort === 'small';
}
