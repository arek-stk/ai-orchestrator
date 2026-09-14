// @ts-check
// Pure evaluation and rendering for the Repo Guardian (ADR-012). No network, filesystem or process access here, so
// every rule is unit-testable (`lib.test.mjs`). Everything that comes from the GitHub API or repository content
// (PR titles, branch names, alert texts, file paths) is untrusted and only reaches the report through `escapeMarkdown`
// and `safeUrl`.

/** @typedef {'ok' | 'warning' | 'critical' | 'skipped'} Status */
/** @typedef {{ status: Status, text: string, url?: string | null }} Finding */
/** @typedef {{ id: string, title: string, status: Status, summary: string, findings: Finding[] }} CheckResult */

export const ISSUE_TITLE = 'Repo Guardian report';
export const ISSUE_LABEL = 'repo-guardian';
export const REQUIRED_CHECK = 'Typecheck and test';
const STATE_MARKER = 'repo-guardian-state:';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 300;
const MAX_FINDINGS_PER_CHECK = 25;

/** @type {Record<Status, number>} */
const RANK = { skipped: 0, ok: 1, warning: 2, critical: 3 };
/** @type {Record<Status, string>} */
const ICON = { ok: '✅ ok', warning: '⚠️ warning', critical: '🔴 critical', skipped: '⏭️ not checked' };

// ---------------------------------------------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------------------------------------------

const MARKDOWN_SPECIAL = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|', '~', '$']);
// Built from code points so the source contains no invisible characters.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Makes untrusted text inert in GitHub markdown: no HTML, no links/images, no table breaks, no @mentions, one line.
 * @param {unknown} value
 * @param {number} [maxLength]
 */
export function escapeMarkdown(value, maxLength = MAX_TEXT) {
  let text = String(value ?? '');
  text = [...text].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === LINE_SEPARATOR || ch === PARAGRAPH_SEPARATOR ? ' ' : ch)).join('');
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  let out = '';
  for (const ch of text) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '@') out += `@${ZERO_WIDTH_SPACE}`;
    else if (MARKDOWN_SPECIAL.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Only https URLs survive; characters that could end a markdown link destination are percent-encoded.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url.href.replace(/[()<>\s"'`\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Status aggregation and change detection
// ---------------------------------------------------------------------------------------------------------------

/**
 * Worst status wins; `skipped` never raises the level. An empty list is ok.
 * @param {Status[]} statuses
 * @returns {Exclude<Status, 'skipped'>}
 */
export function worstStatus(statuses) {
  let worst = /** @type {Exclude<Status, 'skipped'>} */ ('ok');
  for (const status of statuses) {
    if (status === 'warning' && worst === 'ok') worst = 'warning';
    if (status === 'critical') worst = 'critical';
  }
  return worst;
}

/**
 * @param {string} id
 * @param {string} title
 * @param {Finding[]} findings
 * @param {{ okSummary: string, summary?: string }} texts
 * @returns {CheckResult}
 */
export function makeCheck(id, title, findings, texts) {
  const status = worstStatus(findings.map((f) => f.status));
  const problems = findings.filter((f) => f.status === 'warning' || f.status === 'critical').length;
  const summary = texts.summary ?? (problems === 0 ? texts.okSummary : `${problems} finding${problems === 1 ? '' : 's'}`);
  return { id, title, status, summary, findings };
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} reason
 * @returns {CheckResult}
 */
export function skippedCheck(id, title, reason) {
  return { id, title, status: 'skipped', summary: `not checked (${reason})`, findings: [] };
}

/**
 * @param {CheckResult[]} checks
 * @returns {Record<string, Status>}
 */
export function stateOf(checks) {
  /** @type {Record<string, Status>} */
  const state = {};
  for (const check of checks) state[check.id] = check.status;
  return state;
}

/**
 * Reads the machine state from a previous report body. Anything malformed counts as "no previous state".
 * @param {string | null | undefined} body
 * @returns {Record<string, Status>}
 */
export function parseState(body) {
  if (typeof body !== 'string') return {};
  const start = body.indexOf(`<!-- ${STATE_MARKER}`);
  if (start < 0) return {};
  const end = body.indexOf('-->', start);
  if (end < 0) return {};
  const json = body.slice(start + STATE_MARKER.length + 5, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  /** @type {Record<string, Status>} */
  const state = {};
  const checks = parsed && typeof parsed === 'object' ? parsed.checks : null;
  if (!checks || typeof checks !== 'object') return state;
  for (const [id, status] of Object.entries(checks)) {
    if (/^[a-z][a-z0-9-]{0,40}$/.test(id) && typeof status === 'string' && status in RANK) {
      state[id] = /** @type {Status} */ (status);
    }
  }
  return state;
}

/**
 * Ids of checks that are critical now but were not critical in the previous report.
 * @param {Record<string, Status>} previous
 * @param {Record<string, Status>} current
 */
export function newlyCritical(previous, current) {
  return Object.keys(current).filter((id) => current[id] === 'critical' && previous[id] !== 'critical');
}

/**
 * Decides what to do with the single report issue.
 * @param {{ exists: boolean, open: boolean, overall: Exclude<Status, 'skipped'>, previous: Record<string, Status>, current: Record<string, Status> }} input
 */
export function planIssueUpdate({ exists, open, overall, previous, current }) {
  const healthy = overall === 'ok';
  const critical = newlyCritical(previous, current);
  return {
    create: !exists && !healthy,
    update: exists,
    close: exists && open && healthy,
    reopen: exists && !open && !healthy,
    comment: !healthy && critical.length > 0,
    newlyCritical: critical,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {Finding} finding
 */
function renderFinding(finding) {
  const url = safeUrl(finding.url);
  const icon = finding.status === 'ok' ? '✅' : finding.status === 'warning' ? '⚠️' : finding.status === 'critical' ? '🔴' : '⏭️';
  return `- ${icon} ${escapeMarkdown(finding.text)}${url ? ` ([link](${url}))` : ''}`;
}

/**
 * @param {{ checks: CheckResult[], generatedAt: Date, runUrl?: string | null, trigger?: string, ref?: string }} input
 */
export function renderReport({ checks, generatedAt, runUrl, trigger, ref }) {
  const overall = worstStatus(checks.map((c) => c.status));
  const lines = [];
  lines.push('<!-- repo-guardian -->');
  lines.push(`## ${ISSUE_TITLE}`);
  lines.push('');
  const meta = [`**Overall: ${ICON[overall]}**`, `updated ${generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`];
  const run = safeUrl(runUrl);
  if (run) meta.push(`[workflow run](${run})`);
  if (trigger) meta.push(`trigger ${escapeMarkdown(trigger, 40)}`);
  if (ref) meta.push(`docs checked at ${escapeMarkdown(ref, 60)}`);
  lines.push(meta.join(' · '));
  lines.push('');
  lines.push('| Check | Status | Summary |');
  lines.push('|---|---|---|');
  for (const check of checks) {
    lines.push(`| ${escapeMarkdown(check.title, 80)} | ${ICON[check.status]} | ${escapeMarkdown(check.summary, 200)} |`);
  }
  for (const check of checks) {
    const visible = check.findings.filter((f) => f.status !== 'ok' || check.status === 'ok');
    if (visible.length === 0) continue;
    lines.push('');
    lines.push(`### ${ICON[check.status]} — ${escapeMarkdown(check.title, 80)}`);
    lines.push('');
    const sorted = [...visible].sort((a, b) => RANK[b.status] - RANK[a.status]);
    for (const finding of sorted.slice(0, MAX_FINDINGS_PER_CHECK)) lines.push(renderFinding(finding));
    if (sorted.length > MAX_FINDINGS_PER_CHECK) lines.push(`- … and ${sorted.length - MAX_FINDINGS_PER_CHECK} more`);
  }
  lines.push('');
  lines.push('<sub>Maintained by the Repo Guardian workflow (`.github/workflows/repo-guardian.yml`). This issue is updated in place, closed when everything is ok and reopened when not.</sub>');
  lines.push('');
  lines.push(`<!-- ${STATE_MARKER} ${JSON.stringify({ v: 1, checks: stateOf(checks) })} -->`);
  return lines.join('\n');
}

/**
 * Comment body for checks that just became critical; ids map back to titles from the current report.
 * @param {CheckResult[]} checks
 * @param {string[]} ids
 * @param {string | null | undefined} runUrl
 */
export function renderCriticalComment(checks, ids, runUrl) {
  const lines = ['🔴 **Repo Guardian:** newly critical'];
  lines.push('');
  for (const id of ids) {
    const check = checks.find((c) => c.id === id);
    if (check) lines.push(`- **${escapeMarkdown(check.title, 80)}**: ${escapeMarkdown(check.summary, 200)}`);
  }
  const run = safeUrl(runUrl);
  if (run) {
    lines.push('');
    lines.push(`[workflow run](${run})`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluators (inputs are already-fetched, minimal API data)
// ---------------------------------------------------------------------------------------------------------------

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/**
 * @param {string | null | undefined} iso
 * @param {Date} now
 */
export function ageInDays(iso, now) {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return 0;
  return Math.floor((now.getTime() - time) / DAY_MS);
}

/**
 * a. CI on the default branch.
 * @param {{
 *   defaultBranch: string,
 *   requiredCheck: { status: string, conclusion: string | null, url?: string | null } | null,
 *   workflows: { name: string, path: string, latestRun: { conclusion: string | null, status: string, url: string, event: string, createdAt: string } | null }[],
 *   scheduledFailures: { workflowName: string, url: string, createdAt: string }[],
 *   ciWorkflowPath?: string,
 * }} input
 * @returns {CheckResult}
 */
export function evaluateCi({ defaultBranch, requiredCheck, workflows, scheduledFailures, ciWorkflowPath = '.github/workflows/ci.yml' }) {
  /** @type {Finding[]} */
  const findings = [];
  if (!requiredCheck) {
    findings.push({ status: 'warning', text: `No "${REQUIRED_CHECK}" check run on the latest ${defaultBranch} commit` });
  } else if (requiredCheck.status !== 'completed') {
    findings.push({ status: 'ok', text: `"${REQUIRED_CHECK}" is ${requiredCheck.status} on ${defaultBranch}`, url: requiredCheck.url });
  } else if (requiredCheck.conclusion && FAILED_CONCLUSIONS.has(requiredCheck.conclusion)) {
    findings.push({ status: 'critical', text: `Required check "${REQUIRED_CHECK}" is ${requiredCheck.conclusion} on ${defaultBranch}`, url: requiredCheck.url });
  } else {
    findings.push({ status: 'ok', text: `"${REQUIRED_CHECK}" ${requiredCheck.conclusion ?? 'completed'} on ${defaultBranch}`, url: requiredCheck.url });
  }
  for (const workflow of workflows) {
    const run = workflow.latestRun;
    if (!run || run.status !== 'completed' || !run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) continue;
    const critical = workflow.path === ciWorkflowPath;
    findings.push({
      status: critical ? 'critical' : 'warning',
      text: `Latest ${workflow.name} run on ${defaultBranch} (${run.event}) is ${run.conclusion}`,
      url: run.url,
    });
  }
  /** @type {Map<string, { count: number, url: string }>} */
  const byWorkflow = new Map();
  for (const failure of scheduledFailures) {
    const entry = byWorkflow.get(failure.workflowName);
    if (entry) entry.count += 1;
    else byWorkflow.set(failure.workflowName, { count: 1, url: failure.url });
  }
  for (const [name, { count, url }] of byWorkflow) {
    findings.push({ status: 'warning', text: `Scheduled workflow ${name} failed ${count}× in the last 7 days`, url });
  }
  return makeCheck('ci', 'CI on default branch', findings, { okSummary: `green on ${defaultBranch}` });
}

/**
 * b. Code scanning. CodeQL (and other analysers) high/critical → critical; Scorecard findings are posture
 * recommendations and never exceed warning.
 * @param {{ number: number, tool: string, rule: string, securitySeverity: string | null, severity: string | null, url: string }[]} alerts
 * @param {string} listUrl
 * @returns {CheckResult}
 */
export function evaluateCodeScanning(alerts, listUrl) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Map<string, { count: number, severity: string }>} */
  const scorecard = new Map();
  /** @type {Record<string, number>} */
  const counts = {};
  for (const alert of alerts) {
    const level = alert.securitySeverity ?? alert.severity ?? 'unknown';
    counts[level] = (counts[level] ?? 0) + 1;
    if (alert.tool === 'Scorecard') {
      const key = `${alert.rule} (${level})`;
      const entry = scorecard.get(key);
      if (entry) entry.count += 1;
      else scorecard.set(key, { count: 1, severity: level });
      continue;
    }
    const critical = level === 'critical' || level === 'high' || level === 'error';
    findings.push({ status: critical ? 'critical' : 'warning', text: `#${alert.number} ${alert.tool} ${level}: ${alert.rule}`, url: alert.url });
  }
  for (const [key, { count }] of scorecard) {
    findings.push({ status: 'warning', text: `Scorecard ${key}: ${count} open`, url: listUrl });
  }
  const order = ['critical', 'high', 'medium', 'low', 'error', 'warning', 'note', 'unknown'];
  const summary = alerts.length === 0
    ? 'no open alerts'
    : `${alerts.length} open: ${Object.entries(counts).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  return makeCheck('code-scanning', 'Code scanning alerts', findings, { okSummary: summary, summary });
}

/**
 * c1. Dependabot alerts.
 * @param {{ number: number, severity: string, package: string, summary: string, url: string }[]} alerts
 * @returns {CheckResult}
 */
export function evaluateDependabotAlerts(alerts) {
  const findings = alerts.map((alert) => ({
    status: /** @type {Status} */ (alert.severity === 'critical' || alert.severity === 'high' ? 'critical' : 'warning'),
    text: `#${alert.number} ${alert.severity} in ${alert.package}: ${alert.summary}`,
    url: alert.url,
  }));
  return makeCheck('dependabot-alerts', 'Dependabot alerts', findings, { okSummary: 'no open alerts' });
}

/**
 * c2. Secret scanning alerts. The secret value is never part of the input.
 * @param {{ number: number, secretType: string, url: string }[]} alerts
 * @returns {CheckResult}
 */
export function evaluateSecretScanning(alerts) {
  const findings = alerts.map((alert) => ({
    status: /** @type {Status} */ ('critical'),
    text: `#${alert.number} exposed ${alert.secretType}`,
    url: alert.url,
  }));
  return makeCheck('secret-scanning', 'Secret scanning alerts', findings, { okSummary: 'no open alerts' });
}

/**
 * @param {{ author: string, headRef: string }} pr
 */
export function isAutomationPr(pr) {
  const author = pr.author.toLowerCase();
  return (
    author === 'dependabot' || author === 'dependabot[bot]' || author === 'app/dependabot' ||
    pr.headRef.startsWith('dependabot/') || pr.headRef.startsWith('release-please--')
  );
}

/**
 * @param {{ author: string, headRef: string }} pr
 */
export function isDependabotPr(pr) {
  const author = pr.author.toLowerCase();
  return author === 'dependabot' || author === 'dependabot[bot]' || author === 'app/dependabot' || pr.headRef.startsWith('dependabot/');
}

/**
 * @typedef {{ number: number, title: string, url: string, author: string, headRef: string, isDraft: boolean,
 *   createdAt: string, updatedAt: string, mergeable: string, checks: string | null, unresolvedThreads: number }} PullRequestInfo
 */

/**
 * d. Open pull requests.
 * @param {PullRequestInfo[]} prs
 * @param {Date} now
 * @returns {CheckResult}
 */
export function evaluatePullRequests(prs, now) {
  /** @type {Finding[]} */
  const findings = [];
  let skipped = 0;
  for (const pr of prs) {
    const failing = pr.checks === 'FAILURE' || pr.checks === 'ERROR';
    if (isAutomationPr(pr) && !failing) {
      skipped += 1;
      continue;
    }
    const problems = [];
    if (failing) problems.push('failing checks');
    if (pr.mergeable === 'CONFLICTING') problems.push('merge conflicts');
    if (pr.unresolvedThreads > 0 && !pr.isDraft) problems.push(`${pr.unresolvedThreads} unresolved review thread${pr.unresolvedThreads === 1 ? '' : 's'}`);
    const idle = ageInDays(pr.updatedAt, now);
    if (idle > 7) problems.push(`no activity for ${idle} days`);
    const kind = pr.isDraft ? 'draft' : 'ready';
    const notes = [];
    if (pr.isDraft && pr.unresolvedThreads > 0) notes.push(`${pr.unresolvedThreads} unresolved threads`);
    if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') notes.push('checks running');
    const detail = [...problems, ...notes].join(', ') || 'clean';
    findings.push({
      status: problems.length > 0 ? 'warning' : 'ok',
      text: `#${pr.number} (${kind}) ${pr.title} — ${detail}`,
      url: pr.url,
    });
  }
  const problems = findings.filter((f) => f.status !== 'ok').length;
  const summary = `${prs.length} open${skipped ? ` (${skipped} automation PRs skipped)` : ''}${problems ? `, ${problems} need attention` : ''}`;
  return makeCheck('pull-requests', 'Open pull requests', findings, { okSummary: summary, summary });
}

/**
 * e. Branch protection. `requiredContexts` merges classic protection and ruleset status checks.
 * @param {{ branch: string, protected: boolean, requiredContexts: string[], source: string,
 *   details: { allowForcePushes: boolean, conversationResolution: boolean } | null }} input
 * @returns {CheckResult}
 */
export function evaluateBranchProtection({ branch, protected: isProtected, requiredContexts, source, details }) {
  /** @type {Finding[]} */
  const findings = [];
  if (!isProtected && requiredContexts.length === 0) {
    findings.push({ status: 'critical', text: `${branch} is not protected` });
  } else if (!requiredContexts.includes(REQUIRED_CHECK)) {
    findings.push({ status: 'critical', text: `${branch} does not require "${REQUIRED_CHECK}" (required: ${requiredContexts.join(', ') || 'none'})` });
  } else {
    findings.push({ status: 'ok', text: `${branch} requires "${REQUIRED_CHECK}" (${source})` });
  }
  if (details) {
    if (details.allowForcePushes) findings.push({ status: 'warning', text: `Force pushes to ${branch} are allowed` });
    if (!details.conversationResolution) findings.push({ status: 'warning', text: `Conversation resolution is not required on ${branch}` });
  }
  return makeCheck('branch-protection', 'Branch protection', findings, { okSummary: `requires "${REQUIRED_CHECK}"` });
}

/**
 * g. Stale branches: no open PR, last commit older than 30 days, not the default or a release-please branch.
 * @param {{ name: string, committedAt: string, url: string }[]} branches
 * @param {Set<string>} openPrHeads
 * @param {string} defaultBranch
 * @param {Date} now
 * @returns {CheckResult}
 */
export function evaluateStaleBranches(branches, openPrHeads, defaultBranch, now) {
  /** @type {Finding[]} */
  const findings = [];
  for (const branch of branches) {
    if (branch.name === defaultBranch || branch.name === 'main' || branch.name.startsWith('release-please--')) continue;
    if (openPrHeads.has(branch.name)) continue;
    const age = ageInDays(branch.committedAt, now);
    if (age > 30) findings.push({ status: 'warning', text: `${branch.name}: last commit ${age} days ago, no open PR`, url: branch.url });
  }
  return makeCheck('stale-branches', 'Stale branches', findings, { okSummary: `${branches.length} branches, none stale` });
}

/**
 * h. Dependabot PRs waiting for more than 7 days.
 * @param {PullRequestInfo[]} prs
 * @param {Date} now
 * @returns {CheckResult}
 */
export function evaluateDependabotPrs(prs, now) {
  const dependabot = prs.filter(isDependabotPr);
  /** @type {Finding[]} */
  const findings = [];
  for (const pr of dependabot) {
    const age = ageInDays(pr.createdAt, now);
    if (age > 7) findings.push({ status: 'warning', text: `#${pr.number} ${pr.title} — open for ${age} days`, url: pr.url });
  }
  return makeCheck('dependabot-prs', 'Dependabot pull requests', findings, { okSummary: `${dependabot.length} open, none older than 7 days` });
}

// ---------------------------------------------------------------------------------------------------------------
// Docs consistency (f) — parsers work on file content; the caller supplies file existence and blame data
// ---------------------------------------------------------------------------------------------------------------

/**
 * Splits markdown into lines and blanks out fenced code blocks and inline code spans, keeping line numbers.
 * @param {string} markdown
 * @returns {string[]}
 */
export function proseLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = '';
  return lines.map((line) => {
    const trimmed = line.trimStart();
    const marker = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : '';
    if (fence) {
      if (marker === fence) fence = '';
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    let out = '';
    let inCode = false;
    for (const ch of line) {
      if (ch === '`') inCode = !inCode;
      else if (!inCode) out += ch;
    }
    return out;
  });
}

/**
 * Link destinations of inline links/images (`[x](dest)`) and reference definitions (`[x]: dest`), scanned linearly.
 * @param {string} markdown
 * @returns {{ target: string, line: number }[]}
 */
export function extractLinks(markdown) {
  /** @type {{ target: string, line: number }[]} */
  const links = [];
  proseLines(markdown).forEach((line, index, all) => {
    let from = 0;
    for (;;) {
      const open = line.indexOf('](', from);
      if (open < 0) break;
      let i = open + 2;
      let target = '';
      if (line[i] === '<') {
        const close = line.indexOf('>', i + 1);
        if (close < 0) {
          from = i;
          continue;
        }
        target = line.slice(i + 1, close);
        i = close + 1;
      } else {
        let depth = 0;
        while (i < line.length && target.length < 2048) {
          const ch = line[i];
          if (ch === ' ' || ch === '\t') break;
          if (ch === '(') depth += 1;
          if (ch === ')') {
            if (depth === 0) break;
            depth -= 1;
          }
          target += ch;
          i += 1;
        }
      }
      if (target) links.push({ target, line: index + 1 });
      from = i;
    }
    // A reference definition cannot interrupt a paragraph, so `[O2]: "quote"` inside running text is not a link.
    const trimmed = line.trimStart();
    const startsBlock = index === 0 || all[index - 1].trim() === '';
    if (startsBlock && trimmed.startsWith('[') && line.length - trimmed.length <= 3) {
      const close = trimmed.indexOf(']:');
      if (close > 1) {
        const target = trimmed.slice(close + 2).trim().split(/\s/)[0] ?? '';
        if (target && !target.startsWith('"') && !target.startsWith("'")) {
          links.push({ target: target.replace(/^<|>$/g, ''), line: index + 1 });
        }
      }
    }
  });
  return links;
}

/**
 * Resolves a link destination to a repository path, or null for external links and in-page anchors.
 * Returns `{ outside: true }` for paths that escape the repository root.
 * @param {string} fromFile repository-relative path of the markdown file, `/`-separated
 * @param {string} target
 * @returns {{ path: string, outside: boolean } | null}
 */
export function resolveRelativeLink(fromFile, target) {
  if (!target || target.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  let clean = target.split('#')[0].split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep the raw value; it will simply not exist
  }
  if (!clean) return null;
  const base = clean.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  const parts = [...base];
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return { path: clean, outside: true };
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return { path: parts.join('/'), outside: false };
}

/**
 * @param {{ path: string, content: string }[]} files
 * @param {(repoPath: string) => boolean} exists
 * @returns {{ file: string, line: number, target: string }[]}
 */
export function findBrokenLinks(files, exists) {
  const broken = [];
  for (const file of files) {
    for (const link of extractLinks(file.content)) {
      const resolved = resolveRelativeLink(file.path, link.target);
      if (!resolved) continue;
      if (resolved.outside || !exists(resolved.path)) broken.push({ file: file.path, line: link.line, target: link.target });
    }
  }
  return broken;
}

/**
 * @param {string} markdown
 * @returns {{ number: string, lines: number[] }[]}
 */
export function findDuplicateAdrNumbers(markdown) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  proseLines(markdown).forEach((line, index) => {
    const match = /^#{1,6}\s+ADR-(\d{1,5})\b/.exec(line);
    if (!match) return;
    const number = String(Number(match[1]));
    seen.set(number, [...(seen.get(number) ?? []), index + 1]);
  });
  return [...seen].filter(([, lines]) => lines.length > 1).map(([number, lines]) => ({ number, lines }));
}

/**
 * `docs/plans/*.md` and `docs/research/*.md` paths mentioned anywhere in STATE.md.
 * @param {string} markdown
 */
export function referencedPlanPaths(markdown) {
  const found = new Set();
  for (const prefix of ['docs/plans/', 'docs/research/']) {
    let from = 0;
    for (;;) {
      const at = markdown.indexOf(prefix, from);
      if (at < 0) break;
      let end = at + prefix.length;
      while (end < markdown.length && end - at < 300 && /[A-Za-z0-9._\-/]/.test(markdown[end])) end += 1;
      const candidate = markdown.slice(at, end).replace(/[.]+$/, '');
      if (candidate.endsWith('.md')) found.add(candidate);
      from = end;
    }
  }
  return [...found];
}

/**
 * Table rows of STATE.md that are marked in progress, with their 1-based line numbers.
 * @param {string} markdown
 */
export function inProgressRows(markdown) {
  const rows = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const inProgress = cells.some((c) => c.includes('🚧') || /\bin progress\b/i.test(c));
    if (!inProgress) continue;
    const module = cells.find((c, idx) => idx > 1 && c.length > 0) ?? line;
    const prs = [];
    let from = 0;
    for (;;) {
      const at = line.indexOf('PR #', from);
      if (at < 0) break;
      let end = at + 4;
      while (end < line.length && end - at < 12 && line[end] >= '0' && line[end] <= '9') end += 1;
      if (end > at + 4) prs.push(Number(line.slice(at + 4, end)));
      from = end;
    }
    rows.push({ line: i + 1, module: module.split(':')[0].slice(0, 80), prs });
  }
  return rows;
}

/**
 * Parses `git blame --line-porcelain` into committer times (ms) indexed by 1-based final line number.
 * @param {string} porcelain
 * @returns {Map<number, number>}
 */
export function parseBlamePorcelain(porcelain) {
  /** @type {Map<number, number>} */
  const times = new Map();
  let currentLine = 0;
  for (const line of porcelain.split('\n')) {
    const header = /^[0-9a-f]{40} \d+ (\d+)/.exec(line);
    if (header) {
      currentLine = Number(header[1]);
      continue;
    }
    if (line.startsWith('committer-time ') && currentLine > 0) {
      times.set(currentLine, Number(line.slice('committer-time '.length)) * 1000);
    }
  }
  return times;
}

/**
 * f. Docs consistency.
 * @param {{
 *   stateMd: string | null,
 *   decisionsMd: string | null,
 *   blameTimes: Map<number, number> | null,
 *   mergedPrs: Set<number>,
 *   linkedFiles: { path: string, content: string }[],
 *   exists: (repoPath: string) => boolean,
 *   now: Date,
 *   blobUrl: (repoPath: string, line?: number) => string,
 * }} input
 * @returns {CheckResult}
 */
export function evaluateDocs({ stateMd, decisionsMd, blameTimes, mergedPrs, linkedFiles, exists, now, blobUrl }) {
  /** @type {Finding[]} */
  const findings = [];
  if (stateMd === null) {
    findings.push({ status: 'critical', text: 'docs/STATE.md is missing' });
  } else {
    for (const row of inProgressRows(stateMd)) {
      const merged = row.prs.filter((n) => mergedPrs.has(n));
      if (merged.length > 0) {
        findings.push({ status: 'warning', text: `STATE.md line ${row.line}: "${row.module}" is in progress but PR #${merged.join(', #')} is merged`, url: blobUrl('docs/STATE.md', row.line) });
        continue;
      }
      const time = blameTimes?.get(row.line);
      if (time !== undefined) {
        const age = Math.floor((now.getTime() - time) / DAY_MS);
        if (age > 14) findings.push({ status: 'warning', text: `STATE.md line ${row.line}: "${row.module}" marked in progress for ${age} days`, url: blobUrl('docs/STATE.md', row.line) });
      }
    }
    for (const path of referencedPlanPaths(stateMd)) {
      if (!exists(path)) findings.push({ status: 'warning', text: `STATE.md references missing ${path}`, url: blobUrl('docs/STATE.md') });
    }
  }
  if (decisionsMd === null) {
    findings.push({ status: 'warning', text: 'docs/DECISIONS.md is missing' });
  } else {
    for (const dup of findDuplicateAdrNumbers(decisionsMd)) {
      findings.push({ status: 'warning', text: `ADR-${dup.number.padStart(3, '0')} heading appears ${dup.lines.length}× (lines ${dup.lines.join(', ')})`, url: blobUrl('docs/DECISIONS.md', dup.lines[1]) });
    }
  }
  for (const link of findBrokenLinks(linkedFiles, exists)) {
    findings.push({ status: 'warning', text: `${link.file}:${link.line} broken link to ${link.target}`, url: blobUrl(link.file, link.line) });
  }
  return makeCheck('docs', 'Docs consistency', findings, { okSummary: `STATE.md, ADR numbers and links in ${linkedFiles.length} files consistent` });
}
