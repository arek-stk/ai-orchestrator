import { describe, expect, it } from 'vitest';
import { buildContext, extractKeywords, rankFiles, type IndexedFile } from './context-builder';

const files: IndexedFile[] = [
  { path: 'src/auth/session-store.ts', sha: 'a', size: 900, symbols: ['createSession', 'SessionStore'], imports: ['../db/client'] },
  { path: 'src/auth/login-route.ts', sha: 'b', size: 700, symbols: ['loginHandler'], imports: ['./session-store'] },
  { path: 'src/db/client.ts', sha: 'c', size: 400, symbols: ['db'] },
  { path: 'src/cart/cart.ts', sha: 'd', size: 1200, symbols: ['addToCart'], summary: 'Shopping cart totals and discounts' },
  { path: 'package-lock.json', sha: 'e', size: 300_000 },
  { path: '.env', sha: 'f', size: 50, summary: 'session secret' },
  { path: 'dist/auth/session-store.js', sha: 'g', size: 900 },
];

const task = { title: 'Implement user login with sessions', goal: 'Users authenticate and receive a session cookie', acceptanceCriteria: ['Invalid password returns 401'] };

describe('context builder', () => {
  it('extracts keywords including camelCase parts', () => {
    expect(extractKeywords('createSession for loginHandler')).toEqual(['create', 'session', 'login', 'handler']);
  });

  it('ranks task-relevant files and excludes lockfiles, secrets and build output', () => {
    const ranked = rankFiles({ task, files, tokenBudget: 10_000 });
    const paths = ranked.map((r) => r.path);
    expect(paths.slice(0, 2).sort()).toEqual(['src/auth/login-route.ts', 'src/auth/session-store.ts']);
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('dist/auth/session-store.js');
    expect(paths).not.toContain('src/cart/cart.ts');
  });

  it('boosts dependency neighbours of relevant files', () => {
    const ranked = rankFiles({ task, files, tokenBudget: 10_000 });
    expect(ranked.find((r) => r.path === 'src/db/client.ts')?.reasons).toContain('imported by src/auth/session-store.ts');
  });

  it('pins files and uses failure hints', () => {
    const ranked = rankFiles({ task, files, tokenBudget: 10_000, pinnedPaths: ['src/cart/cart.ts'], hints: ['FAIL src/db/client.ts: timeout'] });
    expect(ranked[0]?.path).toBe('src/cart/cart.ts');
    expect(ranked.find((r) => r.path === 'src/db/client.ts')?.reasons).toContain('mentioned in failure/plan');
  });

  it('packs full content within budget, falls back to summaries and redacts secrets', async () => {
    const content: Record<string, string> = {
      'src/auth/session-store.ts': `const key = "ghp_${'z'.repeat(36)}";\n` + 'x'.repeat(200),
      'src/auth/login-route.ts': 'y'.repeat(4000),
      'src/db/client.ts': 'export const db = {};',
    };
    const withSummary = files.map((f) => (f.path === 'src/auth/login-route.ts' ? { ...f, summary: 'Login route handler' } : f));
    const built = await buildContext({ task, files: withSummary, tokenBudget: 200 }, async (p) => content[p] ?? null);

    const byPath = Object.fromEntries(built.files.map((f) => [f.path, f]));
    expect(byPath['src/auth/session-store.ts']?.mode).toBe('full');
    expect(byPath['src/auth/session-store.ts']?.content).not.toContain('ghp_');
    expect(byPath['src/auth/login-route.ts']?.mode).toBe('summary');
    expect(built.totalTokens).toBeLessThanOrEqual(200);
  });
});
