import { createHash } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dependency addition detection (ADR-031)
//
// Every new third-party dependency needs a human approval, whatever proposed it and at every autonomy level. The
// detector compares the base and the new content of dependency manifests, lockfiles and developer-environment
// configs in a change set. All parsers are small, linear scanners (no backtracking regular expressions): the
// content comes from model output and repositories and is untrusted. Anything that cannot be parsed is reported as
// a possible addition, so it is gated rather than silently allowed.
// ---------------------------------------------------------------------------

export const DEPENDENCY_KINDS = ['package', 'github_action', 'mcp_server', 'claude_plugin', 'vscode_extension'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const DEPENDENCY_ECOSYSTEMS = [
  'npm',
  'pypi',
  'cargo',
  'go',
  'rubygems',
  'packagist',
  'nuget',
  'maven',
  'gradle_plugin',
  'github_actions',
  'docker',
  'mcp',
  'claude_plugins',
  'vscode',
  'unknown',
] as const;
export type DependencyEcosystem = (typeof DEPENDENCY_ECOSYSTEMS)[number];

/** Kinds that execute inside developer or CI environments with broad access: always high risk. */
export const HIGH_RISK_DEPENDENCY_KINDS: readonly DependencyKind[] = ['github_action', 'mcp_server', 'claude_plugin', 'vscode_extension'];

export interface DependencyFinding {
  kind: DependencyKind;
  ecosystem: DependencyEcosystem;
  name: string;
  /** Requested version or spec as written; null when none was given. */
  version: string | null;
  file: string;
  source: 'manifest' | 'lockfile' | 'config';
  /** Extra context, e.g. the MCP server entry that launches the package. */
  detail: string | null;
  /** The file could not be parsed reliably; the change is treated as a possible addition. */
  uncertain: boolean;
  reason: string | null;
  risk: 'high' | 'normal';
  /** Built from a fixed per-ecosystem template and a validated name; never taken from repository text. */
  registryUrl: string | null;
}

export interface DependencyDetection {
  findings: DependencyFinding[];
  /** Fingerprint of the sorted findings; null when nothing was added. */
  fingerprint: string | null;
}

export type ChangedFileLike = { path: string; action: 'create' | 'update' | 'delete'; content?: string };
export type ReadBaseContent = (path: string) => Promise<string | null>;

/** Files above this size are not parsed and count as a possible addition. */
export const MAX_PARSED_FILE_CHARS = 5_000_000;
/** Findings stored in an approval request; the fingerprint always covers all of them. */
export const MAX_APPROVAL_FINDINGS = 200;

// ---------------------------------------------------------------------------
// Text helpers (linear)
// ---------------------------------------------------------------------------

// Control characters, zero-width and bidi overrides: stripped from everything shown to a human.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function clean(text: string, max: number): string {
  const stripped = text.replace(UNSAFE_CHARS, '').trim();
  return stripped.length <= max ? stripped : `${stripped.slice(0, max - 1)}…`;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function leadingSpaces(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function splitWs(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const ch of text) {
    if (isWs(ch)) {
      if (current) parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`') && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

/** Strips `#` comments that start a line or follow whitespace and are not inside quotes. */
function stripHashComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || isWs(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes `//` and block comments and trailing commas outside strings (JSONC, e.g. `.vscode/extensions.json`). */
export function stripJsonComments(text: string): string {
  const out: string[] = [];
  let last = -1;
  let beforeLast = -1;
  const push = (ch: string) => {
    out.push(ch);
    if (!isWs(ch)) {
      beforeLast = last;
      last = out.length - 1;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      push(ch);
      for (i++; i < text.length; i++) {
        const c = text[i]!;
        out.push(c);
        if (c === '\\' && i + 1 < text.length) {
          out.push(text[++i]!);
        } else if (c === '"') break;
      }
      beforeLast = last;
      last = out.length - 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if ((ch === '}' || ch === ']') && last >= 0 && out[last] === ',') {
      out[last] = ' ';
      last = beforeLast;
      beforeLast = -1;
    }
    push(ch);
  }
  return out.join('');
}

/** JSON.parse with a JSONC fallback; undefined when the text is not valid JSON either way. */
export function parseJsonLoose(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(stripJsonComments(body));
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal TOML reader: tables, dotted keys, strings, multi-line arrays and inline tables
// ---------------------------------------------------------------------------

export interface TomlEntry {
  /** Header path of the table the key belongs to. */
  table: string[];
  /** Increments with every table header, so `[[package]]` items can be grouped. */
  tableIndex: number;
  key: string[];
  /** Raw value text (multi-line arrays joined). */
  value: string;
}

function splitDotted(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '.') {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** Bracket depth change of a line, ignoring brackets inside strings and after `#`. Returns the cleaned line too. */
function scanToml(line: string): { text: string; depth: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return { text: line.slice(0, i), depth };
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return { text: line, depth };
}

function indexOutsideQuotes(text: string, target: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === target) return i;
  }
  return -1;
}

export function readToml(text: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  let table: string[] = [];
  let tableIndex = 0;
  let pending: { key: string[]; value: string; depth: number } | null = null;

  for (const raw of splitLines(text)) {
    const { text: line, depth } = scanToml(raw);
    if (pending) {
      pending.value += `\n${line}`;
      pending.depth += depth;
      if (pending.depth <= 0) {
        entries.push({ table, tableIndex, key: pending.key, value: pending.value.trim() });
        pending = null;
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) {
      const inner = trimmed.startsWith('[[') ? trimmed.slice(2, trimmed.lastIndexOf(']]')) : trimmed.slice(1, trimmed.lastIndexOf(']'));
      table = splitDotted(inner);
      tableIndex++;
      continue;
    }
    const eq = indexOutsideQuotes(trimmed, '=');
    if (eq <= 0) continue;
    const key = splitDotted(trimmed.slice(0, eq));
    const value = trimmed.slice(eq + 1).trim();
    const valueDepth = scanToml(value).depth;
    if (valueDepth > 0) pending = { key, value, depth: valueDepth };
    else entries.push({ table, tableIndex, key, value });
  }
  if (pending) entries.push({ table, tableIndex, key: pending.key, value: pending.value.trim() });
  return entries;
}

/** Top-level string elements of a TOML/inline array (strings nested in inline tables are skipped). */
function tomlArrayStrings(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let braces = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      let str = '';
      while (end < value.length && value[end] !== ch) {
        if (value[end] === '\\' && ch === '"' && end + 1 < value.length) end++;
        str += value[end];
        end++;
      }
      if (depth === 1 && braces === 0) out.push(str);
      i = end;
    } else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '#') {
      const nl = value.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
    }
  }
  return out;
}

function tomlStringValue(value: string): string | null {
  const t = value.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'")) {
    const end = t.indexOf(t[0]!, 1);
    return end === -1 ? null : t.slice(1, end);
  }
  return null;
}

/** Fields of an inline table `{ version = "1", package = "x" }` (one level). */
function tomlInlineTable(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  const t = value.trim();
  if (!t.startsWith('{')) return fields;
  const body = t.slice(1, t.lastIndexOf('}') === -1 ? t.length : t.lastIndexOf('}'));
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const eq = indexOutsideQuotes(part, '=');
    if (eq <= 0) continue;
    fields.set(splitDotted(part.slice(0, eq)).join('.'), part.slice(eq + 1).trim());
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Entries and per-ecosystem parsers
// ---------------------------------------------------------------------------

interface Entry {
  kind: DependencyKind;
  ecosystem: DependencyEcosystem;
  name: string;
  version: string | null;
  /** Identity used to decide whether the entry already existed in the base. */
  key: string;
  detail?: string;
  uncertain?: boolean;
  reason?: string;
}

const pkg = (ecosystem: DependencyEcosystem, name: string, version: string | null, key: string, extra: Partial<Entry> = {}): Entry => ({
  kind: 'package',
  ecosystem,
  name,
  version,
  key,
  ...extra,
});

/** PEP 503 normalisation without regular expressions. */
export function normalizePypiName(name: string): string {
  let out = '';
  let separator = false;
  for (const ch of name.toLowerCase()) {
    if (ch === '-' || ch === '_' || ch === '.') separator = true;
    else {
      if (separator && out) out += '-';
      separator = false;
      out += ch;
    }
  }
  return out;
}

const isAlnum = (ch: string | undefined) => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'));
const isPypiNameChar = (ch: string | undefined) => isAlnum(ch) || ch === '-' || ch === '_' || ch === '.';

/** One PEP 508 requirement (`name[extra]>=1; marker`, `name @ url`). */
function parsePep508(spec: string): Entry | null {
  const text = spec.trim();
  if (!text) return null;
  if (!isAlnum(text[0])) {
    return pkg('pypi', clean(text, 200), null, `pypi:raw:${text}`, { uncertain: true, reason: 'Requirement is a URL or path, not a registry package' });
  }
  let i = 0;
  while (i < text.length && isPypiNameChar(text[i])) i++;
  const name = text.slice(0, i);
  let rest = text.slice(i).trim();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    rest = close === -1 ? '' : rest.slice(close + 1).trim();
  }
  const semicolon = rest.indexOf(';');
  if (semicolon !== -1) rest = rest.slice(0, semicolon).trim();
  const normalized = normalizePypiName(name);
  if (rest.startsWith('@')) {
    const url = rest.slice(1).trim();
    return pkg('pypi', name, url ? clean(url, 200) : null, `pypi:${normalized}@url:${url}`);
  }
  return pkg('pypi', name, rest ? rest : null, `pypi:${normalized}`);
}

function parseRequirementsTxt(text: string): Entry[] {
  const entries: Entry[] = [];
  const lines = splitLines(text);
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n]!;
    while (line.endsWith('\\') && n + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++n]!}`;
    line = stripHashComment(line).trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      const [flag = '', ...values] = splitWs(line.replace('=', ' '));
      const value = values.join(' ');
      if (flag === '-i' || flag === '--index-url' || flag === '--extra-index-url' || flag === '-f' || flag === '--find-links') {
        entries.push(pkg('pypi', `package index ${clean(value, 180)}`, null, `pypi:index:${value}`, { reason: 'Adds a package index or download location' }));
      } else if (flag === '-e' || flag === '--editable') {
        if (value.startsWith('.') || value.startsWith('/')) continue;
        const egg = value.indexOf('#egg=');
        const name = egg === -1 ? clean(value, 200) : clean(value.slice(egg + 5), 200);
        entries.push(pkg('pypi', name, null, `pypi:editable:${value}`, { reason: 'Editable install from a VCS or URL' }));
      }
      continue;
    }
    const entry = parsePep508(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parsePackageJson(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = json[section];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return null;
    for (const [name, spec] of Object.entries(deps)) {
      const entry = npmEntry(name, typeof spec === 'string' ? spec : null);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function npmEntry(name: string, spec: string | null): Entry | null {
  const version = spec?.trim() ?? null;
  if (version && (version.startsWith('workspace:') || version.startsWith('file:') || version.startsWith('link:') || version.startsWith('portal:'))) return null;
  if (version?.startsWith('npm:')) {
    // Alias: the package that is actually installed is the aliased one.
    const target = version.slice(4);
    const at = target.lastIndexOf('@');
    const real = at > 0 ? target.slice(0, at) : target;
    return pkg('npm', real, at > 0 ? target.slice(at + 1) : null, `npm:${real.toLowerCase()}`, { detail: `alias ${clean(name, 100)}` });
  }
  if (version && (version.includes('://') || version.startsWith('github:') || version.startsWith('git+') || version.startsWith('gitlab:') || version.startsWith('bitbucket:') || isGitHubShorthand(version))) {
    const hash = version.indexOf('#');
    const source = hash === -1 ? version : version.slice(0, hash);
    return pkg('npm', name, clean(version, 200), `npm:${name.toLowerCase()}@${source}`, { reason: 'Installed from a URL or Git repository instead of the registry' });
  }
  return pkg('npm', name, version, `npm:${name.toLowerCase()}`);
}

function isGitHubShorthand(spec: string): boolean {
  const slash = spec.indexOf('/');
  return slash > 0 && !spec.startsWith('@') && !spec.includes(' ') && isAlnum(spec[0]);
}

function parseNpmLock(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  if (isRecord(json.packages)) {
    // v2/v3: entries without node_modules in the key are the root and workspaces; their dependency maps are the
    // top-level (direct) dependencies.
    for (const [key, value] of Object.entries(json.packages)) {
      if (key.includes('node_modules') || !isRecord(value)) continue;
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = value[section];
        if (!isRecord(deps)) continue;
        for (const [name, spec] of Object.entries(deps)) {
          const entry = npmEntry(name, typeof spec === 'string' ? spec : null);
          if (entry) entries.push(entry);
        }
      }
    }
    return entries;
  }
  if (isRecord(json.dependencies)) {
    for (const [name, value] of Object.entries(json.dependencies)) {
      entries.push(pkg('npm', name, isRecord(value) && typeof value.version === 'string' ? value.version : null, `npm:${name.toLowerCase()}`));
    }
    return entries;
  }
  return json.lockfileVersion === undefined ? null : entries;
}

function parseBunLock(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json) || !isRecord(json.workspaces)) return null;
  const entries: Entry[] = [];
  for (const workspace of Object.values(json.workspaces)) {
    if (!isRecord(workspace)) continue;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = workspace[section];
      if (!isRecord(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const entry = npmEntry(name, typeof spec === 'string' ? spec : null);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

function yamlKey(trimmed: string): string | null {
  const colon = indexOutsideQuotes(trimmed, ':');
  if (colon <= 0) return null;
  return unquote(trimmed.slice(0, colon));
}

/** pnpm-lock.yaml: direct dependencies of every importer (or of the root for old lockfiles). */
function parsePnpmLock(text: string): Entry[] | null {
  if (!text.includes('lockfileVersion')) return null;
  const entries: Entry[] = [];
  let inImporters = false;
  let hasImporters = false;
  let sectionIndent = -1;
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = leadingSpaces(line);
    if (indent === 0) {
      inImporters = trimmed === 'importers:';
      hasImporters ||= inImporters;
      sectionIndent = !hasImporters && isDependencySection(yamlKey(trimmed)) ? 0 : -1;
      continue;
    }
    if (sectionIndent >= 0 && indent <= sectionIndent) sectionIndent = -1;
    if (inImporters && indent === 4 && isDependencySection(yamlKey(trimmed))) {
      sectionIndent = 4;
      continue;
    }
    if (sectionIndent >= 0 && indent === sectionIndent + 2) {
      const name = yamlKey(trimmed);
      if (name) entries.push(pkg('npm', name, null, `npm:${name.toLowerCase()}`));
    }
  }
  return entries;
}

function isDependencySection(key: string | null): boolean {
  return key === 'dependencies' || key === 'devDependencies' || key === 'optionalDependencies';
}

/** yarn.lock (classic and berry): every resolved package. Flat, so only compared without a manifest change. */
function parseYarnLock(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of splitLines(text)) {
    if (!line || line[0] === ' ' || line[0] === '#' || !line.trimEnd().endsWith(':')) continue;
    const header = line.trimEnd().slice(0, -1);
    for (const descriptor of header.split(',')) {
      const d = unquote(descriptor);
      if (!d || d === '__metadata') continue;
      const at = d.indexOf('@', 1);
      const name = at === -1 ? d : d.slice(0, at);
      entries.push(pkg('npm', name, null, `npm:${name.toLowerCase()}`));
    }
  }
  return entries;
}

function parsePyproject(text: string): Entry[] {
  const entries: Entry[] = [];
  const poetrySubtables = new Map<number, Entry>();
  for (const e of readToml(text)) {
    const t = e.table.join('.');
    const k = e.key.join('.');
    const strings = () => tomlArrayStrings(e.value).map(parsePep508).filter((x): x is Entry => x !== null);
    if ((t === 'project' && k === 'dependencies') || (t === 'build-system' && k === 'requires') || (t === 'tool.uv' && k === 'dev-dependencies')) {
      entries.push(...strings());
    } else if (t === 'project.optional-dependencies' || t === 'dependency-groups' || t === 'tool.pdm.dev-dependencies' || (t === 'project' && e.key[0] === 'optional-dependencies')) {
      entries.push(...strings());
    } else if (isPoetryDependencyTable(e.table)) {
      if (k === 'python') continue;
      entries.push(poetryEntry(e.key.join('.'), e.value));
    } else if (e.table.length > 1 && isPoetryDependencyTable(e.table.slice(0, -1))) {
      const name = e.table[e.table.length - 1]!;
      const existing = poetrySubtables.get(e.tableIndex) ?? pkg('pypi', name, null, `pypi:${normalizePypiName(name)}`);
      if (k === 'version') existing.version = tomlStringValue(e.value);
      if (k === 'git' || k === 'url') existing.key = `pypi:${normalizePypiName(name)}@${tomlStringValue(e.value) ?? ''}`;
      poetrySubtables.set(e.tableIndex, existing);
    }
  }
  return [...entries, ...poetrySubtables.values()];
}

function isPoetryDependencyTable(table: readonly string[]): boolean {
  const t = table.join('.');
  if (t === 'tool.poetry.dependencies' || t === 'tool.poetry.dev-dependencies') return true;
  return table.length === 5 && table[0] === 'tool' && table[1] === 'poetry' && table[2] === 'group' && table[4] === 'dependencies';
}

function poetryEntry(name: string, value: string): Entry {
  const inline = tomlInlineTable(value);
  const version = tomlStringValue(value) ?? tomlStringValue(inline.get('version') ?? '');
  const source = tomlStringValue(inline.get('git') ?? '') ?? tomlStringValue(inline.get('url') ?? '');
  return pkg('pypi', name, version ?? (source ? clean(source, 200) : null), `pypi:${normalizePypiName(name)}${source ? `@${source}` : ''}`);
}

function parsePipfile(text: string): Entry[] {
  return readToml(text)
    .filter((e) => (e.table.join('.') === 'packages' || e.table.join('.') === 'dev-packages') && e.key.length === 1)
    .map((e) => poetryEntry(e.key[0]!, e.value));
}

const CARGO_SECTIONS = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

function parseCargoToml(text: string): Entry[] {
  const entries: Entry[] = [];
  const subtables = new Map<number, { name: string; fields: Map<string, string> }>();
  for (const e of readToml(text)) {
    const last = e.table[e.table.length - 1];
    if (last && CARGO_SECTIONS.has(last)) {
      if (e.key.length === 2 && e.key[1] === 'workspace') continue; // `serde.workspace = true` inherits a root entry
      const entry = cargoEntry(e.key[0]!, tomlStringValue(e.value), tomlInlineTable(e.value));
      if (entry) entries.push(entry);
    } else if (e.table.length >= 2 && CARGO_SECTIONS.has(e.table[e.table.length - 2]!)) {
      const item = subtables.get(e.tableIndex) ?? { name: e.table[e.table.length - 1]!, fields: new Map<string, string>() };
      item.fields.set(e.key.join('.'), e.value);
      subtables.set(e.tableIndex, item);
    }
  }
  for (const { name, fields } of subtables.values()) {
    const entry = cargoEntry(name, null, fields);
    if (entry) entries.push(entry);
  }
  return entries;
}

function cargoEntry(name: string, plainVersion: string | null, fields: Map<string, string>): Entry | null {
  if (fields.get('workspace')?.trim() === 'true') return null;
  if (fields.has('path') && !fields.has('version') && !fields.has('git')) return null;
  const real = tomlStringValue(fields.get('package') ?? '') ?? name;
  const git = tomlStringValue(fields.get('git') ?? '');
  const version = plainVersion ?? tomlStringValue(fields.get('version') ?? '');
  return pkg('cargo', real, version ?? (git ? clean(git, 200) : null), `cargo:${real.toLowerCase()}${git ? `@${git}` : ''}`, real !== name ? { detail: `renamed to ${clean(name, 100)}` } : {});
}

function parseGradleCatalog(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const e of readToml(text)) {
    const table = e.table.join('.');
    if (table !== 'libraries' && table !== 'plugins') continue;
    const inline = tomlInlineTable(e.value);
    const plain = tomlStringValue(e.value);
    if (table === 'libraries') {
      let coordinate = plain ?? tomlStringValue(inline.get('module') ?? '');
      if (!coordinate) {
        const group = tomlStringValue(inline.get('group') ?? '');
        const name = tomlStringValue(inline.get('name') ?? '');
        coordinate = group && name ? `${group}:${name}` : null;
      }
      if (!coordinate) continue;
      const [group = '', artifact = '', version = null] = coordinate.split(':');
      entries.push(pkg('maven', `${group}:${artifact}`, version ?? tomlStringValue(inline.get('version') ?? ''), `maven:${group}:${artifact}`.toLowerCase()));
    } else {
      const id = plain ? plain.split(':')[0]! : tomlStringValue(inline.get('id') ?? '');
      if (id) entries.push(pkg('gradle_plugin', id, plain?.split(':')[1] ?? tomlStringValue(inline.get('version') ?? ''), `gradle_plugin:${id.toLowerCase()}`));
    }
  }
  return entries;
}

/** Cargo.lock, poetry.lock, uv.lock, pdm.lock: `[[package]]` items. Registry packages only for Cargo. */
function parseTomlLock(text: string, ecosystem: 'cargo' | 'pypi'): Entry[] {
  const items = new Map<number, { name?: string; version?: string; source: boolean }>();
  for (const e of readToml(text)) {
    if (e.table.join('.') !== 'package' || e.key.length !== 1) continue;
    const item = items.get(e.tableIndex) ?? { source: false };
    if (e.key[0] === 'name') item.name = tomlStringValue(e.value) ?? undefined;
    if (e.key[0] === 'version') item.version = tomlStringValue(e.value) ?? undefined;
    if (e.key[0] === 'source') item.source = true;
    items.set(e.tableIndex, item);
  }
  const entries: Entry[] = [];
  for (const item of items.values()) {
    if (!item.name || (ecosystem === 'cargo' && !item.source)) continue;
    const key = ecosystem === 'cargo' ? `cargo:${item.name.toLowerCase()}` : `pypi:${normalizePypiName(item.name)}`;
    entries.push(pkg(ecosystem, item.name, item.version ?? null, key));
  }
  return entries;
}

function parsePipfileLock(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  for (const section of ['default', 'develop']) {
    const deps = json[section];
    if (!isRecord(deps)) continue;
    for (const [name, value] of Object.entries(deps)) {
      entries.push(pkg('pypi', name, isRecord(value) && typeof value.version === 'string' ? value.version : null, `pypi:${normalizePypiName(name)}`));
    }
  }
  return entries;
}

function parseGoMod(text: string): Entry[] {
  const entries: Entry[] = [];
  let block: string | null = null;
  for (const raw of splitLines(text)) {
    const comment = raw.indexOf('//');
    const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    if (!line) continue;
    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      pushGoDirective(entries, block, splitWs(line));
      continue;
    }
    const tokens = splitWs(line);
    const directive = tokens[0];
    if (directive !== 'require' && directive !== 'replace' && directive !== 'tool') continue;
    if (tokens[1] === '(') block = directive;
    else pushGoDirective(entries, directive, tokens.slice(1));
  }
  return entries;
}

function pushGoDirective(entries: Entry[], directive: string, tokens: string[]): void {
  if (directive === 'replace') {
    const arrow = tokens.indexOf('=>');
    const target = arrow === -1 ? undefined : tokens[arrow + 1];
    if (!target || target.startsWith('.') || target.startsWith('/')) return;
    const module = unquote(target);
    entries.push(pkg('go', module, tokens[arrow + 2] ?? null, `go:${module}`, { detail: `replaces ${clean(unquote(tokens[0] ?? ''), 150)}` }));
    return;
  }
  const module = tokens[0] ? unquote(tokens[0]) : '';
  if (!module) return;
  entries.push(pkg('go', module, directive === 'tool' ? null : (tokens[1] ?? null), directive === 'tool' ? `go:tool:${module}` : `go:${module}`));
}

function parseGoSum(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of splitLines(text)) {
    const [module, version] = splitWs(line);
    if (module && version) entries.push(pkg('go', module, version.endsWith('/go.mod') ? version.slice(0, -7) : version, `go:${module}`));
  }
  return entries;
}

function quotedAfter(text: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < text.length && text[i] !== '"' && text[i] !== "'") i++;
  if (i >= text.length) return null;
  const end = text.indexOf(text[i]!, i + 1);
  return end === -1 ? null : { value: text.slice(i + 1, end), end };
}

function parseGemfile(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of splitLines(text)) {
    const line = stripHashComment(raw).trim();
    if (!line.startsWith('gem') || !(isWs(line[3]) || line[3] === '(')) continue;
    const name = quotedAfter(line, 3);
    if (!name) continue;
    const rest = line.slice(name.end + 1);
    let version: string | null = null;
    const comma = rest.trimStart();
    if (comma.startsWith(',')) {
      const after = comma.slice(1).trimStart();
      if (after.startsWith('"') || after.startsWith("'")) version = quotedAfter(after, 0)?.value ?? null;
    }
    const gitAt = Math.max(rest.indexOf('git:'), rest.indexOf('github:'), rest.indexOf(':git'));
    const git = gitAt === -1 ? null : (quotedAfter(rest, gitAt)?.value ?? null);
    if (rest.includes('path:') && !git) continue;
    entries.push(pkg('rubygems', name.value, version ?? (git ? clean(git, 200) : null), `rubygems:${name.value.toLowerCase()}${git ? `@${git}` : ''}`));
  }
  return entries;
}

function parseGemfileLock(text: string): Entry[] | null {
  const entries: Entry[] = [];
  let inDependencies = false;
  let seen = false;
  for (const line of splitLines(text)) {
    if (line && line[0] !== ' ') {
      inDependencies = line.trim() === 'DEPENDENCIES';
      seen ||= inDependencies;
      continue;
    }
    if (!inDependencies || leadingSpaces(line) !== 2) continue;
    const trimmed = line.trim();
    let end = 0;
    while (end < trimmed.length && !isWs(trimmed[end]) && trimmed[end] !== '!' && trimmed[end] !== '(') end++;
    const name = trimmed.slice(0, end);
    const open = trimmed.indexOf('(');
    const close = trimmed.lastIndexOf(')');
    if (name) entries.push(pkg('rubygems', name, open !== -1 && close > open ? trimmed.slice(open + 1, close) : null, `rubygems:${name.toLowerCase()}`));
  }
  return seen || text.trim() === '' ? entries : null;
}

function parseComposerJson(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  for (const section of ['require', 'require-dev']) {
    const deps = json[section];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return null;
    for (const [name, version] of Object.entries(deps)) {
      // Platform requirements (php, ext-*, lib-*) are not packages.
      if (!name.includes('/')) continue;
      entries.push(pkg('packagist', name, typeof version === 'string' ? version : null, `packagist:${name.toLowerCase()}`));
    }
  }
  return entries;
}

function parseComposerLock(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  for (const section of ['packages', 'packages-dev']) {
    const list = json[section];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item) && typeof item.name === 'string') {
        entries.push(pkg('packagist', item.name, typeof item.version === 'string' ? item.version : null, `packagist:${item.name.toLowerCase()}`));
      }
    }
  }
  return entries;
}

function stripXmlComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) return out + text.slice(from);
    out += text.slice(from, start);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) return out;
    from = end + 3;
  }
}

/** Attributes of one XML start tag, scanned linearly. */
function xmlAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  while (i < tag.length) {
    while (i < tag.length && !isAlnum(tag[i])) i++;
    const start = i;
    while (i < tag.length && (isAlnum(tag[i]) || tag[i] === ':' || tag[i] === '_' || tag[i] === '-')) i++;
    const name = tag.slice(start, i);
    while (isWs(tag[i])) i++;
    if (tag[i] !== '=') continue;
    i++;
    while (isWs(tag[i])) i++;
    const quote = tag[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = tag.indexOf(quote, i + 1);
    if (end === -1) break;
    attrs.set(name.toLowerCase(), tag.slice(i + 1, end));
    i = end + 1;
  }
  return attrs;
}

function parseNugetXml(text: string): Entry[] {
  const body = stripXmlComments(text);
  const entries: Entry[] = [];
  for (const [open, attr] of [
    ['<PackageReference', 'include'],
    ['<PackageVersion', 'include'],
    ['<package ', 'id'],
    ['<GlobalPackageReference', 'include'],
  ] as const) {
    let from = 0;
    for (;;) {
      const start = body.indexOf(open, from);
      if (start === -1) break;
      const end = body.indexOf('>', start);
      if (end === -1) break;
      const attrs = xmlAttributes(body.slice(start + open.length, end));
      from = end + 1;
      const name = attrs.get(attr);
      if (name) entries.push(pkg('nuget', name, attrs.get('version') ?? null, `nuget:${name.toLowerCase()}`));
    }
  }
  return entries;
}

function xmlChild(block: string, tag: string): string | null {
  const start = block.indexOf(`<${tag}>`);
  if (start === -1) return null;
  const end = block.indexOf(`</${tag}>`, start);
  return end === -1 ? null : block.slice(start + tag.length + 2, end).trim();
}

function parsePom(text: string): Entry[] {
  const body = stripXmlComments(text);
  const entries: Entry[] = [];
  for (const tag of ['dependency', 'plugin', 'extension', 'parent']) {
    let from = 0;
    for (;;) {
      const start = body.indexOf(`<${tag}>`, from);
      if (start === -1) break;
      const end = body.indexOf(`</${tag}>`, start);
      if (end === -1) break;
      from = end + tag.length + 3;
      const block = body.slice(start, end);
      const nested = block.indexOf('<dependencies>');
      const own = nested === -1 ? block : block.slice(0, nested);
      const artifact = xmlChild(own, 'artifactId');
      if (!artifact) continue;
      const group = xmlChild(own, 'groupId') ?? (tag === 'plugin' ? 'org.apache.maven.plugins' : '');
      entries.push(pkg('maven', `${group}:${artifact}`, xmlChild(own, 'version'), `maven:${group}:${artifact}`.toLowerCase()));
    }
  }
  return entries;
}

const GRADLE_CONFIGURATIONS = new Set([
  'implementation',
  'api',
  'compileOnly',
  'runtimeOnly',
  'testImplementation',
  'testCompileOnly',
  'testRuntimeOnly',
  'androidTestImplementation',
  'debugImplementation',
  'releaseImplementation',
  'annotationProcessor',
  'kapt',
  'ksp',
  'classpath',
  'compile',
  'testCompile',
  'developmentOnly',
  'coreLibraryDesugaring',
  'lintChecks',
  'detektPlugins',
]);

function isGradleConfiguration(name: string): boolean {
  return GRADLE_CONFIGURATIONS.has(name) || name.endsWith('Implementation') || name.endsWith('CompileOnly') || name.endsWith('RuntimeOnly') || name.endsWith('Api');
}

function parseGradle(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of splitLines(text)) {
    const comment = raw.indexOf('//');
    const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    let i = 0;
    while (i < line.length && isAlnum(line[i])) i++;
    const word = line.slice(0, i);
    const next = line[i];
    if (!word || !(next === '(' || next === ' ' || next === '\t' || next === '"' || next === "'")) continue;

    if (word === 'id' || word === 'kotlin') {
      const id = quotedAfter(line, i);
      if (!id) continue;
      const pluginId = word === 'kotlin' ? `org.jetbrains.kotlin.${id.value}` : id.value;
      const versionAt = line.indexOf('version', id.end);
      const version = versionAt === -1 ? null : (quotedAfter(line, versionAt + 7)?.value ?? null);
      entries.push(pkg('gradle_plugin', pluginId, version, `gradle_plugin:${pluginId.toLowerCase()}`));
      continue;
    }
    if (!isGradleConfiguration(word)) continue;
    const args = line.slice(i);
    if (args.includes('project(') || args.includes('files(') || args.includes('fileTree(') || args.includes('libs.') || args.includes('project (')) continue;
    const coordinate = quotedAfter(args, 0);
    if (coordinate && coordinate.value.includes(':') && !coordinate.value.startsWith(':')) {
      const [group = '', artifact = '', version = null] = coordinate.value.split(':');
      entries.push(pkg('maven', `${group}:${artifact}`, version, `maven:${group}:${artifact}`.toLowerCase()));
    } else if (args.includes('group') && args.includes('name')) {
      const group = quotedAfter(args, args.indexOf('group'))?.value ?? '';
      const name = quotedAfter(args, args.indexOf('name'))?.value ?? '';
      const versionAt = args.indexOf('version');
      entries.push(pkg('maven', `${group}:${name}`, versionAt === -1 ? null : (quotedAfter(args, versionAt)?.value ?? null), `maven:${group}:${name}`.toLowerCase()));
    } else if (coordinate === null && (args.startsWith('(') || isWs(args[0]))) {
      entries.push(pkg('maven', clean(line, 200), null, `maven:raw:${line}`, { uncertain: true, reason: 'Dependency declaration could not be parsed' }));
    }
  }
  return entries;
}

function parseGradleLockfile(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of splitLines(text)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('empty=')) continue;
    const eq = t.indexOf('=');
    const [group = '', artifact = '', version = null] = (eq === -1 ? t : t.slice(0, eq)).split(':');
    if (group && artifact) entries.push(pkg('maven', `${group}:${artifact}`, version, `maven:${group}:${artifact}`.toLowerCase()));
  }
  return entries;
}

function parseNugetLock(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json) || !isRecord(json.dependencies)) return null;
  const entries: Entry[] = [];
  for (const framework of Object.values(json.dependencies)) {
    if (!isRecord(framework)) continue;
    for (const [name, value] of Object.entries(framework)) {
      if (isRecord(value) && value.type === 'Direct') {
        entries.push(pkg('nuget', name, typeof value.requested === 'string' ? value.requested : null, `nuget:${name.toLowerCase()}`));
      }
    }
  }
  return entries;
}

function parseWorkflowUses(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of splitLines(text)) {
    let line = raw.trim();
    while (line.startsWith('- ')) line = line.slice(2).trim();
    if (line.startsWith('{')) line = line.slice(1).trim();
    if (!line.startsWith('uses:') && !line.startsWith('"uses":') && !line.startsWith("'uses':")) continue;
    let value = line.slice(line.indexOf(':') + 1);
    const comment = value.indexOf(' #');
    if (comment !== -1) value = value.slice(0, comment);
    const brace = value.indexOf('}');
    if (brace !== -1) value = value.slice(0, brace);
    value = unquote(value.trim().replace(/,$/, ''));
    if (!value || value.startsWith('./') || value.startsWith('.\\')) continue;
    if (value.startsWith('docker://')) {
      const image = value.slice(9);
      const at = image.indexOf('@');
      const lastSlash = image.lastIndexOf('/');
      const colon = image.indexOf(':', lastSlash + 1);
      const cut = at !== -1 ? at : colon;
      const name = cut === -1 ? image : image.slice(0, cut);
      entries.push({ kind: 'github_action', ecosystem: 'docker', name, version: cut === -1 ? null : image.slice(cut + 1), key: `docker:${name.toLowerCase()}` });
      continue;
    }
    const at = value.indexOf('@');
    const name = at === -1 ? value : value.slice(0, at);
    entries.push({ kind: 'github_action', ecosystem: 'github_actions', name, version: at === -1 ? null : value.slice(at + 1), key: `gha:${name.toLowerCase()}` });
  }
  return entries;
}

const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '-w', '--workdir', '--entrypoint', '--env-file', '-u', '--user', '--mount', '-l', '--label', '--platform']);

function splitPackageVersion(spec: string, separator: '@' | '=='): { name: string; version: string | null } {
  if (separator === '==') {
    const i = spec.indexOf('==');
    if (i !== -1) return { name: spec.slice(0, i), version: spec.slice(i + 2) };
  }
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: null };
}

function mcpServerEntries(servers: unknown): Entry[] | null {
  if (servers === undefined) return [];
  if (!isRecord(servers)) return null;
  const entries: Entry[] = [];
  for (const [server, def] of Object.entries(servers)) {
    const detail = `MCP server "${clean(server, 80)}"`;
    const base = { kind: 'mcp_server' as const, detail };
    if (!isRecord(def)) {
      entries.push({ ...base, ecosystem: 'mcp', name: server, version: null, key: `mcp:raw:${server}`, uncertain: true, reason: 'Server definition could not be parsed' });
      continue;
    }
    const url = typeof def.url === 'string' ? def.url : typeof def.serverUrl === 'string' ? def.serverUrl : null;
    if (url) {
      let target = url;
      try {
        const parsed = new URL(url);
        target = `${parsed.host.toLowerCase()}${parsed.pathname}`;
      } catch {
        // keep the raw URL as identity
      }
      entries.push({ ...base, ecosystem: 'mcp', name: server, version: null, key: `mcp:url:${target}`, detail: `${detail} at ${clean(target, 150)}` });
      continue;
    }
    const command = typeof def.command === 'string' ? def.command : '';
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [];
    let program = basename(command.replace(/\\/g, '/')).toLowerCase();
    for (const suffix of ['.cmd', '.exe']) if (program.endsWith(suffix)) program = program.slice(0, -suffix.length);

    const firstPositional = (list: readonly string[]) => list.find((a) => !a.startsWith('-'));
    let resolved: { ecosystem: DependencyEcosystem; spec: string; separator: '@' | '==' } | null = null;
    if (program === 'npx' || program === 'bunx' || program === 'pnpx') {
      const spec = firstPositional(args);
      if (spec) resolved = { ecosystem: 'npm', spec, separator: '@' };
    } else if ((program === 'pnpm' || program === 'yarn' || program === 'bun') && (args[0] === 'dlx' || args[0] === 'x')) {
      const spec = firstPositional(args.slice(1));
      if (spec) resolved = { ecosystem: 'npm', spec, separator: '@' };
    } else if (program === 'uvx' || (program === 'pipx' && args[0] === 'run')) {
      const from = args.indexOf('--from');
      const spec = from !== -1 ? args[from + 1] : firstPositional(program === 'pipx' ? args.slice(1) : args);
      if (spec) resolved = { ecosystem: 'pypi', spec, separator: '==' };
    } else if ((program === 'docker' || program === 'podman') && args[0] === 'run') {
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (DOCKER_VALUE_FLAGS.has(arg)) i++;
        else if (!arg.startsWith('-')) {
          const lastSlash = arg.lastIndexOf('/');
          const colon = arg.indexOf(':', lastSlash + 1);
          const name = colon === -1 ? arg : arg.slice(0, colon);
          entries.push({ ...base, ecosystem: 'docker', name, version: colon === -1 ? null : arg.slice(colon + 1), key: `mcp:docker:${name.toLowerCase()}` });
          break;
        }
      }
      continue;
    }
    if (resolved) {
      const { name, version } = splitPackageVersion(resolved.spec, resolved.separator);
      const key = resolved.ecosystem === 'npm' ? `mcp:npm:${name.toLowerCase()}` : `mcp:pypi:${normalizePypiName(name)}`;
      entries.push({ ...base, ecosystem: resolved.ecosystem, name, version, key });
      continue;
    }
    const commandLine = [command, ...args].join(' ');
    entries.push({ ...base, ecosystem: 'mcp', name: server, version: null, key: `mcp:cmd:${commandLine}`, detail: `${detail} runs ${clean(commandLine, 150)}` });
  }
  return entries;
}

function parseMcpJson(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  return mcpServerEntries(json.mcpServers ?? json.servers);
}

function parseClaudeSettings(text: string): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const entries: Entry[] = [];
  const plugin = (name: string, key: string, detail?: string): Entry => ({ kind: 'claude_plugin', ecosystem: 'claude_plugins', name, version: null, key, ...(detail ? { detail } : {}) });

  const enabled = json.enabledPlugins;
  if (isRecord(enabled)) {
    for (const [id, on] of Object.entries(enabled)) if (on !== false) entries.push(plugin(id, `claude:plugin:${id}`));
  } else if (Array.isArray(enabled)) {
    for (const id of enabled) if (typeof id === 'string') entries.push(plugin(id, `claude:plugin:${id}`));
  }
  if (isRecord(json.extraKnownMarketplaces)) {
    for (const [name, def] of Object.entries(json.extraKnownMarketplaces)) {
      const source = isRecord(def) && isRecord(def.source) ? def.source : {};
      const location = [source.repo, source.url, source.path, source.package].find((v): v is string => typeof v === 'string') ?? '';
      entries.push(plugin(`marketplace ${name}`, `claude:marketplace:${name}:${location}`, location ? `source ${clean(location, 150)}` : undefined));
    }
  }
  if (Array.isArray(json.enabledMcpjsonServers)) {
    for (const server of json.enabledMcpjsonServers) {
      if (typeof server === 'string') entries.push({ kind: 'mcp_server', ecosystem: 'mcp', name: server, version: null, key: `claude:mcpjson:${server}`, detail: 'enabled from .mcp.json' });
    }
  }
  if (json.enableAllProjectMcpServers === true) {
    entries.push({ kind: 'mcp_server', ecosystem: 'mcp', name: 'all project MCP servers', version: null, key: 'claude:mcpjson:*', detail: 'enableAllProjectMcpServers' });
  }
  const servers = mcpServerEntries(json.mcpServers);
  if (servers === null) return null;
  return [...entries, ...servers];
}

function parseVscodeRecommendations(text: string, workspaceFile: boolean): Entry[] | null {
  const json = parseJsonLoose(text);
  if (!isRecord(json)) return null;
  const container = workspaceFile ? json.extensions : json;
  if (container === undefined) return [];
  if (!isRecord(container)) return null;
  const list = container.recommendations;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  return list
    .filter((id): id is string => typeof id === 'string')
    .map((id) => ({ kind: 'vscode_extension' as const, ecosystem: 'vscode' as const, name: id, version: null, key: `vscode:${id.toLowerCase()}` }));
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

interface FileSpec {
  source: DependencyFinding['source'];
  ecosystem: DependencyEcosystem;
  kind: DependencyKind;
  parse: (text: string) => Entry[] | null;
  /**
   * Lockfiles that list every resolved package (not just direct dependencies) are only compared when no manifest of
   * the ecosystem changed in the same directory tree; otherwise transitive packages of a legitimate change would be
   * reported. The manifest basenames that pair with the lockfile.
   */
  flatWith?: readonly string[];
}

const PACKAGE_MANIFEST: Pick<FileSpec, 'source' | 'kind'> = { source: 'manifest', kind: 'package' };
const LOCKFILE: Pick<FileSpec, 'source' | 'kind'> = { source: 'lockfile', kind: 'package' };

export function classifyDependencyFile(path: string): FileSpec | null {
  const normalized = path.replace(/\\/g, '/');
  const name = basename(normalized).toLowerCase();
  const dir = dirname(normalized).toLowerCase();

  switch (name) {
    case 'package.json':
      return { ...PACKAGE_MANIFEST, ecosystem: 'npm', parse: parsePackageJson };
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return { ...LOCKFILE, ecosystem: 'npm', parse: parseNpmLock };
    case 'pnpm-lock.yaml':
      return { ...LOCKFILE, ecosystem: 'npm', parse: parsePnpmLock };
    case 'bun.lock':
      return { ...LOCKFILE, ecosystem: 'npm', parse: parseBunLock };
    case 'bun.lockb':
      return { ...LOCKFILE, ecosystem: 'npm', parse: () => null, flatWith: ['package.json'] };
    case 'yarn.lock':
      return { ...LOCKFILE, ecosystem: 'npm', parse: parseYarnLock, flatWith: ['package.json'] };
    case 'pyproject.toml':
      return { ...PACKAGE_MANIFEST, ecosystem: 'pypi', parse: parsePyproject };
    case 'pipfile':
      return { ...PACKAGE_MANIFEST, ecosystem: 'pypi', parse: parsePipfile };
    case 'pipfile.lock':
      return { ...LOCKFILE, ecosystem: 'pypi', parse: parsePipfileLock, flatWith: ['pipfile'] };
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
      return { ...LOCKFILE, ecosystem: 'pypi', parse: (t) => parseTomlLock(t, 'pypi'), flatWith: ['pyproject.toml'] };
    case 'cargo.toml':
      return { ...PACKAGE_MANIFEST, ecosystem: 'cargo', parse: parseCargoToml };
    case 'cargo.lock':
      return { ...LOCKFILE, ecosystem: 'cargo', parse: (t) => parseTomlLock(t, 'cargo'), flatWith: ['cargo.toml'] };
    case 'go.mod':
      return { ...PACKAGE_MANIFEST, ecosystem: 'go', parse: parseGoMod };
    case 'go.sum':
      return { ...LOCKFILE, ecosystem: 'go', parse: parseGoSum, flatWith: ['go.mod'] };
    case 'gemfile':
      return { ...PACKAGE_MANIFEST, ecosystem: 'rubygems', parse: parseGemfile };
    case 'gemfile.lock':
      return { ...LOCKFILE, ecosystem: 'rubygems', parse: parseGemfileLock };
    case 'composer.json':
      return { ...PACKAGE_MANIFEST, ecosystem: 'packagist', parse: parseComposerJson };
    case 'composer.lock':
      return { ...LOCKFILE, ecosystem: 'packagist', parse: parseComposerLock, flatWith: ['composer.json'] };
    case 'packages.config':
    case 'directory.packages.props':
    case 'directory.build.props':
    case 'directory.build.targets':
      return { ...PACKAGE_MANIFEST, ecosystem: 'nuget', parse: parseNugetXml };
    case 'packages.lock.json':
      return { ...LOCKFILE, ecosystem: 'nuget', parse: parseNugetLock };
    case 'pom.xml':
      return { ...PACKAGE_MANIFEST, ecosystem: 'maven', parse: parsePom };
    case 'build.gradle':
    case 'build.gradle.kts':
    case 'settings.gradle':
    case 'settings.gradle.kts':
      return { ...PACKAGE_MANIFEST, ecosystem: 'maven', parse: parseGradle };
    case 'gradle.lockfile':
      return { ...LOCKFILE, ecosystem: 'maven', parse: parseGradleLockfile, flatWith: ['build.gradle', 'build.gradle.kts'] };
    case 'extensions.json':
      return dir === '.vscode' || dir.endsWith('/.vscode') ? { source: 'config', kind: 'vscode_extension', ecosystem: 'vscode', parse: (t) => parseVscodeRecommendations(t, false) } : null;
    case '.mcp.json':
      return { source: 'config', kind: 'mcp_server', ecosystem: 'mcp', parse: parseMcpJson };
    case 'mcp.json':
      return dir.endsWith('.vscode') || dir.endsWith('.cursor') ? { source: 'config', kind: 'mcp_server', ecosystem: 'mcp', parse: parseMcpJson } : null;
    case 'settings.json':
    case 'settings.local.json':
      return dir === '.claude' || dir.endsWith('/.claude') ? { source: 'config', kind: 'claude_plugin', ecosystem: 'claude_plugins', parse: parseClaudeSettings } : null;
    case 'action.yml':
    case 'action.yaml':
      return { source: 'config', kind: 'github_action', ecosystem: 'github_actions', parse: parseWorkflowUses };
    default:
      break;
  }
  if ((name.endsWith('.yml') || name.endsWith('.yaml')) && (dir === '.github/workflows' || dir.endsWith('/.github/workflows'))) {
    return { source: 'config', kind: 'github_action', ecosystem: 'github_actions', parse: parseWorkflowUses };
  }
  if ((name.startsWith('requirements') && (name.endsWith('.txt') || name.endsWith('.in'))) || ((dir === 'requirements' || dir.endsWith('/requirements')) && name.endsWith('.txt'))) {
    return { ...PACKAGE_MANIFEST, ecosystem: 'pypi', parse: parseRequirementsTxt };
  }
  if (name.endsWith('.csproj') || name.endsWith('.fsproj') || name.endsWith('.vbproj')) return { ...PACKAGE_MANIFEST, ecosystem: 'nuget', parse: parseNugetXml };
  if (name.endsWith('.code-workspace')) return { source: 'config', kind: 'vscode_extension', ecosystem: 'vscode', parse: (t) => parseVscodeRecommendations(t, true) };
  if (name.endsWith('.versions.toml') && (dir === 'gradle' || dir.endsWith('/gradle'))) return { ...PACKAGE_MANIFEST, ecosystem: 'maven', parse: parseGradleCatalog };
  return null;
}

// ---------------------------------------------------------------------------
// Registry links (fixed templates, validated names)
// ---------------------------------------------------------------------------

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const GITHUB_OWNER = /^[A-Za-z0-9-]{1,39}$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const VSCODE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\.[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const GRADLE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const enc = encodeURIComponent;

/** Registry page for a finding, or null when the ecosystem has no public registry or the name is not valid. */
export function registryUrl(ecosystem: DependencyEcosystem, name: string): string | null {
  switch (ecosystem) {
    case 'npm':
      return NPM_NAME.test(name) ? `https://www.npmjs.com/package/${name}` : null; // the pattern admits only URL-safe characters
    case 'pypi':
      return PYPI_NAME.test(name) ? `https://pypi.org/project/${enc(normalizePypiName(name))}/` : null;
    case 'cargo':
      return CRATE_NAME.test(name) ? `https://crates.io/crates/${enc(name)}` : null;
    case 'go': {
      const parts = name.split('/');
      return parts.length >= 2 && parts.length <= 8 && parts.every((p) => SEGMENT.test(p)) && parts[0]!.includes('.') ? `https://pkg.go.dev/${parts.map(enc).join('/')}` : null;
    }
    case 'rubygems':
      return SEGMENT.test(name) ? `https://rubygems.org/gems/${enc(name)}` : null;
    case 'packagist': {
      const parts = name.split('/');
      return parts.length === 2 && parts.every((p) => SEGMENT.test(p)) ? `https://packagist.org/packages/${parts.map(enc).join('/')}` : null;
    }
    case 'nuget':
      return SEGMENT.test(name) ? `https://www.nuget.org/packages/${enc(name)}` : null;
    case 'maven': {
      const parts = name.split(':');
      return parts.length === 2 && parts.every((p) => SEGMENT.test(p)) ? `https://central.sonatype.com/artifact/${parts.map(enc).join('/')}` : null;
    }
    case 'gradle_plugin':
      return GRADLE_PLUGIN_ID.test(name) ? `https://plugins.gradle.org/plugin/${enc(name)}` : null;
    case 'github_actions': {
      const [owner = '', repo = ''] = name.split('/');
      return GITHUB_OWNER.test(owner) && GITHUB_REPO.test(repo) && repo !== '.' && repo !== '..' ? `https://github.com/${enc(owner)}/${enc(repo)}` : null;
    }
    case 'vscode':
      return VSCODE_ID.test(name) ? `https://marketplace.visualstudio.com/items?itemName=${enc(name)}` : null;
    default:
      return null;
  }
}

/** Prefixes of every URL `registryUrl` can produce; clients may use this to re-check links before rendering. */
export const REGISTRY_URL_PREFIXES: readonly string[] = [
  'https://www.npmjs.com/package/',
  'https://pypi.org/project/',
  'https://crates.io/crates/',
  'https://pkg.go.dev/',
  'https://rubygems.org/gems/',
  'https://packagist.org/packages/',
  'https://www.nuget.org/packages/',
  'https://central.sonatype.com/artifact/',
  'https://plugins.gradle.org/plugin/',
  'https://github.com/',
  'https://marketplace.visualstudio.com/items?itemName=',
];

export function dependencyRisk(kind: DependencyKind): DependencyFinding['risk'] {
  return HIGH_RISK_DEPENDENCY_KINDS.includes(kind) ? 'high' : 'normal';
}

// ---------------------------------------------------------------------------
// Diff and detection
// ---------------------------------------------------------------------------

function toFinding(entry: Entry, file: string, source: DependencyFinding['source']): DependencyFinding {
  const name = clean(entry.name, 214) || '(unnamed)';
  return {
    kind: entry.kind,
    ecosystem: entry.ecosystem,
    name,
    version: entry.version ? clean(entry.version, 120) || null : null,
    file: clean(file, 500),
    source,
    detail: entry.detail ? clean(entry.detail, 300) : null,
    uncertain: entry.uncertain ?? false,
    reason: entry.reason ?? null,
    risk: dependencyRisk(entry.kind),
    registryUrl: entry.uncertain ? null : registryUrl(entry.ecosystem, name),
  };
}

function possibleAddition(spec: FileSpec, file: string, reason: string): DependencyFinding {
  return toFinding({ kind: spec.kind, ecosystem: spec.ecosystem, name: `unparsed change in ${basename(file)}`, version: null, key: '', uncertain: true, reason }, file, spec.source);
}

/**
 * Additions in one file: entries of the new content whose identity is not in the base content. Version changes
 * keep the identity (not reported), removals are ignored. Unparsable new content is a possible addition.
 */
export function diffDependencyFile(path: string, base: string | null, next: string | null): DependencyFinding[] {
  const spec = classifyDependencyFile(path);
  if (!spec || next === null) return [];
  if (base !== null && base === next) return [];
  if (next.length > MAX_PARSED_FILE_CHARS) return [possibleAddition(spec, path, `File is larger than ${MAX_PARSED_FILE_CHARS} characters and was not parsed; treated as a possible addition.`)];

  const nextEntries = spec.parse(next);
  if (nextEntries === null) return [possibleAddition(spec, path, 'File could not be parsed; treated as a possible addition.')];
  const baseEntries = base !== null && base.length <= MAX_PARSED_FILE_CHARS ? (spec.parse(base) ?? []) : [];
  const known = new Set(baseEntries.map((e) => e.key));
  const seen = new Set<string>();
  const findings: DependencyFinding[] = [];
  for (const entry of nextEntries) {
    if (known.has(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    findings.push(toFinding(entry, path, spec.source));
  }
  return findings;
}

function identity(f: Pick<DependencyFinding, 'ecosystem' | 'name'>): string {
  return f.ecosystem === 'pypi' ? `pypi:${normalizePypiName(f.name)}` : `${f.ecosystem}:${f.name.toLowerCase()}`;
}

export function sortFindings(findings: readonly DependencyFinding[]): DependencyFinding[] {
  const key = (f: DependencyFinding) => [f.file, f.kind, f.ecosystem, f.name, f.version ?? ''].join(' ');
  return [...findings].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Stable fingerprint of a set of findings; an approval covers exactly this set. */
export function dependencyFingerprint(findings: readonly DependencyFinding[]): string | null {
  if (findings.length === 0) return null;
  const canonical = sortFindings(findings).map((f) => [f.kind, f.ecosystem, f.name, f.version ?? '', f.file, f.uncertain ? '1' : '0']);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 40);
}

/**
 * Detects new dependencies in a change set. `readBase` returns the file content before the change (null when the
 * file did not exist). Deleted files are ignored.
 */
export async function detectDependencyAdditions(changes: readonly ChangedFileLike[], readBase: ReadBaseContent): Promise<DependencyDetection> {
  const manifests: DependencyFinding[] = [];
  const lockfiles: DependencyFinding[] = [];
  const changedManifests = changes.filter((c) => classifyDependencyFile(c.path)?.source === 'manifest').map((c) => c.path.replace(/\\/g, '/').toLowerCase());

  for (const change of changes) {
    if (change.action === 'delete') continue;
    const spec = classifyDependencyFile(change.path);
    if (!spec) continue;
    if (spec.flatWith) {
      const dir = dirname(change.path.replace(/\\/g, '/').toLowerCase());
      const paired = changedManifests.some((m) => spec.flatWith!.includes(basename(m)) && (dir === '' || m === `${dir}/${basename(m)}` || m.startsWith(`${dir}/`)));
      if (paired) continue;
    }
    const base = await readBase(change.path);
    const found = diffDependencyFile(change.path, base, change.content ?? '');
    const labelled = spec.source === 'lockfile' ? found.map((f) => (f.reason ? f : { ...f, reason: 'Added to the lockfile without a matching manifest entry' })) : found;
    (spec.source === 'lockfile' ? lockfiles : manifests).push(...labelled);
  }

  const declared = new Set(manifests.map(identity));
  const findings = sortFindings([...manifests, ...lockfiles.filter((f) => f.uncertain || !declared.has(identity(f)))]);
  return { findings, fingerprint: dependencyFingerprint(findings) };
}

// ---------------------------------------------------------------------------
// Approval payload and decision memory
// ---------------------------------------------------------------------------

export const DependencyFindingSchema = z.object({
  kind: z.enum(DEPENDENCY_KINDS),
  ecosystem: z.enum(DEPENDENCY_ECOSYSTEMS),
  name: z.string().max(300),
  version: z.string().max(200).nullable(),
  file: z.string().max(600),
  source: z.enum(['manifest', 'lockfile', 'config']),
  detail: z.string().max(400).nullable(),
  uncertain: z.boolean(),
  reason: z.string().max(500).nullable(),
  risk: z.enum(['high', 'normal']),
  registryUrl: z.string().max(600).nullable(),
});

export const DependencyApprovalDetailsSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{40}$/),
  findings: z.array(DependencyFindingSchema).max(MAX_APPROVAL_FINDINGS),
  totalFindings: z.number().int().min(0),
  highRisk: z.boolean(),
  paths: z.array(z.string().max(600)).max(MAX_APPROVAL_FINDINGS).default([]),
});
export type DependencyApprovalDetails = z.infer<typeof DependencyApprovalDetailsSchema>;

export function dependencyApprovalDetails(detection: DependencyDetection): DependencyApprovalDetails {
  return {
    fingerprint: detection.fingerprint ?? '',
    findings: detection.findings.slice(0, MAX_APPROVAL_FINDINGS),
    totalFindings: detection.findings.length,
    highRisk: detection.findings.some((f) => f.risk === 'high'),
    paths: [...new Set(detection.findings.map((f) => f.file))].slice(0, MAX_APPROVAL_FINDINGS),
  };
}

/**
 * Reads the dependency details of a stored approval for API clients. Risk and registry links are recomputed from
 * kind, ecosystem and name, so a link is never taken from stored text.
 */
export function readDependencyApprovalDetails(approval: { action: string; details: Record<string, unknown> }): DependencyApprovalDetails | null {
  if (approval.action !== 'dependency_addition') return null;
  const parsed = DependencyApprovalDetailsSchema.safeParse(approval.details);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    findings: parsed.data.findings.map((f) => ({ ...f, risk: dependencyRisk(f.kind), registryUrl: f.uncertain ? null : registryUrl(f.ecosystem, f.name) })),
  };
}

const GRANT_PREFIX = 'dependency_addition:';

/** The entry stored in `approvedActions` once a human approved exactly this set of additions. */
export function dependencyApprovalGrant(fingerprint: string): string {
  return `${GRANT_PREFIX}${fingerprint}`;
}

/** The grant an approved approval adds to a run: the plain action, or the fingerprint-scoped key for dependencies. */
export function approvalGrant(approval: { action: string; details: Record<string, unknown> }): string | null {
  if (approval.action !== 'dependency_addition') return approval.action;
  const fingerprint = approval.details.fingerprint;
  return typeof fingerprint === 'string' && /^[0-9a-f]{40}$/.test(fingerprint) ? dependencyApprovalGrant(fingerprint) : null;
}

export function describeDependencyFindings(findings: readonly DependencyFinding[], max = 5): string {
  const names = findings.slice(0, max).map((f) => `${f.name}${f.version ? `@${f.version}` : ''} (${f.ecosystem})`);
  const more = findings.length > max ? ` and ${findings.length - max} more` : '';
  const noun = findings.length === 1 ? 'dependency' : 'dependencies';
  return `${findings.length} new ${noun} ${findings.length === 1 ? 'needs' : 'need'} human approval: ${names.join(', ')}${more}`;
}
