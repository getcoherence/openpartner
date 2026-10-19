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

/**
 * Fixed-window counter keyed by something other than the IP — an email
 * address, so a credential-stuffing run spread across many IPs still hits a
 * per-account wall, and a "forgot password" form can't be used to bury one
 * inbox in mail. Same in-memory, per-instance caveats as ipRateLimit.
 *
 * Not bypassed under NODE_ENV=test: callers count only failures (or one
 * mail per hit), which tests don't produce in bulk for a single key.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private live(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  /** True when the key has used up its window. Does not count. */
  blocked(key: string): boolean {
    const bucket = this.live(key, Date.now());
    return !!bucket && bucket.count >= this.max;
  }

  /** Count one hit. Returns false when this hit is over the limit. */
  hit(key: string): boolean {
    const now = Date.now();
    let bucket = this.live(key, now);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
      if (this.buckets.size > MAX_ENTRIES) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey !== undefined) this.buckets.delete(firstKey);
      }
    }
    bucket.count += 1;
    return bucket.count <= this.max;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}
