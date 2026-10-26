/**
 * Table grants for the openpartner_app role, the non-superuser role the
 * API's RLS pool connects as.
 *
 * Each tenant table's own migration grants the role its privileges, but
 * only when the role already exists at migrate time. A role provisioned
 * later (OPENPARTNER_APP_DB_PASSWORD set after the first migrate) gets
 * every grant from scripts/ensure-app-role.ts, which applies these lists
 * on every boot. So every table the app role touches must be listed here,
 * under its current name and with the privileges its migration grants.
 * (PlatformSession is the one exception: no migration grants it, and the
 * boot script always has.) apps/api/src/__tests__/app-role-grants.test.ts
 * fails when a table with row-level security is missing, a listed table no
 * longer exists, or a listed grant is wider than the migration's; CI
 * provisions openpartner_app at migrate time so that last check has the
 * migrations' grants to compare against.
 *
 * Deliberately not derived from pg_policies: a derived list would give
 * full DML to every RLS table missing from RESTRICTED_GRANTS, so a
 * forgotten entry would quietly hand tenant-scoped code DELETE on a
 * ledger. A forgotten entry here fails the test instead.
 */

import type { Knex } from 'knex';

// Tables the app role gets full DML on.
export const TENANT_TABLES = [
  'Tenant',
  'Partner',
  'Program',
  'PartnerProgram',
  'Link',
  'Click',
  'Identity',
  'Event',
  'Attribution',
  'Commission',
  'Bonus',
  'Bounty',
  'CommissionAdjustment',
  'Payout',
  'PayoutReversal',
  'ApiKey',
  'Config',
  'Admin',
  'MagicLinkToken',
  'Session',
  // No tenantId and no RLS (email-keyed workspace-picker sessions), but
  // granted all the same: PlatformSessionBundle by its migration,
  // PlatformSession only ever by the boot script.
  'PlatformSession',
  'PlatformSessionBundle',
  'WebhookEndpoint',
  'WebhookDelivery',
  'PlatformAdmin',
  'NetworkOutbox',
  'Coupon',
  'PartnerCommission',
  'PartnerNetworkConsent',
  'PartnerPostback',
  'PartnerPayoutProfile',
  'BrandAsset',
  'PortalCustomDomain',
  'HostedFundingBatch',
  'HostedFundingAllocation',
  'HostedFundingTransfer',
  'HostedFundingAuthorization',
  'HostedBillingState',
] as const;

// Tables where the app role gets LESS than full DML. OperatorRecoveryRequest
// is append-only from the app's side: the API inserts and lists, every
// update runs on the privileged pool, and withholding UPDATE/DELETE here is
// what makes the audit trail tamper-resistant to tenant-scoped code.
export const RESTRICTED_GRANTS: ReadonlyArray<{ table: string; grant: string }> = [
  { table: 'OperatorRecoveryRequest', grant: 'select, insert' },
  // Same reason: the record of every partner sign-in link a brand minted
  // (routes/partner-signin-link.ts).
  { table: 'PartnerSigninLinkLog', grant: 'select, insert' },
  // The click-landing log is raw like Click: appended, never edited.
  // TrackingIssue's counters are bumped in place (tracking-issues.ts), but
  // no request deletes one.
  { table: 'ClickLanding', grant: 'select, insert' },
  { table: 'TrackingIssue', grant: 'select, insert, update' },
  // The brand Stripe events attribution processed; the catch-up prunes it
  // on the privileged pool (stripe-event-catchup.ts).
  { table: 'StripeEventLog', grant: 'select, insert' },
  // The alert job opens, refreshes and closes flag episodes in place
  // (tracking-alerts.ts); only the tenant purge deletes one.
  { table: 'TrackingAlert', grant: 'select, insert, update' },
  // Retiring a postback token is an UPDATE of revokedAt; no request
  // deletes one.
  { table: 'ConversionPostbackToken', grant: 'select, insert, update' },
  // No DELETE, as their own migrations grant.
  { table: 'TenantStripeConnection', grant: 'select, insert, update' },
  { table: 'HostedBillingProfile', grant: 'select, insert, update' },
  { table: 'PaypalConnection', grant: 'select, insert, update' },
  { table: 'PaypalPayoutBatch', grant: 'select, insert, update' },
  // Platform-fee metering: the tenant-scoped reporter appends usage and
  // shadow rows and fills in its own terms row; everything else is the
  // ops console's privileged pool.
  { table: 'UsageLedger', grant: 'select, insert' },
  { table: 'UsageFeeShadow', grant: 'select, insert' },
  { table: 'HostedFeeTerms', grant: 'select, insert, update' },
];

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Apply every grant above to `role` (openpartner_app outside tests). Each
 * statement is idempotent. Tables that don't exist are skipped, so an
 * image can boot against a schema older than this list.
 */
export async function grantAppRole(db: Knex, role = 'openpartner_app'): Promise<void> {
  if (!ROLE_NAME.test(role)) throw new Error(`unsafe role name: ${role}`);
  const grantee = `"${role}"`;

  const dbName = (await db.raw('select current_database() as n')).rows[0].n as string;
  await db.raw(`grant connect on database "${dbName}" to ${grantee}`);
  await db.raw(`grant usage on schema public to ${grantee}`);

  const { rows } = (await db.raw(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  )) as { rows: Array<{ table_name: string }> };
  const existing = new Set(rows.map((r) => r.table_name));

  for (const tbl of TENANT_TABLES) {
    if (!existing.has(tbl)) continue;
    await db.raw(`grant select, insert, update, delete on "${tbl}" to ${grantee}`);
  }
  for (const { table, grant } of RESTRICTED_GRANTS) {
    if (!existing.has(table)) continue;
    // Revoke first so a role provisioned before the grant narrowed
    // doesn't keep the wider privileges forever — in ONE transaction,
    // so a boot killed between the two statements cannot strand the
    // role with no privileges at all (round 12): GRANT/REVOKE are
    // transactional in Postgres, and live instances see either the old
    // grants or the new ones, never the gap.
    await db.transaction(async (trx) => {
      await trx.raw(`revoke all privileges on "${table}" from ${grantee}`);
      await trx.raw(`grant ${grant} on "${table}" to ${grantee}`);
    });
  }

  await db.raw(`grant usage on all sequences in schema public to ${grantee}`);
}
