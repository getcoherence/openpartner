/**
 * Compute the knex `ssl` option for a Postgres connection string.
 *
 * Managed Postgres providers (DO, Heroku, etc.) require TLS but their CA
 * chain isn't in Node's default trust store. We map sslmode params to the
 * matching node-pg `ssl` shape:
 *
 *   sslmode=require | no-verify  → encrypted, no chain check
 *   sslmode=verify-ca | verify-full → encrypted, full chain check (deployment must
 *                                     have the CA in its trust store)
 *   anything else → no ssl
 *
 * Used by both the runtime db factory (createDb) and the knex migration
 * runner (knexfile) so behavior is identical for app calls and migrations.
 */
export function sslFromConnectionString(url: string): true | { rejectUnauthorized: false } | undefined {
  const lower = url.toLowerCase();
  if (lower.includes('sslmode=verify-ca') || lower.includes('sslmode=verify-full')) return true;
  if (lower.includes('sslmode=require') || lower.includes('sslmode=no-verify')) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}
