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
  createdAt: Date;
  updatedAt: Date;
}

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
