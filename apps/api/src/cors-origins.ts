/**
 * CORS allowlist extension for white-label custom domains (spec §4.5).
 *
 * In production the white-label SPA is served from the custom domain itself,
 * so its /api calls are same-origin and never trigger CORS — this cache is
 * defense-in-depth (dev setups, genuine cross-origin embeds, and the
 * OPTIONS-preflight-before-tenant-resolution race, which needs no tenant
 * context). Auth never rests on CORS.
 *
 * The set of verified custom domains is cached and re-read from the Tenant
 * table at most once per TTL, and explicitly invalidated on domain
 * verify/revoke so a fresh verification is honored immediately. A DB error
 * degrades to "not allowed" (the static seed allowlist is unaffected).
 */

import { TABLES, type TenantRow } from '@openpartner/db';

const REFRESH_TTL_MS = 60_000;

let customDomainOrigins = new Set<string>();
let lastRefreshAt = 0;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  const { db } = await import('./db.js');
  const rows = await db<TenantRow>(TABLES.Tenant)
    .whereNotNull('customDomain')
    .where({ status: 'active' })
    .pluck('customDomain');
  customDomainOrigins = new Set(rows.map((d) => `https://${String(d).toLowerCase()}`));
  lastRefreshAt = Date.now();
}

/** Force the next check to re-read the DB (call on verify/revoke). */
export function invalidateCustomDomainOrigins(): void {
  lastRefreshAt = 0;
}

/**
 * True iff `origin` is `https://<some verified, active custom domain>`.
 * At most one concurrent refresh; a failed refresh answers from the last
 * good snapshot rather than throwing into the CORS layer.
 */
export async function isCustomDomainOrigin(origin: string): Promise<boolean> {
  if (Date.now() - lastRefreshAt > REFRESH_TTL_MS) {
    inflight ??= refresh()
      .catch((err) => {
        // Keep serving the previous snapshot; don't tight-loop the DB on
        // persistent failure.
        lastRefreshAt = Date.now() - REFRESH_TTL_MS + 5_000;
        console.error('[cors] custom-domain origin refresh failed', err);
      })
      .finally(() => {
        inflight = null;
      });
    await inflight;
  }
  return customDomainOrigins.has(origin.toLowerCase());
}

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * The CORS `origin` option: seed allowlist ∪ custom-domain lookup. An
 * origin is echoed back ONLY after matching one of the two — never blind
 * reflection (`origin: true` + credentials would turn the session cookie
 * into a CSRF payload). Lookup failure = not allowed. Requests without an
 * Origin header (same-origin, curl) are allowed and never touch the DB.
 */
export function corsOriginDecider(
  seed: ReadonlySet<string>,
  isCustom: (origin: string) => Promise<boolean> = isCustomDomainOrigin,
): (origin: string | undefined, cb: OriginCallback) => void {
  return (origin, cb) => {
    if (!origin || seed.has(origin)) return cb(null, true);
    isCustom(origin).then(
      (ok) => cb(null, ok),
      () => cb(null, false),
    );
  };
}
