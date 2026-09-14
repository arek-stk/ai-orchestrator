import { AGENT_DEFINITIONS } from '../agents/definitions';
import type { AgentRuntime } from '../agents/runtime';
import type { ResearchOutput } from '../agents/schemas';
import { questionKey, truncate } from '../orchestrator/helpers';
import type { EventRecorder, MemoryRepository, ProjectRepository, TaskRepository } from '../ports';

export const RESEARCH_JOB = 'project.research';

export interface ResearchDeps {
  projects: ProjectRepository;
  tasks: TaskRepository;
  memories: MemoryRepository;
  events: EventRecorder;
  runtime: AgentRuntime;
}

export interface ResearchRequest {
  projectId: string;
  question: string;
  /** When set, the result is linked to the task and PLAN includes it. */
  taskId: string | null;
}

export type ResearchResult = { ok: true; memoryKey: string; output: ResearchOutput; costUsd: number } | { ok: false; error: string; costUsd: number };

/**
 * Runs the Research agent. It is never part of the default pipeline: only an explicit request activates it (spec §5,
 * "no unnecessary agents"). The result is stored as memory so the orchestrator can use it without calling it again.
 */
export async function runResearch(deps: ResearchDeps, request: ResearchRequest): Promise<ResearchResult> {
  const project = await deps.projects.get(request.projectId);
  if (!project) return { ok: false, error: 'project not found', costUsd: 0 };
  const task = request.taskId ? await deps.tasks.get(request.taskId) : null;
  if (request.taskId && (!task || task.projectId !== project.id)) return { ok: false, error: 'task not found in this project', costUsd: 0 };

  const context = await deps.memories.search(project.id, { scope: 'project', limit: 20 });
  const analysis = context.find((m) => m.key === 'analysis:latest');
  const health = context.find((m) => m.key === 'health:latest');
  const question = request.question.trim();

  const outcome = await deps.runtime.run({
    definition: AGENT_DEFINITIONS.research,
    input: {
      project: { name: project.name, description: project.description, languages: project.profile.languages },
      task: task ?? {
        title: truncate(`Research: ${question}`, 200),
        goal: question,
        kind: 'chore',
        risk: 'low',
        estimatedComplexity: 'medium',
        acceptanceCriteria: [],
      },
      question,
      sections: [
        ...(analysis ? [{ title: 'Latest project analysis', body: truncate(analysis.content, 6_000) }] : []),
        ...(health ? [{ title: 'Latest health scan', body: truncate(health.content, 3_000) }] : []),
      ],
      files: [],
    },
    scope: { projectId: project.id, taskId: task?.id ?? null, runId: null },
    complexity: 'medium',
    risk: 'low',
    projectRoleOverrides: project.settings.modelOverrides,
  });
  if (!outcome.ok) return { ok: false, error: `${outcome.kind}: ${outcome.error}`, costUsd: outcome.costUsd };

  const memoryKey = `research:${questionKey([question, task?.id ?? ''])}`;
  await deps.memories.upsert({
    projectId: project.id,
    scope: task ? 'task' : 'project',
    taskId: task?.id ?? null,
    kind: 'research',
    key: memoryKey,
    content: JSON.stringify(outcome.output),
    tags: ['research'],
  });
  await deps.events.emit({
    type: 'research.completed',
    projectId: project.id,
    taskId: task?.id ?? null,
    runId: null,
    payload: { memoryKey, question: truncate(question, 300), confidence: outcome.output.confidence },
  });
  return { ok: true, memoryKey, output: outcome.output, costUsd: outcome.costUsd };
}
