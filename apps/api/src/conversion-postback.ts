/**
 * Credentials for GET /postback, the inbound conversion URL.
 *
 * An affiliate network or lender that can only fire a URL puts this token in
 * the query string, so it's built to be cheap to leak: it records
 * conversions and nothing else, never authenticates as a Bearer key, can be
 * pinned to the sender's IPs, and rotates from the Integrations page. Stored
 * as a sha256 hash like ApiKey; one live token per tenant.
 */

import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import ipaddr from 'ipaddr.js';
import { ulid } from 'ulid';
import { TABLES, type ConversionPostbackTokenRow } from '@openpartner/db';
import { hashKey } from './auth.js';
import { db as privilegedDb } from './db.js';
import { timingSafeEqualStr } from './tenancy.js';

const TOKEN_PREFIX = 'opcp_';
/** `opcp_` + 8 hex: the indexed lookup slice. */
export const POSTBACK_TOKEN_LOOKUP_LEN = TOKEN_PREFIX.length + 8;
export const MAX_IP_ALLOWLIST = 50;

/** What the portal sees of the live token. Never the hash. */
export interface PostbackTokenSummary {
  prefix: string;
  ipAllowlist: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function summarize(row: ConversionPostbackTokenRow): PostbackTokenSummary {
  return { prefix: row.prefix, ipAllowlist: row.ipAllowlist, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

export async function livePostbackToken(db: Knex, tenantId: string): Promise<ConversionPostbackTokenRow | null> {
  const row = await db<ConversionPostbackTokenRow>(TABLES.ConversionPostbackToken)
    .where({ tenantId })
    .whereNull('revokedAt')
    .first();
  return row ?? null;
}

/**
 * Mint a token, revoking the live one: the old URL stops working at once,
 * which is what a leak calls for. The allowlist carries over unless the
 * caller passes a new one. Serialized per tenant so two concurrent rotations
 * can't both insert (the partial unique index would 500 the loser).
 */
export async function rotatePostbackToken(
  db: Knex,
  tenantId: string,
  ipAllowlist?: string[],
): Promise<{ plaintext: string; token: PostbackTokenSummary }> {
  await db.raw(`select pg_advisory_xact_lock(hashtext(?))`, [`conversion_postback_token:${tenantId}`]);
  const current = await livePostbackToken(db, tenantId);
  if (current) {
    await db(TABLES.ConversionPostbackToken).where({ id: current.id }).update({ revokedAt: new Date() });
  }
  const plaintext = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const [row] = (await db<ConversionPostbackTokenRow>(TABLES.ConversionPostbackToken)
    .insert({
      id: ulid(),
      tenantId,
      prefix: plaintext.slice(0, POSTBACK_TOKEN_LOOKUP_LEN),
      tokenHash: hashKey(plaintext),
      // pg jsonb: arrays need stringification.
      ipAllowlist: JSON.stringify(ipAllowlist ?? current?.ipAllowlist ?? []) as unknown as string[],
    })
    .returning('*')) as ConversionPostbackTokenRow[];
  return { plaintext, token: summarize(row!) };
}

/** The live token row this plaintext names in this tenant, or null. */
export async function verifyPostbackToken(
  db: Knex,
  tenantId: string,
  plaintext: string,
): Promise<ConversionPostbackTokenRow | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX) || plaintext.length <= POSTBACK_TOKEN_LOOKUP_LEN) return null;
  const hash = hashKey(plaintext);
  const candidates = await db<ConversionPostbackTokenRow>(TABLES.ConversionPostbackToken)
    .where({ tenantId, prefix: plaintext.slice(0, POSTBACK_TOKEN_LOOKUP_LEN) })
    .whereNull('revokedAt');
  return candidates.find((row) => timingSafeEqualStr(row.tokenHash, hash)) ?? null;
}

/**
 * Stamp lastUsedAt so the portal can show the integration is live. On the
 * privileged pool, autocommit, at most once a minute: done in the request's
 * transaction it would hold the token row's lock until that commits, and
 * serialize every concurrent postback behind it.
 */
export async function touchPostbackToken(id: string): Promise<void> {
  try {
    await privilegedDb(TABLES.ConversionPostbackToken)
      .where({ id })
      .where((q) => q.whereNull('lastUsedAt').orWhere('lastUsedAt', '<', new Date(Date.now() - 60_000)))
      .update({ lastUsedAt: new Date() });
  } catch (err) {
    console.warn('[postback] could not stamp lastUsedAt', { id, err: err instanceof Error ? err.message : err });
  }
}

/** Entries that aren't an IP or a CIDR range, for a 400. IPv4 must be
 *  dotted-quad: ipaddr.js also parses `2130706433` and `0x7f.1`, which
 *  nobody means to allowlist. */
export function invalidAllowlistEntries(entries: string[]): string[] {
  return entries.filter(
    (e) =>
      !ipaddr.IPv4.isValidFourPartDecimal(e) &&
      !ipaddr.IPv4.isValidCIDRFourPartDecimal(e) &&
      !ipaddr.IPv6.isValid(e) &&
      !ipaddr.IPv6.isValidCIDR(e),
  );
}

/**
 * May a postback from `ip` use a token with this allowlist? An empty list
 * admits any source. IPv4-mapped IPv6 (`::ffff:203.0.113.7`, what Node
 * reports on a dual-stack socket) matches its IPv4 entries.
 */
export function ipAllowed(allowlist: string[], ip: string | undefined): boolean {
  if (allowlist.length === 0) return true;
  if (!ip || !ipaddr.isValid(ip)) return false;
  const addr = ipaddr.process(ip);
  return allowlist.some((entry) => {
    try {
      if (ipaddr.isValidCIDR(entry)) {
        const [range, bits] = ipaddr.parseCIDR(entry);
        return range.kind() === addr.kind() && addr.match(range, bits);
      }
      const single = ipaddr.process(entry);
      return single.kind() === addr.kind() && single.toNormalizedString() === addr.toNormalizedString();
    } catch {
      return false;
    }
  });
}
