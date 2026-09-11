// Sliding-window rate limiter, in memory. Good for a single server process
// (local dev, one container); swap for a shared store (Redis/Upstash) before
// running more than one instance.

const windows = new Map<string, number[]>();
let lastSweep = 0;

export interface RateLimit {
  limit: number;
  windowMs: number;
}

// Records a hit for `key` and reports whether it is within the limit. When it
// isn't, `retryAfterMs` says when the oldest hit leaves the window.
export const hit = (
  key: string,
  { limit, windowMs }: RateLimit,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } => {
  sweep(now, windowMs);
  const recent = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return { ok: false, retryAfterMs: windowMs - (now - recent[0]) };
  }
  recent.push(now);
  windows.set(key, recent);
  return { ok: true };
};

// Drop idle keys now and then so the map can't grow without bound.
const sweep = (now: number, windowMs: number) => {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, times] of windows) {
    if (!times.length || now - times[times.length - 1] >= windowMs) windows.delete(key);
  }
};

export const resetRateLimits = () => windows.clear();
