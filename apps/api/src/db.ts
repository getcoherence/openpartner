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
 * Self-hosters can leave DATABASE_URL_APP unset. RLS is then bypassed
 * (the app runs as the same role as migrations) but app-level tenantId
 * filtering still applies, so isolation is preserved at the query layer.
 * For real defense-in-depth, set DATABASE_URL_APP to the openpartner_app
 * role connection string.
 */
import './env.js';
import { createDb } from '@openpartner/db';

const adminUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_URL_APP ?? adminUrl;

if (!adminUrl) {
  throw new Error('DATABASE_URL must be set');
}

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
export const db = createDb({ connectionString: adminUrl, bypassRls: true });

/**
 * Per-tenant pool. Tenant scope is set on each transaction via SET LOCAL
 * app.tenant_id; see tenancy.ts withTenantTransaction. RLS is *not*
 * bypassed on this pool — that's the whole point.
 */
export const appDb = createDb({ connectionString: appUrl! });
