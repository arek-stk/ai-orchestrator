import { createHash } from 'node:crypto';
import {
  HEALTH_SCAN_JOB,
  HealthScanner,
  RESEARCH_JOB,
  runResearch,
  type AgentRuntime,
  type Clock,
  type EventRecorder,
  type GitHubPort,
  type JobQueue,
  type RepoIndexer,
} from '@orch/core';
import type { AdminRepositories, HealthRepositories, Repositories } from '@orch/db';

export interface IntelligenceDeps {
  repos: Repositories;
  admin: AdminRepositories;
  health: HealthRepositories;
  events: EventRecorder;
  queue: JobQueue;
  clock: Clock;
  runtime: AgentRuntime;
  github: GitHubPort;
  repoIndex: RepoIndexer;
}

export interface IntelligenceOptions {
  /** Scheduled scans per project (autonomy ≥ 1 with a repository). 0 disables scheduled scans. */
  scanIntervalMs: number;
  /** How often the worker tick checks for due scans and purges expired cache entries. */
  maintenanceIntervalMs: number;
}

export interface Intelligence {
  health: HealthRepositories;
  scanner: HealthScanner;
  /** Job types handled by `handleJob`, claimed by the worker pool. */
  jobTypes: readonly string[];
  handleJob(job: { type: string; payload: Record<string, unknown> }): Promise<void>;
  /** Maintenance from the scheduler tick: queue due scans, purge the expired agent cache. Throttled. */
  tick(): Promise<{ scansQueued: number; cachePurged: number } | null>;
  requestResearch(input: { projectId: string; question: string; taskId: string | null }): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Composition of the orchestration-intelligence services (health scans, research, cache maintenance). */
export function createIntelligence(deps: IntelligenceDeps, options: Partial<IntelligenceOptions> = {}): Intelligence {
  const settings: IntelligenceOptions = { scanIntervalMs: DAY_MS, maintenanceIntervalMs: 60 * 60 * 1000, ...options };
  const scanner = new HealthScanner({
    projects: deps.repos.projects,
    tasks: deps.repos.tasks,
    runs: deps.repos.runs,
    memories: deps.repos.memories,
    scans: deps.health.healthScans,
    proposals: deps.health.proposals,
    events: deps.events,
    queue: deps.queue,
    clock: deps.clock,
    runtime: deps.runtime,
    github: deps.github,
    repoIndex: deps.repoIndex,
    repoFiles: deps.admin.repoFiles,
    summaries: deps.health.fileSummaries,
  });
  let lastMaintenance = 0;

  return {
    health: deps.health,
    scanner,
    jobTypes: [HEALTH_SCAN_JOB, RESEARCH_JOB],

    async handleJob(job) {
      if (job.type === HEALTH_SCAN_JOB) {
        await scanner.run(String(job.payload.scanId ?? ''));
        return;
      }
      if (job.type === RESEARCH_JOB) {
        const result = await runResearch(
          { projects: deps.repos.projects, tasks: deps.repos.tasks, memories: deps.repos.memories, events: deps.events, runtime: deps.runtime },
          { projectId: String(job.payload.projectId ?? ''), question: String(job.payload.question ?? ''), taskId: typeof job.payload.taskId === 'string' ? job.payload.taskId : null },
        );
        await deps.admin.audit.record({
          actorType: 'agent',
          actorId: 'researcher',
          action: result.ok ? 'research.completed' : 'research.failed',
          target: String(job.payload.projectId ?? ''),
          details: result.ok ? { memoryKey: result.memoryKey, costUsd: result.costUsd } : { error: result.error, costUsd: result.costUsd },
        });
        return;
      }
      throw new Error(`unsupported job type ${job.type}`);
    },

    async tick() {
      const now = deps.clock.now().getTime();
      if (now - lastMaintenance < settings.maintenanceIntervalMs) return null;
      lastMaintenance = now;
      const scansQueued = settings.scanIntervalMs > 0 ? await scanner.scheduleDue(settings.scanIntervalMs) : 0;
      const cachePurged = await deps.health.agentCache.purgeExpired(deps.clock.now());
      return { scansQueued, cachePurged };
    },

    async requestResearch(input) {
      const digest = createHash('sha256').update(`${input.projectId}|${input.taskId ?? ''}|${input.question}`).digest('hex').slice(0, 16);
      await deps.queue.enqueue({ type: RESEARCH_JOB, payload: { ...input }, dedupeKey: `research:${digest}`, maxAttempts: 2 });
    },
  };
}
