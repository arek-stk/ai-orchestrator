import type { StopConditions } from '../domain/project';

export interface RunCounters {
  iterations: number;
  costUsd: number;
  tokens: number;
  debugAttempts: number;
  startedAt: Date;
  /** Time spent PARKED waiting for a human (autopilot); it does not count towards the runtime limit. */
  parkedMs?: number;
}

export type StopReason = 'max_iterations' | 'max_cost' | 'max_tokens' | 'max_runtime' | 'max_debug_attempts';

export type StopCheck = { stop: false } | { stop: true; reason: StopReason; detail: string };

/** Hard limits that end a pipeline run (spec §7). Checked before every step. */
export function checkStopConditions(counters: RunCounters, limits: StopConditions, now: Date): StopCheck {
  if (counters.iterations >= limits.maxIterations) {
    return { stop: true, reason: 'max_iterations', detail: `${counters.iterations}/${limits.maxIterations} iterations used` };
  }
  if (counters.costUsd >= limits.maxCostUsd) {
    return { stop: true, reason: 'max_cost', detail: `$${counters.costUsd.toFixed(4)} of $${limits.maxCostUsd.toFixed(2)} spent` };
  }
  if (counters.tokens >= limits.maxTokens) {
    return { stop: true, reason: 'max_tokens', detail: `${counters.tokens}/${limits.maxTokens} tokens used` };
  }
  const runtime = now.getTime() - counters.startedAt.getTime() - Math.max(0, counters.parkedMs ?? 0);
  if (runtime >= limits.maxRuntimeMs) {
    return { stop: true, reason: 'max_runtime', detail: `ran ${Math.round(runtime / 1000)}s of ${Math.round(limits.maxRuntimeMs / 1000)}s` };
  }
  return { stop: false };
}

/** Whether another debug attempt is allowed. After `maxDebugAttempts` failures the run is BLOCKED. */
export function canAttemptDebug(counters: Pick<RunCounters, 'debugAttempts'>, limits: Pick<StopConditions, 'maxDebugAttempts'>): boolean {
  return counters.debugAttempts < limits.maxDebugAttempts;
}
