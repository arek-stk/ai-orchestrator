import type { Stage } from '../domain/enums';
import type { Project } from '../domain/project';
import type { Task } from '../domain/task';

export interface StagePlanItem {
  stage: Stage;
  run: boolean;
  reason: string;
}

export type StagePlanTask = Pick<Task, 'kind' | 'risk' | 'estimatedComplexity' | 'title' | 'goal' | 'acceptanceCriteria'>;
export type StagePlanProject = Pick<Project, 'autonomyLevel' | 'profile' | 'repo'>;

const SECURITY_KEYWORDS =
  /\b(auth\w*|login|logout|sign[- ]?in|password|passwd|token|secret|credential|permission|rbac|role|session|crypto\w*|encrypt\w*|payment|billing|upload|sql|oauth|jwt|csrf|cors|xss|ssrf|injection|cookie|webhook|admin)\b/i;

export function isSecurityRelevant(task: StagePlanTask): boolean {
  if (task.kind === 'security' || task.risk === 'high') return true;
  const text = [task.title, task.goal, ...task.acceptanceCriteria].join('\n');
  return SECURITY_KEYWORDS.test(text);
}

/**
 * Decides which pipeline stages a task needs (spec §11). Every skipped stage carries a reason so
 * the decision is visible in the dashboard.
 */
export function planStages(task: StagePlanTask, project: StagePlanProject): StagePlanItem[] {
  const level = project.autonomyLevel;
  const { checks } = project.profile;
  const docsOnly = task.kind === 'docs';
  const items: StagePlanItem[] = [];
  const add = (stage: Stage, run: boolean, reason: string) => items.push({ stage, run, reason });
  const needsLevel = (min: number, what: string) =>
    level >= min ? null : `Autonomy level ${level} does not permit ${what} (requires ${min}).`;

  add('INTAKE', true, 'Validate and normalise the task.');

  const trivialDocs = docsOnly && task.estimatedComplexity === 'simple';
  add('ANALYZE', !trivialDocs, trivialDocs ? 'Simple documentation change needs no repository analysis.' : 'Build a compact project state for the task.');

  const planBlock = needsLevel(1, 'planning');
  add('PLAN', planBlock === null, planBlock ?? 'Derive a structured plan with acceptance criteria.');

  const designWorthy =
    !docsOnly &&
    (task.estimatedComplexity === 'complex' ||
      task.risk === 'high' ||
      ((task.kind === 'feature' || task.kind === 'refactor') && task.estimatedComplexity === 'medium'));
  const designBlock = needsLevel(1, 'design proposals');
  add(
    'DESIGN',
    designBlock === null && designWorthy,
    designBlock ?? (designWorthy ? 'Complexity/risk warrants an architecture decision.' : 'Change is too small to need a design decision.'),
  );

  const implementBlock = needsLevel(2, 'code changes') ?? (project.repo ? null : 'No repository connected.');
  const implement = implementBlock === null;
  add('IMPLEMENT', implement, implementBlock ?? 'Produce the change set.');

  const testRun = implement && !docsOnly && checks.test;
  add(
    'TEST',
    testRun,
    !implement ? 'Nothing is implemented.' : docsOnly ? 'Documentation-only change.' : checks.test ? 'Project profile requires tests.' : 'Tests disabled in project profile.',
  );

  add('REVIEW', implement, implement ? 'Every change set is reviewed.' : 'Nothing to review.');

  const securityRelevant = isSecurityRelevant(task);
  const securityRun = implement && !docsOnly && checks.security && securityRelevant;
  add(
    'SECURITY',
    securityRun,
    !implement
      ? 'Nothing is implemented.'
      : docsOnly
        ? 'Documentation-only change needs no security audit.'
        : !checks.security
          ? 'Security checks disabled in project profile.'
          : securityRelevant
            ? 'Task touches security-relevant areas.'
            : 'No security-relevant surface detected.',
  );

  add('VERIFY', implement, implement ? 'Verify the Definition of Done.' : 'Nothing to verify.');

  const publishBlock = implement ? needsLevel(3, 'publishing changes to GitHub') : 'Nothing is implemented.';
  const publish = publishBlock === null;
  add('COMMIT', publish, publishBlock ?? 'Create the commit on a feature branch.');
  add('PUSH', publish, publishBlock ?? 'Update the feature branch ref.');
  add('PR', publish, publishBlock ?? 'Open or update the pull request.');

  const ciRun = publish && project.profile.hasCi;
  add('CI', ciRun, !publish ? (publishBlock ?? 'Nothing published.') : ciRun ? 'Wait for CI checks.' : 'Project has no CI configured.');

  const deployBlock = publish ? needsLevel(4, 'autonomous delivery') : 'Nothing published.';
  const deployRun = deployBlock === null && project.profile.deployWorkflow !== null;
  add(
    'DEPLOY',
    deployRun,
    deployBlock ?? (deployRun ? 'Deploy via configured workflow (approval gate applies).' : 'No deploy workflow configured.'),
  );
  add('MONITOR', deployRun, deployRun ? 'Watch the deployment outcome.' : 'No deployment to monitor.');

  return items;
}

export function stagesToRun(plan: readonly StagePlanItem[]): Stage[] {
  return plan.filter((item) => item.run).map((item) => item.stage);
}
