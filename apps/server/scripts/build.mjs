// Production build of the server (ADR-020): one ESM bundle plus the Drizzle migrations and a minimal
// package.json for the dependencies that cannot be bundled.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverRoot, '../..');
const dist = join(serverRoot, 'dist');

/**
 * Not bundled: PGlite loads its WASM and data files relative to its own module; pg-native is an optional
 * native addon that `pg` only requires when explicitly asked for.
 */
const RUNTIME_DEPENDENCIES = ['@electric-sql/pglite'];
const EXTERNAL = [...RUNTIME_DEPENDENCIES, 'pg-native'];

async function installedVersion(name) {
  for (let dir = serverRoot; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return JSON.parse(await readFile(manifest, 'utf8')).version;
    if (dirname(dir) === dir) throw new Error(`dependency ${name} is not installed; run npm ci first`);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(serverRoot, 'src/main.ts')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  external: EXTERNAL,
  // CommonJS dependencies (fastify, pg, ...) call require/__dirname, which ESM output does not define.
  banner: {
    js: [
      "import { createRequire as __orchCreateRequire } from 'node:module';",
      "import { fileURLToPath as __orchFileURLToPath } from 'node:url';",
      "import { dirname as __orchDirname } from 'node:path';",
      'const require = __orchCreateRequire(import.meta.url);',
      'const __filename = __orchFileURLToPath(import.meta.url);',
      'const __dirname = __orchDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// Migrations next to the bundle; the container auto-detects dist/drizzle (MIGRATIONS_DIR overrides).
await cp(join(repoRoot, 'packages/db/drizzle'), join(dist, 'drizzle'), { recursive: true });

const dependencies = Object.fromEntries(await Promise.all(RUNTIME_DEPENDENCIES.map(async (name) => [name, await installedVersion(name)])));
await writeFile(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: 'orch-server-dist', private: true, type: 'module', main: 'main.js', engines: { node: '>=24' }, dependencies }, null, 2)}\n`,
);

console.log(`server bundle written to ${dist} (runtime dependencies: ${Object.keys(dependencies).join(', ')})`);
