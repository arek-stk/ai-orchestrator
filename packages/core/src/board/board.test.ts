import { describe, expect, it } from 'vitest';
import { schedule } from '../scheduler/scheduler';
import { describeEventForRoom } from '../room/projector';
import { columnOf, planMove, planPosition, wipState, type BoardActor, type BoardColumn, type BoardTask } from './board';
import {
  findLeaseConflicts,
  foreignTaskLeases,
  globsOverlap,
  isLeaseActive,
  LeaseGlobsSchema,
  leaseExpiry,
  MAX_LEASE_DURATION_MS,
  normalizeLeaseGlob,
  pathLeaseConflicts,
  segmentMatches,
  type Lease,
} from './leases';
import { isIsoDate, LabelsSchema, MilestoneInputSchema, milestoneProgress } from './milestones';

const now = new Date('2026-09-16T10:00:00Z');
const alice: BoardActor = { id: 'usr_alice', name: 'alice', admin: false };
const admin: BoardActor = { id: 'usr_root', name: 'root', admin: true };

const task = (extra: Partial<BoardTask> = {}): BoardTask => ({ status: 'READY', prNumber: null, assigneeType: 'orchestrator', assigneeId: null, schedulingHold: false, ...extra });
const move = (t: BoardTask, to: BoardColumn, extra: { release?: boolean; hasActiveRun?: boolean; actor?: BoardActor } = {}) =>
  planMove({ task: t, to, actor: extra.actor ?? alice, hasActiveRun: extra.hasActiveRun ?? false, release: extra.release ?? false, now });

describe('board columns and transitions', () => {
  it('derives columns from task status, owner and pull request', () => {
    expect(columnOf(task({ status: 'BACKLOG' }))).toBe('backlog');
    expect(columnOf(task({ status: 'RUNNING' }))).toBe('in_progress');
    expect(columnOf(task({ status: 'RUNNING', prNumber: 12 }))).toBe('review');
    expect(columnOf(task({ status: 'RUNNING', prNumber: 12, assigneeType: 'user' }))).toBe('in_progress');
    expect(columnOf(task({ status: 'WAITING_APPROVAL' }))).toBe('review');
    expect(columnOf(task({ status: 'PAUSED' }))).toBe('in_progress');
    expect(columnOf(task({ status: 'FAILED' }))).toBe('blocked');
    expect(columnOf(task({ status: 'CANCELLED' }))).toBe('cancelled');
  });

  it('lets people move orchestrator tasks only between Backlog, Ready and Cancelled', () => {
    expect(move(task({ status: 'BACKLOG' }), 'ready')).toMatchObject({ ok: true, patch: { status: 'READY', readySince: now } });
    for (const to of ['in_progress', 'review', 'done', 'blocked'] as const) {
      expect(move(task(), to)).toMatchObject({ ok: false, code: 'pipeline_controlled' });
    }
    expect(move(task({ status: 'RUNNING' }), 'ready')).toMatchObject({ ok: false, code: 'pipeline_controlled' });
    expect(move(task({ status: 'DONE' }), 'cancelled')).toMatchObject({ ok: false, code: 'pipeline_controlled' });
    expect(move(task({ status: 'RUNNING' }), 'cancelled', { hasActiveRun: true })).toMatchObject({ ok: true, cancelRuns: true, patch: { status: 'CANCELLED' } });
    expect(move(task({ status: 'BLOCKED' }), 'backlog', { hasActiveRun: true })).toMatchObject({ ok: false, code: 'active_run' });
    expect(move(task({ status: 'CANCELLED' }), 'backlog')).toMatchObject({ ok: true, patch: { status: 'BACKLOG', blockedReason: null } });
  });

  it('never makes a task schedulable without an explicit release', () => {
    // Moving to Backlog holds.
    expect(move(task(), 'backlog')).toMatchObject({ ok: true, schedulableBefore: true, schedulableAfter: false, patch: { schedulingHold: true, holdReason: 'Moved to Backlog by alice' } });
    // Backlog -> Ready keeps the previous hold state in both directions.
    expect(move(task({ status: 'BACKLOG', schedulingHold: true }), 'ready')).toMatchObject({ ok: true, schedulableAfter: false });
    const unheld = move(task({ status: 'BACKLOG' }), 'ready');
    expect(unheld).toMatchObject({ ok: true, schedulableBefore: true, schedulableAfter: true });
    expect(unheld.ok && 'schedulingHold' in unheld.patch).toBe(false);
    // Blocked, failed and cancelled tasks arrive on hold.
    for (const status of ['BLOCKED', 'FAILED', 'CANCELLED'] as const) {
      expect(move(task({ status }), 'ready')).toMatchObject({ ok: true, schedulableBefore: false, schedulableAfter: false, patch: { status: 'READY', schedulingHold: true } });
    }
    // Reordering never changes anything but the position.
    expect(move(task({ schedulingHold: true }), 'ready')).toMatchObject({ ok: true, patch: {}, schedulableAfter: false });
    // Release is explicit and restricted.
    expect(move(task({ status: 'BLOCKED' }), 'ready', { release: true })).toMatchObject({ ok: true, schedulableAfter: true, patch: { schedulingHold: false, holdReason: null } });
    expect(move(task({ schedulingHold: true }), 'ready', { release: true })).toMatchObject({ ok: true, schedulableAfter: true, patch: { schedulingHold: false } });
    expect(move(task(), 'backlog', { release: true })).toMatchObject({ ok: false, code: 'release_requires_ready' });
    expect(move(task({ assigneeType: 'user', assigneeId: alice.id }), 'ready', { release: true })).toMatchObject({ ok: false, code: 'release_requires_orchestrator' });
  });

  it('lets the assignee or an admin move their tasks through every column', () => {
    const mine = task({ status: 'READY', assigneeType: 'user', assigneeId: alice.id });
    expect(move(mine, 'in_progress')).toMatchObject({ ok: true, patch: { status: 'RUNNING' }, schedulableAfter: false });
    expect(move({ ...mine, status: 'RUNNING' }, 'review')).toMatchObject({ ok: true, patch: { status: 'WAITING_APPROVAL' } });
    expect(move({ ...mine, status: 'WAITING_APPROVAL' }, 'done')).toMatchObject({ ok: true, patch: { status: 'DONE' } });
    const bobs = task({ status: 'READY', assigneeType: 'user', assigneeId: 'usr_bob' });
    expect(move(bobs, 'in_progress')).toMatchObject({ ok: false, code: 'not_assignee' });
    expect(move(bobs, 'backlog')).toMatchObject({ ok: true, patch: { status: 'BACKLOG' } });
    expect(move(bobs, 'in_progress', { actor: admin })).toMatchObject({ ok: true });
    expect(move({ ...bobs, status: 'BLOCKED' }, 'ready')).toMatchObject({ ok: true, patch: { status: 'READY', blockedReason: null } });
    expect(move(bobs, 'done', { hasActiveRun: true, actor: admin })).toMatchObject({ ok: false, code: 'active_run' });
  });
});

describe('board ordering and WIP', () => {
  const t = (id: string, boardPosition: number | null, priority = 5, created = 0) => ({ id, boardPosition, priority, createdAt: new Date(now.getTime() + created) });

  it('inserts between neighbours and at the ends', () => {
    const column = [t('a', 1000), t('b', 2000), t('c', 3000)];
    expect(planPosition(column, 1)).toEqual({ position: 1500, renumber: [] });
    expect(planPosition(column, 0)).toEqual({ position: 0, renumber: [] });
    expect(planPosition(column, undefined)).toEqual({ position: 4000, renumber: [] });
    expect(planPosition([], 3)).toEqual({ position: 1000, renumber: [] });
  });

  it('renumbers the column when positions are missing or the gap is exhausted', () => {
    // Unpositioned tasks are ordered by priority: b (8) before a (5).
    expect(planPosition([t('a', null, 5), t('b', null, 8)], 1)).toEqual({ position: 2000, renumber: [{ id: 'b', position: 1000 }, { id: 'a', position: 3000 }] });
    const tight = planPosition([t('a', 1), t('b', 1 + 1e-9)], 1);
    expect(tight.position).toBe(2000);
    expect(tight.renumber).toEqual([{ id: 'a', position: 1000 }, { id: 'b', position: 3000 }]);
  });

  it('limits In progress by maxConcurrentTasks only', () => {
    expect(wipState('in_progress', 2, 2)).toEqual({ count: 2, limit: 2, atLimit: true, exceeded: false });
    expect(wipState('in_progress', 3, 2)).toMatchObject({ exceeded: true });
    expect(wipState('ready', 50, 2)).toEqual({ count: 50, limit: null, atLimit: false, exceeded: false });
  });
});

describe('scheduler with holds, owners and leases', () => {
  const project = { id: 'p1', priority: 5, status: 'IDLE' as const, maxConcurrentTasks: 5, budgetUsd: 100, spentUsd: 0, lastScheduledAt: now };
  const base = { projectId: 'p1', priority: 5, status: 'READY' as const, dependencies: [], risk: 'medium' as const, readySince: now, createdAt: now };

  it('skips held, person-owned and leased tasks with a reason', () => {
    const result = schedule({
      now,
      projects: [project],
      tasks: [
        { ...base, id: 'held', schedulingHold: true },
        { ...base, id: 'mine', assigneeType: 'user' },
        { ...base, id: 'ai', assigneeType: 'external_ai' },
        { ...base, id: 'leased' },
        { ...base, id: 'free', assigneeType: 'orchestrator', schedulingHold: false },
      ],
      taskStatuses: new Map(),
      runningTasksByProject: new Map(),
      globalCapacity: 10,
      globalRunning: 0,
      globalBudgetExhausted: false,
      leasedTaskIds: new Set(['leased']),
    });
    expect(result.selected.map((s) => s.taskId)).toEqual(['free']);
    expect(Object.fromEntries(result.skipped.map((s) => [s.taskId, s.reason]))).toEqual({
      held: 'scheduling_hold',
      mine: 'assigned_to_user',
      ai: 'assigned_to_external_ai',
      leased: 'task_leased',
    });
  });
});

describe('leases', () => {
  const lease = (extra: Partial<Lease> = {}): Lease => ({
    id: 'lse_1',
    projectId: 'p1',
    holderType: 'user',
    holderId: 'usr_bob',
    holderName: 'bob',
    scope: 'paths',
    taskId: null,
    pathGlobs: ['src/auth/**'],
    reason: '',
    expiresAt: new Date(now.getTime() + 60_000),
    heartbeatAt: now,
    createdAt: now,
    releasedAt: null,
    releasedBy: null,
    endReason: null,
    ...extra,
  });

  it('normalises globs and rejects unsafe ones', () => {
    expect(normalizeLeaseGlob(' ./src//auth/**/**/*.ts ')).toBe('src/auth/**/*.ts');
    for (const bad of ['', '/etc/passwd', '../secrets', 'src/../x', 'C:/repo', 'src\\auth', 'src/?.ts', 'src/[ab].ts', 'src/{a,b}', 'src/a**b', 'x'.repeat(301), 'src/\u0000']) {
      expect(normalizeLeaseGlob(bad), bad).toBeNull();
    }
    expect(LeaseGlobsSchema.parse(['src/**', './src/**'])).toEqual(['src/**']);
    expect(LeaseGlobsSchema.safeParse(['../x']).success).toBe(false);
    expect(LeaseGlobsSchema.safeParse([]).success).toBe(false);
  });

  it('matches segments with * and globs with ** in both directions', () => {
    expect(segmentMatches('*.ts', 'index.ts')).toBe(true);
    expect(segmentMatches('a*b*c', 'aXXbYYc')).toBe(true);
    expect(segmentMatches('a*b*c', 'aXXbYY')).toBe(false);
    expect(globsOverlap('src/auth/**', 'src/auth/login.ts')).toBe(true);
    expect(globsOverlap('src/**', 'src')).toBe(true);
    expect(globsOverlap('src/auth/**', 'src/billing/pay.ts')).toBe(false);
    expect(globsOverlap('src/*/index.ts', 'src/**/*.ts')).toBe(true);
    expect(globsOverlap('docs/*.md', 'src/**')).toBe(false);
    expect(globsOverlap('src/*.test.ts', 'src/*.ts')).toBe(true);
    expect(globsOverlap('src/a*.ts', 'src/b*.ts')).toBe(false);
  });

  it('matches hostile globs in bounded time', () => {
    const deep = `${Array.from({ length: 140 }, () => '**/a*').join('/')}`.slice(0, 300);
    const path = `${'a/'.repeat(149)}b`;
    const started = performance.now();
    globsOverlap(deep, path);
    segmentMatches(`${'*a'.repeat(40)}b`, 'a'.repeat(60));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('finds conflicts with other holders only, for the same task or overlapping paths', () => {
    const request = { holderType: 'user' as const, holderId: 'usr_alice', scope: 'paths' as const, taskId: null, pathGlobs: ['src/auth/session.ts'] };
    expect(findLeaseConflicts([lease()], request, now)).toHaveLength(1);
    expect(findLeaseConflicts([lease({ holderId: 'usr_alice' })], request, now)).toEqual([]);
    expect(findLeaseConflicts([lease({ releasedAt: now })], request, now)).toEqual([]);
    expect(findLeaseConflicts([lease({ expiresAt: now })], request, now)).toEqual([]);
    const taskLease = lease({ scope: 'task', taskId: 't1', pathGlobs: [] });
    expect(findLeaseConflicts([taskLease], { ...request, scope: 'task', taskId: 't1', pathGlobs: [] }, now)).toHaveLength(1);
    expect(findLeaseConflicts([taskLease], { ...request, scope: 'task', taskId: 't2', pathGlobs: [] }, now)).toEqual([]);
    expect(foreignTaskLeases([taskLease, lease({ id: 'o', scope: 'task', taskId: 't3', holderType: 'orchestrator' })], now)).toEqual(new Set(['t1']));
    expect(pathLeaseConflicts([lease()], ['src/auth/a.ts', 'README.md'], 'orchestrator', now)).toEqual([{ lease: lease(), paths: ['src/auth/a.ts'] }]);
  });

  it('bounds expiry by the maximum lease duration', () => {
    const created = new Date(now.getTime() - MAX_LEASE_DURATION_MS + 10 * 60_000);
    expect(leaseExpiry(now, 30 * 60_000, created).getTime()).toBe(created.getTime() + MAX_LEASE_DURATION_MS);
    expect(leaseExpiry(now, 1000).getTime()).toBe(now.getTime() + 5 * 60_000);
    expect(isLeaseActive(lease(), now)).toBe(true);
  });
});

describe('milestones', () => {
  it('validates dates, labels and ordering', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(MilestoneInputSchema.safeParse({ title: 'Beta', startDate: '2026-10-02', dueDate: '2026-10-01' }).success).toBe(false);
    expect(MilestoneInputSchema.parse({ title: ' Beta ' })).toEqual({ title: 'Beta', description: '', status: 'planned', startDate: null, dueDate: null });
    expect(LabelsSchema.parse(['UI', 'ui', ' api '])).toEqual(['UI', 'api']);
    expect(LabelsSchema.safeParse(['<script>']).success).toBe(false);
  });

  it('computes progress by points when every task is estimated, otherwise by count', () => {
    const t = (status: BoardTask['status'], estimatePoints: 1 | 2 | 3 | 5 | 8 | 13 | null) => ({ status, prNumber: null, assigneeType: 'orchestrator' as const, estimatePoints });
    expect(milestoneProgress([t('DONE', 8), t('READY', 2), t('CANCELLED', 13)])).toMatchObject({ total: 2, done: 1, points: 10, pointsDone: 8, pct: 80, unestimated: 0 });
    expect(milestoneProgress([t('DONE', null), t('READY', 5), t('RUNNING', null)])).toMatchObject({ total: 3, done: 1, pct: 33.3, unestimated: 2, byColumn: { in_progress: 1 } });
    expect(milestoneProgress([])).toMatchObject({ total: 0, pct: 0 });
  });
});

describe('room notices for board events', () => {
  const ctx = { taskTitle: null, now };
  const event = <T extends object>(type: string, payload: T, taskId: string | null = 't1') => ({ type, projectId: 'p1', taskId, runId: null, payload }) as never;

  it('posts typed, deduplicated system notices and skips reorders', () => {
    const moved = { title: 'Add search', from: 'backlog', to: 'ready', fromStatus: 'BACKLOG', toStatus: 'READY', position: 1000, schedulingHold: false, schedulable: true, cancelledRuns: 0, by: 'alice' };
    const notice = describeEventForRoom(event('task.moved', moved), ctx)!;
    expect(notice).toMatchObject({ authorType: 'system', intent: 'status', body: 'alice moved “Add search” from Backlog to Ready. The orchestrator may start it.' });
    expect(notice.dedupeKey).toBe(`board:t1:moved:ready:${Math.floor(now.getTime() / 60_000)}`);
    expect(describeEventForRoom(event('task.moved', { ...moved, from: 'ready' }), ctx)).toBeNull();
    expect(describeEventForRoom(event('milestone.updated', { milestoneId: 'm1', title: 'Beta', change: 'updated', status: 'active', previousStatus: 'active', by: 'alice' }, null), ctx)).toBeNull();
    expect(describeEventForRoom(event('milestone.updated', { milestoneId: 'm1', title: 'Beta', change: 'updated', status: 'done', previousStatus: 'active', by: 'alice' }, null), ctx)).toMatchObject({
      body: 'alice marked milestone “Beta” as done.',
    });
    const claim = describeEventForRoom(event('lease.acquired', { leaseId: 'l1', scope: 'paths', holderType: 'user', holderName: 'bob\u202e', paths: ['src/**'], expiresAt: '2026-09-16T10:30:00.000Z', reason: 'refactor\u0000' }, null), ctx)!;
    expect(claim).toMatchObject({ intent: 'claim', body: 'bob claimed src/** until 10:30 UTC. Reason: refactor', refs: { paths: ['src/**'] }, dedupeKey: 'lease:l1:acquired' });
    expect(describeEventForRoom(event('task.planning_updated', { fields: ['labels'], by: 'alice' }), ctx)).toBeNull();
  });
});
