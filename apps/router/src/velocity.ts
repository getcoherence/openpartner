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
// Hard per-IP cap across all linkKeys — prevents a scraper from passing
// velocity by rotating through different links. 300/min is well above
// any plausible legitimate click rate from a single IP.
const IP_CAP_MAX = Number(process.env.ROUTER_IP_CAP_MAX ?? 300);
const IP_CAP_WINDOW_MS = Number(process.env.ROUTER_IP_CAP_WINDOW_MS ?? 60_000);
const MAX_ENTRIES = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

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

/**
 * Per-IP global cap. Returns true when the IP has exceeded the cap in
 * the current window — the caller should refuse the request (unlike
 * velocity, which is audit-only).
 */
export function checkIpCap(ipHash: string | null): boolean {
  if (!ipHash) return false;
  const now = Date.now();
  let bucket = ipBuckets.get(ipHash);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + IP_CAP_WINDOW_MS };
    ipBuckets.set(ipHash, bucket);
  }
  bucket.count += 1;

  if (ipBuckets.size > MAX_ENTRIES) {
    const firstKey = ipBuckets.keys().next().value;
    if (firstKey !== undefined) ipBuckets.delete(firstKey);
  }

  return bucket.count > IP_CAP_MAX;
}
