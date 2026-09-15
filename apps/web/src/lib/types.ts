// Web-local mirrors of the API response shapes (apps/server/src/routes.ts, packages/core/src/domain).
// Dates arrive as ISO strings over JSON.

export type ISODate = string;

export const USER_ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PROJECT_STATUSES = [
  'IDLE', 'PLANNING', 'ANALYZING', 'BUILDING', 'TESTING', 'REVIEWING', 'DEBUGGING', 'WAITING', 'BLOCKED', 'PAUSED', 'READY_FOR_RELEASE', 'DEPLOYED', 'FAILED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = ['BACKLOG', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_CHILDREN', 'PAUSED', 'BLOCKED', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STAGES = ['INTAKE', 'ANALYZE', 'PLAN', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'SECURITY', 'VERIFY', 'COMMIT', 'PUSH', 'PR', 'CI', 'DEPLOY', 'MONITOR'] as const;
export type Stage = (typeof STAGES)[number];
export type RunStage = Stage | 'DEBUG';
export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'waiting';

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AGENT_ROLES = [
  'orchestrator', 'project_analyst', 'planner', 'architect', 'builder', 'frontend', 'backend', 'database', 'security', 'tester', 'debugger', 'reviewer', 'researcher', 'documentation', 'devops', 'release',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AUTONOMY_LABELS: Record<number, string> = {
  0: 'Observe',
  1: 'Suggest',
  2: 'Execute',
  3: 'Autonomous Development',
  4: 'Autonomous Delivery',
};

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
export const COMPLEXITIES = ['simple', 'medium', 'complex'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];
export const TASK_KINDS = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'security', 'improvement'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const GATED_ACTIONS = [
  'production_deploy', 'database_migration', 'destructive_data', 'architecture_change', 'secrets_permissions', 'high_cost', 'external_service', 'critical_infrastructure', 'dependency_addition',
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];
/** Gates that cannot be switched off in the project settings (ADR-031). */
export const HARD_GATED_ACTIONS: readonly GatedAction[] = ['dependency_addition'];

export const EDITABLE_PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
export type ProviderKind = (typeof EDITABLE_PROVIDER_KINDS)[number] | 'mock';
export const MODEL_TIERS = ['fast', 'balanced', 'reasoning'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
}

export interface AuthMe {
  user: SessionUser | null;
  methods: { github: boolean; dev: boolean };
}

export interface UserInfo {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  lastLoginAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Projects & tasks
// ---------------------------------------------------------------------------

export interface RepoRef {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface StopConditions {
  maxIterations: number;
  maxCostUsd: number;
  maxTokens: number;
  maxRuntimeMs: number;
  maxDebugAttempts: number;
}

export interface CouncilSettings {
  maxRounds: number;
  confidenceThreshold: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ProjectSettings {
  stopConditions: StopConditions;
  council: CouncilSettings;
  approvalGates: Record<GatedAction, boolean>;
  highCostThresholdUsd: number;
  maxConcurrentTasks: number;
  modelOverrides: Partial<Record<AgentRole, string>>;
}

export interface ProjectProfile {
  languages: string[];
  checks: Record<string, boolean>;
  commands: Record<string, string>;
  hasCi: boolean;
  deployWorkflow: string | null;
  criticalPaths: string[];
  protectedBranches: string[];
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  repo: RepoRef | null;
  status: ProjectStatus;
  priority: number;
  autonomyLevel: number;
  healthScore: number;
  budgetUsd: number;
  spentUsd: number;
  tokensUsed: number;
  profile: ProjectProfile;
  settings: ProjectSettings;
  lastScheduledAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  autonomyLabel?: string;
}

export interface ActiveRunRef {
  id: string;
  taskId: string;
  status: RunStatus;
  currentStage: RunStage | null;
}

export interface ProjectListItem extends Project {
  autonomyLabel: string;
  openTasks: number;
  activeRuns: ActiveRunRef[];
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  goal: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  acceptanceCriteria: string[];
  risk: Risk;
  estimatedComplexity: Complexity;
  tokenBudget: number;
  maxCost: number;
  maxAttempts: number;
  attempts: number;
  costUsd: number;
  tokensUsed: number;
  branch: string | null;
  prNumber: number | null;
  blockedReason: string | null;
  readySince: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface CostSummary {
  costUsd: number;
  tokens: number;
  calls: number;
}

export interface ProjectDetailResponse {
  project: Project & { autonomyLabel: string };
  tasks: Task[];
  runs: PipelineRun[];
  decisions: Decision[];
  approvals: Approval[];
  costs30d: CostSummary;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface StagePlanItem {
  stage: Stage;
  run: boolean;
  reason: string;
}

export interface StageState {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  attempts: number;
}

export interface FileChange {
  path: string;
  action: 'create' | 'update' | 'delete';
  content?: string;
  rationale?: string;
}

export interface VerificationReport {
  status: 'passed' | 'failed' | 'deferred' | 'skipped';
  source: 'sandbox' | 'ci' | 'none';
  summary: string;
  fingerprint?: string;
  output?: string;
}

export interface FailureRecord {
  stage: RunStage;
  summary: string;
  fingerprint: string;
  output: string;
  at: string;
}

export interface RunCheckpoint {
  outputs: Record<string, unknown>;
  designDecisionId: string | null;
  changeset: FileChange[];
  changesetVersion: number;
  buildComplete: boolean;
  feedback: string[];
  verification: VerificationReport | null;
  failures: FailureRecord[];
  resumeStage: RunStage | null;
  branch: string | null;
  baseSha: string | null;
  pendingCommitSha: string | null;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  ciAttempts: number;
  ciPolls: number;
  deployDispatchedAt: string | null;
  pendingApprovalId: string | null;
  approvedActions: string[];
  notes: string[];
  outcome: string | null;
}

export interface PipelineRun {
  id: string;
  taskId: string;
  projectId: string;
  status: RunStatus;
  currentStage: RunStage | null;
  stagePlan: StagePlanItem[];
  stageStates: Partial<Record<RunStage, StageState>>;
  iterations: number;
  debugAttempts: number;
  costUsd: number;
  tokens: number;
  limits: StopConditions;
  checkpoint: RunCheckpoint;
  error: string | null;
  blockedReason: string | null;
  resumeAt: ISODate | null;
  startedAt: ISODate;
  finishedAt: ISODate | null;
  updatedAt: ISODate;
  version: number;
}

export interface RunDetailResponse {
  run: PipelineRun;
  task: Task | null;
  agentRuns: AgentRun[];
  events: DomainEvent[];
  approvals: Approval[];
  decisions: Decision[];
}

// ---------------------------------------------------------------------------
// Agents, decisions, approvals
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed';

export interface AgentRun {
  id: string;
  runId: string | null;
  taskId: string | null;
  projectId: string;
  role: AgentRole;
  modelConfigId: string | null;
  provider: string | null;
  modelId: string | null;
  status: AgentRunStatus;
  inputSummary: string;
  output: unknown;
  confidence: number | null;
  usage: TokenUsage;
  costUsd: number;
  toolsUsed: string[];
  durationMs: number | null;
  error: string | null;
  startedAt: ISODate;
  finishedAt: ISODate | null;
}

export interface AgentDefinitionInfo {
  key: string;
  role: AgentRole;
  name: string;
  schemaName: string;
  effort: 'low' | 'medium' | 'high';
  expectedOutputTokens: number;
  tools: string[];
}

export interface DecisionOption {
  id: string;
  summary: string;
  pros: string[];
  cons: string[];
}

export interface ConsultedAgent {
  role: AgentRole;
  modelId: string | null;
  position: string;
  optionId: string | null;
  confidence: number;
}

export interface Decision {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  question: string;
  options: DecisionOption[];
  consulted: ConsultedAgent[];
  evidence: string[];
  decision: string;
  chosenOptionId: string | null;
  reason: string;
  confidence: number;
  costUsd: number;
  supersedesId: string | null;
  createdAt: ISODate;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalAction = GatedAction | 'publish_changes';

export interface Approval {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  action: ApprovalAction;
  reason: string;
  risk: Risk;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: ISODate;
  decidedBy: string | null;
  decidedAt: ISODate | null;
  comment: string | null;
  /** Typed findings of a `dependency_addition` approval (ADR-031); null or absent for other actions. */
  dependencies?: DependencyApprovalDetails | null;
}

export type DependencyKind = 'package' | 'github_action' | 'mcp_server' | 'claude_plugin' | 'vscode_extension';

export interface DependencyFinding {
  kind: DependencyKind;
  ecosystem: string;
  name: string;
  version: string | null;
  file: string;
  source: 'manifest' | 'lockfile' | 'config';
  detail: string | null;
  uncertain: boolean;
  reason: string | null;
  risk: 'high' | 'normal';
  registryUrl: string | null;
}

export interface DependencyApprovalDetails {
  fingerprint: string;
  findings: DependencyFinding[];
  totalFindings: number;
  highRisk: boolean;
  paths: string[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'project.created', 'project.updated', 'project.blocked',
  'task.created', 'task.started', 'task.completed', 'task.blocked', 'task.failed',
  'pipeline.stage.started', 'pipeline.stage.completed',
  'agent.started', 'agent.completed', 'agent.failed',
  'test.passed', 'test.failed',
  'review.requested', 'review.completed',
  'decision.made',
  'github.branch.created', 'github.push', 'github.pr.created',
  'ci.started', 'ci.passed', 'ci.failed',
  'deployment.started', 'deployment.completed',
  'approval.required', 'approval.decided',
  'budget.exhausted',
  'scheduler.tick',
  'room.message',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent {
  id?: string;
  type: EventType | (string & {});
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Project Room (conversation model, ADR-030)
// ---------------------------------------------------------------------------

export type MessageAuthorType = 'human' | 'assistant' | 'orchestrator' | 'agent' | 'external_ai' | 'system';
export type MessageIntent =
  | 'message'
  | 'question'
  | 'answer'
  | 'status'
  | 'decision'
  | 'decision_request'
  | 'claim'
  | 'release'
  | 'handoff'
  | 'objection'
  | 'clarifying_question'
  | 'brief_update'
  | 'suggestion';
/** Intents a person may post in stage 1. */
export const HUMAN_MESSAGE_INTENTS = ['message', 'question', 'answer'] as const;
export type HumanMessageIntent = (typeof HUMAN_MESSAGE_INTENTS)[number];
export const MAX_MESSAGE_LENGTH = 8000;

export interface MessageRefs {
  taskId?: string;
  runId?: string;
  decisionId?: string;
  approvalId?: string;
  conversationId?: string;
  stage?: string;
  paths?: string[];
}

export interface Conversation {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  status: string;
  messageCount: number;
  lastActivityAt: ISODate;
  createdAt: ISODate;
}

export interface ConversationMessage {
  id: string;
  seq: number;
  conversationId: string;
  projectId: string | null;
  threadId: string | null;
  authorType: MessageAuthorType;
  authorId: string | null;
  authorName: string;
  intent: MessageIntent;
  body: string;
  refs: MessageRefs;
  replyCount: number;
  lastReplyAt: ISODate | null;
  createdAt: ISODate;
}

export interface RoomMessagesResponse {
  conversation: Conversation;
  messages: ConversationMessage[];
  hasMore: boolean;
}

export interface RoomThreadResponse {
  root: ConversationMessage;
  replies: ConversationMessage[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Dashboard, costs, models, providers, settings
// ---------------------------------------------------------------------------

export interface DashboardResponse {
  projects: { total: number; running: number; blocked: number; byStatus: Record<string, number> };
  tasks: Record<TaskStatus, number>;
  pipelines: { active: number; waiting: number; succeeded7d: number; failed7d: number };
  agents: { active: number; running: AgentRun[] };
  approvals: { pending: number };
  queue: Record<'queued' | 'running' | 'succeeded' | 'dead', number>;
  costs: { todayUsd: number; tokensToday: number; callsToday: number; dailyBudgetUsd: number; budgetUsedPct: number };
  demoMode: boolean;
  recentEvents: DomainEvent[];
}

export interface CostsResponse {
  since: ISODate;
  summary: CostSummary;
  byDay: Array<{ day: string; costUsd: number; tokens: number }>;
  byModel: Array<{ provider: string; modelId: string; costUsd: number; tokens: number; calls: number }>;
  byProject: Array<{ projectId: string | null; costUsd: number; tokens: number }>;
}

export interface ModelConfig {
  id: string;
  provider: ProviderKind;
  providerConfigId: string | null;
  modelId: string;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number | null; cacheWritePerMTok: number | null };
  latency: 'low' | 'medium' | 'high';
  codingScore: number;
  reasoningScore: number;
  capabilities: { structuredOutput: boolean; vision: boolean; tools: boolean; reasoning: boolean };
  enabled: boolean;
}

export interface ModelsResponse {
  demoMode: boolean;
  models: Array<ModelConfig & { available: boolean }>;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  source: 'settings' | 'environment';
}

export interface GlobalSettings {
  globalDailyBudgetUsd: number;
  globalCapacity: number;
  modelOverrides: Partial<Record<AgentRole, string>>;
}

export interface SettingsResponse {
  settings: GlobalSettings;
  autonomyLevels: Record<string, string>;
  taskKinds: TaskKind[];
}

export interface HealthResponse {
  ok: boolean;
  database: string;
  demoMode: boolean;
  github: string;
  sandbox: string;
}
