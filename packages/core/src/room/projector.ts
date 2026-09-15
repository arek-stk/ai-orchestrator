import type { AnyDomainEvent } from '../events/types';
import { systemClock, type Clock, type EmitEvent, type EventRecorder, type TaskRepository } from '../ports';
import { sanitizeInline } from './content';
import type { RoomService } from './service';
import type { MessageAuthorType, MessageIntent, MessageRefs } from './types';

// Projects selected orchestrator events into the Project Room as typed notices. Bounded on three levels:
// 1. only a fixed allow-list of event types is projected (no agent chatter, no stage starts, no scheduler ticks);
// 2. every notice has a dedupe key, so at-least-once pipeline steps that re-emit an event post it once;
// 3. routine notices are rate limited per run; past the limit one "further updates suppressed" notice is posted.
//    Notices that need a human (approvals, decisions, blocked/failed/completed tasks) bypass the limit.

/** Stages whose successful completion is worth a room notice; the run timeline shows the rest. */
const NOTABLE_PASSED_STAGES = new Set(['PLAN', 'IMPLEMENT', 'TEST', 'REVIEW', 'DEPLOY']);
const SUMMARY_LENGTH = 400;
const HOUR_MS = 60 * 60 * 1000;

export interface RoomNotice {
  authorType: MessageAuthorType;
  authorName: string;
  intent: MessageIntent;
  body: string;
  refs: MessageRefs;
  dedupeKey: string;
  /** Bypasses the per-run limit. */
  essential: boolean;
}

export interface RoomProjectorOptions {
  /** Routine notices per run before they are suppressed. */
  maxNoticesPerRun: number;
  /** Runs tracked by the limiter (oldest evicted first), bounding memory. */
  maxTrackedRuns: number;
}

type ProjectableEvent = EmitEvent | AnyDomainEvent;

const inline = (text: string | undefined | null, max = SUMMARY_LENGTH) => sanitizeInline(text ?? '', max);
const words = (value: string) => value.replace(/_/g, ' ');
const quoted = (title: string | null) => (title ? ` “${title}”` : '');

function refsOf(event: ProjectableEvent, extra: MessageRefs = {}): MessageRefs {
  return { ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.runId ? { runId: event.runId } : {}), ...extra };
}

/**
 * Maps an event to a room notice, or null when the event is not projected. Pure: the task title and the current time
 * are passed in.
 */
export function describeEventForRoom(event: ProjectableEvent, context: { taskTitle: string | null; now: Date }): RoomNotice | null {
  const orchestrator = { authorType: 'orchestrator' as const, authorName: 'Orchestrator' };
  const title = context.taskTitle ? inline(context.taskTitle, 120) : null;
  const run = event.runId ?? '';
  const e = event as AnyDomainEvent;
  switch (e.type) {
    case 'task.started':
      return { ...orchestrator, intent: 'status', body: `Started working on${quoted(title) || ' a task'}.`, refs: refsOf(e), dedupeKey: `run:${e.payload.runId}:started`, essential: false };
    case 'pipeline.stage.completed': {
      const { stage, status } = e.payload;
      if (status !== 'failed' && !(status === 'passed' && NOTABLE_PASSED_STAGES.has(stage))) return null;
      if (!run) return null;
      const summary = inline(e.payload.summary);
      const verb = status === 'failed' ? 'failed' : 'passed';
      return {
        ...orchestrator,
        intent: 'status',
        body: `Stage ${stage} ${verb}${quoted(title) ? ` for${quoted(title)}` : ''}${summary ? `: ${summary}` : '.'}`,
        refs: refsOf(e, { stage }),
        dedupeKey: `run:${run}:stage:${stage}:${status}`,
        essential: false,
      };
    }
    case 'github.pr.created':
      return { ...orchestrator, intent: 'status', body: `Opened pull request #${e.payload.number}: ${inline(e.payload.url, 300)}`, refs: refsOf(e), dedupeKey: `run:${run}:pr:${e.payload.number}`, essential: false };
    case 'ci.failed':
      return { ...orchestrator, intent: 'status', body: `CI failed (${words(inline(e.payload.classification, 40))}).`, refs: refsOf(e), dedupeKey: `run:${run}:ci:${inline(e.payload.sha, 64)}:failed`, essential: false };
    case 'deployment.completed':
      return { ...orchestrator, intent: 'status', body: `Deployment via ${inline(e.payload.workflow, 120)} finished: ${words(inline(e.payload.conclusion, 40))}.`, refs: refsOf(e), dedupeKey: `run:${run}:deploy:${inline(e.payload.workflow, 120)}`, essential: false };
    case 'budget.exhausted': {
      // Without a run the notice is bucketed per hour, so a paused project does not post on every scheduler tick.
      const bucket = run ? `run:${run}` : `hour:${Math.floor(context.now.getTime() / HOUR_MS)}`;
      return { authorType: 'system', authorName: 'System', intent: 'status', body: `Budget exhausted (${inline(e.payload.scope, 40)}): ${inline(e.payload.reason)}`, refs: refsOf(e), dedupeKey: `budget:${bucket}:${inline(e.payload.scope, 40)}`, essential: false };
    }
    case 'approval.required':
      return {
        ...orchestrator,
        intent: 'decision_request',
        body: `Approval needed${quoted(title) ? ` for${quoted(title)}` : ''}: ${words(e.payload.action)} (${inline(e.payload.risk, 20)} risk). ${inline(e.payload.reason)}`.trim(),
        refs: refsOf(e, { approvalId: e.payload.approvalId }),
        dedupeKey: `approval:${e.payload.approvalId}:required`,
        essential: true,
      };
    case 'approval.decided':
      return { ...orchestrator, intent: 'status', body: `Approval ${e.payload.status} by ${inline(e.payload.by, 100)}.`, refs: refsOf(e, { approvalId: e.payload.approvalId }), dedupeKey: `approval:${e.payload.approvalId}:decided`, essential: true };
    case 'decision.made':
      return {
        ...orchestrator,
        intent: 'decision',
        body: `Decision recorded (${Math.round(e.payload.confidence * 100)}% confidence): ${inline(e.payload.question)}`,
        refs: refsOf(e, { decisionId: e.payload.decisionId }),
        dedupeKey: `decision:${e.payload.decisionId}`,
        essential: true,
      };
    case 'task.completed': {
      const key = e.payload.runId ? `run:${e.payload.runId}:completed` : `task:${e.taskId ?? ''}:completed:${inline(e.payload.outcome, 40)}`;
      return { ...orchestrator, intent: 'status', body: `Finished${quoted(title) || ' a task'}: ${words(inline(e.payload.outcome, 80))}.`, refs: refsOf(e), dedupeKey: key, essential: true };
    }
    case 'task.blocked':
      return { ...orchestrator, intent: 'status', body: `Blocked${quoted(title) || ''}: ${inline(e.payload.reason)}`, refs: refsOf(e), dedupeKey: run ? `run:${run}:blocked` : `task:${e.taskId ?? ''}:blocked`, essential: true };
    case 'task.failed':
      return { ...orchestrator, intent: 'status', body: `Failed${quoted(title) || ''}: ${inline(e.payload.reason)}`, refs: refsOf(e), dedupeKey: run ? `run:${run}:failed` : `task:${e.taskId ?? ''}:failed`, essential: true };
    default:
      return null;
  }
}

/** Per-run budget for routine notices. Bounded memory: least recently started runs are evicted first. */
export class RunNoticeLimiter {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly maxPerRun: number,
    private readonly maxRuns: number,
  ) {}

  /** `post` within budget, `notice` exactly once when the budget is exhausted, `drop` afterwards. */
  check(runId: string): 'post' | 'notice' | 'drop' {
    const count = this.counts.get(runId) ?? 0;
    if (count < this.maxPerRun) return 'post';
    return count === this.maxPerRun ? 'notice' : 'drop';
  }

  record(runId: string, kind: 'post' | 'notice'): void {
    const count = this.counts.get(runId) ?? 0;
    this.counts.delete(runId);
    this.counts.set(runId, kind === 'notice' ? this.maxPerRun + 1 : count + 1);
    while (this.counts.size > this.maxRuns) this.counts.delete(this.counts.keys().next().value!);
  }
}

export interface RoomProjectorDeps {
  room: Pick<RoomService, 'post'>;
  tasks?: Pick<TaskRepository, 'get'>;
  clock?: Clock;
  /** Projection is best effort: failures are reported here and never fail the emitting pipeline step. */
  onError?: (error: unknown, event: ProjectableEvent) => void;
}

export class RoomEventProjector {
  private readonly limiter: RunNoticeLimiter;

  constructor(
    private readonly deps: RoomProjectorDeps,
    options: Partial<RoomProjectorOptions> = {},
  ) {
    this.limiter = new RunNoticeLimiter(options.maxNoticesPerRun ?? 12, options.maxTrackedRuns ?? 1000);
  }

  async project(event: ProjectableEvent): Promise<void> {
    if (!event.projectId || event.type.startsWith('room.')) return;
    try {
      const taskTitle = event.taskId && this.deps.tasks ? ((await this.deps.tasks.get(event.taskId))?.title ?? null) : null;
      const notice = describeEventForRoom(event, { taskTitle, now: (this.deps.clock ?? systemClock).now() });
      if (!notice) return;

      if (!notice.essential && event.runId) {
        const verdict = this.limiter.check(event.runId);
        if (verdict === 'drop') return;
        if (verdict === 'notice') {
          const { created } = await this.post(event.projectId, {
            ...notice,
            authorType: 'system',
            authorName: 'System',
            body: 'Further routine updates for this run are hidden here to keep the room readable; the run timeline has all of them.',
            refs: { runId: event.runId },
            dedupeKey: `run:${event.runId}:suppressed`,
          });
          if (created) this.limiter.record(event.runId, 'notice');
          return;
        }
      }
      const { created } = await this.post(event.projectId, notice);
      if (created && !notice.essential && event.runId) this.limiter.record(event.runId, 'post');
    } catch (error) {
      this.deps.onError?.(error, event);
    }
  }

  private post(projectId: string, notice: RoomNotice) {
    return this.deps.room.post({
      projectId,
      author: { type: notice.authorType, id: null, name: notice.authorName },
      intent: notice.intent,
      body: notice.body,
      refs: notice.refs,
      dedupeKey: notice.dedupeKey,
    });
  }
}

/**
 * Decorates an event recorder so that projected events also appear in the room. The inner recorder persists and
 * publishes first; the room service must use the inner recorder for its own `room.message` events.
 */
export function withRoomProjection(inner: EventRecorder, projector: Pick<RoomEventProjector, 'project'>): EventRecorder {
  return {
    async emit(event) {
      await inner.emit(event);
      await projector.project(event);
    },
  };
}
