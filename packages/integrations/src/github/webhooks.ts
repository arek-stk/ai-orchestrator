import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RepoCoordinates } from '@orch/core';

/** Verifies `X-Hub-Signature-256` (HMAC-SHA256 over the raw body) in constant time. */
export function verifyGitHubSignature(secret: string, rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!secret || !signature || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export type GitHubWebhookEvent =
  | { kind: 'ci_completed'; repo: RepoCoordinates; sha: string }
  | { kind: 'pull_request_closed'; repo: RepoCoordinates; prNumber: number; merged: boolean }
  | { kind: 'push'; repo: RepoCoordinates; branch: string; sha: string }
  | { kind: 'ignored'; reason: string };

const Repository = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const Sha = z.string().regex(/^[0-9a-f]{40}$/i);

const CheckSuite = z.object({ action: z.literal('completed'), repository: Repository, check_suite: z.object({ head_sha: Sha }) });
const CheckRun = z.object({ action: z.literal('completed'), repository: Repository, check_run: z.object({ head_sha: Sha }) });
const WorkflowRun = z.object({ action: z.literal('completed'), repository: Repository, workflow_run: z.object({ head_sha: Sha }) });
const PullRequest = z.object({
  action: z.literal('closed'),
  repository: Repository,
  pull_request: z.object({ number: z.number().int(), merged: z.boolean().nullable() }),
});
const Push = z.object({ ref: z.string(), after: Sha, repository: Repository });

const repoOf = (repository: z.infer<typeof Repository>): RepoCoordinates => ({ owner: repository.owner.login, name: repository.name });

/**
 * Normalises the webhook events the orchestrator reacts to. Anything else is ignored explicitly, so the
 * endpoint can accept all events without trusting payload shapes it does not understand.
 */
export function parseGitHubWebhook(eventName: string, payload: unknown): GitHubWebhookEvent {
  switch (eventName) {
    case 'check_suite': {
      const parsed = CheckSuite.safeParse(payload);
      return parsed.success ? { kind: 'ci_completed', repo: repoOf(parsed.data.repository), sha: parsed.data.check_suite.head_sha } : ignored(eventName);
    }
    case 'check_run': {
      const parsed = CheckRun.safeParse(payload);
      return parsed.success ? { kind: 'ci_completed', repo: repoOf(parsed.data.repository), sha: parsed.data.check_run.head_sha } : ignored(eventName);
    }
    case 'workflow_run': {
      const parsed = WorkflowRun.safeParse(payload);
      return parsed.success ? { kind: 'ci_completed', repo: repoOf(parsed.data.repository), sha: parsed.data.workflow_run.head_sha } : ignored(eventName);
    }
    case 'pull_request': {
      const parsed = PullRequest.safeParse(payload);
      return parsed.success
        ? { kind: 'pull_request_closed', repo: repoOf(parsed.data.repository), prNumber: parsed.data.pull_request.number, merged: parsed.data.pull_request.merged === true }
        : ignored(eventName);
    }
    case 'push': {
      const parsed = Push.safeParse(payload);
      if (!parsed.success || !parsed.data.ref.startsWith('refs/heads/')) return ignored(eventName);
      return { kind: 'push', repo: repoOf(parsed.data.repository), branch: parsed.data.ref.slice('refs/heads/'.length), sha: parsed.data.after };
    }
    default:
      return { kind: 'ignored', reason: `event ${eventName} is not handled` };
  }
}

function ignored(eventName: string): GitHubWebhookEvent {
  return { kind: 'ignored', reason: `${eventName} action or payload not relevant` };
}
