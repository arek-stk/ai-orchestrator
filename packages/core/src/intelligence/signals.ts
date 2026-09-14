import { importerCounts } from '../context/file-summarizer';
import { isContextEligible, type IndexedFile } from '../context/context-builder';
import type { RunStatus } from '../domain/enums';
import type { MemoryItem } from '../domain/records';
import type { Task } from '../domain/task';
import { isSensitivePath } from '../security/paths';
import type { HealthBreakdownItem, HealthSignals } from './types';

// Deterministic project signals and the health score (spec §14). No model is involved, so the score is
// reproducible and explainable from the persisted signals.

export interface SignalInputs {
  files: readonly IndexedFile[];
  manifests: ReadonlyArray<{ path: string; content: string }>;
  failures: readonly MemoryItem[];
  runs: ReadonlyArray<{ status: RunStatus }>;
  blockedTasks: ReadonlyArray<Pick<Task, 'id' | 'title' | 'blockedReason'>>;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte)$/i;
const TEST = /((\.|_)(test|spec)\.[^/]+$)|((^|\/)(__tests__|tests?|spec|e2e)\/)|((^|\/)test_[^/]+\.py$)/i;
const NOT_A_MODULE = /(\.d\.ts$)|((^|\/)(index|main|mod)\.[^/]+$)|((^|\/)[^/]*\.config\.[^/]+$)|((^|\/)(migrations?|scripts?|examples?|fixtures?)\/)/i;
const MANIFEST = /(^|\/)(package\.json|requirements(-dev)?\.txt)$/;
const CI_FILE = /(^\.github\/workflows\/[^/]+\.ya?ml$)|(^\.gitlab-ci\.ya?ml$)|(^Jenkinsfile$)|(^azure-pipelines\.ya?ml$)/i;
const DOCKER_FILE = /(^|\/)(Dockerfile(\.[^/]*)?|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i;
const LARGE_MODULE_BYTES = 40_000;

export const MAX_MANIFESTS = 5;

export function isTestPath(path: string): boolean {
  return TEST.test(path);
}

export function isSourcePath(path: string): boolean {
  return SOURCE.test(path) && !isTestPath(path) && isContextEligible(path);
}

/** Dependency manifests to read, shallowest first (the root manifest matters most). */
export function selectManifests(files: readonly IndexedFile[], max = MAX_MANIFESTS): string[] {
  return files
    .map((f) => f.path)
    .filter((path) => MANIFEST.test(path) && isContextEligible(path))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, max);
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/^test_/, '')
    .replace(/[._](test|spec)$/i, '')
    .toLowerCase();
}

/** Unpinned or unbounded dependency ranges: builds are not reproducible and may pull breaking releases. */
export function findUnpinnedDependencies(manifest: { path: string; content: string }): Array<{ name: string; range: string }> {
  const found: Array<{ name: string; range: string }> = [];
  if (manifest.path.endsWith('package.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.content);
    } catch {
      return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = (parsed as Record<string, unknown>)[field];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        const range = value.trim();
        const unbounded = range === '' || range === '*' || range === 'x' || range === 'latest' || range === 'next' || (/^>=?/.test(range) && !range.includes('<'));
        if (unbounded) found.push({ name, range: range || '(empty)' });
      }
    }
    return found;
  }
  for (const raw of manifest.content.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!match) continue;
    const spec = match[3]!.trim();
    if (!/(==|~=|<)/.test(spec)) found.push({ name: match[1]!, range: spec || '(any)' });
  }
  return found;
}

export function collectSignals(inputs: SignalInputs): HealthSignals {
  const paths = inputs.files.map((f) => f.path);
  const source = inputs.files.filter((f) => isSourcePath(f.path));
  const tests = paths.filter((p) => SOURCE.test(p) && isTestPath(p));
  const testedStems = new Set(tests.map(stemOf));
  const importers = importerCounts(inputs.files);

  const untestedModules = source
    .filter((f) => !NOT_A_MODULE.test(f.path) && !testedStems.has(stemOf(f.path)))
    .map((f) => ({ path: f.path, importers: importers.get(f.path) ?? 0 }))
    .sort((a, b) => b.importers - a.importers || a.path.localeCompare(b.path))
    .slice(0, 10);

  const rootDoc = (re: RegExp) => paths.some((p) => !p.includes('/') && re.test(p));
  const unpinned = inputs.manifests.flatMap((m) => findUnpinnedDependencies(m).map((d) => ({ manifest: m.path, ...d }))).slice(0, 30);
  const totalDependencies = inputs.manifests.reduce((sum, m) => {
    if (!m.path.endsWith('package.json')) return sum + m.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('-')).length;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      return sum + Object.keys((parsed.dependencies as object) ?? {}).length + Object.keys((parsed.devDependencies as object) ?? {}).length;
    } catch {
      return sum;
    }
  }, 0);

  return {
    files: {
      total: inputs.files.length,
      source: source.length,
      tests: tests.length,
      largeModules: source.filter((f) => f.size > LARGE_MODULE_BYTES).map((f) => f.path).slice(0, 10),
    },
    untestedModules,
    docs: { readme: rootDoc(/^readme(\.[a-z]+)?$/i), changelog: rootDoc(/^(changelog|changes|history)(\.[a-z]+)?$/i), contributing: rootDoc(/^contributing(\.[a-z]+)?$/i) },
    ci: { workflows: paths.filter((p) => CI_FILE.test(p)).slice(0, 20), dockerfiles: paths.filter((p) => DOCKER_FILE.test(p) && isContextEligible(p)).slice(0, 10) },
    sensitiveFiles: paths.filter(isSensitivePath).slice(0, 20),
    dependencies: { manifests: inputs.manifests.map((m) => m.path), unpinned, total: totalDependencies },
    failures: inputs.failures
      .slice()
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10)
      .map((f) => ({ key: f.key, summary: summaryOf(f.content), hits: f.hits })),
    runs: {
      total: inputs.runs.length,
      succeeded: inputs.runs.filter((r) => r.status === 'SUCCEEDED').length,
      failed: inputs.runs.filter((r) => r.status === 'FAILED').length,
      blocked: inputs.runs.filter((r) => r.status === 'BLOCKED').length,
    },
    blockedTasks: inputs.blockedTasks.slice(0, 10).map((t) => ({ id: t.id, title: t.title, reason: t.blockedReason })),
  };
}

function summaryOf(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown; rootCause?: unknown };
    const text = [parsed.summary, parsed.rootCause].filter((v) => typeof v === 'string').join(' — ');
    if (text) return text.slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw content.
  }
  return content.slice(0, 300);
}

/** Health score 0–100: 100 minus capped penalties per component. */
export function computeHealthScore(signals: HealthSignals): { score: number; breakdown: HealthBreakdownItem[] } {
  const item = (component: HealthBreakdownItem['component'], maxPenalty: number, raw: number, detail: string): HealthBreakdownItem => ({
    component,
    maxPenalty,
    penalty: Math.round(Math.min(maxPenalty, Math.max(0, raw)) * 10) / 10,
    detail,
  });

  const { files, dependencies, failures, runs, blockedTasks, docs, sensitiveFiles } = signals;
  const testRatio = files.source === 0 ? 1 : files.tests / files.source;
  const recurring = failures.filter((f) => f.hits >= 2).length;
  const finishedBad = runs.failed + runs.blocked;
  const docsPenalty = (docs.readme ? 0 : 6) + (docs.changelog ? 0 : 2) + (docs.contributing ? 0 : 2);

  const breakdown = [
    item('tests', 25, files.source === 0 ? 0 : 25 * (1 - Math.min(1, testRatio / 0.5)), `${files.tests} test file(s) for ${files.source} source file(s)`),
    item('dependencies', 15, 3 * dependencies.unpinned.length, `${dependencies.unpinned.length} unpinned of ${dependencies.total} dependencies`),
    item('failures', 15, 5 * recurring + 2 * (failures.length - recurring), `${failures.length} remembered failure(s), ${recurring} recurring`),
    item('runs', 15, runs.total >= 3 ? 15 * (finishedBad / runs.total) : 0, `${finishedBad} of ${runs.total} recent run(s) failed or blocked`),
    item('blocked', 10, 3 * blockedTasks.length, `${blockedTasks.length} blocked task(s)`),
    item('documentation', 10, docsPenalty, `README ${docs.readme ? 'present' : 'missing'}, CHANGELOG ${docs.changelog ? 'present' : 'missing'}, CONTRIBUTING ${docs.contributing ? 'present' : 'missing'}`),
    item('security', 20, 10 * sensitiveFiles.length, `${sensitiveFiles.length} committed sensitive file(s)`),
    item('maintainability', 10, 2 * files.largeModules.length, `${files.largeModules.length} module(s) above ${LARGE_MODULE_BYTES / 1000} KB`),
  ];
  const score = Math.max(0, Math.round((100 - breakdown.reduce((sum, b) => sum + b.penalty, 0)) * 10) / 10);
  return { score, breakdown };
}
