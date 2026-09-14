import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations, executed directly by Node in the workflow.
import * as logic from './logic.mjs';

const REPO = 'arek-stk/ai-orchestrator';
const BOT = 'github-actions[bot]';

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'v0.4 — Health intelligence & dependency approval',
    state: 'open',
    open_issues: 0,
    closed_issues: 3,
    html_url: 'https://github.com/arek-stk/ai-orchestrator/milestone/1',
    ...overrides,
  };
}

function releasePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'chore(main): release 0.4.0',
    state: 'open',
    labels: ['autorelease: pending'],
    autoMerge: null,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return logic.planMilestone({
    milestone: milestone(),
    currentVersion: '0.3.0',
    release: null,
    releasePr: releasePr(),
    mergedReleasePr: null,
    releaseAsPr: null,
    autoRelease: undefined,
    ...overrides,
  });
}

function rawPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: 'chore(main): release 0.4.0',
    state: 'open',
    merged_at: null,
    user: { login: BOT },
    head: { ref: 'release-please--branches--main--components--ai-orchestrator', sha: 'abc', repo: { full_name: REPO } },
    labels: [{ name: 'autorelease: pending' }],
    auto_merge: null,
    node_id: 'PR_1',
    ...overrides,
  };
}

describe('version parsing', () => {
  it('parses vX.Y milestone titles and rejects everything else', () => {
    expect(logic.parseMilestoneVersion('v0.4 — Health intelligence & dependency approval')).toMatchObject({
      version: '0.4.0',
      tag: 'v0.4.0',
      key: 'v0.4',
    });
    expect(logic.parseMilestoneVersion('v1.10')?.version).toBe('1.10.0');
    expect(logic.parseMilestoneVersion('v0.4.1 — patch')).toBeNull();
    expect(logic.parseMilestoneVersion('v01.2 — leading zero')).toBeNull();
    expect(logic.parseMilestoneVersion('Backlog — proposed')).toBeNull();
    expect(logic.parseMilestoneVersion('v0.4-beta')).toBeNull();
    expect(logic.parseMilestoneVersion(undefined)).toBeNull();
  });

  it('parses release-please PR titles only', () => {
    expect(logic.parseReleasePrVersion('chore(main): release 0.3.0')).toBe('0.3.0');
    expect(logic.parseReleasePrVersion('chore: release 1.2.3')).toBe('1.2.3');
    expect(logic.parseReleasePrVersion('feat: release 1.0.0')).toBeNull();
    expect(logic.parseReleasePrVersion('chore(main): release 0.3.0; rm -rf')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(logic.compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(logic.compareVersions('0.4.0', '0.4.0')).toBe(0);
    expect(logic.compareVersions('0.3.9', '0.4.0')).toBe(-1);
    expect(() => logic.compareVersions('v1', '0.1.0')).toThrow();
  });

  it('orders open release milestones and skips the backlog and closed ones', () => {
    const ordered = logic.releaseMilestones([
      milestone({ number: 3, title: 'v0.10 — Later' }),
      milestone({ number: 4, title: 'Backlog — proposed' }),
      milestone({ number: 2, title: 'v0.5 — Project Room' }),
      milestone({ number: 5, title: 'v0.3 — Done', state: 'closed' }),
    ]);
    expect(ordered.map((entry: { milestone: { number: number } }) => entry.milestone.number)).toEqual([2, 3]);
  });
});

describe('closing references and milestone assignment', () => {
  it('finds same-repository closing references only', () => {
    const body = [
      'Closes #12, fixes: #13 and resolved https://github.com/arek-stk/ai-orchestrator/issues/14.',
      'Fixes other/repo#15, see #16, closes Arek-Stk/AI-Orchestrator#12 again.',
    ].join('\n');
    expect(logic.parseClosingReferences(body, REPO)).toEqual([12, 13, 14]);
    expect(logic.parseClosingReferences(null, REPO)).toEqual([]);
    expect(logic.parseClosingReferences('closes #1 closes #2 closes #3', REPO, 2)).toEqual([1, 2]);
  });

  const open = [
    milestone({ number: 2, title: 'v0.5 — Project Room', open_issues: 2 }),
    milestone({ number: 1, open_issues: 1 }),
    milestone({ number: 4, title: 'Backlog — proposed' }),
  ];

  it('assigns the lowest milestone indicated by a label or a closing reference', () => {
    const pr = { milestone: null, headRef: 'feat/x', labels: ['Milestone:v0.5'] };
    expect(logic.pickMilestoneForPr({ pr, openMilestones: open })?.number).toBe(2);
    expect(
      logic.pickMilestoneForPr({ pr, openMilestones: open, referencedIssueMilestoneNumbers: [1] })?.number,
    ).toBe(1);
  });

  it('leaves the milestone unset when nothing indicates one', () => {
    const pr = { milestone: null, headRef: 'feat/x', labels: ['core'] };
    expect(logic.pickMilestoneForPr({ pr, openMilestones: open, referencedIssueMilestoneNumbers: [4] })).toBeNull();
    expect(logic.pickMilestoneForPr({ pr: { ...pr, labels: ['milestone:v0.9'] }, openMilestones: open })).toBeNull();
  });

  it('never assigns PRs that already have a milestone or come from release automation', () => {
    const labels = ['milestone:v0.4'];
    expect(
      logic.pickMilestoneForPr({ pr: { milestone: { number: 2 }, headRef: 'feat/x', labels }, openMilestones: open }),
    ).toBeNull();
    expect(
      logic.pickMilestoneForPr({ pr: { milestone: null, headRef: 'release-as/v0.4.0', labels }, openMilestones: open }),
    ).toBeNull();
    expect(
      logic.pickMilestoneForPr({
        pr: { milestone: null, headRef: 'release-please--branches--main', labels },
        openMilestones: open,
      }),
    ).toBeNull();
  });
});

describe('CI dispatch and hold switches', () => {
  it('dispatches CI once per commit', () => {
    expect(logic.needsCiDispatch({ checkRuns: [], workflowRuns: [] })).toBe(true);
    expect(
      logic.needsCiDispatch({ workflowRuns: [{ event: 'pull_request', status: 'completed', conclusion: 'action_required' }] }),
    ).toBe(true);
    expect(logic.needsCiDispatch({ checkRuns: [{ name: 'Typecheck and test' }] })).toBe(false);
    expect(logic.needsCiDispatch({ workflowRuns: [{ event: 'workflow_dispatch', status: 'queued' }] })).toBe(false);
    expect(
      logic.needsCiDispatch({ workflowRuns: [{ event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' }] }),
    ).toBe(false);
    expect(
      logic.needsCiDispatch({
        workflowRuns: [{ event: 'workflow_dispatch', status: 'completed', conclusion: 'cancelled' }],
      }),
    ).toBe(true);
  });

  it('pauses on AUTO_RELEASE=false or the release:hold label', () => {
    expect(logic.holdReason({ autoRelease: ' FALSE ' })).toMatch(/AUTO_RELEASE/);
    expect(logic.holdReason({ autoRelease: '', releasePrLabels: ['release:hold'] })).toMatch(/release:hold/);
    expect(logic.holdReason({ autoRelease: 'true', releasePrLabels: [] })).toBeNull();
    expect(logic.holdReason({ autoRelease: undefined })).toBeNull();
  });
});

describe('trusted automation PRs', () => {
  it('selects only the bot-authored release PR from this repository', () => {
    const forged = rawPr({ number: 20, user: { login: 'mallory' } });
    const fork = rawPr({ number: 21, head: { ref: 'release-please--x', sha: 'f', repo: { full_name: 'mallory/fork' } } });
    const unlabeled = rawPr({ number: 22, labels: [] });
    expect(logic.selectReleasePr([forged, fork, unlabeled], REPO)).toBeNull();
    expect(logic.selectReleasePr([forged, rawPr()], REPO)).toMatchObject({ number: 10, headSha: 'abc', autoMerge: null });
  });

  it('normalises auto-merge ownership', () => {
    const pr = logic.normalizePr(rawPr({ auto_merge: { enabled_by: { login: 'arek-stk' } } }));
    expect(pr.autoMerge).toEqual({ enabledBy: 'arek-stk' });
  });

  it('prefers the open Release-As PR and finds the merged release PR by version', () => {
    const parsed = logic.parseMilestoneVersion('v0.4 — x');
    const head = { ref: 'release-as/v0.4.0', sha: 's', repo: { full_name: REPO } };
    const pulls = [
      rawPr({ number: 30, state: 'closed', head }),
      rawPr({ number: 31, state: 'open', head }),
      rawPr({ number: 32, state: 'closed', head, merged_at: '2026-01-01' }),
    ];
    expect(logic.selectReleaseAsPr(pulls, parsed, REPO)?.number).toBe(31);
    expect(logic.selectReleaseAsPr([pulls[0], pulls[2]], parsed, REPO)).toMatchObject({ number: 32, merged: true });
    const merged = rawPr({ number: 40, state: 'closed', merged_at: '2026-01-01' });
    expect(logic.selectMergedReleasePr([rawPr({ state: 'closed' }), merged], parsed, REPO)?.number).toBe(40);
  });
});

describe('planMilestone', () => {
  it('ignores non-release and closed milestones', () => {
    expect(plan({ milestone: milestone({ title: 'Backlog — proposed' }) }).status).toBe('ignored');
    expect(plan({ milestone: milestone({ state: 'closed' }) }).status).toBe('ignored');
  });

  it('waits while items are open or nothing is closed, withdrawing only its own auto-merge', () => {
    const botMerge = releasePr({ autoMerge: { enabledBy: BOT } });
    expect(plan({ milestone: milestone({ open_issues: 2 }), releasePr: botMerge })).toEqual({
      status: 'waiting',
      reason: '2 open item(s) left',
      actions: [{ type: 'disable-auto-merge', pr: 10 }],
    });
    const humanMerge = releasePr({ autoMerge: { enabledBy: 'arek-stk' } });
    expect(plan({ milestone: milestone({ open_issues: 1 }), releasePr: humanMerge }).actions).toEqual([]);
    expect(plan({ milestone: milestone({ closed_issues: 0 }) }).reason).toMatch(/no closed items/);
  });

  it('refuses milestone versions that are not newer than the current release', () => {
    expect(plan({ currentVersion: '0.4.0' })).toMatchObject({ status: 'blocked', actions: [] });
  });

  it('holds when paused', () => {
    expect(plan({ autoRelease: 'false' }).status).toBe('held');
    const held = plan({ releasePr: releasePr({ labels: ['autorelease: pending', 'release:hold'], autoMerge: { enabledBy: BOT } }) });
    expect(held).toMatchObject({ status: 'held', actions: [{ type: 'disable-auto-merge', pr: 10 }] });
  });

  it('waits for release-please when there is no release PR', () => {
    expect(plan({ releasePr: null })).toMatchObject({ status: 'waiting', actions: [] });
  });

  it('enables auto-merge once when the release PR already targets the milestone version', () => {
    expect(plan()).toMatchObject({ status: 'releasing', actions: [{ type: 'enable-auto-merge', pr: 10 }] });
    expect(plan({ releasePr: releasePr({ autoMerge: { enabledBy: 'arek-stk' } }) }).actions).toEqual([]);
  });

  it('retargets a release PR with another version through a single Release-As PR', () => {
    const other = releasePr({ title: 'chore(main): release 0.3.0' });
    expect(plan({ releasePr: other })).toMatchObject({ status: 'retargeting', actions: [{ type: 'open-release-as-pr' }] });
    expect(plan({ releasePr: other, releaseAsPr: { number: 17, state: 'open', merged: false, autoMerge: null } })).toMatchObject({
      status: 'retargeting',
      actions: [{ type: 'enable-release-as-auto-merge', pr: 17 }],
    });
    expect(
      plan({ releasePr: other, releaseAsPr: { number: 17, state: 'open', merged: false, autoMerge: { enabledBy: BOT } } })
        .actions,
    ).toEqual([]);
  });

  it('stops instead of looping when a Release-As PR was merged or vetoed', () => {
    const other = releasePr({ title: 'chore(main): release 0.3.0', autoMerge: { enabledBy: BOT } });
    expect(plan({ releasePr: other, releaseAsPr: { number: 17, state: 'closed', merged: true } })).toMatchObject({
      status: 'blocked',
      actions: [{ type: 'disable-auto-merge', pr: 10 }],
    });
    expect(plan({ releasePr: other, releaseAsPr: { number: 17, state: 'closed', merged: false } }).reason).toMatch(
      /closed without merging/,
    );
  });

  it('finishes a released milestone idempotently', () => {
    const release = { id: 5, draft: false, body: '## 0.4.0\n* feat', html_url: 'https://example.test/r' };
    expect(plan({ release, releasePr: null, mergedReleasePr: { number: 10, commented: false } })).toMatchObject({
      status: 'released',
      actions: [
        { type: 'annotate-release', releaseId: 5 },
        { type: 'comment-release-pr', pr: 10 },
        { type: 'close-milestone', milestone: 1 },
      ],
    });
    const parsed = logic.parseMilestoneVersion('v0.4 — x');
    const annotated = { ...release, body: logic.releaseNotesWithMilestone(release.body, parsed, 'https://m') };
    expect(plan({ release: annotated, mergedReleasePr: { number: 10, commented: true } }).actions).toEqual([
      { type: 'close-milestone', milestone: 1 },
    ]);
    expect(plan({ release, milestone: milestone({ open_issues: 1 }) }).status).toBe('blocked');
    expect(plan({ release: { ...release, draft: true }, releasePr: null }).status).toBe('waiting');
  });
});

describe('release notes and logging', () => {
  it('appends the milestone link once', () => {
    const parsed = logic.parseMilestoneVersion('v0.5 — Project Room');
    const once = logic.releaseNotesWithMilestone('## 0.5.0\n', parsed, 'https://github.com/o/r/milestone/2');
    expect(once).toContain('**Milestone:** [v0.5](https://github.com/o/r/milestone/2)');
    expect(logic.releaseNotesWithMilestone(once, parsed, 'https://github.com/o/r/milestone/2')).toBeNull();
    expect(logic.releaseAsCommitMessage(parsed)).toMatch(/\n\nRelease-As: 0\.5\.0\n$/);
    expect(logic.releaseAsBranch(parsed)).toBe('release-as/v0.5.0');
  });

  it('neutralises workflow commands in untrusted text', () => {
    expect(logic.safeLog('title\n::add-mask::x')).toBe('title : :add-mask: :x');
  });
});
