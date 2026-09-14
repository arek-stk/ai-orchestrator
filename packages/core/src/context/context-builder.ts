import type { Task } from '../domain/task';
import { estimateTokens } from '../models/registry';
import { isSensitivePath } from '../security/paths';
import { redactSecrets } from '../security/secrets';

/** One entry of the repository index (repo_files). */
export interface IndexedFile {
  path: string;
  sha: string;
  size: number;
  summary?: string | null;
  symbols?: readonly string[];
  imports?: readonly string[];
}

export interface ContextRequest {
  task: Pick<Task, 'title' | 'goal' | 'acceptanceCriteria'>;
  files: readonly IndexedFile[];
  tokenBudget: number;
  /** Paths that must be included (e.g. files named in the plan or a failing test). */
  pinnedPaths?: readonly string[];
  /** Extra text that should steer relevance, e.g. failure output or plan areas. */
  hints?: readonly string[];
  maxFiles?: number;
}

export interface RankedFile {
  path: string;
  score: number;
  reasons: string[];
}

export interface ContextFile {
  path: string;
  mode: 'full' | 'summary';
  content: string;
  tokens: number;
  reasons: string[];
}

export interface BuiltContext {
  files: ContextFile[];
  totalTokens: number;
  omitted: RankedFile[];
}

const STOPWORDS = new Set(
  (
    'the and for with that this from into when then than have has are was were will would should could can not you your ' +
    'use using add adds added make makes all any each every must also only more most such via per new old get set ' +
    'implement implementation feature task user users should able ensure support' +
    ' der die das und oder mit für von bei ist sind wird werden soll sollen kann können nicht ein eine einen dem den des auf aus'
  ).split(/\s+/),
);

const EXCLUDED_PATHS: readonly RegExp[] = [
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor|\.git|\.turbo|\.cache)\//,
  /\.(lock|min\.js|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|gz|tar|mp4|mp3|wasm)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$/,
];

const LARGE_FILE_BYTES = 150_000;

export function extractKeywords(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function countMatches(keywords: readonly string[], candidates: readonly string[]): string[] {
  return keywords.filter((k) => candidates.some((c) => tokensMatch(k, c)));
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function resolveImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = (dirname(fromPath) ? `${dirname(fromPath)}/${specifier}` : specifier).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function stripExtension(path: string): string {
  return path.replace(/\.[^/.]+$/, '');
}

export function isContextEligible(path: string): boolean {
  return !EXCLUDED_PATHS.some((re) => re.test(path)) && !isSensitivePath(path);
}

/** Relevance ranking of repository files for a task (spec §9). Deterministic and cheap: no model calls. */
export function rankFiles(request: ContextRequest): RankedFile[] {
  const keywords = extractKeywords([request.task.title, request.task.goal, ...request.task.acceptanceCriteria].join(' '));
  const hintText = (request.hints ?? []).join('\n');
  const hintKeywords = extractKeywords(hintText);
  const pinned = new Set(request.pinnedPaths ?? []);

  const scored = new Map<string, RankedFile>();
  for (const file of request.files) {
    if (!isContextEligible(file.path)) continue;
    let score = 0;
    const reasons: string[] = [];

    if (pinned.has(file.path)) {
      score += 100;
      reasons.push('pinned');
    }
    const pathMatches = countMatches(keywords, extractKeywords(file.path));
    if (pathMatches.length > 0) {
      score += 3 * pathMatches.length;
      reasons.push(`path matches ${pathMatches.join(', ')}`);
    }
    const symbolMatches = countMatches(keywords, extractKeywords((file.symbols ?? []).join(' ')));
    if (symbolMatches.length > 0) {
      score += 4 * Math.min(5, symbolMatches.length);
      reasons.push(`symbols match ${symbolMatches.slice(0, 5).join(', ')}`);
    }
    if (file.summary) {
      const summaryMatches = countMatches(keywords, extractKeywords(file.summary));
      if (summaryMatches.length > 0) {
        score += Math.min(6, summaryMatches.length);
        reasons.push('summary is relevant');
      }
    }
    const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
    if (hintText.includes(file.path) || (basename.length > 4 && hintText.includes(basename))) {
      score += 12;
      reasons.push('mentioned in failure/plan');
    } else {
      const hintMatches = countMatches(hintKeywords, extractKeywords(file.path));
      if (hintMatches.length > 0) {
        score += 2 * hintMatches.length;
        reasons.push('related to hints');
      }
    }
    if (file.size > LARGE_FILE_BYTES) score -= 5;
    if (score > 0) scored.set(file.path, { path: file.path, score, reasons });
  }

  // Dependency neighbours of the most relevant files get a smaller boost.
  const byStem = new Map<string, IndexedFile>();
  for (const file of request.files) {
    byStem.set(stripExtension(file.path), file);
    if (/\/index\.[^/]+$/.test(file.path)) byStem.set(dirname(file.path), file);
  }
  const top = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  const topFiles = new Map(request.files.map((f) => [f.path, f]));
  for (const ranked of top) {
    for (const specifier of topFiles.get(ranked.path)?.imports ?? []) {
      const resolved = resolveImport(ranked.path, specifier);
      const target = resolved ? byStem.get(resolved) : undefined;
      if (!target || target.path === ranked.path || !isContextEligible(target.path)) continue;
      const existing = scored.get(target.path) ?? { path: target.path, score: 0, reasons: [] };
      existing.score += 2;
      existing.reasons.push(`imported by ${ranked.path}`);
      scored.set(target.path, existing);
    }
  }

  return [...scored.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Builds the minimal task-specific context: most relevant files first, full content while it fits,
 * cached summaries otherwise. Content is redacted before it can reach any model.
 */
export async function buildContext(
  request: ContextRequest,
  loadContent: (path: string) => Promise<string | null>,
): Promise<BuiltContext> {
  const ranked = rankFiles(request).slice(0, request.maxFiles ?? 40);
  const summaries = new Map(request.files.map((f) => [f.path, f.summary ?? null]));
  const files: ContextFile[] = [];
  const omitted: RankedFile[] = [];
  let remaining = request.tokenBudget;

  for (const entry of ranked) {
    const raw = await loadContent(entry.path);
    if (raw !== null) {
      const content = redactSecrets(raw);
      const tokens = estimateTokens(content);
      if (tokens <= remaining) {
        files.push({ path: entry.path, mode: 'full', content, tokens, reasons: entry.reasons });
        remaining -= tokens;
        continue;
      }
    }
    const summary = summaries.get(entry.path);
    if (summary) {
      const content = redactSecrets(summary);
      const tokens = estimateTokens(content);
      if (tokens <= remaining) {
        files.push({ path: entry.path, mode: 'summary', content, tokens, reasons: entry.reasons });
        remaining -= tokens;
        continue;
      }
    }
    omitted.push(entry);
  }

  return { files, totalTokens: request.tokenBudget - remaining, omitted };
}
