import { z } from 'zod';
import { AGENT_ROLES } from '../domain/enums';
import { TOOL_NAMES } from '../tools/tool-router';

// Workflows (docs/plans/workflows.md, ADR-037): a versioned DAG of goal, orchestrator, agent and join/finale nodes per
// project. Definitions are data edited by humans; everything in them is untrusted when it reaches a model.

export const WORKFLOW_SCHEMA_VERSION = 1;

/** Hard bounds; the API, the runner and the UI all use these. */
export const WORKFLOW_LIMITS = Object.freeze({
  maxNodes: 40,
  maxEdges: 120,
  nameLength: 80,
  descriptionLength: 300,
  labelLength: 60,
  nodeDescriptionLength: 300,
  instructionsLength: 4000,
  maxTags: 6,
  tagLength: 24,
  minTemperature: 0,
  maxTemperature: 2,
  minMaxTokens: 256,
  maxMaxTokens: 16_000,
  artifactNameLength: 120,
  /** Canvas coordinates. */
  coordinate: 100_000,
  maxParallel: 4,
  defaultParallel: 3,
  defaultMaxCostUsd: 2,
  maxCostUsd: 50,
  defaultMaxDurationMinutes: 20,
  maxDurationMinutes: 120,
  /** Upstream output passed to a node: per upstream and in total (characters). */
  upstreamChars: 12_000,
  upstreamTotalChars: 40_000,
  artifactChars: 100_000,
});

export const WORKFLOW_NODE_TYPES = ['goal', 'orchestrator', 'agent', 'join', 'finale'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_OUTPUT_FORMATS = ['markdown', 'text', 'json'] as const;
export type WorkflowOutputFormat = (typeof WORKFLOW_OUTPUT_FORMATS)[number];

export const WORKFLOW_STATUSES = ['active', 'draft', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const NODE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
/** Linear check instead of a regular expression: 1–40 characters of [a-z0-9_-], starting with a letter or digit. */
export function isValidWorkflowId(value: string): boolean {
  if (value.length < 1 || value.length > 40) return false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (!NODE_ID_CHARS.includes(char)) return false;
    if (i === 0 && (char === '_' || char === '-')) return false;
  }
  return true;
}

const NodeId = z.string().refine(isValidWorkflowId, 'ids use 1–40 characters a-z, 0-9, "_" or "-"');
const Coordinate = z.number().finite().min(-WORKFLOW_LIMITS.coordinate).max(WORKFLOW_LIMITS.coordinate);
const Position = z.object({ x: Coordinate, y: Coordinate });
const Label = z.string().trim().min(1).max(WORKFLOW_LIMITS.labelLength);

const BaseNode = { id: NodeId, label: Label, position: Position };

export const WorkflowGoalNodeSchema = z.object({
  ...BaseNode,
  type: z.literal('goal'),
  /** What the whole workflow should achieve. Untrusted text. */
  goal: z.string().max(WORKFLOW_LIMITS.instructionsLength),
});

export const WorkflowOrchestratorNodeSchema = z.object({
  ...BaseNode,
  type: z.literal('orchestrator'),
  description: z.string().max(WORKFLOW_LIMITS.nodeDescriptionLength).default(''),
});

export const WorkflowAgentOutputSettingsSchema = z.object({
  format: z.enum(WORKFLOW_OUTPUT_FORMATS),
  /** Stage 1: the name of the run artifact (a relative, normalised name), never a repository path. */
  artifactName: z.string().trim().max(WORKFLOW_LIMITS.artifactNameLength).default(''),
});

export const WorkflowAgentNodeSchema = z.object({
  ...BaseNode,
  type: z.literal('agent'),
  role: z.enum(AGENT_ROLES),
  /** AI Hub catalog id (WORKFLOW_TOOLS). */
  toolId: z.string().min(1).max(60),
  /** Registry model id; null routes within the tool's available models. */
  model: z.string().min(1).max(200).nullable(),
  temperature: z.number().finite().min(WORKFLOW_LIMITS.minTemperature).max(WORKFLOW_LIMITS.maxTemperature),
  maxTokens: z.number().int().min(WORKFLOW_LIMITS.minMaxTokens).max(WORKFLOW_LIMITS.maxMaxTokens),
  enabledTools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).default([]),
  output: WorkflowAgentOutputSettingsSchema,
  instructions: z.string().max(WORKFLOW_LIMITS.instructionsLength),
  description: z.string().max(WORKFLOW_LIMITS.nodeDescriptionLength).default(''),
  tags: z.array(z.string().trim().min(1).max(WORKFLOW_LIMITS.tagLength)).max(WORKFLOW_LIMITS.maxTags).default([]),
});

export const WorkflowJoinNodeSchema = z.object({
  ...BaseNode,
  type: z.literal('join'),
  description: z.string().max(WORKFLOW_LIMITS.nodeDescriptionLength).default(''),
});

export const WorkflowFinaleNodeSchema = z.object({
  ...BaseNode,
  type: z.literal('finale'),
  description: z.string().max(WORKFLOW_LIMITS.nodeDescriptionLength).default(''),
  output: WorkflowAgentOutputSettingsSchema.default({ format: 'markdown', artifactName: 'ergebnis' }),
});

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  WorkflowGoalNodeSchema,
  WorkflowOrchestratorNodeSchema,
  WorkflowAgentNodeSchema,
  WorkflowJoinNodeSchema,
  WorkflowFinaleNodeSchema,
]);

export const WorkflowEdgeSchema = z.object({ id: NodeId, source: NodeId, target: NodeId });

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  nodes: z.array(WorkflowNodeSchema).max(WORKFLOW_LIMITS.maxNodes),
  edges: z.array(WorkflowEdgeSchema).max(WORKFLOW_LIMITS.maxEdges),
});

export type WorkflowGoalNode = z.infer<typeof WorkflowGoalNodeSchema>;
export type WorkflowOrchestratorNode = z.infer<typeof WorkflowOrchestratorNodeSchema>;
export type WorkflowAgentNode = z.infer<typeof WorkflowAgentNodeSchema>;
export type WorkflowJoinNode = z.infer<typeof WorkflowJoinNodeSchema>;
export type WorkflowFinaleNode = z.infer<typeof WorkflowFinaleNodeSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  version: number;
  definition: WorkflowDefinition;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowVersion {
  workflowId: string;
  version: number;
  name: string;
  definition: WorkflowDefinition;
  createdBy: string | null;
  createdAt: Date;
}

export const WORKFLOW_RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'blocked', 'cancelled'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const ACTIVE_WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = ['queued', 'running'];

export const WORKFLOW_STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'blocked', 'cancelled'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
export const TERMINAL_WORKFLOW_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set(['succeeded', 'failed', 'skipped', 'blocked', 'cancelled']);

export type WorkflowRunMode = 'live' | 'demo';
export type NonExecutablePolicy = 'block' | 'skip';

export interface WorkflowRunLimits {
  maxParallel: number;
  maxCostUsd: number;
  maxDurationMs: number;
}

/** Why an agent node cannot run (see executability.ts). */
export interface WorkflowBlocker {
  nodeId: string;
  label: string;
  code: string;
  message: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  projectId: string;
  workflowVersion: number;
  workflowName: string;
  definition: WorkflowDefinition;
  status: WorkflowRunStatus;
  mode: WorkflowRunMode;
  onNonExecutable: NonExecutablePolicy;
  limits: WorkflowRunLimits;
  sessionId: string | null;
  blockers: WorkflowBlocker[];
  reason: string | null;
  costUsd: number;
  tokens: number;
  startedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface WorkflowStep {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  status: WorkflowStepStatus;
  reason: string | null;
  agentRunId: string | null;
  modelId: string | null;
  provider: string | null;
  costUsd: number;
  tokens: number;
  summary: string | null;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface WorkflowArtifact {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  format: WorkflowOutputFormat;
  content: string;
  size: number;
  createdAt: Date;
}

export type WorkflowArtifactMeta = Omit<WorkflowArtifact, 'content'>;

// ---------------------------------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------------------------------

export interface NewWorkflow {
  projectId: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  createdBy: string | null;
}

export interface WorkflowPatch {
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  definition?: WorkflowDefinition;
}

export interface WorkflowRepository {
  create(input: NewWorkflow): Promise<Workflow>;
  get(id: string): Promise<Workflow | null>;
  list(filter: { projectIds?: readonly string[]; limit: number }): Promise<Workflow[]>;
  /** Saves a new version when `expectedVersion` matches; throws ConcurrentModificationError otherwise. */
  update(id: string, patch: WorkflowPatch, expectedVersion: number, updatedBy: string | null): Promise<Workflow>;
  delete(id: string): Promise<boolean>;
  listVersions(id: string, limit: number): Promise<WorkflowVersion[]>;
}

export type NewWorkflowRun = Omit<WorkflowRun, 'id' | 'createdAt' | 'costUsd' | 'tokens'>;
export type NewWorkflowStep = Pick<WorkflowStep, 'nodeId' | 'nodeType' | 'status' | 'reason'>;
export type WorkflowRunPatch = Partial<Pick<WorkflowRun, 'status' | 'reason' | 'costUsd' | 'tokens' | 'startedAt' | 'finishedAt' | 'blockers'>>;
export type WorkflowStepPatch = Partial<Omit<WorkflowStep, 'id' | 'runId' | 'nodeId' | 'nodeType'>>;

export interface WorkflowRunRepository {
  create(run: NewWorkflowRun, steps: readonly NewWorkflowStep[]): Promise<WorkflowRun>;
  get(id: string): Promise<WorkflowRun | null>;
  list(filter: { workflowId?: string; projectId?: string; sessionId?: string; statuses?: readonly WorkflowRunStatus[]; limit: number }): Promise<WorkflowRun[]>;
  /** Applies the patch only while the run is in one of `onlyIf` (when given); returns the updated run or null. */
  update(id: string, patch: WorkflowRunPatch, onlyIf?: readonly WorkflowRunStatus[]): Promise<WorkflowRun | null>;
  listSteps(runId: string): Promise<WorkflowStep[]>;
  updateStep(runId: string, nodeId: string, patch: WorkflowStepPatch): Promise<WorkflowStep>;
  addArtifact(artifact: Omit<WorkflowArtifact, 'id' | 'createdAt' | 'size'>): Promise<WorkflowArtifactMeta>;
  listArtifacts(runId: string): Promise<WorkflowArtifactMeta[]>;
  getArtifact(runId: string, artifactId: string): Promise<WorkflowArtifact | null>;
  /** Cost of all workflow runs attached to an autopilot session. */
  sessionCostUsd(sessionId: string): Promise<number>;
}
