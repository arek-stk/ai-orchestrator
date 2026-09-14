import { isContextEligible, type IndexedFile } from '../context/context-builder';
import type { GitHubPort, RepoCoordinates } from '../github/port';

/** Persistence for the repository index (repo_files). */
export interface RepoFileStore {
  list(projectId: string): Promise<IndexedFile[]>;
  replace(projectId: string, files: readonly IndexedFile[]): Promise<void>;
}

export interface IndexResult {
  headSha: string;
  files: IndexedFile[];
  fetched: number;
  reused: number;
  truncated: boolean;
}

export interface RepoIndexerOptions {
  /** Maximum file contents fetched per refresh (changed files first come, first served). */
  maxFetch?: number;
  maxFileBytes?: number;
  concurrency?: number;
}

const INDEXABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte)$/i;
const MAX_SYMBOLS = 60;

const SYMBOL_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*def\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm,
  /^func\s+(?:\([^)\n]{0,200}\)\s*)?([A-Za-z_]\w*)/gm,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
  /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:[\w*{}\s,$]{0,500}\s+from\s+)?['"]([^'"\n]{1,300})['"]/g,
  /\bexport\s+[\w*{}\s,$]{0,500}\s+from\s+['"]([^'"\n]{1,300})['"]/g,
  /\brequire\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g,
  /^\s*from\s+([.\w]{1,200})\s+import\b/gm,
];

function collect(patterns: readonly RegExp[], content: string, limit: number): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of content.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (match[1]) found.add(match[1]);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

export function extractSymbols(content: string): string[] {
  return collect(SYMBOL_PATTERNS, content, MAX_SYMBOLS);
}

export function extractImports(content: string): string[] {
  return collect(IMPORT_PATTERNS, content, MAX_SYMBOLS);
}

/**
 * Keeps a lightweight repository index (spec §9): tree with blob SHAs, plus symbols and imports for source
 * files. Unchanged blobs reuse stored data, so refreshes after small commits only fetch what changed.
 */
export class RepoIndexer {
  private readonly maxFetch: number;
  private readonly maxFileBytes: number;
  private readonly concurrency: number;

  constructor(
    private readonly github: GitHubPort,
    private readonly store: RepoFileStore,
    options: RepoIndexerOptions = {},
  ) {
    this.maxFetch = options.maxFetch ?? 300;
    this.maxFileBytes = options.maxFileBytes ?? 100_000;
    this.concurrency = options.concurrency ?? 8;
  }

  async refresh(projectId: string, repo: RepoCoordinates, branch: string): Promise<IndexResult> {
    const headSha = await this.github.getBranchSha(repo, branch);
    if (!headSha) throw new Error(`branch ${branch} not found in ${repo.owner}/${repo.name}`);
    const tree = await this.github.getTree(repo, headSha);
    const previous = new Map((await this.store.list(projectId)).map((f) => [f.path, f]));

    const files: IndexedFile[] = [];
    const toFetch: IndexedFile[] = [];
    let reused = 0;

    for (const entry of tree.entries) {
      const known = previous.get(entry.path);
      if (known && known.sha === entry.sha) {
        files.push(known);
        reused++;
        continue;
      }
      const file: IndexedFile = { path: entry.path, sha: entry.sha, size: entry.size, summary: null, symbols: [], imports: [] };
      files.push(file);
      if (INDEXABLE.test(entry.path) && entry.size <= this.maxFileBytes && isContextEligible(entry.path) && toFetch.length < this.maxFetch) {
        toFetch.push(file);
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < toFetch.length) {
        const file = toFetch[cursor++]!;
        const content = await this.github.getFileContent(repo, file.path, headSha);
        if (content === null) continue;
        file.symbols = extractSymbols(content);
        file.imports = extractImports(content);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, toFetch.length) }, worker));

    await this.store.replace(projectId, files);
    return { headSha, files, fetched: toFetch.length, reused, truncated: tree.truncated };
  }
}
