import { join } from 'node:path';
import {
  AgentRuntime,
  DEFAULT_MODEL_CONFIGS,
  EventBus,
  ModelRegistry,
  Orchestrator,
  RepoIndexer,
  systemClock,
  unavailableSandbox,
  type AgentRole,
  type AgentScope,
  type BudgetScope,
  type Clock,
  type EmitEvent,
  type EventRecorder,
  type EventType,
  type GitHubPort,
  type ModelConfig,
  type SandboxPort,
} from '@orch/core';
import {
  createAdminRepositories,
  createDatabase,
  createRepositories,
  PgJobQueue,
  type AdminRepositories,
  type DatabaseHandle,
  type DrizzleEventStore,
  type Repositories,
} from '@orch/db';
import { createDemoResponders, DefaultProviderResolver, DockerSandbox, OctokitGitHub, type ProviderCredential } from '@orch/integrations';
import type { ServerConfig } from './config';
import { decryptSecret } from './crypto';
import { createDemoGitHub } from './seed';

export interface GlobalSettings {
  globalDailyBudgetUsd: number;
  globalCapacity: number;
  modelOverrides: Partial<Record<AgentRole, string>>;
}

export interface Container {
  config: ServerConfig;
  clock: Clock;
  db: DatabaseHandle;
  repos: Repositories;
  admin: AdminRepositories;
  queue: PgJobQueue;
  bus: EventBus;
  events: EventRecorder;
  registry: ModelRegistry;
  providers: DefaultProviderResolver;
  runtime: AgentRuntime;
  orchestrator: Orchestrator;
  github: GitHubPort;
  githubKind: 'octokit' | 'in-memory';
  sandbox: SandboxPort;
  settings(): GlobalSettings;
  updateSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings>;
  /** Models the router may use: stored models, with mock models enabled when no real provider is usable. */
  effectiveModels(): ModelConfig[];
  demoMode(): boolean;
  reloadModels(): Promise<void>;
  reloadProviders(): Promise<void>;
  startOfDay(): Date;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  github?: GitHubPort;
  sandbox?: SandboxPort;
  clock?: Clock;
}

/** Persists every event before publishing it, so SSE clients can replay what they missed. */
class PersistentEventRecorder implements EventRecorder {
  constructor(
    private readonly store: DrizzleEventStore,
    private readonly bus: EventBus,
  ) {}

  async emit<T extends EventType>(event: EmitEvent<T>): Promise<void> {
    const saved = await this.store.append(event);
    this.bus.publish(saved);
  }
}

function environmentCredentials(config: ServerConfig): ProviderCredential[] {
  const { providers } = config;
  const credentials: ProviderCredential[] = [];
  if (providers.anthropicApiKey) credentials.push({ id: 'env:anthropic', kind: 'anthropic', apiKey: providers.anthropicApiKey, baseUrl: null, enabled: true });
  if (providers.openaiApiKey) credentials.push({ id: 'env:openai', kind: 'openai', apiKey: providers.openaiApiKey, baseUrl: null, enabled: true });
  if (providers.googleApiKey) credentials.push({ id: 'env:google', kind: 'google', apiKey: providers.googleApiKey, baseUrl: null, enabled: true });
  if (providers.openaiCompatibleBaseUrl) {
    credentials.push({
      id: 'env:openai-compatible',
      kind: 'openai-compatible',
      apiKey: providers.openaiCompatibleApiKey,
      baseUrl: providers.openaiCompatibleBaseUrl,
      enabled: true,
    });
  }
  return credentials;
}

/** Composition root: wires persistence, providers, GitHub, sandbox, agent runtime and orchestrator. */
export async function createContainer(config: ServerConfig, overrides: ContainerOverrides = {}): Promise<Container> {
  const clock = overrides.clock ?? systemClock;
  const db = await createDatabase({ url: config.databaseUrl, dataDir: config.inMemoryDatabase ? null : join(config.dataDir, 'pglite') });
  await db.migrate();

  const repos = createRepositories(db.db);
  const admin = createAdminRepositories(db.db);
  await admin.models.seedDefaults(DEFAULT_MODEL_CONFIGS);

  const bus = new EventBus((error, event) => console.error(`event handler failed for ${event.type}:`, error));
  const events = new PersistentEventRecorder(repos.events, bus);
  const queue = new PgJobQueue(db.db, clock);

  let credentials: ProviderCredential[] = [];
  const providers = new DefaultProviderResolver(() => credentials, {
    mock: { responders: createDemoResponders(), latencyMs: config.demoLatencyMs },
  });
  const reloadProviders = async () => {
    const stored = await admin.providers.list();
    credentials = [
      ...environmentCredentials(config),
      ...stored.map((row) => ({
        id: row.id,
        kind: row.kind,
        baseUrl: row.baseUrl,
        enabled: row.enabled,
        apiKey: row.apiKeyEncrypted ? decryptSecret(config.encryptionKey, row.apiKeyEncrypted) : null,
      })),
    ];
    providers.clear();
  };
  await reloadProviders();

  const registry = new ModelRegistry();
  const reloadModels = async () => registry.replaceAll(await admin.models.list());
  await reloadModels();

  const usableRealModel = () => registry.list().some((m) => m.enabled && m.provider !== 'mock' && providers.get(m) !== null);
  const effectiveModels = () => (usableRealModel() ? registry.list() : registry.list().map((m) => (m.provider === 'mock' ? { ...m, enabled: true } : m)));

  let settings: GlobalSettings = {
    globalDailyBudgetUsd: await admin.settings.get('globalDailyBudgetUsd', config.globalDailyBudgetUsd),
    globalCapacity: await admin.settings.get('globalCapacity', 4),
    modelOverrides: await admin.settings.get<Partial<Record<AgentRole, string>>>('modelOverrides', {}),
  };

  const startOfDay = () => {
    const now = clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  };

  const github: GitHubPort = overrides.github ?? (config.github.token ? new OctokitGitHub({ token: config.github.token }) : createDemoGitHub());
  const githubKind: Container['githubKind'] = !overrides.github && config.github.token ? 'octokit' : 'in-memory';
  const sandbox = overrides.sandbox ?? (config.sandbox === 'docker' ? await DockerSandbox.detect({ github, egressNetwork: config.sandboxEgressNetwork }) : unavailableSandbox);

  const runtime = new AgentRuntime({
    models: effectiveModels,
    providers,
    agentRuns: repos.agentRuns,
    usage: repos.usage,
    addProjectUsage: (projectId, costUsd, tokens) => repos.projects.addUsage(projectId, costUsd, tokens),
    addTaskUsage: (taskId, costUsd, tokens) => repos.tasks.addUsage(taskId, costUsd, tokens),
    events,
    budgetScopes: async ({ projectId, taskId }: AgentScope): Promise<BudgetScope[]> => {
      const [spentToday, project, task] = await Promise.all([
        repos.usage.totalCostSince(startOfDay()),
        repos.projects.get(projectId),
        taskId ? repos.tasks.get(taskId) : Promise.resolve(null),
      ]);
      const scopes: BudgetScope[] = [{ scope: 'global', limitUsd: settings.globalDailyBudgetUsd > 0 ? settings.globalDailyBudgetUsd : null, spentUsd: spentToday }];
      if (project) scopes.push({ scope: 'project', limitUsd: project.budgetUsd > 0 ? project.budgetUsd : null, spentUsd: project.spentUsd });
      if (task) scopes.push({ scope: 'task', limitUsd: task.maxCost, spentUsd: task.costUsd });
      return scopes;
    },
    globalRoleOverrides: () => settings.modelOverrides,
    clock,
  });

  const orchestrator = new Orchestrator({
    ...repos,
    events,
    queue,
    clock,
    runtime,
    github,
    sandbox,
    repoIndex: new RepoIndexer(github, admin.repoFiles),
    repoFiles: admin.repoFiles,
    toolAudit: (entry) =>
      admin.audit.record({
        actorType: 'agent',
        actorId: entry.agentRole,
        action: `tool.${entry.tool}.${entry.outcome}`,
        target: entry.projectId,
        details: { taskId: entry.taskId, runId: entry.runId, reason: entry.reason ?? null, durationMs: entry.durationMs, costUsd: entry.costUsd },
      }),
    globalBudgetExhausted: async () =>
      settings.globalDailyBudgetUsd > 0 && (await repos.usage.totalCostSince(startOfDay())) >= settings.globalDailyBudgetUsd,
    options: { globalCapacity: settings.globalCapacity },
  });

  return {
    config,
    clock,
    db,
    repos,
    admin,
    queue,
    bus,
    events,
    registry,
    providers,
    runtime,
    orchestrator,
    github,
    githubKind,
    sandbox,
    settings: () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      for (const [key, value] of Object.entries(patch)) await admin.settings.set(key, value);
      orchestrator.options.globalCapacity = settings.globalCapacity;
      return settings;
    },
    effectiveModels,
    demoMode: () => !usableRealModel(),
    reloadModels,
    reloadProviders,
    startOfDay,
    close: () => db.close(),
  };
}
