import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBoardStore, createMemoryStore, defaultProjectProfile, defaultProjectSettings, TaskInputSchema, type LeaseRepository, type MilestoneRepository, type NewLease, type TaskRepository } from '@orch/core';
import { createBoardRepositories, type BoardRepositories } from './board-repositories';
import { createDatabase, type DatabaseHandle } from './client';
import { createRepositories, type Repositories } from './repositories';

let handle: DatabaseHandle;
let repos: Repositories;
let board: BoardRepositories;
const now = new Date('2026-09-16T10:00:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

beforeAll(async () => {
  handle = await createDatabase();
  await handle.migrate();
  repos = createRepositories(handle.db);
  board = createBoardRepositories(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const makeProject = (slug: string) =>
  repos.projects.create({ slug, name: slug, description: '', repo: null, priority: 5, autonomyLevel: 1, budgetUsd: 10, profile: defaultProjectProfile(), settings: defaultProjectSettings() });
const makeTask = (projectId: string, title = 'Add search') => repos.tasks.create(projectId, TaskInputSchema.parse({ title, goal: 'Customers can search' }), null);

describe('task planning columns (PGlite)', () => {
  it('defaults to orchestrator-owned, unheld tasks and round-trips every planning field', async () => {
    const project = await makeProject('plan-fields');
    const plain = await makeTask(project.id);
    expect(plain).toMatchObject({ status: 'READY', assigneeType: 'orchestrator', assigneeId: null, milestoneId: null, boardPosition: null, estimatePoints: null, labels: [], dueDate: null, schedulingHold: false, holdReason: null });

    const milestone = await board.milestones.create(project.id, { title: 'Beta', description: '', status: 'active', startDate: '2026-09-01', dueDate: '2026-10-15', position: 1000 }, null);
    const held = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'Held card', goal: 'Planned work' }), null, {
      status: 'BACKLOG',
      assigneeType: 'user',
      assigneeId: 'usr_1',
      milestoneId: milestone.id,
      boardPosition: 1500.5,
      estimatePoints: 8,
      labels: ['ui', 'search'],
      dueDate: '2026-10-01',
      schedulingHold: true,
      holdReason: 'Added on the board',
    });
    expect(await repos.tasks.get(held.id)).toMatchObject({ status: 'BACKLOG', assigneeType: 'user', milestoneId: milestone.id, boardPosition: 1500.5, estimatePoints: 8, labels: ['ui', 'search'], dueDate: '2026-10-01', schedulingHold: true });
    const released = await repos.tasks.update(held.id, { schedulingHold: false, holdReason: null, dueDate: null, labels: [] });
    expect(released).toMatchObject({ schedulingHold: false, holdReason: null, dueDate: null, labels: [] });
  });
});

describe('milestone repository (PGlite)', () => {
  it('creates, lists in position order, updates and deletes while keeping tasks', async () => {
    const project = await makeProject('milestones');
    const second = await board.milestones.create(project.id, { title: 'Launch', description: 'GA', status: 'planned', startDate: null, dueDate: '2026-12-01', position: 2000 }, null);
    const first = await board.milestones.create(project.id, { title: 'Beta', description: '', status: 'active', startDate: '2026-09-01', dueDate: null, position: 1000 }, null);
    expect((await board.milestones.list(project.id)).map((m) => m.title)).toEqual(['Beta', 'Launch']);
    const updated = await board.milestones.update(second.id, { status: 'done', title: 'Launch v1' });
    expect(updated).toMatchObject({ status: 'done', title: 'Launch v1', dueDate: '2026-12-01' });
    await expect(board.milestones.update('mst_missing', { title: 'x' })).rejects.toThrow('not found');

    const task = await repos.tasks.create(project.id, TaskInputSchema.parse({ title: 'In beta', goal: 'Planned work' }), null, { milestoneId: first.id });
    expect(await board.milestones.delete(first.id)).toBe(true);
    expect(await board.milestones.delete(first.id)).toBe(false);
    expect(await repos.tasks.get(task.id)).toMatchObject({ id: task.id, milestoneId: null });
    expect(await board.milestones.get(first.id)).toBeNull();
  });
});

describe('lease repository (PGlite)', () => {
  const lease = (projectId: string, extra: Partial<NewLease> = {}): NewLease => ({
    projectId,
    holderType: 'user',
    holderId: 'usr_bob',
    holderName: 'bob',
    scope: 'paths',
    taskId: null,
    pathGlobs: ['src/auth/**'],
    reason: 'refactor',
    expiresAt: later(30),
    ...extra,
  });

  it('grants exactly one of concurrent conflicting acquisitions', async () => {
    const project = await makeProject('lease-race');
    const task = await makeTask(project.id);
    const results = await Promise.all(
      ['usr_a', 'usr_b', 'usr_c', 'usr_d'].map((holderId) => board.leases.acquire(lease(project.id, { holderId, holderName: holderId, scope: 'task', taskId: task.id, pathGlobs: [] }), now)),
    );
    expect(results.filter((r) => r.lease !== null)).toHaveLength(1);
    expect(results.filter((r) => r.lease === null).every((r) => r.conflicts.length === 1)).toBe(true);
    // Path leases of other holders conflict when globs overlap; the same holder may add more.
    expect((await board.leases.acquire(lease(project.id), now)).lease).not.toBeNull();
    expect((await board.leases.acquire(lease(project.id, { holderId: 'usr_bob', pathGlobs: ['src/**'] }), now)).lease).not.toBeNull();
    const blocked = await board.leases.acquire(lease(project.id, { holderId: 'usr_eve', pathGlobs: ['src/auth/session.ts'] }), now);
    expect(blocked.lease).toBeNull();
    expect(blocked.conflicts.map((c) => c.holderId)).toEqual(['usr_bob', 'usr_bob']);
    expect((await board.leases.acquire(lease(project.id, { holderId: 'usr_eve', pathGlobs: ['docs/**'] }), now)).lease).not.toBeNull();
  });

  it('lists active leases, extends, ends once and reaps expired leases', async () => {
    const project = await makeProject('lease-life');
    const other = await makeProject('lease-other');
    const task = await makeTask(project.id);
    const { lease: taskLease } = await board.leases.acquire(lease(project.id, { scope: 'task', taskId: task.id, pathGlobs: [] }), now);
    const { lease: pathLease } = await board.leases.acquire(lease(project.id, { expiresAt: later(5) }), now);
    await board.leases.acquire(lease(other.id), now);
    expect(new Set((await board.leases.listActive({ projectId: project.id }, now)).map((l) => l.id))).toEqual(new Set([taskLease!.id, pathLease!.id]));
    expect((await board.leases.listActive({ scope: 'task', taskId: task.id }, now)).map((l) => l.id)).toEqual([taskLease!.id]);

    const extended = await board.leases.heartbeat(taskLease!.id, later(60), later(1));
    expect(extended).toMatchObject({ expiresAt: later(60), heartbeatAt: later(1) });
    expect(await board.leases.listActive({ projectId: project.id }, later(10))).toHaveLength(1);
    // Expired leases cannot be extended or released by holders, only reaped once.
    expect(await board.leases.heartbeat(pathLease!.id, later(90), later(10))).toBeNull();
    expect(await board.leases.end(pathLease!.id, 'usr_bob', 'released', later(10))).toBeNull();
    expect((await board.leases.listExpired(later(10), 10)).map((l) => l.id)).toEqual([pathLease!.id]);
    expect(await board.leases.end(pathLease!.id, 'system', 'expired', later(10))).toMatchObject({ endReason: 'expired', releasedBy: 'system' });
    expect(await board.leases.end(pathLease!.id, 'system', 'expired', later(10))).toBeNull();
    expect(await board.leases.listExpired(later(10), 10)).toEqual([]);

    expect(await board.leases.end(taskLease!.id, 'usr_root', 'broken', later(11))).toMatchObject({ endReason: 'broken', releasedAt: later(11) });
    expect(await board.leases.listActive({ projectId: project.id }, later(12))).toEqual([]);
  });
});

describe('in-memory parity', () => {
  it('behaves like the Drizzle repositories for leases and milestone deletion', async () => {
    const project = await makeProject('parity');
    const memoryTasks = createMemoryStore().tasks;
    const memory = createMemoryBoardStore({ tasks: memoryTasks });
    const run = async (store: { leases: LeaseRepository; milestones: MilestoneRepository }, tasks: TaskRepository, holderPrefix: string) => {
      const task = await tasks.create(project.id, TaskInputSchema.parse({ title: 'Parity', goal: 'Same semantics' }), null);
      const input = (holderId: string, globs: string[]): NewLease => ({ projectId: project.id, holderType: 'user', holderId: `${holderPrefix}${holderId}`, holderName: holderId, scope: 'paths', taskId: null, pathGlobs: globs, reason: '', expiresAt: later(5) });
      const first = await store.leases.acquire(input('a', ['src/**']), now);
      const conflict = await store.leases.acquire(input('b', ['src/x.ts']), now);
      const free = await store.leases.acquire(input('b', ['docs/*.md']), now);
      const active = (await store.leases.listActive({ projectId: project.id }, now)).length;
      const heartbeatExpired = await store.leases.heartbeat(first.lease!.id, later(30), later(6));
      const expired = (await store.leases.listExpired(later(6), 10)).filter((l) => l.projectId === project.id).length;
      const ended = await store.leases.end(first.lease!.id, 'system', 'expired', later(6));
      const endedTwice = await store.leases.end(first.lease!.id, 'system', 'expired', later(6));
      const milestone = await store.milestones.create(project.id, { title: 'M', description: '', status: 'planned', startDate: null, dueDate: null, position: 1 }, null);
      await tasks.update(task.id, { milestoneId: milestone.id });
      await store.milestones.delete(milestone.id);
      await store.leases.end(free.lease!.id, 'system', 'expired', later(6));
      return {
        granted: first.lease !== null,
        conflicts: conflict.conflicts.length,
        free: free.lease !== null,
        active,
        heartbeatExpired,
        expired,
        endReason: ended?.endReason,
        endedTwice,
        taskMilestone: (await tasks.get(task.id))!.milestoneId,
      };
    };
    const drizzle = await run(board, repos.tasks, 'db-');
    expect(drizzle).toEqual({ granted: true, conflicts: 1, free: true, active: 2, heartbeatExpired: null, expired: 2, endReason: 'expired', endedTwice: null, taskMilestone: null });
    expect(await run(memory, memoryTasks, 'mem-')).toEqual(drizzle);
  });
});
