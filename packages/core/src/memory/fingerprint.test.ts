import { describe, expect, it } from 'vitest';
import { failureFingerprint, normalizeFailure } from './fingerprint';

describe('failure fingerprint', () => {
  const runA = `2026-09-14T10:00:01.123Z FAIL src/cart.test.ts (412 ms)
  ● cart › applies discount
    AssertionError: expected 90 to equal 81
      at /home/runner/work/shop/src/cart.test.ts:42:17`;
  const runB = `2026-09-15T08:12:44.001Z FAIL src/cart.test.ts (38 ms)
  ● cart › applies discount
    AssertionError: expected 90 to equal 81
      at D:\\a\\shop\\src\\cart.test.ts:43:9`;

  it('is identical for the same failure across runs and machines', () => {
    expect(failureFingerprint(runA)).toBe(failureFingerprint(runB));
  });

  it('differs for different failures', () => {
    expect(failureFingerprint(runA)).not.toBe(failureFingerprint('error TS2345: Argument of type string is not assignable'));
  });

  it('keeps compiler error codes', () => {
    expect(normalizeFailure('src/a.ts(3,5): error TS2345: bad')).toContain('TS2345');
  });
});
