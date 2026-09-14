import type { RunStatus, TaskStatus } from './domain/enums';
import type { Project } from './domain/project';
import type {
  AgentRole,
} from './domain/enums';
import type {
  AgentRun,
  AgentRunResult,
  Approval,
  ApprovalStatus,
  Decision,
  MemoryItem,
  MemoryScope,
  UsageEntry,
} from './domain/records';
import type { PipelineRun } from './domain/run';
import type { Task, TaskInput } from './domain/task';
import type { DomainEvent, EventType } from './events/types';

// Ports are implemented by packages/db (persistence) and apps/server (composition).

export type NewProject = Omit<
  Project,
  'id' | 'status' | 'healthScore' | 'spentUsd' | 'tokensUsed' | 'lastScheduledAt' | 'createdAt' | 'updatedAt'
>;
export type ProjectPatch = Partial<
  Pick<
    Project,
    'name' | 'description' | 'repo' | 'status' | 'priority' | 'autonomyLevel' | 'healthScore' | 'budgetUsd' | 'profile' | 'settings' | 'lastScheduledAt'
  >
>;

export interface ProjectRepository {
  get(id: string): Promise<Project | null>;
  getBySlug(slug: string): Promise<Project | null>;
  list(): Promise<Project[]>;
  create(input: NewProject): Promise<Project>;
  update(id: string, patch: ProjectPatch): Promise<Project>;
  addUsage(id: string, costUsd: number, tokens: number): Promise<void>;
}

export interface TaskFilter {
  projectId?: string;
  statuses?: readonly TaskStatus[];
  parentId?: string | null;
  limit?: number;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'goal'
    | 'status'
    | 'priority'
    | 'dependencies'
    | 'acceptanceCriteria'
    | 'risk'
    | 'estimatedComplexity'
    | 'attempts'
    | 'branch'
    | 'prNumber'
    | 'blockedReason'
    | 'readySince'
  >
>;

export interface TaskRepository {
  get(id: string): Promise<Task | null>;
  list(filter: TaskFilter): Promise<Task[]>;
  statuses(ids: readonly string[]): Promise<Map<string, TaskStatus>>;
  create(projectId: string, input: TaskInput, createdBy: string | null): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  addUsage(id: string, costUsd: number, tokens: number): Promise<void>;
}

export type NewRun = Pick<PipelineRun, 'taskId' | 'projectId' | 'stagePlan' | 'limits'> & Partial<Pick<PipelineRun, 'sessionId'>>;

export interface RunFilter {
  projectId?: string;
  taskId?: string;
  statuses?: readonly RunStatus[];
  sessionId?: string;
  limit?: number;
}

export class ConcurrentModificationError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently`);
    this.name = 'ConcurrentModificationError';
  }
}

export interface RunRepository {
  create(run: NewRun): Promise<PipelineRun>;
  get(id: string): Promise<PipelineRun | null>;
  list(filter: RunFilter): Promise<PipelineRun[]>;
  /** Persists the run if its version is unchanged; throws ConcurrentModificationError otherwise. */
  save(run: PipelineRun): Promise<PipelineRun>;
  countByProject(statuses: readonly RunStatus[]): Promise<Map<string, number>>;
}

export type NewAgentRun = Pick<AgentRun, 'runId' | 'taskId' | 'projectId' | 'role' | 'inputSummary'> &
  Partial<Pick<AgentRun, 'modelConfigId' | 'provider' | 'modelId'>>;

export interface AgentRunFilter {
  projectId?: string;
  runId?: string;
  role?: AgentRole;
  status?: AgentRun['status'];
  limit?: number;
}

export interface AgentRunRepository {
  start(run: NewAgentRun): Promise<AgentRun>;
  finish(id: string, result: AgentRunResult): Promise<void>;
  list(filter: AgentRunFilter): Promise<AgentRun[]>;
}

export type NewDecision = Omit<Decision, 'id' | 'createdAt'>;

export interface DecisionRepository {
  create(decision: NewDecision): Promise<Decision>;
  get(id: string): Promise<Decision | null>;
  list(filter: { projectId?: string; taskId?: string; limit?: number }): Promise<Decision[]>;
  /** Most recent decision for an equivalent question in the project (for reuse, spec §29). */
  findByQuestionKey(projectId: string, questionKey: string): Promise<Decision | null>;
}

export type NewMemory = Pick<MemoryItem, 'projectId' | 'scope' | 'kind' | 'key' | 'content'> &
  Partial<Pick<MemoryItem, 'taskId' | 'tags'>>;

export interface MemoryQuery {
  scope?: MemoryScope;
  kind?: string;
  key?: string;
  text?: string;
  limit?: number;
}

export interface MemoryRepository {
  /** Inserts or updates by (projectId, scope, key); repeated keys increment `hits`. */
  upsert(item: NewMemory): Promise<MemoryItem>;
  search(projectId: string, query: MemoryQuery): Promise<MemoryItem[]>;
}

export type NewApproval = Pick<Approval, 'projectId' | 'taskId' | 'runId' | 'action' | 'reason' | 'risk' | 'details'> &
  Partial<Pick<Approval, 'mode' | 'sessionId' | 'expiresAt'>>;

export interface ApprovalRepository {
  create(approval: NewApproval): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  list(filter: { projectId?: string; status?: ApprovalStatus; sessionId?: string; limit?: number }): Promise<Approval[]>;
  /** Only pending approvals can be decided; returns null if it was already decided. */
  decide(id: string, status: 'approved' | 'rejected' | 'expired', decidedBy: string, comment: string | null): Promise<Approval | null>;
}

export interface UsageRepository {
  record(entry: UsageEntry): Promise<void>;
  totalCostSince(since: Date, projectId?: string): Promise<number>;
}

export type EmitEvent<T extends EventType = EventType> = Omit<DomainEvent<T>, 'id' | 'createdAt'>;

export interface EventRecorder {
  /** Persists the event, then publishes it on the bus. */
  emit<T extends EventType>(event: EmitEvent<T>): Promise<void>;
}

export interface EnqueueJob {
  type: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  /** At most one queued/running job per dedupe key. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobQueue {
  enqueue(job: EnqueueJob): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
