/**
 * In-memory fixed-window rate limiter for click velocity.
 *
 * Keyed on `${ipHash}|${linkKey}` — the same (ip, link) combination hitting
 * the router more than `max` times in `windowMs` gets flagged as velocity.
 * We don't refuse the request (the operator may want audit), but we mark the
 * Click so the attribution engine skips it.
 *
 * This resets on process restart, which is fine: the purpose is to stop click
 * spam within a session, not to maintain a long-horizon fraud model.
 */

const DEFAULT_MAX = Number(process.env.VELOCITY_MAX ?? 20);
const DEFAULT_WINDOW_MS = Number(process.env.VELOCITY_WINDOW_MS ?? 60_000);
const MAX_ENTRIES = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkVelocity(ipHash: string | null, linkKey: string): boolean {
  if (!ipHash) return false;
  const key = `${ipHash}|${linkKey}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + DEFAULT_WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  // Cheap cap on map size — drop oldest entries when we blow the lid off.
  if (buckets.size > MAX_ENTRIES) {
    const firstKey = buckets.keys().next().value;
    if (firstKey !== undefined) buckets.delete(firstKey);
  }

  return bucket.count > DEFAULT_MAX;
}
