import { describe, expect, it } from 'vitest';
import { defaultProjectProfile } from '../domain/project';
import { planStages, stagesToRun, type StagePlanProject, type StagePlanTask } from './stage-planner';
import type { AutonomyLevel } from '../domain/enums';

const repo = { owner: 'acme', name: 'shop', defaultBranch: 'main' };

function projectAt(level: AutonomyLevel, extra: Partial<StagePlanProject> = {}): StagePlanProject {
  return { autonomyLevel: level, profile: defaultProjectProfile(), repo, ...extra };
}

function taskOf(extra: Partial<StagePlanTask> = {}): StagePlanTask {
  return {
    kind: 'feature',
    risk: 'medium',
    estimatedComplexity: 'medium',
    title: 'Add product filter',
    goal: 'Users can filter products by category',
    acceptanceCriteria: [],
    ...extra,
  };
}

describe('planStages', () => {
  it('keeps a small README change lean: no design, tests or security audit', () => {
    const plan = planStages(taskOf({ kind: 'docs', estimatedComplexity: 'simple', title: 'Fix README typo', goal: 'Fix typo' }), projectAt(3));
    expect(stagesToRun(plan)).toEqual(['INTAKE', 'PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'COMMIT', 'PUSH', 'PR', 'CI']);
    const security = plan.find((p) => p.stage === 'SECURITY')!;
    expect(security.reason).toMatch(/Documentation-only/);
  });

  it('adds design and security stages for complex authentication work', () => {
    const plan = planStages(
      taskOf({ title: 'Implement user authentication', goal: 'Login with sessions', estimatedComplexity: 'complex' }),
      projectAt(3),
    );
    const run = stagesToRun(plan);
    expect(run).toContain('DESIGN');
    expect(run).toContain('SECURITY');
    expect(run).toContain('TEST');
  });

  it('level 0 only observes', () => {
    expect(stagesToRun(planStages(taskOf(), projectAt(0)))).toEqual(['INTAKE', 'ANALYZE']);
  });

  it('level 2 executes but never publishes', () => {
    const run = stagesToRun(planStages(taskOf(), projectAt(2)));
    expect(run).toContain('IMPLEMENT');
    expect(run).toContain('VERIFY');
    expect(run).not.toContain('COMMIT');
    expect(run).not.toContain('PR');
  });

  it('level 4 deploys only when a deploy workflow exists', () => {
    expect(stagesToRun(planStages(taskOf(), projectAt(4)))).not.toContain('DEPLOY');
    const profile = { ...defaultProjectProfile(), deployWorkflow: 'deploy.yml' };
    const run = stagesToRun(planStages(taskOf(), projectAt(4, { profile })));
    expect(run.slice(-2)).toEqual(['DEPLOY', 'MONITOR']);
  });

  it('does not implement without a connected repository', () => {
    const plan = planStages(taskOf(), projectAt(3, { repo: null }));
    expect(plan.find((p) => p.stage === 'IMPLEMENT')).toMatchObject({ run: false, reason: 'No repository connected.' });
    expect(stagesToRun(plan)).not.toContain('PR');
  });
});
