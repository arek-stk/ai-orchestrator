import { createHash } from 'node:crypto';
import type { AgentRole, ProjectStatus, RunStage, TaskKind } from '../domain/enums';
import type { FileChange } from '../domain/run';
import type { Task } from '../domain/task';
import type { StagePlanItem } from '../pipeline/stage-planner';

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 20))}\n…[truncated]`;
}

export function branchNameFor(task: Pick<Task, 'id' | 'title'>): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `orchestrator/${task.id}${slug ? `-${slug}` : ''}`;
}

/** Stable key for "the same question" so earlier decisions can be reused (spec §29). */
export function questionKey(parts: readonly string[]): string {
  const normalized = parts.map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).join(' | ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export const STAGE_PROJECT_STATUS: Readonly<Record<RunStage, ProjectStatus>> = Object.freeze({
  INTAKE: 'PLANNING',
  ANALYZE: 'ANALYZING',
  PLAN: 'PLANNING',
  DESIGN: 'PLANNING',
  IMPLEMENT: 'BUILDING',
  TEST: 'TESTING',
  REVIEW: 'REVIEWING',
  SECURITY: 'REVIEWING',
  VERIFY: 'REVIEWING',
  COMMIT: 'BUILDING',
  PUSH: 'BUILDING',
  PR: 'REVIEWING',
  CI: 'TESTING',
  DEPLOY: 'READY_FOR_RELEASE',
  MONITOR: 'DEPLOYED',
  DEBUG: 'DEBUGGING',
});

export function nextPlannedStage(plan: readonly StagePlanItem[], after: RunStage | null): RunStage | null {
  const start = after === null ? 0 : plan.findIndex((item) => item.stage === after) + 1;
  if (after !== null && start === 0) return null;
  return plan.slice(start).find((item) => item.run)?.stage ?? null;
}

export function isPlanned(plan: readonly StagePlanItem[], stage: RunStage): boolean {
  return plan.some((item) => item.stage === stage && item.run);
}

export function mergeChanges(existing: readonly FileChange[], incoming: readonly FileChange[]): FileChange[] {
  const byPath = new Map(existing.map((c) => [c.path, c]));
  for (const change of incoming) byPath.set(change.path, change);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Readable change set for review prompts and PR descriptions. */
export function renderChangeset(changes: readonly FileChange[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const change of changes) {
    const header = `### ${change.action} ${change.path}`;
    if (change.action === 'delete' || !change.content) {
      parts.push(header);
      continue;
    }
    const budget = Math.max(200, maxChars - used);
    const content = truncate(change.content, budget);
    const fence = fenceFor(content);
    const block = `${header}\n${fence}\n${content}\n${fence}`;
    used += block.length;
    parts.push(block);
    if (used >= maxChars) {
      parts.push(`…${changes.length - parts.length} more file(s) omitted`);
      break;
    }
  }
  return parts.join('\n\n');
}

export function commitPrefix(kind: TaskKind): string {
  switch (kind) {
    case 'feature':
      return 'feat';
    case 'bugfix':
    case 'security':
      return 'fix';
    case 'improvement':
      return 'perf';
    default:
      return kind;
  }
}

export function childTaskKind(role: AgentRole): TaskKind {
  if (role === 'tester') return 'test';
  if (role === 'documentation') return 'docs';
  if (role === 'devops') return 'chore';
  return 'feature';
}

export function defaultOutcome(checkpoint: {
  outcome: string | null;
  prNumber: number | null;
  changeset: readonly FileChange[];
  outputs: { plan?: unknown; analysis?: unknown };
}): string {
  if (checkpoint.outcome) return checkpoint.outcome;
  if (checkpoint.prNumber !== null) return 'pr_ready';
  if (checkpoint.changeset.length > 0) return 'changes_ready';
  if (checkpoint.outputs.plan) return 'plan_ready';
  return 'analyzed';
}
