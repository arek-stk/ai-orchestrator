import { AGENT_DEFINITIONS } from '../agents/definitions';
import type { AgentRuntime, AgentScope } from '../agents/runtime';
import type { Project } from '../domain/project';
import { estimateTokens } from '../models/registry';
import { addUsage, ZERO_USAGE, type TokenUsage } from '../models/types';
import { isContextEligible, type ContextFile, type IndexedFile } from './context-builder';

/** Writes summaries to the repository index; implementations only store a summary while the blob sha still matches. */
export interface FileSummaryStore {
  updateSummaries(projectId: string, summaries: ReadonlyArray<{ path: string; sha: string; summary: string }>): Promise<number>;
}

export interface SummarizeFilesRequest {
  runtime: AgentRuntime;
  store: FileSummaryStore;
  project: Pick<Project, 'id' | 'name' | 'description' | 'profile' | 'settings'>;
  files: readonly IndexedFile[];
  loadContent: (path: string) => Promise<string | null>;
  scope: AgentScope;
  /** Most relevant paths first (e.g. the task's ranked files); the rest is ordered by how often files are imported. */
  priorityPaths?: readonly string[];
  batchSize?: number;
  maxBatches?: number;
  /** Smaller files are cheaper to include in full than to summarise. */
  minBytes?: number;
  maxFileTokens?: number;
  runBudgetRemainingUsd?: number | null;
}

export interface SummarizeFilesResult {
  summarized: number;
  batches: number;
  cachedBatches: number;
  costUsd: number;
  usage: TokenUsage;
  /** Fresh summaries by path, so callers can update their in-memory index. */
  summaries: Map<string, string>;
  /** Why summarisation stopped early, if it did. */
  stoppedBecause: string | null;
}

const SUMMARIZABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte)$/i;
const MAX_SUMMARIZABLE_BYTES = 100_000;

function stripExtension(path: string): string {
  return path.replace(/\.[^/.]+$/, '');
}

function resolveRelative(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const part of (dir ? `${dir}/${specifier}` : specifier).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return stripExtension(out.join('/'));
}

/** How many indexed files import each file (relative imports only). Cheap proxy for "central" modules. */
export function importerCounts(files: readonly IndexedFile[]): Map<string, number> {
  const byStem = new Map<string, string>();
  for (const file of files) {
    byStem.set(stripExtension(file.path), file.path);
    if (/\/index\.[^/]+$/.test(file.path)) byStem.set(file.path.slice(0, file.path.lastIndexOf('/')), file.path);
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of file.imports ?? []) {
      const resolved = resolveRelative(file.path, specifier);
      const target = resolved === null ? undefined : byStem.get(resolved);
      if (target && target !== file.path) targets.add(target);
    }
    for (const target of targets) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** Source files without a fresh summary, most relevant first. */
export function selectFilesToSummarize(files: readonly IndexedFile[], options: { priorityPaths?: readonly string[]; limit: number; minBytes: number }): IndexedFile[] {
  const priority = new Map((options.priorityPaths ?? []).map((path, index) => [path, index]));
  const importers = importerCounts(files);
  return files
    .filter((f) => !f.summary && SUMMARIZABLE.test(f.path) && isContextEligible(f.path) && f.size >= options.minBytes && f.size <= MAX_SUMMARIZABLE_BYTES)
    .sort((a, b) => {
      const pa = priority.get(a.path) ?? Number.MAX_SAFE_INTEGER;
      const pb = priority.get(b.path) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || (importers.get(b.path) ?? 0) - (importers.get(a.path) ?? 0) || b.size - a.size || a.path.localeCompare(b.path);
    })
    .slice(0, options.limit);
}

/**
 * Fills repository index summaries with the fast-tier file summarizer (spec §31). Bounded by batch size and
 * batch count; summaries are keyed by blob sha, so unchanged files are never summarised twice.
 */
export async function summarizeFiles(request: SummarizeFilesRequest): Promise<SummarizeFilesResult> {
  const batchSize = request.batchSize ?? 6;
  const maxBatches = request.maxBatches ?? 2;
  const maxChars = (request.maxFileTokens ?? 6_000) * 4;
  const result: SummarizeFilesResult = { summarized: 0, batches: 0, cachedBatches: 0, costUsd: 0, usage: { ...ZERO_USAGE }, summaries: new Map(), stoppedBecause: null };
  const candidates = selectFilesToSummarize(request.files, { priorityPaths: request.priorityPaths ?? [], limit: batchSize * maxBatches, minBytes: request.minBytes ?? 2_000 });

  for (let offset = 0; offset < candidates.length && result.batches < maxBatches; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const contextFiles: ContextFile[] = [];
    for (const file of batch) {
      const content = await request.loadContent(file.path);
      if (content === null) continue;
      const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}\n…[truncated]` : content;
      contextFiles.push({ path: file.path, mode: 'full', content: clipped, tokens: estimateTokens(clipped), reasons: ['summary missing'] });
    }
    if (contextFiles.length === 0) continue;

    result.batches++;
    const remaining = request.runBudgetRemainingUsd === undefined || request.runBudgetRemainingUsd === null ? null : Math.max(0, request.runBudgetRemainingUsd - result.costUsd);
    const outcome = await request.runtime.run({
      definition: AGENT_DEFINITIONS.file_summary,
      input: {
        project: { name: request.project.name, description: request.project.description, languages: request.project.profile.languages },
        task: {
          title: 'Summarise repository files',
          goal: 'Produce compact summaries for the repository index.',
          kind: 'chore',
          risk: 'low',
          estimatedComplexity: 'simple',
          acceptanceCriteria: [],
        },
        sections: [{ title: 'Files to summarise', body: contextFiles.map((f) => `- ${f.path}`).join('\n') }],
        files: contextFiles,
      },
      scope: request.scope,
      complexity: 'simple',
      risk: 'low',
      projectRoleOverrides: request.project.settings.modelOverrides,
      ...(remaining !== null ? { runBudgetRemainingUsd: remaining } : {}),
    });
    result.costUsd += outcome.costUsd;
    result.usage = addUsage(result.usage, outcome.usage);
    if (!outcome.ok) {
      result.stoppedBecause = `${outcome.kind}: ${outcome.error}`.slice(0, 300);
      break;
    }
    if (outcome.cached) result.cachedBatches++;

    const shaByPath = new Map(batch.map((f) => [f.path, f.sha]));
    const accepted = outcome.output.summaries.filter((s) => shaByPath.has(s.path));
    const stored = await request.store.updateSummaries(
      request.project.id,
      accepted.map((s) => ({ path: s.path, sha: shaByPath.get(s.path)!, summary: s.summary })),
    );
    result.summarized += stored;
    for (const summary of accepted) result.summaries.set(summary.path, summary.summary);
  }
  return result;
}
