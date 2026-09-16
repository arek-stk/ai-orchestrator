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
  ApprovalMode,
  ApprovalStatus,
  AutonomyLevel,
  AutopilotSessionStatus,
  AutopilotStopPolicy,
  AutopilotStopReason,
  QuietHours,
  Complexity,
  ConsultedAgent,
  ConversationKind,
  ConversationStatus,
  DecisionOption,
  Effort,
  HealthBreakdownItem,
  HealthScanStatus,
  HealthScanTrigger,
  HealthSignals,
  Impact,
  ImprovementCategory,
  LatencyClass,
  MessageAuthorType,
  MessageIntent,
  MessageRefs,
  ProposalSource,
  ProposalStatus,
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
  CouncilDecisionType,
  CouncilDiversity,
  CouncilOption,
  CouncilParkReason,
  CouncilParticipant,
  CouncilStatus,
  CouncilTurnKind,
  CouncilTurnRecord,
  DecisionNature,
  DecisionOrigin,
  DecisionRequestKind,
  DecisionRequestStatus,
  DecisionStatus,
  LadderAdvisory,
  LadderAnswer,
  LadderRung,
  LadderStep,
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
// Autopilot / away mode (docs/plans/autopilot.md, stage 1)
// ---------------------------------------------------------------------------

export const autopilotSessions = pgTable(
  'autopilot_sessions',
  {
    id: text('id').primaryKey(),
    /** User id of the starter (or "system"). */
    startedBy: text('started_by').notNull(),
    status: text('status').$type<AutopilotSessionStatus>().notNull().default('active'),
    /** Projects in scope; authoritative membership (and the one-active-session rule) is in autopilot_session_projects. */
    projectIds: jsonb('project_ids').$type<string[]>().notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    budgetUsd: doublePrecision('budget_usd').notNull(),
    /** Ceiling chosen at start. The effective autonomy is computed per call and never persisted. */
    autonomyCeiling: integer('autonomy_ceiling').$type<AutonomyLevel>().notNull(),
    maxTaskRisk: text('max_task_risk').$type<'low' | 'medium'>().notNull(),
    maxConcurrentRuns: integer('max_concurrent_runs'),
    maxParkedRuns: integer('max_parked_runs').notNull().default(3),
    quietHours: jsonb('quiet_hours').$type<QuietHours>(),
    stopPolicy: jsonb('stop_policy').$type<AutopilotStopPolicy>().notNull(),
    demo: boolean('demo').notNull().default(false),
    stopReason: text('stop_reason').$type<AutopilotStopReason>(),
    stopDetail: text('stop_detail'),
    stoppedBy: text('stopped_by'),
    endedAt: ts('ended_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('autopilot_sessions_status_idx').on(t.status, t.createdAt)],
);

export const autopilotSessionProjects = pgTable(
  'autopilot_session_projects',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => autopilotSessions.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.projectId] }),
    // At most one active session per project, atomically across requests and processes.
    uniqueIndex('autopilot_session_projects_active_uq')
      .on(t.projectId)
      .where(sql`status = 'active'`),
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
    /** Autopilot session that started the run (null: started by a human or outside a session). */
    sessionId: text('session_id').references(() => autopilotSessions.id, { onDelete: 'set null' }),
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
    index('runs_session_idx').on(t.sessionId),
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
    cacheHit: boolean('cache_hit').notNull().default(false),
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
    /** pipeline | autopilot_precedent | autopilot_research | autopilot_council | human (autopilot stage 2). */
    origin: text('origin').$type<DecisionOrigin>().notNull().default('pipeline'),
    /** active | provisional (settled while away, waiting for human review) | confirmed | rejected. */
    status: text('status').$type<DecisionStatus>().notNull().default('active'),
    sessionId: text('session_id').references(() => autopilotSessions.id, { onDelete: 'set null' }),
    requestId: text('request_id'),
    councilId: text('council_id'),
    adrRefs: jsonb('adr_refs').$type<string[]>().notNull().default(emptyArray),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    reviewComment: text('review_comment'),
    createdAt: createdAt(),
  },
  (t) => [
    index('decisions_project_key_idx').on(t.projectId, t.questionKey),
    index('decisions_task_idx').on(t.taskId),
    index('decisions_session_idx').on(t.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Autopilot decision ladder and council protocol v2 (docs/plans/autopilot.md §9.1)
// ---------------------------------------------------------------------------

export const decisionRequests = pgTable(
  'decision_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => autopilotSessions.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    kind: text('kind').$type<DecisionRequestKind>().notNull(),
    nature: text('nature').$type<DecisionNature>().notNull(),
    question: text('question').notNull(),
    options: jsonb('options').$type<CouncilOption[]>().notNull().default(emptyArray),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').$type<DecisionRequestStatus>().notNull().default('open'),
    rung: text('rung').$type<LadderRung>(),
    trail: jsonb('trail').$type<LadderStep[]>().notNull().default(emptyArray),
    answer: jsonb('answer').$type<LadderAnswer>(),
    parkReason: text('park_reason'),
    advisory: jsonb('advisory').$type<LadderAdvisory>(),
    decisionId: text('decision_id').references(() => decisions.id, { onDelete: 'set null' }),
    approvalId: text('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    councilId: text('council_id'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    // Identical questions from several runs resolve once (dedupe while open or resolving).
    uniqueIndex('decision_requests_open_fingerprint_uq')
      .on(t.projectId, t.fingerprint)
      .where(sql`status in ('open', 'resolving')`),
    index('decision_requests_session_idx').on(t.sessionId, t.createdAt),
    index('decision_requests_project_status_idx').on(t.projectId, t.status),
  ],
);

export const councilSessions = pgTable(
  'council_sessions',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => decisionRequests.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => autopilotSessions.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => pipelineRuns.id, { onDelete: 'set null' }),
    decisionType: text('decision_type').$type<CouncilDecisionType>().notNull(),
    protocolVersion: integer('protocol_version').notNull(),
    question: text('question').notNull(),
    participants: jsonb('participants').$type<CouncilParticipant[]>().notNull().default(emptyArray),
    diversity: text('diversity').$type<CouncilDiversity>(),
    status: text('status').$type<CouncilStatus>().notNull().default('running'),
    chosenOptionId: text('chosen_option_id'),
    confidence: real('confidence'),
    parkReason: text('park_reason').$type<CouncilParkReason>(),
    roundsUsed: integer('rounds_used').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    deadlineAt: ts('deadline_at').notNull(),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('council_sessions_request_idx').on(t.requestId), index('council_sessions_session_idx').on(t.sessionId)],
);

/** Append-only council transcript; the Project Room thread is a projection of it. */
export const councilTurns = pgTable(
  'council_turns',
  {
    id: text('id').primaryKey(),
    councilId: text('council_id')
      .notNull()
      .references(() => councilSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    round: integer('round').notNull(),
    kind: text('kind').$type<CouncilTurnKind>().notNull(),
    role: text('role').$type<CouncilTurnRecord['role']>().notNull(),
    stance: text('stance').$type<CouncilTurnRecord['stance']>().notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    modelId: text('model_id'),
    provider: text('provider'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('council_turns_council_seq_uq').on(t.councilId, t.seq)],
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
    /** blocking: the run waits in WAITING; deferred: requested in an autopilot session, the run is PARKED. */
    mode: text('mode').$type<ApprovalMode>().notNull().default('blocking'),
    sessionId: text('session_id').references(() => autopilotSessions.id, { onDelete: 'set null' }),
    /** Explicit expiry (deferred approvals). null: requested_at + APPROVAL_TTL_HOURS (ADR-023). */
    expiresAt: ts('expires_at'),
  },
  (t) => [
    index('approvals_status_idx').on(t.status),
    index('approvals_project_status_idx').on(t.projectId, t.status),
    index('approvals_session_idx').on(t.sessionId),
  ],
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
    /** Served from the agent output cache: cost_usd is 0, saved_usd is what the original call cost. */
    cacheHit: boolean('cache_hit').notNull().default(false),
    savedUsd: doublePrecision('saved_usd').notNull().default(0),
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
    hits: integer('hits').notNull().default(0),
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

// ---------------------------------------------------------------------------
// Autonomous product improvement (spec §14)
// ---------------------------------------------------------------------------

export const healthScans = pgTable(
  'health_scans',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').$type<HealthScanStatus>().notNull().default('queued'),
    trigger: text('trigger').$type<HealthScanTrigger>().notNull(),
    requestedBy: text('requested_by'),
    healthScore: real('health_score'),
    previousScore: real('previous_score'),
    breakdown: jsonb('breakdown').$type<HealthBreakdownItem[]>().notNull().default(emptyArray),
    signals: jsonb('signals').$type<HealthSignals>(),
    proposalsCreated: integer('proposals_created').notNull().default(0),
    proposalsSeen: integer('proposals_seen').notNull().default(0),
    autoAccepted: integer('auto_accepted').notNull().default(0),
    agentStatus: text('agent_status'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    summary: text('summary'),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('health_scans_project_created_idx').on(t.projectId, t.createdAt),
    index('health_scans_status_idx').on(t.status),
    // At most one queued or running scan per project, so concurrent requests cannot create an orphaned scan.
    uniqueIndex('health_scans_project_active_uq')
      .on(t.projectId)
      .where(sql`status in ('queued', 'running')`),
  ],
);

export const improvementProposals = pgTable(
  'improvement_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scanId: text('scan_id').references(() => healthScans.id, { onDelete: 'set null' }),
    fingerprint: text('fingerprint').notNull(),
    category: text('category').$type<ImprovementCategory>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    rationale: text('rationale').notNull().default(''),
    evidence: jsonb('evidence').$type<string[]>().notNull().default(emptyArray),
    affectedPaths: jsonb('affected_paths').$type<string[]>().notNull().default(emptyArray),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default(emptyArray),
    impact: text('impact').$type<Impact>().notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    risk: text('risk').$type<Risk>().notNull(),
    roiScore: real('roi_score').notNull(),
    priority: integer('priority').notNull(),
    source: text('source').$type<ProposalSource>().notNull(),
    status: text('status').$type<ProposalStatus>().notNull().default('proposed'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    autoAccepted: boolean('auto_accepted').notNull().default(false),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    dismissReason: text('dismiss_reason'),
    occurrences: integer('occurrences').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('improvement_proposals_project_fingerprint_uq').on(t.projectId, t.fingerprint),
    index('improvement_proposals_project_status_idx').on(t.projectId, t.status, t.priority),
  ],
);

// ---------------------------------------------------------------------------
// Conversations: Project Room and later planning, explain and council threads (ADR-030 addendum)
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ConversationKind>().notNull(),
    title: text('title').notNull().default(''),
    status: text('status').$type<ConversationStatus>().notNull().default('active'),
    createdBy: text('created_by'),
    messageCount: integer('message_count').notNull().default(0),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Exactly one room per project, also under concurrent first use.
    uniqueIndex('conversations_project_room_uq')
      .on(t.projectId)
      .where(sql`kind = 'room'`),
    index('conversations_project_kind_activity_idx').on(t.projectId, t.kind, t.lastActivityAt),
  ],
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    /** Insertion order across all conversations; the pagination cursor. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Denormalised for access control and event filters. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references((): AnyPgColumn => conversationMessages.id, { onDelete: 'cascade' }),
    authorType: text('author_type').$type<MessageAuthorType>().notNull(),
    authorId: text('author_id'),
    authorName: text('author_name').notNull(),
    intent: text('intent').$type<MessageIntent>().notNull().default('message'),
    body: text('body').notNull(),
    refs: jsonb('refs').$type<MessageRefs>().notNull().default(emptyObject),
    dedupeKey: text('dedupe_key'),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: ts('last_reply_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('conversation_messages_seq_uq').on(t.seq),
    // Top-level timeline of a conversation, paged by seq.
    index('conversation_messages_top_level_idx')
      .on(t.conversationId, t.seq)
      .where(sql`thread_id is null`),
    index('conversation_messages_thread_idx').on(t.threadId, t.seq),
    index('conversation_messages_project_created_idx').on(t.projectId, t.createdAt),
    uniqueIndex('conversation_messages_dedupe_uq')
      .on(t.conversationId, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
  ],
);
