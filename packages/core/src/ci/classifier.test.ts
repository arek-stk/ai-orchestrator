import { describe, expect, it } from 'vitest';
import { classifyCiFailure } from './classifier';

describe('classifyCiFailure', () => {
  it('classifies test failures as code failures', () => {
    const result = classifyCiFailure({
      conclusion: 'failure',
      jobs: [{ name: 'test', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }],
      logExcerpt: 'FAIL src/cart.test.ts\n  AssertionError: expected 90 to equal 81\nTests: 1 failed, 20 passed',
    });
    expect(result).toMatchObject({ kind: 'code', retryable: false });
    expect(result.signals).toContain('test_failure');
  });

  it('classifies a lost runner as infrastructure, retryable', () => {
    const result = classifyCiFailure({
      conclusion: 'failure',
      jobs: [],
      logExcerpt: 'The self-hosted runner lost communication with the server.',
    });
    expect(result).toMatchObject({ kind: 'infra', retryable: true, signals: ['runner_lost'] });
  });

  it('code signals win over incidental network noise', () => {
    const result = classifyCiFailure({
      conclusion: 'failure',
      jobs: [],
      logExcerpt: 'npm WARN ECONNRESET retrying\nsrc/index.ts(4,1): error TS2304: Cannot find name foo',
    });
    expect(result.kind).toBe('code');
  });

  it('treats failures confined to setup steps as infrastructure', () => {
    const result = classifyCiFailure({
      conclusion: 'failure',
      jobs: [{ name: 'build', conclusion: 'failure', steps: [{ name: 'Setup Node.js', conclusion: 'failure' }] }],
      logExcerpt: 'Process completed with exit code 1.',
    });
    expect(result).toMatchObject({ kind: 'infra', signals: ['setup_step_failure'] });
  });

  it('treats cancelled and timed out runs as infrastructure', () => {
    expect(classifyCiFailure({ conclusion: 'timed_out', jobs: [], logExcerpt: '' }).kind).toBe('infra');
  });

  it('returns unknown when there is no decisive signal', () => {
    expect(classifyCiFailure({ conclusion: 'failure', jobs: [], logExcerpt: 'exit code 1' })).toMatchObject({ kind: 'unknown', retryable: true });
  });
});
