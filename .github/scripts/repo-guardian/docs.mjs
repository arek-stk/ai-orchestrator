// @ts-check
// Filesystem and git collection for the docs consistency check. Only fixed arguments reach `git`; it is started
// without a shell.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseBlamePorcelain } from './lib.mjs';

const ROOT_MARKDOWN_EXCLUDE = new Set(['CHANGELOG.md']);
const MAX_FILES = 500;

/**
 * @param {string} root
 * @param {string} repoPath
 */
function readIfExists(root, repoPath) {
  const full = join(root, repoPath);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

/**
 * Markdown files whose relative links are checked: root `*.md` (except the generated CHANGELOG), everything under
 * `docs/` and the Copilot instructions.
 * @param {string} root
 * @returns {string[]}
 */
export function markdownFiles(root) {
  const files = readdirSync(root).filter((name) => name.endsWith('.md') && !ROOT_MARKDOWN_EXCLUDE.has(name));
  /** @param {string} dir */
  const walk = (dir) => {
    const full = join(root, dir);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      if (files.length >= MAX_FILES) return;
      const repoPath = `${dir}/${name}`;
      const stat = statSync(join(root, repoPath));
      if (stat.isDirectory()) walk(repoPath);
      else if (name.endsWith('.md')) files.push(repoPath);
    }
  };
  walk('docs');
  if (existsSync(join(root, '.github/copilot-instructions.md'))) files.push('.github/copilot-instructions.md');
  return files.sort();
}

/**
 * @param {string} root
 */
export function existsInRepo(root) {
  const base = resolve(root);
  /** @param {string} repoPath */
  return (repoPath) => {
    const full = resolve(base, repoPath);
    if (full !== base && !full.startsWith(base + sep)) return false;
    return existsSync(full);
  };
}

/**
 * Committer time per line of docs/STATE.md, or null when git history is unavailable (e.g. no checkout).
 * @param {string} root
 */
export function blameState(root) {
  try {
    const out = execFileSync('git', ['blame', '--line-porcelain', '--', 'docs/STATE.md'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseBlamePorcelain(out);
  } catch {
    return null;
  }
}

/**
 * Everything `evaluateDocs` needs except merged PR numbers and URLs.
 * @param {string} root
 */
export function collectDocs(root) {
  const linkedFiles = markdownFiles(root).map((path) => ({ path, content: readFileSync(join(root, path), 'utf8') }));
  return {
    stateMd: readIfExists(root, 'docs/STATE.md'),
    decisionsMd: readIfExists(root, 'docs/DECISIONS.md'),
    blameTimes: blameState(root),
    linkedFiles,
    exists: existsInRepo(root),
  };
}
