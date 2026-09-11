import { expect, test } from 'bun:test';
import { retryDelayMs } from './providers';

test('429 waits follow Retry-After, then the message, then a default', () => {
  expect(retryDelayMs(new Headers({ 'retry-after': '3' }), '')).toBe(3_250);
  expect(retryDelayMs(new Headers(), 'Please try again in 14.1525s. Need more tokens?')).toBe(14_403);
  expect(retryDelayMs(new Headers(), 'Please try again in 1m2.5s')).toBe(62_750);
  expect(retryDelayMs(new Headers(), 'slow down')).toBe(5_000);
});
