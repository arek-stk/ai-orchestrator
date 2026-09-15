// @ts-check
// Repo Guardian entry point (ADR-012), run by `.github/workflows/repo-guardian.yml` through actions/github-script.
//
// Token model:
// * GITHUB_TOKEN (job permissions) covers CI runs, code scanning, Dependabot alerts (`vulnerability-alerts: read`),
//   pull requests and review threads, branches, the branch protection summary and the report issue.
// * Optional secret REPO_GUARDIAN_TOKEN: a fine-grained personal access token for this repository only with
//   read-only "Secret scanning alerts" and "Administration" permissions (plus "Dependabot alerts" if the
//   GITHUB_TOKEN cannot read them). It is used for reads only; writes always use GITHUB_TOKEN. Without it, secret
//   scanning is reported as "not checked" and branch protection falls back to the public protection summary.
// The token value is never logged or rendered.
//
// Local docs check (no token needed): `node .github/scripts/repo-guardian/repo-guardian.mjs --docs`
import { pathToFileURL } from 'node:url';
import { collectDocs } from './docs.mjs';
import {
  ISSUE_LABEL,
  ISSUE_TITLE,
  REQUIRED_CHECK,
  evaluateBranchProtection,
  evaluateCi,
  evaluateCodeScanning,
  evaluateDependabotAlerts,
  evaluateDependabotPrs,
  evaluateDocs,
  evaluatePullRequests,
  evaluateSecretScanning,
  errorCheck,
  evaluateStaleBranches,
  inProgressRows,
  planIssueUpdate,
  renderCriticalComment,
  renderReport,
  skippedCheck,
  summarizeChecks,
  trustedPreviousState,
} from './lib.mjs';

const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const BOT_LOGIN = 'github-actions[bot]';

/**
 * @param {unknown} error
 */
function httpStatus(error) {
  return error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
}

/**
 * @param {unknown} error
 */
function isPermissionError(error) {
  const status = httpStatus(error);
  return status === 401 || status === 403 || status === 404;
}

/**
 * Bounded REST pagination.
 * @param {any} octokit
 * @param {any} method
 * @param {Record<string, unknown>} params
 * @param {(response: any) => any[]} [pick]
 */
async function paginate(octokit, method, params, pick = (r) => r.data) {
  const items = [];
  let pages = 0;
  for await (const response of octokit.paginate.iterator(method, { per_page: 100, ...params })) {
    items.push(...pick(response));
    pages += 1;
    if (pages >= MAX_PAGES) break;
  }
  return items;
}

/**
 * Runs a check and turns unexpected errors into an `error` result (degraded report) instead of failing the whole run.
 * @param {string} id
 * @param {string} title
 * @param {() => Promise<import('./lib.mjs').CheckResult>} fn
 * @param {any} core
 */
async function guarded(id, title, fn, core) {
  try {
    return await fn();
  } catch (error) {
    const status = httpStatus(error);
    core.warning(`${title}: ${status ? `HTTP ${status}` : error instanceof Error ? error.message : 'error'}`);
    return errorCheck(id, title, status ? `API returned HTTP ${status}` : 'unexpected error, see workflow log');
  }
}

/**
 * @param {{ github: any, owner: string, repo: string, defaultBranch: string, now: Date, selfRunId: number }} ctx
 */
async function checkCi({ github, owner, repo, defaultBranch, now, selfRunId }) {
  const checkRuns = await github.rest.checks.listForRef({ owner, repo, ref: defaultBranch, check_name: REQUIRED_CHECK, per_page: 10 });
  const latestCheck = checkRuns.data.check_runs[0];
  const workflows = await paginate(github, github.rest.actions.listRepoWorkflows, { owner, repo }, (r) => r.data.workflows ?? r.data);
  const evaluated = [];
  for (const workflow of workflows.filter((w) => w.state === 'active')) {
    const runs = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflow.id, branch: defaultBranch, per_page: 5, exclude_pull_requests: true });
    const latest = runs.data.workflow_runs.find((run) => run.id !== selfRunId && run.status === 'completed');
    evaluated.push({
      name: workflow.name,
      path: workflow.path,
      latestRun: latest ? { conclusion: latest.conclusion, status: latest.status, url: latest.html_url, event: latest.event, createdAt: latest.created_at } : null,
    });
  }
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
  const scheduled = await paginate(
    github,
    github.rest.actions.listWorkflowRunsForRepo,
    { owner, repo, event: 'schedule', status: 'failure', created: `>=${since}` },
    (r) => r.data.workflow_runs ?? r.data,
  );
  return evaluateCi({
    defaultBranch,
    requiredCheck: latestCheck ? { status: latestCheck.status, conclusion: latestCheck.conclusion, url: latestCheck.html_url } : null,
    workflows: evaluated,
    scheduledFailures: scheduled.filter((run) => run.id !== selfRunId).map((run) => ({ workflowName: run.name, url: run.html_url, createdAt: run.created_at })),
  });
}

/**
 * @param {{ github: any, owner: string, repo: string }} ctx
 */
async function checkCodeScanning({ github, owner, repo }) {
  try {
    const alerts = await paginate(github, github.rest.codeScanning.listAlertsForRepo, { owner, repo, state: 'open' });
    return evaluateCodeScanning(
      alerts.map((a) => ({
        number: a.number,
        tool: a.tool?.name ?? 'unknown',
        rule: a.rule?.description || a.rule?.id || 'unknown rule',
        securitySeverity: a.rule?.security_severity_level ?? null,
        severity: a.rule?.severity ?? null,
        url: a.html_url,
      })),
      `https://github.com/${owner}/${repo}/security/code-scanning`,
    );
  } catch (error) {
    if (isPermissionError(error)) return skippedCheck('code-scanning', 'Code scanning alerts', 'code scanning disabled or needs `security-events: read`');
    throw error;
  }
}

/**
 * @param {{ readers: any[], owner: string, repo: string }} ctx
 */
async function checkDependabotAlerts({ readers, owner, repo }) {
  for (const octokit of readers) {
    try {
      const alerts = await paginate(octokit, octokit.rest.dependabot.listAlertsForRepo, { owner, repo, state: 'open' });
      return evaluateDependabotAlerts(
        alerts.map((a) => ({
          number: a.number,
          severity: a.security_advisory?.severity ?? a.security_vulnerability?.severity ?? 'unknown',
          package: a.dependency?.package?.name ?? 'unknown package',
          summary: a.security_advisory?.summary ?? '',
          url: a.html_url,
        })),
      );
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
  }
  return skippedCheck('dependabot-alerts', 'Dependabot alerts', 'needs `vulnerability-alerts: read` or REPO_GUARDIAN_TOKEN with Dependabot alerts: read');
}

/**
 * @param {{ readers: any[], owner: string, repo: string }} ctx
 */
async function checkSecretScanning({ readers, owner, repo }) {
  for (const octokit of readers) {
    try {
      const alerts = await paginate(octokit, octokit.rest.secretScanning.listAlertsForRepo, { owner, repo, state: 'open' });
      // Only the number, type and link are kept; the `secret` field never leaves this function.
      return evaluateSecretScanning(alerts.map((a) => ({ number: a.number, secretType: a.secret_type_display_name ?? a.secret_type ?? 'secret', url: a.html_url })));
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
  }
  return skippedCheck('secret-scanning', 'Secret scanning alerts', 'needs REPO_GUARDIAN_TOKEN with Secret scanning alerts: read');
}

/**
 * @param {{ github: any, owner: string, repo: string }} ctx
 * @returns {Promise<import('./lib.mjs').PullRequestInfo[]>}
 */
async function fetchPullRequests({ github, owner, repo }) {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url isDraft createdAt updatedAt mergeable headRefName
          author { login }
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          reviewThreads(first: 100) { nodes { isResolved } }
        }
      }
    }
  }`;
  const prs = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await github.graphql(query, { owner, name: repo, cursor });
    const connection = result.repository.pullRequests;
    for (const pr of connection.nodes) {
      prs.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? 'ghost',
        headRef: pr.headRefName,
        isDraft: pr.isDraft,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        mergeable: pr.mergeable,
        checks: pr.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null,
        unresolvedThreads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return prs;
}

/**
 * @param {{ github: any, readers: any[], owner: string, repo: string, defaultBranch: string }} ctx
 */
async function checkBranchProtection({ github, readers, owner, repo, defaultBranch }) {
  const contexts = new Set();
  let isProtected = false;
  let source = 'protection summary';
  /** @type {{ allowForcePushes: boolean, conversationResolution: boolean } | null} */
  let details = null;
  for (const octokit of readers) {
    try {
      const { data } = await octokit.rest.repos.getBranchProtection({ owner, repo, branch: defaultBranch });
      isProtected = true;
      source = 'branch protection';
      for (const c of data.required_status_checks?.contexts ?? []) contexts.add(c);
      for (const c of data.required_status_checks?.checks ?? []) contexts.add(c.context);
      details = { allowForcePushes: Boolean(data.allow_force_pushes?.enabled), conversationResolution: Boolean(data.required_conversation_resolution?.enabled) };
      break;
    } catch (error) {
      if (httpStatus(error) === 404 && octokit !== readers[readers.length - 1]) continue;
      if (!isPermissionError(error)) throw error;
    }
  }
  if (!details) {
    // Readable with `contents: read`: the branch endpoint includes a summary of required status checks.
    const { data } = await github.rest.repos.getBranch({ owner, repo, branch: defaultBranch });
    isProtected = Boolean(data.protected);
    for (const c of data.protection?.required_status_checks?.contexts ?? []) contexts.add(c);
    for (const c of data.protection?.required_status_checks?.checks ?? []) contexts.add(c.context);
  }
  try {
    const rules = await paginate(github, github.rest.repos.getBranchRules, { owner, repo, branch: defaultBranch });
    for (const rule of rules) {
      if (rule.type !== 'required_status_checks') continue;
      for (const check of rule.parameters?.required_status_checks ?? []) contexts.add(check.context);
      source += ' + rulesets';
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
  }
  return evaluateBranchProtection({ branch: defaultBranch, protected: isProtected, requiredContexts: [...contexts], source, details });
}

/**
 * @param {{ github: any, owner: string, repo: string }} ctx
 */
async function fetchBranches({ github, owner, repo }) {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name target { ... on Commit { committedDate } } }
      }
    }
  }`;
  const branches = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await github.graphql(query, { owner, name: repo, cursor });
    const refs = result.repository.refs;
    for (const ref of refs.nodes) {
      branches.push({ name: ref.name, committedAt: ref.target?.committedDate ?? '', url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref.name)}` });
    }
    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
  }
  return branches;
}

/**
 * @param {{ github: any, owner: string, repo: string, now: Date, root: string, sha: string, prs: import('./lib.mjs').PullRequestInfo[] }} ctx
 */
async function checkDocs({ github, owner, repo, now, root, sha }) {
  const docs = collectDocs(root);
  const mergedPrs = new Set();
  const mentioned = docs.stateMd ? inProgressRows(docs.stateMd).flatMap((row) => row.prs) : [];
  for (const number of [...new Set(mentioned)].slice(0, 20)) {
    try {
      const { data } = await github.rest.pulls.get({ owner, repo, pull_number: number });
      if (data.merged_at) mergedPrs.add(number);
    } catch (error) {
      if (!isPermissionError(error)) throw error;
    }
  }
  return evaluateDocs({
    ...docs,
    mergedPrs,
    now,
    blobUrl: (path, line) => `https://github.com/${owner}/${repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`,
  });
}

/**
 * @param {{ github: any, owner: string, repo: string }} ctx
 */
async function ensureLabel({ github, owner, repo }) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: ISSUE_LABEL });
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
    await github.rest.issues.createLabel({ owner, repo, name: ISSUE_LABEL, color: '5319e7', description: 'Repository health report maintained by the Repo Guardian workflow' });
  }
}

/**
 * Keeps exactly one bot-authored report issue: updates it in place, closes or reopens it and comments only when a
 * check newly becomes critical.
 * @param {{ github: any, core: any, owner: string, repo: string, checks: import('./lib.mjs').CheckResult[],
 *   render: (previous: Record<string, import('./lib.mjs').Status>) => string, runUrl: string }} ctx
 */
async function publishIssue({ github, core, owner, repo, checks, render, runUrl }) {
  await ensureLabel({ github, owner, repo });
  const candidates = (await paginate(github, github.rest.issues.listForRepo, { owner, repo, labels: ISSUE_LABEL, state: 'all', sort: 'created', direction: 'asc' }))
    .filter((issue) => !issue.pull_request && issue.title === ISSUE_TITLE && issue.user?.login === BOT_LOGIN);
  const issue = candidates.find((i) => i.state === 'open') ?? candidates[candidates.length - 1] ?? null;
  /** @type {Record<string, import('./lib.mjs').Status>} */
  let previous = {};
  if (issue) {
    try {
      const result = await github.graphql(
        'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { editor { login } } } }',
        { owner, name: repo, number: issue.number },
      );
      previous = trustedPreviousState(issue.body, result.repository.issue?.editor?.login ?? null);
    } catch {
      core.warning(`Could not read the last editor of issue #${issue.number}; ignoring its recorded state`);
    }
  }
  const plan = planIssueUpdate({ exists: Boolean(issue), open: issue?.state === 'open', checks, previous });
  const body = render(previous);

  let number = issue?.number ?? null;
  if (plan.create) {
    const created = await github.rest.issues.create({ owner, repo, title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] });
    number = created.data.number;
    core.info(`Created report issue #${number}`);
  } else if (issue) {
    /** @type {Record<string, unknown>} */
    const update = { owner, repo, issue_number: issue.number, body };
    if (plan.close) Object.assign(update, { state: 'closed', state_reason: 'completed' });
    if (plan.reopen) Object.assign(update, { state: 'open' });
    await github.rest.issues.update(update);
    core.info(`Updated report issue #${issue.number}${plan.close ? ' (closed)' : plan.reopen ? ' (reopened)' : ''}`);
  }
  // Duplicates (e.g. from a race before concurrency was configured) are closed so exactly one stays open.
  for (const duplicate of candidates.filter((i) => i.state === 'open' && i.number !== number)) {
    await github.rest.issues.update({ owner, repo, issue_number: duplicate.number, state: 'closed', state_reason: 'not_planned' });
  }
  if (plan.comment && number !== null) {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body: renderCriticalComment(checks, plan.newlyCritical, runUrl) });
  }
  return { number, plan };
}

/**
 * @param {{ github: any, context: any, core: any, getOctokit?: (token: string) => any, dryRun?: boolean, root?: string }} args
 */
export default async function run({ github, context, core, getOctokit, dryRun = false, root = process.cwd() }) {
  const { owner, repo } = context.repo;
  const now = new Date();
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const defaultBranch = repository.default_branch;
  const extraToken = process.env.REPO_GUARDIAN_TOKEN;
  const readers = extraToken && getOctokit ? [github, getOctokit(extraToken)] : [github];
  const runUrl = `${context.serverUrl ?? 'https://github.com'}/${owner}/${repo}/actions/runs/${context.runId}`;
  const ctx = { github, readers, owner, repo, defaultBranch, now, selfRunId: Number(context.runId) };
  core.info(`Extra token ${extraToken ? 'configured' : 'not configured'}`);

  /** @type {import('./lib.mjs').PullRequestInfo[] | null} */
  let prs = null;
  try {
    prs = await fetchPullRequests(ctx);
  } catch (error) {
    core.warning(`Pull requests could not be read (HTTP ${httpStatus(error) || 'error'})`);
  }

  const checks = [
    await guarded('ci', 'CI on default branch', () => checkCi(ctx), core),
    await guarded('code-scanning', 'Code scanning alerts', () => checkCodeScanning(ctx), core),
    await guarded('dependabot-alerts', 'Dependabot alerts', () => checkDependabotAlerts(ctx), core),
    await guarded('secret-scanning', 'Secret scanning alerts', () => checkSecretScanning(ctx), core),
    prs ? evaluatePullRequests(prs, now) : errorCheck('pull-requests', 'Open pull requests', 'pull requests could not be read'),
    await guarded('branch-protection', 'Branch protection', () => checkBranchProtection(ctx), core),
    await guarded('docs', 'Docs consistency', () => checkDocs({ ...ctx, root, sha: context.sha, prs: prs ?? [] }), core),
    await guarded('stale-branches', 'Stale branches', async () => {
      const heads = new Set((prs ?? []).map((pr) => pr.headRef));
      return evaluateStaleBranches(await fetchBranches(ctx), heads, defaultBranch, now);
    }, core),
    prs ? evaluateDependabotPrs(prs, now) : errorCheck('dependabot-prs', 'Dependabot pull requests', 'pull requests could not be read'),
  ];

  const ref = `${String(context.ref ?? '').replace(/^refs\/heads\//, '')}@${String(context.sha ?? '').slice(0, 7)}`;
  /** @param {Record<string, import('./lib.mjs').Status>} previous */
  const render = (previous) => renderReport({ checks, generatedAt: now, runUrl, trigger: context.eventName, ref, previous });
  const body = render({});
  const { label, errors } = summarizeChecks(checks);
  core.info(`Overall: ${label}${errors.length ? ` (${errors.length} checks could not run)` : ''}`);
  if (core.summary) await core.summary.addRaw(body, true).write();
  if (dryRun) return { checks, body, issue: null };
  const issue = await publishIssue({ github, core, owner, repo, checks, render, runUrl });
  return { checks, body, issue };
}

// `node repo-guardian.mjs --docs` runs the docs consistency check against the working tree without any token.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv.includes('--docs')) {
  const root = process.cwd();
  const result = evaluateDocs({ ...collectDocs(root), mergedPrs: new Set(), now: new Date(), blobUrl: (path, line) => `${path}${line ? `#L${line}` : ''}` });
  console.log(`${result.status}: ${result.summary}`);
  for (const finding of result.findings) console.log(`  [${finding.status}] ${finding.text}`);
  process.exitCode = result.status === 'ok' ? 0 : 1;
}
