export type BudgetScopeKind = 'global' | 'project' | 'task' | 'agent';

export interface BudgetScope {
  scope: BudgetScopeKind;
  /** null = unlimited */
  limitUsd: number | null;
  spentUsd: number;
}

export interface BudgetCheckInput {
  estimatedCostUsd: number;
  scopes: readonly BudgetScope[];
}

export type BudgetDecision =
  | { decision: 'allow'; headroomUsd: number }
  | { decision: 'degrade'; headroomUsd: number; limitingScope: BudgetScopeKind; reason: string }
  | { decision: 'pause'; headroomUsd: 0; limitingScope: BudgetScopeKind; reason: string };

/**
 * Cost gate executed before every model call (spec §29).
 * - pause:   some scope has no money left → stop calling models.
 * - degrade: the call would overrun a scope → choose a cheaper model / smaller context / cached result.
 * - allow:   the estimate fits into every scope.
 */
export function checkBudget(input: BudgetCheckInput): BudgetDecision {
  let headroom = Number.POSITIVE_INFINITY;
  let limiting: BudgetScopeKind | null = null;

  for (const scope of input.scopes) {
    if (scope.limitUsd === null) continue;
    const remaining = scope.limitUsd - scope.spentUsd;
    if (remaining < headroom) {
      headroom = remaining;
      limiting = scope.scope;
    }
  }

  if (limiting === null) return { decision: 'allow', headroomUsd: Number.POSITIVE_INFINITY };
  if (headroom <= 0) {
    return { decision: 'pause', headroomUsd: 0, limitingScope: limiting, reason: `${limiting} budget exhausted` };
  }
  if (input.estimatedCostUsd > headroom) {
    return {
      decision: 'degrade',
      headroomUsd: headroom,
      limitingScope: limiting,
      reason: `estimated $${input.estimatedCostUsd.toFixed(4)} exceeds remaining ${limiting} budget $${headroom.toFixed(4)}`,
    };
  }
  return { decision: 'allow', headroomUsd: headroom };
}
