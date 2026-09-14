import type { Effort, Impact, ImprovementCategory } from '../agents/schemas';
import type { Risk } from '../domain/enums';

export type HealthScanStatus = 'queued' | 'running' | 'completed' | 'failed';
export type HealthScanTrigger = 'manual' | 'scheduled';
export type ProposalStatus = 'proposed' | 'accepted' | 'dismissed';
export type ProposalSource = 'heuristic' | 'agent' | 'devops';

export interface HealthBreakdownItem {
  component: 'tests' | 'dependencies' | 'failures' | 'runs' | 'blocked' | 'documentation' | 'security' | 'maintainability';
  penalty: number;
  maxPenalty: number;
  detail: string;
}

/** Deterministic facts a scan is based on. Persisted so a score can always be explained. */
export interface HealthSignals {
  files: { total: number; source: number; tests: number; largeModules: string[] };
  untestedModules: Array<{ path: string; importers: number }>;
  docs: { readme: boolean; changelog: boolean; contributing: boolean };
  ci: { workflows: string[]; dockerfiles: string[] };
  sensitiveFiles: string[];
  dependencies: { manifests: string[]; unpinned: Array<{ manifest: string; name: string; range: string }>; total: number };
  failures: Array<{ key: string; summary: string; hits: number }>;
  runs: { total: number; succeeded: number; failed: number; blocked: number };
  blockedTasks: Array<{ id: string; title: string; reason: string | null }>;
}

export interface HealthScan {
  id: string;
  projectId: string;
  status: HealthScanStatus;
  trigger: HealthScanTrigger;
  requestedBy: string | null;
  healthScore: number | null;
  previousScore: number | null;
  breakdown: HealthBreakdownItem[];
  signals: HealthSignals | null;
  proposalsCreated: number;
  proposalsSeen: number;
  autoAccepted: number;
  /** How the model part went: ok, cached, skipped (reason) or failed (reason). */
  agentStatus: string | null;
  costUsd: number;
  summary: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ImprovementProposal {
  id: string;
  projectId: string;
  scanId: string | null;
  /** Stable identity of "the same improvement" across scans (category + normalised title). */
  fingerprint: string;
  category: ImprovementCategory;
  title: string;
  description: string;
  rationale: string;
  evidence: string[];
  affectedPaths: string[];
  acceptanceCriteria: string[];
  impact: Impact;
  effort: Effort;
  risk: Risk;
  roiScore: number;
  priority: number;
  source: ProposalSource;
  status: ProposalStatus;
  taskId: string | null;
  autoAccepted: boolean;
  decidedBy: string | null;
  decidedAt: Date | null;
  dismissReason: string | null;
  occurrences: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewProposal = Pick<
  ImprovementProposal,
  | 'projectId'
  | 'scanId'
  | 'fingerprint'
  | 'category'
  | 'title'
  | 'description'
  | 'rationale'
  | 'evidence'
  | 'affectedPaths'
  | 'acceptanceCriteria'
  | 'impact'
  | 'effort'
  | 'risk'
  | 'roiScore'
  | 'priority'
  | 'source'
>;

export type HealthScanPatch = Partial<
  Pick<
    HealthScan,
    'status' | 'healthScore' | 'previousScore' | 'breakdown' | 'signals' | 'proposalsCreated' | 'proposalsSeen' | 'autoAccepted' | 'agentStatus' | 'costUsd' | 'summary' | 'error' | 'startedAt' | 'finishedAt'
  >
>;

export interface HealthScanRepository {
  /**
   * Creates a queued scan unless the project already has a queued or running one, which is then returned with
   * `created: false`. Must be atomic: concurrent calls for one project create at most one active scan.
   */
  create(input: { projectId: string; trigger: HealthScanTrigger; requestedBy: string | null }): Promise<{ scan: HealthScan; created: boolean }>;
  get(id: string): Promise<HealthScan | null>;
  list(projectId: string, limit?: number): Promise<HealthScan[]>;
  /** A queued or running scan of the project, if any. */
  findActive(projectId: string): Promise<HealthScan | null>;
  update(id: string, patch: HealthScanPatch): Promise<HealthScan>;
}

export interface ProposalFilter {
  projectId?: string;
  statuses?: readonly ProposalStatus[];
  limit?: number;
}

export interface ProposalRepository {
  /**
   * Inserts a new proposal or, for an existing fingerprint, only counts the new occurrence: decided proposals stay
   * decided (a dismissed improvement never comes back). `created` is true for inserts.
   */
  upsert(proposal: NewProposal): Promise<{ proposal: ImprovementProposal; created: boolean }>;
  get(id: string): Promise<ImprovementProposal | null>;
  list(filter: ProposalFilter): Promise<ImprovementProposal[]>;
  /** Only proposals in `proposed` can be decided; returns null when it was already decided. */
  accept(id: string, input: { taskId: string; decidedBy: string; auto: boolean }): Promise<ImprovementProposal | null>;
  dismiss(id: string, input: { decidedBy: string; reason: string | null }): Promise<ImprovementProposal | null>;
}
