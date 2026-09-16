import { describe, expect, it } from 'vitest';
import { allLabels, applyLocalMove, canMoveTo, columnOf, dropIndex, fullColumnIndex, initials, isHeld, matchesFilters, moveOptions, parseDay, parseLabels, roadmapLayout } from './board';
import type { BoardColumn, Milestone, Task } from './types';

const columns: BoardColumn[] = ['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
const viewer = { id: 'usr_alice', admin: false };

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    parentId: null,
    title: 'Card',
    goal: 'Goal',
    kind: 'feature',
    status: 'READY',
    priority: 5,
    dependencies: [],
    acceptanceCriteria: [],
    risk: 'medium',
    estimatedComplexity: 'medium',
    tokenBudget: 1,
    maxCost: 5,
    maxAttempts: 3,
    attempts: 0,
    costUsd: 0,
    tokensUsed: 0,
    branch: null,
    prNumber: null,
    blockedReason: null,
    readySince: null,
    assigneeType: 'orchestrator',
    assigneeId: null,
    milestoneId: null,
    boardPosition: null,
    estimatePoints: null,
    labels: [],
    dueDate: null,
    schedulingHold: false,
    holdReason: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

function milestone(extra: Partial<Milestone>): Milestone {
  return {
    id: 'm1',
    projectId: 'p1',
    title: 'Beta',
    description: '',
    status: 'planned',
    startDate: null,
    dueDate: null,
    position: 1000,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    progress: { total: 0, done: 0, points: 0, pointsDone: 0, pct: 0, byColumn: { backlog: 0, ready: 0, in_progress: 0, review: 0, blocked: 0, done: 0, cancelled: 0 }, unestimated: 0 },
    ...extra,
  };
}

describe('board move rules (client mirror)', () => {
  it('maps statuses to columns like the server', () => {
    expect(columnOf(task({ status: 'RUNNING', prNumber: 3 }))).toBe('review');
    expect(columnOf(task({ status: 'RUNNING', prNumber: 3, assigneeType: 'user' }))).toBe('in_progress');
    expect(columnOf(task({ status: 'FAILED' }))).toBe('blocked');
  });

  it('offers only permitted destinations and an explicit release', () => {
    const options = (t: Task, v = viewer) => moveOptions(t, v, columns).map((o) => `${o.to}${o.release ? '+release' : ''}`);
    expect(options(task({ status: 'BACKLOG', schedulingHold: true }))).toEqual(['ready', 'cancelled', 'ready+release']);
    expect(options(task({ status: 'READY', schedulingHold: true }))).toEqual(['backlog', 'cancelled', 'ready+release']);
    expect(options(task({ status: 'READY', schedulingHold: false }))).toEqual(['backlog', 'cancelled']);
    expect(options(task({ status: 'RUNNING' }))).toEqual(['cancelled']);
    expect(options(task({ status: 'DONE' }))).toEqual([]);
    expect(options(task({ status: 'READY', assigneeType: 'user', assigneeId: 'usr_alice' }))).toEqual(['backlog', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
    expect(options(task({ status: 'READY', assigneeType: 'user', assigneeId: 'usr_bob' }))).toEqual(['backlog', 'blocked', 'cancelled']);
    expect(canMoveTo(task({ status: 'READY', assigneeType: 'user', assigneeId: 'usr_bob' }), 'done', { id: 'x', admin: true })).toBe(true);
    expect(isHeld(task({ status: 'READY', schedulingHold: true }))).toBe(true);
    expect(isHeld(task({ status: 'BLOCKED', schedulingHold: true }))).toBe(false);
  });
});

describe('drag and drop helpers', () => {
  it('computes the insertion index from card midpoints', () => {
    expect(dropIndex([100, 200, 300], 50)).toBe(0);
    expect(dropIndex([100, 200, 300], 150)).toBe(1);
    expect(dropIndex([100, 200, 300], 999)).toBe(3);
    expect(dropIndex([], 10)).toBe(0);
  });

  it('moves ids between columns without mutating the input', () => {
    const before = { backlog: ['a', 'b'], ready: ['c'], in_progress: [], review: [], blocked: [], done: [], cancelled: [] };
    const after = applyLocalMove(before, 'a', 'ready', 0);
    expect(after.backlog).toEqual(['b']);
    expect(after.ready).toEqual(['a', 'c']);
    expect(before.backlog).toEqual(['a', 'b']);
    expect(applyLocalMove(before, 'b', 'backlog', 0).backlog).toEqual(['b', 'a']);
  });
});

describe('filters and labels', () => {
  it('filters by milestone, assignee and label', () => {
    const t = task({ milestoneId: 'm1', assigneeType: 'user', assigneeId: 'usr_bob', labels: ['UI'] });
    expect(matchesFilters(t, { milestone: 'm1', assignee: 'usr_bob', label: 'ui' })).toBe(true);
    expect(matchesFilters(t, { milestone: 'none', assignee: '', label: '' })).toBe(false);
    expect(matchesFilters(task(), { milestone: 'none', assignee: 'orchestrator', label: '' })).toBe(true);
    expect(matchesFilters(t, { milestone: '', assignee: 'orchestrator', label: '' })).toBe(false);
    expect(allLabels([task({ labels: ['ui', 'API'] }), task({ labels: ['UI'] })])).toEqual(['API', 'ui']);
    expect(parseLabels(' ui, API ,,ui ')).toEqual(['ui', 'API']);
    expect(initials('jane.doe')).toBe('JD');
    expect(initials('bob')).toBe('BO');
  });
});

describe('roadmap layout', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');

  it('aligns the timeline to months, includes today and places bars and markers', () => {
    const layout = roadmapLayout(
      [
        milestone({ id: 'a', startDate: '2026-09-01', dueDate: '2026-09-30', status: 'active' }),
        milestone({ id: 'b', dueDate: '2026-11-15' }),
        milestone({ id: 'c', dueDate: '2026-09-10' }),
        milestone({ id: 'd' }),
      ],
      now,
    );
    expect(new Date(layout.start).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(new Date(layout.end).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(layout.months.map((m) => m.label)).toEqual(['Sep 2026', 'Oct', 'Nov']);
    expect(layout.unscheduled.map((m) => m.id)).toEqual(['d']);
    const [a, b, c] = layout.rows;
    expect(a).toMatchObject({ left: 0, marker: false, overdue: false, range: 'Sep 1 – Sep 30, 2026' });
    expect(a!.width).toBeCloseTo((30 / 91) * 100, 5);
    expect(b).toMatchObject({ marker: true, width: 0, range: 'due Nov 15, 2026' });
    expect(c).toMatchObject({ overdue: true });
    expect(layout.today).toBeGreaterThan(0);
    expect(layout.today).toBeLessThan(a!.width);
  });

  it('handles an empty roadmap and invalid dates', () => {
    const layout = roadmapLayout([], now);
    expect(layout.rows).toEqual([]);
    expect(layout.months).toHaveLength(1);
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('bad')).toBeNull();
  });
});

describe('filtered drop positions', () => {
  it('maps visible indexes to full column indexes', () => {
    const full = ['a', 'b', 'c', 'd', 'e'];
    const visible = ['b', 'd', 'e'];
    expect(fullColumnIndex(full, visible, 0, 'x')).toBe(1);
    expect(fullColumnIndex(full, visible, 1, 'x')).toBe(3);
    expect(fullColumnIndex(full, visible, 3, 'x')).toBe(5);
    expect(fullColumnIndex(full, [], 0, 'x')).toBe(5);
    // The moved card itself is excluded from both lists.
    expect(fullColumnIndex(full, visible, 1, 'b')).toBe(3);
  });
});
