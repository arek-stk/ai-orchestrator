export const PROJECT_STATUSES = [
  'IDLE',
  'PLANNING',
  'ANALYZING',
  'BUILDING',
  'TESTING',
  'REVIEWING',
  'DEBUGGING',
  'WAITING',
  'BLOCKED',
  'PAUSED',
  'READY_FOR_RELEASE',
  'DEPLOYED',
  'FAILED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = [
  'BACKLOG',
  'READY',
  'RUNNING',
  'WAITING_APPROVAL',
  'WAITING_CHILDREN',
  'PAUSED',
  'BLOCKED',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['DONE', 'FAILED', 'CANCELLED']);

/** Planned pipeline stages, in execution order. */
export const STAGES = [
  'INTAKE',
  'ANALYZE',
  'PLAN',
  'DESIGN',
  'IMPLEMENT',
  'TEST',
  'REVIEW',
  'SECURITY',
  'VERIFY',
  'COMMIT',
  'PUSH',
  'PR',
  'CI',
  'DEPLOY',
  'MONITOR',
] as const;
export type Stage = (typeof STAGES)[number];
/** DEBUG is never planned up front; the orchestrator inserts it after a failure. */
export type RunStage = Stage | 'DEBUG';

export const STAGE_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped', 'waiting'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING',
  'PAUSED',
  /** Waiting for a human decision on a deferred approval (autopilot); holds no concurrency slot. */
  'PARKED',
  'BLOCKED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
/** Runs that still exist for their task: a task with one of these cannot start another run. */
export const NON_TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED', 'PARKED'];
/** Runs that occupy a per-project concurrency slot. PARKED runs wait for a human and free their slot. */
export const SLOT_HOLDING_RUN_STATUSES: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'PAUSED'];

export const AGENT_ROLES = [
  'orchestrator',
  'project_analyst',
  'planner',
  'architect',
  'builder',
  'frontend',
  'backend',
  'database',
  'security',
  'tester',
  'debugger',
  'reviewer',
  'researcher',
  'documentation',
  'devops',
  'release',
  /** Autopilot council critic: raises evidence-backed objections and proposes nothing (docs/plans/autopilot.md §4.2). */
  'critic',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
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

export const USER_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];
