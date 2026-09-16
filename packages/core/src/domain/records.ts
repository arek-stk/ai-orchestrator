import type { AgentRole, Risk } from './enums';
import type { GatedAction } from './project';
import type { TokenUsage } from '../models/types';

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
  startedAt: Date;
  finishedAt: Date | null;
  /** Served from the agent output cache. */
  cacheHit?: boolean;
}

export interface AgentRunResult {
  status: Exclude<AgentRunStatus, 'running'>;
  output: unknown;
  confidence: number | null;
  usage: TokenUsage;
  costUsd: number;
  toolsUsed: string[];
  durationMs: number;
  error: string | null;
  modelConfigId: string | null;
  provider: string | null;
  modelId: string | null;
  /** The output was served from the agent output cache (no model call). */
  cacheHit?: boolean;
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

/**
 * Who settled a decision. `pipeline`: the DESIGN council outside sessions. `autopilot_*`: the decision ladder of an
 * autopilot session (precedent, research or council v2). `human`: a person answered a parked question.
 */
export const DECISION_ORIGINS = ['pipeline', 'autopilot_precedent', 'autopilot_research', 'autopilot_council', 'human'] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

/**
 * `active`: a normal decision. `provisional`: settled by the autopilot while nobody was watching; a human confirms or
 * rejects it in the return digest. Rejected decisions are never reused.
 */
export const DECISION_STATUSES = ['active', 'provisional', 'confirmed', 'rejected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Provenance of a decision; defaults apply to pipeline decisions created outside autopilot sessions. */
export interface DecisionProvenance {
  origin: DecisionOrigin;
  status: DecisionStatus;
  sessionId: string | null;
  /** Decision request (ladder) that produced it. */
  requestId: string | null;
  councilId: string | null;
  /** Accepted ADRs the rationale relies on, e.g. "ADR-034". */
  adrRefs: string[];
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
}

export const DEFAULT_DECISION_PROVENANCE: Readonly<DecisionProvenance> = Object.freeze({
  origin: 'pipeline',
  status: 'active',
  sessionId: null,
  requestId: null,
  councilId: null,
  adrRefs: [],
  reviewedBy: null,
  reviewedAt: null,
  reviewComment: null,
});

/** Decision Memory entry (spec §10, §22). Only the orchestrator writes these. */
export interface Decision extends DecisionProvenance {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  question: string;
  /** Normalised hash of the question used to reuse earlier decisions instead of re-consulting. */
  questionKey: string;
  options: DecisionOption[];
  consulted: ConsultedAgent[];
  evidence: string[];
  decision: string;
  chosenOptionId: string | null;
  reason: string;
  confidence: number;
  costUsd: number;
  supersedesId: string | null;
  createdAt: Date;
}

export type MemoryScope = 'project' | 'task' | 'failure';

export interface MemoryItem {
  id: string;
  projectId: string;
  scope: MemoryScope;
  taskId: string | null;
  kind: string;
  key: string;
  content: string;
  tags: string[];
  hits: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalAction = GatedAction | 'publish_changes';
/**
 * blocking: the run waits in WAITING and holds its slot (ADR-023 expiry).
 * deferred: requested inside an autopilot session; the run is PARKED without a slot and the approval expires only
 * after the session ends plus a grace period, capped by a hard maximum.
 */
export type ApprovalMode = 'blocking' | 'deferred';

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
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  comment: string | null;
  mode: ApprovalMode;
  /** Autopilot session the approval was deferred in. */
  sessionId: string | null;
  /** Explicit expiry (deferred approvals); null = requestedAt + APPROVAL_TTL_HOURS. */
  expiresAt: Date | null;
}

export interface UsageEntry {
  projectId: string | null;
  taskId: string | null;
  agentRunId: string | null;
  provider: string;
  modelId: string;
  usage: TokenUsage;
  costUsd: number;
  /** Cache hit: costUsd is 0 and savedUsd is the cost of the original call. */
  cacheHit?: boolean;
  savedUsd?: number;
}
