import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HUMAN_MESSAGE_INTENTS, MAX_MESSAGE_LENGTH, MAX_PAGE_SIZE, RoomError, type RoomErrorCode } from '@orch/core';
import { createProjectAcl } from './acl';
import { requireRole } from './auth';
import type { Container } from './container';

// Project Room API (ADR-030 stage 1). Viewers read, operators post; every route asserts per-project access (ADR-022).
// Live updates arrive as content-free `room.message` events on the SSE stream, which replays by Last-Event-ID.

const Id = z.string().min(1).max(100);
const ProjectParams = z.object({ id: Id });
const MessageParams = z.object({ id: Id, messageId: Id });
const Cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const ListQuery = z
  .object({ before: Cursor.optional(), after: Cursor.optional(), limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50) })
  .refine((q) => q.before === undefined || q.after === undefined, { message: 'use either before or after' });
const ThreadQuery = z.object({ after: Cursor.optional(), limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50) });

const PostBody = z.object({
  body: z.string().max(MAX_MESSAGE_LENGTH),
  intent: z.enum(HUMAN_MESSAGE_INTENTS).default('message'),
});

const ERROR_STATUS: Record<RoomErrorCode, 400 | 404> = { empty_body: 400, answer_requires_thread: 400, thread_not_found: 404 };

/** Posting is rate limited per user (not per IP), after authentication has resolved the session. */
const postRateLimit = {
  rateLimit: { max: 30, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (request: FastifyRequest) => `room:${request.user?.id ?? request.ip}` },
};

export async function registerRoomRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, room } = container;
  const acl = createProjectAcl(container.config.projectAcl, admin);

  const audit = (request: FastifyRequest, action: string, target: string | null, details: Record<string, unknown>) =>
    admin.audit.record({ actorType: 'user', actorId: request.user?.id ?? null, action, target, details, ip: request.ip });

  const assertProject = async (request: FastifyRequest, projectId: string, minimum: 'viewer' | 'operator') => {
    await acl.assertProject(request, projectId, minimum);
    return (await repos.projects.get(projectId)) !== null;
  };

  const post = async (request: FastifyRequest, projectId: string, threadId: string | null) => {
    const input = PostBody.parse(request.body);
    const user = request.user!;
    try {
      const { message } = await room.post({ projectId, author: { type: 'human', id: user.id, name: user.login }, intent: input.intent, body: input.body, threadId });
      // The audit trail records who posted what kind of message, never the content.
      await audit(request, threadId ? 'room.reply' : 'room.post', projectId, { messageId: message.id, threadId: message.threadId, intent: message.intent, length: message.body.length });
      return { status: 201 as const, payload: { message } };
    } catch (error) {
      if (error instanceof RoomError) return { status: ERROR_STATUS[error.code], payload: { error: error.message } };
      throw error;
    }
  };

  app.get('/api/projects/:id/room', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await assertProject(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    return { conversation: await room.room(id) };
  });

  app.get('/api/projects/:id/room/messages', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    const query = ListQuery.parse(request.query);
    if (!(await assertProject(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    return room.list(id, query);
  });

  app.post('/api/projects/:id/room/messages', { preHandler: requireRole('operator'), config: postRateLimit }, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await assertProject(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const result = await post(request, id, null);
    return reply.code(result.status).send(result.payload);
  });

  app.get('/api/projects/:id/room/messages/:messageId/replies', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { id, messageId } = MessageParams.parse(request.params);
    const query = ThreadQuery.parse(request.query);
    if (!(await assertProject(request, id, 'viewer'))) return reply.code(404).send({ error: 'project not found' });
    const thread = await room.thread(id, messageId, query);
    if (!thread) return reply.code(404).send({ error: 'message not found' });
    return thread;
  });

  app.post('/api/projects/:id/room/messages/:messageId/replies', { preHandler: requireRole('operator'), config: postRateLimit }, async (request, reply) => {
    const { id, messageId } = MessageParams.parse(request.params);
    if (!(await assertProject(request, id, 'operator'))) return reply.code(404).send({ error: 'project not found' });
    const result = await post(request, id, messageId);
    return reply.code(result.status).send(result.payload);
  });
}
