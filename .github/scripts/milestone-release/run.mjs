// IO shell around logic.mjs for .github/workflows/milestone-release.yml.
//   node run.mjs assign   → assign a milestone to pull request PR_NUMBER (fetched fresh from the API)
//   node run.mjs release  → request missing CI/release-please runs, then plan and apply milestone releases
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, AUTO_RELEASE, DRY_RUN. Titles, bodies and labels are
// untrusted: they are only parsed, never executed, and pass through safeLog before they are printed.
import * as logic from './logic.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? '';
const [OWNER] = REPOSITORY.split('/');
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_PAGES = 5;

function log(message) {
  console.log(logic.safeLog(message));
}

async function api(method, path, body, { allowNotFound = false } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'milestone-release',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allowNotFound && response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path.split('?')[0]} failed with HTTP ${response.status}: ${logic.safeLog(text)}`);
    error.status = response.status;
    error.responseText = text;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function paginate(path) {
  const items = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api('GET', `${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function graphql(query, variables) {
  const result = await api('POST', '/graphql', { query, variables });
  if (result.errors?.length) {
    throw new Error(`GraphQL error: ${logic.safeLog(result.errors.map((e) => e.message).join('; '))}`);
  }
  return result.data;
}

async function write(description, fn) {
  if (DRY_RUN) {
    log(`[dry-run] would ${description}`);
    return null;
  }
  log(description);
  return fn();
}

const repoPath = () => `/repos/${REPOSITORY}`;

async function dispatchWorkflow(file, ref) {
  await write(`dispatch ${file} on ${ref}`, () =>
    api('POST', `${repoPath()}/actions/workflows/${file}/dispatches`, { ref }),
  );
}

/** Bot-created PRs get no CI run of their own (it waits for approval); dispatch CI once for their head commit. */
async function ensureCi(pr) {
  const sha = encodeURIComponent(pr.headSha);
  const checks = await api(
    'GET',
    `${repoPath()}/commits/${sha}/check-runs?check_name=${encodeURIComponent(logic.CI_CHECK_NAME)}`,
  );
  const runs = await api('GET', `${repoPath()}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`);
  if (logic.needsCiDispatch({ checkRuns: checks.check_runs, workflowRuns: runs.workflow_runs })) {
    await dispatchWorkflow('ci.yml', pr.headRef);
  } else {
    log(`CI already requested for PR #${pr.number}`);
  }
}

async function enableAutoMerge(pr, { commitHeadline, commitBody } = {}) {
  const mutation = `mutation($id: ID!, $oid: GitObjectID, $headline: String, $body: String) {
    enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid,
      commitHeadline: $headline, commitBody: $body }) { clientMutationId }
  }`;
  await write(`enable squash auto-merge on PR #${pr.number}`, async () => {
    try {
      await graphql(mutation, { id: pr.nodeId, oid: pr.headSha, headline: commitHeadline ?? null, body: commitBody ?? null });
    } catch (error) {
      // Auto-merge cannot be enabled on a PR that is already mergeable; merge it through the REST API instead, which
      // still enforces branch protection.
      if (!/clean status/i.test(String(error.message))) throw error;
      await api('PUT', `${repoPath()}/pulls/${pr.number}/merge`, {
        merge_method: 'squash',
        sha: pr.headSha,
        ...(commitHeadline ? { commit_title: commitHeadline } : {}),
        ...(commitBody ? { commit_message: commitBody } : {}),
      });
    }
  });
}

async function disableAutoMerge(pr) {
  const mutation = `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`;
  await write(`disable auto-merge that this workflow enabled on PR #${pr.number}`, () =>
    graphql(mutation, { id: pr.nodeId }),
  );
}

async function openReleaseAsPr({ parsed, milestone, releasePr, defaultBranch, mainSha }) {
  const branch = logic.releaseAsBranch(parsed);
  const message = logic.releaseAsCommitMessage(parsed);
  const headline = message.split('\n')[0];
  let headSha;
  const existing = await api('GET', `${repoPath()}/git/ref/heads/${branch}`, undefined, { allowNotFound: true });
  if (existing) {
    const commit = await api('GET', `${repoPath()}/git/commits/${existing.object.sha}`);
    if (!commit.message.includes(`Release-As: ${parsed.version}`)) {
      throw new Error(`branch ${branch} exists without a Release-As ${parsed.version} commit; needs a human`);
    }
    headSha = existing.object.sha;
  } else {
    headSha = await write(`create ${branch} with an empty Release-As ${parsed.version} commit`, async () => {
      const base = await api('GET', `${repoPath()}/git/commits/${mainSha}`);
      const commit = await api('POST', `${repoPath()}/git/commits`, {
        message,
        tree: base.tree.sha,
        parents: [mainSha],
      });
      await api('POST', `${repoPath()}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      return commit.sha;
    });
  }
  const body = [
    `Milestone [${parsed.key}](${milestone.html_url}) is complete, but the release PR #${releasePr.number} targets a different version.`,
    '',
    `This PR adds an empty commit with a \`Release-As: ${parsed.version}\` footer so release-please retargets the release PR (ADR-012 addendum).`,
    'It merges automatically once the required checks pass.',
    '',
    `* Veto: close this PR (the automation will not reopen it).`,
    `* Pause all automatic releases: add the \`${logic.HOLD_LABEL}\` label to the release PR or set the repository variable \`AUTO_RELEASE=false\`.`,
  ].join('\n');
  const created = await write(`open the Release-As ${parsed.version} PR from ${branch}`, () =>
    api('POST', `${repoPath()}/pulls`, { title: headline, head: branch, base: defaultBranch, body }),
  );
  if (!created) return;
  const pr = logic.normalizePr(created);
  await enableAutoMerge({ ...pr, headSha }, { commitHeadline: headline, commitBody: `Release-As: ${parsed.version}` });
  await ensureCi({ ...pr, headSha });
}

async function runAssign() {
  const prNumber = Number(process.env.PR_NUMBER);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return log('PR_NUMBER is not a pull request number');
  const pr = await api('GET', `${repoPath()}/pulls/${prNumber}`);
  if (pr.milestone) return log(`PR #${pr.number} already has a milestone`);
  const openMilestones = await paginate(`${repoPath()}/milestones?state=open`);
  const referencedIssueMilestoneNumbers = [];
  for (const number of logic.parseClosingReferences(pr.body, REPOSITORY)) {
    const issue = await api('GET', `${repoPath()}/issues/${number}`, undefined, { allowNotFound: true });
    if (issue && !issue.pull_request && issue.milestone) referencedIssueMilestoneNumbers.push(issue.milestone.number);
  }
  const target = logic.pickMilestoneForPr({
    pr: { milestone: pr.milestone, headRef: pr.head?.ref, labels: (pr.labels ?? []).map((label) => label.name) },
    openMilestones,
    referencedIssueMilestoneNumbers,
  });
  if (!target) return log(`no label or closing reference indicates a milestone for PR #${pr.number}; leaving it unset`);
  await write(`assign milestone ${logic.parseMilestoneVersion(target.title).key} to PR #${pr.number}`, () =>
    api('PATCH', `${repoPath()}/issues/${pr.number}`, { milestone: target.number }),
  );
}

async function runRelease() {
  const repo = await api('GET', repoPath());
  const defaultBranch = repo.default_branch;
  const branchRef = await api('GET', `${repoPath()}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const mainSha = branchRef.object.sha;
  if (DRY_RUN) log('dry run: no changes will be made');

  // Merges and releases made with GITHUB_TOKEN trigger no push workflows; make sure release-please saw the head.
  const releaseRuns = await api(
    'GET',
    `${repoPath()}/actions/workflows/release-please.yml/runs?head_sha=${encodeURIComponent(mainSha)}&per_page=5`,
  );
  if (releaseRuns.total_count === 0) {
    await dispatchWorkflow('release-please.yml', defaultBranch);
    log('release-please had not run for the default branch head; dispatched it and deferred evaluation');
    return;
  }

  const manifest = await api(
    'GET',
    `${repoPath()}/contents/.release-please-manifest.json?ref=${encodeURIComponent(defaultBranch)}`,
  );
  const currentVersion = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'))['.'];
  const openPulls = await paginate(`${repoPath()}/pulls?state=open`);
  const releasePr = logic.selectReleasePr(openPulls, REPOSITORY);

  for (const pull of openPulls) {
    if (!logic.isTrustedAutomationPr(pull, REPOSITORY) || !logic.isAutomationBranch(pull.head.ref)) continue;
    await ensureCi(logic.normalizePr(pull));
  }

  const milestones = logic.releaseMilestones(await paginate(`${repoPath()}/milestones?state=open`));
  for (const [index, { milestone, parsed }] of milestones.entries()) {
    const release = await api('GET', `${repoPath()}/releases/tags/${parsed.tag}`, undefined, { allowNotFound: true });
    const isTarget = index === 0;
    if (!isTarget && !release) {
      log(`${parsed.key}: waiting (a lower release milestone is still open)`);
      continue;
    }
    let mergedReleasePr = null;
    if (release) {
      const closed = await api('GET', `${repoPath()}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
      mergedReleasePr = logic.selectMergedReleasePr(closed, parsed, REPOSITORY);
      if (mergedReleasePr) {
        const comments = await paginate(`${repoPath()}/issues/${mergedReleasePr.number}/comments`);
        const marker = logic.milestoneMarker(parsed);
        mergedReleasePr.commented = comments.some((c) => c.user?.login === logic.BOT_LOGIN && c.body?.includes(marker));
      }
    }
    let releaseAsPr = null;
    if (isTarget) {
      const branch = logic.releaseAsBranch(parsed);
      const pulls = await api('GET', `${repoPath()}/pulls?state=all&head=${encodeURIComponent(`${OWNER}:${branch}`)}`);
      releaseAsPr = logic.selectReleaseAsPr(pulls, parsed, REPOSITORY);
    }

    const plan = logic.planMilestone({
      milestone,
      currentVersion,
      release,
      releasePr: isTarget ? releasePr : null,
      mergedReleasePr,
      releaseAsPr,
      autoRelease: process.env.AUTO_RELEASE,
    });
    log(`${parsed.key}: ${plan.status} (${plan.reason})`);

    for (const action of plan.actions) {
      switch (action.type) {
        case 'enable-auto-merge':
          await enableAutoMerge(releasePr);
          break;
        case 'disable-auto-merge':
          await disableAutoMerge(releasePr);
          break;
        case 'enable-release-as-auto-merge':
          await enableAutoMerge(releaseAsPr, {
            commitHeadline: logic.releaseAsCommitMessage(parsed).split('\n')[0],
            commitBody: `Release-As: ${parsed.version}`,
          });
          break;
        case 'open-release-as-pr':
          await openReleaseAsPr({ parsed, milestone, releasePr, defaultBranch, mainSha });
          break;
        case 'annotate-release': {
          const notes = logic.releaseNotesWithMilestone(release.body, parsed, milestone.html_url);
          await write(`append the milestone link to release ${parsed.tag}`, () =>
            api('PATCH', `${repoPath()}/releases/${release.id}`, { body: notes }),
          );
          break;
        }
        case 'comment-release-pr':
          await write(`comment the release link on PR #${mergedReleasePr.number}`, () =>
            api('POST', `${repoPath()}/issues/${mergedReleasePr.number}/comments`, {
              body: `${logic.milestoneMarker(parsed)}\nReleased [${parsed.tag}](${release.html_url}). Milestone [${parsed.key}](${milestone.html_url}) is complete and has been closed.`,
            }),
          );
          break;
        case 'close-milestone':
          await write(`close milestone ${parsed.key}`, () =>
            api('PATCH', `${repoPath()}/milestones/${milestone.number}`, { state: 'closed' }),
          );
          break;
        default:
          throw new Error(`unknown action ${action.type}`);
      }
    }
  }
}

const mode = process.argv[2];
const runners = { assign: runAssign, release: runRelease };
if (!TOKEN || !REPOSITORY || !runners[mode]) {
  console.error('usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node run.mjs assign|release');
  process.exit(2);
}
runners[mode]().catch((error) => {
  console.error(logic.safeLog(error.message));
  process.exitCode = 1;
});
