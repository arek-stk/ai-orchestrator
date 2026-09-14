import type { z } from 'zod';
import type { AgentRole, TaskKind } from '../domain/enums';
import type { Task } from '../domain/task';
import type { ToolName } from '../tools/tool-router';
import type { AgentDefinition } from './definitions';
import type { AgentOutcome, AgentRuntime, RunAgentRequest } from './runtime';

export interface AgentPlan {
  role: AgentRole;
  steps: string[];
  tools: readonly ToolName[];
  expectedOutputTokens: number;
}

export interface VerificationResult {
  ok: boolean;
  issues: string[];
}

export type AgentExecutionContext<S extends z.ZodType> = Omit<RunAgentRequest<S>, 'definition'>;

/** Uniform agent contract (spec §26). The orchestrator stays in charge of what happens with results. */
export interface Agent<S extends z.ZodType> {
  readonly id: string;
  readonly role: AgentRole;
  canHandle(task: Pick<Task, 'kind'>): boolean;
  plan(task: Pick<Task, 'title'>): Promise<AgentPlan>;
  execute(task: Pick<Task, 'title'>, context: AgentExecutionContext<S>): Promise<AgentOutcome<z.infer<S>>>;
  verify(result: AgentOutcome<z.infer<S>>): Promise<VerificationResult>;
}

/** Model-backed agent: definition (prompt, schema, checks) + shared runtime (routing, budgets, audit). */
export class LlmAgent<S extends z.ZodType> implements Agent<S> {
  readonly id: string;
  readonly role: AgentRole;

  constructor(
    private readonly definition: AgentDefinition<S>,
    private readonly runtime: AgentRuntime,
    private readonly handles: readonly TaskKind[] | 'all' = 'all',
  ) {
    this.id = `agent:${definition.key}`;
    this.role = definition.role;
  }

  canHandle(task: Pick<Task, 'kind'>): boolean {
    return this.handles === 'all' || this.handles.includes(task.kind);
  }

  async plan(task: Pick<Task, 'title'>): Promise<AgentPlan> {
    return {
      role: this.role,
      steps: [`${this.definition.name} produces ${this.definition.schemaName} for "${task.title}"`],
      tools: this.definition.tools,
      expectedOutputTokens: this.definition.expectedOutputTokens,
    };
  }

  execute(_task: Pick<Task, 'title'>, context: AgentExecutionContext<S>): Promise<AgentOutcome<z.infer<S>>> {
    return this.runtime.run({ ...context, definition: this.definition });
  }

  async verify(result: AgentOutcome<z.infer<S>>): Promise<VerificationResult> {
    if (!result.ok) return { ok: false, issues: result.issues.length > 0 ? result.issues : [result.error] };
    const issues = this.definition.verify ? this.definition.verify(result.output) : [];
    return { ok: issues.length === 0, issues };
  }
}
