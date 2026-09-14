import { describe, expect, it } from 'vitest';
import { checkBudget } from './budget-guard';

describe('checkBudget', () => {
  it('allows calls that fit every scope', () => {
    const result = checkBudget({
      estimatedCostUsd: 0.1,
      scopes: [
        { scope: 'global', limitUsd: 25, spentUsd: 3 },
        { scope: 'project', limitUsd: 10, spentUsd: 9 },
        { scope: 'task', limitUsd: null, spentUsd: 100 },
      ],
    });
    expect(result.decision).toBe('allow');
    expect(result.headroomUsd).toBeCloseTo(1);
  });

  it('degrades when the estimate would overrun the tightest scope', () => {
    const result = checkBudget({
      estimatedCostUsd: 0.5,
      scopes: [
        { scope: 'global', limitUsd: 25, spentUsd: 3 },
        { scope: 'task', limitUsd: 1, spentUsd: 0.8 },
      ],
    });
    expect(result).toMatchObject({ decision: 'degrade', limitingScope: 'task' });
  });

  it('pauses when any scope is exhausted', () => {
    const result = checkBudget({
      estimatedCostUsd: 0.01,
      scopes: [
        { scope: 'global', limitUsd: 25, spentUsd: 25 },
        { scope: 'project', limitUsd: 10, spentUsd: 1 },
      ],
    });
    expect(result).toMatchObject({ decision: 'pause', limitingScope: 'global' });
  });

  it('allows everything when no limits are configured', () => {
    expect(checkBudget({ estimatedCostUsd: 99, scopes: [{ scope: 'agent', limitUsd: null, spentUsd: 0 }] }).decision).toBe('allow');
  });
});
