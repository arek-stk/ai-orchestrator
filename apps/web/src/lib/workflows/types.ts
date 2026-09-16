// Workflow API shapes (server: apps/server/src/routes-workflows.ts, core: packages/core/src/workflows). The web app talks
// only to the API, so these mirror the JSON the server returns; validation stays authoritative on the server.

export type AgentRole =
  | 'orchestrator'
  | 'project_analyst'
  | 'planner'
  | 'architect'
  | 'builder'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'security'
  | 'tester'
  | 'debugger'
  | 'reviewer'
  | 'researcher'
  | 'documentation'
  | 'devops'
  | 'release';

export type WorkflowNodeType = 'goal' | 'orchestrator' | 'agent' | 'join' | 'finale';
export type WorkflowOutputFormat = 'markdown' | 'text' | 'json';
export type WorkflowStatus = 'active' | 'draft' | 'archived';

export interface Position {
  x: number;
  y: number;
}

interface BaseNode {
  id: string;
  label: string;
  position: Position;
}

export interface GoalNode extends BaseNode {
  type: 'goal';
  goal: string;
}

export interface OrchestratorNode extends BaseNode {
  type: 'orchestrator';
  description: string;
}

export interface OutputSettings {
  format: WorkflowOutputFormat;
  artifactName: string;
}

export interface AgentNode extends BaseNode {
  type: 'agent';
  role: AgentRole;
  toolId: string;
  model: string | null;
  temperature: number;
  maxTokens: number;
  enabledTools: string[];
  output: OutputSettings;
  instructions: string;
  description: string;
  tags: string[];
}

export interface JoinNode extends BaseNode {
  type: 'join';
  description: string;
}

export interface FinaleNode extends BaseNode {
  type: 'finale';
  description: string;
  output: OutputSettings;
}

export type WorkflowNode = GoalNode | OrchestratorNode | AgentNode | JoinNode | FinaleNode;

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: string | null;
  nodeId: string | null;
  edgeId: string | null;
}

export interface NodeExecutability {
  nodeId: string;
  executable: boolean;
  code: string;
  message: string;
  modelIds: string[];
  demo: boolean;
}

export type WorkflowRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'blocked' | 'cancelled';
export type WorkflowStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'cancelled';

export interface WorkflowBlocker {
  nodeId: string;
  label: string;
  code: string;
  message: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  projectId: string;
  workflowVersion: number;
  workflowName: string;
  status: WorkflowRunStatus;
  mode: 'live' | 'demo';
  onNonExecutable: 'block' | 'skip';
  limits: { maxParallel: number; maxCostUsd: number; maxDurationMs: number };
  sessionId: string | null;
  blockers: WorkflowBlocker[];
  reason: string | null;
  costUsd: number;
  tokens: number;
  startedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowRun extends WorkflowRunSummary {
  definition: WorkflowDefinition;
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
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowArtifactMeta {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  format: WorkflowOutputFormat;
  size: number;
  createdAt: string;
}

export interface WorkflowArtifact extends WorkflowArtifactMeta {
  content: string;
}

export interface LedgerUsage {
  costUsd: number;
  tokens: number;
  calls: number;
  byModel: Array<{ provider: string; modelId: string; costUsd: number; tokens: number; calls: number }>;
}

export interface WorkflowRecord {
  id: string;
  projectId: string;
  projectName: string | null;
  name: string;
  description: string;
  status: WorkflowStatus;
  version: number;
  definition: WorkflowDefinition;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: WorkflowRunSummary | null;
}

export interface WorkflowResponse {
  workflow: WorkflowRecord;
  validation: { valid: boolean; issues: WorkflowIssue[] };
  executability: Record<string, NodeExecutability>;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  steps: WorkflowStep[];
  artifacts: WorkflowArtifactMeta[];
  usage: LedgerUsage | null;
}

export interface WorkflowEventRecord {
  id: number;
  type: string;
  payload: { workflowRunId?: string; nodeId?: string; status?: string; costUsd?: number; tokens?: number; mode?: string };
  createdAt: string;
}

export interface ToolStatus {
  id: string;
  name: string;
  vendor: string;
  integration: 'native' | 'openai-compatible' | 'planned' | 'no-public-api';
  executable: boolean;
  code: string;
  message: string;
  models: Array<{ id: string; label: string }>;
}

export interface ToggleStatus {
  id: 'web_search' | 'file_analysis' | 'image_generation';
  label: string;
  toolName: string | null;
  available: boolean;
  reason: string | null;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}

export interface WorkflowLimits {
  maxNodes: number;
  maxEdges: number;
  nameLength: number;
  descriptionLength: number;
  labelLength: number;
  instructionsLength: number;
  maxTags: number;
  tagLength: number;
  minTemperature: number;
  maxTemperature: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  artifactNameLength: number;
  maxParallel: number;
  defaultParallel: number;
  defaultMaxCostUsd: number;
  maxCostUsd: number;
  defaultMaxDurationMinutes: number;
  maxDurationMinutes: number;
}

export interface WorkflowMeta {
  mode: 'live' | 'demo';
  limits: WorkflowLimits;
  roles: AgentRole[];
  tools: ToolStatus[];
  toggles: ToggleStatus[];
  templates: WorkflowTemplate[];
  outputTargets: { kinds: string[]; note: string };
}
