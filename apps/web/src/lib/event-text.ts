import { formatConfidence, formatTokens, formatUsd, humanize, shortSha } from './format';
import type { Tone } from './status';
import type { DomainEvent } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
const COLUMN_LABELS: Record<string, string> = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
const columnLabel = (value: unknown): string => COLUMN_LABELS[str(value)] ?? humanize(str(value));
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

/** Human-readable one-line description of a domain event. */
export function describeEvent(event: DomainEvent): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'project.created':
      return `Project "${str(p.name)}" created`;
    case 'project.updated':
      return `Project settings updated (${(p.fields as string[] | undefined)?.join(', ') ?? 'fields'})`;
    case 'project.blocked':
      return `Project blocked: ${str(p.reason)}`;
    case 'task.created':
      return `Task created: ${str(p.title)}`;
    case 'task.started':
      return 'Task started a new pipeline run';
    case 'task.completed':
      return `Task completed (${humanize(str(p.outcome)).replace(/\bPr\b/, 'PR')})`;
    case 'task.blocked':
      return `Task blocked: ${str(p.reason)}`;
    case 'task.failed':
      return `Task failed: ${str(p.reason)}`;
    case 'pipeline.stage.started':
      return `Stage ${str(p.stage)} started`;
    case 'pipeline.stage.completed':
      return `Stage ${str(p.stage)} ${str(p.status)}${p.summary ? `: ${str(p.summary)}` : ''}`;
    case 'agent.started':
      return `${humanize(str(p.role))} agent started on ${str(p.modelId)}`;
    case 'agent.completed':
      return `${humanize(str(p.role))} agent finished: ${formatTokens(num(p.tokens))} tokens, ${formatUsd(num(p.costUsd))}${p.confidence !== null && p.confidence !== undefined ? `, confidence ${formatConfidence(num(p.confidence))}` : ''}`;
    case 'agent.failed':
      return `${humanize(str(p.role))} agent failed: ${str(p.error)}`;
    case 'test.passed':
      return `Tests passed: ${str(p.summary)}`;
    case 'test.failed':
      return `Tests failed: ${str(p.summary)}`;
    case 'review.requested':
      return `Review requested for ${str(p.stage)}`;
    case 'review.completed':
      return `Review completed: ${humanize(str(p.verdict))}, ${num(p.issues)} issue(s)`;
    case 'decision.made':
      return `Decision made (${formatConfidence(num(p.confidence))}): ${str(p.question)}`;
    case 'github.branch.created':
      return `Branch ${str(p.branch)} created`;
    case 'github.push':
      return `Pushed ${shortSha(str(p.sha))} to ${str(p.branch)}`;
    case 'github.pr.created':
      return `Pull request #${num(p.number)} opened`;
    case 'ci.started':
      return `CI started for ${shortSha(str(p.sha))}`;
    case 'ci.passed':
      return `CI passed for ${shortSha(str(p.sha))}`;
    case 'ci.failed':
      return `CI failed for ${shortSha(str(p.sha))} (${humanize(str(p.classification))})`;
    case 'deployment.started':
      return `Deployment started via ${str(p.workflow)}`;
    case 'deployment.completed':
      return `Deployment ${humanize(str(p.conclusion)).toLowerCase()} via ${str(p.workflow)}`;
    case 'approval.required':
      return `Approval required: ${humanize(str(p.action))} (${str(p.risk)} risk)`;
    case 'approval.decided':
      return `Approval ${str(p.status)} by ${str(p.by)}`;
    case 'budget.exhausted':
      return `Budget exhausted (${str(p.scope)}): ${str(p.reason)}`;
    case 'room.message':
      return `Room: ${str(p.authorName)} posted ${p.threadId ? 'a reply' : `a ${humanize(str(p.intent)).toLowerCase()}`}`;
    case 'task.moved':
      return `${str(p.by)} moved “${str(p.title)}” from ${columnLabel(p.from)} to ${columnLabel(p.to)}${p.schedulingHold ? ' (on hold)' : ''}`;
    case 'task.assigned':
      return `${str(p.by)} assigned “${str(p.title)}” to ${p.assigneeType === 'orchestrator' ? 'the orchestrator' : str(p.assigneeName) || 'a person'}`;
    case 'task.hold_changed':
      return p.hold ? `${str(p.by)} put “${str(p.title)}” on hold` : `${str(p.by)} released “${str(p.title)}” to the scheduler`;
    case 'task.planning_updated':
      return `${str(p.by)} updated planning fields (${((p.fields as string[] | undefined) ?? []).map((f) => humanize(f).toLowerCase()).join(', ')})`;
    case 'milestone.updated':
      return `Milestone “${str(p.title)}” ${str(p.change)}${p.change === 'updated' ? ` (${str(p.status)})` : ''} by ${str(p.by)}`;
    case 'lease.acquired':
      return `${str(p.holderName)} claimed ${p.scope === 'task' ? 'a task' : ((p.paths as string[] | undefined) ?? []).join(', ')}`;
    case 'lease.released':
      return p.broken ? `${str(p.by)} broke ${str(p.holderName)}'s ${str(p.scope)} lease` : `${str(p.holderName)} released a ${str(p.scope)} lease`;
    case 'lease.expired':
      return `${str(p.holderName)}'s ${str(p.scope)} lease expired`;
    case 'scheduler.tick':
      return `Scheduler selected ${num(p.selected)} task(s), skipped ${num(p.skipped)}`;
    case 'autopilot.session.started':
      return `Autopilot started (budget ${formatUsd(num(p.budgetUsd))}, autonomy level ${num(p.effectiveAutonomy)})`;
    case 'autopilot.session.resumed':
      return 'Autopilot session resumed after a server restart';
    case 'autopilot.session.stopped':
      return `Autopilot stopped (${humanize(str(p.reason))}) by ${str(p.by)}`;
    case 'autopilot.session.killed':
      return `Autopilot killed by ${str(p.by)}: ${num(p.pausedRuns)} run(s) paused`;
    case 'autopilot.run.started':
      return `Autopilot started a run at autonomy level ${num(p.effectiveAutonomy)}`;
    case 'autopilot.run.parked':
      return `Run parked for a human: ${humanize(str(p.action))}`;
    case 'autopilot.run.unparked':
      return `Parked run ${str(p.status)}`;
    default:
      return humanize(event.type);
  }
}

const UNVERIFIED = /could not be executed|unverified|no CI checks|verification: (?:deferred|skipped)/i;

/** True when a "passed" stage or outcome admits it was not actually verified (no sandbox, no CI). */
export function isUnverified(text: string | null | undefined): boolean {
  return UNVERIFIED.test(text ?? '');
}

export function eventTone(event: DomainEvent): Tone {
  const type = event.type;
  if (type.endsWith('.failed') || type === 'budget.exhausted') return 'critical';
  if (type.endsWith('.blocked') || type === 'autopilot.session.killed') return 'serious';
  if (type === 'approval.required' || type === 'autopilot.run.parked') return 'warning';
  if (type === 'pipeline.stage.completed') {
    const status = str(event.payload?.status);
    if (status === 'failed') return 'critical';
    if (status === 'waiting') return 'warning';
    if (status === 'skipped') return 'muted';
    // A stage can pass without real verification (no sandbox, no CI): a warning, not a green check.
    return UNVERIFIED.test(str(event.payload?.summary)) ? 'warning' : 'good';
  }
  if (type === 'task.completed' && UNVERIFIED.test(str(event.payload?.outcome))) return 'warning';
  if (type.endsWith('.passed') || type.endsWith('.completed') || type === 'github.pr.created') return 'good';
  if (type.endsWith('.started')) return 'accent';
  return 'muted';
}

export function eventHref(event: DomainEvent): string | null {
  if (event.type === 'room.message' && event.projectId) return `/projects/${event.projectId}?tab=room`;
  if ((event.type === 'task.moved' || event.type === 'task.assigned' || event.type === 'task.hold_changed' || event.type.startsWith('lease.')) && event.projectId) return `/projects/${event.projectId}?tab=board`;
  if (event.type === 'milestone.updated' && event.projectId) return `/projects/${event.projectId}?tab=roadmap`;
  if (event.runId) return `/runs/${event.runId}`;
  if (event.projectId) return `/projects/${event.projectId}`;
  return null;
}
