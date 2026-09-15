import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENT_DEFINITIONS,
  AUTONOMY_LABELS,
  COMPLEXITIES,
  CouncilSettingsSchema,
  defaultProjectProfile,
  defaultProjectSettings,
  GATED_ACTIONS,
  ModelConfigSchema,
  PIPELINE_STEP_JOB,
  PROVIDER_KINDS,
  ProjectInputSchema,
  ProjectProfileSchema,
  ProjectSettingsSchema,
  readDependencyApprovalDetails,
  RepoRefSchema,
  RISKS,
  RUN_STATUSES,
  slugify,
  StopConditionsSchema,
  TASK_KINDS,
  TASK_STATUSES,
  TaskInputSchema,
  AGENT_ROLES,
  type AnyDomainEvent,
  type Approval,
  type DependencyApprovalDetails,
  type Project,
  type RunStatus,
} from '@orch/core';
import { parseGitHubWebhook, verifyGitHubSignature } from '@orch/integrations';
import { createProjectAcl, eventVisible } from './acl';
import { requireRole } from './auth';
import type { Container } from './container';
import { encryptSecret } from './crypto';

const IdParams = z.object({ id: z.string().min(1).max(100) });
const ACTIVE_RUNS: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED'];
const DAY_MS = 24 * 60 * 60 * 1000;

const ProjectCreateSchema = ProjectInputSchema.extend({
  profile: ProjectProfileSchema.partial().optional(),
});

const ProjectPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000),
    repo: RepoRefSchema.nullable(),
    priority: z.number().int().min(1).max(10),
    autonomyLevel: z.number().int().min(0).max(4),
    budgetUsd: z.number().min(0).max(100_000),
    profile: ProjectProfileSchema.partial(),
    settings: ProjectSettingsSchema.extend({
      stopConditions: StopConditionsSchema.partial(),
      council: CouncilSettingsSchema.partial(),
      approvalGates: z.partialRecord(z.enum(GATED_ACTIONS), z.boolean()),
    }).partial(),
  })
  .partial();

const TaskPatchSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    goal: z.string().trim().min(3).max(5000),
    priority: z.number().int().min(1).max(10),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30),
    risk: z.enum(RISKS),
    estimatedComplexity: z.enum(COMPLEXITIES),
  })
  .partial();

const ProviderUpsertSchema = z.object({
  kind: z.enum(PROVIDER_KINDS).exclude(['mock']),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url().max(500).nullable().default(null),
  /** Omitted: keep the stored key. null: remove it. */
  apiKey: z.string().min(1).max(500).nullable().optional(),
  enabled: z.boolean().default(true),
});

const SettingsPatchSchema = z
  .object({
    globalDailyBudgetUsd: z.number().min(0).max(100_000),
    globalCapacity: z.number().int().min(1).max(64),
    modelOverrides: z.partialRecord(z.enum(AGENT_ROLES), z.string().min(1).max(200)),
  })
  .partial();

function mergeSettings(project: Project, patch: z.infer<typeof ProjectPatchSchema>['settings']) {
  if (!patch) return project.settings;
  return ProjectSettingsSchema.parse({
    ...project.settings,
    ...patch,
    stopConditions: { ...project.settings.stopConditions, ...patch.stopConditions },
    council: { ...project.settings.council, ...patch.council },
    approvalGates: { ...project.settings.approvalGates, ...patch.approvalGates },
    modelOverrides: patch.modelOverrides ?? project.settings.modelOverrides,
  });
}

/**
 * Adds the typed `dependencies` field to dependency approvals (ADR-031). `details` stays untouched for existing
 * clients; the typed field is validated and its registry links are rebuilt from fixed templates.
 */
function withDependencies<T extends Approval>(approval: T): T & { dependencies: DependencyApprovalDetails | null } {
  return { ...approval, dependencies: readDependencyApprovalDetails(approval) };
}

export async function registerRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, orchestrator, queue, config } = container;
  const viewer = { preHandler: requireRole('viewer') };
  const operator = { preHandler: requireRole('operator') };
  const adminOnly = { preHandler: requireRole('admin') };

  const audit = (request: { user: { id: string } | null; ip: string }, action: string, target: string | null, details: Record<string, unknown> = {}) =>
    admin.audit.record({ actorType: 'user', actorId: request.user?.id ?? null, action, target, details, ip: request.ip });

  const notFound = (entity: string) => ({ error: `${entity} not found` });

  // Per-project access control (ADR-022): every project-scoped read and action goes through `acl`.
  const acl = createProjectAcl(config.projectAcl, admin);
  const usageScope = async (request: Parameters<typeof acl.visibleProjects>[0], projectId?: string) => {
    if (projectId) return projectId;
    const visible = await acl.visibleProjects(request);
    return visible === null ? undefined : [...visible.keys()];
  };

  // ---------------------------------------------------------------------------
  // Health & dashboard
  // ---------------------------------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    database: container.db.kind,
    demoMode: container.demoMode(),
    github: container.githubKind,
    sandbox: container.sandbox.available ? 'docker' : 'none',
  }));

  app.get('/api/dashboard', viewer, async (request) => {
    const now = container.clock.now();
    const visible = await acl.visibleProjects(request);
    const scoped = <T>(fetch: (projectId?: string) => Promise<T[]>, limit: number, sortKey: (item: T) => number) => acl.scopedList(request, undefined, fetch, { limit, sortKey });
    const byProject = (projectId?: string) => (projectId ? { projectId } : {});
    const [allProjects, tasks, activeRuns, recentRuns, activeAgents, approvals, queueStats, today, events] = await Promise.all([
      repos.projects.list(),
      scoped((p) => repos.tasks.list({ ...byProject(p), limit: 2000 }), 2000, (t) => t.createdAt.getTime()),
      scoped((p) => repos.runs.list({ ...byProject(p), statuses: ACTIVE_RUNS, limit: 200 }), 200, (r) => r.startedAt.getTime()),
      scoped((p) => repos.runs.list({ ...byProject(p), statuses: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'], limit: 500 }), 500, (r) => r.startedAt.getTime()),
      scoped((p) => repos.agentRuns.list({ ...byProject(p), status: 'running', limit: 100 }), 100, (a) => a.startedAt.getTime()),
      scoped((p) => repos.approvals.list({ ...byProject(p), status: 'pending', limit: 100 }), 100, (a) => a.requestedAt.getTime()),
      queue.stats(),
      admin.stats.summary(container.startOfDay(), await usageScope(request)),
      scoped((p) => repos.events.list({ ...byProject(p), order: 'desc', limit: 30 }), 30, (e) => Number(e.id)),
    ]);
    const projects = visible === null ? allProjects : allProjects.filter((p) => visible.has(p.id));
    const weekAgo = now.getTime() - 7 * DAY_MS;
    const lastWeek = recentRuns.filter((r) => (r.finishedAt?.getTime() ?? 0) >= weekAgo);
    const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]));
    const settings = container.settings();
    return {
      projects: {
        total: projects.length,
        running: new Set(activeRuns.filter((r) => r.status === 'RUNNING').map((r) => r.projectId)).size,
        blocked: projects.filter((p) => p.status === 'BLOCKED').length,
        byStatus: Object.fromEntries([...new Set(projects.map((p) => p.status))].map((s) => [s, projects.filter((p) => p.status === s).length])),
      },
      tasks: tasksByStatus,
      pipelines: {
        active: activeRuns.length,
        waiting: activeRuns.filter((r) => r.status === 'WAITING').length,
        succeeded7d: lastWeek.filter((r) => r.status === 'SUCCEEDED').length,
        failed7d: lastWeek.filter((r) => r.status !== 'SUCCEEDED').length,
      },
      agents: { active: activeAgents.length, running: activeAgents },
      approvals: { pending: approvals.length },
      queue: queueStats,
      costs: {
        todayUsd: today.costUsd,
        tokensToday: today.tokens,
        callsToday: today.calls,
        dailyBudgetUsd: settings.globalDailyBudgetUsd,
        budgetUsedPct: settings.globalDailyBudgetUsd > 0 ? Math.min(100, (today.costUsd / settings.globalDailyBudgetUsd) * 100) : 0,
      },
      demoMode: container.demoMode(),
      recentEvents: events,
    };
  });

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  app.get('/api/projects', viewer, async (request) => {
    const visible = await acl.visibleProjects(request);
    const [projects, activeRuns, openTasks] = await Promise.all([
      repos.projects.list().then((all) => (visible === null ? all : all.filter((p) => visible.has(p.id)))),
      repos.runs.list({ statuses: ACTIVE_RUNS, limit: 500 }),
      repos.tasks.list({ statuses: ['BACKLOG', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_CHILDREN', 'PAUSED', 'BLOCKED'], limit: 5000 }),
    ]);
    return {
      projects: projects.map((project) => {
        const runs = activeRuns.filter((r) => r.projectId === project.id);
        return {
          ...project,
          autonomyLabel: AUTONOMY_LABELS[project.autonomyLevel],
          openTasks: openTasks.filter((t) => t.projectId === project.id).length,
          activeRuns: runs.map((r) => ({ id: r.id, taskId: r.taskId, status: r.status, currentStage: r.currentStage })),
        };
      }),
    };
  });

  app.post('/api/projects', adminOnly, async (request, reply) => {
    const input = ProjectCreateSchema.parse(request.body);
    const slug = input.slug ?? slugify(input.name);
    if (await repos.projects.getBySlug(slug)) return reply.code(409).send({ error: `slug "${slug}" is already taken` });
    const project = await repos.projects.create({
      slug,
      name: input.name,
      description: input.description,
      repo: input.repo,
      priority: input.priority,
      autonomyLevel: input.autonomyLevel,
      budgetUsd: input.budgetUsd,
      profile: ProjectProfileSchema.parse({ ...defaultProjectProfile(), ...input.profile, checks: { ...defaultProjectProfile().checks, ...input.profile?.checks } }),
      settings: defaultProjectSettings(),
    });
    await container.events.emit({ type: 'project.created', projectId: project.id, taskId: null, runId: null, payload: { name: project.name } });
    await audit(request, 'project.create', project.id);
    return reply.code(201).send({ project });
  });

  app.get('/api/projects/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id);
    const project = await repos.projects.get(id);
    if (!project) return reply.code(404).send(notFound('project'));
    const since = new Date(container.clock.now().getTime() - 30 * DAY_MS);
    const [tasks, runs, decisions, approvals, costs] = await Promise.all([
      repos.tasks.list({ projectId: id, limit: 1000 }),
      repos.runs.list({ projectId: id, limit: 50 }),
      repos.decisions.list({ projectId: id, limit: 50 }),
      repos.approvals.list({ projectId: id, limit: 50 }),
      admin.stats.summary(since, id),
    ]);
    return { project: { ...project, autonomyLabel: AUTONOMY_LABELS[project.autonomyLevel] }, tasks, runs, decisions, approvals: approvals.map(withDependencies), costs30d: costs };
  });

  app.patch('/api/projects/:id', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id, 'operator');
    const project = await repos.projects.get(id);
    if (!project) return reply.code(404).send(notFound('project'));
    const patch = ProjectPatchSchema.parse(request.body);
    // Autonomy, repository, budget, settings and the profile (sandbox commands, deploy workflow, critical paths)
    // define what agents may execute — an admin decision.
    const privileged =
      patch.autonomyLevel !== undefined || patch.settings !== undefined || patch.budgetUsd !== undefined || patch.repo !== undefined || patch.profile !== undefined;
    if (privileged && !['admin', 'owner'].includes(request.user!.role)) {
      return reply.code(403).send({ error: 'changing autonomy, repository, budget, profile or settings requires the admin role' });
    }
    const updated = await repos.projects.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.repo !== undefined ? { repo: patch.repo } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.autonomyLevel !== undefined ? { autonomyLevel: patch.autonomyLevel as Project['autonomyLevel'] } : {}),
      ...(patch.budgetUsd !== undefined ? { budgetUsd: patch.budgetUsd } : {}),
      ...(patch.profile ? { profile: ProjectProfileSchema.parse({ ...project.profile, ...patch.profile, checks: { ...project.profile.checks, ...patch.profile.checks } }) } : {}),
      ...(patch.settings ? { settings: mergeSettings(project, patch.settings) } : {}),
    });
    await container.events.emit({ type: 'project.updated', projectId: id, taskId: null, runId: null, payload: { fields: Object.keys(patch) } });
    await audit(request, 'project.update', id, { fields: Object.keys(patch) });
    return { project: updated };
  });

  app.post('/api/projects/:id/pause', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id, 'operator');
    if (!(await repos.projects.get(id))) return reply.code(404).send(notFound('project'));
    await audit(request, 'project.pause', id);
    return { project: await repos.projects.update(id, { status: 'PAUSED' }) };
  });

  app.post('/api/projects/:id/resume', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id, 'operator');
    if (!(await repos.projects.get(id))) return reply.code(404).send(notFound('project'));
    await audit(request, 'project.resume', id);
    return { project: await repos.projects.update(id, { status: 'IDLE' }) };
  });

  app.get('/api/projects/:id/memory', viewer, async (request) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id);
    const { scope, q } = z.object({ scope: z.enum(['project', 'task', 'failure']).optional(), q: z.string().max(200).optional() }).parse(request.query);
    return { memories: await repos.memories.search(id, { ...(scope ? { scope } : {}), ...(q ? { text: q } : {}), limit: 100 }) };
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  app.get('/api/projects/:id/tasks', viewer, async (request) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id);
    const { status } = z.object({ status: z.enum(TASK_STATUSES).optional() }).parse(request.query);
    return { tasks: await repos.tasks.list({ projectId: id, ...(status ? { statuses: [status] } : {}), limit: 1000 }) };
  });

  app.post('/api/projects/:id/tasks', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await acl.assertProject(request, id, 'operator');
    const project = await repos.projects.get(id);
    if (!project) return reply.code(404).send(notFound('project'));
    const input = TaskInputSchema.parse(request.body);

    for (const dependency of new Set([...input.dependencies, ...(input.parentId ? [input.parentId] : [])])) {
      const other = await repos.tasks.get(dependency);
      if (!other || other.projectId !== id) return reply.code(400).send({ error: `task ${dependency} does not exist in this project` });
    }
    const task = await repos.tasks.create(id, input, request.user!.id);
    await container.events.emit({ type: 'task.created', projectId: id, taskId: task.id, runId: null, payload: { title: task.title } });
    await audit(request, 'task.create', task.id, { projectId: id });
    return reply.code(201).send({ task });
  });

  app.get('/api/tasks/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const task = await repos.tasks.get(id);
    if (!task) return reply.code(404).send(notFound('task'));
    await acl.assertProject(request, task.projectId, 'viewer', 'task');
    const [runs, decisions, children] = await Promise.all([
      repos.runs.list({ taskId: id, limit: 20 }),
      repos.decisions.list({ taskId: id, limit: 20 }),
      repos.tasks.list({ parentId: id }),
    ]);
    return { task, runs, decisions, children };
  });

  app.patch('/api/tasks/:id', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const task = await repos.tasks.get(id);
    if (!task) return reply.code(404).send(notFound('task'));
    await acl.assertProject(request, task.projectId, 'operator', 'task');
    if (!['BACKLOG', 'READY', 'BLOCKED'].includes(task.status)) return reply.code(409).send({ error: `task is ${task.status}; only queued or blocked tasks can be edited` });
    const updated = await repos.tasks.update(id, TaskPatchSchema.parse(request.body));
    await audit(request, 'task.update', id);
    return { task: updated };
  });

  app.post('/api/tasks/:id/start', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const existing = await repos.tasks.get(id);
    if (existing) await acl.assertProject(request, existing.projectId, 'operator', 'task');
    const run = await orchestrator.startTask(id);
    if (!run) return reply.code(409).send({ error: 'task cannot be started (not ready, already running or missing)' });
    await audit(request, 'task.start', id, { runId: run.id });
    return reply.code(202).send({ run });
  });

  app.post('/api/tasks/:id/retry', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const task = await repos.tasks.get(id);
    if (!task) return reply.code(404).send(notFound('task'));
    await acl.assertProject(request, task.projectId, 'operator', 'task');
    if (!['BLOCKED', 'FAILED', 'CANCELLED'].includes(task.status)) return reply.code(409).send({ error: `task is ${task.status}` });
    const updated = await repos.tasks.update(id, { status: 'READY', blockedReason: null, readySince: container.clock.now() });
    await audit(request, 'task.retry', id);
    return { task: updated };
  });

  app.post('/api/tasks/:id/cancel', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const task = await repos.tasks.get(id);
    if (!task) return reply.code(404).send(notFound('task'));
    await acl.assertProject(request, task.projectId, 'operator', 'task');
    for (const run of await repos.runs.list({ taskId: id, statuses: ACTIVE_RUNS })) await orchestrator.cancel(run.id, `cancelled by ${request.user!.login}`);
    const updated = await repos.tasks.update(id, { status: 'CANCELLED' });
    await audit(request, 'task.cancel', id);
    return { task: updated };
  });

  // ---------------------------------------------------------------------------
  // Runs, agents, decisions, approvals
  // ---------------------------------------------------------------------------

  app.get('/api/runs', viewer, async (request) => {
    const query = z.object({ projectId: z.string().optional(), status: z.enum(RUN_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return {
      runs: await acl.scopedList(
        request,
        query.projectId,
        (projectId) => repos.runs.list({ ...(projectId ? { projectId } : {}), ...(query.status ? { statuses: [query.status] } : {}), limit: query.limit }),
        { limit: query.limit, sortKey: (r) => r.startedAt.getTime() },
      ),
    };
  });

  app.get('/api/runs/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const run = await repos.runs.get(id);
    if (!run) return reply.code(404).send(notFound('run'));
    await acl.assertProject(request, run.projectId, 'viewer', 'run');
    const [task, agentRuns, events, approvals, decisions] = await Promise.all([
      repos.tasks.get(run.taskId),
      repos.agentRuns.list({ runId: id, limit: 200 }),
      repos.events.list({ runId: id, limit: 500 }),
      repos.approvals.list({ projectId: run.projectId, limit: 100 }),
      repos.decisions.list({ taskId: run.taskId, limit: 20 }),
    ]);
    return { run, task, agentRuns, events, approvals: approvals.filter((a) => a.runId === id).map(withDependencies), decisions };
  });

  app.post('/api/runs/:id/resume', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const existing = await repos.runs.get(id);
    if (existing) await acl.assertProject(request, existing.projectId, 'operator', 'run');
    const result = await orchestrator.resume(id);
    if (!result) return reply.code(409).send({ error: 'only paused runs can be resumed' });
    await audit(request, 'run.resume', id);
    return { result };
  });

  app.post('/api/runs/:id/cancel', operator, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const existing = await repos.runs.get(id);
    if (existing) await acl.assertProject(request, existing.projectId, 'operator', 'run');
    if (!(await orchestrator.cancel(id, `cancelled by ${request.user!.login}`))) return reply.code(409).send({ error: 'run is not active' });
    await audit(request, 'run.cancel', id);
    return { ok: true };
  });

  app.get('/api/agents', viewer, async (request) => {
    const query = z.object({ projectId: z.string().optional(), status: z.enum(['running', 'succeeded', 'failed']).optional(), role: z.enum(AGENT_ROLES).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return {
      agentRuns: await acl.scopedList(
        request,
        query.projectId,
        (projectId) =>
          repos.agentRuns.list({
            ...(projectId ? { projectId } : {}),
            ...(query.status ? { status: query.status } : {}),
            ...(query.role ? { role: query.role } : {}),
            limit: query.limit,
          }),
        { limit: query.limit, sortKey: (a) => a.startedAt.getTime() },
      ),
    };
  });

  app.get('/api/agents/definitions', viewer, async () => ({
    agents: Object.values(AGENT_DEFINITIONS).map((d) => ({
      key: d.key,
      role: d.role,
      name: d.name,
      schemaName: d.schemaName,
      effort: d.effort,
      expectedOutputTokens: d.expectedOutputTokens,
      tools: d.tools,
    })),
  }));

  app.get('/api/decisions', viewer, async (request) => {
    const query = z.object({ projectId: z.string().optional(), taskId: z.string().optional() }).parse(request.query);
    if (query.taskId) {
      const task = await repos.tasks.get(query.taskId);
      if (!task || (query.projectId && task.projectId !== query.projectId)) return { decisions: [] };
      await acl.assertProject(request, task.projectId, 'viewer', 'task');
      return { decisions: await repos.decisions.list({ projectId: task.projectId, taskId: task.id, limit: 200 }) };
    }
    return {
      decisions: await acl.scopedList(request, query.projectId, (projectId) => repos.decisions.list({ ...(projectId ? { projectId } : {}), limit: 200 }), {
        limit: 200,
        sortKey: (d) => d.createdAt.getTime(),
      }),
    };
  });

  app.get('/api/decisions/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const decision = await repos.decisions.get(id);
    if (!decision) return reply.code(404).send(notFound('decision'));
    await acl.assertProject(request, decision.projectId, 'viewer', 'decision');
    return { decision };
  });

  app.get('/api/approvals', viewer, async (request) => {
    const query = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(), projectId: z.string().optional() }).parse(request.query);
    return {
      approvals: (
        await acl.scopedList(
          request,
          query.projectId,
          (projectId) => repos.approvals.list({ ...(projectId ? { projectId } : {}), ...(query.status ? { status: query.status } : {}), limit: 200 }),
          { limit: 200, sortKey: (a) => a.requestedAt.getTime() },
        )
      ).map(withDependencies),
    };
  });

  app.post('/api/approvals/:id/decide', adminOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { status, comment } = z.object({ status: z.enum(['approved', 'rejected']), comment: z.string().trim().max(2000).nullable().default(null) }).parse(request.body);
    const approval = await repos.approvals.get(id);
    if (!approval) return reply.code(404).send(notFound('approval'));
    await acl.assertProject(request, approval.projectId, 'admin', 'approval');
    if (approval.action === 'production_deploy' && status === 'approved' && request.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'production deployments must be approved by an owner' });
    }
    const decided = await repos.approvals.decide(id, status, request.user!.login, comment);
    if (!decided) return reply.code(409).send({ error: 'approval was already decided' });
    const result = await orchestrator.onApprovalDecided(id);
    await audit(request, `approval.${status}`, id, { action: approval.action, runId: approval.runId });
    return { approval: withDependencies(decided), result };
  });

  // ---------------------------------------------------------------------------
  // Costs, models, providers, settings, audit
  // ---------------------------------------------------------------------------

  app.get('/api/costs', viewer, async (request) => {
    const { days, projectId } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), projectId: z.string().optional() }).parse(request.query);
    const since = new Date(container.clock.now().getTime() - days * DAY_MS);
    if (projectId) await acl.assertProject(request, projectId);
    const scope = await usageScope(request, projectId);
    const visible = await acl.visibleProjects(request);
    const [summary, byDay, byModel, byProject] = await Promise.all([
      admin.stats.summary(since, scope),
      admin.stats.byDay(since, scope),
      admin.stats.byModel(since, scope),
      projectId ? Promise.resolve([]) : admin.stats.byProject(since).then((rows) => (visible === null ? rows : rows.filter((r) => r.projectId !== null && visible.has(r.projectId)))),
    ]);
    return { since, summary, byDay, byModel, byProject };
  });

  app.get('/api/models', viewer, async () => ({
    demoMode: container.demoMode(),
    models: container.registry.list().map((model) => ({ ...model, available: container.providers.get(model) !== null })),
  }));

  app.put('/api/models/:id', adminOnly, async (request) => {
    const { id } = z.object({ id: z.string().min(3).max(200) }).parse(request.params);
    const model = ModelConfigSchema.parse({ ...(request.body as object), id: decodeURIComponent(id) });
    const saved = await admin.models.upsert(model);
    await container.reloadModels();
    await audit(request, 'model.upsert', saved.id, { enabled: saved.enabled });
    return { model: saved };
  });

  app.delete('/api/models/:id', adminOnly, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(3).max(200) }).parse(request.params);
    if (!(await admin.models.delete(decodeURIComponent(id)))) return reply.code(404).send(notFound('model'));
    await container.reloadModels();
    await audit(request, 'model.delete', id);
    return { ok: true };
  });

  app.get('/api/providers', viewer, async () => {
    const stored = await admin.providers.list();
    const env = config.providers;
    return {
      providers: [
        ...stored.map((p) => ({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, enabled: p.enabled, hasApiKey: p.apiKeyEncrypted !== null, source: 'settings' as const })),
        ...([
          ['anthropic', env.anthropicApiKey],
          ['openai', env.openaiApiKey],
          ['google', env.googleApiKey],
          ['openai-compatible', env.openaiCompatibleBaseUrl],
        ] as const)
          .filter(([, value]) => value)
          .map(([kind]) => ({ id: `env:${kind}`, kind, name: `${kind} (environment)`, baseUrl: kind === 'openai-compatible' ? env.openaiCompatibleBaseUrl : null, enabled: true, hasApiKey: true, source: 'environment' as const })),
      ],
    };
  });

  app.put('/api/providers/:id', adminOnly, async (request) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/) }).parse(request.params);
    const input = ProviderUpsertSchema.parse(request.body);
    const saved = await admin.providers.upsert({
      id,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      ...(input.apiKey !== undefined ? { apiKeyEncrypted: input.apiKey === null ? null : encryptSecret(config.encryptionKey, input.apiKey) } : {}),
    });
    await container.reloadProviders();
    await audit(request, 'provider.upsert', id, { kind: input.kind, keyChanged: input.apiKey !== undefined });
    return { provider: { id: saved.id, kind: saved.kind, name: saved.name, baseUrl: saved.baseUrl, enabled: saved.enabled, hasApiKey: saved.apiKeyEncrypted !== null } };
  });

  app.delete('/api/providers/:id', adminOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    if (!(await admin.providers.delete(id))) return reply.code(404).send(notFound('provider'));
    await container.reloadProviders();
    await audit(request, 'provider.delete', id);
    return { ok: true };
  });

  app.get('/api/settings', viewer, async () => ({ settings: container.settings(), autonomyLevels: AUTONOMY_LABELS, taskKinds: TASK_KINDS }));

  app.patch('/api/settings', adminOnly, async (request) => {
    const patch = SettingsPatchSchema.parse(request.body);
    const settings = await container.updateSettings(patch);
    await audit(request, 'settings.update', null, { fields: Object.keys(patch) });
    return { settings };
  });

  app.get('/api/audit', adminOnly, async (request) => {
    const { limit, action } = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), action: z.string().max(100).optional() }).parse(request.query);
    return { entries: await admin.audit.list({ limit, ...(action ? { action } : {}) }) };
  });

  // ---------------------------------------------------------------------------
  // Events: history + live stream (SSE)
  // ---------------------------------------------------------------------------

  app.get('/api/events', viewer, async (request) => {
    const query = z
      .object({ projectId: z.string().optional(), runId: z.string().optional(), afterId: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    let projectId = query.projectId;
    if (query.runId) {
      const run = await repos.runs.get(query.runId);
      if (!run || (projectId && run.projectId !== projectId)) return { events: [] };
      projectId = run.projectId;
    }
    const ascending = query.afterId !== undefined;
    return {
      events: await acl.scopedList(
        request,
        projectId,
        (scopedProjectId) =>
          repos.events.list({
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(query.runId ? { runId: query.runId } : {}),
            ...(ascending ? { afterId: query.afterId, order: 'asc' as const } : { order: 'desc' as const }),
            limit: query.limit,
          }),
        { limit: query.limit, sortKey: (e) => Number(e.id), order: ascending ? 'asc' : 'desc' },
      ),
    };
  });

  app.get('/api/events/stream', viewer, async (request, reply) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(request.query);
    const lastEventId = Number(request.headers['last-event-id']);
    if (projectId) await acl.assertProject(request, projectId);
    let visible = await acl.visibleProjects(request);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    const send = (event: AnyDomainEvent): void => {
      if (!eventVisible(visible, event)) return;
      raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    raw.write('retry: 3000\n\n');

    if (Number.isFinite(lastEventId)) {
      const missed = await acl.scopedList(request, projectId, (scoped) => repos.events.list({ afterId: lastEventId, ...(scoped ? { projectId: scoped } : {}), order: 'asc', limit: 500 }), {
        limit: 500,
        sortKey: (e) => Number(e.id),
        order: 'asc',
      });
      for (const event of missed) send(event);
    }
    const unsubscribe = container.bus.subscribe(send, projectId ? { projectId } : {});
    const heartbeat = setInterval(() => {
      raw.write(': keep-alive\n\n');
      // Membership changes apply to open streams within one heartbeat.
      void acl
        .visibleProjects(request, { fresh: true })
        .then((next) => {
          visible = next;
        })
        .catch(() => {});
    }, 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---------------------------------------------------------------------------
  // GitHub webhooks (HMAC-authenticated, raw body)
  // ---------------------------------------------------------------------------

  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

    scope.post('/api/webhooks/github', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
      const secret = config.github.webhookSecret;
      if (!secret) return reply.code(503).send({ error: 'webhooks are not configured' });
      const body = request.body;
      const signature = request.headers['x-hub-signature-256'];
      if (!Buffer.isBuffer(body) || !verifyGitHubSignature(secret, body, typeof signature === 'string' ? signature : undefined)) {
        return reply.code(401).send({ error: 'invalid signature' });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }
      const eventName = String(request.headers['x-github-event'] ?? '');
      const event = parseGitHubWebhook(eventName, payload);

      let resumed = 0;
      if (event.kind === 'ci_completed') {
        // Wake runs waiting on CI for this commit instead of waiting for the next poll.
        const waiting = await repos.runs.list({ statuses: ['WAITING'], limit: 500 });
        for (const run of waiting.filter((r) => r.currentStage === 'CI' && r.checkpoint.commitSha === event.sha)) {
          const saved = await repos.runs.save({ ...run, resumeAt: null });
          await queue.enqueue({ type: PIPELINE_STEP_JOB, payload: { runId: saved.id }, dedupeKey: `run:${saved.id}:${saved.version}` });
          resumed++;
        }
      }
      await admin.audit.record({ actorType: 'system', actorId: 'github', action: `webhook.${eventName || 'unknown'}`, target: null, details: { kind: event.kind, resumed }, ip: request.ip });
      return reply.code(202).send({ accepted: true, kind: event.kind, resumed });
    });
  });
}
