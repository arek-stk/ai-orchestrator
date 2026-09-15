// Pure decision logic for milestone-driven releases (ADR-012 addendum). No IO: every GitHub fact is passed in, every
// side effect is returned as a plan, so the rules can be unit tested and re-evaluated safely on every run.

export const RELEASE_BRANCH_PREFIX = 'release-please--';
export const RELEASE_AS_BRANCH_PREFIX = 'release-as/';
export const HOLD_LABEL = 'release:hold';
export const MILESTONE_LABEL_PREFIX = 'milestone:';
export const CI_CHECK_NAME = 'Typecheck and test';
export const BOT_LOGIN = 'github-actions[bot]';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TRUSTED_EVENTS = ['schedule', 'workflow_dispatch', 'milestone'];
const WRITE_ROLES = ['admin', 'maintain', 'write'];

/** `v0.4 — Project Room` → version 0.4.0. Only `vX.Y` followed by whitespace or the end qualifies. */
export function parseMilestoneVersion(title) {
  if (typeof title !== 'string') return null;
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?=\s|$)/.exec(title.trim());
  if (!match) return null;
  const version = `${match[1]}.${match[2]}.0`;
  return { major: Number(match[1]), minor: Number(match[2]), version, tag: `v${version}`, key: `v${match[1]}.${match[2]}` };
}

/** `chore(main): release 0.3.0` → `0.3.0`. */
export function parseReleasePrVersion(title) {
  if (typeof title !== 'string') return null;
  const match = /^chore(?:\([^)]*\))?!?: release (\d+\.\d+\.\d+)$/.exec(title.trim());
  return match && SEMVER.test(match[1]) ? match[1] : null;
}

export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error('invalid semantic version');
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isMilestoneComplete(milestone) {
  return milestone.state === 'open' && milestone.open_issues === 0 && milestone.closed_issues >= 1;
}

/** Open `vX.Y` milestones ordered by version, lowest first. */
export function releaseMilestones(milestones) {
  return milestones
    .filter((m) => m.state === 'open')
    .map((m) => ({ milestone: m, parsed: parseMilestoneVersion(m.title) }))
    .filter((entry) => entry.parsed !== null)
    .sort((a, b) => compareVersions(a.parsed.version, b.parsed.version));
}

export function isAutomationBranch(ref) {
  return typeof ref === 'string' && (ref.startsWith(RELEASE_BRANCH_PREFIX) || ref.startsWith(RELEASE_AS_BRANCH_PREFIX));
}

/** Global pause: repository variable `AUTO_RELEASE=false` or the `release:hold` label on the release PR. */
export function holdReason({ autoRelease, releasePrLabels = [] }) {
  if (typeof autoRelease === 'string' && autoRelease.trim().toLowerCase() === 'false') {
    return 'repository variable AUTO_RELEASE is false';
  }
  if (releasePrLabels.includes(HOLD_LABEL)) return `release PR has the ${HOLD_LABEL} label`;
  return null;
}

/**
 * Safe mode is the default: the automation never enables auto-merge unless the repository variable
 * `AUTO_RELEASE_MERGE` is exactly `true`.
 */
export function isFullAutoMerge(autoReleaseMerge) {
  return autoReleaseMerge === 'true';
}

/**
 * Release mode from the repository variables; any value other than exactly `true` counts as unset.
 * - `safe` (default): no pull requests, no CI dispatch, no auto-merge. The workflow only comments, annotates release
 *   notes and closes milestones; a maintainer retargets, runs CI and merges.
 * - `prepare` (`AUTO_RELEASE_PREPARE=true`): additionally opens the Release-As PR and dispatches CI for bot PRs.
 * - `full` (`AUTO_RELEASE_MERGE=true`, implies prepare): additionally enables squash auto-merge on those PRs.
 */
export function releaseMode({ autoReleasePrepare, autoReleaseMerge } = {}) {
  if (isFullAutoMerge(autoReleaseMerge)) return 'full';
  if (autoReleasePrepare === 'true') return 'prepare';
  return 'safe';
}

/**
 * Repository permission of the event actor, failing closed: an invalid login (including `[bot]` accounts), a missing
 * collaborator record or any lookup error yields `none`. `lookup(login)` returns the collaborator permission response.
 */
export async function resolveActorPermission(actor, lookup) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(actor)) {
    return { permission: 'none', reason: 'actor is not a user login' };
  }
  try {
    const result = await lookup(actor);
    const role = result?.role_name ?? result?.permission;
    return typeof role === 'string' && role !== ''
      ? { permission: role, reason: 'looked up' }
      : { permission: 'none', reason: 'no permission record' };
  } catch (error) {
    return { permission: 'none', reason: `permission lookup failed: ${safeLog(error?.message ?? error)}` };
  }
}

/**
 * Whether an event may start the write-capable release job. Schedule, manual dispatch (write access required) and
 * milestone events (write access required) are trusted. Issue and pull request events from the public only count when
 * a milestone is involved (or the `release:hold` label was added) and the actor has write, maintain or admin
 * permission; everything else waits for the schedule. `needsPermission` asks the caller to look the actor up and call
 * again.
 */
export function eventGate({ eventName, action, label, itemMilestone, eventMilestone, actorPermission }) {
  if (TRUSTED_EVENTS.includes(eventName)) {
    return { proceed: true, needsPermission: false, reason: `${eventName} events are trusted` };
  }
  if (eventName !== 'issues' && eventName !== 'pull_request_target') {
    return { proceed: false, needsPermission: false, reason: `unexpected event ${eventName}` };
  }
  const present = (value) => typeof value === 'string' ? value.trim() !== '' : value != null;
  // Adding the hold label should withdraw bot auto-merge promptly instead of waiting for the schedule.
  const holdAdded = eventName === 'pull_request_target' && action === 'labeled' && label === HOLD_LABEL;
  if (!holdAdded && !present(itemMilestone) && !present(eventMilestone)) {
    return { proceed: false, needsPermission: false, reason: 'no milestone involved' };
  }
  if (actorPermission == null) {
    return { proceed: false, needsPermission: true, reason: 'actor permission unknown' };
  }
  if (!WRITE_ROLES.includes(actorPermission)) {
    return { proceed: false, needsPermission: false, reason: 'actor has no write access; the schedule re-evaluates' };
  }
  return { proceed: true, needsPermission: false, reason: `actor has ${actorPermission} access` };
}

/**
 * Same-repository issue numbers referenced with a GitHub closing keyword (`Closes #12`, `fixes owner/repo#3`,
 * `resolves https://github.com/owner/repo/issues/4`). References to other repositories are ignored.
 */
export function parseClosingReferences(body, repository, limit = 10) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const repo = repository.toLowerCase();
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/)|(?:([\w.-]+\/[\w.-]+))?#)(\d+)\b/gi;
  const numbers = [];
  for (const match of body.slice(0, 65_536).matchAll(pattern)) {
    const target = (match[1] ?? match[2] ?? repository).toLowerCase();
    if (target !== repo) continue;
    const number = Number(match[3]);
    if (Number.isSafeInteger(number) && number > 0 && !numbers.includes(number)) numbers.push(number);
    if (numbers.length >= limit) break;
  }
  return numbers;
}

/**
 * Milestone for a pull request without one: the lowest open `vX.Y` milestone that a `milestone:vX.Y` label or a closing
 * reference to an issue in that milestone points at. Returns null when nothing indicates a milestone.
 */
export function pickMilestoneForPr({ pr, openMilestones, referencedIssueMilestoneNumbers = [] }) {
  if (pr.milestone || isAutomationBranch(pr.headRef)) return null;
  const candidates = releaseMilestones(openMilestones);
  const labelKeys = new Set(
    (pr.labels ?? [])
      .map((label) => label.toLowerCase())
      .filter((label) => label.startsWith(MILESTONE_LABEL_PREFIX))
      .map((label) => label.slice(MILESTONE_LABEL_PREFIX.length).trim()),
  );
  const referenced = new Set(referencedIssueMilestoneNumbers);
  const match = candidates.find(
    ({ milestone, parsed }) => labelKeys.has(parsed.key) || referenced.has(milestone.number),
  );
  return match ? match.milestone : null;
}

/**
 * CI must be requested for bot-created PRs: their `pull_request` runs wait for approval (`action_required`) and never
 * report the required check. Dispatch runs by branch name, so the branch tip is re-read right before dispatching and a
 * moved branch aborts (the next run re-evaluates). Only runs for the evaluated head SHA count. Failed or running CI is
 * never re-dispatched automatically.
 * Returns 'requested' | 'stale-head' | 'dispatch'.
 */
export function ciDispatchDecision({ headSha, branchTipSha, checkRuns = [], workflowRuns = [] }) {
  if (checkRuns.some((run) => run.name === CI_CHECK_NAME && run.head_sha === headSha)) return 'requested';
  const dispatched = workflowRuns.some(
    (run) =>
      run.head_sha === headSha &&
      run.event === 'workflow_dispatch' &&
      !(run.status === 'completed' && run.conclusion === 'cancelled'),
  );
  if (dispatched) return 'requested';
  if (!headSha || branchTipSha !== headSha) return 'stale-head';
  return 'dispatch';
}

/** The latest required check run for exactly this head SHA succeeded. */
export function requiredCheckSatisfied(checkRuns = [], headSha) {
  const latest = checkRuns
    .filter((run) => run.name === CI_CHECK_NAME && run.head_sha === headSha)
    .sort((a, b) => b.id - a.id)[0];
  return Boolean(latest && latest.status === 'completed' && latest.conclusion === 'success');
}

export function milestoneMarker(parsed) {
  return `<!-- milestone-release:${parsed.key} -->`;
}

export function readyMarker(parsed) {
  return `<!-- milestone-release:ready:${parsed.key} -->`;
}

export function retargetMarker(parsed) {
  return `<!-- milestone-release:retarget:${parsed.key} -->`;
}

/** One-time comment on the release PR once it targets the milestone version (safe and prepare mode). */
export function readyCommentBody(parsed, milestoneUrl, mode) {
  const ci =
    mode === 'safe'
      ? 'Safe mode does not run CI for bot pull requests: if the required check `Typecheck and test` is waiting, approve the pending workflow runs on this PR or run the CI workflow on its branch, then merge once it passes.'
      : 'CI was requested for its head commit; merge once the required checks pass. Set `AUTO_RELEASE_MERGE=true` for automatic merging.';
  return [
    readyMarker(parsed),
    `Milestone [${parsed.key}](${milestoneUrl}) is complete and this PR targets ${parsed.version}, so it is ready for a maintainer to merge.`,
    '',
    ci,
  ].join('\n');
}

/** One-time safe-mode comment on the release PR explaining how a maintainer retargets it to the milestone version. */
export function retargetCommentBody(parsed, milestoneUrl, prVersion) {
  const branch = `chore/release-as-${parsed.version}`;
  return [
    retargetMarker(parsed),
    `Milestone [${parsed.key}](${milestoneUrl}) is complete, but this release PR targets ${prVersion ?? 'another version'} instead of ${parsed.version}.`,
    '',
    `Safe mode does not open pull requests. To retarget, merge a commit with a \`Release-As: ${parsed.version}\` footer into the default branch, for example:`,
    '',
    '```sh',
    `git switch -c ${branch} origin/main`,
    `git commit --allow-empty -m "chore(release): release ${parsed.version} for milestone ${parsed.key}" -m "Release-As: ${parsed.version}"`,
    `git push -u origin ${branch}`,
    '```',
    '',
    `Open a pull request from \`${branch}\` and squash-merge it with the \`Release-As: ${parsed.version}\` line kept in the commit message; release-please then updates this PR. Set \`AUTO_RELEASE_PREPARE=true\` to let the workflow open that pull request instead.`,
  ].join('\n');
}

/** Release notes stay release-please's changelog; the milestone link is appended once. */
export function releaseNotesWithMilestone(body, parsed, milestoneUrl) {
  const marker = milestoneMarker(parsed);
  const current = body ?? '';
  if (current.includes(marker)) return null;
  return `${current.trimEnd()}\n\n${marker}\n**Milestone:** [${parsed.key}](${milestoneUrl})\n`;
}

export function releaseAsCommitMessage(parsed) {
  return `chore(release): release ${parsed.version} for milestone ${parsed.key}\n\nRelease-As: ${parsed.version}\n`;
}

export function releaseAsBranch(parsed) {
  return `${RELEASE_AS_BRANCH_PREFIX}${parsed.tag}`;
}

function botAutoMerge(pr) {
  return Boolean(pr?.autoMerge && pr.autoMerge.enabledBy === BOT_LOGIN);
}

/**
 * Plan for the lowest open release milestone.
 *
 * state = {
 *   milestone: { number, title, state, open_issues, closed_issues, html_url },
 *   currentVersion: manifest version on the default branch,
 *   release: published release for the milestone tag or null,
 *   releasePr: open release-please PR
 *     { number, title, labels, autoMerge: { enabledBy } | null, readyCommented, retargetCommented } or null,
 *   ciSatisfied: required check passed for the release PR head SHA,
 *   mergedReleasePr: merged release PR for the milestone version { number, commented } or null,
 *   releaseAsPr: PR from the release-as branch { number, state, merged, autoMerge } or null,
 *   autoRelease: value of the AUTO_RELEASE variable (global pause),
 *   autoReleasePrepare: value of the AUTO_RELEASE_PREPARE variable (prepare mode only when exactly 'true'),
 *   autoReleaseMerge: value of the AUTO_RELEASE_MERGE variable (full mode only when exactly 'true'),
 * }
 * Returns { status, reason, mode, actions: [{ type, ... }] }. Only full mode ever returns enable-* actions and only
 * prepare and full mode return open-release-as-pr.
 */
export function planMilestone(state) {
  const mode = releaseMode(state);
  const result = planForMode(state, mode);
  return { ...result, mode };
}

function planForMode(state, mode) {
  const { milestone, currentVersion, release, releasePr, mergedReleasePr, releaseAsPr, autoRelease } = state;
  const fullAuto = mode === 'full';
  const parsed = parseMilestoneVersion(milestone.title);
  if (!parsed) return { status: 'ignored', reason: 'not a vX.Y release milestone', actions: [] };
  if (milestone.state !== 'open') return { status: 'ignored', reason: 'milestone is closed', actions: [] };

  // Withdrawing auto-merge that this workflow enabled is allowed in every mode and while paused: it only ever makes
  // the automation do less. Auto-merge enabled by a human is never touched.
  const disableBotAutoMerge = botAutoMerge(releasePr) ? [{ type: 'disable-auto-merge', pr: releasePr.number }] : [];
  const disableReleaseAsAutoMerge =
    releaseAsPr?.state === 'open' && botAutoMerge(releaseAsPr)
      ? [{ type: 'disable-release-as-auto-merge', pr: releaseAsPr.number }]
      : [];
  const withdrawAll = [...disableBotAutoMerge, ...disableReleaseAsAutoMerge];

  // The pause wins over everything else, including finishing an already published release.
  const hold = holdReason({ autoRelease, releasePrLabels: releasePr?.labels ?? [] });
  if (hold) return { status: 'held', reason: hold, actions: withdrawAll };

  if (release && !release.draft) {
    if (milestone.open_issues > 0) {
      return {
        status: 'blocked',
        reason: `${parsed.tag} is already released but the milestone still has ${milestone.open_issues} open item(s); move or close them`,
        actions: [],
      };
    }
    const actions = [];
    if (releaseNotesWithMilestone(release.body, parsed, milestone.html_url) !== null) {
      actions.push({ type: 'annotate-release', releaseId: release.id });
    }
    if (mergedReleasePr && !mergedReleasePr.commented) {
      actions.push({ type: 'comment-release-pr', pr: mergedReleasePr.number });
    }
    actions.push({ type: 'close-milestone', milestone: milestone.number });
    return { status: 'released', reason: `${parsed.tag} is published`, actions };
  }

  if (!isMilestoneComplete(milestone)) {
    const reason =
      milestone.closed_issues === 0 ? 'milestone has no closed items yet' : `${milestone.open_issues} open item(s) left`;
    return { status: 'waiting', reason, actions: withdrawAll };
  }

  if (compareVersions(parsed.version, currentVersion) <= 0) {
    return {
      status: 'blocked',
      reason: `milestone version ${parsed.version} is not newer than the current release ${currentVersion}; rename the milestone`,
      actions: withdrawAll,
    };
  }

  if (!releasePr) {
    return {
      status: 'waiting',
      reason: 'no open release PR yet (nothing releasable since the last release)',
      actions: disableReleaseAsAutoMerge,
    };
  }

  const prVersion = parseReleasePrVersion(releasePr.title);
  if (prVersion === parsed.version) {
    if (!fullAuto) {
      const actions = [...withdrawAll];
      if (!releasePr.readyCommented) actions.push({ type: 'comment-release-ready', pr: releasePr.number });
      return {
        status: state.ciSatisfied ? 'ready' : 'awaiting-ci',
        reason: `${mode} mode: release PR targets ${parsed.version} and waits for a maintainer to merge it`,
        actions,
      };
    }
    const actions = releasePr.autoMerge ? [] : [{ type: 'enable-auto-merge', pr: releasePr.number }];
    return { status: 'releasing', reason: `release PR targets ${parsed.version}; merges once required checks pass`, actions };
  }

  if (releaseAsPr?.merged) {
    return {
      status: 'blocked',
      reason: `Release-As ${parsed.version} was merged but the release PR still targets ${prVersion ?? 'an unknown version'}; needs a human`,
      actions: disableBotAutoMerge,
    };
  }
  if (releaseAsPr && releaseAsPr.state === 'closed') {
    return {
      status: 'blocked',
      reason: `the Release-As PR #${releaseAsPr.number} was closed without merging; a human decided against it`,
      actions: disableBotAutoMerge,
    };
  }
  if (releaseAsPr) {
    const actions = [...disableBotAutoMerge];
    if (fullAuto && !releaseAsPr.autoMerge) actions.push({ type: 'enable-release-as-auto-merge', pr: releaseAsPr.number });
    if (!fullAuto) actions.push(...disableReleaseAsAutoMerge);
    const reason = fullAuto
      ? `waiting for Release-As PR #${releaseAsPr.number}`
      : `${mode} mode: Release-As PR #${releaseAsPr.number} waits for a maintainer to merge it`;
    return { status: 'retargeting', reason, actions };
  }
  if (mode === 'safe') {
    const actions = [...disableBotAutoMerge];
    if (!releasePr.retargetCommented) actions.push({ type: 'comment-retarget-instructions', pr: releasePr.number });
    return {
      status: 'needs-retarget',
      reason: `safe mode: release PR targets ${prVersion ?? 'an unknown version'}; a maintainer merges a Release-As ${parsed.version} commit`,
      actions,
    };
  }
  return {
    status: 'retargeting',
    reason: `release PR targets ${prVersion ?? 'an unknown version'}; requesting Release-As ${parsed.version}`,
    actions: [...disableBotAutoMerge, { type: 'open-release-as-pr', autoMerge: fullAuto }],
  };
}

/** Only PRs opened by this workflow's own bot from this repository are ever auto-merged; titles alone prove nothing. */
export function isTrustedAutomationPr(pr, repository) {
  return (
    pr?.user?.login === BOT_LOGIN &&
    typeof pr?.head?.repo?.full_name === 'string' &&
    pr.head.repo.full_name.toLowerCase() === repository.toLowerCase()
  );
}

export function normalizePr(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: Boolean(pr.merged_at),
    labels: (pr.labels ?? []).map((label) => label.name),
    autoMerge: pr.auto_merge ? { enabledBy: pr.auto_merge.enabled_by?.login ?? null } : null,
    nodeId: pr.node_id,
    headRef: pr.head?.ref,
    headSha: pr.head?.sha,
  };
}

/** The open release-please PR (bot-authored, same repository, `autorelease: pending`, parseable title). */
export function selectReleasePr(pulls, repository) {
  const pr = pulls.find(
    (p) =>
      p.state === 'open' &&
      isTrustedAutomationPr(p, repository) &&
      p.head.ref.startsWith(RELEASE_BRANCH_PREFIX) &&
      (p.labels ?? []).some((label) => label.name === 'autorelease: pending') &&
      parseReleasePrVersion(p.title) !== null,
  );
  return pr ? normalizePr(pr) : null;
}

/** The merged release-please PR that produced the milestone's version. */
export function selectMergedReleasePr(pulls, parsed, repository) {
  const pr = pulls.find(
    (p) =>
      p.merged_at &&
      isTrustedAutomationPr(p, repository) &&
      p.head.ref.startsWith(RELEASE_BRANCH_PREFIX) &&
      parseReleasePrVersion(p.title) === parsed.version,
  );
  return pr ? normalizePr(pr) : null;
}

/** The Release-As PR for the milestone: an open one wins, otherwise the most recent closed one. */
export function selectReleaseAsPr(pulls, parsed, repository) {
  const branch = releaseAsBranch(parsed);
  const matches = pulls
    .filter((p) => isTrustedAutomationPr(p, repository) && p.head.ref === branch)
    .sort((a, b) => b.number - a.number);
  const pr = matches.find((p) => p.state === 'open') ?? matches[0];
  return pr ? normalizePr(pr) : null;
}

/** Neutralises workflow commands and line breaks before untrusted text reaches the log. */
export function safeLog(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/::/g, ': :').slice(0, 300);
}
