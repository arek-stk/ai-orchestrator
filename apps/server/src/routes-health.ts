import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProposalStatus } from '@orch/core';
import { createProjectAcl } from './acl';
import { requireRole } from './auth';
import type { Container } from './container';

const IdParams = z.object({ id: z.string().min(1).max(100) });
const PROPOSAL_STATUSES = ['proposed', 'accepted', 'dismissed'] as const satisfies readonly ProposalStatus[];

/** Orchestration intelligence API: health scans, improvement proposals and explicit research (spec §14, §5). */
export async function registerHealthRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, intelligence } = container;
  const viewer = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };
  // Per-project access control (ADR-022): every project-scoped read and action is checked against memberships.
  const acl = createProjectAcl(container.config.projectAcl, admin);

  const audit = (request: { user: { id: string } | null; ip: string }, action: string, target: string | null, details: Record<string, unknown> = {}) =>
    admin.audit.record({ actorType: 'user', actorId: request.user?.id ?? null, action, target, details, ip: request.ip });

  app.post('/api/projects/:id/health-scans', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id, 'operator');
    if (!(await repos.projects.get(id))) return reply.code(404).send({ error: 'project not found' });
    const { scan, created } = await intelligence.scanner.request(id, 'manual', request.user!.id);
    await audit(request, 'health_scan.request', id, { scanId: scan.id, created });
    return reply.code(202).send({ scan, created });
  });

  app.get('/api/projects/:id/health-scans', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    await acl.assertProject(request, id);
    const project = await repos.projects.get(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { healthScore: project.healthScore, scans: await intelligence.health.healthScans.list(id, limit) };
  });

  app.get('/api/projects/:id/improvements', viewer, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { status } = z.object({ status: z.enum(PROPOSAL_STATUSES).optional() }).parse(request.query);
    await acl.assertProject(request, id);
    return { proposals: await intelligence.health.proposals.list({ projectId: id, ...(status ? { statuses: [status] } : {}), limit: 200 }) };
  });

  app.post('/api/improvements/:id/accept', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const proposal = await intelligence.health.proposals.get(id);
    if (!proposal) return reply.code(404).send({ error: 'proposal not found' });
    await acl.assertProject(request, proposal.projectId, 'operator', 'proposal');
    const result = await intelligence.scanner.accept(id, { userId: request.user!.id, name: request.user!.login });
    if (!result) return reply.code(409).send({ error: `proposal is already ${proposal.status === 'proposed' ? 'decided' : proposal.status}` });
    await audit(request, 'improvement.accept', id, { projectId: proposal.projectId, taskId: result.task.id });
    return reply.code(201).send(result);
  });

  app.post('/api/improvements/:id/dismiss', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().max(1000).nullable().default(null) }).parse(request.body ?? {});
    const proposal = await intelligence.health.proposals.get(id);
    if (!proposal) return reply.code(404).send({ error: 'proposal not found' });
    await acl.assertProject(request, proposal.projectId, 'operator', 'proposal');
    const dismissed = await intelligence.scanner.dismiss(id, { userId: request.user!.id, name: request.user!.login }, reason);
    if (!dismissed) return reply.code(409).send({ error: `proposal is already ${proposal.status === 'proposed' ? 'decided' : proposal.status}` });
    await audit(request, 'improvement.dismiss', id, { projectId: proposal.projectId, reason });
    return { proposal: dismissed };
  });

  // Research is never activated by default; an operator asks for it explicitly.
  app.post('/api/projects/:id/research', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const input = z.object({ question: z.string().trim().min(10).max(2000), taskId: z.string().min(1).max(100).nullable().default(null) }).parse(request.body);
    await acl.assertProject(request, id, 'operator');
    if (!(await repos.projects.get(id))) return reply.code(404).send({ error: 'project not found' });
    if (input.taskId) {
      const task = await repos.tasks.get(input.taskId);
      if (!task || task.projectId !== id) return reply.code(400).send({ error: `task ${input.taskId} does not exist in this project` });
    }
    await intelligence.requestResearch({ projectId: id, question: input.question, taskId: input.taskId });
    await audit(request, 'research.request', id, { taskId: input.taskId });
    return reply.code(202).send({ queued: true });
  });
}
