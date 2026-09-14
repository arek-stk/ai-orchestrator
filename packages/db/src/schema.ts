import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  AgentRole,
  AgentRunStatus,
  ApprovalAction,
  ApprovalStatus,
  AutonomyLevel,
  Complexity,
  ConsultedAgent,
  DecisionOption,
  LatencyClass,
  MemoryScope,
  ModelCapabilities,
  ModelTier,
  ProjectProfile,
  ProjectSettings,
  ProjectStatus,
  ProviderKind,
  Risk,
  RunCheckpoint,
  RunStage,
  RunStatus,
  StageState,
  StagePlanItem,
  StopConditions,
  TaskKind,
  TaskStatus,
  UserRole,
} from '@orch/core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const emptyArray = sql`'[]'::jsonb`;
const emptyObject = sql`'{}'::jsonb`;

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  githubId: bigint('github_id', { mode: 'number' }).unique(),
  login: text('login').notNull().unique(),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  role: text('role').$type<UserRole>().notNull().default('viewer'),
  createdAt: createdAt(),
  lastLoginAt: ts('last_login_at'),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Projects & tasks
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    repoOwner: text('repo_owner'),
    repoName: text('repo_name'),
    defaultBranch: text('default_branch'),
    status: text('status').$type<ProjectStatus>().notNull().default('IDLE'),
    priority: integer('priority').notNull().default(5),
    autonomyLevel: integer('autonomy_level').$type<AutonomyLevel>().notNull().default(1),
    healthScore: real('health_score').notNull().default(100),
    budgetUsd: doublePrecision('budget_usd').notNull().default(50),
    spentUsd: doublePrecision('spent_usd').notNull().default(0),
    tokensUsed: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    profile: jsonb('profile').$type<ProjectProfile>().notNull(),
    settings: jsonb('settings').$type<ProjectSettings>().notNull(),
    lastScheduledAt: ts('last_scheduled_at'),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_status_idx').on(t.status)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<UserRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    kind: text('kind').$type<TaskKind>().notNull(),
    status: text('status').$type<TaskStatus>().notNull().default('BACKLOG'),
    priority: integer('priority').notNull().default(5),
    dependencies: jsonb('dependencies').$type<string[]>().notNull().default(emptyArray),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default(emptyArray),
    risk: text('risk').$type<Risk>().notNull(),
    estimatedComplexity: text('estimated_complexity').$type<Complexity>().notNull(),
    tokenBudget: bigint('token_budget', { mode: 'number' }).notNull(),
    maxCost: doublePrecision('max_cost').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    attempts: integer('attempts').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tokensUsed: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    branch: text('branch'),
    prNumber: integer('pr_number'),
    blockedReason: text('blocked_reason'),
    readySince: ts('ready_since'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_status_idx').on(t.status),
    index('tasks_parent_idx').on(t.parentId),
  ],
);

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').$type<RunStatus>().notNull().default('QUEUED'),
    currentStage: text('current_stage').$type<RunStage>(),
    stagePlan: jsonb('stage_plan').$type<StagePlanItem[]>().notNull(),
    stageStates: jsonb('stage_states').$type<Partial<Record<RunStage, StageState>>>().notNull().default(emptyObject),
    iterations: integer('iterations').notNull().default(0),
    debugAttempts: integer('debug_attempts').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    limits: jsonb('limits').$type<StopConditions>().notNull(),
    checkpoint: jsonb('checkpoint').$type<RunCheckpoint>().notNull(),
    error: text('error'),
    blockedReason: text('blocked_reason'),
    resumeAt: ts('resume_at'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('runs_project_status_idx').on(t.projectId, t.status),
    index('runs_task_idx').on(t.taskId),
    index('runs_status_idx').on(t.status),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').$type<AgentRole>().notNull(),
    modelConfigId: text('model_config_id'),
    provider: text('provider'),
    modelId: text('model_id'),
    status: text('status').$type<AgentRunStatus>().notNull().default('running'),
    inputSummary: text('input_summary').notNull().default(''),
    output: jsonb('output').$type<unknown>(),
    confidence: real('confidence'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    toolsUsed: jsonb('tools_used').$type<string[]>().notNull().default(emptyArray),
    durationMs: integer('duration_ms'),
    error: text('error'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('agent_runs_project_started_idx').on(t.projectId, t.startedAt),
    index('agent_runs_run_idx').on(t.runId),
    index('agent_runs_status_idx').on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Memory, decisions, approvals
// ---------------------------------------------------------------------------

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    questionKey: text('question_key').notNull(),
    options: jsonb('options').$type<DecisionOption[]>().notNull().default(emptyArray),
    consulted: jsonb('consulted').$type<ConsultedAgent[]>().notNull().default(emptyArray),
    evidence: jsonb('evidence').$type<string[]>().notNull().default(emptyArray),
    decision: text('decision').notNull(),
    chosenOptionId: text('chosen_option_id'),
    reason: text('reason').notNull(),
    confidence: real('confidence').notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    supersedesId: text('supersedes_id'),
    createdAt: createdAt(),
  },
  (t) => [index('decisions_project_key_idx').on(t.projectId, t.questionKey), index('decisions_task_idx').on(t.taskId)],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<MemoryScope>().notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    content: text('content').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default(emptyArray),
    hits: integer('hits').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('memories_project_scope_key_uq').on(t.projectId, t.scope, t.key)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    action: text('action').$type<ApprovalAction>().notNull(),
    reason: text('reason').notNull(),
    risk: text('risk').$type<Risk>().notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(emptyObject),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    comment: text('comment'),
  },
  (t) => [index('approvals_status_idx').on(t.status), index('approvals_project_status_idx').on(t.projectId, t.status)],
);

// ---------------------------------------------------------------------------
// Events, jobs, usage, audit
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    projectId: text('project_id'),
    taskId: text('task_id'),
    runId: text('run_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('events_project_id_idx').on(t.projectId, t.id), index('events_created_idx').on(t.createdAt)],
);

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    runAt: ts('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedBy: text('locked_by'),
    lockedUntil: ts('locked_until'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_active_uq')
      .on(t.dedupeKey)
      .where(sql`status in ('queued', 'running')`),
  ],
);

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id'),
    taskId: text('task_id'),
    agentRunId: text('agent_run_id'),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('usage_created_idx').on(t.createdAt), index('usage_project_created_idx').on(t.projectId, t.createdAt)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: text('actor_type').$type<'user' | 'agent' | 'system'>().notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(emptyObject),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt), index('audit_actor_idx').on(t.actorId)],
);

// ---------------------------------------------------------------------------
// Model layer (ADR-005)
// ---------------------------------------------------------------------------

export const providerConfigs = pgTable('provider_configs', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<ProviderKind>().notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  /** AES-256-GCM ciphertext (ADR-009). */
  apiKeyEncrypted: text('api_key_encrypted'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const modelConfigs = pgTable('model_configs', {
  id: text('id').primaryKey(),
  provider: text('provider').$type<ProviderKind>().notNull(),
  providerConfigId: text('provider_config_id').references(() => providerConfigs.id, { onDelete: 'set null' }),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  tier: text('tier').$type<ModelTier>().notNull(),
  contextWindow: integer('context_window').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  inputPerMTok: doublePrecision('input_per_mtok').notNull(),
  outputPerMTok: doublePrecision('output_per_mtok').notNull(),
  cacheReadPerMTok: doublePrecision('cache_read_per_mtok'),
  cacheWritePerMTok: doublePrecision('cache_write_per_mtok'),
  latency: text('latency').$type<LatencyClass>().notNull(),
  codingScore: real('coding_score').notNull(),
  reasoningScore: real('reasoning_score').notNull(),
  capabilities: jsonb('capabilities').$type<ModelCapabilities>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Context optimisation & integrations
// ---------------------------------------------------------------------------

export const repoFiles = pgTable(
  'repo_files',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha: text('sha').notNull(),
    size: integer('size').notNull(),
    language: text('language'),
    summary: text('summary'),
    /** Blob SHA the summary was produced for; summary is stale when it differs from `sha`. */
    summarySha: text('summary_sha'),
    symbols: jsonb('symbols').$type<string[]>().notNull().default(emptyArray),
    imports: jsonb('imports').$type<string[]>().notNull().default(emptyArray),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

export const cacheEntries = pgTable(
  'cache_entries',
  {
    key: text('key').primaryKey(),
    projectId: text('project_id'),
    kind: text('kind').notNull(),
    contentHash: text('content_hash').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('cache_expires_idx').on(t.expiresAt), index('cache_project_kind_idx').on(t.projectId, t.kind)],
);

export const ciRuns = pgTable(
  'ci_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    prNumber: integer('pr_number'),
    sha: text('sha').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    classification: text('classification'),
    reason: text('reason'),
    url: text('url'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ci_runs_project_created_idx').on(t.projectId, t.createdAt), index('ci_runs_sha_idx').on(t.sha)],
);
