import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, GATED_ACTIONS } from '../domain/project';
import type { Approval, Decision } from '../domain/records';
import { buildAutopilotDigest, filterAutopilotDigest, type AutopilotDigestInput } from './digest';
import {
  applyAutopilotSession,
  autopilotStartSchema,
  DEFAULT_AUTOPILOT_LIMITS,
  defaultStopPolicy,
  deferredApprovalExpiry,
  effectiveAutonomy,
  evaluateSessionStop,
  isQuietHour,
  sessionTaskEligibility,
  type AutopilotSession,
  type AutopilotSessionStats,
} from './session';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-14T10:00:00Z');

function session(overrides: Partial<AutopilotSession> = {}): AutopilotSession {
  return {
    id: 'aps_1',
    startedBy: 'usr_owner',
    status: 'active',
    projectIds: ['prj_a', 'prj_b'],
    startsAt: T0,
    endsAt: new Date(T0.getTime() + 10 * HOUR),
    budgetUsd: 5,
    autonomyCeiling: 3,
    maxTaskRisk: 'medium',
    maxConcurrentRuns: null,
    quietHours: null,
    stopPolicy: defaultStopPolicy(),
    demo: false,
    stopReason: null,
    stopDetail: null,
    stoppedBy: null,
    endedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const quiet: AutopilotSessionStats = { spentUsd: 0, spentLastHourUsd: 0, finishedRuns: [], ciResults: [], securityDenials: 0 };
const finished = (...statuses: Array<'SUCCEEDED' | 'BLOCKED' | 'FAILED' | 'CANCELLED'>) =>
  statuses.map((status, i) => ({ runId: `run_${i}`, status, finishedAt: new Date(T0.getTime() + i * 1000) }));

describe('effective autonomy', () => {
  it('is min(project level, ceilings, 3) and never raises a project', () => {
    expect(effectiveAutonomy(4)).toBe(3);
    expect(effectiveAutonomy(4, 3, 3)).toBe(3);
    expect(effectiveAutonomy(4, 2)).toBe(2);
    expect(effectiveAutonomy(3, 3)).toBe(3);
    expect(effectiveAutonomy(2, 3)).toBe(2);
    expect(effectiveAutonomy(1, 0)).toBe(0);
  });

  it('caps the project view and hardens every gate without touching the stored project', () => {
    const settings = defaultProjectSettings();
    for (const action of GATED_ACTIONS) settings.approvalGates[action] = false;
    const project = { autonomyLevel: 4 as const, settings };
    const view = applyAutopilotSession(project, { autonomyCeiling: 3 }, { maxAutonomy: 3 });
    expect(view.autonomyLevel).toBe(3);
    expect(Object.values(view.settings.approvalGates).every(Boolean)).toBe(true);
    expect(project.autonomyLevel).toBe(4);
    expect(Object.values(project.settings.approvalGates).some(Boolean)).toBe(false);
  });

  it('rejects ceilings above the instance maximum and unknown time zones at the boundary', () => {
    const schema = autopilotStartSchema({ ...DEFAULT_AUTOPILOT_LIMITS, enabled: true, maxAutonomy: 2 });
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5, autonomyCeiling: 3 }).success).toBe(false);
    expect(schema.parse({ projectIds: ['p', 'p'], durationHours: 4, budgetUsd: 5 })).toMatchObject({ projectIds: ['p'], autonomyCeiling: 2, maxTaskRisk: 'medium' });
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5, maxTaskRisk: 'high' }).success).toBe(false);
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 999, budgetUsd: 5 }).success).toBe(false);
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5000 }).success).toBe(false);
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5, quietHours: { timeZone: 'Mars/Olympus', windows: [{ from: '22:00', to: '07:00' }] } }).success).toBe(false);
    // Stop thresholds can only be tightened.
    expect(schema.safeParse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5, stopPolicy: { maxConsecutiveFailures: 10 } }).success).toBe(false);
    expect(schema.parse({ projectIds: ['p'], durationHours: 4, budgetUsd: 5, stopPolicy: { maxConsecutiveFailures: 1 } }).stopPolicy).toEqual({ maxConsecutiveFailures: 1 });
  });
});

describe('stop conditions', () => {
  it('keeps running while nothing is reached', () => {
    expect(evaluateSessionStop(session(), quiet, T0)).toEqual({ stop: false });
  });

  it('stops at the end of the time box', () => {
    const s = session();
    expect(evaluateSessionStop(s, quiet, new Date(s.endsAt.getTime() - 1))).toEqual({ stop: false });
    expect(evaluateSessionStop(s, quiet, s.endsAt)).toMatchObject({ stop: true, mode: 'stop', reason: 'time_box' });
  });

  it('stops when the session budget is spent', () => {
    expect(evaluateSessionStop(session(), { ...quiet, spentUsd: 4.99 }, T0)).toEqual({ stop: false });
    expect(evaluateSessionStop(session(), { ...quiet, spentUsd: 5 }, T0)).toMatchObject({ stop: true, reason: 'budget_exhausted', detail: 'spent $5.00 of $5.00' });
  });

  it('stops after N consecutive failed runs; a success resets and cancellations do not count', () => {
    expect(evaluateSessionStop(session(), { ...quiet, finishedRuns: finished('BLOCKED', 'FAILED', 'SUCCEEDED', 'BLOCKED', 'FAILED') }, T0)).toEqual({ stop: false });
    expect(evaluateSessionStop(session(), { ...quiet, finishedRuns: finished('SUCCEEDED', 'BLOCKED', 'CANCELLED', 'FAILED', 'BLOCKED') }, T0)).toMatchObject({ stop: true, reason: 'failure_streak' });
    const strict = session({ stopPolicy: { ...defaultStopPolicy(), maxConsecutiveFailures: 1 } });
    expect(evaluateSessionStop(strict, { ...quiet, finishedRuns: finished('BLOCKED') }, T0)).toMatchObject({ stop: true, reason: 'failure_streak' });
  });

  it('stops on a CI red streak of code failures; infrastructure failures are ignored', () => {
    const code = { passed: false, classification: 'code' };
    const infra = { passed: false, classification: 'infra' };
    const green = { passed: true, classification: null };
    expect(evaluateSessionStop(session(), { ...quiet, ciResults: [code, code, green, code, infra, code] }, T0)).toEqual({ stop: false });
    expect(evaluateSessionStop(session(), { ...quiet, ciResults: [green, code, infra, code, infra, code] }, T0)).toMatchObject({ stop: true, reason: 'ci_red_streak' });
  });

  it('stops on a cost anomaly (spend rate above the hourly limit)', () => {
    const s = session({ budgetUsd: 50, stopPolicy: { ...defaultStopPolicy(), maxUsdPerHour: 2 } });
    expect(evaluateSessionStop(s, { ...quiet, spentUsd: 10, spentLastHourUsd: 2 }, T0)).toEqual({ stop: false });
    expect(evaluateSessionStop(s, { ...quiet, spentUsd: 10, spentLastHourUsd: 2.5 }, T0)).toMatchObject({ stop: true, mode: 'stop', reason: 'cost_anomaly' });
  });

  it('kills (not just stops) on repeated security denials, before any other condition', () => {
    const s = session();
    expect(evaluateSessionStop(s, { ...quiet, securityDenials: 2 }, T0)).toEqual({ stop: false });
    expect(evaluateSessionStop(s, { ...quiet, securityDenials: 3, spentUsd: 99 }, s.endsAt)).toMatchObject({ stop: true, mode: 'kill', reason: 'security_denials' });
  });
});

describe('deferred approval expiry', () => {
  const base = { ttlMs: 72 * HOUR, returnGraceMs: 48 * HOUR, maxApprovalLifetimeMs: 14 * 24 * HOUR };

  it('extends a deferred approval until the session end plus grace', () => {
    const requestedAt = T0;
    const expiresAt = deferredApprovalExpiry({ ...base, requestedAt, sessionEndsAt: new Date(T0.getTime() + 70 * HOUR) })!;
    expect(expiresAt.getTime() - requestedAt.getTime()).toBe(118 * HOUR);
    expect(expiresAt.getTime()).toBeGreaterThan(requestedAt.getTime() + 72 * HOUR);
  });

  it('never shortens the normal TTL', () => {
    expect(deferredApprovalExpiry({ ...base, requestedAt: T0, sessionEndsAt: new Date(T0.getTime() + HOUR) })!.getTime()).toBe(T0.getTime() + 72 * HOUR);
  });

  it('never extends beyond the hard maximum lifetime', () => {
    const expiresAt = deferredApprovalExpiry({ ...base, requestedAt: T0, sessionEndsAt: new Date(T0.getTime() + 300 * HOUR) })!;
    expect(expiresAt.getTime()).toBe(T0.getTime() + 14 * 24 * HOUR);
  });

  it('follows APPROVAL_TTL_HOURS=0 (no expiry)', () => {
    expect(deferredApprovalExpiry({ ...base, ttlMs: 0, requestedAt: T0, sessionEndsAt: T0 })).toBeNull();
  });
});

describe('quiet hours and eligibility', () => {
  const quietHours = { timeZone: 'Europe/Berlin', windows: [{ from: '22:00', to: '07:00' }] };

  it('evaluates windows in the configured time zone across a DST change', () => {
    expect(isQuietHour(new Date('2026-07-01T04:30:00Z'), quietHours)).toBe(true); // 06:30 CEST
    expect(isQuietHour(new Date('2026-07-01T05:30:00Z'), quietHours)).toBe(false); // 07:30 CEST
    expect(isQuietHour(new Date('2026-10-24T20:30:00Z'), quietHours)).toBe(true); // 22:30 CEST
    expect(isQuietHour(new Date('2026-10-25T05:30:00Z'), quietHours)).toBe(true); // 06:30 CET, after the change
    expect(isQuietHour(new Date('2026-10-25T06:30:00Z'), quietHours)).toBe(false); // 07:30 CET
    expect(isQuietHour(new Date('2026-10-25T12:00:00Z'), { timeZone: 'UTC', windows: [{ from: '11:00', to: '13:00' }] })).toBe(true);
    expect(isQuietHour(T0, null)).toBe(false);
  });

  it('skips held, quiet-hour, over-budget, risky and security-relevant tasks', () => {
    const task = { title: 'Add product search', goal: 'Search by name', kind: 'feature' as const, risk: 'medium' as const, estimatedComplexity: 'medium' as const, acceptanceCriteria: [] };
    const s = session();
    const input = { task, session: s, now: T0, spentUsd: 0 };
    expect(sessionTaskEligibility(input)).toBeNull();
    expect(sessionTaskEligibility({ ...input, task: { ...task, schedulingHold: true } })).toBe('scheduling_hold');
    expect(sessionTaskEligibility({ ...input, session: session({ quietHours: { timeZone: 'UTC', windows: [{ from: '09:00', to: '11:00' }] } }) })).toBe('autopilot_quiet_hours');
    expect(sessionTaskEligibility({ ...input, spentUsd: 4.5 })).toBe('autopilot_budget_reserve');
    expect(sessionTaskEligibility({ ...input, spentUsd: 4.49 })).toBeNull();
    expect(sessionTaskEligibility({ ...input, task: { ...task, risk: 'high' } })).toBe('autopilot_risk_class');
    expect(sessionTaskEligibility({ ...input, session: session({ maxTaskRisk: 'low' }) })).toBe('autopilot_risk_class');
    expect(sessionTaskEligibility({ ...input, task: { ...task, kind: 'security' } })).toBe('autopilot_security_relevant');
  });
});

describe('return digest', () => {
  function digestInput(): AutopilotDigestInput {
    const s = session({ status: 'ended', endedAt: new Date(T0.getTime() + 5 * HOUR), stopReason: 'budget_exhausted', stopDetail: 'spent $5.00 of $5.00', stoppedBy: 'system' });
    const approval = (id: string, projectId: string, minutes: number): Approval => ({
      id,
      projectId,
      taskId: `tsk_${id}`,
      runId: `run_${id}`,
      action: 'database_migration',
      reason: 'Database schema or migration changed',
      risk: 'medium',
      details: {},
      status: 'pending',
      requestedAt: new Date(T0.getTime() + minutes * 60_000),
      decidedBy: null,
      decidedAt: null,
      comment: null,
      mode: 'deferred',
      sessionId: s.id,
      expiresAt: new Date(T0.getTime() + 58 * HOUR),
    });
    const decision: Decision = {
      id: 'dec_1',
      projectId: 'prj_a',
      taskId: 'tsk_1',
      runId: 'run_1',
      question: 'Which design?',
      questionKey: 'k',
      options: [],
      consulted: [],
      evidence: [],
      decision: 'option-a',
      chosenOptionId: 'option-a',
      reason: 'consensus',
      confidence: 0.9,
      costUsd: 0.1,
      supersedesId: null,
      createdAt: new Date(T0.getTime() + 30 * 60_000),
    };
    const run = (id: string, projectId: string, status: 'SUCCEEDED' | 'BLOCKED' | 'PARKED', minutes: number, pr: number | null) => ({
      id,
      taskId: id.replace('run', 'tsk'),
      projectId,
      status,
      costUsd: 1,
      blockedReason: status === 'BLOCKED' ? 'Gave up after 3 repair attempts' : null,
      prNumber: pr,
      prUrl: pr ? `https://github.com/acme/shop/pull/${pr}` : null,
      outcome: status === 'SUCCEEDED' ? 'pr_ready' : null,
      startedAt: new Date(T0.getTime() + minutes * 60_000),
      finishedAt: status === 'PARKED' ? null : new Date(T0.getTime() + (minutes + 20) * 60_000),
    });
    return {
      session: s,
      runs: [run('run_1', 'prj_a', 'SUCCEEDED', 1, 7), run('run_2', 'prj_b', 'BLOCKED', 2, null), run('run_x', 'prj_a', 'PARKED', 3, null), run('run_y', 'prj_b', 'PARKED', 3, null)],
      taskTitles: new Map([
        ['tsk_1', 'Add product search'],
        ['tsk_2', 'Refactor cart'],
        ['tsk_x', 'Add search index'],
      ]),
      approvals: [approval('x', 'prj_a', 40), approval('y', 'prj_b', 40)],
      decisions: [decision, { ...decision, id: 'dec_other', runId: 'run_not_in_session' }],
      costByProject: [
        { projectId: 'prj_b', costUsd: 1.25 },
        { projectId: 'prj_a', costUsd: 3.5 },
      ],
    };
  }

  it('aggregates runs, PRs, parked approvals, decisions, costs and the stop reason', () => {
    const digest = buildAutopilotDigest(digestInput(), new Date(T0.getTime() + 9 * HOUR));
    expect(digest.asOf).toBe(new Date(T0.getTime() + 5 * HOUR).toISOString());
    expect(digest.totals).toEqual({ runsStarted: 4, succeeded: 1, failed: 1, cancelled: 0, inProgress: 0, parked: 2, pullRequests: 1, decisions: 1 });
    expect(digest.pullRequests).toEqual([{ runId: 'run_1', taskId: 'tsk_1', projectId: 'prj_a', taskTitle: 'Add product search', number: 7, url: 'https://github.com/acme/shop/pull/7', outcome: 'pr_ready' }]);
    expect(digest.parkedApprovals.map((a) => [a.approvalId, a.action, a.taskTitle])).toEqual([
      ['x', 'database_migration', 'Add search index'],
      ['y', 'database_migration', 'tsk_y'],
    ]);
    expect(digest.failures).toEqual([expect.objectContaining({ runId: 'run_2', reason: 'Gave up after 3 repair attempts' })]);
    expect(digest.decisions.map((d) => d.decisionId)).toEqual(['dec_1']);
    expect(digest.costs).toEqual({ totalUsd: 4.75, budgetUsd: 5, budgetUsedPct: 95, byProject: [{ projectId: 'prj_a', costUsd: 3.5 }, { projectId: 'prj_b', costUsd: 1.25 }] });
    expect(digest.stop).toEqual({ reason: 'budget_exhausted', detail: 'spent $5.00 of $5.00', by: 'system' });
  });

  it('is deterministic: the same records in any order give the same digest', () => {
    const now = new Date(T0.getTime() + 9 * HOUR);
    const input = digestInput();
    const shuffled: AutopilotDigestInput = {
      ...input,
      runs: [...input.runs].reverse(),
      approvals: [...input.approvals].reverse(),
      decisions: [...input.decisions].reverse(),
      costByProject: [...input.costByProject].reverse(),
    };
    expect(JSON.stringify(buildAutopilotDigest(shuffled, now))).toBe(JSON.stringify(buildAutopilotDigest(input, now)));
    // An ended session's digest does not depend on when it is looked at.
    expect(buildAutopilotDigest(input, new Date(now.getTime() + 24 * HOUR))).toEqual(buildAutopilotDigest(input, now));
  });

  it('shows restricted viewers only their projects, including totals', () => {
    const digest = filterAutopilotDigest(buildAutopilotDigest(digestInput(), T0), new Set(['prj_b']));
    expect(digest.pullRequests).toEqual([]);
    expect(digest.parkedApprovals.map((a) => a.projectId)).toEqual(['prj_b']);
    expect(digest.totals).toMatchObject({ runsStarted: 2, succeeded: 0, failed: 1, parked: 1, pullRequests: 0, decisions: 0 });
    expect(digest.costs.totalUsd).toBe(1.25);
    expect(digest.projects.map((p) => p.projectId)).toEqual(['prj_b']);
  });
});
