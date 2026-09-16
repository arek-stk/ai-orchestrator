import type { AgentRole, RunStage, StageStatus } from '../domain/enums';
import type { GatedAction } from '../domain/project';
import type { MessageAuthorType, MessageIntent } from '../room/types';

/** Typed payloads for every domain event (spec §20). */
export interface EventPayloads {
  'project.created': { name: string };
  'project.updated': { fields: string[] };
  'project.blocked': { reason: string };
  'task.created': { title: string };
  'task.started': { runId: string };
  'task.completed': { runId: string; outcome: string };
  'task.blocked': { reason: string; analysis?: string };
  'task.failed': { reason: string };
  'pipeline.stage.started': { stage: RunStage };
  'pipeline.stage.completed': { stage: RunStage; status: StageStatus; summary?: string };
  'agent.started': { agentRunId: string; role: AgentRole; modelId: string };
  'agent.completed': { agentRunId: string; role: AgentRole; modelId: string; costUsd: number; tokens: number; confidence: number | null; cached?: boolean; savedUsd?: number };
  'agent.failed': { agentRunId: string; role: AgentRole; modelId: string | null; error: string };
  'test.passed': { summary: string };
  'test.failed': { summary: string; fingerprint: string };
  'review.requested': { stage: RunStage };
  'review.completed': { verdict: string; issues: number };
  'decision.made': { decisionId: string; question: string; confidence: number };
  'github.branch.created': { branch: string };
  'github.push': { branch: string; sha: string };
  'github.pr.created': { number: number; url: string };
  'ci.started': { sha: string };
  'ci.passed': { sha: string };
  'ci.failed': { sha: string; classification: string };
  'deployment.started': { workflow: string };
  'deployment.completed': { workflow: string; conclusion: string };
  'approval.required': { approvalId: string; action: GatedAction | 'publish_changes'; risk: string; reason: string; mode?: 'blocking' | 'deferred' };
  'approval.decided': { approvalId: string; status: 'approved' | 'rejected' | 'expired'; by: string };
  'budget.exhausted': { scope: string; reason: string };
  'scheduler.tick': { selected: number; skipped: number };
  'project.health_scan.requested': { scanId: string; trigger: 'manual' | 'scheduled' };
  'project.health_scanned': { scanId: string; healthScore: number; previousScore: number | null; proposalsCreated: number; autoAccepted: number; costUsd: number };
  'project.health_scan.failed': { scanId: string; error: string };
  'improvement.proposed': { proposalId: string; title: string; category: string; priority: number };
  'improvement.accepted': { proposalId: string; taskId: string; auto: boolean; by: string };
  'improvement.dismissed': { proposalId: string; by: string; reason: string | null };
  'release.readiness': { verdict: 'ready' | 'not_ready'; blockers: string[] };
  'research.completed': { memoryKey: string; question: string; confidence: number };
  /** Content-free: clients load the message through the room API (ADR-030). */
  'room.message': { conversationId: string; messageId: string; seq: number; threadId: string | null; authorType: MessageAuthorType; authorName: string; intent: MessageIntent };
  // Autopilot (away mode). Session events are emitted once per project in scope so per-project ACLs apply.
  'autopilot.session.started': { sessionId: string; endsAt: string; budgetUsd: number; effectiveAutonomy: number; demo: boolean };
  'autopilot.session.resumed': { sessionId: string; reason: string };
  'autopilot.session.stopped': { sessionId: string; reason: string; detail: string; by: string };
  'autopilot.session.killed': { sessionId: string; reason: string; detail: string; by: string; pausedRuns: number };
  'autopilot.run.started': { sessionId: string; effectiveAutonomy: number; baseAutonomy: number };
  'autopilot.run.parked': { sessionId: string; approvalId: string; action: string; reason: string; expiresAt: string | null };
  'autopilot.run.unparked': { sessionId: string | null; approvalId: string; status: 'approved' | 'rejected' | 'expired' };
  // Workflows (ADR-037). Content-free: clients load definitions, steps and artifacts through the workflow API.
  'workflow.saved': { workflowId: string; version: number; status: string };
  'workflow.deleted': { workflowId: string };
  'workflow.run.created': { workflowRunId: string; workflowId: string; status: string; mode: 'live' | 'demo' };
  'workflow.run.started': { workflowRunId: string; workflowId: string; mode: 'live' | 'demo' };
  'workflow.step.updated': { workflowRunId: string; workflowId: string; nodeId: string; status: string };
  'workflow.run.finished': { workflowRunId: string; workflowId: string; status: string; costUsd: number; tokens: number };
}

export type EventType = keyof EventPayloads;

export interface DomainEvent<T extends EventType = EventType> {
  id?: string;
  type: T;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  payload: EventPayloads[T];
  createdAt: Date;
}

export type AnyDomainEvent = { [K in EventType]: DomainEvent<K> }[EventType];
