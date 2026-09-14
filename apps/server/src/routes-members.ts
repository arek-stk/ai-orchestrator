import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from './auth';
import type { Container } from './container';

const MemberParams = z.object({ id: z.string().min(1).max(100), userId: z.string().min(1).max(100) });
const ProjectParams = z.object({ id: z.string().min(1).max(100) });
/** Admins and owners see every project anyway, so memberships only grant operator or viewer access. */
const MemberBody = z.object({ role: z.enum(['operator', 'viewer']) });

/** Project membership management (ADR-022). Admin only; every change is audited. */
export async function registerMemberRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin } = container;
  const adminOnly = { preHandler: requireRole('admin') };

  app.get('/api/projects/:id/members', adminOnly, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await repos.projects.get(id))) return reply.code(404).send({ error: 'project not found' });
    return { aclMode: container.config.projectAcl, members: await admin.members.listForProject(id) };
  });

  app.put('/api/projects/:id/members/:userId', adminOnly, async (request, reply) => {
    const { id, userId } = MemberParams.parse(request.params);
    const { role } = MemberBody.parse(request.body);
    if (!(await repos.projects.get(id))) return reply.code(404).send({ error: 'project not found' });
    if (!(await admin.users.get(userId))) return reply.code(404).send({ error: 'user not found' });
    const member = await admin.members.upsert({ projectId: id, userId, role });
    await admin.audit.record({ actorType: 'user', actorId: request.user!.id, action: 'project.member.upsert', target: id, details: { userId, role }, ip: request.ip });
    return { member };
  });

  app.delete('/api/projects/:id/members/:userId', adminOnly, async (request, reply) => {
    const { id, userId } = MemberParams.parse(request.params);
    if (!(await admin.members.remove(id, userId))) return reply.code(404).send({ error: 'membership not found' });
    await admin.audit.record({ actorType: 'user', actorId: request.user!.id, action: 'project.member.remove', target: id, details: { userId }, ip: request.ip });
    return { ok: true };
  });

  app.get('/api/users/:id/projects', adminOnly, async (request, reply) => {
    const { id } = ProjectParams.parse(request.params);
    if (!(await admin.users.get(id))) return reply.code(404).send({ error: 'user not found' });
    return { memberships: await admin.members.listForUser(id) };
  });
}
