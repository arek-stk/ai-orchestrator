import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  isProtectedBranch,
  isSensitivePath,
  isValidBranchName,
  normalizeRepoPath,
  UnsafePathError,
} from './paths';
import { containsSecret, findSecrets, redactSecrets } from './secrets';

describe('normalizeRepoPath', () => {
  it('rejects colons that would address NTFS alternate data streams', () => {
    expect(() => normalizeRepoPath('src/report.md:hidden.js')).toThrow(UnsafePathError);
  });

  it('normalises separators and dot segments', () => {
    expect(normalizeRepoPath('src\\app//./index.ts')).toBe('src/app/index.ts');
  });

  it.each(['../etc/passwd', 'src/../../x', '/etc/passwd', 'C:/Windows/system32', '~/.ssh/id_rsa', '.git/config', 'a/.GIT/hooks/pre-commit', '', 'a\u0000b'])(
    'rejects %j',
    (path) => {
      expect(() => normalizeRepoPath(path)).toThrow(UnsafePathError);
    },
  );
});

describe('sensitive paths', () => {
  it.each(['.env', 'config/.env.production', 'certs/server.pem', 'id_rsa', 'secrets/db.json', '.npmrc'])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });
  it.each(['.env.example', 'src/environment.ts', 'docs/secret-management.md.txt', 'src/keyboard.ts'])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

describe('globs and branches', () => {
  it('matches globs', () => {
    expect(globToRegExp('infra/**').test('infra/prod/main.tf')).toBe(true);
    expect(globToRegExp('**/*.sql').test('db/migrations/001.sql')).toBe(true);
    expect(globToRegExp('**/*.sql').test('001.sql')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });

  it('always protects the default branch', () => {
    expect(isProtectedBranch('main', 'main')).toBe(true);
    expect(isProtectedBranch('release/1.2', 'main', ['release/*'])).toBe(true);
    expect(isProtectedBranch('orchestrator/task-1', 'main', ['release/*'])).toBe(false);
  });

  it('validates branch names', () => {
    expect(isValidBranchName('orchestrator/task-abc_1.2')).toBe(true);
    expect(isValidBranchName('--upload-pack=/tmp/evil.sh')).toBe(false);
    expect(isValidBranchName('-oProxyCommand')).toBe(false);
    expect(isValidBranchName('bad..name')).toBe(false);
    expect(isValidBranchName('/leading')).toBe(false);
    expect(isValidBranchName('x.lock')).toBe(false);
  });
});

describe('secrets', () => {
  const ghToken = `ghp_${'a'.repeat(36)}`;
  const text = `token=${ghToken}\nconst apiKey = "supersecretvalue123";\nANTHROPIC=sk-ant-api03-${'x'.repeat(30)}`;

  it('finds secrets', () => {
    expect(findSecrets(text).map((f) => f.name)).toEqual(['github_token', 'credential_assignment', 'anthropic_api_key']);
    expect(containsSecret('nothing to see here')).toBe(false);
  });

  it('redacts secrets but keeps surrounding text', () => {
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain(ghToken);
    expect(redacted).not.toContain('supersecretvalue123');
    expect(redacted).toContain('const apiKey = "[REDACTED]"');
    expect(redacted).toContain('[REDACTED:anthropic_api_key]');
  });

  it('is stable across repeated calls (no lastIndex leakage)', () => {
    expect(containsSecret(ghToken)).toBe(true);
    expect(containsSecret(ghToken)).toBe(true);
  });
});
