import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BOARD_COLUMNS,
  BoardError,
  COMPLEXITIES,
  DEFAULT_LEASE_TTL_MS,
  EstimatePointsSchema,
  IsoDateSchema,
  LabelsSchema,
  LeaseError,
  LeaseGlobsSchema,
  MAX_LEASE_DURATION_MS,
  MIN_LEASE_TTL_MS,
  MilestoneInputSchema,
  MilestonePatchSchema,
  RISKS,
  TASK_KINDS,
  TaskInputSchema,
  type BoardActor,
  type BoardErrorCode,
  type Lease,
  type LeaseErrorCode,
  type UserRole,
} from '@orch/core';
import { createProjectAcl } from './acl';
import { hasRole, requireRole } from './auth';
import type { Container } from './container';

// Board, milestones, holds and leases API (ADR-030 stage 2, ADR-016 route module). Viewers read; operators with the
// operator role on the project mutate (per-project ACL, ADR-022). Every mutation is audited without free text,
// rate limited per user and CSRF-checked by the global origin hook. Changes emit events: SSE clients refresh live and
// the room projection posts deduplicated notices.

const Id = z.string().min(1).max(100);
const ProjectParams = z.object({ id: Id });
const CardParams = z.object({ id: Id, taskId: Id });
const TaskParams = z.object({ id: Id });
const MilestoneParams = z.object({ id: Id, milestoneId: Id });
const LeaseParams = z.object({ id: Id, leaseId: Id });

const Assignee = z.discriminatedUnion('type', [z.object({ type: z.literal('orchestrator') }), z.object({ type: z.literal('user'), id: Id })]);

const CardCreateBody = z.object({
  title: z.string().trim().min(3).max(200),
  goal: z.string().trim().min(3).max(5000),
  kind: z.enum(TASK_KINDS).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  risk: z.enum(RISKS).optional(),
  estimatedComplexity: z.enum(COMPLEXITIES).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  column: z.enum(['backlog', 'ready']).default('backlog'),
  assignee: Assignee.optional(),
  milestoneId: Id.nullable().optional(),
  estimatePoints: EstimatePointsSchema.nullable().optional(),
  labels: LabelsSchema.optional(),
  dueDate: IsoDateSchema.nullable().optional(),
  /** Let the scheduler pick the new card right away (only orchestrator cards in Ready). Default: on hold. */
  release: z.boolean().default(false),
});

const MoveBody = z.object({
  to: z.enum(BOARD_COLUMNS),
  /** Target index in the destination column (without the moved card); default: end of the column. */
  index: z.number().int().min(0).max(10_000).optional(),
  /** Explicitly release the task to the scheduler (Ready only). Moves never release implicitly. */
  release: z.boolean().default(false),
});

const CardPatchBody = z
  .object({
    assignee: Assignee,
    milestoneId: Id.nullable(),
    estimatePoints: EstimatePointsSchema.nullable(),
    labels: LabelsSchema,
    dueDate: IsoDateSchema.nullable(),
  })
  .partial()
  .strict();

const HoldBody = z.object({ reason: z.string().max(500).optional() }).default({});

const LeaseBody = z
  .object({
    scope: z.enum(['task', 'paths']),
    taskId: Id.optional(),
    paths: LeaseGlobsSchema.optional(),
    reason: z.string().max(300).optional(),
    ttlMinutes: z
      .number()
      .int()
      .min(MIN_LEASE_TTL_MS / 60_000)
      .max(MAX_LEASE_DURATION_MS / 60_000)
      .default(DEFAULT_LEASE_TTL_MS / 60_000),
  })
  .refine((body) => (body.scope === 'task' ? Boolean(body.taskId) && !body.paths : Boolean(body.paths) && !body.taskId), {
    message: 'task leases need taskId, path leases need paths',
  });

const HeartbeatBody = z.object({ ttlMinutes: z.number().int().min(MIN_LEASE_TTL_MS / 60_000).max(MAX_LEASE_DURATION_MS / 60_000).optional() }).default({});

const BOARD_STATUS: Record<BoardErrorCode, 400 | 403 | 404 | 409> = {
  task_not_found: 404,
  project_not_found: 404,
  milestone_not_found: 404,
  not_assignee: 403,
  invalid_assignee: 400,
  invalid_dates: 400,
  release_requires_ready: 400,
  release_requires_orchestrator: 409,
  pipeline_controlled: 409,
  active_run: 409,
  hold_not_applicable: 409,
  milestone_limit: 409,
};

const LEASE_STATUS: Record<LeaseErrorCode, 403 | 404 | 409> = {
  lease_not_found: 404,
  task_not_found: 404,
  not_lease_holder: 403,
  lease_conflict: 409,
  lease_not_active: 409,
  lease_limit: 409,
};

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** Mutations are rate limited per user after authentication (drag and drop bursts stay well below the limit). */
const perUser = (bucket: string, max: number) => ({
  rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (request: FastifyRequest) => `${bucket}:${request.user?.id ?? request.ip}` },
});

/** A lease as other users see it: who holds what until when (no internal ids of the releasing user). */
const presentLease = (lease: Lease) => ({
  id: lease.id,
  projectId: lease.projectId,
  holderType: lease.holderType,
  holderId: lease.holderId,
  holderName: lease.holderName,
  scope: lease.scope,
  taskId: lease.taskId,
  pathGlobs: lease.pathGlobs,
  reason: lease.reason,
  expiresAt: lease.expiresAt,
  heartbeatAt: lease.heartbeatAt,
  createdAt: lease.createdAt,
  endReason: lease.endReason,
});

export async function registerBoardRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, board, leases, config } = container;
  const acl = createProjectAcl(config.projectAcl, admin);
  const viewer = { preHandler: requireRole('viewer') };
  const boardMutation = { preHandler: requireRole('operator'), config: perUser('board', 120) };
  const leaseMutation = { preHandler: requireRole('operator'), config: perUser('lease', 60) };

  const actor = (request: FastifyRequest): BoardActor => ({ id: request.user!.id, name: request.user!.login, admin: hasRole(request.user, 'admin') });

  const audit = (request: FastifyRequest, action: string, target: string, details: Record<string, unknown>) =>
    admin.audit.record({ actorType: 'user', actorId: request.user?.id ?? null, action, target, details, ip: request.ip });

  /** Asserts the ACL and that the project exists; false answers 404. */
  const projectAccess = async (request: FastifyRequest, projectId: string, minimum: 'viewer' | 'operator') => {
    await acl.assertProject(request, projectId, minimum);
    return (await repos.projects.get(projectId)) !== null;
  };

  /** Users who may own tasks in the project: owners and admins, and members with an effective operator role. */
  const assignableUsers = async (projectId: string) => {
    const users = await admin.users.list();
    const members = config.projectAcl === 'enforced' ? new Map((await admin.members.listForProject(projectId)).map((m) => [m.userId, m.role])) : null;
    return users
      .filter((user) => {
        if (ROLE_RANK[user.role] >= ROLE_RANK.admin) return true;
        if (ROLE_RANK[user.role] < ROLE_RANK.operator) return false;
        if (members === null) return true;
        const role = members.get(user.id);
        return role !== undefined && ROLE_RANK[role] >= ROLE_RANK.operator;
      })
      .map((user) => ({ type: 'user' as const, id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl }));
  };
  const resolver = (projectId: string) => async (userId: string) => {
    const user = (await assignableUsers(projectId)).find((u) => u.id === userId);
    return user ? { name: user.login } : null;
  };

  /** Maps service errors to HTTP answers; everything else propagates to the global error handler. */
  const handle = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BoardError) return reply.code(BOARD_STATUS[error.code]).send({ error: error.message, code: error.code });
      if (error instanceof LeaseError) {
        const conflicts = error.conflicts.map((l) => ({ holderName: l.holderName, holderType: l.holderType, scope: l.scope, taskId: l.taskId, pathGlobs: l.pathGlobs, expiresAt: l.expiresAt }));
        return reply.code(LEASE_STATUS[error.code]).send({ error: error.message, code: error.code, ...(conflicts.length > 0 ? { conflicts } : {}) });
      }
      throw error;
    }
  };

  // ---------------------------------------------------------------------------
  // Board
  // ---------------------------------------------------------------------------

  app.get('/api/projects/:id/board', viewer, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    return handle(reply, async () => {
      const [view, assignees] = await Promise.all([board.board(id), assignableUsers(id)]);
      return { ...view, leases: view.leases.map(presentLease), assignees };
    });
  });

  app.post('/api/projects/:id/board/cards', boardMutation, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const body = CardCreateBody.parse(request.body);
    const task = TaskInputSchema.parse({
      title: body.title,
      goal: body.goal,
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.risk ? { risk: body.risk } : {}),
      ...(body.estimatedComplexity ? { estimatedComplexity: body.estimatedComplexity } : {}),
      ...(body.acceptanceCriteria ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
    });
    return handle(reply, async () => {
      const created = await board.createCard({
        projectId: id,
        task,
        column: body.column,
        ...(body.assignee ? { assignee: body.assignee } : {}),
        milestoneId: body.milestoneId ?? null,
        estimatePoints: body.estimatePoints ?? null,
        labels: body.labels ?? [],
        dueDate: body.dueDate ?? null,
        release: body.release,
        actor: actor(request),
        resolveAssignee: resolver(id),
      });
      await audit(request, 'board.card.create', id, { taskId: created.id, column: body.column, assigneeType: created.assigneeType, schedulingHold: created.schedulingHold });
      return reply.code(201).send({ task: created });
    });
  });

  app.post('/api/projects/:id/board/cards/:taskId/move', boardMutation, async (request, reply) => {
    const { id, taskId } = CardParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const body = MoveBody.parse(request.body);
    return handle(reply, async () => {
      const result = await board.move({ projectId: id, taskId, to: body.to, ...(body.index !== undefined ? { index: body.index } : {}), release: body.release, actor: actor(request) });
      // Reorders within a column are not audited individually; column changes and releases are.
      if (result.from !== result.to || body.release) {
        await audit(request, 'board.card.move', id, {
          taskId,
          from: result.from,
          to: result.to,
          release: body.release,
          schedulingHold: result.task.schedulingHold,
          mayStartRun: result.mayStartRun,
          cancelledRuns: result.cancelledRuns,
        });
      }
      return result;
    });
  });

  app.patch('/api/projects/:id/board/cards/:taskId', boardMutation, async (request, reply) => {
    const { id, taskId } = CardParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const patch = CardPatchBody.parse(request.body);
    return handle(reply, async () => {
      const task = await board.updateCard({ projectId: id, taskId, patch, actor: actor(request), resolveAssignee: resolver(id) });
      await audit(request, 'board.card.update', id, { taskId, fields: Object.keys(patch), assigneeType: task.assigneeType, assigneeId: task.assigneeId });
      return { task };
    });
  });

  const setHold = async (request: FastifyRequest, reply: FastifyReply, projectId: string, taskId: string, hold: boolean) => {
    const body = HoldBody.parse(request.body ?? {});
    return handle(reply, async () => {
      const result = await board.setHold({ projectId, taskId, hold, reason: body.reason ?? null, actor: actor(request) });
      if (result.changed) await audit(request, hold ? 'task.hold' : 'task.release', taskId, { projectId, mayStartRun: result.mayStartRun });
      return result;
    });
  };

  app.post('/api/projects/:id/board/cards/:taskId/hold', boardMutation, async (request, reply) => {
    const { id, taskId } = CardParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    return setHold(request, reply, id, taskId, true);
  });

  app.post('/api/projects/:id/board/cards/:taskId/release', boardMutation, async (request, reply) => {
    const { id, taskId } = CardParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    return setHold(request, reply, id, taskId, false);
  });

  // Task-level aliases from the planning assistant plan (`POST /api/tasks/:id/hold` · `/release`).
  for (const [suffix, hold] of [
    ['hold', true],
    ['release', false],
  ] as const) {
    app.post(`/api/tasks/:id/${suffix}`, boardMutation, async (request, reply) => {
      const { id } = TaskParams.parse(request.params);
      const task = await repos.tasks.get(id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      await acl.assertProject(request, task.projectId, 'operator', 'task');
      return setHold(request, reply, task.projectId, id, hold);
    });
  }

  // ---------------------------------------------------------------------------
  // Milestones
  // ---------------------------------------------------------------------------

  app.get('/api/projects/:id/milestones', viewer, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    return { milestones: await board.milestones(id) };
  });

  app.post('/api/projects/:id/milestones', boardMutation, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const input = MilestoneInputSchema.parse(request.body);
    return handle(reply, async () => {
      const milestone = await board.createMilestone(id, input, actor(request));
      await audit(request, 'milestone.create', id, { milestoneId: milestone.id, status: milestone.status });
      return reply.code(201).send({ milestone });
    });
  });

  app.patch('/api/projects/:id/milestones/:milestoneId', boardMutation, async (request, reply) => {
    const { id, milestoneId } = MilestoneParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const patch = MilestonePatchSchema.strict().parse(request.body);
    return handle(reply, async () => {
      const milestone = await board.updateMilestone(id, milestoneId, patch, actor(request));
      await audit(request, 'milestone.update', id, { milestoneId, fields: Object.keys(patch), status: milestone.status });
      return { milestone };
    });
  });

  app.delete('/api/projects/:id/milestones/:milestoneId', boardMutation, async (request, reply) => {
    const { id, milestoneId } = MilestoneParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    return handle(reply, async () => {
      await board.deleteMilestone(id, milestoneId, actor(request));
      await audit(request, 'milestone.delete', id, { milestoneId });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------------------
  // Leases
  // ---------------------------------------------------------------------------

  app.get('/api/projects/:id/leases', viewer, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    return { leases: (await leases.list(id)).map(presentLease) };
  });

  app.post('/api/projects/:id/leases', leaseMutation, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const body = LeaseBody.parse(request.body);
    return handle(reply, async () => {
      const { lease, created } = await leases.acquire({
        projectId: id,
        actor: actor(request),
        scope: body.scope,
        taskId: body.taskId ?? null,
        pathGlobs: body.paths ?? [],
        reason: body.reason ?? '',
        ttlMs: body.ttlMinutes * 60_000,
      });
      await audit(request, created ? 'lease.acquire' : 'lease.extend', id, { leaseId: lease.id, scope: lease.scope, taskId: lease.taskId, paths: lease.pathGlobs.length, expiresAt: lease.expiresAt.toISOString() });
      return reply.code(created ? 201 : 200).send({ lease: presentLease(lease), created });
    });
  });

  app.post('/api/projects/:id/leases/:leaseId/heartbeat', leaseMutation, async (request, reply) => {
    const { id, leaseId } = LeaseParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const body = HeartbeatBody.parse(request.body ?? {});
    // Heartbeats are frequent and only extend the holder's own lease within the maximum duration: not audited.
    return handle(reply, async () => ({ lease: presentLease(await leases.heartbeat({ projectId: id, leaseId, actor: actor(request), ...(body.ttlMinutes ? { ttlMs: body.ttlMinutes * 60_000 } : {}) })) }));
  });

  app.post('/api/projects/:id/leases/:leaseId/release', leaseMutation, async (request, reply) => {
    const { id, leaseId } = LeaseParams.parse(request.params);
    if (!(await projectAccess(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    return handle(reply, async () => {
      const { lease, broken } = await leases.release({ projectId: id, leaseId, actor: actor(request) });
      await audit(request, broken ? 'lease.break' : 'lease.release', id, { leaseId, scope: lease.scope, holderId: lease.holderId, holderType: lease.holderType });
      return { lease: presentLease(lease), broken };
    });
  });
}
