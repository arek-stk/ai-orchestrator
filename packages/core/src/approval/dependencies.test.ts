import { describe, expect, it } from 'vitest';
import {
  approvalGrant,
  classifyDependencyFile,
  dependencyApprovalDetails,
  dependencyFingerprint,
  detectDependencyAdditions,
  diffDependencyFile,
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

  it('does not report transitive lockfile packages or duplicates of manifest findings', async () => {
    const result = await detect({ 'package.json': manifest, 'package-lock.json': lock({ express: '^4.18.0' }, ['express']) }, [
      { path: 'package.json', action: 'update', content: json({ dependencies: { express: '^4.18.0', zod: '^4.1.0' } }) },
      { path: 'package-lock.json', action: 'update', content: lock({ express: '^4.18.0', zod: '^4.1.0' }, ['express', 'zod', 'some-transitive']) },
    ]);
    expect(result.findings.map((f) => [f.name, f.file])).toEqual([['zod', 'package.json']]);
  });

  it('compares flat lockfiles only when the manifest did not change', async () => {
    const yarnBase = '# yarn lockfile v1\n\nexpress@^4.18.0:\n  version "4.18.2"\n';
    const yarnNext = `${yarnBase}\n"left-pad@^1.3.0", left-pad@^1.0.0:\n  version "1.3.0"\n`;
    const lockOnly = await detect({ 'yarn.lock': yarnBase }, [{ path: 'yarn.lock', action: 'update', content: yarnNext }]);
    expect(names(lockOnly.findings)).toEqual(['left-pad']);

    const withBump = await detect({ 'yarn.lock': yarnBase, 'package.json': manifest }, [
      { path: 'package.json', action: 'update', content: json({ dependencies: { express: '^4.19.0' } }) },
      { path: 'yarn.lock', action: 'update', content: yarnNext },
    ]);
    expect(withBump.findings).toEqual([]);
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
      ['numpy', '>=1.26'],
    ]);
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
