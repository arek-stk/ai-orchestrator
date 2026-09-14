import type { AgentRole, Complexity, Risk } from '../domain/enums';
import type { CouncilSettings } from '../domain/project';
import type { DecisionOption } from '../domain/records';
import { totalTokens } from '../models/types';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { AGENT_DEFINITIONS, type AgentInput } from './definitions';
import type { AgentRuntime, AgentScope } from './runtime';
import type { DesignOpinion } from './schemas';

export interface CouncilOpinion {
  role: AgentRole;
  output: DesignOpinion;
  modelId: string;
  costUsd: number;
}

export interface Synthesis {
  chosenOptionId: string | null;
  /** Confidence-weighted share of support for the chosen option (0–1). */
  agreement: number;
  /** agreement × mean confidence of the supporters. */
  confidence: number;
  support: Record<string, number>;
  options: DecisionOption[];
  dissent: Array<{ role: AgentRole; optionId: string; rationale: string }>;
}

export interface CouncilRequest {
  question: string;
  members: readonly AgentRole[];
  baseInput: AgentInput;
  scope: AgentScope;
  complexity: Complexity;
  risk: Risk;
  settings: CouncilSettings;
  projectRoleOverrides?: Partial<Record<AgentRole, string>>;
}

export type CouncilStopReason = 'consensus' | 'max_rounds' | 'token_limit' | 'timeout' | 'no_opinions';

export interface CouncilResult {
  rounds: CouncilOpinion[][];
  synthesis: Synthesis;
  stoppedBecause: CouncilStopReason;
  /** Confidence stayed below the threshold: the orchestrator must add an expert or ask a human. */
  escalate: boolean;
  costUsd: number;
  tokens: number;
  failures: string[];
}

/** Deterministic synthesis of specialist opinions. Agents propose; this only measures agreement. */
export function synthesizeOpinions(opinions: ReadonlyArray<Pick<CouncilOpinion, 'role' | 'output'>>): Synthesis {
  const options = new Map<string, DecisionOption>();
  const support: Record<string, number> = {};
  let total = 0;

  for (const { output } of opinions) {
    for (const option of output.options) {
      const existing = options.get(option.id);
      if (!existing) options.set(option.id, { id: option.id, summary: option.summary, pros: [...option.pros], cons: [...option.cons] });
      else {
        existing.pros = [...new Set([...existing.pros, ...option.pros])].slice(0, 12);
        existing.cons = [...new Set([...existing.cons, ...option.cons])].slice(0, 12);
      }
    }
    support[output.recommendedOptionId] = (support[output.recommendedOptionId] ?? 0) + output.confidence;
    total += output.confidence;
  }

  const ranked = Object.entries(support).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chosenOptionId = ranked[0]?.[0] ?? null;
  if (chosenOptionId === null || total === 0) {
    return { chosenOptionId: null, agreement: 0, confidence: 0, support, options: [...options.values()], dissent: [] };
  }

  const supporters = opinions.filter((o) => o.output.recommendedOptionId === chosenOptionId);
  const meanSupporterConfidence = supporters.reduce((sum, o) => sum + o.output.confidence, 0) / supporters.length;
  const agreement = support[chosenOptionId]! / total;
  return {
    chosenOptionId,
    agreement,
    confidence: agreement * meanSupporterConfidence,
    support,
    options: [...options.values()],
    dissent: opinions
      .filter((o) => o.output.recommendedOptionId !== chosenOptionId)
      .map((o) => ({ role: o.role, optionId: o.output.recommendedOptionId, rationale: o.output.rationale.slice(0, 500) })),
  };
}

/**
 * Bounded agent council (spec §6): parallel opinions, at most `maxRounds`, stops early on consensus,
 * on the token cap or on timeout. Never loops endlessly; low confidence is escalated, not debated further.
 */
export async function runCouncil(request: CouncilRequest, runtime: AgentRuntime, clock: Clock = systemClock): Promise<CouncilResult> {
  const { settings } = request;
  const deadline = clock.now().getTime() + settings.timeoutMs;
  const rounds: CouncilOpinion[][] = [];
  const failures: string[] = [];
  let costUsd = 0;
  let tokens = 0;
  let synthesis = synthesizeOpinions([]);
  let stoppedBecause: CouncilStopReason = 'max_rounds';

  for (let round = 1; round <= settings.maxRounds; round++) {
    const previous = rounds.at(-1) ?? [];
    const results = await Promise.all(
      request.members.map((role) => {
        const others = previous.filter((o) => o.role !== role);
        const sections = [
          ...request.baseInput.sections,
          { title: 'Your perspective', body: role },
          ...(others.length > 0
            ? [
                {
                  title: 'Positions from other specialists',
                  body: others
                    .map((o) => `- ${o.role}: option ${o.output.recommendedOptionId} (confidence ${o.output.confidence.toFixed(2)}): ${o.output.rationale.slice(0, 400)}`)
                    .join('\n'),
                },
              ]
            : []),
        ];
        return runtime
          .run({
            definition: AGENT_DEFINITIONS.design_opinion,
            role,
            input: { ...request.baseInput, question: request.question, sections },
            scope: request.scope,
            complexity: request.complexity,
            risk: request.risk,
            projectRoleOverrides: request.projectRoleOverrides,
          })
          .then((outcome) => ({ role, outcome }));
      }),
    );

    const opinions: CouncilOpinion[] = [];
    for (const { role, outcome } of results) {
      costUsd += outcome.costUsd;
      tokens += totalTokens(outcome.usage);
      if (outcome.ok) opinions.push({ role, output: outcome.output, modelId: outcome.model.id, costUsd: outcome.costUsd });
      else failures.push(`${role} (round ${round}): ${outcome.error}`);
    }

    if (opinions.length === 0) {
      // Keep the last successful round's synthesis if a later round produced nothing.
      stoppedBecause = rounds.length === 0 ? 'no_opinions' : stoppedBecause;
      break;
    }
    rounds.push(opinions);
    synthesis = synthesizeOpinions(opinions);

    if (synthesis.confidence >= settings.confidenceThreshold) {
      stoppedBecause = 'consensus';
      break;
    }
    if (tokens >= settings.maxTokens) {
      stoppedBecause = 'token_limit';
      break;
    }
    if (clock.now().getTime() >= deadline) {
      stoppedBecause = 'timeout';
      break;
    }
  }

  return {
    rounds,
    synthesis,
    stoppedBecause,
    escalate: synthesis.confidence < settings.confidenceThreshold,
    costUsd,
    tokens,
    failures,
  };
}
