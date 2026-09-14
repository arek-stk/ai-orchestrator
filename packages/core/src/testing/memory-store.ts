import type { AgentCacheEntry, AgentCacheStore } from '../agents/cache';
import type { IndexedFile } from '../context/context-builder';
import type { FileSummaryStore } from '../context/file-summarizer';
import type { HealthScan, HealthScanRepository, ImprovementProposal, ProposalRepository } from '../intelligence/types';
import type { RunStatus, TaskStatus } from '../domain/enums';
import type { Project } from '../domain/project';
import type { AgentRun, Approval, Decision, MemoryItem, UsageEntry } from '../domain/records';
import { emptyCheckpoint, type PipelineRun } from '../domain/run';
import type { Task } from '../domain/task';
import type { AnyDomainEvent } from '../events/types';
import { ZERO_USAGE } from '../models/types';
import {
  ConcurrentModificationError,
  systemClock,
  type AgentRunRepository,
  type ApprovalRepository,
  type Clock,
  type DecisionRepository,
  type EmitEvent,
  type EnqueueJob,
  type EventRecorder,
  type JobQueue,
  type MemoryRepository,
  type ProjectRepository,
  type RunRepository,
  type TaskRepository,
  type UsageRepository,
} from '../ports';
import type { RepoFileStore } from '../repo-index/indexer';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory implementation of every persistence port. Used by core tests; mirrors the semantics of the
 * Drizzle repositories (optimistic locking, memory upserts, single approval decisions).
 */
export function createMemoryStore(clock: Clock = systemClock) {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;
  const now = () => clock.now();

  const projectMap = new Map<string, Project>();
  const taskMap = new Map<string, Task & { createdBy: string | null }>();
  const runMap = new Map<string, PipelineRun>();
  const agentRunList: AgentRun[] = [];
  const decisionList: Decision[] = [];
  const memoryList: MemoryItem[] = [];
  const approvalList: Approval[] = [];
  const ledger: Array<UsageEntry & { createdAt: Date }> = [];
  const eventLog: AnyDomainEvent[] = [];
  const jobs: EnqueueJob[] = [];
  const repoFileMap = new Map<string, IndexedFile[]>();

  const projects: ProjectRepository = {
    get: async (projectId) => (projectMap.has(projectId) ? clone(projectMap.get(projectId)!) : null),
    getBySlug: async (slug) => clone([...projectMap.values()].find((p) => p.slug === slug) ?? null),
    list: async () => clone([...projectMap.values()].sort((a, b) => b.priority - a.priority)),
    create: async (input) => {
      const project: Project = {
        ...clone(input),
        id: id('prj'),
        status: 'IDLE',
        healthScore: 100,
        spentUsd: 0,
        tokensUsed: 0,
        lastScheduledAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      projectMap.set(project.id, project);
      return clone(project);
    },
    update: async (projectId, patch) => {
      const project = projectMap.get(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      Object.assign(project, clone(patch), { updatedAt: now() });
      return clone(project);
    },
    addUsage: async (projectId, costUsd, tokens) => {
      const project = projectMap.get(projectId);
      if (project) {
        project.spentUsd += costUsd;
        project.tokensUsed += tokens;
      }
    },
  };

  const tasks: TaskRepository = {
    get: async (taskId) => (taskMap.has(taskId) ? clone(taskMap.get(taskId)!) : null),
    list: async (filter) =>
      clone(
        [...taskMap.values()]
          .filter((t) => !filter.projectId || t.projectId === filter.projectId)
          .filter((t) => !filter.statuses || filter.statuses.includes(t.status))
          .filter((t) => filter.parentId === undefined || t.parentId === filter.parentId)
          .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, filter.limit ?? 500),
      ),
    statuses: async (ids) => {
      const result = new Map<string, TaskStatus>();
      for (const taskId of ids) {
        const task = taskMap.get(taskId);
        if (task) result.set(taskId, task.status);
      }
      return result;
    },
    create: async (projectId, input, createdBy) => {
      const task = {
        ...clone(input),
        id: id('tsk'),
        projectId,
        status: 'READY' as TaskStatus,
        attempts: 0,
        costUsd: 0,
        tokensUsed: 0,
        branch: null,
        prNumber: null,
        blockedReason: null,
        readySince: now(),
        createdAt: now(),
        updatedAt: now(),
        createdBy,
      };
      taskMap.set(task.id, task);
      return clone(task);
    },
    update: async (taskId, patch) => {
      const task = taskMap.get(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      Object.assign(task, clone(patch), { updatedAt: now() });
      return clone(task);
    },
    addUsage: async (taskId, costUsd, tokens) => {
      const task = taskMap.get(taskId);
      if (task) {
        task.costUsd += costUsd;
        task.tokensUsed += tokens;
      }
    },
  };

  const runs: RunRepository = {
    create: async (input) => {
      const run: PipelineRun = {
        id: id('run'),
        taskId: input.taskId,
        projectId: input.projectId,
        status: 'QUEUED',
        currentStage: null,
        stagePlan: clone(input.stagePlan),
        stageStates: {},
        iterations: 0,
        debugAttempts: 0,
        costUsd: 0,
        tokens: 0,
        limits: clone(input.limits),
        checkpoint: emptyCheckpoint(),
        error: null,
        blockedReason: null,
        resumeAt: null,
        startedAt: now(),
        finishedAt: null,
        updatedAt: now(),
        version: 1,
      };
      runMap.set(run.id, run);
      return clone(run);
    },
    get: async (runId) => (runMap.has(runId) ? clone(runMap.get(runId)!) : null),
    list: async (filter) =>
      clone(
        [...runMap.values()]
          .filter((r) => !filter.projectId || r.projectId === filter.projectId)
          .filter((r) => !filter.taskId || r.taskId === filter.taskId)
          .filter((r) => !filter.statuses || filter.statuses.includes(r.status))
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, filter.limit ?? 100),
      ),
    save: async (run) => {
      const current = runMap.get(run.id);
      if (!current || current.version !== run.version) throw new ConcurrentModificationError('pipeline run', run.id);
      const saved = { ...clone(run), version: run.version + 1, updatedAt: now() };
      runMap.set(run.id, saved);
      return clone(saved);
    },
    countByProject: async (statuses: readonly RunStatus[]) => {
      const counts = new Map<string, number>();
      for (const run of runMap.values()) {
        if (statuses.includes(run.status)) counts.set(run.projectId, (counts.get(run.projectId) ?? 0) + 1);
      }
      return counts;
    },
  };

  const agentRuns: AgentRunRepository = {
    start: async (input) => {
      const run: AgentRun = {
        id: id('agr'),
        runId: input.runId,
        taskId: input.taskId,
        projectId: input.projectId,
        role: input.role,
        modelConfigId: input.modelConfigId ?? null,
        provider: input.provider ?? null,
        modelId: input.modelId ?? null,
        status: 'running',
        inputSummary: input.inputSummary,
        output: null,
        confidence: null,
        usage: { ...ZERO_USAGE },
        costUsd: 0,
        toolsUsed: [],
        durationMs: null,
        error: null,
        startedAt: now(),
        finishedAt: null,
      };
      agentRunList.push(run);
      return clone(run);
    },
    finish: async (agentRunId, result) => {
      const run = agentRunList.find((r) => r.id === agentRunId);
      if (run) Object.assign(run, clone(result), { finishedAt: now() });
    },
    list: async (filter) =>
      clone(
        agentRunList
          .filter((r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.runId || r.runId === filter.runId))
          .filter((r) => (!filter.role || r.role === filter.role) && (!filter.status || r.status === filter.status))
          .slice(0, filter.limit ?? 100),
      ),
  };

  const decisions: DecisionRepository = {
    create: async (input) => {
      const decision: Decision = { ...clone(input), id: id('dec'), createdAt: now() };
      decisionList.push(decision);
      return clone(decision);
    },
    get: async (decisionId) => clone(decisionList.find((d) => d.id === decisionId) ?? null),
    list: async (filter) =>
      clone(
        decisionList
          .filter((d) => (!filter.projectId || d.projectId === filter.projectId) && (!filter.taskId || d.taskId === filter.taskId))
          .slice(0, filter.limit ?? 100),
      ),
    findByQuestionKey: async (projectId, questionKey) =>
      clone([...decisionList].reverse().find((d) => d.projectId === projectId && d.questionKey === questionKey) ?? null),
  };

  const memories: MemoryRepository = {
    upsert: async (input) => {
      const existing = memoryList.find((m) => m.projectId === input.projectId && m.scope === input.scope && m.key === input.key);
      if (existing) {
        Object.assign(existing, { content: input.content, kind: input.kind, tags: input.tags ?? [], taskId: input.taskId ?? null });
        existing.hits++;
        existing.updatedAt = now();
        return clone(existing);
      }
      const item: MemoryItem = {
        id: id('mem'),
        projectId: input.projectId,
        scope: input.scope,
        taskId: input.taskId ?? null,
        kind: input.kind,
        key: input.key,
        content: input.content,
        tags: input.tags ?? [],
        hits: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      memoryList.push(item);
      return clone(item);
    },
    search: async (projectId, query) => {
      const text = query.text?.toLowerCase();
      return clone(
        memoryList
          .filter((m) => m.projectId === projectId)
          .filter((m) => (!query.scope || m.scope === query.scope) && (!query.kind || m.kind === query.kind) && (!query.key || m.key === query.key))
          .filter((m) => !text || m.content.toLowerCase().includes(text) || m.key.toLowerCase().includes(text))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, query.limit ?? 50),
      );
    },
  };

  const approvals: ApprovalRepository = {
    create: async (input) => {
      const approval: Approval = {
        ...clone(input),
        id: id('apr'),
        status: 'pending',
        requestedAt: now(),
        decidedBy: null,
        decidedAt: null,
        comment: null,
      };
      approvalList.push(approval);
      return clone(approval);
    },
    get: async (approvalId) => clone(approvalList.find((a) => a.id === approvalId) ?? null),
    list: async (filter) =>
      clone(
        approvalList
          .filter((a) => (!filter.projectId || a.projectId === filter.projectId) && (!filter.status || a.status === filter.status))
          .slice(0, filter.limit ?? 100),
      ),
    decide: async (approvalId, status, decidedBy, comment) => {
      const approval = approvalList.find((a) => a.id === approvalId);
      if (!approval || approval.status !== 'pending') return null;
      Object.assign(approval, { status, decidedBy, comment, decidedAt: now() });
      return clone(approval);
    },
  };

  const usage: UsageRepository = {
    record: async (entry) => void ledger.push({ ...clone(entry), createdAt: now() }),
    totalCostSince: async (since, projectId) =>
      ledger
        .filter((e) => e.createdAt.getTime() >= since.getTime() && (!projectId || e.projectId === projectId))
        .reduce((sum, e) => sum + e.costUsd, 0),
  };

  const events: EventRecorder & { log: AnyDomainEvent[] } = {
    log: eventLog,
    emit: async (event: EmitEvent) => {
      eventLog.push({ ...clone(event), id: String(eventLog.length + 1), createdAt: now() } as AnyDomainEvent);
    },
  };

  const queue: JobQueue & { jobs: EnqueueJob[] } = {
    jobs,
    enqueue: async (job) => void jobs.push(clone(job)),
  };

  const repoFiles: RepoFileStore = {
    list: async (projectId) => clone(repoFileMap.get(projectId) ?? []),
    replace: async (projectId, files) => void repoFileMap.set(projectId, clone([...files])),
  };

  const cacheMap = new Map<string, AgentCacheEntry & { hits: number }>();
  const agentCache: AgentCacheStore & { entries: typeof cacheMap } = {
    entries: cacheMap,
    get: async (key, at) => {
      const entry = cacheMap.get(key);
      if (!entry || (entry.expiresAt && entry.expiresAt.getTime() <= at.getTime())) return null;
      return clone(entry);
    },
    set: async (entry) => void cacheMap.set(entry.key, { ...clone(entry), hits: 0 }),
    recordHit: async (key) => {
      const entry = cacheMap.get(key);
      if (entry) entry.hits++;
    },
  };

  const scanList: HealthScan[] = [];
  const scans: HealthScanRepository = {
    create: async (input) => {
      const scan: HealthScan = {
        id: id('hsc'),
        ...input,
        status: 'queued',
        healthScore: null,
        previousScore: null,
        breakdown: [],
        signals: null,
        proposalsCreated: 0,
        proposalsSeen: 0,
        autoAccepted: 0,
        agentStatus: null,
        costUsd: 0,
        summary: null,
        error: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
      };
      scanList.push(scan);
      return clone(scan);
    },
    get: async (scanId) => clone(scanList.find((s) => s.id === scanId) ?? null),
    list: async (projectId, limit = 20) => clone([...scanList].reverse().filter((s) => s.projectId === projectId).slice(0, limit)),
    findActive: async (projectId) => clone([...scanList].reverse().find((s) => s.projectId === projectId && (s.status === 'queued' || s.status === 'running')) ?? null),
    update: async (scanId, patch) => {
      const scan = scanList.find((s) => s.id === scanId);
      if (!scan) throw new Error(`health scan ${scanId} not found`);
      Object.assign(scan, clone(patch));
      return clone(scan);
    },
  };

  const proposalList: ImprovementProposal[] = [];
  const proposals: ProposalRepository = {
    upsert: async (input) => {
      const existing = proposalList.find((p) => p.projectId === input.projectId && p.fingerprint === input.fingerprint);
      if (existing) {
        existing.occurrences++;
        existing.updatedAt = now();
        return { proposal: clone(existing), created: false };
      }
      const proposal: ImprovementProposal = {
        ...clone(input),
        id: id('imp'),
        status: 'proposed',
        taskId: null,
        autoAccepted: false,
        decidedBy: null,
        decidedAt: null,
        dismissReason: null,
        occurrences: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      proposalList.push(proposal);
      return { proposal: clone(proposal), created: true };
    },
    get: async (proposalId) => clone(proposalList.find((p) => p.id === proposalId) ?? null),
    list: async (filter) =>
      clone(
        proposalList
          .filter((p) => (!filter.projectId || p.projectId === filter.projectId) && (!filter.statuses || filter.statuses.includes(p.status)))
          .sort((a, b) => b.priority - a.priority || b.roiScore - a.roiScore)
          .slice(0, filter.limit ?? 200),
      ),
    accept: async (proposalId, input) => {
      const proposal = proposalList.find((p) => p.id === proposalId);
      if (!proposal || proposal.status !== 'proposed') return null;
      Object.assign(proposal, { status: 'accepted', taskId: input.taskId, decidedBy: input.decidedBy, autoAccepted: input.auto, decidedAt: now(), updatedAt: now() });
      return clone(proposal);
    },
    dismiss: async (proposalId, input) => {
      const proposal = proposalList.find((p) => p.id === proposalId);
      if (!proposal || proposal.status !== 'proposed') return null;
      Object.assign(proposal, { status: 'dismissed', decidedBy: input.decidedBy, dismissReason: input.reason, decidedAt: now(), updatedAt: now() });
      return clone(proposal);
    },
  };

  const fileSummaries: FileSummaryStore = {
    updateSummaries: async (projectId, entries) => {
      let updated = 0;
      for (const entry of entries) {
        const file = repoFileMap.get(projectId)?.find((f) => f.path === entry.path && f.sha === entry.sha);
        if (file) {
          file.summary = entry.summary;
          updated++;
        }
      }
      return updated;
    },
  };

  return { projects, tasks, runs, agentRuns, decisions, memories, approvals, usage, events, queue, repoFiles, ledger, agentCache, scans, proposals, fileSummaries };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
