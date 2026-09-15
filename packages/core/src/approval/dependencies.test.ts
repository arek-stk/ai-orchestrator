import { describe, expect, it } from 'vitest';
import {
  approvalGrant,
  classifyDependencyFile,
  dependencyApprovalDetails,
  dependencyFingerprint,
  detectDependencyAdditions,
  diffDependencyFile,
  LOCKFILE_FINDING_REASONS,
  parseJsonLoose,
  readDependencyApprovalDetails,
  registryUrl,
  REGISTRY_URL_PREFIXES,
  type ChangedFileLike,
} from './dependencies';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const names = (findings: ReadonlyArray<{ name: string }>) => findings.map((f) => f.name).sort();

async function detect(base: Record<string, string>, changes: ChangedFileLike[]) {
  return detectDependencyAdditions(changes, async (path) => base[path] ?? null);
}

describe('detectDependencyAdditions: npm', () => {
  const base = json({ name: 'shop', dependencies: { express: '^4.18.0' }, devDependencies: { vitest: '^3.0.0' } });

  it('reports new entries in every dependency section, not bumps or removals', () => {
    const next = json({
      name: 'shop',
      dependencies: { express: '^5.0.0', zod: '^4.1.0' },
      devDependencies: {},
      optionalDependencies: { fsevents: '2.3.3' },
      peerDependencies: { react: '>=18' },
    });
    const findings = diffDependencyFile('package.json', base, next);
    expect(findings.map((f) => [f.name, f.version, f.ecosystem, f.kind, f.file])).toEqual([
      ['zod', '^4.1.0', 'npm', 'package', 'package.json'],
      ['fsevents', '2.3.3', 'npm', 'package', 'package.json'],
      ['react', '>=18', 'npm', 'package', 'package.json'],
    ]);
    expect(findings[0]).toMatchObject({ risk: 'normal', registryUrl: 'https://www.npmjs.com/package/zod', uncertain: false });
  });

  it('treats moving a dependency between sections as no addition and ignores workspace links', () => {
    const next = json({ dependencies: { express: '^4.18.0', vitest: '^3.0.0', '@acme/utils': 'workspace:*' } });
    expect(diffDependencyFile('package.json', base, next)).toEqual([]);
  });

  it('reports an alias or a Git source swapped in under an existing name', () => {
    const next = json({ dependencies: { express: 'npm:expresss@4.18.0' }, devDependencies: { vitest: 'github:evil/vitest#main' } });
    const findings = diffDependencyFile('package.json', base, next);
    expect(findings.map((f) => [f.name, f.detail])).toEqual([
      ['expresss', 'alias express'],
      ['vitest', null],
    ]);
    expect(findings[1]!.reason).toMatch(/Git repository/);
  });

  it('reports every entry of a newly created manifest', async () => {
    const result = await detect({}, [{ path: 'packages/api/package.json', action: 'create', content: json({ dependencies: { '@scope/pkg': '1.0.0' } }) }]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ name: '@scope/pkg', registryUrl: 'https://www.npmjs.com/package/@scope/pkg' });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ignores deleted manifests and non-dependency files', async () => {
    const result = await detect({ 'package.json': base }, [
      { path: 'package.json', action: 'delete' },
      { path: 'src/package.ts', action: 'create', content: 'export const dependencies = { evil: "1" };' },
    ]);
    expect(result).toEqual({ findings: [], fingerprint: null });
  });

  it('treats an unparsable manifest as a possible addition with a reason', () => {
    const [finding] = diffDependencyFile('package.json', base, '{ "dependencies": { "zod": ');
    expect(finding).toMatchObject({ uncertain: true, registryUrl: null, ecosystem: 'npm' });
    expect(finding!.reason).toMatch(/could not be parsed/);
  });
});

describe('detectDependencyAdditions: lockfiles', () => {
  const manifest = json({ dependencies: { express: '^4.18.0' } });
  const lock = (deps: Record<string, string>, hoisted: string[] = []) =>
    json({
      lockfileVersion: 3,
      packages: {
        '': { name: 'shop', dependencies: deps },
        ...Object.fromEntries(hoisted.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])),
      },
    });

  it('reports a top-level package added only to package-lock.json', async () => {
    const result = await detect({ 'package.json': manifest, 'package-lock.json': lock({ express: '^4.18.0' }, ['express']) }, [
      { path: 'package-lock.json', action: 'update', content: lock({ express: '^4.18.0', 'left-pad': '^1.3.0' }, ['express', 'left-pad']) },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ name: 'left-pad', source: 'lockfile', reason: 'Added to the lockfile without a matching manifest entry' });
  });

  it('dedupes a lockfile entry against its manifest addition but labels and gates transitive packages', async () => {
    const result = await detect({ 'package.json': manifest, 'package-lock.json': lock({ express: '^4.18.0' }, ['express']) }, [
      { path: 'package.json', action: 'update', content: json({ dependencies: { express: '^4.18.0', zod: '^4.1.0' } }) },
      { path: 'package-lock.json', action: 'update', content: lock({ express: '^4.18.0', zod: '^4.1.0' }, ['express', 'zod', 'some-transitive']) },
    ]);
    expect(result.findings.map((f) => [f.name, f.file, f.source, f.reason])).toEqual([
      ['zod', 'package.json', 'manifest', null],
      ['some-transitive', 'package-lock.json', 'lockfile', LOCKFILE_FINDING_REASONS.possiblyTransitive],
    ]);
  });

  it('diffs flat lockfiles also when the manifest changed (review fix: no silent lockfile-only additions)', async () => {
    const yarnBase = '# yarn lockfile v1\n\nexpress@^4.18.0:\n  version "4.18.2"\n';
    const yarnNext = `${yarnBase}\n"left-pad@^1.3.0", left-pad@^1.0.0:\n  version "1.3.0"\n`;
    const lockOnly = await detect({ 'yarn.lock': yarnBase }, [{ path: 'yarn.lock', action: 'update', content: yarnNext }]);
    expect(lockOnly.findings.map((f) => [f.name, f.reason])).toEqual([['left-pad', LOCKFILE_FINDING_REASONS.undeclared]]);

    const withBump = await detect({ 'yarn.lock': yarnBase, 'package.json': manifest }, [
      { path: 'package.json', action: 'update', content: json({ dependencies: { express: '^4.19.0' } }) },
      { path: 'yarn.lock', action: 'update', content: yarnNext },
    ]);
    expect(withBump.findings.map((f) => [f.name, f.file, f.source, f.reason])).toEqual([['left-pad', 'yarn.lock', 'lockfile', LOCKFILE_FINDING_REASONS.possiblyTransitive]]);
    expect(withBump.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    // The label is part of what the human approves.
    expect(withBump.fingerprint).not.toBe(lockOnly.fingerprint);
  });

  it('reads pnpm importers, Cargo.lock registry packages, Gemfile.lock DEPENDENCIES and go.sum', async () => {
    const pnpm = (extra: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      express:\n        specifier: ^4.18.0\n        version: 4.18.2\n${extra}\npackages:\n\n  express@4.18.2:\n    resolution: {integrity: sha512-x}\n`;
    const cargo = (extra: string) => `version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n${extra}`;
    const gemLock = (extra: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.0.0)\n\nDEPENDENCIES\n  rack (~> 3.0)\n${extra}\nBUNDLED WITH\n   2.5.0\n`;
    const result = await detect(
      { 'pnpm-lock.yaml': pnpm(''), 'Cargo.lock': cargo(''), 'Gemfile.lock': gemLock(''), 'go.sum': 'golang.org/x/text v0.3.0 h1:abc\n' },
      [
        { path: 'pnpm-lock.yaml', action: 'update', content: pnpm("      '@scope/extra':\n        specifier: ^1.0.0\n        version: 1.0.0\n") },
        { path: 'Cargo.lock', action: 'update', content: cargo('\n[[package]]\nname = "local-member"\nversion = "0.1.0"\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n') },
        { path: 'Gemfile.lock', action: 'update', content: gemLock('  nokogiri!\n') },
        { path: 'go.sum', action: 'update', content: 'golang.org/x/text v0.3.0 h1:abc\ngithub.com/evil/mod v1.0.0/go.mod h1:def\n' },
      ],
    );
    expect(result.findings.map((f) => [f.ecosystem, f.name])).toEqual([
      ['cargo', 'rand'],
      ['rubygems', 'nokogiri'],
      ['go', 'github.com/evil/mod'],
      ['npm', '@scope/extra'],
    ]);
  });

  it('treats a binary lockfile change without a manifest change as a possible addition', async () => {
    const result = await detect({}, [{ path: 'bun.lockb', action: 'update', content: 'binary' }]);
    expect(result.findings[0]).toMatchObject({ uncertain: true, source: 'lockfile' });
  });
});

describe('detectDependencyAdditions: Python', () => {
  it('parses requirements files: additions, bumps, extras, markers, URLs, indexes and continuations', () => {
    const base = 'requests==2.31.0\nDjango>=4.2  # web\n';
    const next = [
      'requests==2.32.0',
      'django>=5.0',
      'python_dateutil[tz]>=2.8 ; python_version >= "3.9"',
      'my-pkg @ https://example.com/my-pkg-1.0.tar.gz',
      '--extra-index-url https://pypi.internal.example/simple',
      '-r other.txt',
      '-e ./local',
      'numpy \\',
      '  >=1.26',
      '',
    ].join('\n');
    const findings = diffDependencyFile('requirements-dev.txt', base, next);
    expect(findings.map((f) => [f.name, f.version])).toEqual([
      ['python_dateutil', '>=2.8'],
      ['my-pkg', 'https://example.com/my-pkg-1.0.tar.gz'],
      ['package index https://pypi.internal.example/simple', null],
      ['requirements file other.txt', null],
      ['numpy', '>=1.26'],
    ]);
    expect(findings[3]).toMatchObject({ uncertain: true, reason: expect.stringMatching(/Includes another requirements file/) });
    expect(findings[0]!.registryUrl).toBe('https://pypi.org/project/python-dateutil/');
  });

  it('parses pyproject.toml: PEP 621, optional groups, dependency groups, build requires and Poetry', () => {
    const base = `[project]\nname = "app"\ndependencies = ["httpx>=0.27"]\n\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13.0"\n`;
    const next = `[build-system]
requires = ["hatchling"]

[project]
name = "app"
dependencies = [
  "httpx>=0.28", # bump
  "pydantic>=2",
]

[project.optional-dependencies]
cli = ["typer"]

[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]

[tool.poetry.dependencies]
python = "^3.12"
rich = { version = "^14.0" }
Flask = { git = "https://github.com/pallets/flask.git" }

[tool.poetry.group.test.dependencies.hypothesis]
version = "^6.0"
`;
    const findings = diffDependencyFile('pyproject.toml', base, next);
    expect(findings.map((f) => [f.name, f.version])).toEqual([
      ['hatchling', null],
      ['pydantic', '>=2'],
      ['typer', null],
      ['pytest', '>=8'],
      ['Flask', 'https://github.com/pallets/flask.git'],
      ['hypothesis', '^6.0'],
    ]);
  });

  it('parses Pipfile packages and dev-packages', () => {
    const findings = diffDependencyFile('Pipfile', '[packages]\nrequests = "*"\n', '[packages]\nrequests = "==2.32"\n\n[dev-packages]\nblack = {version = "*"}\n');
    expect(names(findings)).toEqual(['black']);
  });
});

describe('detectDependencyAdditions: Cargo, Go, Ruby, PHP, .NET, Java', () => {
  it('parses Cargo.toml including target tables, renames, workspace inheritance and subtables', () => {
    const base = '[dependencies]\nserde = "1.0"\n';
    const next = `[dependencies]
serde = "1.0.200"
tokio = { version = "1", features = ["full"] }
json = { package = "serde_json", version = "1" }
shared.workspace = true
local = { path = "../local" }

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[dev-dependencies.proptest]
version = "1.4"
`;
    const findings = diffDependencyFile('crates/app/Cargo.toml', base, next);
    expect(findings.map((f) => [f.name, f.version, f.detail])).toEqual([
      ['tokio', '1', null],
      ['serde_json', '1', 'renamed to json'],
      ['nix', '0.29', null],
      ['proptest', '1.4', null],
    ]);
    expect(findings[0]!.registryUrl).toBe('https://crates.io/crates/tokio');
  });

  it('parses go.mod require blocks, single requires, tool and replace directives', () => {
    const base = 'module example.com/app\n\ngo 1.24\n\nrequire (\n\tgolang.org/x/text v0.3.0\n)\n';
    const next = `module example.com/app

go 1.24

require (
\tgolang.org/x/text v0.14.0 // indirect
\tgithub.com/spf13/cobra v1.8.0
)

require github.com/google/uuid v1.6.0

tool golang.org/x/tools/cmd/stringer

replace golang.org/x/text => github.com/fork/text v0.14.1
replace example.com/local => ../local
`;
    const findings = diffDependencyFile('go.mod', base, next);
    expect(findings.map((f) => [f.name, f.version])).toEqual([
      ['github.com/spf13/cobra', 'v1.8.0'],
      ['github.com/google/uuid', 'v1.6.0'],
      ['golang.org/x/tools/cmd/stringer', null],
      ['github.com/fork/text', 'v0.14.1'],
    ]);
    expect(findings[0]!.registryUrl).toBe('https://pkg.go.dev/github.com/spf13/cobra');
  });

  it('parses Gemfile gems with versions and Git sources', () => {
    const base = "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n";
    const next = "source 'https://rubygems.org'\ngem 'rails', '~> 7.2'\ngem \"sidekiq\", \"~> 7.0\" # jobs\ngem 'devise', github: 'heartcombo/devise'\ngem 'local', path: '../local'\ngemspec\n";
    expect(diffDependencyFile('Gemfile', base, next).map((f) => [f.name, f.version])).toEqual([
      ['sidekiq', '~> 7.0'],
      ['devise', 'heartcombo/devise'],
    ]);
  });

  it('parses composer.json and skips platform requirements', () => {
    const next = json({ require: { php: '^8.3', 'ext-json': '*', 'laravel/framework': '^11.0' }, 'require-dev': { 'phpunit/phpunit': '^11' } });
    const findings = diffDependencyFile('composer.json', json({ require: { 'laravel/framework': '^10.0' } }), next);
    expect(findings.map((f) => [f.name, f.registryUrl])).toEqual([['phpunit/phpunit', 'https://packagist.org/packages/phpunit/phpunit']]);
  });

  it('parses csproj PackageReference and ignores commented-out references', () => {
    const base = '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>';
    const next = '<Project><ItemGroup>\n<PackageReference Include="Serilog" Version="4.0.0" />\n<!-- <PackageReference Include="Hidden" Version="1" /> -->\n<PackageReference Include=\'Newtonsoft.Json\' Version="13.0.3"></PackageReference>\n</ItemGroup></Project>';
    expect(diffDependencyFile('src/App/App.csproj', base, next).map((f) => [f.name, f.version, f.ecosystem])).toEqual([['Newtonsoft.Json', '13.0.3', 'nuget']]);
  });

  it('parses pom.xml dependencies and plugins, and build.gradle(.kts) dependencies and plugins', () => {
    const pomBase = '<project><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.0</version></dependency></dependencies></project>';
    const pomNext = `<project><dependencies>
  <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.13</version></dependency>
  <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.0.0-jre</version></dependency>
</dependencies><build><plugins><plugin><artifactId>maven-shade-plugin</artifactId><version>3.5.0</version></plugin></plugins></build></project>`;
    expect(diffDependencyFile('pom.xml', pomBase, pomNext).map((f) => [f.name, f.version])).toEqual([
      ['com.google.guava:guava', '33.0.0-jre'],
      ['org.apache.maven.plugins:maven-shade-plugin', '3.5.0'],
    ]);

    const gradleBase = 'dependencies {\n    implementation("org.slf4j:slf4j-api:2.0.0")\n}\n';
    const gradleNext = `plugins {
    id("org.springframework.boot") version "3.3.0"
    kotlin("jvm") version "2.0.0"
}
dependencies {
    implementation("org.slf4j:slf4j-api:2.0.13")
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'
    implementation(project(":core"))
    implementation(libs.guava)
    // implementation("commented:out:1")
}
`;
    const findings = diffDependencyFile('app/build.gradle.kts', gradleBase, gradleNext);
    expect(findings.map((f) => [f.ecosystem, f.name, f.version])).toEqual([
      ['gradle_plugin', 'org.springframework.boot', '3.3.0'],
      ['gradle_plugin', 'org.jetbrains.kotlin.jvm', '2.0.0'],
      ['maven', 'org.junit.jupiter:junit-jupiter', '5.10.2'],
    ]);
  });
});

describe('detectDependencyAdditions: developer environment configs', () => {
  it('reports new GitHub Actions and Docker actions in workflows, not ref bumps or local actions', () => {
    const base = 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n';
    const next = `jobs:
  build:
    steps:
      - uses: actions/checkout@v5
      - uses: "tj-actions/changed-files@0123456789abcdef0123456789abcdef01234567" # pinned
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.20
  reusable:
    uses: octo-org/shared/.github/workflows/ci.yml@main
`;
    const findings = diffDependencyFile('.github/workflows/ci.yml', base, next);
    expect(findings.map((f) => [f.ecosystem, f.name, f.version, f.risk])).toEqual([
      ['github_actions', 'tj-actions/changed-files', '0123456789abcdef0123456789abcdef01234567', 'high'],
      ['docker', 'alpine', '3.20', 'high'],
      ['github_actions', 'octo-org/shared/.github/workflows/ci.yml', 'main', 'high'],
    ]);
    expect(findings[0]).toMatchObject({ kind: 'github_action', registryUrl: 'https://github.com/tj-actions/changed-files' });
    expect(findings[2]!.registryUrl).toBe('https://github.com/octo-org/shared');
  });

  it('reports new MCP servers in .mcp.json by the package they launch, not version bumps', () => {
    const base = json({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.0.0'] } } });
    const next = json({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.1.0'] },
        fetch: { command: 'uvx', args: ['mcp-server-fetch==2025.1.1'] },
        remote: { type: 'http', url: 'https://mcp.example.com/sse' },
        container: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/acme/mcp:1.2'] },
        custom: { command: 'node', args: ['tools/server.js'] },
      },
    });
    const findings = diffDependencyFile('.mcp.json', base, next);
    expect(findings.map((f) => [f.kind, f.ecosystem, f.name, f.version, f.risk])).toEqual([
      ['mcp_server', 'pypi', 'mcp-server-fetch', '2025.1.1', 'high'],
      ['mcp_server', 'mcp', 'remote', null, 'high'],
      ['mcp_server', 'docker', 'ghcr.io/acme/mcp', '1.2', 'high'],
      ['mcp_server', 'mcp', 'custom', null, 'high'],
    ]);
    expect(findings[0]).toMatchObject({ detail: 'MCP server "fetch"', registryUrl: 'https://pypi.org/project/mcp-server-fetch/' });
  });

  it('reports a server whose launched package changes under the same name', () => {
    const base = json({ mcpServers: { files: { command: 'npx', args: ['@acme/files'] } } });
    const next = json({ mcpServers: { files: { command: 'npx', args: ['@evil/files'] } } });
    expect(names(diffDependencyFile('.mcp.json', base, next))).toEqual(['@evil/files']);
  });

  it('reports Claude plugins, marketplaces and MCP enablement in .claude/settings.json', () => {
    const base = json({ permissions: { allow: [] }, enabledPlugins: { 'formatter@official': true } });
    const next = json({
      permissions: { allow: ['Bash(npm test)'] },
      enabledPlugins: { 'formatter@official': true, 'deploy-tools@acme': true, 'disabled@acme': false },
      extraKnownMarketplaces: { acme: { source: { source: 'github', repo: 'acme/claude-plugins' } } },
      enabledMcpjsonServers: ['github'],
      enableAllProjectMcpServers: true,
    });
    const findings = diffDependencyFile('.claude/settings.json', base, next);
    expect(findings.map((f) => [f.kind, f.name])).toEqual([
      ['claude_plugin', 'deploy-tools@acme'],
      ['claude_plugin', 'marketplace acme'],
      ['mcp_server', 'github'],
      ['mcp_server', 'all project MCP servers'],
    ]);
    expect(findings.every((f) => f.risk === 'high' && f.registryUrl === null)).toBe(true);
    expect(classifyDependencyFile('docs/settings.json')).toBeNull();
  });

  it('reports new VS Code extension recommendations in JSONC', () => {
    const base = '{\n  // recommended\n  "recommendations": ["dbaeumer.vscode-eslint"]\n}\n';
    const next = '{\n  // recommended\n  "recommendations": [\n    "dbaeumer.vscode-eslint",\n    "Evil.Extension", /* new */\n  ],\n}\n';
    const findings = diffDependencyFile('.vscode/extensions.json', base, next);
    expect(findings.map((f) => [f.kind, f.name, f.risk, f.registryUrl])).toEqual([
      ['vscode_extension', 'Evil.Extension', 'high', 'https://marketplace.visualstudio.com/items?itemName=Evil.Extension'],
    ]);
  });
});

describe('lockfile additions next to a manifest change (review fix for PR #20)', () => {
  interface EcosystemCase {
    ecosystem: string;
    manifest: [path: string, base: string, bump: string, addition: string];
    lockfile: [path: string, base: string, smuggled: string, ownEntry: string];
    smuggledName: string;
    addedName: string;
  }
  const tomlLock = (...names: string[]) => names.map((n) => `[[package]]\nname = "${n}"\nversion = "1.0.0"\n`).join('\n');
  const pyproject = (deps: string[]) => `[project]\nname = "app"\ndependencies = [${deps.map((d) => `"${d}"`).join(', ')}]\n`;
  const cargoLock = (...names: string[]) => names.map((n) => `[[package]]\nname = "${n}"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`).join('\n');
  const yarnLock = (...names: string[]) => `# yarn lockfile v1\n\n${names.map((n) => `${n}@^1.0.0:\n  version "1.0.0"\n`).join('\n')}`;
  const pkgJson = (deps: Record<string, string>) => json({ dependencies: deps });
  const pipfileLock = (...names: string[]) => json({ default: Object.fromEntries(names.map((n) => [n, { version: '==1.0.0' }])), develop: {} });
  const composerLock = (...names: string[]) => json({ packages: names.map((name) => ({ name, version: 'v1.0.0' })) });
  const gradle = (...coords: string[]) => `dependencies {\n${coords.map((c) => `    implementation("${c}")\n`).join('')}}\n`;

  const cases: EcosystemCase[] = [
    {
      ecosystem: 'yarn',
      manifest: ['package.json', pkgJson({ express: '^1.0.0' }), pkgJson({ express: '^1.1.0' }), pkgJson({ express: '^1.0.0', 'left-pad': '^1.0.0' })],
      lockfile: ['yarn.lock', yarnLock('express'), yarnLock('express', 'evil-pkg'), yarnLock('express', 'left-pad')],
      smuggledName: 'evil-pkg',
      addedName: 'left-pad',
    },
    {
      ecosystem: 'Pipfile',
      manifest: ['Pipfile', '[packages]\nrequests = "*"\n', '[packages]\nrequests = "==2.32"\n', '[packages]\nrequests = "*"\nblack = "*"\n'],
      lockfile: ['Pipfile.lock', pipfileLock('requests'), pipfileLock('requests', 'evil-pkg'), pipfileLock('requests', 'black')],
      smuggledName: 'evil-pkg',
      addedName: 'black',
    },
    ...(['poetry.lock', 'uv.lock', 'pdm.lock'] as const).map(
      (lock): EcosystemCase => ({
        ecosystem: lock,
        manifest: ['pyproject.toml', pyproject(['rich>=13']), pyproject(['rich>=14']), pyproject(['rich>=13', 'black>=24'])],
        lockfile: [lock, tomlLock('rich'), tomlLock('rich', 'evil-pkg'), tomlLock('rich', 'black')],
        smuggledName: 'evil-pkg',
        addedName: 'black',
      }),
    ),
    {
      ecosystem: 'Cargo',
      manifest: ['Cargo.toml', '[dependencies]\nserde = "1.0"\n', '[dependencies]\nserde = "1.0.200"\n', '[dependencies]\nserde = "1.0"\nrand = "0.8"\n'],
      lockfile: ['Cargo.lock', cargoLock('serde'), cargoLock('serde', 'evil-pkg'), cargoLock('serde', 'rand')],
      smuggledName: 'evil-pkg',
      addedName: 'rand',
    },
    {
      ecosystem: 'go.sum',
      manifest: ['go.mod', 'module x\n\nrequire golang.org/x/text v0.3.0\n', 'module x\n\nrequire golang.org/x/text v0.14.0\n', 'module x\n\nrequire golang.org/x/text v0.3.0\nrequire github.com/google/uuid v1.6.0\n'],
      lockfile: [
        'go.sum',
        'golang.org/x/text v0.3.0 h1:a\n',
        'golang.org/x/text v0.3.0 h1:a\ngithub.com/evil/mod v1.0.0 h1:b\n',
        'golang.org/x/text v0.3.0 h1:a\ngithub.com/google/uuid v1.6.0 h1:c\n',
      ],
      smuggledName: 'github.com/evil/mod',
      addedName: 'github.com/google/uuid',
    },
    {
      ecosystem: 'composer',
      manifest: ['composer.json', json({ require: { 'laravel/framework': '^10.0' } }), json({ require: { 'laravel/framework': '^11.0' } }), json({ require: { 'laravel/framework': '^10.0', 'monolog/monolog': '^3.0' } })],
      lockfile: ['composer.lock', composerLock('laravel/framework'), composerLock('laravel/framework', 'evil/pkg'), composerLock('laravel/framework', 'monolog/monolog')],
      smuggledName: 'evil/pkg',
      addedName: 'monolog/monolog',
    },
    {
      ecosystem: 'gradle',
      manifest: ['build.gradle', gradle('org.slf4j:slf4j-api:2.0.0'), gradle('org.slf4j:slf4j-api:2.0.13'), gradle('org.slf4j:slf4j-api:2.0.0', 'com.google.guava:guava:33.0.0-jre')],
      lockfile: [
        'gradle.lockfile',
        'org.slf4j:slf4j-api:2.0.0=compileClasspath\n',
        'org.slf4j:slf4j-api:2.0.0=compileClasspath\ncom.evil:pkg:1.0=compileClasspath\n',
        'org.slf4j:slf4j-api:2.0.0=compileClasspath\ncom.google.guava:guava:33.0.0-jre=compileClasspath\n',
      ],
      smuggledName: 'com.evil:pkg',
      addedName: 'com.google.guava:guava',
    },
  ];

  it.each(cases)('$ecosystem: a manifest bump next to an unrelated lockfile addition is gated and labelled', async ({ manifest, lockfile, smuggledName }) => {
    const [manifestPath, manifestBase, bump] = manifest;
    const [lockPath, lockBase, smuggled] = lockfile;
    const result = await detect({ [manifestPath]: manifestBase, [lockPath]: lockBase }, [
      { path: manifestPath, action: 'update', content: bump },
      { path: lockPath, action: 'update', content: smuggled },
    ]);
    expect(result.findings.map((f) => [f.name, f.file, f.source, f.uncertain, f.reason])).toEqual([[smuggledName, lockPath, 'lockfile', false, LOCKFILE_FINDING_REASONS.possiblyTransitive]]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(cases)('$ecosystem: a manifest addition with its own lockfile entry yields only the manifest finding', async ({ manifest, lockfile, addedName }) => {
    const [manifestPath, manifestBase, , addition] = manifest;
    const [lockPath, lockBase, , ownEntry] = lockfile;
    const result = await detect({ [manifestPath]: manifestBase, [lockPath]: lockBase }, [
      { path: manifestPath, action: 'update', content: addition },
      { path: lockPath, action: 'update', content: ownEntry },
    ]);
    expect(result.findings.map((f) => [f.name, f.file, f.source])).toEqual([[addedName, manifestPath, 'manifest']]);
    const manifestOnly = await detect({ [manifestPath]: manifestBase }, [{ path: manifestPath, action: 'update', content: addition }]);
    expect(result.fingerprint).toBe(manifestOnly.fingerprint);
  });

  it('bun.lockb: a binary lockfile change is a possible addition that cannot be inspected, with or without a manifest change', async () => {
    const base = { 'package.json': pkgJson({ express: '^1.0.0' }), 'bun.lockb': 'binary-v1' };
    const bumpOnly = await detect(base, [
      { path: 'package.json', action: 'update', content: pkgJson({ express: '^1.1.0' }) },
      { path: 'bun.lockb', action: 'update', content: 'binary-v2' },
    ]);
    expect(bumpOnly.findings).toHaveLength(1);
    expect(bumpOnly.findings[0]).toMatchObject({ file: 'bun.lockb', source: 'lockfile', uncertain: true, registryUrl: null, reason: LOCKFILE_FINDING_REASONS.opaque });
    expect(bumpOnly.findings[0]!.reason).toMatch(/cannot inspect/);
    expect(bumpOnly.findings[0]!.reason).toMatch(/Bumping an existing dependency also changes it/);

    const withAddition = await detect(base, [
      { path: 'package.json', action: 'update', content: pkgJson({ express: '^1.0.0', 'left-pad': '^1.0.0' }) },
      { path: 'bun.lockb', action: 'update', content: 'binary-v2' },
    ]);
    expect(withAddition.findings.map((f) => [f.name, f.source, f.uncertain])).toEqual([
      ['left-pad', 'manifest', false],
      ['unparsed change in bun.lockb', 'lockfile', true],
    ]);
    expect(await detect(base, [{ path: 'bun.lockb', action: 'update', content: 'binary-v1' }])).toEqual({ findings: [], fingerprint: null });
  });

  it('keeps manifests and configs ahead of lockfile findings in the approval payload', async () => {
    const lockNext = yarnLock(...Array.from({ length: 250 }, (_, i) => `transitive-${i}`));
    const detection = await detect({ 'yarn.lock': yarnLock() }, [
      { path: 'package.json', action: 'create', content: pkgJson({ zod: '^4.0.0' }) },
      { path: 'yarn.lock', action: 'update', content: lockNext },
    ]);
    const details = dependencyApprovalDetails(detection);
    expect(details.totalFindings).toBe(251);
    expect(details.findings[0]).toMatchObject({ name: 'zod', source: 'manifest' });
    expect(details.fingerprint).toBe(detection.fingerprint);
  });
});

describe('other skip paths closed by the review fix', () => {
  const npmLock = (packages: Record<string, unknown>, extra: Record<string, unknown> = {}) => json({ lockfileVersion: 3, packages: { '': { dependencies: { express: '^4.18.0' } }, ...packages }, ...extra });
  const registry = (name: string, version = '1.0.0') => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` });

  it('package-lock v3: reports nested and hoisted transitive additions and source swaps, not workspace links', async () => {
    const base = npmLock({ 'node_modules/express': registry('express', '4.18.2') });
    const next = npmLock({
      'node_modules/express': { version: '4.18.2', resolved: 'https://evil.example/express-4.18.2.tgz' },
      'node_modules/express/node_modules/evil-nested': registry('evil-nested'),
      'node_modules/@scope/hoisted': registry('@scope/hoisted'),
      'node_modules/@acme/utils': { resolved: 'packages/utils', link: true },
      'packages/utils': { name: '@acme/utils', version: '0.0.0' },
    });
    const result = await detect({ 'package-lock.json': base }, [{ path: 'package-lock.json', action: 'update', content: next }]);
    expect(result.findings.map((f) => [f.name, f.detail])).toEqual([
      ['@scope/hoisted', null],
      ['evil-nested', null],
      ['express', 'resolved from evil.example'],
    ]);
    expect(result.findings[2]!.reason).toBe(`${LOCKFILE_FINDING_REASONS.undeclared}. Downloaded from a registry or URL other than registry.npmjs.org`);
    // A version bump from the registry is not an addition.
    const bump = npmLock({ 'node_modules/express': registry('express', '4.19.0') });
    expect((await detect({ 'package-lock.json': base }, [{ path: 'package-lock.json', action: 'update', content: bump }])).findings).toEqual([]);
  });

  it('package-lock v1 and the legacy section of v2: nested dependency trees and Git sources', async () => {
    const v1 = (deps: Record<string, unknown>) => json({ lockfileVersion: 1, dependencies: deps });
    const base = v1({ express: { version: '4.18.2', dependencies: { debug: { version: '2.6.9' } } } });
    const next = v1({
      express: { version: '4.18.2', dependencies: { debug: { version: '2.6.9', dependencies: { 'deep-evil': { version: '1.0.0' } } } } },
      'git-dep': { version: 'git+https://github.com/evil/git-dep.git#abc123' },
      local: { version: 'file:packages/local' },
    });
    expect(names(diffDependencyFile('package-lock.json', base, next))).toEqual(['deep-evil', 'git-dep']);

    const v2Base = json({ lockfileVersion: 2, packages: { '': {} }, dependencies: {} });
    const v2Next = json({ lockfileVersion: 2, packages: { '': {} }, dependencies: { 'legacy-only': { version: '1.0.0' } } });
    expect(names(diffDependencyFile('package-lock.json', v2Base, v2Next))).toEqual(['legacy-only']);
  });

  it('pnpm-lock.yaml and bun.lock: packages sections are diffed, not only importers and workspaces', () => {
    const pnpm = (extra: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      express:\n        specifier: ^4.18.0\n        version: 4.18.2\n\npackages:\n\n  express@4.18.2:\n    resolution: {integrity: sha512-x}\n${extra}\nsnapshots:\n\n  express@4.18.2: {}\n`;
    const pnpmNext = pnpm("\n  evil@1.0.0:\n    resolution: {integrity: sha512-y}\n\n  '@scope/peer@2.0.0(react@18.0.0)':\n    resolution: {integrity: sha512-z}\n");
    expect(names(diffDependencyFile('pnpm-lock.yaml', pnpm(''), pnpmNext))).toEqual(['@scope/peer', 'evil']);
    const v5 = "lockfileVersion: 5.4\n\ndependencies:\n  express: 4.18.2\n\npackages:\n\n  /express/4.18.2:\n    resolution: {integrity: sha512-x}\n";
    expect(names(diffDependencyFile('pnpm-lock.yaml', v5, `${v5}\n  /@scope/evil/1.0.0_react@18.0.0:\n    resolution: {integrity: sha512-y}\n`))).toEqual(['@scope/evil']);

    const bun = (packages: Record<string, unknown[]>) => `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "dependencies": { "express": "^4.18.0" } } },\n  "packages": ${JSON.stringify(packages)},\n}\n`;
    const bunBase = bun({ express: ['express@4.18.2', '', {}, 'sha512-x'] });
    const bunNext = bun({ express: ['express@4.18.2', '', {}, 'sha512-x'], 'express/evil': ['evil@1.0.0', '', {}, 'sha512-y'], forked: ['forked@github:evil/forked#abc', {}] });
    const findings = diffDependencyFile('bun.lock', bunBase, bunNext);
    expect(findings.map((f) => [f.name, f.reason])).toEqual([
      ['evil', null],
      ['forked', 'Installed from a URL or Git repository instead of the registry'],
    ]);
  });

  it('Gemfile.lock specs, packages.lock.json transitive packages and Cargo.lock Git sources', () => {
    const gemLock = (specs: string, git = '') => `${git}GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.0.0)\n${specs}\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack (~> 3.0)\n`;
    const gems = diffDependencyFile('Gemfile.lock', gemLock(''), gemLock('    evil-gem (1.0.0)\n      rack (>= 2)\n', 'GIT\n  remote: https://github.com/evil/fork.git\n  revision: abc\n  specs:\n    forked (0.1.0)\n\n'));
    expect(gems.map((f) => [f.name, f.version, f.detail])).toEqual([
      ['forked', '0.1.0', 'source https://github.com/evil/fork.git'],
      ['evil-gem', '1.0.0', null],
    ]);

    const nuget = (extra: Record<string, unknown>) => json({ version: 1, dependencies: { net8: { Serilog: { type: 'Direct', requested: '[3.0.0, )' }, Core: { type: 'Project' }, ...extra } } });
    expect(names(diffDependencyFile('packages.lock.json', nuget({}), nuget({ 'Evil.Transitive': { type: 'Transitive', resolved: '1.0.0' }, 'Local.Project': { type: 'Project' } })))).toEqual(['Evil.Transitive']);

    const cargo = (source: string) => `[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "${source}"\n`;
    const swapped = diffDependencyFile('Cargo.lock', cargo('registry+https://github.com/rust-lang/crates.io-index'), cargo('git+https://github.com/evil/serde#abc'));
    expect(swapped.map((f) => [f.name, f.detail])).toEqual([['serde', 'source git+https://github.com/evil/serde']]);
    expect(diffDependencyFile('Cargo.lock', cargo('registry+https://github.com/rust-lang/crates.io-index'), cargo('sparse+https://index.crates.io/'))).toEqual([]);
  });

  it('package.json overrides and resolutions that swap packages, and Cargo [patch] sources', () => {
    const base = json({ dependencies: { express: '^4.18.0' } });
    const next = json({
      dependencies: { express: '^4.18.0' },
      overrides: { debug: '4.3.4', express: { 'body-parser': 'npm:evil-parser@1.0.0' } },
      resolutions: { '**/qs': 'github:evil/qs' },
      pnpm: { overrides: { 'path-to-regexp': 'https://evil.example/ptr.tgz' } },
    });
    expect(diffDependencyFile('package.json', base, next).map((f) => [f.name, f.detail])).toEqual([
      ['evil-parser', 'overrides body-parser'],
      ['**/qs', 'resolutions **/qs'],
      ['path-to-regexp', 'pnpm.overrides path-to-regexp'],
    ]);

    const cargo = diffDependencyFile('Cargo.toml', '[dependencies]\nserde = "1"\n', '[dependencies]\nserde = "1"\n\n[patch.crates-io]\nserde = { git = "https://github.com/evil/serde" }\nlocal = { path = "../local" }\n\n[patch.crates-io.tokio]\ngit = "https://github.com/evil/tokio"\n');
    expect(cargo.map((f) => [f.name, f.version])).toEqual([
      ['serde', 'https://github.com/evil/serde'],
      ['tokio', 'https://github.com/evil/tokio'],
    ]);
  });

  it('requirements files included with -r are inspected under any name when they are in the change set', async () => {
    const result = await detect({ 'requirements.txt': 'requests==2.31.0\n' }, [
      { path: 'requirements.txt', action: 'update', content: 'requests==2.31.0\n-rdeps/extra.txt\n' },
      { path: 'deps/extra.txt', action: 'create', content: '-r ../more/base-deps.txt\nevil-pkg==1.0\n' },
      { path: 'more/base-deps.txt', action: 'create', content: 'another-evil\n' },
      { path: 'notes.txt', action: 'create', content: 'not-a-package\n' },
    ]);
    expect(result.findings.map((f) => [f.name, f.file])).toEqual([
      ['evil-pkg', 'deps/extra.txt'],
      ['requirements file ../more/base-deps.txt', 'deps/extra.txt'],
      ['another-evil', 'more/base-deps.txt'],
      ['requirements file deps/extra.txt', 'requirements.txt'],
    ]);
  });

  it('reports renamed and re-created dependency files against their new path', async () => {
    const result = await detect({ 'yarn.lock': 'express@^4.18.0:\n  version "4.18.2"\n' }, [
      { path: 'yarn.lock', action: 'delete' },
      { path: 'apps/web/yarn.lock', action: 'create', content: 'express@^4.18.0:\n  version "4.18.2"\n' },
    ]);
    expect(result.findings.map((f) => [f.name, f.file, f.reason])).toEqual([['express', 'apps/web/yarn.lock', LOCKFILE_FINDING_REASONS.undeclared]]);
  });
});

describe('fingerprints and approval payloads', () => {
  it('is independent of change order and changes when the set of additions changes', async () => {
    const a = { path: 'package.json', action: 'create' as const, content: json({ dependencies: { zod: '^4' } }) };
    const b = { path: '.vscode/extensions.json', action: 'create' as const, content: json({ recommendations: ['a.b'] }) };
    const first = await detect({}, [a, b]);
    const second = await detect({}, [b, a]);
    expect(first.fingerprint).toBe(second.fingerprint);

    const more = await detect({}, [a, b, { path: 'requirements.txt', action: 'create', content: 'requests\n' }]);
    expect(more.fingerprint).not.toBe(first.fingerprint);
    const otherVersion = await detect({}, [{ ...a, content: json({ dependencies: { zod: '^5' } }) }, b]);
    expect(otherVersion.fingerprint).not.toBe(first.fingerprint);
    expect(dependencyFingerprint([])).toBeNull();
  });

  it('grants exactly the approved fingerprint and rebuilds links when reading stored details', async () => {
    const detection = await detect({}, [{ path: '.mcp.json', action: 'create', content: json({ mcpServers: { x: { command: 'npx', args: ['left-pad'] } } }) }]);
    const details = dependencyApprovalDetails(detection);
    expect(details).toMatchObject({ totalFindings: 1, highRisk: true, paths: ['.mcp.json'] });
    expect(approvalGrant({ action: 'dependency_addition', details: { ...details } })).toBe(`dependency_addition:${detection.fingerprint}`);
    expect(approvalGrant({ action: 'dependency_addition', details: {} })).toBeNull();
    expect(approvalGrant({ action: 'database_migration', details: {} })).toBe('database_migration');

    const tampered = { ...details, findings: details.findings.map((f) => ({ ...f, registryUrl: 'https://evil.example/', risk: 'normal' as const })) };
    const read = readDependencyApprovalDetails({ action: 'dependency_addition', details: tampered });
    expect(read!.findings[0]).toMatchObject({ registryUrl: 'https://www.npmjs.com/package/left-pad', risk: 'high' });
    expect(readDependencyApprovalDetails({ action: 'database_migration', details: tampered })).toBeNull();
    expect(readDependencyApprovalDetails({ action: 'dependency_addition', details: { findings: 'nope' } })).toBeNull();
  });

  it('builds registry links only from allow-listed templates and valid names', () => {
    expect(registryUrl('npm', 'javascript:alert(1)')).toBeNull();
    expect(registryUrl('npm', '../../evil')).toBeNull();
    expect(registryUrl('github_actions', 'owner/..')).toBeNull();
    expect(registryUrl('maven', 'a:b:c')).toBeNull();
    expect(registryUrl('go', 'notadomain/pkg')).toBeNull();
    expect(registryUrl('mcp', 'server')).toBeNull();
    const samples = [
      registryUrl('npm', '@a/b'),
      registryUrl('pypi', 'Foo.Bar'),
      registryUrl('cargo', 'serde'),
      registryUrl('go', 'golang.org/x/text'),
      registryUrl('rubygems', 'rails'),
      registryUrl('packagist', 'a/b'),
      registryUrl('nuget', 'Serilog'),
      registryUrl('maven', 'g.h:a'),
      registryUrl('gradle_plugin', 'org.a.b'),
      registryUrl('github_actions', 'actions/checkout'),
      registryUrl('vscode', 'a.b'),
    ];
    for (const url of samples) expect(REGISTRY_URL_PREFIXES.some((prefix) => url!.startsWith(prefix))).toBe(true);
  });

  it('strips control and bidi characters from displayed names', () => {
    const [finding] = diffDependencyFile('package.json', null, json({ dependencies: { 'safe\u202egpj.exe': '1' } }));
    expect(finding!.name).toBe('safegpj.exe');
  });
});

describe('hostile inputs (ReDoS and size)', () => {
  const HUGE = 200_000;
  const fast = (fn: () => unknown) => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };

  it('parses pathological content in linear time', () => {
    const cases: Array<[string, string]> = [
      ['requirements.txt', `${'a'.repeat(HUGE)}[${'['.repeat(HUGE)}\n${'-'.repeat(HUGE)}\n${'#'.repeat(HUGE)}`],
      ['pyproject.toml', `[project]\ndependencies = ${'['.repeat(HUGE)}${'"x",'.repeat(HUGE / 4)}`],
      ['Cargo.toml', `[dependencies]\n${'a = { version = "1", '.repeat(HUGE / 20)}\n${'.'.repeat(HUGE)} = "1"`],
      ['go.mod', `require (\n${' \t'.repeat(HUGE)}\n${'//'.repeat(HUGE)}`],
      ['Gemfile', `gem ${"'".repeat(HUGE)}\ngem ${'"a", '.repeat(HUGE / 4)}`],
      ['.github/workflows/x.yml', `${'- '.repeat(HUGE)}uses: ${'@'.repeat(HUGE)}\n${'uses: a#'.repeat(HUGE / 8)}`],
      ['package.json', `{"dependencies": {${'"a":"1",'.repeat(HUGE / 8)}${'/*'.repeat(HUGE / 2)}`],
      ['.vscode/extensions.json', `{"recommendations": [${',]'.repeat(HUGE / 2)}${' '.repeat(HUGE)}]]]`],
      ['pom.xml', `${'<dependency>'.repeat(HUGE / 12)}${'<!--'.repeat(HUGE / 4)}`],
      ['App.csproj', `<PackageReference ${'Include="'.repeat(HUGE / 9)}`],
      ['build.gradle', `${'implementation('.repeat(HUGE / 15)}\n${'id '.repeat(HUGE / 3)}`],
      ['yarn.lock', `${'"a@1", '.repeat(HUGE / 8)}:\n`],
      ['pnpm-lock.yaml', `lockfileVersion: 9\nimporters:\n${'    dependencies:\n'.repeat(HUGE / 20)}`],
      ['pnpm-lock.yaml', `lockfileVersion: 9\npackages:\n${`  ${'@'.repeat(200)}/${'('.repeat(200)}:\n`.repeat(HUGE / 400)}`],
      ['package-lock.json', `{"lockfileVersion":1,"dependencies":${'{"a":{"version":"1","dependencies":'.repeat(2000)}{}${'}}'.repeat(2000)}}`],
      ['package-lock.json', json({ lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`${'node_modules/'.repeat(20)}p${i}`, { version: '1', resolved: `git+https://x/${i}#${'#'.repeat(20)}` }])) })],
      ['bun.lock', `{"workspaces":{"":{}},"packages":{${'"a":["@@@@@@@@",{}],'.repeat(HUGE / 20)}}}`],
      ['Gemfile.lock', `GEM\n  specs:\n${'    a ((((((((\n'.repeat(HUGE / 14)}DEPENDENCIES\n`],
      ['Cargo.lock', `${'[[package]]\nname = "a"\nsource = "git+x#####"\n'.repeat(HUGE / 40)}`],
      ['.mcp.json', json({ mcpServers: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`s${i}`, { command: 'docker', args: ['run', ...Array(50).fill('-e')] }])) })],
    ];
    for (const [path, content] of cases) {
      expect(fast(() => diffDependencyFile(path, null, content)), path).toBeLessThan(2_000);
    }
  });

  it('does not parse oversized files but gates them', () => {
    const [finding] = diffDependencyFile('package.json', '{}', `{"dependencies":{}}${' '.repeat(5_000_001)}`);
    expect(finding).toMatchObject({ uncertain: true });
    expect(finding!.reason).toMatch(/larger than/);
  });

  it('never throws on malformed JSON and strips comments without breaking strings', () => {
    expect(parseJsonLoose('{"a": "// not a comment", /* c */ "b": [1,2,],}')).toEqual({ a: '// not a comment', b: [1, 2] });
    expect(parseJsonLoose('{"a": "\\"/*"}')).toEqual({ a: '"/*' });
    expect(parseJsonLoose('{')).toBeUndefined();
    expect(diffDependencyFile('.mcp.json', null, '[]')[0]).toMatchObject({ uncertain: true });
    expect(diffDependencyFile('.claude/settings.json', null, json({ mcpServers: 'x' }))[0]).toMatchObject({ uncertain: true });
  });
});
