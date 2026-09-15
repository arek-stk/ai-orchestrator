import { describe, expect, it } from 'vitest';
import {
  errorCheck,
  escapeMarkdown,
  evaluateBranchProtection,
  evaluateCi,
  evaluateCodeScanning,
  evaluateDocs,
  evaluateDependabotPrs,
  evaluatePullRequests,
  evaluateSecretScanning,
  evaluateStaleBranches,
  extractLinks,
  findBrokenLinks,
  findDuplicateAdrNumbers,
  inProgressRows,
  newlyCritical,
  parseBlamePorcelain,
  parseState,
  planIssueUpdate,
  referencedPlanPaths,
  renderReport,
  resolveRelativeLink,
  safeUrl,
  skippedCheck,
  stateOf,
  summarizeChecks,
  trustedPreviousState,
  worstStatus,
} from './lib.mjs';

const NOW = new Date('2026-09-14T12:00:00Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

describe('escapeMarkdown', () => {
  it('neutralises HTML, links, tables, mentions and newlines', () => {
    const out = escapeMarkdown('<img src=x onerror=alert(1)> [click](https://evil.example) | @octocat\n# heading');
    expect(out).not.toMatch(/<|>/);
    expect(out).toContain('&lt;img');
    expect(out).toContain('\\[click\\]\\(https://evil\\.example\\)');
    expect(out).toContain('\\|');
    expect(out).not.toContain('@octocat');
    expect(out).not.toContain('\n');
    expect(out).toContain('\\# heading');
  });

  it('removes control characters and truncates long text', () => {
    expect(escapeMarkdown(`a${String.fromCharCode(0)}b${String.fromCharCode(0x2028)}c`)).toBe('a b c');
    const long = escapeMarkdown('x'.repeat(1000), 50);
    expect(long.length).toBe(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('escapes backticks and HTML comment terminators', () => {
    expect(escapeMarkdown('`code` -->')).toBe('\\`code\\` \\-\\-&gt;');
  });
});

describe('safeUrl', () => {
  it('accepts https and rejects other schemes', () => {
    expect(safeUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('http://example.com')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });

  it('encodes characters that would break out of a markdown link', () => {
    expect(safeUrl('https://github.com/o/r/tree/a)b(c')).toBe('https://github.com/o/r/tree/a%29b%28c');
  });
});

describe('status aggregation', () => {
  it('computes the worst finding level; skipped and error do not raise it', () => {
    expect(worstStatus([])).toBe('ok');
    expect(worstStatus(['skipped', 'error'])).toBe('ok');
    expect(worstStatus(['ok', 'warning', 'skipped'])).toBe('warning');
    expect(worstStatus(['critical', 'warning', 'ok'])).toBe('critical');
  });

  const ok = { id: 'ci', title: 'CI', status: 'ok', summary: 'green', findings: [] };

  it('is healthy with ok and intentionally skipped checks', () => {
    expect(summarizeChecks([ok, skippedCheck('secret-scanning', 'Secrets', 'needs token')])).toMatchObject({ healthy: true, label: 'ok' });
  });

  it('is degraded, never healthy, when a check errored', () => {
    const mixed = summarizeChecks([ok, errorCheck('docs', 'Docs', 'HTTP 502')]);
    expect(mixed).toMatchObject({ healthy: false, label: 'degraded', level: 'ok' });
    expect(mixed.errors.map((c) => c.id)).toEqual(['docs']);
    expect(summarizeChecks([errorCheck('a', 'A', 'x'), errorCheck('b', 'B', 'y')])).toMatchObject({ healthy: false, label: 'degraded' });
    expect(summarizeChecks([{ ...ok, status: 'critical' }, errorCheck('b', 'B', 'y')])).toMatchObject({ healthy: false, label: 'critical' });
  });

  it('keeps "not checked" and "could not run" distinguishable', () => {
    expect(skippedCheck('x', 'X', 'needs token').summary).toBe('not checked (needs token)');
    expect(errorCheck('x', 'X', 'HTTP 403').summary).toBe('could not run (HTTP 403)');
  });
});

describe('change detection', () => {
  const checks = [
    { id: 'ci', title: 'CI', status: 'critical', summary: 'red', findings: [] },
    { id: 'docs', title: 'Docs', status: 'warning', summary: '1 finding', findings: [] },
    skippedCheck('secret-scanning', 'Secrets', 'needs token'),
  ];

  it('round-trips the state through the rendered report', () => {
    const body = renderReport({ checks, generatedAt: NOW, runUrl: 'https://github.com/o/r/actions/runs/1', trigger: 'schedule' });
    expect(parseState(body)).toEqual({ ci: 'critical', docs: 'warning', 'secret-scanning': 'skipped' });
  });

  it('treats malformed or hostile state as empty or filters it', () => {
    expect(parseState(undefined)).toEqual({});
    expect(parseState('<!-- repo-guardian-state: {not json} -->')).toEqual({});
    expect(parseState('<!-- repo-guardian-state: {"checks":{"ci":"exploded","Bad Id":"ok","docs":"ok"}} -->')).toEqual({ docs: 'ok' });
  });

  it('reports only checks that newly became critical', () => {
    expect(newlyCritical({ ci: 'warning', docs: 'critical' }, { ci: 'critical', docs: 'critical', x: 'ok' })).toEqual(['ci']);
    expect(newlyCritical({}, { ci: 'critical' })).toEqual(['ci']);
    expect(newlyCritical({ ci: 'critical' }, { ci: 'critical' })).toEqual([]);
  });

  const check = (id, status) => ({ id, title: id, status, summary: status, findings: [] });

  it('plans create, close, reopen and comments without spam', () => {
    const previous = stateOf(checks);
    expect(planIssueUpdate({ exists: false, open: false, checks: [check('ci', 'ok')], previous: {} })).toMatchObject({ create: false, update: false, comment: false });
    expect(planIssueUpdate({ exists: false, open: false, checks, previous: {} })).toMatchObject({ create: true, comment: true });
    expect(planIssueUpdate({ exists: true, open: true, checks, previous })).toMatchObject({ update: true, close: false, reopen: false, comment: false });
    expect(planIssueUpdate({ exists: true, open: true, checks: [check('ci', 'ok')], previous })).toMatchObject({ close: true, comment: false });
    expect(planIssueUpdate({ exists: true, open: false, checks: [check('ci', 'warning')], previous: { ci: 'ok' } })).toMatchObject({ reopen: true, comment: false });
    expect(planIssueUpdate({ exists: true, open: false, checks: [check('ci', 'critical')], previous: { ci: 'ok' } })).toMatchObject({ reopen: true, comment: true, newlyCritical: ['ci'] });
  });

  it('does not close the issue when all checks errored', () => {
    const all = [errorCheck('ci', 'CI', 'HTTP 502'), errorCheck('docs', 'Docs', 'HTTP 502')];
    expect(planIssueUpdate({ exists: true, open: true, checks: all, previous: { ci: 'critical', docs: 'ok' } })).toMatchObject({ close: false, comment: false });
    expect(planIssueUpdate({ exists: true, open: false, checks: all, previous: {} })).toMatchObject({ reopen: true });
    expect(planIssueUpdate({ exists: false, open: false, checks: all, previous: {} })).toMatchObject({ create: true, comment: false });
  });

  it('does not close the issue when ok checks are mixed with an errored one', () => {
    const mixed = [check('ci', 'ok'), check('docs', 'ok'), errorCheck('code-scanning', 'Code scanning', 'HTTP 403')];
    expect(planIssueUpdate({ exists: true, open: true, checks: mixed, previous: { ci: 'ok' } })).toMatchObject({ close: false, reopen: false, update: true });
  });

  it('keeps a previous critical state through an errored run and does not re-comment on recovery', () => {
    const outage = planIssueUpdate({ exists: true, open: true, checks: [errorCheck('ci', 'CI', 'HTTP 502')], previous: { ci: 'critical' } });
    expect(outage.state).toEqual({ ci: 'critical' });
    expect(outage.comment).toBe(false);
    const recovered = planIssueUpdate({ exists: true, open: true, checks: [check('ci', 'critical')], previous: outage.state });
    expect(recovered.comment).toBe(false);
    // With no earlier state the errored check is recorded as error, and a later critical result is announced.
    const fresh = planIssueUpdate({ exists: true, open: true, checks: [errorCheck('ci', 'CI', 'x')], previous: {} });
    expect(fresh.state).toEqual({ ci: 'error' });
    expect(planIssueUpdate({ exists: true, open: true, checks: [check('ci', 'critical')], previous: fresh.state }).comment).toBe(true);
  });

  it('writes the carried-forward state into the rendered report and shows a degraded banner', () => {
    const body = renderReport({ checks: [check('ci', 'ok'), errorCheck('docs', 'Docs consistency', 'HTTP 502')], generatedAt: NOW, previous: { docs: 'critical' } });
    expect(parseState(body)).toEqual({ ci: 'ok', docs: 'critical' });
    expect(body).toContain('**Overall: ❗ degraded**');
    expect(body).toContain('Degraded — 1 check could not run:** Docs consistency');
    expect(body).toContain('| Docs consistency | ❗ could not run | could not run \\(HTTP 502\\) |');
  });

  it('ignores the recorded state when a human edited the issue body last', () => {
    const body = renderReport({ checks, generatedAt: NOW });
    expect(trustedPreviousState(body, null)).toEqual(parseState(body));
    expect(trustedPreviousState(body, 'github-actions')).toEqual(parseState(body));
    expect(trustedPreviousState(body, 'mallory')).toEqual({});
  });
});

describe('renderReport', () => {
  it('renders a summary table and escapes untrusted finding text', () => {
    const body = renderReport({
      checks: [
        {
          id: 'pull-requests',
          title: 'Open pull requests',
          status: 'warning',
          summary: '1 open',
          findings: [{ status: 'warning', text: '#7 (ready) <script>x</script> | @admin', url: 'javascript:alert(1)' }],
        },
      ],
      generatedAt: NOW,
      runUrl: 'https://github.com/o/r/actions/runs/1',
    });
    expect(body).toContain('| Open pull requests | ⚠️ warning | 1 open |');
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('@admin');
    expect(body).toContain('**Overall: ⚠️ warning**');
  });
});

describe('evaluators', () => {
  it('CI: failing required check is critical, other failing workflows warn, scheduled failures are grouped', () => {
    const result = evaluateCi({
      defaultBranch: 'main',
      requiredCheck: { status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/runs/1' },
      workflows: [
        { name: 'CodeQL', path: '.github/workflows/codeql.yml', latestRun: { status: 'completed', conclusion: 'failure', url: 'https://github.com/x', event: 'push', createdAt: daysAgo(1) } },
        { name: 'Stale', path: '.github/workflows/stale.yml', latestRun: { status: 'completed', conclusion: 'cancelled', url: 'https://github.com/x', event: 'schedule', createdAt: daysAgo(1) } },
      ],
      scheduledFailures: [
        { workflowName: 'Scorecard', url: 'https://github.com/a', createdAt: daysAgo(1) },
        { workflowName: 'Scorecard', url: 'https://github.com/b', createdAt: daysAgo(2) },
      ],
    });
    expect(result.status).toBe('critical');
    expect(result.findings.filter((f) => f.status === 'warning').map((f) => f.text)).toEqual([
      'Latest CodeQL run on main (push) is failure',
      'Scheduled workflow Scorecard failed 2× in the last 7 days',
    ]);
  });

  it('CI: green required check is ok', () => {
    const result = evaluateCi({ defaultBranch: 'main', requiredCheck: { status: 'completed', conclusion: 'success' }, workflows: [], scheduledFailures: [] });
    expect(result.status).toBe('ok');
  });

  it('code scanning: CodeQL high is critical, Scorecard stays a grouped warning', () => {
    const alerts = [
      { number: 1, tool: 'CodeQL', rule: 'Polynomial regex', securitySeverity: 'high', severity: 'warning', url: 'https://github.com/1' },
      { number: 2, tool: 'Scorecard', rule: 'Pinned-Dependencies', securitySeverity: 'medium', severity: 'error', url: 'https://github.com/2' },
      { number: 3, tool: 'Scorecard', rule: 'Pinned-Dependencies', securitySeverity: 'medium', severity: 'error', url: 'https://github.com/3' },
    ];
    const result = evaluateCodeScanning(alerts, 'https://github.com/o/r/security/code-scanning');
    expect(result.status).toBe('critical');
    expect(result.findings).toHaveLength(2);
    expect(result.summary).toBe('3 open: 1 high, 2 medium');
    expect(evaluateCodeScanning(alerts.slice(1), 'https://github.com/x').status).toBe('warning');
    expect(evaluateCodeScanning([], 'https://github.com/x').status).toBe('ok');
  });

  it('secret scanning: any open alert is critical and only type and number are shown', () => {
    const result = evaluateSecretScanning([{ number: 4, secretType: 'GitHub Personal Access Token', url: 'https://github.com/4' }]);
    expect(result.status).toBe('critical');
    expect(result.findings[0].text).toBe('#4 exposed GitHub Personal Access Token');
  });

  const pr = (overrides) => ({
    number: 1, title: 'feat: x', url: 'https://github.com/o/r/pull/1', author: 'alice', headRef: 'feat/x', isDraft: false,
    createdAt: daysAgo(1), updatedAt: daysAgo(1), mergeable: 'MERGEABLE', checks: 'SUCCESS', unresolvedThreads: 0, ...overrides,
  });

  it('pull requests: flags failing, conflicting, unresolved and idle PRs and skips healthy automation PRs', () => {
    const result = evaluatePullRequests([
      pr({ number: 1 }),
      pr({ number: 2, checks: 'FAILURE', mergeable: 'CONFLICTING' }),
      pr({ number: 3, unresolvedThreads: 2 }),
      pr({ number: 4, isDraft: true, unresolvedThreads: 2, updatedAt: daysAgo(10) }),
      pr({ number: 5, author: 'dependabot', headRef: 'dependabot/npm/x' }),
      pr({ number: 6, author: 'github-actions', headRef: 'release-please--branches--main', checks: 'FAILURE' }),
    ], NOW);
    const byNumber = Object.fromEntries(result.findings.map((f) => [f.text.split(' ')[0], f]));
    expect(byNumber['#1'].status).toBe('ok');
    expect(byNumber['#2'].text).toContain('failing checks, merge conflicts');
    expect(byNumber['#3'].text).toContain('2 unresolved review threads');
    expect(byNumber['#4'].text).toContain('(draft)');
    expect(byNumber['#4'].text).toContain('no activity for 10 days');
    expect(byNumber['#5']).toBeUndefined();
    expect(byNumber['#6'].status).toBe('warning');
    expect(result.summary).toBe('6 open (1 automation PRs skipped), 4 need attention');
  });

  it('dependabot PRs older than 7 days warn', () => {
    const result = evaluateDependabotPrs([pr({ author: 'dependabot', headRef: 'dependabot/npm/a', createdAt: daysAgo(9) }), pr({ author: 'alice', createdAt: daysAgo(30) })], NOW);
    expect(result.status).toBe('warning');
    expect(result.findings).toHaveLength(1);
  });

  it('branch protection must require the CI check', () => {
    expect(evaluateBranchProtection({ branch: 'main', protected: true, requiredContexts: ['Typecheck and test'], source: 'x', details: null }).status).toBe('ok');
    expect(evaluateBranchProtection({ branch: 'main', protected: true, requiredContexts: ['Other'], source: 'x', details: null }).status).toBe('critical');
    expect(evaluateBranchProtection({ branch: 'main', protected: false, requiredContexts: [], source: 'x', details: null }).status).toBe('critical');
    expect(evaluateBranchProtection({ branch: 'main', protected: true, requiredContexts: ['Typecheck and test'], source: 'x', details: { allowForcePushes: true, conversationResolution: true } }).status).toBe('warning');
  });

  it('stale branches exclude main, release-please and branches with open PRs', () => {
    const branches = [
      { name: 'main', committedAt: daysAgo(100), url: 'https://github.com/m' },
      { name: 'release-please--branches--main', committedAt: daysAgo(100), url: 'https://github.com/r' },
      { name: 'feat/open', committedAt: daysAgo(100), url: 'https://github.com/o' },
      { name: 'feat/old', committedAt: daysAgo(45), url: 'https://github.com/old' },
      { name: 'feat/new', committedAt: daysAgo(3), url: 'https://github.com/new' },
    ];
    const result = evaluateStaleBranches(branches, new Set(['feat/open']), 'main', NOW);
    expect(result.findings.map((f) => f.text)).toEqual(['feat/old: last commit 45 days ago, no open PR']);
  });
});

describe('docs link checker', () => {
  it('extracts inline, image, angle-bracket and reference links but ignores code', () => {
    const md = [
      'See [arch](docs/ARCHITECTURE.md#layers) and ![img](./a.png "title").',
      'Wrapped [x](<docs/with space.md>) and [wiki](https://example.com/a_(b)).',
      '`[not](a-link.md)` and',
      '```',
      '[also not](inside-fence.md)',
      '```',
      '[ref]: ../CONTRIBUTING.md',
    ].join('\n');
    expect(extractLinks(md).map((l) => [l.target, l.line])).toEqual([
      ['docs/ARCHITECTURE.md#layers', 1],
      ['./a.png', 1],
      ['docs/with space.md', 2],
      ['https://example.com/a_(b)', 2],
      ['../CONTRIBUTING.md', 7],
    ]);
  });

  it('does not treat bracketed citations inside a paragraph as reference definitions', () => {
    const md = '- **Terms** (see source)\n  [O2]: "You may not share your account"\n\n[O3]: "quoted title only"\n\n[docs]: docs/STATE.md';
    expect(extractLinks(md).map((l) => l.target)).toEqual(['docs/STATE.md']);
  });

  it('resolves relative, root-relative and escaping paths', () => {
    expect(resolveRelativeLink('docs/plans/a.md', '../STATE.md')).toEqual({ path: 'docs/STATE.md', outside: false });
    expect(resolveRelativeLink('docs/STATE.md', '/README.md#top')).toEqual({ path: 'README.md', outside: false });
    expect(resolveRelativeLink('README.md', 'docs/with%20space.md')).toEqual({ path: 'docs/with space.md', outside: false });
    expect(resolveRelativeLink('README.md', '../../etc/passwd')).toMatchObject({ outside: true });
    expect(resolveRelativeLink('README.md', '#anchor')).toBeNull();
    expect(resolveRelativeLink('README.md', 'mailto:a@b.c')).toBeNull();
    expect(resolveRelativeLink('README.md', 'https://github.com')).toBeNull();
  });

  it('reports links to missing files', () => {
    const existing = new Set(['docs/STATE.md', 'README.md']);
    const broken = findBrokenLinks(
      [{ path: 'docs/plans/p.md', content: 'ok [s](../STATE.md) [r](../../README.md)\nbad [m](../missing.md) [out](../../../x.md)' }],
      (p) => existing.has(p),
    );
    expect(broken).toEqual([
      { file: 'docs/plans/p.md', line: 2, target: '../missing.md' },
      { file: 'docs/plans/p.md', line: 2, target: '../../../x.md' },
    ]);
  });

  it('stays linear on hostile input', () => {
    const hostile = `${'[a]('.repeat(20000)}${'('.repeat(20000)}`;
    const started = Date.now();
    extractLinks(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('finds duplicate ADR numbers and referenced plan paths', () => {
    expect(findDuplicateAdrNumbers('## ADR-001 — a\n## ADR-002 — b\n```\n## ADR-002 — in code\n```\n### ADR-2 — dup')).toEqual([{ number: '2', lines: [2, 6] }]);
    expect(referencedPlanPaths('see `docs/plans/project-room.md`, docs/research/models.md. and docs/plans/dir/')).toEqual(['docs/plans/project-room.md', 'docs/research/models.md']);
  });

  it('parses in-progress rows and blame times', () => {
    const state = '| # | Module | Status |\n|---|---|---|\n| 11 | Web dashboard: pages | 🚧 in progress | PR #11 |\n| 12 | Done | ✅ done | — |';
    expect(inProgressRows(state)).toEqual([{ line: 3, module: 'Web dashboard', prs: [11] }]);
    const sha = 'a'.repeat(40);
    const porcelain = `${sha} 1 1 2\nauthor x\ncommitter-time 1000\n\tline one\n${sha} 2 2\ncommitter-time 2000\n\tline two\n`;
    expect([...parseBlamePorcelain(porcelain)]).toEqual([[1, 1_000_000], [2, 2_000_000]]);
  });

  it('evaluateDocs flags old in-progress rows, merged PRs, missing plans and broken links', () => {
    const stateMd = [
      '| # | Module | Status |',
      '|---|---|---|',
      '| 11 | Web | 🚧 in progress |',
      '| 13 | Cache | 🚧 in progress | PR #20 |',
      '| 14 | Fresh | 🚧 in progress |',
      'Plan: docs/plans/missing.md',
    ].join('\n');
    const result = evaluateDocs({
      stateMd,
      decisionsMd: '## ADR-001 — a\n## ADR-001 — b',
      blameTimes: new Map([[3, Date.parse(daysAgo(20))], [4, Date.parse(daysAgo(1))], [5, Date.parse(daysAgo(2))]]),
      mergedPrs: new Set([20]),
      linkedFiles: [{ path: 'README.md', content: '[gone](docs/gone.md)' }],
      exists: () => false,
      now: NOW,
      blobUrl: (path, line) => `https://github.com/o/r/blob/main/${path}${line ? `#L${line}` : ''}`,
    });
    expect(result.status).toBe('warning');
    expect(result.findings.map((f) => f.text)).toEqual([
      'STATE.md line 3: "Web" marked in progress for 20 days',
      'STATE.md line 4: "Cache" is in progress but PR #20 is merged',
      'STATE.md references missing docs/plans/missing.md',
      'ADR-001 heading appears 2× (lines 1, 2)',
      'README.md:1 broken link to docs/gone.md',
    ]);
    expect(evaluateDocs({ stateMd: null, decisionsMd: null, blameTimes: null, mergedPrs: new Set(), linkedFiles: [], exists: () => true, now: NOW, blobUrl: () => '' }).status).toBe('critical');
  });
});
