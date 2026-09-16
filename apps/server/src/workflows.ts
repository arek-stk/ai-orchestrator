import {
  assessWorkflow,
  DemoWorkflowExecutor,
  EXECUTABILITY_MESSAGES,
  LiveWorkflowExecutor,
  WORKFLOW_RUN_JOB,
  WORKFLOW_RUNNER_TOOLS,
  WORKFLOW_TOOLS,
  WorkflowRunner,
  workflowToggleAvailability,
  workflowToolModels,
  type AgentRuntime,
  type AutopilotSession,
  type Clock,
  type EventRecorder,
  type ExecutabilityEnvironment,
  type JobQueue,
  type ModelConfig,
  type ModelProvider,
  type RoomService,
  type ToolName,
  type WorkflowDefinition,
  type WorkflowProviderAccount,
  type WorkflowRunMode,
} from '@orch/core';
import { createWorkflowRepositories, type AdminRepositories, type Db, type DrizzleAutopilotSessionRepository, type Repositories, type WorkflowRepositories } from '@orch/db';
import type { ServerConfig } from './config';

// Composition of the Workflows feature (ADR-037): repositories, executability environment, runner with live and demo
// executors, autopilot session caps and the job handler the worker pool calls.

export interface WorkflowFeatureDeps {
  db: Db;
  config: ServerConfig;
  repos: Repositories;
  admin: AdminRepositories;
  events: EventRecorder;
  queue: JobQueue;
  clock: Clock;
  runtime: AgentRuntime;
  room: RoomService;
  registry: { list(): ModelConfig[] };
  providers: { get(model: ModelConfig): ModelProvider | null };
  autopilotSessions: DrizzleAutopilotSessionRepository;
  demoMode: () => boolean;
  registeredTools: () => ToolName[];
}

export interface WorkflowFeature {
  store: WorkflowRepositories;
  runner: WorkflowRunner;
  mode(): WorkflowRunMode;
  environment(mode: WorkflowRunMode): Promise<ExecutabilityEnvironment>;
  availableTools(): ReadonlySet<ToolName>;
  /** Tool catalog with live executability for the editor. */
  toolStatus(): Promise<Array<{ id: string; name: string; vendor: string; integration: string; executable: boolean; code: string; message: string; models: Array<{ id: string; label: string }> }>>;
  assess(definition: WorkflowDefinition): Promise<ReturnType<typeof assessWorkflow>>;
  jobTypes: readonly string[];
  handleJob(job: { type: string; payload: Record<string, unknown> }): Promise<void>;
}

export function createWorkflowFeature(deps: WorkflowFeatureDeps): WorkflowFeature {
  const store = createWorkflowRepositories(deps.db);
  const mode = (): WorkflowRunMode => (deps.demoMode() ? 'demo' : 'live');

  const accounts = async (): Promise<WorkflowProviderAccount[]> => {
    const stored = await deps.admin.providers.list();
    const env = deps.config.providers;
    const environment: WorkflowProviderAccount[] = (
      [
        ['anthropic', env.anthropicApiKey],
        ['openai', env.openaiApiKey],
        ['google', env.googleApiKey],
        ['openai-compatible', env.openaiCompatibleBaseUrl],
      ] as const
    )
      .filter(([, value]) => Boolean(value))
      .map(([kind]) => ({ id: `env:${kind}`, kind, baseUrl: kind === 'openai-compatible' ? env.openaiCompatibleBaseUrl : null, enabled: true, usable: true, source: 'environment' as const }));
    return [
      ...stored.map((row) => ({
        id: row.id,
        kind: row.kind,
        baseUrl: row.baseUrl,
        enabled: row.enabled,
        usable: row.enabled && (row.kind === 'openai-compatible' ? row.baseUrl !== null : row.apiKeyEncrypted !== null),
        source: 'settings' as const,
      })),
      ...environment,
    ];
  };

  const environment = async (runMode: WorkflowRunMode): Promise<ExecutabilityEnvironment> => ({
    mode: runMode,
    // Only real models: the mock models behind demo mode never make a live node executable.
    models: deps.registry.list().filter((model) => model.provider !== 'mock'),
    accounts: await accounts(),
    isModelAvailable: (model) => deps.providers.get(model) !== null,
  });

  const availableTools = () => new Set(deps.registeredTools().filter((tool) => WORKFLOW_RUNNER_TOOLS.has(tool)));

  const sessionRemaining = async (session: AutopilotSession) => {
    const [pipelineSpend, workflowSpend] = await Promise.all([deps.autopilotSessions.spentUsd(session), store.runs.sessionCostUsd(session.id)]);
    return session.budgetUsd - pipelineSpend - workflowSpend;
  };

  const runner = new WorkflowRunner({
    runs: store.runs,
    projects: deps.repos.projects,
    events: deps.events,
    queue: deps.queue,
    executors: { live: new LiveWorkflowExecutor(deps.runtime), demo: new DemoWorkflowExecutor({ latencyMs: deps.config.demoLatencyMs }) },
    environment,
    availableTools,
    room: deps.room,
    sessions: {
      activeForProject: async (projectId) => {
        const [session] = await deps.autopilotSessions.list({ statuses: ['active'], projectIds: [projectId], limit: 1 });
        if (!session) return null;
        return { id: session.id, remainingBudgetUsd: await sessionRemaining(session), endsAt: session.endsAt };
      },
      status: async (sessionId) => (await deps.autopilotSessions.get(sessionId))?.status ?? null,
    },
    clock: deps.clock,
    onError: (error, context) => console.error(`${context} failed:`, error),
  });

  return {
    store,
    runner,
    mode,
    environment,
    availableTools,
    async toolStatus() {
      const runMode = mode();
      const env = await environment(runMode);
      return WORKFLOW_TOOLS.map((tool) => {
        const assessment = assessWorkflow(
          {
            schemaVersion: 1,
            nodes: [
              { id: 'probe', type: 'agent', label: 'probe', position: { x: 0, y: 0 }, role: 'researcher', toolId: tool.id, model: null, temperature: 0.7, maxTokens: 1000, enabledTools: [], output: { format: 'markdown', artifactName: '' }, instructions: '', description: '', tags: [] },
            ],
            edges: [],
          },
          env,
        ).get('probe')!;
        const models = runMode === 'live' ? workflowToolModels(tool, env).map((model) => ({ id: model.id, label: model.displayName })) : [];
        return { id: tool.id, name: tool.name, vendor: tool.vendor, integration: tool.integration, executable: assessment.executable, code: assessment.code, message: assessment.code === 'ok' && runMode === 'demo' ? `${EXECUTABILITY_MESSAGES.ok} (Demo)` : assessment.message, models };
      });
    },
    async assess(definition) {
      return assessWorkflow(definition, await environment(mode()));
    },
    jobTypes: [WORKFLOW_RUN_JOB],
    async handleJob(job) {
      if (job.type !== WORKFLOW_RUN_JOB) throw new Error(`unknown job type ${job.type}`);
      await runner.execute(String(job.payload.runId ?? ''));
    },
  };
}
