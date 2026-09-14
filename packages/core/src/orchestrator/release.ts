import { detectGatedActions } from '../approval/policy';
import { AGENT_DEFINITIONS } from '../agents/definitions';
import { ReleaseReadinessOutputSchema, SecurityOutputSchema, type ReleaseCheckName, type ReleaseCheckStatus, type ReleaseReadinessOutput } from '../agents/schemas';
import type { Project } from '../domain/project';
import type { PipelineRun } from '../domain/run';
import { isPlanned, truncate } from './helpers';
import { agentCommon, baseInput, onAgentFailure, parseOutput, track, type StageContext, type StageOutcome } from './stages';

export interface ReleaseCheck {
  name: ReleaseCheckName;
  status: ReleaseCheckStatus;
  detail: string;
}

const check = (name: ReleaseCheckName, status: ReleaseCheckStatus, detail: string): ReleaseCheck => ({ name, status, detail });

/** Release checks that need no model (spec §5 release readiness). A failing check blocks the release by itself. */
export function deterministicReleaseChecks(run: PipelineRun, project: Pick<Project, 'profile'>): ReleaseCheck[] {
  const cp = run.checkpoint;
  const verification = cp.verification;
  const checks: ReleaseCheck[] = [];

  if (verification?.status === 'passed') checks.push(check('tests', 'pass', `${verification.source}: ${verification.summary}`));
  else if (verification?.status === 'failed') checks.push(check('tests', 'fail', verification.summary));
  else checks.push(check('tests', 'warn', 'Tests were not executed before the release.'));

  if (isPlanned(run.stagePlan, 'SECURITY')) {
    const audit = parseOutput(SecurityOutputSchema, cp.outputs.security);
    checks.push(audit?.verdict === 'pass' ? check('security', 'pass', 'Security audit passed.') : check('security', 'fail', 'Security audit has not passed.'));
  } else {
    checks.push(check('security', 'skipped', 'No security-relevant surface in the change.'));
  }

  const gates = detectGatedActions(cp.changeset, { criticalPaths: project.profile.criticalPaths });
  const destructive = gates.find((g) => g.action === 'destructive_data');
  const migration = gates.find((g) => g.action === 'database_migration');
  if (destructive) {
    const approved = cp.approvedActions.includes('destructive_data');
    checks.push(check('migrations', approved ? 'warn' : 'fail', `${destructive.reason}${approved ? ' (approved)' : ''}: ${destructive.paths.slice(0, 5).join(', ')}`));
  } else if (migration) {
    const approved = cp.approvedActions.includes('database_migration');
    checks.push(check('migrations', approved ? 'pass' : 'warn', `${approved ? 'Approved migration' : 'Unapproved migration'}: ${migration.paths.slice(0, 5).join(', ')}`));
  } else {
    checks.push(check('migrations', 'skipped', 'No migrations in the change set.'));
  }

  const paths = cp.changeset.map((c) => c.path);
  checks.push(
    paths.some((p) => /(^|\/)(CHANGELOG|CHANGES)(\.[a-z]+)?$/i.test(p))
      ? check('changelog', 'pass', 'Changelog updated in the change set.')
      : check('changelog', 'warn', 'No changelog entry in the change set.'),
  );
  const versioned = cp.changeset.find((c) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml)$/.test(c.path) && /\bversion\b/.test(c.content ?? ''));
  checks.push(versioned ? check('version', 'pass', `Version declared in ${versioned.path}.`) : check('version', 'warn', 'No version bump in the change set.'));

  if (isPlanned(run.stagePlan, 'CI')) {
    checks.push(verification?.source === 'ci' && verification.status === 'passed' ? check('ci', 'pass', 'CI checks passed.') : check('ci', 'fail', 'CI has not passed for the release commit.'));
  } else {
    checks.push(check('ci', 'skipped', 'Project has no CI configured.'));
  }
  return checks;
}

async function record(ctx: StageContext, readiness: ReleaseReadinessOutput): Promise<void> {
  ctx.run.checkpoint.outputs.release = readiness;
  await ctx.deps.events.emit({
    type: 'release.readiness',
    projectId: ctx.project.id,
    taskId: ctx.task.id,
    runId: ctx.run.id,
    payload: { verdict: readiness.verdict, blockers: readiness.blockers.slice(0, 10) },
  });
}

/**
 * Release readiness gate before DEPLOY: deterministic checks first (a failure blocks without a model call), then the
 * release agent. Returns null when the release may proceed to the deploy approval.
 */
export async function releaseReadiness(ctx: StageContext): Promise<StageOutcome | null> {
  const cp = ctx.run.checkpoint;
  if (parseOutput(ReleaseReadinessOutputSchema, cp.outputs.release)?.verdict === 'ready') return null;

  const checks = deterministicReleaseChecks(ctx.run, ctx.project);
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length > 0) {
    const blockers = failed.map((c) => `${c.name}: ${c.detail}`);
    await record(ctx, { verdict: 'not_ready', summary: 'Deterministic release checks failed.', checks, blockers, confidence: 1 });
    return { kind: 'blocked', reason: truncate(`Release readiness failed: ${blockers.join('; ')}`, 2000) };
  }

  const outcome = await ctx.deps.runtime.run({
    ...agentCommon(ctx),
    definition: AGENT_DEFINITIONS.release_readiness,
    input: baseInput(ctx, [
      { title: 'Deterministic release checks (authoritative)', body: checks.map((c) => `- ${c.name}: ${c.status} (${c.detail})`).join('\n') },
      { title: 'Change set', body: cp.changeset.map((c) => `- ${c.action} ${c.path}`).join('\n') || '(empty)' },
      { title: 'Pull request', body: cp.prNumber ? `#${cp.prNumber} ${cp.prUrl ?? ''}` : '(none)' },
    ]),
  });
  track(ctx, outcome);
  if (!outcome.ok) return onAgentFailure(ctx, outcome);

  await record(ctx, outcome.output);
  if (outcome.output.verdict === 'not_ready') {
    return { kind: 'blocked', reason: truncate(`Release readiness: ${outcome.output.blockers.join('; ')}`, 2000) };
  }
  return null;
}
