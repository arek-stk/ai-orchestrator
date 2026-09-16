import { z } from 'zod';
import {
  COMPLEXITIES,
  RISKS,
  TASK_KINDS,
  type Complexity,
  type Risk,
  type TaskKind,
  type TaskStatus,
} from './enums';

/** Task contract (spec §27) plus the bookkeeping fields the orchestrator needs. */
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
  readySince: Date | null;
  // Planning fields (ADR-030 stage 2): the board, milestones and roadmap are views over tasks.
  /** Who owns the work. The scheduler only starts tasks owned by the orchestrator. */
  assigneeType: AssigneeType;
  /** User id (or AI identity id, stage 3) for non-orchestrator assignees. */
  assigneeId: string | null;
  milestoneId: string | null;
  /** Order within the board column (ascending); null = default order (priority, age). */
  boardPosition: number | null;
  estimatePoints: EstimatePoints | null;
  labels: string[];
  /** Calendar date `YYYY-MM-DD`. */
  dueDate: string | null;
  /** Held tasks are never picked by the scheduler or the autopilot; only a human releases them. */
  schedulingHold: boolean;
  holdReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ASSIGNEE_TYPES = ['orchestrator', 'user', 'external_ai'] as const;
export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];

export const ESTIMATE_POINTS = [1, 2, 3, 5, 8, 13] as const;
export type EstimatePoints = (typeof ESTIMATE_POINTS)[number];

/** Planning fields that can be set when a task is created (defaults: orchestrator-owned, no milestone, not held). */
export type TaskPlanningFields = Pick<
  Task,
  'assigneeType' | 'assigneeId' | 'milestoneId' | 'boardPosition' | 'estimatePoints' | 'labels' | 'dueDate' | 'schedulingHold' | 'holdReason'
>;

export const DEFAULT_TASK_PLANNING: Readonly<TaskPlanningFields> = Object.freeze({
  assigneeType: 'orchestrator',
  assigneeId: null,
  milestoneId: null,
  boardPosition: null,
  estimatePoints: null,
  labels: [],
  dueDate: null,
  schedulingHold: false,
  holdReason: null,
});

/** Options for creating a task: planning fields and the initial status (default READY). */
export type NewTaskOptions = Partial<TaskPlanningFields> & { status?: 'BACKLOG' | 'READY' };

export const TaskInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  goal: z.string().trim().min(3).max(5000),
  kind: z.enum(TASK_KINDS).default('feature'),
  priority: z.number().int().min(1).max(10).default(5),
  dependencies: z.array(z.string().min(1)).max(50).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  risk: z.enum(RISKS).default('medium'),
  estimatedComplexity: z.enum(COMPLEXITIES).default('medium'),
  tokenBudget: z.number().int().positive().max(50_000_000).default(600_000),
  maxCost: z.number().positive().max(10_000).default(5),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  parentId: z.string().nullable().default(null),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
