/**
 * Per-IP fixed-window rate limiter.
 *
 * In-memory, resets on process restart — good enough for the endpoints
 * it protects (magic-link email sends, unauth'd attribution identify),
 * where the goal is stopping an attacker or a runaway client in the
 * current session, not maintaining a long-horizon quota.
 *
 * If you run multiple API instances behind a load balancer the limit is
 * per-instance, which means the effective limit is `max * instances`.
 * That's fine at small scale; swap the bucket store for Redis if you
 * need exact limits across a fleet.
 */

import type { RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_ENTRIES = 10_000;

export function ipRateLimit({
  max,
  windowMs,
  name,
}: {
  max: number;
  windowMs: number;
  name: string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    // Tests share a single process and fire dozens of requests through
    // these endpoints back-to-back — bypass under NODE_ENV=test so the
    // suite isn't fighting the limiter. Vitest sets NODE_ENV=test by
    // default; the same bypass applies if a user sets it explicitly.
    if (process.env.NODE_ENV === 'test') return next();

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${name}|${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (buckets.size > MAX_ENTRIES) {
      const firstKey = buckets.keys().next().value;
      if (firstKey !== undefined) buckets.delete(firstKey);
    }

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'rate_limited',
        detail: `limit ${max} per ${Math.round(windowMs / 1000)}s`,
      });
    }

    next();
  };
}
