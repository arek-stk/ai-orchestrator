// Pure decision logic for milestone-driven releases (ADR-012 addendum). No IO: every GitHub fact is passed in, every
// side effect is returned as a plan, so the rules can be unit tested and re-evaluated safely on every run.

export const RELEASE_BRANCH_PREFIX = 'release-please--';
export const RELEASE_AS_BRANCH_PREFIX = 'release-as/';
export const HOLD_LABEL = 'release:hold';
export const MILESTONE_LABEL_PREFIX = 'milestone:';
export const CI_CHECK_NAME = 'Typecheck and test';
export const BOT_LOGIN = 'github-actions[bot]';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

/** Pause switches: repository variable `AUTO_RELEASE=false` or the `release:hold` label on the release PR. */
export function holdReason({ autoRelease, releasePrLabels = [] }) {
  if (typeof autoRelease === 'string' && autoRelease.trim().toLowerCase() === 'false') {
    return 'repository variable AUTO_RELEASE is false';
  }
  if (releasePrLabels.includes(HOLD_LABEL)) return `release PR has the ${HOLD_LABEL} label`;
  return null;
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
 * report the required check. Dispatch once per commit; failed or running CI is never re-dispatched automatically.
 */
export function needsCiDispatch({ checkRuns = [], workflowRuns = [] }) {
  if (checkRuns.some((run) => run.name === CI_CHECK_NAME)) return false;
  return !workflowRuns.some(
    (run) => run.event === 'workflow_dispatch' && !(run.status === 'completed' && run.conclusion === 'cancelled'),
  );
}

export function milestoneMarker(parsed) {
  return `<!-- milestone-release:${parsed.key} -->`;
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
 *   releasePr: open release-please PR { number, title, labels, autoMerge: { enabledBy } | null } or null,
 *   mergedReleasePr: merged release PR for the milestone version { number, commented } or null,
 *   releaseAsPr: PR from the release-as branch { number, state, merged, autoMerge } or null,
 *   autoRelease: value of the AUTO_RELEASE variable,
 * }
 * Returns { status, reason, actions: [{ type, ... }] }.
 */
export function planMilestone(state) {
  const { milestone, currentVersion, release, releasePr, mergedReleasePr, releaseAsPr, autoRelease } = state;
  const parsed = parseMilestoneVersion(milestone.title);
  if (!parsed) return { status: 'ignored', reason: 'not a vX.Y release milestone', actions: [] };
  if (milestone.state !== 'open') return { status: 'ignored', reason: 'milestone is closed', actions: [] };

  const disableBotAutoMerge = botAutoMerge(releasePr) ? [{ type: 'disable-auto-merge', pr: releasePr.number }] : [];

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
    return { status: 'waiting', reason, actions: disableBotAutoMerge };
  }

  if (compareVersions(parsed.version, currentVersion) <= 0) {
    return {
      status: 'blocked',
      reason: `milestone version ${parsed.version} is not newer than the current release ${currentVersion}; rename the milestone`,
      actions: disableBotAutoMerge,
    };
  }

  const hold = holdReason({ autoRelease, releasePrLabels: releasePr?.labels ?? [] });
  if (hold) return { status: 'held', reason: hold, actions: disableBotAutoMerge };

  if (!releasePr) {
    return { status: 'waiting', reason: 'no open release PR yet (nothing releasable since the last release)', actions: [] };
  }

  const prVersion = parseReleasePrVersion(releasePr.title);
  if (prVersion === parsed.version) {
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
    if (!releaseAsPr.autoMerge) actions.push({ type: 'enable-release-as-auto-merge', pr: releaseAsPr.number });
    return { status: 'retargeting', reason: `waiting for Release-As PR #${releaseAsPr.number}`, actions };
  }
  return {
    status: 'retargeting',
    reason: `release PR targets ${prVersion ?? 'an unknown version'}; requesting Release-As ${parsed.version}`,
    actions: [...disableBotAutoMerge, { type: 'open-release-as-pr' }],
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
