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
  'approval.required': { approvalId: string; action: GatedAction | 'publish_changes'; risk: string; reason: string };
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
