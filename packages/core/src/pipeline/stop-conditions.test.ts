import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_CONDITIONS } from '../domain/project';
import { canAttemptDebug, checkStopConditions, type RunCounters } from './stop-conditions';

const start = new Date('2026-09-14T10:00:00Z');
const counters = (extra: Partial<RunCounters> = {}): RunCounters => ({
  iterations: 0,
  costUsd: 0,
  tokens: 0,
  debugAttempts: 0,
  startedAt: start,
  ...extra,
});

describe('stop conditions', () => {
  const limits = { ...DEFAULT_STOP_CONDITIONS };

  it('continues while all limits have headroom', () => {
    expect(checkStopConditions(counters({ iterations: 3, costUsd: 1 }), limits, start)).toEqual({ stop: false });
  });

  it.each([
    [{ iterations: limits.maxIterations }, 'max_iterations'],
    [{ costUsd: limits.maxCostUsd }, 'max_cost'],
    [{ tokens: limits.maxTokens }, 'max_tokens'],
  ] as const)('stops on %o', (extra, reason) => {
    expect(checkStopConditions(counters(extra), limits, start)).toMatchObject({ stop: true, reason });
  });

  it('stops when runtime is exceeded', () => {
    const later = new Date(start.getTime() + limits.maxRuntimeMs);
    expect(checkStopConditions(counters(), limits, later)).toMatchObject({ stop: true, reason: 'max_runtime' });
  });

  it('allows exactly maxDebugAttempts debug attempts', () => {
    expect(canAttemptDebug({ debugAttempts: 2 }, { maxDebugAttempts: 3 })).toBe(true);
    expect(canAttemptDebug({ debugAttempts: 3 }, { maxDebugAttempts: 3 })).toBe(false);
  });
});
