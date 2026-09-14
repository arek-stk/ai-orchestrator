export interface CiJobStep {
  name: string;
  conclusion: string | null;
}

export interface CiJob {
  name: string;
  conclusion: string | null;
  steps?: CiJobStep[];
}

export interface CiFailureInput {
  /** Overall conclusion reported by the CI provider (e.g. GitHub check suite conclusion). */
  conclusion: string | null;
  jobs: readonly CiJob[];
  /** Tail of the failing job logs (already redacted). */
  logExcerpt: string;
}

export type CiFailureKind = 'infra' | 'code' | 'unknown';

export interface CiClassification {
  kind: CiFailureKind;
  /** Re-running CI without code changes is expected to help. */
  retryable: boolean;
  reason: string;
  signals: string[];
}

const CODE_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ['typescript_error', /error TS\d{3,5}/],
  ['test_failure', /\bFAIL\b\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?/],
  ['test_failure', /\b\d+\s+(?:failing|failed)\b/i],
  ['test_failure', /Tests?:\s+\d+ failed/],
  ['test_failure', /--- FAIL:|^FAILED\s|test result: FAILED/m],
  ['assertion', /AssertionError|Expected[:\s].*Received|expected .* to (?:equal|be|deeply equal)/],
  ['lint_error', /✖ \d+ problems?|\d+ errors? and \d+ warnings?/],
  ['runtime_error', /\b(?:SyntaxError|ReferenceError|TypeError): /],
  ['module_resolution', /Module not found|Cannot find module/],
  ['dependency_conflict', /ERESOLVE|peer dep(?:endency)? conflict/i],
  ['compile_error', /error\[E\d{4}\]|compilation failed|Build failed/i],
];

const INFRA_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ['runner_lost', /runner has received a shutdown signal|lost communication with the server|runner .* (?:lost|offline)/i],
  ['network', /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|getaddrinfo|Could not resolve host|npm ERR! network/i],
  ['rate_limit', /API rate limit exceeded|429 Too Many Requests|toomanyrequests|pull rate limit/i],
  ['disk_full', /No space left on device|ENOSPC/],
  ['upstream_unavailable', /\b50[234]\b.*(?:Bad Gateway|Service Unavailable|Gateway Timeout)/i],
  ['action_download', /Unable to (?:resolve|download) action/i],
  ['cancelled', /The operation was canceled|exceeded the maximum execution time/i],
];

const INFRA_CONCLUSIONS = new Set(['cancelled', 'startup_failure', 'timed_out', 'stale']);
const SETUP_STEP = /set ?up|checkout|cache|download|install (?:node|python|go|java)|login|runner|initialize containers|post /i;

/**
 * Distinguishes CI infrastructure failures from code failures (spec §32).
 * Code signals win because retrying a genuine failure only wastes time; infra failures must never
 * trigger the debug agent to change code.
 */
export function classifyCiFailure(input: CiFailureInput): CiClassification {
  const log = input.logExcerpt;
  const codeSignals = CODE_SIGNALS.filter(([, re]) => re.test(log)).map(([name]) => name);
  const infraSignals = INFRA_SIGNALS.filter(([, re]) => re.test(log)).map(([name]) => name);
  const uniq = (xs: string[]) => [...new Set(xs)];

  if (codeSignals.length > 0) {
    return { kind: 'code', retryable: false, reason: 'Failure output contains code-level errors.', signals: uniq(codeSignals) };
  }
  if (input.conclusion === 'action_required') {
    return { kind: 'infra', retryable: false, reason: 'Workflow requires manual approval to run.', signals: ['action_required'] };
  }
  if (infraSignals.length > 0) {
    return { kind: 'infra', retryable: true, reason: 'Failure output matches infrastructure problems.', signals: uniq(infraSignals) };
  }
  if (input.conclusion !== null && INFRA_CONCLUSIONS.has(input.conclusion)) {
    return { kind: 'infra', retryable: true, reason: `CI concluded "${input.conclusion}".`, signals: [input.conclusion] };
  }

  const failedSteps = input.jobs.flatMap((job) => (job.steps ?? []).filter((s) => s.conclusion === 'failure'));
  if (failedSteps.length > 0 && failedSteps.every((step) => SETUP_STEP.test(step.name))) {
    return {
      kind: 'infra',
      retryable: true,
      reason: `Only setup steps failed: ${failedSteps.map((s) => s.name).join(', ')}.`,
      signals: ['setup_step_failure'],
    };
  }

  return { kind: 'unknown', retryable: true, reason: 'No decisive signal; re-run once before treating as a code failure.', signals: [] };
}
