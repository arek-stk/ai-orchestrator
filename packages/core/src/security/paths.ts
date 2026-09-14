export class UnsafePathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Unsafe repository path "${path}": ${reason}`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Normalises a repository-relative path produced by an agent and rejects anything that could
 * escape the repository or touch git internals. Returns the canonical "a/b/c.ts" form.
 */
export function normalizeRepoPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new UnsafePathError(String(input), 'empty path');
  if (input.length > 1024) throw new UnsafePathError(input.slice(0, 50), 'path too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw new UnsafePathError(input, 'control characters');
  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('~')) {
    throw new UnsafePathError(input, 'absolute paths are not allowed');
  }
  const segments = unified.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) throw new UnsafePathError(input, 'empty path');
  for (const segment of segments) {
    if (segment === '..') throw new UnsafePathError(input, 'path traversal');
    if (segment.toLowerCase() === '.git') throw new UnsafePathError(input, 'git internals are not writable');
  }
  return segments.join('/');
}

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(secrets?|credentials?)(\/|\.[^/]*$|$)/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /(^|\/)\.aws\/credentials$/i,
];
const SAFE_ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

/** Files that may contain credentials: never sent to models, never written by agents without approval. */
export function isSensitivePath(path: string): boolean {
  if (SAFE_ENV_TEMPLATE.test(path)) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

/** Minimal glob → RegExp: `**` spans directories, `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const followedBySlash = glob[i + 2] === '/';
        re += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** The default branch is always protected; additional globs come from the project profile. */
export function isProtectedBranch(branch: string, defaultBranch: string, protectedGlobs: readonly string[] = []): boolean {
  return branch === defaultBranch || matchesAnyGlob(branch, protectedGlobs);
}

const BRANCH_NAME = /^(?!\/|.*(?:\/\/|\.\.|@\{|\\|\.lock$|\/$|\.$))[A-Za-z0-9._\/-]{1,200}$/;

export function isValidBranchName(branch: string): boolean {
  return BRANCH_NAME.test(branch);
}
