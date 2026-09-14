import type { BudgetScope } from '../budget/budget-guard';
import type { RunStatus } from '../domain/enums';
import type { Project } from '../domain/project';
import type { Clock, EventRecorder, ProjectRepository, RunRepository } from '../ports';
import { buildAutopilotDigest, type AutopilotDigest, type AutopilotDigestInput } from './digest';
import {
  defaultStopPolicy,
  effectiveAutonomy,
  evaluateSessionStop,
  type AutopilotLimits,
  type AutopilotSession,
  type AutopilotSessionStats,
  type AutopilotSessionStatus,
  type AutopilotStartInput,
  type AutopilotStopReason,
} from './session';

export type NewAutopilotSession = Omit<AutopilotSession, 'id' | 'status' | 'stopReason' | 'stopDetail' | 'stoppedBy' | 'endedAt' | 'createdAt' | 'updatedAt'>;

export interface AutopilotSessionFinish {
  status: 'ended' | 'killed';
  stopReason: AutopilotStopReason;
  stopDetail: string;
  stoppedBy: string;
  endedAt: Date;
}

export interface AutopilotSessionFilter {
  statuses?: readonly AutopilotSessionStatus[];
  /** Sessions that include at least one of these projects. */
  projectIds?: readonly string[];
  limit?: number;
}

/** Persistence port for sessions (packages/db, in-memory store in testing). */
export interface AutopilotSessionRepository {
  /** Throws AutopilotConflictError when a project already belongs to an active session. */
  create(input: NewAutopilotSession): Promise<AutopilotSession>;
  get(id: string): Promise<AutopilotSession | null>;
  list(filter: AutopilotSessionFilter): Promise<AutopilotSession[]>;
  /** Ends an active session; null when it was no longer active (another actor finished it first). */
  finish(id: string, patch: AutopilotSessionFinish): Promise<AutopilotSession | null>;
  /** Ledger spend of the session's runs between the session start and its end (or `now`). */
  spentUsd(session: AutopilotSession, now: Date): Promise<number>;
  stats(session: AutopilotSession, now: Date): Promise<AutopilotSessionStats>;
  digestInput(session: AutopilotSession, now: Date): Promise<AutopilotDigestInput>;
}

export class AutopilotConflictError extends Error {
  readonly statusCode = 409;
  constructor(readonly projectIds: readonly string[]) {
    super(`project(s) already in an active autopilot session: ${projectIds.join(', ')}`);
    this.name = 'AutopilotConflictError';
  }
}

export class AutopilotDisabledError extends Error {
  readonly statusCode = 403;
  constructor() {
    super('the autopilot is disabled on this instance (AUTOPILOT_ENABLED)');
    this.name = 'AutopilotDisabledError';
  }
}

export interface AutopilotActor {
  type: 'user' | 'system';
  id: string | null;
  login: string;
}

export const SYSTEM_ACTOR: AutopilotActor = Object.freeze({ type: 'system', id: null, login: 'system' });

export interface AutopilotAuditEntry {
  actorType: 'user' | 'system';
  actorId: string | null;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface AutopilotServiceDeps {
  sessions: AutopilotSessionRepository;
  projects: Pick<ProjectRepository, 'get'>;
  runs: Pick<RunRepository, 'list'>;
  events: EventRecorder;
  clock: Clock;
  limits: () => AutopilotLimits;
  /** Pauses a run of a killed session (resumable by a human). */
  pauseRun: (runId: string, reason: string) => Promise<boolean>;
  audit?: (entry: AutopilotAuditEntry) => Promise<void>;
  demoMode?: () => boolean;
}

/**
 * The `session` budget scope for a model call of a run in an active session (existing budget guard, ADR-004 style
 * accounting over the usage ledger). null when the run is not in an active session.
 */
export async function sessionBudgetScope(
  deps: { sessions: Pick<AutopilotSessionRepository, 'get' | 'spentUsd'>; runs: Pick<RunRepository, 'get'> },
  runId: string | null,
  now: Date,
): Promise<BudgetScope | null> {
  if (!runId) return null;
  const run = await deps.runs.get(runId);
  if (!run?.sessionId) return null;
  const session = await deps.sessions.get(run.sessionId);
  if (!session || session.status !== 'active') return null;
  return { scope: 'session', limitUsd: session.budgetUsd, spentUsd: await deps.sessions.spentUsd(session, now) };
}

/** Runs a kill pauses. PARKED runs already wait for a human; PAUSED ones are already stopped. */
const KILL_PAUSES: readonly RunStatus[] = ['QUEUED', 'RUNNING', 'WAITING'];
const HOUR_MS = 60 * 60 * 1000;

/**
 * Session lifecycle: start, graceful stop, kill switch, automatic stops from the scheduler tick, restart recovery and
 * the return digest. Every transition emits one event per project in scope and writes an audit entry.
 */
export class AutopilotService {
  constructor(private readonly deps: AutopilotServiceDeps) {}

  async start(input: AutopilotStartInput, actor: AutopilotActor): Promise<AutopilotSession> {
    const limits = this.deps.limits();
    if (!limits.enabled) throw new AutopilotDisabledError();
    const projects: Project[] = [];
    for (const projectId of input.projectIds) {
      const project = await this.deps.projects.get(projectId);
      if (!project) throw Object.assign(new Error(`project ${projectId} not found`), { statusCode: 404 });
      projects.push(project);
    }

    const now = this.deps.clock.now();
    const session = await this.deps.sessions.create({
      startedBy: actor.id ?? actor.login,
      projectIds: input.projectIds,
      startsAt: now,
      endsAt: new Date(now.getTime() + input.durationHours * HOUR_MS),
      budgetUsd: input.budgetUsd,
      autonomyCeiling: input.autonomyCeiling,
      maxTaskRisk: input.maxTaskRisk,
      maxConcurrentRuns: input.maxConcurrentRuns,
      quietHours: input.quietHours,
      stopPolicy: { ...defaultStopPolicy(limits), ...input.stopPolicy },
      demo: this.deps.demoMode?.() ?? false,
    });

    for (const project of projects) {
      await this.deps.events.emit({
        type: 'autopilot.session.started',
        projectId: project.id,
        taskId: null,
        runId: null,
        payload: {
          sessionId: session.id,
          endsAt: session.endsAt.toISOString(),
          budgetUsd: session.budgetUsd,
          effectiveAutonomy: effectiveAutonomy(project.autonomyLevel, session.autonomyCeiling, limits.maxAutonomy),
          demo: session.demo,
        },
      });
    }
    await this.audit(actor, 'autopilot.session.start', session.id, {
      projectIds: session.projectIds,
      endsAt: session.endsAt.toISOString(),
      budgetUsd: session.budgetUsd,
      autonomyCeiling: session.autonomyCeiling,
      maxTaskRisk: session.maxTaskRisk,
      demo: session.demo,
    });
    return session;
  }

  /** Graceful stop: no new work; in-flight runs continue with the project's own autonomy and gates. */
  async stop(id: string, actor: AutopilotActor, reason: AutopilotStopReason = 'manual', detail = `stopped by ${actor.login}`): Promise<AutopilotSession | null> {
    const session = await this.deps.sessions.finish(id, { status: 'ended', stopReason: reason, stopDetail: detail, stoppedBy: actor.login, endedAt: this.deps.clock.now() });
    if (!session) return null;
    for (const projectId of session.projectIds) {
      await this.deps.events.emit({ type: 'autopilot.session.stopped', projectId, taskId: null, runId: null, payload: { sessionId: id, reason, detail, by: actor.login } });
    }
    await this.audit(actor, 'autopilot.session.stop', id, { reason, detail });
    return session;
  }

  /**
   * Kill switch: the session ends immediately, its running runs are paused (resumable, not cancelled) and the tool
   * router denies every further call carrying the session id. Parked approvals stay with the human.
   */
  async kill(id: string, actor: AutopilotActor, reason: AutopilotStopReason = 'killed', detail = `killed by ${actor.login}`): Promise<{ session: AutopilotSession; pausedRuns: number } | null> {
    const session = await this.deps.sessions.finish(id, { status: 'killed', stopReason: reason, stopDetail: detail, stoppedBy: actor.login, endedAt: this.deps.clock.now() });
    if (!session) return null;
    let pausedRuns = 0;
    for (const run of await this.deps.runs.list({ sessionId: id, statuses: KILL_PAUSES, limit: 500 })) {
      if (await this.deps.pauseRun(run.id, `Autopilot session ${id} was killed: ${detail}`)) pausedRuns++;
    }
    for (const projectId of session.projectIds) {
      await this.deps.events.emit({ type: 'autopilot.session.killed', projectId, taskId: null, runId: null, payload: { sessionId: id, reason, detail, by: actor.login, pausedRuns } });
    }
    await this.audit(actor, 'autopilot.session.kill', id, { reason, detail, pausedRuns });
    return { session, pausedRuns };
  }

  /** Kills every active session accepted by `include` (e.g. sessions touching a project the operator can access). */
  async killAll(actor: AutopilotActor, include: (session: AutopilotSession) => boolean = () => true): Promise<Array<{ session: AutopilotSession; pausedRuns: number }>> {
    const killed: Array<{ session: AutopilotSession; pausedRuns: number }> = [];
    for (const session of await this.deps.sessions.list({ statuses: ['active'], limit: 200 })) {
      if (!include(session)) continue;
      const result = await this.kill(session.id, actor);
      if (result) killed.push(result);
    }
    return killed;
  }

  /** Scheduler tick: evaluates the stop conditions of every active session. */
  async tick(): Promise<{ stopped: number; killed: number }> {
    const now = this.deps.clock.now();
    let stopped = 0;
    let killed = 0;
    for (const session of await this.deps.sessions.list({ statuses: ['active'], limit: 200 })) {
      const verdict = evaluateSessionStop(session, await this.deps.sessions.stats(session, now), now);
      if (!verdict.stop) continue;
      if (verdict.mode === 'kill') {
        if (await this.kill(session.id, SYSTEM_ACTOR, verdict.reason, verdict.detail)) killed++;
      } else if (await this.stop(session.id, SYSTEM_ACTOR, verdict.reason, verdict.detail)) {
        stopped++;
      }
    }
    return { stopped, killed };
  }

  /**
   * After a restart sessions are resumed from the database: effective autonomy is never persisted, so nothing needs
   * repairing. A session whose time box ended while the server was down is stopped with that reason.
   */
  async recover(): Promise<{ resumed: number; stopped: number }> {
    const now = this.deps.clock.now();
    let resumed = 0;
    let stopped = 0;
    for (const session of await this.deps.sessions.list({ statuses: ['active'], limit: 200 })) {
      if (now.getTime() >= session.endsAt.getTime()) {
        if (await this.stop(session.id, SYSTEM_ACTOR, 'time_box', `time box ended at ${session.endsAt.toISOString()} while the server was offline`)) stopped++;
        continue;
      }
      const reason = 'server restarted; session state restored from the database';
      for (const projectId of session.projectIds) {
        await this.deps.events.emit({ type: 'autopilot.session.resumed', projectId, taskId: null, runId: null, payload: { sessionId: session.id, reason } });
      }
      await this.audit(SYSTEM_ACTOR, 'autopilot.session.resume', session.id, { reason });
      resumed++;
    }
    const verdicts = await this.tick();
    return { resumed, stopped: stopped + verdicts.stopped + verdicts.killed };
  }

  async digest(id: string): Promise<AutopilotDigest | null> {
    const session = await this.deps.sessions.get(id);
    if (!session) return null;
    const now = this.deps.clock.now();
    return buildAutopilotDigest(await this.deps.sessions.digestInput(session, now), now);
  }

  private async audit(actor: AutopilotActor, action: string, target: string, details: Record<string, unknown>): Promise<void> {
    await this.deps.audit?.({ actorType: actor.type, actorId: actor.id, action, target, details: { ...details, by: actor.login } });
  }
}
