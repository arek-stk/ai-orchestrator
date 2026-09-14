import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubUnavailableError } from '@orch/core';
import { aggregateChecks, OctokitGitHub } from './octokit';
import { parseGitHubWebhook, verifyGitHubSignature } from './webhooks';

const repo = { owner: 'acme', name: 'shop' };
const sha = (c: string) => c.repeat(40);

let server: Server;
let github: OctokitGitHub;
const requests: Array<{ method: string; url: string; body: any }> = [];

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : null));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    // Octokit percent-encodes path parameters such as refs ("heads%2Fmain"), like GitHub expects.
    const url = decodeURIComponent(req.url ?? '');
    requests.push({ method: req.method ?? '', url, body });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const r = `/repos/acme/shop`;
    if (req.method === 'GET' && url === `${r}/git/ref/heads/main`) return json(200, { ref: 'refs/heads/main', object: { sha: sha('a'), type: 'commit' } });
    if (req.method === 'GET' && url === `${r}/git/ref/heads/missing`) return json(404, { message: 'Not Found' });
    if (req.method === 'GET' && url === `${r}/git/ref/heads/limited`) return json(429, { message: 'rate limited' }, { 'retry-after': '30' });
    if (req.method === 'GET' && url.startsWith(`${r}/git/commits/`)) return json(200, { sha: url.split('/').pop(), tree: { sha: sha('t') } });
    if (req.method === 'POST' && url === `${r}/git/blobs`) return json(201, { sha: sha('b') });
    if (req.method === 'POST' && url === `${r}/git/trees`) return json(201, { sha: sha('n') });
    if (req.method === 'POST' && url === `${r}/git/commits`) return json(201, { sha: sha('c') });
    if (req.method === 'PATCH' && url === `${r}/git/refs/heads/orchestrator/tsk-1`) return json(200, { ref: 'refs/heads/orchestrator/tsk-1', object: { sha: body.sha } });
    if (req.method === 'GET' && url.startsWith(`${r}/pulls?`)) return json(200, []);
    if (req.method === 'POST' && url === `${r}/pulls`) return json(201, { number: 5, html_url: 'https://github.com/acme/shop/pull/5' });
    if (req.method === 'GET' && url.startsWith(`${r}/git/ref/heads/broken`)) return json(503, { message: 'unavailable' });
    return json(404, { message: `unhandled ${req.method} ${url}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  github = new OctokitGitHub({ token: 'test-token', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, retries: 0 });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('OctokitGitHub', () => {
  it('resolves branches and returns null for missing ones', async () => {
    expect(await github.getBranchSha(repo, 'main')).toBe(sha('a'));
    expect(await github.getBranchSha(repo, 'missing')).toBeNull();
  });

  it('builds commits through the Git Data API without force-pushing', async () => {
    requests.length = 0;
    const commit = await github.createCommit(repo, {
      parentSha: sha('a'),
      message: 'feat: search',
      changes: [
        { path: 'src/search.ts', action: 'create', content: 'export const search = 1;' },
        { path: 'src/legacy.ts', action: 'delete' },
      ],
    });
    expect(commit).toBe(sha('c'));
    await github.updateBranch(repo, 'orchestrator/tsk-1', commit);

    const blob = requests.find((r) => r.url.endsWith('/git/blobs'))!;
    expect(Buffer.from(blob.body.content, 'base64').toString('utf8')).toBe('export const search = 1;');
    const tree = requests.find((r) => r.url.endsWith('/git/trees'))!;
    expect(tree.body.base_tree).toBe(sha('t'));
    expect(tree.body.tree).toEqual([
      { path: 'src/search.ts', mode: '100644', type: 'blob', sha: sha('b') },
      { path: 'src/legacy.ts', mode: '100644', type: 'blob', sha: null },
    ]);
    expect(requests.find((r) => r.url.endsWith('/git/commits'))!.body.parents).toEqual([sha('a')]);
    expect(requests.find((r) => r.method === 'PATCH')!.body).toEqual({ sha: sha('c'), force: false });
  });

  it('creates a pull request when none is open for the branch', async () => {
    const pr = await github.upsertPullRequest(repo, { head: 'orchestrator/tsk-1', base: 'main', title: 'Search', body: 'body' });
    expect(pr).toEqual({ number: 5, url: 'https://github.com/acme/shop/pull/5', created: true });
    expect(requests.find((r) => r.url.startsWith('/repos/acme/shop/pulls?'))!.url).toContain('head=acme:orchestrator/tsk-1');
  });

  it('maps rate limits and outages to GitHubUnavailableError so runs wait instead of failing', async () => {
    await expect(github.getBranchSha(repo, 'limited')).rejects.toMatchObject({ name: 'GitHubUnavailableError', retryAfterMs: 30_000 });
    await expect(github.getBranchSha(repo, 'broken')).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});

describe('aggregateChecks', () => {
  const done = (conclusion: string) => ({ name: 'ci', status: 'completed', conclusion });
  it('derives none / pending / success / failure', () => {
    expect(aggregateChecks([], []).state).toBe('none');
    expect(aggregateChecks([{ name: 'ci', status: 'in_progress', conclusion: null }], []).state).toBe('pending');
    expect(aggregateChecks([done('success'), done('skipped'), done('neutral')], []).state).toBe('success');
    expect(aggregateChecks([done('success')], [{ id: 9, status: 'completed', conclusion: 'failure' }])).toMatchObject({ state: 'failure', failedRunIds: [9] });
    expect(aggregateChecks([done('timed_out')], []).conclusion).toBe('timed_out');
  });
});

describe('webhooks', () => {
  const payload = JSON.stringify({ action: 'completed', repository: { name: 'shop', owner: { login: 'acme' } }, check_suite: { head_sha: sha('d') } });
  const signature = `sha256=${createHmac('sha256', 'hook-secret').update(payload).digest('hex')}`;

  it('verifies HMAC signatures in constant time', () => {
    expect(verifyGitHubSignature('hook-secret', payload, signature)).toBe(true);
    expect(verifyGitHubSignature('wrong-secret', payload, signature)).toBe(false);
    expect(verifyGitHubSignature('hook-secret', `${payload} `, signature)).toBe(false);
    expect(verifyGitHubSignature('hook-secret', payload, undefined)).toBe(false);
    expect(verifyGitHubSignature('', payload, signature)).toBe(false);
  });

  it('normalises relevant events and ignores the rest', () => {
    expect(parseGitHubWebhook('check_suite', JSON.parse(payload))).toEqual({ kind: 'ci_completed', repo, sha: sha('d') });
    expect(parseGitHubWebhook('push', { ref: 'refs/heads/main', after: sha('e'), repository: { name: 'shop', owner: { login: 'acme' } } })).toEqual({
      kind: 'push',
      repo,
      branch: 'main',
      sha: sha('e'),
    });
    expect(parseGitHubWebhook('check_suite', { action: 'requested' }).kind).toBe('ignored');
    expect(parseGitHubWebhook('issues', {}).kind).toBe('ignored');
  });
});
