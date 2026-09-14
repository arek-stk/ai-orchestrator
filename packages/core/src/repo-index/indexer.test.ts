import { describe, expect, it } from 'vitest';
import type { IndexedFile } from '../context/context-builder';
import { InMemoryGitHub } from '../testing/in-memory-github';
import { extractImports, extractSymbols, RepoIndexer, type RepoFileStore } from './indexer';

const repo = { owner: 'acme', name: 'shop' };

function memoryFileStore(): RepoFileStore & { data: Map<string, IndexedFile[]> } {
  const data = new Map<string, IndexedFile[]>();
  return { data, list: async (id) => data.get(id) ?? [], replace: async (id, files) => void data.set(id, [...files]) };
}

describe('symbol and import extraction', () => {
  it('extracts TypeScript and Python declarations', () => {
    const ts = `import { db } from './db';\nexport async function createSession() {}\nexport class SessionStore {}\nexport const TTL = 5;\nconst x = require("lodash");`;
    expect(extractSymbols(ts)).toEqual(['createSession', 'SessionStore', 'TTL']);
    expect(extractImports(ts)).toEqual(['./db', 'lodash']);
    expect(extractSymbols('def handler(event):\n  pass\nclass Cart(Base):\n  pass').sort()).toEqual(['Cart', 'handler']);
  });

  it('handles multi-line imports', () => {
    expect(extractImports(`import {\n  a,\n  b,\n} from '../shared/util';`)).toEqual(['../shared/util']);
  });
});

describe('RepoIndexer', () => {
  it('indexes source files and reuses unchanged blobs on refresh', async () => {
    const github = new InMemoryGitHub();
    const base = github.seed(repo, {
      'src/cart.ts': 'export function addToCart() {}',
      'src/db.ts': 'export const db = {};',
      'README.md': '# Shop',
      '.env': 'SECRET=1',
    });
    const store = memoryFileStore();
    const indexer = new RepoIndexer(github, store);

    const first = await indexer.refresh('prj', repo, 'main');
    expect(first).toMatchObject({ headSha: base, fetched: 2, reused: 0 });
    expect(first.files.find((f) => f.path === 'src/cart.ts')?.symbols).toEqual(['addToCart']);
    expect(first.files.find((f) => f.path === 'README.md')?.symbols).toEqual([]);

    const commit = await github.createCommit(repo, {
      parentSha: base,
      message: 'change cart',
      changes: [{ path: 'src/cart.ts', action: 'update', content: 'export function addToCart() {}\nexport function clearCart() {}' }],
    });
    await github.updateBranch(repo, 'main', commit);

    const second = await indexer.refresh('prj', repo, 'main');
    expect(second).toMatchObject({ fetched: 1, reused: 3 });
    expect(second.files.find((f) => f.path === 'src/cart.ts')?.symbols).toEqual(['addToCart', 'clearCart']);
  });
});
