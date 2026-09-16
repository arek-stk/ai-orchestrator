import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AUTOPILOT_SESSION_STATUSES,
  DECISION_REQUEST_STATUSES,
  autopilotStartSchema,
  effectiveAutonomy,
  filterAutopilotDigest,
  GATED_ACTIONS,
  type AutopilotActor,
  type AutopilotSession,
  type RunStatus,
  type UserRole,
} from '@orch/core';
import { createProjectAcl, type VisibleProjects } from './acl';
import { requireRole } from './auth';
import type { Container } from './container';

const IdParams = z.object({ id: z.string().min(1).max(100) });
const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const SLOT_HOLDING: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED'];

/** What always stays with a human in a session (shown in the start dialog; enforced by core, not by this list). */
const PARKED_FOR_HUMANS = [
  'Merging to the default branch and production deployments (autonomy is capped at level 3)',
  'Every gated action: database migrations, destructive changes, infrastructure/CI, secrets and permissions, large or architectural changes, high cost, new dependencies',
  'High-risk and security-relevant tasks (never picked up)',
  'Approvals: parked approvals are decided by an admin (production deploys by an owner); nothing is auto-approved',
];

/**
 * Autopilot / away mode API (ADR-034, ADR-016 pattern). Starting a session changes what agents may execute and is an
 * admin decision; stopping and the kill switch only remove autonomy, so operators may use them on sessions touching a
 * project they operate. Every read and action goes through the per-project access control (ADR-022).
 */
export async function registerAutopilotRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, autopilot, autopilotSessions, ladder, config } = container;
  const acl = createProjectAcl(config.projectAcl, admin);
  const limited = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  const viewer = { preHandler: requireRole('viewer') };
  const operatorMutation = { preHandler: requireRole('operator'), config: limited(30) };
  const adminMutation = { preHandler: requireRole('admin'), config: limited(20) };

  const actor = (request: FastifyRequest): AutopilotActor => ({ type: 'user', id: request.user!.id, login: request.user!.login });

  const visibleIn = (visible: VisibleProjects, session: AutopilotSession) => visible === null || session.projectIds.some((id) => visible.has(id));
  const operableIn = (visible: VisibleProjects, session: AutopilotSession) =>
    visible === null ||
    session.projectIds.some((id) => {
      const role = visible.get(id);
      return role !== undefined && ROLE_RANK[role] >= ROLE_RANK.operator;
    });

  /** The session as a viewer may see it: projects outside the viewer's ACL are omitted. */
  async function present(session: AutopilotSession, visible: VisibleProjects) {
    const projectIds = visible === null ? session.projectIds : session.projectIds.filter((id) => visible.has(id));
    const runs = (await repos.runs.list({ sessionId: session.id, limit: 500 })).filter((r) => projectIds.includes(r.projectId));
    const approvals = (await repos.approvals.list({ sessionId: session.id, status: 'pending', limit: 200 })).filter((a) => projectIds.includes(a.projectId));
    const fullyVisible = projectIds.length === session.projectIds.length;
    return {
      ...session,
      projectIds,
      // The stop detail aggregates the whole session (total spend, cross-project streaks); partial views omit it.
      stopDetail: fullyVisible ? session.stopDetail : null,
      progress: {
        // Spend of hidden projects would leak their activity; partially visible sessions show no total.
        spentUsd: fullyVisible ? await autopilotSessions.spentUsd(session) : null,
        runsStarted: runs.length,
        activeRuns: runs.filter((r) => SLOT_HOLDING.includes(r.status)).length,
        parkedRuns: runs.filter((r) => r.status === 'PARKED').length,
        pendingApprovals: approvals.length,
      },
    };
  }

  async function loadVisible(request: FastifyRequest, reply: FastifyReply, id: string) {
    const [session, visible] = await Promise.all([autopilotSessions.get(id), acl.visibleProjects(request)]);
    if (!session || !visibleIn(visible, session)) {
      await reply.code(404).send({ error: 'autopilot session not found' });
      return null;
    }
    return { session, visible };
  }

  app.get('/api/autopilot/config', viewer, async () => {
    const limits = config.autopilot;
    return {
      enabled: limits.enabled,
      maxHours: limits.maxHours,
      maxBudgetUsd: limits.maxBudgetUsd,
      maxAutonomy: limits.maxAutonomy,
      returnGraceHours: limits.returnGraceMs / 3_600_000,
      approvalTtlHours: config.approvalTtlMs / 3_600_000,
      gatedActions: GATED_ACTIONS,
      parkedForHumans: PARKED_FOR_HUMANS,
    };
  });

  app.post('/api/autopilot/sessions', adminMutation, async (request, reply) => {
    const input = autopilotStartSchema(config.autopilot).parse(request.body);
    const projects = [];
    for (const projectId of input.projectIds) {
      await acl.assertProject(request, projectId, 'admin');
      const project = await repos.projects.get(projectId);
      if (!project) return reply.code(404).send({ error: `project ${projectId} not found` });
      projects.push(project);
    }
    const session = await autopilot.start(input, actor(request));
    return reply.code(201).send({
      session: await present(session, null),
      projects: projects.map((p) => ({ id: p.id, name: p.name, baseAutonomy: p.autonomyLevel, effectiveAutonomy: effectiveAutonomy(p.autonomyLevel, session.autonomyCeiling, config.autopilot.maxAutonomy) })),
    });
  });

  app.get('/api/autopilot/sessions', viewer, async (request) => {
    const query = z
      .object({ status: z.enum(AUTOPILOT_SESSION_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(request.query);
    const visible = await acl.visibleProjects(request);
    if (visible !== null && visible.size === 0) return { sessions: [] };
    const sessions = await autopilotSessions.list({
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(visible === null ? {} : { projectIds: [...visible.keys()] }),
      limit: query.limit,
    });
    return { sessions: await Promise.all(sessions.map((s) => present(s, visible))) };
  });

  app.get('/api/autopilot/sessions/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const found = await loadVisible(request, reply, id);
    if (!found) return reply;
    return { session: await present(found.session, found.visible) };
  });

  app.post('/api/autopilot/sessions/:id/stop', operatorMutation, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const found = await loadVisible(request, reply, id);
    if (!found) return reply;
    if (!operableIn(found.visible, found.session)) return reply.code(403).send({ error: 'requires the operator role on a project of this session' });
    const stopped = await autopilot.stop(id, actor(request));
    if (!stopped) return reply.code(409).send({ error: `session is already ${found.session.status}` });
    return { session: await present(stopped, found.visible) };
  });

  // Kill switch: one session, or every active session the operator can act on.
  app.post('/api/autopilot/kill', operatorMutation, async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(100).optional() }).parse(request.body ?? {});
    const visible = await acl.visibleProjects(request);
    if (sessionId) {
      const found = await loadVisible(request, reply, sessionId);
      if (!found) return reply;
      if (!operableIn(visible, found.session)) return reply.code(403).send({ error: 'requires the operator role on a project of this session' });
      const result = await autopilot.kill(sessionId, actor(request));
      if (!result) return reply.code(409).send({ error: `session is already ${found.session.status}` });
      return { killed: [{ sessionId, pausedRuns: result.pausedRuns }] };
    }
    const killed = await autopilot.killAll(actor(request), (session) => operableIn(visible, session));
    return { killed: killed.map((k) => ({ sessionId: k.session.id, pausedRuns: k.pausedRuns })) };
  });

  // -------------------------------------------------------------------------
  // Decision ladder and council protocol v2 (stage 2+3)
  // -------------------------------------------------------------------------

  const REQUEST_LIST_LIMIT = 100;
  const MAX_TURNS_SHOWN = 32;

  /** Decision requests the viewer may see: filtered to visible projects; `sessionId` requires a visible session. */
  app.get('/api/autopilot/decision-requests', viewer, async (request, reply) => {
    const query = z
      .object({
        sessionId: z.string().min(1).max(100).optional(),
        projectId: z.string().min(1).max(100).optional(),
        status: z.enum(DECISION_REQUEST_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(REQUEST_LIST_LIMIT).default(50),
      })
      .parse(request.query);
    const statuses = query.status ? { statuses: [query.status] } : {};
    if (query.sessionId) {
      const found = await loadVisible(request, reply, query.sessionId);
      if (!found) return reply;
      if (query.projectId) await acl.assertProject(request, query.projectId);
      // A session holds a bounded number of requests; hidden projects are filtered out.
      const rows = await ladder.decisionRequests.list({ sessionId: query.sessionId, ...(query.projectId ? { projectId: query.projectId } : {}), ...statuses, limit: 500 });
      return { requests: rows.filter((r) => found.visible === null || found.visible.has(r.projectId)).slice(0, query.limit) };
    }
    const requests = await acl.scopedList(request, query.projectId, (projectId) => ladder.decisionRequests.list({ ...(projectId ? { projectId } : {}), ...statuses, limit: query.limit }), {
      limit: query.limit,
      sortKey: (r) => r.createdAt.getTime(),
    });
    return { requests };
  });

  /** One request with its council and the append-only transcript (model text is plain data; the UI renders text nodes). */
  app.get('/api/autopilot/decision-requests/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const found = await ladder.decisionRequests.get(id);
    if (!found) return reply.code(404).send({ error: 'decision request not found' });
    await acl.assertProject(request, found.projectId, 'viewer', 'decision request');
    const councils = await ladder.councils.list({ requestId: found.id, limit: 3 });
    const withTurns = await Promise.all(councils.map(async (council) => ({ ...council, turns: (await ladder.councils.turns(council.id)).slice(0, MAX_TURNS_SHOWN) })));
    return { request: found, councils: withTurns };
  });

  /**
   * Human review of a provisional decision from the return digest (admin, as for approvals). Confirming keeps it as
   * decision memory; rejecting removes it from reuse. Neither touches gates, approvals or autonomy.
   */
  const reviewBody = z.object({ comment: z.string().trim().max(1_000).optional() });
  const rejectBody = z.object({ reason: z.string().trim().min(3).max(1_000) });

  async function reviewDecision(request: FastifyRequest, reply: FastifyReply, verdict: 'confirmed' | 'rejected', comment: string | null) {
    const { id } = IdParams.parse(request.params);
    const decision = await repos.decisions.get(id);
    if (!decision) return reply.code(404).send({ error: 'decision not found' });
    await acl.assertProject(request, decision.projectId, 'admin', 'decision');
    const result = await autopilot.reviewDecision(id, verdict, actor(request), comment);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { decision: result.decision };
  }

  app.post('/api/autopilot/decisions/:id/confirm', adminMutation, async (request, reply) => {
    const { comment } = reviewBody.parse(request.body ?? {});
    return reviewDecision(request, reply, 'confirmed', comment ? comment : null);
  });

  app.post('/api/autopilot/decisions/:id/reject', adminMutation, async (request, reply) => {
    const { reason } = rejectBody.parse(request.body ?? {});
    return reviewDecision(request, reply, 'rejected', reason);
  });

  app.get('/api/autopilot/sessions/:id/digest', { preHandler: requireRole('viewer'), config: limited(60) }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const found = await loadVisible(request, reply, id);
    if (!found) return reply;
    const digest = await autopilot.digest(id);
    if (!digest) return reply.code(404).send({ error: 'autopilot session not found' });
    return { digest: filterAutopilotDigest(digest, found.visible === null ? null : new Set(found.visible.keys())) };
  });
}
