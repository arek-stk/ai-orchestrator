import { z } from 'zod';
import { ESTIMATE_POINTS, type Task } from '../domain/task';
import { columnOf, type BoardColumn } from './board';

// Milestones and task planning fields (ADR-030 stage 2). Milestones group tasks over time; progress is derived from the
// tasks, never stored.

export const MILESTONE_STATUSES = ['planned', 'active', 'done'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const MAX_MILESTONES_PER_PROJECT = 100;
export const MAX_LABELS = 10;
export const MAX_LABEL_LENGTH = 40;

/** A real calendar date in `YYYY-MM-DD` form (the pattern is fixed-length, so it cannot backtrack). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const IsoDateSchema = z.string().refine(isIsoDate, { message: 'expected a date as YYYY-MM-DD' });

/** Letters, digits, space and `_ . : / -`; checked per character (no regular expression over the whole label). */
function isLabelCharacter(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char) || ' _.:/-'.includes(char);
}

export const LabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LABEL_LENGTH)
  .refine((label) => [...label].every(isLabelCharacter), { message: 'labels may contain letters, digits, spaces and _ . : / -' });

/** Labels are trimmed, deduplicated case-insensitively and bounded. */
export const LabelsSchema = z
  .array(LabelSchema)
  .max(MAX_LABELS)
  .transform((labels) => {
    const seen = new Set<string>();
    return labels.filter((label) => {
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const EstimatePointsSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]);
/** Compile-time check that the schema and ESTIMATE_POINTS agree. */
export const ESTIMATE_POINT_VALUES: ReadonlyArray<z.infer<typeof EstimatePointsSchema>> = ESTIMATE_POINTS;

const datesInOrder = (value: { startDate?: string | null; dueDate?: string | null }) => !value.startDate || !value.dueDate || value.startDate <= value.dueDate;

export const MilestoneInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(''),
    status: z.enum(MILESTONE_STATUSES).default('planned'),
    startDate: IsoDateSchema.nullable().default(null),
    dueDate: IsoDateSchema.nullable().default(null),
  })
  .refine(datesInOrder, { message: 'the start date must not be after the due date', path: ['dueDate'] });
export type MilestoneInput = z.infer<typeof MilestoneInputSchema>;

export const MilestonePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    status: z.enum(MILESTONE_STATUSES),
    startDate: IsoDateSchema.nullable(),
    dueDate: IsoDateSchema.nullable(),
    position: z.number().finite(),
  })
  .partial();
export type MilestonePatch = z.infer<typeof MilestonePatchSchema>;

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  startDate: string | null;
  dueDate: string | null;
  position: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MilestoneRepository {
  create(projectId: string, input: MilestoneInput & { position: number }, createdBy: string | null): Promise<Milestone>;
  get(id: string): Promise<Milestone | null>;
  /** Ordered by position, then creation. */
  list(projectId: string): Promise<Milestone[]>;
  update(id: string, patch: MilestonePatch): Promise<Milestone>;
  /** Deletes the milestone; its tasks keep existing without a milestone. Returns false when it did not exist. */
  delete(id: string): Promise<boolean>;
}

export interface MilestoneProgress {
  /** Tasks in the milestone, cancelled ones excluded. */
  total: number;
  done: number;
  /** Estimate points of those tasks (unestimated tasks count 0). */
  points: number;
  pointsDone: number;
  /** Share of done tasks (by points when every task is estimated), 0–100. */
  pct: number;
  byColumn: Record<BoardColumn, number>;
  /** Tasks without an estimate (cancelled ones excluded). */
  unestimated: number;
}

export function milestoneProgress(tasks: ReadonlyArray<Pick<Task, 'status' | 'prNumber' | 'assigneeType' | 'estimatePoints'>>): MilestoneProgress {
  const byColumn: Record<BoardColumn, number> = { backlog: 0, ready: 0, in_progress: 0, review: 0, blocked: 0, done: 0, cancelled: 0 };
  let total = 0;
  let done = 0;
  let points = 0;
  let pointsDone = 0;
  let unestimated = 0;
  for (const task of tasks) {
    const column = columnOf(task);
    byColumn[column]++;
    if (column === 'cancelled') continue;
    total++;
    const estimate = task.estimatePoints ?? 0;
    if (task.estimatePoints === null) unestimated++;
    points += estimate;
    if (column === 'done') {
      done++;
      pointsDone += estimate;
    }
  }
  const byPoints = total > 0 && unestimated === 0 && points > 0;
  const pct = total === 0 ? 0 : Math.round(((byPoints ? pointsDone / points : done / total) * 1000)) / 10;
  return { total, done, points, pointsDone, pct, byColumn, unestimated };
}

/** Position for a new milestone at the end of the project's list. */
export function nextMilestonePosition(existing: ReadonlyArray<Pick<Milestone, 'position'>>): number {
  return existing.reduce((max, m) => Math.max(max, m.position), 0) + 1000;
}
