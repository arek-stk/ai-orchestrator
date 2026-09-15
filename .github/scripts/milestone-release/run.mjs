// IO shell around logic.mjs for .github/workflows/milestone-release.yml.
//   node run.mjs gate     → decide whether an issue/PR event may start the write-capable release job (read-only token)
//   node run.mjs assign   → assign a milestone to pull request PR_NUMBER (fetched fresh from the API)
//   node run.mjs release  → request missing release-please runs (and CI in prepare/full mode), then plan and apply
//                           milestone releases
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, EVENT_NAME, EVENT_ACTION, EVENT_LABEL, ACTOR,
// ITEM_MILESTONE, EVENT_MILESTONE, AUTO_RELEASE, AUTO_RELEASE_PREPARE, AUTO_RELEASE_MERGE, DRY_RUN. Titles, bodies and
// labels are untrusted: they are only parsed, never executed, and pass through safeLog before they are printed.
import { appendFile } from 'node:fs/promises';
import * as logic from './logic.mjs';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? '';
const [OWNER] = REPOSITORY.split('/');
const DRY_RUN = process.env.DRY_RUN === 'true';
const MODE = logic.releaseMode({
  autoReleasePrepare: process.env.AUTO_RELEASE_PREPARE,
  autoReleaseMerge: process.env.AUTO_RELEASE_MERGE,
});
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

/**
 * Whether the required check passed for exactly the PR head SHA. With `dispatch` (prepare and full mode only), bot
 * PRs, whose own CI runs wait for approval, get CI dispatched once for their head commit.
 */
async function ciStatus(pr, { dispatch }) {
  const sha = encodeURIComponent(pr.headSha);
  const checks = await api(
    'GET',
    `${repoPath()}/commits/${sha}/check-runs?check_name=${encodeURIComponent(logic.CI_CHECK_NAME)}&per_page=50`,
  );
  if (!dispatch) return logic.requiredCheckSatisfied(checks.check_runs, pr.headSha);
  if (MODE === 'safe') throw new Error('CI dispatch requested in safe mode');
  const runs = await api('GET', `${repoPath()}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`);
  // Dispatch works by branch name: re-read the tip last so a moved branch is never tested in place of the evaluated head.
  const tip = await api('GET', `${repoPath()}/git/ref/heads/${pr.headRef}`, undefined, { allowNotFound: true });
  const decision = logic.ciDispatchDecision({
    headSha: pr.headSha,
    branchTipSha: tip?.object?.sha,
    checkRuns: checks.check_runs,
    workflowRuns: runs.workflow_runs,
  });
  if (decision === 'dispatch') await dispatchWorkflow('ci.yml', pr.headRef);
  else if (decision === 'stale-head') log(`PR #${pr.number} head moved since evaluation; CI dispatch deferred to the next run`);
  else log(`CI already requested for PR #${pr.number}`);
  return logic.requiredCheckSatisfied(checks.check_runs, pr.headSha);
}

async function enableAutoMerge(pr, { commitHeadline, commitBody } = {}) {
  if (MODE !== 'full') throw new Error('auto-merge requested outside full mode');
  const mutation = `mutation($id: ID!, $oid: GitObjectID, $headline: String, $body: String) {
    enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid,
      commitHeadline: $headline, commitBody: $body }) { clientMutationId }
  }`;
  await write(`enable squash auto-merge on PR #${pr.number}`, async () => {
    try {
      await graphql(mutation, { id: pr.nodeId, oid: pr.headSha, headline: commitHeadline ?? null, body: commitBody ?? null });
    } catch (error) {
      // Auto-merge cannot be enabled on a PR that is already mergeable; merge it through the REST API instead, which
      // still enforces branch protection and the expected head SHA.
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

async function openReleaseAsPr({ parsed, milestone, releasePr, defaultBranch, mainSha, autoMerge }) {
  if (MODE === 'safe') throw new Error('Release-As PR requested in safe mode');
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
  const mergeLine = autoMerge
    ? 'It merges automatically once the required checks pass (`AUTO_RELEASE_MERGE=true`).'
    : `Prepare mode: a maintainer squash-merges it once the required checks pass, keeping the \`Release-As: ${parsed.version}\` line in the commit message; the release PR then updates.`;
  const body = [
    `Milestone [${parsed.key}](${milestone.html_url}) is complete, but the release PR #${releasePr.number} targets a different version.`,
    '',
    `This PR adds an empty commit with a \`Release-As: ${parsed.version}\` footer so release-please retargets the release PR (ADR-012 addendum).`,
    mergeLine,
    '',
    `* Veto: close this PR (the automation will not reopen it).`,
    `* Pause all automatic release work: add the \`${logic.HOLD_LABEL}\` label to the release PR or set the repository variable \`AUTO_RELEASE=false\`.`,
  ].join('\n');
  const created = await write(`open the Release-As ${parsed.version} PR from ${branch}`, () =>
    api('POST', `${repoPath()}/pulls`, { title: headline, head: branch, base: defaultBranch, body }),
  );
  if (!created) return;
  const pr = logic.normalizePr(created);
  if (autoMerge) {
    await enableAutoMerge({ ...pr, headSha }, { commitHeadline: headline, commitBody: `Release-As: ${parsed.version}` });
  }
  await ciStatus({ ...pr, headSha }, { dispatch: true });
}

async function runGate() {
  const input = {
    eventName: process.env.EVENT_NAME,
    action: process.env.EVENT_ACTION,
    label: process.env.EVENT_LABEL,
    itemMilestone: process.env.ITEM_MILESTONE,
    eventMilestone: process.env.EVENT_MILESTONE,
    actorPermission: null,
  };
  let decision = logic.eventGate(input);
  if (decision.needsPermission) {
    // Fails closed: invalid logins, missing records and API errors all resolve to `none`.
    const { permission, reason } = await logic.resolveActorPermission(process.env.ACTOR, (actor) =>
      api('GET', `${repoPath()}/collaborators/${actor}/permission`, undefined, { allowNotFound: true }),
    );
    log(`actor permission: ${permission} (${reason})`);
    decision = logic.eventGate({ ...input, actorPermission: permission });
  }
  log(`event gate: ${decision.proceed ? 'proceed' : 'skip'} (${decision.reason})`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, decision.proceed ? 'proceed=true\n' : 'proceed=false\n');
  }
}

async function runAssign() {
  const prNumber = Number(process.env.PR_NUMBER);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return log('PR_NUMBER is not a pull request number');
  const hold = logic.holdReason({ autoRelease: process.env.AUTO_RELEASE });
  if (hold) return log(`paused: ${hold}`);
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
  log(
    {
      full: 'mode: full (AUTO_RELEASE_MERGE=true): Release-As PRs, CI dispatch for bot PRs and squash auto-merge',
      prepare: 'mode: prepare (AUTO_RELEASE_PREPARE=true): Release-As PRs and CI dispatch for bot PRs; a maintainer merges',
      safe: 'mode: safe: comments only, no pull requests, no CI dispatch, no auto-merge; a maintainer merges',
    }[MODE],
  );

  const openPulls = await paginate(`${repoPath()}/pulls?state=open`);
  const releasePr = logic.selectReleasePr(openPulls, REPOSITORY);
  const hold = logic.holdReason({ autoRelease: process.env.AUTO_RELEASE, releasePrLabels: releasePr?.labels ?? [] });
  if (hold) log(`paused: ${hold}; nothing is dispatched and only auto-merge enabled by this workflow is withdrawn`);

  // Merges and releases made with GITHUB_TOKEN trigger no push workflows; make sure release-please saw the head. This
  // is self-limiting: release-please hands back to this workflow, which then finds a run for the head and stops here.
  // It runs the default branch's own release workflow, not pull request code, so it is allowed in every mode.
  if (!hold) {
    const releaseRuns = await api(
      'GET',
      `${repoPath()}/actions/workflows/release-please.yml/runs?head_sha=${encodeURIComponent(mainSha)}&per_page=5`,
    );
    if (releaseRuns.total_count === 0) {
      await dispatchWorkflow('release-please.yml', defaultBranch);
      log('release-please had not run for the default branch head; dispatched it and deferred evaluation');
      return;
    }
  }

  const manifest = await api(
    'GET',
    `${repoPath()}/contents/.release-please-manifest.json?ref=${encodeURIComponent(defaultBranch)}`,
  );
  const currentVersion = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'))['.'];

  const ciSatisfied = new Map();
  if (!hold) {
    for (const pull of openPulls) {
      if (!logic.isTrustedAutomationPr(pull, REPOSITORY) || !logic.isAutomationBranch(pull.head.ref)) continue;
      ciSatisfied.set(pull.number, await ciStatus(logic.normalizePr(pull), { dispatch: MODE !== 'safe' }));
    }
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
    let targetReleasePr = null;
    if (isTarget) {
      const branch = logic.releaseAsBranch(parsed);
      const pulls = await api('GET', `${repoPath()}/pulls?state=all&head=${encodeURIComponent(`${OWNER}:${branch}`)}`);
      releaseAsPr = logic.selectReleaseAsPr(pulls, parsed, REPOSITORY);
      if (releasePr) {
        const comments = await paginate(`${repoPath()}/issues/${releasePr.number}/comments`);
        const botCommented = (marker) =>
          comments.some((c) => c.user?.login === logic.BOT_LOGIN && c.body?.includes(marker));
        targetReleasePr = {
          ...releasePr,
          readyCommented: botCommented(logic.readyMarker(parsed)),
          retargetCommented: botCommented(logic.retargetMarker(parsed)),
        };
      }
    }

    const plan = logic.planMilestone({
      milestone,
      currentVersion,
      release,
      releasePr: targetReleasePr,
      ciSatisfied: targetReleasePr ? ciSatisfied.get(targetReleasePr.number) === true : false,
      mergedReleasePr,
      releaseAsPr,
      autoRelease: process.env.AUTO_RELEASE,
      autoReleasePrepare: process.env.AUTO_RELEASE_PREPARE,
      autoReleaseMerge: process.env.AUTO_RELEASE_MERGE,
    });
    log(`${parsed.key}: ${plan.status} (${plan.reason})`);

    for (const action of plan.actions) {
      switch (action.type) {
        case 'enable-auto-merge':
          await enableAutoMerge(targetReleasePr);
          break;
        case 'disable-auto-merge':
          await disableAutoMerge(targetReleasePr);
          break;
        case 'enable-release-as-auto-merge':
          await enableAutoMerge(releaseAsPr, {
            commitHeadline: logic.releaseAsCommitMessage(parsed).split('\n')[0],
            commitBody: `Release-As: ${parsed.version}`,
          });
          break;
        case 'disable-release-as-auto-merge':
          await disableAutoMerge(releaseAsPr);
          break;
        case 'open-release-as-pr':
          await openReleaseAsPr({
            parsed,
            milestone,
            releasePr: targetReleasePr,
            defaultBranch,
            mainSha,
            autoMerge: action.autoMerge === true,
          });
          break;
        case 'comment-release-ready':
          await write(`comment that release PR #${targetReleasePr.number} is ready to merge`, () =>
            api('POST', `${repoPath()}/issues/${targetReleasePr.number}/comments`, {
              body: logic.readyCommentBody(parsed, milestone.html_url, MODE),
            }),
          );
          break;
        case 'comment-retarget-instructions':
          await write(`comment Release-As ${parsed.version} instructions on release PR #${targetReleasePr.number}`, () =>
            api('POST', `${repoPath()}/issues/${targetReleasePr.number}/comments`, {
              body: logic.retargetCommentBody(
                parsed,
                milestone.html_url,
                logic.parseReleasePrVersion(targetReleasePr.title),
              ),
            }),
          );
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
const runners = { gate: runGate, assign: runAssign, release: runRelease };
if (!TOKEN || !REPOSITORY || !runners[mode]) {
  console.error('usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node run.mjs gate|assign|release');
  process.exit(2);
}
runners[mode]().catch((error) => {
  console.error(logic.safeLog(error.message));
  process.exitCode = 1;
});
