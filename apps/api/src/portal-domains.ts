/**
 * White-label custom-domain lifecycle — shared logic for the admin
 * register/verify endpoints, the public cert/entitlement allow-gate, and
 * the scheduled re-verification + entitlement sweeps (spec §4.1, §4.2,
 * §7.6, §8.1).
 *
 * Key invariants:
 *   - Verification is NOT terminal. The `_openpartner.<domain>` TXT record
 *     is the customer's ONGOING ownership proof; the daily re-verification
 *     job demotes a verified domain whose TXT disappeared, closing the
 *     dangling-CNAME takeover window (a lapsed domain re-registered by a
 *     stranger must never route into the original tenant's portal).
 *   - The verification token ROTATES on registration and on every failed
 *     (re-)verification cycle — a stale token can't be replayed.
 *   - The allow-gate keys on effective entitlement (billing state, not the
 *     bare whiteLabel boolean) AND verification freshness.
 */

import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { Knex } from 'knex';
import { TABLES, type PortalCustomDomainRow, type TenantRow } from '@openpartner/db';
import { getTenantBillingState } from './billing-plan.js';
import { isWhiteLabelEntitled } from './white-label.js';
import { isPlatformHost } from './tenancy.js';
import { invalidateCustomDomainOrigins } from './cors-origins.js';

/** A `verified` row whose last successful check is older than this is
 *  refused by the allow-gate until the re-verification job (or a manual
 *  verify) freshens it. The job runs daily, so 7 days tolerates a week of
 *  job outage before a live domain drops. */
export const VERIFICATION_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const TXT_RECORD_PREFIX = 'openpartner-verify=';

export function newVerificationToken(): string {
  return randomBytes(24).toString('hex');
}

export function txtRecordName(domain: string): string {
  return `_openpartner.${domain}`;
}

export function expectedTxtValue(token: string): string {
  return `${TXT_RECORD_PREFIX}${token}`;
}

/** DNS TXT answers arrive as chunk arrays (long records are split);
 *  join each answer before comparing. */
export function txtContainsToken(records: string[][], token: string): boolean {
  const expected = expectedTxtValue(token);
  return records.some((chunks) => chunks.join('').trim() === expected);
}

export function isStaleVerification(
  row: Pick<PortalCustomDomainRow, 'verifiedAt' | 'lastCheckedAt'>,
  now: Date = new Date(),
): boolean {
  const freshAsOf = row.lastCheckedAt ?? row.verifiedAt;
  if (!freshAsOf) return true;
  return now.getTime() - new Date(freshAsOf).getTime() > VERIFICATION_STALE_AFTER_MS;
}

const FQDN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Registrable = syntactically a valid lowercase FQDN, at least three labels
 * (v1 supports subdomains only — an apex needs ALIAS/ANAME support, spec
 * §10.2), and never a platform/reserved host (spec §4.2: fail loudly here
 * rather than leaning on the unique constraint).
 */
export function domainRegistrationError(domain: string): string | null {
  if (domain.length === 0 || domain.length > 253) return 'invalid_domain';
  const labels = domain.split('.');
  if (labels.some((l) => !FQDN_LABEL.test(l))) return 'invalid_domain';
  if (isPlatformHost(domain)) return 'reserved_host';
  if (labels.length < 3) return 'subdomain_required';
  return null;
}

export type TxtResolver = (name: string) => Promise<string[][]>;

const defaultResolver: TxtResolver = (name) => resolveTxt(name);

/** One DNS check. Resolution failure (NXDOMAIN, timeout) = not verified. */
export async function checkDomainTxt(
  domain: string,
  token: string,
  resolver: TxtResolver = defaultResolver,
): Promise<boolean> {
  try {
    const records = await resolver(txtRecordName(domain));
    return txtContainsToken(records, token);
  } catch {
    return false;
  }
}

/**
 * The single predicate behind the public allow-gate (§4.1): may `domain`
 * serve white-label traffic right now? Runs on the PRIVILEGED pool — the
 * domain → tenant lookup is legitimately cross-tenant.
 */
export async function isDomainAllowed(
  db: Knex,
  domain: string,
): Promise<{ allowed: boolean; reason: string }> {
  const row = await db<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
    .where({ domain, status: 'verified' })
    .first();
  if (!row) return { allowed: false, reason: 'not_registered' };
  if (isStaleVerification(row)) return { allowed: false, reason: 'verification_stale' };
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: row.tenantId })
    .first(['id', 'whiteLabel', 'status']);
  if (!tenant) return { allowed: false, reason: 'not_registered' };
  const billing = await getTenantBillingState(db, tenant.id);
  if (!isWhiteLabelEntitled({ whiteLabel: !!tenant.whiteLabel, status: tenant.status }, billing)) {
    return { allowed: false, reason: 'not_entitled' };
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * Edge revocation (spec §6.3): remove the domain from the DO App Platform
 * app so the cert stops renewing and the host stops resolving at the edge.
 * Clearing Tenant.customDomain (done by the callers) already stops tenant
 * resolution; this closes the TLS side. When the DO automation isn't
 * configured or errors, the warning is the operator's signal to remove the
 * domain in the DO console by hand.
 */
async function revokeEdge(domain: string, why: string): Promise<void> {
  const { removeAppDomain } = await import('./do-app-domains.js');
  const edge = await removeAppDomain(domain);
  if (edge === 'removed' || edge === 'absent') {
    console.warn(`[white-label] custom domain ${domain} revoked (${why}) — DO edge: ${edge}`);
    return;
  }
  console.warn(
    `[white-label] custom domain ${domain} revoked (${why}) — DO edge ${edge}: remove it from the DO App Platform app manually (console → Settings → Domains)`,
  );
}

/**
 * Daily re-verification sweep (§7.6): every verified domain gets its
 * `_openpartner` TXT re-checked. Present → freshen lastCheckedAt. Gone or
 * changed → demote to failed, ROTATE the token, clear Tenant.customDomain,
 * and revoke the edge. Runs on the privileged pool.
 */
export async function reverifyPortalDomains(
  db: Knex,
  resolver: TxtResolver = defaultResolver,
): Promise<{ checked: number; demoted: string[] }> {
  const rows = await db<PortalCustomDomainRow>(TABLES.PortalCustomDomain).where({
    status: 'verified',
  });
  const demoted: string[] = [];
  const now = new Date();
  for (const row of rows) {
    const ok = await checkDomainTxt(row.domain, row.verificationToken, resolver);
    if (ok) {
      await db<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
        .where({ id: row.id })
        .update({ lastCheckedAt: now, updatedAt: now });
      continue;
    }
    await db<PortalCustomDomainRow>(TABLES.PortalCustomDomain).where({ id: row.id }).update({
      status: 'failed',
      verificationToken: newVerificationToken(),
      lastCheckedAt: now,
      updatedAt: now,
    });
    await db<TenantRow>(TABLES.Tenant)
      .where({ id: row.tenantId, customDomain: row.domain })
      .update({ customDomain: null, updatedAt: now });
    await revokeEdge(row.domain, 'ownership TXT record missing or changed');
    demoted.push(row.domain);
  }
  if (demoted.length > 0) invalidateCustomDomainOrigins();
  return { checked: rows.length, demoted };
}

/**
 * Revoke a tenant's custom-domain ROUTING: clear Tenant.customDomain (host
 * resolution + links + CORS stop) and remove the domain from the DO edge
 * (cert stops renewing). The PortalCustomDomain row keeps its verified
 * status so re-subscribing restores service without a DNS round-trip.
 * No-op when the tenant has no custom domain. Shared by the entitlement
 * sweep and the Stripe webhook's add-on-removed transition.
 */
export async function revokeTenantCustomDomainRouting(
  db: Knex,
  tenantId: string,
  why: string,
): Promise<string | null> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['customDomain']);
  const domain = tenant?.customDomain;
  if (!domain) return null;
  await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .update({ customDomain: null, updatedAt: new Date() });
  await revokeEdge(domain, why);
  invalidateCustomDomainOrigins();
  return domain;
}

/**
 * Daily entitlement sweep (§8.1): a tenant whose trial lapsed without ever
 * subscribing emits no Stripe webhook, so this is what actually revokes
 * white-label routing for them.
 */
export async function sweepWhiteLabelEntitlement(
  db: Knex,
): Promise<{ checked: number; revoked: string[] }> {
  const tenants = await db<TenantRow>(TABLES.Tenant)
    .whereNotNull('customDomain')
    .select(['id', 'slug', 'customDomain', 'whiteLabel', 'status']);
  const revoked: string[] = [];
  for (const tenant of tenants) {
    const billing = await getTenantBillingState(db, tenant.id);
    if (isWhiteLabelEntitled({ whiteLabel: !!tenant.whiteLabel, status: tenant.status }, billing)) {
      continue;
    }
    const domain = await revokeTenantCustomDomainRouting(
      db,
      tenant.id,
      `tenant ${tenant.slug} no longer white-label entitled`,
    );
    if (domain) revoked.push(domain);
  }
  return { checked: tenants.length, revoked };
}
