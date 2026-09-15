import { z } from 'zod';
import type { AutonomyLevel, Risk, RunStatus } from '../domain/enums';
import { GATED_ACTIONS, type GatedAction, type Project } from '../domain/project';
import { isSecurityRelevant, type StagePlanTask } from '../pipeline/stage-planner';

// Autopilot (away mode), slice 1 of docs/plans/autopilot.md: time- and budget-boxed sessions in which the
// scheduler keeps working on existing tasks while gated actions are parked for a human. Everything here is pure.

export const AUTOPILOT_SESSION_STATUSES = ['active', 'ended', 'killed'] as const;
export type AutopilotSessionStatus = (typeof AUTOPILOT_SESSION_STATUSES)[number];

export const AUTOPILOT_STOP_REASONS = [
  'manual',
  'killed',
  'time_box',
  'budget_exhausted',
  'failure_streak',
  'ci_red_streak',
  'cost_anomaly',
  'security_denials',
] as const;
export type AutopilotStopReason = (typeof AUTOPILOT_STOP_REASONS)[number];

/** Hard structural cap: level 4 (merge + deploy) is never reachable inside a session. */
export const AUTOPILOT_AUTONOMY_CAP = 3 as const satisfies AutonomyLevel;

export interface QuietHoursWindow {
  /** "HH:MM", 24-hour clock in `timeZone`. A window with from > to wraps midnight. */
  from: string;
  to: string;
}

export interface QuietHours {
  timeZone: string;
  windows: QuietHoursWindow[];
}

export interface AutopilotStopPolicy {
  /** Consecutive BLOCKED/FAILED session runs that stop the session. */
  maxConsecutiveFailures: number;
  /** Consecutive CI failures classified as code failures (infrastructure failures are ignored). */
  maxCiRedStreak: number;
  /** Tool-router security denials within `securityDenialWindowMs` that kill the session (possible prompt injection). */
  maxSecurityDenials: number;
  securityDenialWindowMs: number;
  /** Spend in the trailing hour above this is treated as a cost anomaly. */
  maxUsdPerHour: number;
  /** Share of the session budget from which no new runs start (in-flight runs may finish). */
  noNewRunsAtBudgetShare: number;
}

export interface AutopilotSession {
  id: string;
  startedBy: string;
  status: AutopilotSessionStatus;
  projectIds: string[];
  startsAt: Date;
  endsAt: Date;
  budgetUsd: number;
  /** Ceiling chosen at start (0–3), additionally capped by the instance maximum. */
  autonomyCeiling: AutonomyLevel;
  /** Highest task risk the autopilot picks up; high-risk and security-relevant tasks are never picked. */
  maxTaskRisk: Extract<Risk, 'low' | 'medium'>;
  /** Slot-holding session runs at once (null: only the projects' own limits apply). */
  maxConcurrentRuns: number | null;
  /** Parked runs per project from which no new run starts there (a pile of unreviewed branches helps nobody). */
  maxParkedRuns: number;
  quietHours: QuietHours | null;
  stopPolicy: AutopilotStopPolicy;
  /** Started while the instance ran with mock models (demo mode). */
  demo: boolean;
  stopReason: AutopilotStopReason | null;
  stopDetail: string | null;
  stoppedBy: string | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Instance-wide bounds (server configuration). */
export interface AutopilotLimits {
  enabled: boolean;
  maxHours: number;
  maxBudgetUsd: number;
  /** ≤ 3, validated by the configuration. */
  maxAutonomy: AutonomyLevel;
  /** Deferred approvals stay valid until the session ends plus this grace period. */
  returnGraceMs: number;
  /** Deferred approvals never live longer than this after they were requested. */
  maxApprovalLifetimeMs: number;
  maxUsdPerHour: number;
}

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_AUTOPILOT_LIMITS: Readonly<AutopilotLimits> = Object.freeze({
  enabled: false,
  maxHours: 72,
  maxBudgetUsd: 50,
  maxAutonomy: AUTOPILOT_AUTONOMY_CAP,
  returnGraceMs: 48 * HOUR_MS,
  maxApprovalLifetimeMs: 14 * 24 * HOUR_MS,
  maxUsdPerHour: 10,
});

export function defaultStopPolicy(limits: Pick<AutopilotLimits, 'maxUsdPerHour'> = DEFAULT_AUTOPILOT_LIMITS): AutopilotStopPolicy {
  return {
    maxConsecutiveFailures: 3,
    maxCiRedStreak: 3,
    maxSecurityDenials: 3,
    securityDenialWindowMs: HOUR_MS,
    maxUsdPerHour: limits.maxUsdPerHour,
    noNewRunsAtBudgetShare: 0.9,
  };
}

// ---------------------------------------------------------------------------
// Validation (API boundary)
// ---------------------------------------------------------------------------

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const QuietHoursSchema = z.object({
  timeZone: z.string().min(1).max(64).refine(validTimeZone, 'unknown time zone'),
  windows: z
    .array(
      z
        .object({ from: z.string().regex(TIME_OF_DAY, 'expected HH:MM'), to: z.string().regex(TIME_OF_DAY, 'expected HH:MM') })
        .refine((w) => w.from !== w.to, 'a window needs different start and end times'),
    )
    .min(1)
    .max(4),
});

/** Start parameters. Stop thresholds can only be tightened relative to the defaults. */
export function autopilotStartSchema(limits: AutopilotLimits) {
  const defaults = defaultStopPolicy(limits);
  return z.object({
    projectIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .transform((ids) => [...new Set(ids)]),
    durationHours: z.number().min(0.25).max(limits.maxHours),
    budgetUsd: z.number().positive().max(limits.maxBudgetUsd),
    autonomyCeiling: z
      .number()
      .int()
      .min(0)
      .max(limits.maxAutonomy)
      .default(limits.maxAutonomy)
      .transform((v) => v as AutonomyLevel),
    maxTaskRisk: z.enum(['low', 'medium']).default('medium'),
    maxConcurrentRuns: z.number().int().min(1).max(20).nullable().default(null),
    maxParkedRuns: z.number().int().min(1).max(10).default(3),
    quietHours: QuietHoursSchema.nullable().default(null),
    stopPolicy: z
      .object({
        maxConsecutiveFailures: z.number().int().min(1).max(defaults.maxConsecutiveFailures),
        maxCiRedStreak: z.number().int().min(1).max(defaults.maxCiRedStreak),
        maxSecurityDenials: z.number().int().min(1).max(defaults.maxSecurityDenials),
        maxUsdPerHour: z.number().positive().max(defaults.maxUsdPerHour),
        noNewRunsAtBudgetShare: z.number().min(0.5).max(defaults.noNewRunsAtBudgetShare),
      })
      .partial()
      .default({}),
  });
}
export type AutopilotStartInput = z.output<ReturnType<typeof autopilotStartSchema>>;

// ---------------------------------------------------------------------------
// Autonomy and gates
// ---------------------------------------------------------------------------

/**
 * Effective autonomy inside a session: min(project level, ceilings, 3). Computed per call and never written to the
 * project, so a crash can never leave a project with changed autonomy.
 */
export function effectiveAutonomy(projectLevel: AutonomyLevel, ...ceilings: readonly number[]): AutonomyLevel {
  const level = Math.min(projectLevel, AUTOPILOT_AUTONOMY_CAP, ...ceilings);
  return Math.max(0, Math.floor(level)) as AutonomyLevel;
}

/** Every gated action is hard while unattended: gates can be tightened, never loosened, in a session. */
export const AUTOPILOT_HARD_GATES: readonly GatedAction[] = GATED_ACTIONS;

export function hardenGates(gates: Readonly<Record<GatedAction, boolean>>): Record<GatedAction, boolean> {
  const hardened = { ...gates };
  for (const action of AUTOPILOT_HARD_GATES) hardened[action] = true;
  return hardened;
}

/**
 * The project as the pipeline sees it during an active session: capped autonomy and hard gates. The stored project is
 * never modified; runs of ended sessions use the stored project again.
 */
export function applyAutopilotSession<P extends Pick<Project, 'autonomyLevel' | 'settings'>>(project: P, session: Pick<AutopilotSession, 'autonomyCeiling'>, limits: Pick<AutopilotLimits, 'maxAutonomy'>): P {
  return {
    ...project,
    autonomyLevel: effectiveAutonomy(project.autonomyLevel, session.autonomyCeiling, limits.maxAutonomy),
    settings: { ...project.settings, approvalGates: hardenGates(project.settings.approvalGates) },
  };
}

// ---------------------------------------------------------------------------
// Deferred approvals
// ---------------------------------------------------------------------------

export interface DeferredExpiryInput {
  requestedAt: Date;
  /** APPROVAL_TTL_HOURS; ≤ 0 disables expiry. */
  ttlMs: number;
  sessionEndsAt: Date;
  returnGraceMs: number;
  maxApprovalLifetimeMs: number;
}

/**
 * Expiry of a deferred approval: at least the normal TTL, extended to the session end plus the return grace period,
 * but never beyond the hard maximum lifetime (refines ADR-023). null when expiry is disabled.
 */
export function deferredApprovalExpiry(input: DeferredExpiryInput): Date | null {
  if (input.ttlMs <= 0) return null;
  const requested = input.requestedAt.getTime();
  const normal = requested + input.ttlMs;
  const extended = Math.max(normal, input.sessionEndsAt.getTime() + input.returnGraceMs);
  const cap = requested + Math.max(input.ttlMs, input.maxApprovalLifetimeMs);
  return new Date(Math.min(extended, cap));
}

// ---------------------------------------------------------------------------
// Quiet hours and eligibility
// ---------------------------------------------------------------------------

function minutesOf(time: string): number {
  const match = TIME_OF_DAY.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

/** Local minute of the day in `timeZone` (Intl-based, DST-aware). */
export function localMinuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

export function isQuietHour(now: Date, quietHours: QuietHours | null): boolean {
  if (!quietHours) return false;
  const minute = localMinuteOfDay(now, quietHours.timeZone);
  return quietHours.windows.some(({ from, to }) => {
    const start = minutesOf(from);
    const end = minutesOf(to);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

export type AutopilotSkipReason =
  | 'scheduling_hold'
  | 'autopilot_quiet_hours'
  | 'autopilot_budget_reserve'
  | 'autopilot_parked_full'
  | 'autopilot_risk_class'
  | 'autopilot_security_relevant';

export interface EligibilityInput {
  task: StagePlanTask & { schedulingHold?: boolean };
  session: Pick<AutopilotSession, 'budgetUsd' | 'maxTaskRisk' | 'maxParkedRuns' | 'quietHours' | 'stopPolicy'>;
  now: Date;
  spentUsd: number;
  /** PARKED runs in the task's project. */
  parkedRuns?: number;
}

/** Why the autopilot must not start this task (null: eligible). Only existing READY/BACKLOG tasks reach this. */
export function sessionTaskEligibility(input: EligibilityInput): AutopilotSkipReason | null {
  const { task, session } = input;
  // TODO(planning-assistant): `tasks.scheduling_hold` does not exist yet (docs/plans/planning-assistant.md, stage 1).
  // Held tasks must never be picked or released by the autopilot; this check activates once the field is mapped.
  if (task.schedulingHold === true) return 'scheduling_hold';
  if (isQuietHour(input.now, session.quietHours)) return 'autopilot_quiet_hours';
  if (input.spentUsd >= session.budgetUsd * session.stopPolicy.noNewRunsAtBudgetShare) return 'autopilot_budget_reserve';
  if ((input.parkedRuns ?? 0) >= session.maxParkedRuns) return 'autopilot_parked_full';
  if (task.risk === 'high' || (session.maxTaskRisk === 'low' && task.risk !== 'low')) return 'autopilot_risk_class';
  if (isSecurityRelevant(task)) return 'autopilot_security_relevant';
  return null;
}

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

export interface AutopilotSessionStats {
  /** Ledger spend attributed to the session's runs while the session was active. */
  spentUsd: number;
  spentLastHourUsd: number;
  /** Terminal runs of the session, oldest first. */
  finishedRuns: ReadonlyArray<{ runId: string; status: RunStatus; finishedAt: Date }>;
  /** CI results of session runs, oldest first. `classification` is set for failures. */
  ciResults: ReadonlyArray<{ passed: boolean; classification: string | null }>;
  /** Security denials of session tool calls inside the policy window. */
  securityDenials: number;
}

export type StopEvaluation = { stop: false } | { stop: true; mode: 'stop' | 'kill'; reason: AutopilotStopReason; detail: string };

const usd = (value: number) => `$${value.toFixed(2)}`;

/** Evaluated on every scheduler tick. Security denials kill (possible prompt injection); everything else stops. */
export function evaluateSessionStop(session: Pick<AutopilotSession, 'endsAt' | 'budgetUsd' | 'stopPolicy'>, stats: AutopilotSessionStats, now: Date): StopEvaluation {
  const policy = session.stopPolicy;
  if (stats.securityDenials >= policy.maxSecurityDenials) {
    const minutes = Math.round(policy.securityDenialWindowMs / 60_000);
    return { stop: true, mode: 'kill', reason: 'security_denials', detail: `${stats.securityDenials} security denials within ${minutes} min` };
  }
  if (now.getTime() >= session.endsAt.getTime()) {
    return { stop: true, mode: 'stop', reason: 'time_box', detail: `time box ended at ${session.endsAt.toISOString()}` };
  }
  if (stats.spentUsd >= session.budgetUsd) {
    return { stop: true, mode: 'stop', reason: 'budget_exhausted', detail: `spent ${usd(stats.spentUsd)} of ${usd(session.budgetUsd)}` };
  }

  let failures = 0;
  for (let i = stats.finishedRuns.length - 1; i >= 0; i--) {
    const status = stats.finishedRuns[i]!.status;
    if (status === 'CANCELLED') continue; // a human decision, not a failure of the autopilot
    if (status !== 'BLOCKED' && status !== 'FAILED') break;
    failures++;
  }
  if (failures >= policy.maxConsecutiveFailures) {
    return { stop: true, mode: 'stop', reason: 'failure_streak', detail: `${failures} consecutive runs blocked or failed` };
  }

  let red = 0;
  for (let i = stats.ciResults.length - 1; i >= 0; i--) {
    const result = stats.ciResults[i]!;
    if (result.passed) break;
    // Infrastructure and unclassified failures are retried by the pipeline and say nothing about the code.
    if (result.classification === 'code') red++;
  }
  if (red >= policy.maxCiRedStreak) {
    return { stop: true, mode: 'stop', reason: 'ci_red_streak', detail: `${red} consecutive CI code failures` };
  }

  if (stats.spentLastHourUsd > policy.maxUsdPerHour) {
    return { stop: true, mode: 'stop', reason: 'cost_anomaly', detail: `spent ${usd(stats.spentLastHourUsd)} in the last hour (limit ${usd(policy.maxUsdPerHour)}/h)` };
  }
  return { stop: false };
}
