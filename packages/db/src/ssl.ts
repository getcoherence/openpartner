/**
 * Compute the knex `ssl` option for a Postgres connection string.
 *
 * Managed Postgres providers (DO, Heroku, etc.) require TLS but their CA
 * chain isn't in Node's default trust store. We map sslmode params to the
 * matching node-pg `ssl` shape:
 *
 *   sslmode=require | no-verify   → encrypted, no chain check
 *   sslmode=verify-ca | verify-full → encrypted, full chain check (deployment
 *                                     must have the CA in its trust store)
 *   anything else → no ssl
 *
 * Used by both the runtime db factory (createDb) and the knex migration
 * runner (knexfile) so behavior is identical for app calls and migrations.
 *
 * Returns both the ssl config and a stripped URL: pg-connection-string
 * (>= v2.7) treats sslmode=require as verify-full and overrides our
 * explicit ssl object, so we strip the sslmode param from the URL when
 * we're managing ssl ourselves.
 */
export interface SslResolution {
  ssl: true | { rejectUnauthorized: false } | undefined;
  url: string;
}

export function sslFromConnectionString(originalUrl: string): SslResolution {
  const lower = originalUrl.toLowerCase();
  let ssl: SslResolution['ssl'] = undefined;
  if (lower.includes('sslmode=verify-ca') || lower.includes('sslmode=verify-full')) {
    ssl = true;
  } else if (lower.includes('sslmode=require') || lower.includes('sslmode=no-verify')) {
    // sslmode=require maps to "encrypt-but-don't-verify-CA" because most
    // managed Postgres providers (DO Managed PG in particular) ship a
    // self-signed CA that isn't in Node's default trust store. Operators
    // who want full verification opt in via sslmode=verify-ca/verify-full
    // and supply the CA in their trust store.
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    ssl = { rejectUnauthorized: false };
  }
  // Strip sslmode + any leftover separator so pg doesn't re-derive ssl.
  const url = originalUrl
    .replace(/([?&])sslmode=[^&]*/gi, '$1')
    .replace(/\?&/, '?')
    .replace(/&&/g, '&')
    .replace(/[?&]$/, '');
  return { ssl, url };
}
