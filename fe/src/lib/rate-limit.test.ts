import { beforeEach, expect, test } from 'bun:test';
import { hit, resetRateLimits } from './rate-limit';

beforeEach(resetRateLimits);

test('allows up to the limit, then reports when to retry', () => {
  const rl = { limit: 2, windowMs: 1_000 };
  expect(hit('u', rl, 0).ok).toBe(true);
  expect(hit('u', rl, 100).ok).toBe(true);
  // Oldest hit (t=0) leaves the window at t=1000, i.e. 800ms from now.
  expect(hit('u', rl, 200)).toEqual({ ok: false, retryAfterMs: 800 });
  // The first hit ages out of the window.
  expect(hit('u', rl, 1_000).ok).toBe(true);
});

test('keys are independent', () => {
  const rl = { limit: 1, windowMs: 1_000 };
  expect(hit('a', rl, 0).ok).toBe(true);
  expect(hit('b', rl, 0).ok).toBe(true);
  expect(hit('a', rl, 1).ok).toBe(false);
});
