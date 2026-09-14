import { describe, expect, it } from 'vitest';
import { schedule, type SchedulableProject, type SchedulableTask, type SchedulerInput } from './scheduler';

const now = new Date('2026-09-14T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function project(id: string, priority: number, extra: Partial<SchedulableProject> = {}): SchedulableProject {
  return {
    id,
    priority,
    status: 'IDLE',
    maxConcurrentTasks: 5,
    budgetUsd: 100,
    spentUsd: 0,
    lastScheduledAt: now,
    ...extra,
  };
}

function task(id: string, projectId: string, extra: Partial<SchedulableTask> = {}): SchedulableTask {
  return {
    id,
    projectId,
    priority: 5,
    status: 'READY',
    dependencies: [],
    risk: 'medium',
    readySince: now,
    createdAt: now,
    ...extra,
  };
}

function input(overrides: Partial<SchedulerInput>): SchedulerInput {
  return {
    now,
    projects: [],
    tasks: [],
    taskStatuses: new Map(),
    runningTasksByProject: new Map(),
    globalCapacity: 1,
    globalRunning: 0,
    globalBudgetExhausted: false,
    ...overrides,
  };
}

describe('scheduler', () => {
  it('gives resources to the highest-priority project first', () => {
    const result = schedule(
      input({
        projects: [project('A', 10), project('B', 5), project('C', 8)],
        tasks: [task('b1', 'B'), task('a1', 'A'), task('c1', 'C')],
      }),
    );
    expect(result.selected.map((s) => s.taskId)).toEqual(['a1']);
    expect(result.skipped.map((s) => s.reason)).toEqual(['global_capacity_reached', 'global_capacity_reached']);
  });

  it('prevents starvation: a long-waiting low-priority project eventually wins', () => {
    const result = schedule(
      input({
        projects: [project('A', 10), project('B', 5, { lastScheduledAt: minutesAgo(600) })],
        tasks: [task('a1', 'A'), task('b1', 'B', { readySince: minutesAgo(180) })],
      }),
    );
    expect(result.selected[0]?.taskId).toBe('b1');
  });

  it('spreads capacity across projects with similar priority', () => {
    const result = schedule(
      input({
        globalCapacity: 2,
        projects: [project('A', 10), project('B', 9)],
        tasks: [task('a1', 'A'), task('a2', 'A'), task('a3', 'A'), task('b1', 'B')],
      }),
    );
    expect(result.selected.map((s) => s.projectId).sort()).toEqual(['A', 'B']);
  });

  it('respects per-project concurrency limits', () => {
    const result = schedule(
      input({
        globalCapacity: 5,
        projects: [project('A', 10, { maxConcurrentTasks: 2 })],
        runningTasksByProject: new Map([['A', 1]]),
        tasks: [task('a1', 'A'), task('a2', 'A')],
      }),
    );
    expect(result.selected).toHaveLength(1);
    expect(result.skipped).toEqual([{ taskId: expect.any(String), projectId: 'A', reason: 'project_concurrency_limit' }]);
  });

  it('only schedules tasks whose dependencies are done', () => {
    const result = schedule(
      input({
        globalCapacity: 5,
        projects: [project('A', 10)],
        taskStatuses: new Map([
          ['api', 'RUNNING'],
          ['schema', 'DONE'],
          ['broken', 'FAILED'],
        ]),
        tasks: [
          task('ui', 'A', { dependencies: ['api'] }),
          task('migrate', 'A', { dependencies: ['schema'] }),
          task('deploy', 'A', { dependencies: ['broken'] }),
        ],
      }),
    );
    expect(result.selected.map((s) => s.taskId)).toEqual(['migrate']);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.taskId, s.reason]));
    expect(reasons.ui).toBe('waiting_on_dependencies:api');
    expect(reasons.deploy).toBe('dependency_failed:broken');
  });

  it('skips paused projects and exhausted budgets', () => {
    const result = schedule(
      input({
        globalCapacity: 5,
        projects: [project('P', 10, { status: 'PAUSED' }), project('B', 10, { budgetUsd: 10, spentUsd: 10 })],
        tasks: [task('p1', 'P'), task('b1', 'B')],
      }),
    );
    expect(result.selected).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['project_budget_exhausted', 'project_paused']);

    const global = schedule(
      input({ projects: [project('A', 10)], tasks: [task('a1', 'A')], globalBudgetExhausted: true }),
    );
    expect(global.skipped[0]?.reason).toBe('global_budget_exhausted');
  });

  it('ignores tasks that are not schedulable', () => {
    const result = schedule(
      input({ projects: [project('A', 10)], tasks: [task('done', 'A', { status: 'DONE' }), task('run', 'A', { status: 'RUNNING' })] }),
    );
    expect(result).toEqual({ selected: [], skipped: [] });
  });
});
