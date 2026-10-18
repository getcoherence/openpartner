/**
 * Two database connections:
 *
 *   db (admin)  — connection used for migrations + cross-tenant operations
 *                 (signup, platform-admin tooling). Uses DATABASE_URL.
 *                 Bypasses RLS (it's a superuser/owner role).
 *
 *   appDb       — connection used for normal tenant-scoped requests. Uses
 *                 DATABASE_URL_APP if set, otherwise falls back to
 *                 DATABASE_URL. When set to the openpartner_app role,
 *                 every query is subject to RLS — the per-request
 *                 transaction (see tenancy.ts) sets `app.tenant_id` to
 *                 scope rows correctly.
 *
 * Multi-tenant (OPENPARTNER_TENANCY=multi) REQUIRES DATABASE_URL_APP to be
 * the openpartner_app role. RLS is the tenant boundary. App-level tenantId
 * filters are defence in depth and do NOT cover every query: an Oct 2026
 * run without DATABASE_URL_APP leaked partners, program grants and billed
 * GMV across tenants. server.ts refuses to start a multi-tenant API whose
 * app pool bypasses RLS (tenant-isolation-guard.ts).
 *
 * Single-tenant self-host can leave DATABASE_URL_APP unset. The app then
 * runs as the migration role and RLS is bypassed, which is harmless with
 * only one tenant.
 */
import './env.js';
import { createDb } from '@openpartner/db';

const adminUrl = process.env.DATABASE_URL;
const rawAppUrl = process.env.DATABASE_URL_APP ?? adminUrl;

if (!adminUrl) {
  throw new Error('DATABASE_URL must be set');
}

// If the admin URL specifies sslmode but the app URL doesn't, carry it
// across. Both URLs target the same managed cluster (the app role lives
// alongside the admin role), so SSL requirements are identical — making
// operators set sslmode in two places is just a footgun. DO Managed
// Postgres rejects unencrypted connections, so a missing sslmode on the
// app URL surfaces as a pg_hba "no encryption" error at request time.
function inheritSslMode(appUrl: string, adminUrl: string): string {
  if (/[?&]sslmode=/i.test(appUrl)) return appUrl;
  const adminMode = adminUrl.match(/[?&](sslmode=[^&]+)/i);
  if (!adminMode) return appUrl;
  const sep = appUrl.includes('?') ? '&' : '?';
  return `${appUrl}${sep}${adminMode[1]}`;
}

const appUrl = inheritSslMode(rawAppUrl!, adminUrl);

/**
 * Privileged knex instance. Used by:
 *   - migrations (via the migrate.ts script, separately)
 *   - signup flow (creates Tenant rows; the request has no tenantId yet)
 *   - platform-admin tooling
 *   - background jobs that genuinely need cross-tenant access
 *   - stripe webhook tenant resolution (looks up by partnerId/payoutId
 *     across tenants before opening a per-tenant trx for processing)
 *   - the in-process scheduler enumerating active tenants
 *   - /metrics scrape (platform-wide counts)
 *
 * `bypassRls: true` sets `row_security = off` on every pooled connection
 * so cross-tenant queries actually return rows. Without this, FORCE RLS
 * would silently zero out every query on this pool — even for the table
 * owner. The role used here must be the table owner or have BYPASSRLS.
 *
 * Day-to-day API request handling should use req.db (the transaction-bound
 * appDb instance) instead, so RLS is the second line of defense.
 */
// Top-level await: createDb is async because knex is now lazy-imported
// (kept out of any browser bundle that imports from @openpartner/db). Node
// 14+ ESM supports top-level await, so callers see the already-resolved
// Knex instance with no API-shape change.
export const db = await createDb({ connectionString: adminUrl, bypassRls: true });

/**
 * Per-tenant pool. Tenant scope is set on each transaction via SET LOCAL
 * app.tenant_id; see tenancy.ts withTenantTransaction. RLS is *not*
 * bypassed on this pool — that's the whole point.
 */
export const appDb = await createDb({ connectionString: appUrl! });
