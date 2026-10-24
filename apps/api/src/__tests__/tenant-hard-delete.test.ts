/**
 * The tenant-hard-delete job: once a brand's 30-day deletion grace window
 * lapses, every row it owns goes, in an order no foreign key trips over.
 *
 * Before this test the purge deleted Payout, Commission, Partner and Admin
 * while PayoutReversal, CommissionAdjustment and the hosted-funding tables
 * still pointed at them, so any brand with clawback or funding history
 * rolled back and retried daily forever. The seed below puts a row in
 * every table that has a tenantId column (read from the catalog, so a new
 * table fails here until it joins TENANT_PURGE_ORDER or TENANT_PURGE_KEEP).
 * The kept compliance records must outlive the purge.
 *
 * The same job then drops platform passwords (keyed by email, outside any
 * tenant) once no admin membership or operator account holds them.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

const ENV_OPERATOR = 'ops-purge@openpartner.test';
process.env.PLATFORM_OPS_EMAIL = 'ops@openpartner.test';
process.env.PLATFORM_ADMIN_EMAILS = `someone@openpartner.test, ${ENV_OPERATOR.toUpperCase()}`;

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { __setMailerForTests } = await import('../mailer.js');
const { hardDeleteExpiredTenants, TENANT_PURGE_KEEP, TENANT_PURGE_ORDER } = await import('../scheduler.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Every public table with a tenantId column. */
async function tenantScopedTables(): Promise<string[]> {
  const rows = await db('information_schema.columns')
    .where({ table_schema: 'public', column_name: 'tenantId' })
    .select<Array<{ table_name: string }>>('table_name');
  return rows.map((r) => r.table_name).sort();
}

/** The tenant-scoped tables the purge empties: all but the kept records. */
async function purgedTables(): Promise<string[]> {
  return (await tenantScopedTables()).filter((t) => !TENANT_PURGE_KEEP.includes(t));
}

async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const tbl of await purgedTables()) {
    const [r] = await db(tbl).where({ tenantId }).count<Array<{ count: string }>>({ count: '*' });
    out[tbl] = Number(r?.count ?? 0);
  }
  return out;
}

async function insertTenant(id: string, pendingDeletionAt: Date | null): Promise<void> {
  await db(TABLES.Tenant).insert({
    id,
    slug: `purge-${id.toLowerCase()}`,
    displayName: `Purge ${id.slice(-4)}`,
    status: 'active',
    pendingDeletionAt,
  });
}

/** One row in every tenant-scoped table, wired through the same foreign
 *  keys production data uses. */
async function seedEverything(tenantId: string): Promise<void> {
  const u = () => ulid();
  const short = () => ulid().slice(-12).toLowerCase();
  const adminId = u();
  const partnerId = u();
  const programId = u();
  const linkId = u();
  const clickId = u();
  const eventId = u();
  const attributionId = u();
  const bountyId = u();
  const bonusId = u();
  const commissionId = u();
  const bonusCommissionId = u();
  const payoutId = u();
  const batchId = u();
  const endpointId = u();

  await db(TABLES.Admin).insert({ id: adminId, tenantId, email: `admin-${short()}@purge.test`, name: 'Admin' });
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, email: `partner-${short()}@purge.test`, name: 'Partner' });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'Program',
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: 'https://brand.example.test',
  });
  await db(TABLES.PartnerProgram).insert({ id: u(), tenantId, partnerId, programId, source: 'admin' });
  await db(TABLES.PartnerCommission).insert({
    partnerId,
    tenantId,
    commissionType: 'percent',
    commissionValue: 15,
    source: 'admin',
  });
  await db(TABLES.PartnerPostback).insert({
    id: u(),
    tenantId,
    partnerId,
    url: 'https://partner.example.test/postback',
    events: JSON.stringify(['commission.created']),
  });
  await db(TABLES.PartnerNetworkConsent).insert({
    partnerId,
    tenantId,
    status: 'granted',
    source: 'portal_setting',
    consentedAt: new Date(),
  });
  await db(TABLES.PartnerPayoutProfile).insert({
    partnerId,
    tenantId,
    method: 'paypal',
    details: 'sealed-details-placeholder',
    updatedBy: 'partner',
  });
  await db(TABLES.Coupon).insert({ id: u(), tenantId, partnerId, programId, code: `PURGE${short().toUpperCase()}` });
  await db(TABLES.Link).insert({ id: linkId, tenantId, linkKey: `purge-${short()}`, partnerId, programId });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example.test/?cref=x',
  });
  await db(TABLES.Identity).insert({ id: u(), tenantId, clickId, userId: 'user_purge' });
  await db(TABLES.ClickLanding).insert({ clickId, tenantId, host: 'www.purge.test' });
  await db(TABLES.Event).insert({ id: eventId, tenantId, userId: 'user_purge', type: 'invoice_paid' });
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId,
    eventId,
    partnerId,
    programId,
    clickId,
    model: 'last_click',
  });
  await db(TABLES.Bounty).insert({
    id: bountyId,
    tenantId,
    programId,
    name: 'Bounty',
    metric: 'conversions',
    threshold: 5,
    rewardAmount: 50,
    currency: 'USD',
  });
  await db(TABLES.Bonus).insert({
    id: bonusId,
    tenantId,
    partnerId,
    programId,
    bountyId,
    amount: 50,
    currency: 'USD',
    source: 'performance_bounty',
  });
  await db(TABLES.Commission).insert([
    { id: commissionId, tenantId, partnerId, amount: 10, attributionId },
    { id: bonusCommissionId, tenantId, partnerId, amount: 50, bonusId },
  ]);
  await db(TABLES.CommissionAdjustment).insert({
    id: u(),
    tenantId,
    commissionId,
    amount: -5,
    currency: 'USD',
    reason: 'refund_clawback',
  });
  await db(TABLES.Payout).insert({ id: payoutId, tenantId, partnerId, amount: 10, method: 'stripe_connect' });
  await db(TABLES.PayoutReversal).insert({
    id: u(),
    tenantId,
    payoutId,
    stripeReversalId: `trr_${short()}`,
    amountMinor: 500,
  });
  await db(TABLES.HostedFundingBatch).insert({
    id: batchId,
    tenantId,
    currency: 'usd',
    principalMinor: 1000,
    grossChargeMinor: 1100,
  });
  await db(TABLES.HostedFundingAllocation).insert({
    id: u(),
    tenantId,
    batchId,
    commissionId,
    partnerId,
    amountMinor: 1000,
  });
  await db(TABLES.HostedFundingTransfer).insert({
    id: u(),
    tenantId,
    batchId,
    partnerId,
    currency: 'usd',
    amountMinor: 1000,
    destinationAccountId: 'acct_purge',
    idempotencyKey: `idem_${short()}`,
  });
  await db(TABLES.HostedFundingAuthorization).insert({
    id: u(),
    tenantId,
    adminId,
    termsVersion: 'v1',
    stripePaymentMethodId: 'pm_purge',
    paymentMethodType: 'us_bank_account',
  });
  await db(TABLES.HostedBillingState).insert({ tenantId });
  await db(TABLES.HostedFeeTerms).insert({ tenantId });
  await db(TABLES.HostedBillingProfile).insert({ tenantId, collectionMethod: 'send_invoice', gstin: '27AAPFU0939F1ZV' });
  await db(TABLES.UsageLedger).insert({
    id: u(),
    tenantId,
    reportKey: 'purge',
    reason: 'billed',
    currency: 'USD',
    amount: 10,
    amountUsd: 0,
    eventId,
  });
  await db(TABLES.UsageFeeShadow).insert({
    id: u(),
    tenantId,
    reportKey: 'purge',
    rangeEnd: new Date(),
    mode: 'shadow',
    conversions: 0,
    oldBasisUsd: 0,
    newBasisUsd: 0,
    oldFeeUsd: 0,
    newFeeUsd: 0,
    floorConversions: 0,
    renamedSaleConversions: 0,
  });
  await db(TABLES.TenantStripeConnection).insert({
    id: u(),
    tenantId,
    stripeAccountId: `acct_${short()}`,
    livemode: false,
    keyMode: 'test',
    permissionsVersion: 1,
    refreshTokenEnc: 'enc',
  });
  const paypalConnectionId = u();
  await db(TABLES.PaypalConnection).insert({
    id: paypalConnectionId,
    tenantId,
    environment: 'sandbox',
    clientId: `client_${short()}`,
    clientSecretEnc: 'enc',
  });
  await db(TABLES.PaypalPayoutBatch).insert({
    id: u(),
    tenantId,
    connectionId: paypalConnectionId,
    environment: 'sandbox',
    runId: u(),
    currency: 'USD',
    itemCount: 1,
    total: '10.00',
    createdBy: 'admin',
  });
  await db(TABLES.PortalCustomDomain).insert({
    id: u(),
    tenantId,
    domain: `${short()}.purge.example.test`,
    verificationToken: short(),
  });
  await db(TABLES.OperatorRecoveryRequest).insert({
    id: u(),
    tenantId,
    rail: 'direct_connect',
    kind: 'dispose_intent',
    targetId: payoutId,
    requestedBy: 'ops@openpartner.test',
  });
  await db(TABLES.BrandNotification).insert({
    id: u(),
    tenantId,
    kind: 'setup_reminder',
    step: 1,
    recipientEmail: 'admin@purge.test',
  });
  await db(TABLES.Config).insert({ tenantId, key: 'program_settings', value: { partnerNetworkVisible: false } });
  await db(TABLES.ConversionPostbackToken).insert({ id: u(), tenantId, prefix: short(), tokenHash: short() });
  await db(TABLES.ApiKey).insert({ id: u(), tenantId, partnerId, prefix: short(), keyHash: short() });
  await db(TABLES.MagicLinkToken).insert({
    id: u(),
    tenantId,
    prefix: short(),
    tokenHash: short(),
    email: 'admin@purge.test',
    purpose: 'signin',
    expiresAt: new Date(Date.now() + DAY),
    principalKind: 'admin',
    principalId: adminId,
  });
  await db(TABLES.Session).insert({
    id: u(),
    tenantId,
    prefix: short(),
    tokenHash: short(),
    expiresAt: new Date(Date.now() + DAY),
    principalKind: 'admin',
    principalId: adminId,
  });
  await db(TABLES.PartnerSigninLinkLog).insert({
    id: u(),
    tenantId,
    partnerId,
    magicLinkTokenId: u(),
    actorKind: 'operator_key',
    expiresAt: new Date(Date.now() + DAY),
  });
  await db(TABLES.TrackingIssue).insert({ tenantId, day: '2026-10-01', kind: 'identify_unknown_click', count: 3 });
  await db(TABLES.PasswordCredential).insert({
    id: u(),
    tenantId,
    principalKind: 'partner',
    principalId: partnerId,
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
  });
  await db(TABLES.WebhookEndpoint).insert({
    id: endpointId,
    tenantId,
    url: 'https://brand.example.test/hooks',
    secretPrefix: short(),
    secret: short(),
    events: JSON.stringify(['*']),
  });
  await db(TABLES.WebhookDelivery).insert({
    id: u(),
    tenantId,
    endpointId,
    eventId: 'evt_purge',
    eventType: 'commission.created',
    payload: {},
    status: 'pending',
  });
  await db(TABLES.NetworkOutbox).insert({ id: u(), tenantId, op: 'upsert_vendor', payload: {} });
  await db(TABLES.BrandAsset).insert({ id: u(), tenantId, kind: 'snippet', label: 'Snippet', body: 'Hello' });
}

describe.skipIf(skipIntegration)('tenant-hard-delete', () => {
  const sentMail: Array<{ to: string; subject: string; text: string; tag?: string }> = [];
  const created: string[] = [];
  // Rows outside any seeded tenant: platform-scoped credentials (under
  // DEFAULT_TENANT_ID) and PlatformAdmin rows.
  const credentialIds: string[] = [];
  const operatorEmails: string[] = [];

  /** Remove whatever a test left behind, cross-tenant references first. */
  async function wipe(): Promise<void> {
    await db(TABLES.PasswordCredential).whereIn('id', credentialIds).del();
    await db(TABLES.PlatformAdmin).whereIn('email', operatorEmails).del();
    credentialIds.length = 0;
    operatorEmails.length = 0;
    if (created.length === 0) return;
    for (const tbl of TENANT_PURGE_ORDER) await db(tbl).whereIn('tenantId', created).del();
    await db(TABLES.LocationDeclaration).whereIn('tenantId', created).del();
    await db(TABLES.Tenant).whereIn('id', created).del();
    created.length = 0;
  }

  async function credential(tenantId: string, principalKind: string, principalId: string): Promise<string> {
    const id = ulid();
    credentialIds.push(id);
    await db(TABLES.PasswordCredential).insert({
      id,
      tenantId,
      principalKind,
      principalId,
      passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    });
    return id;
  }

  beforeEach(async () => {
    sentMail.length = 0;
    __setMailerForTests({
      send: async (_ctx, msg) => {
        sentMail.push({ to: msg.to, subject: msg.subject, text: msg.text, tag: msg.tag });
      },
    });
    await wipe();
  });

  afterAll(async () => {
    __setMailerForTests(null);
    await wipe();
    await db.destroy();
  });

  it('lists every table that has a tenantId column, apart from the kept records', async () => {
    expect([...TENANT_PURGE_ORDER].sort()).toEqual(await purgedTables());
    expect(TENANT_PURGE_ORDER.filter((t) => TENANT_PURGE_KEEP.includes(t))).toEqual([]);
  });

  it('purges an expired tenant with a row in every tenant-scoped table, and nobody else', async () => {
    const expired = ulid();
    const inGrace = ulid();
    created.push(expired, inGrace);
    await insertTenant(expired, daysAgo(31));
    await insertTenant(inGrace, daysAgo(1));
    await seedEverything(expired);
    await seedEverything(inGrace);
    // A compliance record the purge must keep (no FK, so it can't block it).
    const declarationId = ulid();
    await db(TABLES.LocationDeclaration).insert({
      id: declarationId,
      subjectKind: 'tenant',
      subjectId: expired,
      tenantId: expired,
      country: 'DE',
      source: 'signup',
    });

    const before = await rowCounts(expired);
    const empty = Object.entries(before).filter(([, n]) => n === 0).map(([tbl]) => tbl);
    expect(empty, 'seed must cover every tenant-scoped table').toEqual([]);

    const result = await hardDeleteExpiredTenants();

    expect(result.tenantIds).toContain(expired);
    expect(result.tenantIds).not.toContain(inGrace);
    expect(result.failed.filter((f) => created.includes(f.tenantId))).toEqual([]);
    expect(await db(TABLES.Tenant).where({ id: expired }).first()).toBeUndefined();
    const left = Object.entries(await rowCounts(expired)).filter(([, n]) => n > 0);
    expect(left).toEqual([]);
    expect(await db(TABLES.LocationDeclaration).where({ id: declarationId }).first()).toMatchObject({
      tenantId: expired,
      country: 'DE',
    });

    // The brand still inside its grace window keeps everything.
    expect(await rowCounts(inGrace)).toEqual(before);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_purge_failed')).toEqual([]);
  });

  it('rolls a failed purge back and tells ops', async () => {
    const expired = ulid();
    const other = ulid();
    created.push(expired, other);
    await insertTenant(expired, daysAgo(40));
    await insertTenant(other, null);
    const partnerId = ulid();
    const programId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId: expired, email: 'p@purge.test', name: 'P' });
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: other,
      name: 'Other',
      commissionRule: { type: 'percent', value: 10 },
      destinationUrl: 'https://other.example.test',
    });
    // A row the purge doesn't own still points at the expired brand's
    // Partner, so deleting the Partner violates Link.partnerId.
    await db(TABLES.Link).insert({ id: ulid(), tenantId: other, linkKey: `x-${ulid()}`, partnerId, programId });

    const result = await hardDeleteExpiredTenants();

    expect(result.tenantIds).not.toContain(expired);
    const failure = result.failed.find((f) => f.tenantId === expired);
    expect(failure?.error).toMatch(/foreign key/);
    // Rolled back: nothing of the brand was removed.
    expect(await db(TABLES.Tenant).where({ id: expired }).first()).toBeDefined();
    expect(await db(TABLES.Partner).where({ id: partnerId }).first()).toBeDefined();

    const alerts = sentMail.filter((m) => m.tag === 'ops_tenant_purge_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe('ops@openpartner.test');
    expect(alerts[0]!.text).toContain(`tenant ${expired}`);
    expect(alerts[0]!.text).toContain(failure!.error);
  });

  it('deletes platform passwords no admin or operator holds any more, and nothing else', async () => {
    const expired = ulid();
    const live = ulid();
    created.push(expired, live);
    await insertTenant(expired, daysAgo(31));
    await insertTenant(live, null);
    const tag = ulid().slice(-8).toLowerCase();
    const at = (who: string) => `${who}-${tag}@purge.test`;
    const admin = (tenantId: string, email: string, extra: Record<string, unknown> = {}) =>
      db(TABLES.Admin).insert({ id: ulid(), tenantId, email, name: 'Admin', activatedAt: new Date(), ...extra });
    const operator = async (email: string, revokedAt: Date | null = null) => {
      operatorEmails.push(email);
      await db(TABLES.PlatformAdmin).insert({ id: ulid(), email, name: 'Operator', role: 'admin', revokedAt });
    };

    // Its only brand is purged by this run.
    await admin(expired, at('last-brand'));
    // Purged here, but still admins another brand.
    await admin(expired, at('other-brand'));
    await admin(live, at('other-brand'));
    // Invited and never activated still counts.
    await admin(live, at('invited'), { activatedAt: null });
    // The credential key is lower-cased; an Admin row may not be.
    await admin(live, at('MixedCase'));
    // Removed from the brand: kept for 30 days, so reinstating brings the
    // password back with the membership; gone after that.
    await admin(live, at('removed-recently'), { revokedAt: daysAgo(1) });
    await admin(live, at('removed-long-ago'), { revokedAt: daysAgo(31) });
    // Operators: a live PlatformAdmin row, or PLATFORM_ADMIN_EMAILS (which
    // outranks a revoked row, as it does at sign-in). The same 30 days
    // apply to a revoked operator.
    await operator(at('operator'));
    await operator(ENV_OPERATOR, daysAgo(90));
    await operator(at('operator-removed-long-ago'), daysAgo(31));

    const platform = (email: string) => credential(DEFAULT_TENANT_ID, 'platform', email.toLowerCase());
    const gone = {
      lastBrand: await platform(at('last-brand')),
      removedLongAgo: await platform(at('removed-long-ago')),
      operatorRemovedLongAgo: await platform(at('operator-removed-long-ago')),
      // No Admin row anywhere (its brand was purged before this sweep).
      noAdmin: await platform(at('no-admin')),
    };
    const kept = {
      otherBrand: await platform(at('other-brand')),
      invited: await platform(at('invited')),
      mixedCase: await platform(at('MixedCase')),
      removedRecently: await platform(at('removed-recently')),
      operator: await platform(at('operator')),
      envOperator: await platform(ENV_OPERATOR),
      // Other kinds are never the sweep's, even under DEFAULT_TENANT_ID
      // (single-tenant partners) where no Admin row matches.
      livePartner: await credential(live, 'partner', ulid()),
      defaultTenantPartner: await credential(DEFAULT_TENANT_ID, 'partner', ulid()),
      defaultTenantSignup: await credential(DEFAULT_TENANT_ID, 'signup', ulid()),
      liveSignup: await credential(live, 'signup', ulid()),
    };

    const result = await hardDeleteExpiredTenants();

    expect(result.tenantIds).toContain(expired);
    expect(result.orphanedPasswordsDeleted).toBeGreaterThanOrEqual(Object.keys(gone).length);
    const remaining = new Set<string>(await db(TABLES.PasswordCredential).whereIn('id', credentialIds).pluck('id'));
    for (const [name, id] of Object.entries(gone)) expect(remaining.has(id), `${name} deleted`).toBe(false);
    for (const [name, id] of Object.entries(kept)) expect(remaining.has(id), `${name} kept`).toBe(true);
  });
});
