import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACTIVE_WORKFLOW_RUN_STATUSES,
  AGENT_ROLES,
  blankWorkflowDefinition,
  findWorkflowTemplate,
  validateWorkflowDefinition,
  WORKFLOW_LIMITS,
  WORKFLOW_STATUSES,
  WORKFLOW_TEMPLATES,
  workflowToggleAvailability,
  WorkflowValidationError,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@orch/core';
import { createProjectAcl } from './acl';
import { requireRole } from './auth';
import type { Container } from './container';

// Workflows API (ADR-037, ADR-016 pattern). Viewers read, operators edit and run; every route asserts per-project
// access (ADR-022). Mutations are audited without content. Live progress arrives as content-free workflow.* events on the
// SSE stream; clients reload runs, steps and artifacts here.

const Id = z.string().min(1).max(100);
const IdParams = z.object({ id: Id });
const RunParams = z.object({ runId: Id });
const ArtifactParams = z.object({ runId: Id, artifactId: Id });

const Name = z.string().trim().min(1).max(WORKFLOW_LIMITS.nameLength);
const Description = z.string().trim().max(WORKFLOW_LIMITS.descriptionLength);

const CreateBody = z.object({
  projectId: Id,
  name: Name,
  description: Description.default(''),
  status: z.enum(WORKFLOW_STATUSES).default('draft'),
  templateId: z.string().max(60).optional(),
  definition: z.unknown().optional(),
});

const UpdateBody = z.object({
  expectedVersion: z.number().int().min(1),
  name: Name.optional(),
  description: Description.optional(),
  status: z.enum(WORKFLOW_STATUSES).optional(),
  definition: z.unknown().optional(),
});

const RunBody = z.object({
  onNonExecutable: z.enum(['block', 'skip']).default('block'),
  maxParallel: z.number().int().min(1).max(WORKFLOW_LIMITS.maxParallel).optional(),
  maxCostUsd: z.number().min(0.01).max(WORKFLOW_LIMITS.maxCostUsd).optional(),
  maxDurationMinutes: z.number().int().min(1).max(WORKFLOW_LIMITS.maxDurationMinutes).optional(),
});

const limited = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (request: FastifyRequest) => `workflows:${max}:${request.user?.id ?? request.ip}` } });

/** Header-safe download name. */
function downloadName(name: string): string {
  let out = '';
  for (const char of name.slice(0, 120)) out += (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '.' || char === '-' || char === '_' ? char : '_';
  return out || 'artefakt.txt';
}

export async function registerWorkflowRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { repos, admin, workflows: feature, config } = container;
  const { store, runner } = feature;
  const acl = createProjectAcl(config.projectAcl, admin);
  const viewer = { preHandler: requireRole('viewer') };

  const audit = (request: FastifyRequest, action: string, target: string, details: Record<string, unknown>) =>
    admin.audit.record({ actorType: 'user', actorId: request.user?.id ?? null, action, target, details, ip: request.ip });

  const availableTools = () => feature.availableTools();

  /** Validation plus executability, as returned with every workflow. */
  async function describe(definition: WorkflowDefinition) {
    const validation = validateWorkflowDefinition(definition, { availableTools: availableTools() });
    const executability = validation.definition ? Object.fromEntries(await feature.assess(validation.definition)) : {};
    return { validation: { valid: validation.valid, issues: validation.issues }, executability };
  }

  async function present(workflow: Workflow) {
    const [project, lastRun] = await Promise.all([repos.projects.get(workflow.projectId), store.runs.list({ workflowId: workflow.id, limit: 1 })]);
    return { ...workflow, projectName: project?.name ?? null, lastRun: lastRun[0] ? summary(lastRun[0]) : null };
  }

  const summary = (run: WorkflowRun) => {
    const { definition: _definition, ...rest } = run;
    return rest;
  };

  async function loadWorkflow(request: FastifyRequest, reply: FastifyReply, id: string, minimum: 'viewer' | 'operator') {
    const workflow = await store.workflows.get(id);
    if (!workflow) {
      await reply.code(404).send({ error: 'workflow not found' });
      return null;
    }
    await acl.assertProject(request, workflow.projectId, minimum, 'workflow');
    return workflow;
  }

  async function loadRun(request: FastifyRequest, reply: FastifyReply, runId: string, minimum: 'viewer' | 'operator') {
    const run = await store.runs.get(runId);
    if (!run) {
      await reply.code(404).send({ error: 'workflow run not found' });
      return null;
    }
    await acl.assertProject(request, run.projectId, minimum, 'workflow run');
    return run;
  }

  /** Parses a submitted definition; schema errors are a 400 with issues, semantic errors only block `active`. */
  function parseDefinition(raw: unknown, status: Workflow['status']) {
    const validation = validateWorkflowDefinition(raw, { availableTools: availableTools() });
    if (!validation.definition) return { error: { error: 'invalid workflow definition', issues: validation.issues } };
    if (status === 'active' && !validation.valid) return { error: { error: 'an active workflow must be valid; save it as a draft or fix the errors', issues: validation.issues } };
    return { definition: validation.definition };
  }

  app.get('/api/workflows/meta', viewer, async () => ({
    mode: feature.mode(),
    limits: WORKFLOW_LIMITS,
    roles: AGENT_ROLES,
    tools: await feature.toolStatus(),
    toggles: workflowToggleAvailability(container.orchestrator.tools.registeredTools()),
    templates: WORKFLOW_TEMPLATES.map((template) => ({ id: template.id, name: template.name, description: template.description, definition: template.definition })),
    outputTargets: { kinds: ['artifact'], note: 'Stufe 1: Ausgaben werden als Run-Artefakte gespeichert. Schreiben ins Repository folgt über Change Set → Pull Request mit Freigabe.' },
  }));

  app.get('/api/workflows', viewer, async (request) => {
    const query = z.object({ projectId: Id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const visible = await acl.visibleProjects(request);
    let projectIds: string[] | undefined;
    if (query.projectId) {
      await acl.assertProject(request, query.projectId);
      projectIds = [query.projectId];
    } else if (visible !== null) {
      projectIds = [...visible.keys()];
    }
    const list = await store.workflows.list({ ...(projectIds ? { projectIds } : {}), limit: query.limit });
    return { workflows: await Promise.all(list.map(present)), mode: feature.mode() };
  });

  app.post('/api/workflows', { preHandler: requireRole('operator'), config: limited(30) }, async (request, reply) => {
    const input = CreateBody.parse(request.body);
    await acl.assertProject(request, input.projectId, 'operator');
    if (!(await repos.projects.get(input.projectId))) return reply.code(404).send({ error: 'project not found' });
    let raw: unknown = input.definition;
    if (raw === undefined) {
      if (input.templateId) {
        const template = findWorkflowTemplate(input.templateId);
        if (!template) return reply.code(400).send({ error: 'unknown template' });
        raw = template.definition;
      } else {
        raw = blankWorkflowDefinition();
      }
    }
    const parsed = parseDefinition(raw, input.status);
    if (parsed.error) return reply.code(400).send(parsed.error);
    const workflow = await store.workflows.create({ projectId: input.projectId, name: input.name, description: input.description, status: input.status, definition: parsed.definition, createdBy: request.user!.id });
    await audit(request, 'workflow.create', workflow.id, { projectId: workflow.projectId, templateId: input.templateId ?? null, nodes: workflow.definition.nodes.length });
    await container.events.emit({ type: 'workflow.saved', projectId: workflow.projectId, taskId: null, runId: null, payload: { workflowId: workflow.id, version: workflow.version, status: workflow.status } });
    return reply.code(201).send({ workflow: await present(workflow), ...(await describe(workflow.definition)) });
  });

  app.post('/api/workflows/validate', { preHandler: requireRole('viewer'), config: limited(60) }, async (request) => {
    const { definition } = z.object({ definition: z.unknown() }).parse(request.body);
    const validation = validateWorkflowDefinition(definition, { availableTools: availableTools() });
    const executability = validation.definition ? Object.fromEntries(await feature.assess(validation.definition)) : {};
    return { validation: { valid: validation.valid, issues: validation.issues }, executability };
  });

  app.get('/api/workflows/:id', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const workflow = await loadWorkflow(request, reply, id, 'viewer');
    if (!workflow) return reply;
    return { workflow: await present(workflow), ...(await describe(workflow.definition)) };
  });

  app.put('/api/workflows/:id', { preHandler: requireRole('operator'), config: limited(30) }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const input = UpdateBody.parse(request.body);
    const workflow = await loadWorkflow(request, reply, id, 'operator');
    if (!workflow) return reply;
    const status = input.status ?? workflow.status;
    let definition = workflow.definition;
    if (input.definition !== undefined || input.status !== undefined) {
      const parsed = parseDefinition(input.definition ?? workflow.definition, status);
      if (parsed.error) return reply.code(400).send(parsed.error);
      definition = parsed.definition;
    }
    const saved = await store.workflows.update(
      id,
      { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), status, definition },
      input.expectedVersion,
      request.user!.id,
    );
    await audit(request, 'workflow.update', id, { projectId: saved.projectId, version: saved.version, status: saved.status, fields: Object.keys(input).filter((k) => k !== 'expectedVersion'), nodes: saved.definition.nodes.length });
    await container.events.emit({ type: 'workflow.saved', projectId: saved.projectId, taskId: null, runId: null, payload: { workflowId: saved.id, version: saved.version, status: saved.status } });
    return { workflow: await present(saved), ...(await describe(saved.definition)) };
  });

  app.delete('/api/workflows/:id', { preHandler: requireRole('operator'), config: limited(30) }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const workflow = await loadWorkflow(request, reply, id, 'operator');
    if (!workflow) return reply;
    const active = await store.runs.list({ workflowId: id, statuses: ACTIVE_WORKFLOW_RUN_STATUSES, limit: 1 });
    if (active.length > 0) return reply.code(409).send({ error: 'the workflow has an active run; cancel it first' });
    await store.workflows.delete(id);
    await audit(request, 'workflow.delete', id, { projectId: workflow.projectId, name: workflow.name });
    await container.events.emit({ type: 'workflow.deleted', projectId: workflow.projectId, taskId: null, runId: null, payload: { workflowId: id } });
    return { ok: true };
  });

  app.get('/api/workflows/:id/versions', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const workflow = await loadWorkflow(request, reply, id, 'viewer');
    if (!workflow) return reply;
    const versions = await store.workflows.listVersions(id, 50);
    return { versions: versions.map((v) => ({ version: v.version, name: v.name, createdBy: v.createdBy, createdAt: v.createdAt, nodes: v.definition.nodes.length })) };
  });

  app.get('/api/workflows/:id/runs', viewer, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    const workflow = await loadWorkflow(request, reply, id, 'viewer');
    if (!workflow) return reply;
    return { runs: (await store.runs.list({ workflowId: id, limit })).map(summary) };
  });

  app.post('/api/workflows/:id/runs', { preHandler: requireRole('operator'), config: limited(10) }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const input = RunBody.parse(request.body ?? {});
    const workflow = await loadWorkflow(request, reply, id, 'operator');
    if (!workflow) return reply;
    if (workflow.status === 'archived') return reply.code(409).send({ error: 'archived workflows cannot run' });
    const active = await store.runs.list({ workflowId: id, statuses: ACTIVE_WORKFLOW_RUN_STATUSES, limit: 1 });
    if (active.length > 0) return reply.code(409).send({ error: 'the workflow is already running', runId: active[0]!.id });
    try {
      const run = await runner.start({
        workflow,
        mode: feature.mode(),
        onNonExecutable: input.onNonExecutable,
        startedBy: request.user!.id,
        limits: { maxParallel: input.maxParallel, maxCostUsd: input.maxCostUsd, maxDurationMinutes: input.maxDurationMinutes },
      });
      await audit(request, 'workflow.run.start', run.id, { projectId: run.projectId, workflowId: id, version: run.workflowVersion, status: run.status, mode: run.mode, onNonExecutable: run.onNonExecutable, limits: run.limits, sessionId: run.sessionId, blockers: run.blockers.length });
      return reply.code(201).send({ run: summary(run), steps: await store.runs.listSteps(run.id) });
    } catch (error) {
      if (error instanceof WorkflowValidationError) return reply.code(400).send({ error: 'the workflow is invalid and cannot run', issues: error.issues });
      throw error;
    }
  });

  app.get('/api/workflow-runs/:runId', viewer, async (request, reply) => {
    const { runId } = RunParams.parse(request.params);
    const run = await loadRun(request, reply, runId, 'viewer');
    if (!run) return reply;
    const [steps, artifacts, usage] = await Promise.all([store.runs.listSteps(runId), store.runs.listArtifacts(runId), run.mode === 'live' ? store.runs.ledgerTotals(runId) : Promise.resolve(null)]);
    return { run, steps, artifacts, usage };
  });

  app.get('/api/workflow-runs/:runId/events', viewer, async (request, reply) => {
    const { runId } = RunParams.parse(request.params);
    const run = await loadRun(request, reply, runId, 'viewer');
    if (!run) return reply;
    return { events: await store.runs.listEvents(run.projectId, runId, 500) };
  });

  app.get('/api/workflow-runs/:runId/artifacts/:artifactId', viewer, async (request, reply) => {
    const { runId, artifactId } = ArtifactParams.parse(request.params);
    const { download } = z.object({ download: z.enum(['0', '1']).optional() }).parse(request.query);
    const run = await loadRun(request, reply, runId, 'viewer');
    if (!run) return reply;
    const artifact = await store.runs.getArtifact(runId, artifactId);
    if (!artifact) return reply.code(404).send({ error: 'artifact not found' });
    if (download === '1') {
      // Plain text attachment, never rendered as HTML (nosniff and CSP are set globally).
      const type = artifact.format === 'json' ? 'application/json' : artifact.format === 'markdown' ? 'text/markdown' : 'text/plain';
      return reply
        .header('content-type', `${type}; charset=utf-8`)
        .header('content-disposition', `attachment; filename="${downloadName(artifact.name.split('/').join('_'))}"`)
        .send(artifact.content);
    }
    return { artifact };
  });

  app.post('/api/workflow-runs/:runId/cancel', { preHandler: requireRole('operator'), config: limited(30) }, async (request, reply) => {
    const { runId } = RunParams.parse(request.params);
    const run = await loadRun(request, reply, runId, 'operator');
    if (!run) return reply;
    const cancelled = await runner.cancel(runId, `Abgebrochen von ${request.user!.login}.`);
    if (!cancelled) return reply.code(409).send({ error: `run is already ${run.status}` });
    await audit(request, 'workflow.run.cancel', runId, { projectId: run.projectId, workflowId: run.workflowId });
    return { run: summary(cancelled) };
  });
}
