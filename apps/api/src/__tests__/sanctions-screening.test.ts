/**
 * Sanctions screening and compliance payout holds (sanctions-screening.ts,
 * docs/sanctions-screening.md). Hosted multi-tenant mode, real database:
 *
 *   1. The CSL client: the request it sends, what counts as a possible
 *      match, and what an error or a missing key records.
 *   2. Payout holds, one test per reason (blocked declared country, open
 *      possible match, confirmed match, not screened yet), on the direct
 *      Connect rail and the funded rail; the manual rail only warns; an
 *      operator's 'cleared' releases the hold. Also as the app role, which
 *      can't read the hold records itself. And holds that appear after
 *      planning, which the executors of both rails catch before posting.
 *   3. The sweep: first time payable, at most daily after, decisions
 *      carried across rescreens, and giving up when the API is down.
 *   4. Brands: signup screens in the background, ops review it, and a
 *      confirmed match rejects the brand.
 *   5. GET /payouts/holds, the ops screening page, and POST /partners
 *      `country`.
 *
 * The CSL is stubbed (setCslLookupForTesting): tests decide what the list
 * holds. Skipped when DATABASE_URL is unset, like the rest of the
 * integration suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import type { Knex } from 'knex';
import type Stripe from 'stripe';
import {
  TABLES,
  type HostedFundingAllocationRow,
  type HostedFundingBatchRow,
  type LocationDeclarationRow,
  type PlatformAdminRow,
  type SanctionsScreeningRow,
  type TenantRow,
} from '@openpartner/db';

const OPS_EMAIL = 'ops-screening@openpartner.test';
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_ADMIN_EMAILS = OPS_EMAIL;
delete process.env.NETWORK_URL;
delete process.env.PLATFORM_OPS_EMAIL;
const cslKeyBefore = process.env.CSL_API_KEY;
const fundingFlagBefore = process.env.HOSTED_FUNDING_ENABLED;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { setIpCountryLookupForTesting } = await import('../geoip.js');
const { recordLocationDeclaration } = await import('../country-access.js');
const { runPayouts } = await import('../payouts.js');
const { executePayoutTransfers } = await import('../payout-transfers.js');
const { runTransferExecutor } = await import('../funding/executor.js');
const { __setMailerForTests } = await import('../mailer.js');
const screening = await import('../sanctions-screening.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import(
  '../platform-admin-sessions.js'
);

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const fileStartedAt = new Date();

const SDN = 'Specially Designated Nationals (SDN) - Treasury Department';
/** What the stubbed list holds, by lower-cased name. */
let listed = new Map<string, unknown[]>();
let cslDown = false;
const cslCalls: string[] = [];

function entry(name: string, id: string, score = 96) {
  return { id, name, source: SDN, score, type: 'Individual', programs: ['SDGT'], addresses: [{ country: 'IR' }] };
}

let tenant: Pick<TenantRow, 'id' | 'slug'>;
let adminKey: string;
let operatorId: string | null = null;
const createdTenantIds: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

async function operatorCookie(): Promise<string> {
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email: OPS_EMAIL }).first();
  const admin =
    existing ?? { id: ulid(), email: OPS_EMAIL, name: 'Ops', role: 'admin' as const, createdAt: new Date(), revokedAt: null };
  if (!existing) await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  operatorId = admin.id;
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

async function seedPartner(opts: { connect: boolean; name?: string }): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: tenant.id,
    email: `p-${rnd()}@screening.test`,
    name: opts.name ?? `Partner ${rnd()}`,
    stripeConnectAccountId: opts.connect ? `acct_${id.slice(0, 10)}` : null,
    metadata: opts.connect ? { stripe: { payoutsEnabled: true } } : {},
  });
  return id;
}

/** One conversion credited to the partner, with one approved commission. */
async function seedCommission(partnerId: string, amount = '50.00'): Promise<string> {
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: tenant.id,
    name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 100 }]),
    destinationUrl: 'https://x.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({ id: clickId, tenantId: tenant.id, partnerId, programId, landingUrl: 'https://x.test/', ts: new Date() });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: tenant.id,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: amount,
    currency: 'USD',
    ts: new Date(),
  });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: tenant.id,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  const commissionId = ulid();
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId: tenant.id,
    partnerId,
    attributionId,
    amount,
    currency: 'USD',
    status: 'approved',
  });
  return commissionId;
}

async function declare(partnerId: string, country: string): Promise<void> {
  await recordLocationDeclaration(db, {
    subjectKind: 'partner',
    subjectId: partnerId,
    tenantId: tenant.id,
    country,
    ipCountry: null,
    source: 'join',
    declaredByEmail: null,
  });
}

async function plan(trxDb: Knex = db) {
  return trxDb.transaction((trx) => runPayouts(trx, tenant.id));
}

async function screeningsOf(subjectId: string): Promise<SanctionsScreeningRow[]> {
  return db<SanctionsScreeningRow>(TABLES.SanctionsScreening).where({ subjectId }).orderBy('screenedAt', 'asc');
}

async function commission(id: string) {
  return (await db(TABLES.Commission).where({ id }).first()) as { status: string; payoutId: string | null };
}

/** Review a screening as the ops console does. */
async function review(id: string, decision: 'cleared' | 'confirmed_match', note?: string) {
  return request(app)
    .post(`/platform-admin/screenings/${id}/review`)
    .set('Cookie', await operatorCookie())
    .send({ decision, note });
}

const asAdmin = () => ({ Authorization: `Bearer ${adminKey}` });

/** Put the tenant on the hosted funded rail: a plan, the flag, and a
 *  funding authorization. */
async function enableFundedRail(): Promise<void> {
  await db(TABLES.Tenant)
    .where({ id: tenant.id })
    .update({ billingPlan: 'flex', stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test' });
  process.env.HOSTED_FUNDING_ENABLED = '1';
  await db(TABLES.HostedFundingAuthorization).insert({
    id: ulid(),
    tenantId: tenant.id,
    adminId: null,
    termsVersion: 'test',
    stripePaymentMethodId: 'pm_x',
    paymentMethodType: 'us_bank_account',
    acceptedAt: new Date(),
    revokedAt: null,
  });
}

/** The brand's payment for the tenant's reserved batch settled: the state
 *  the funding executor picks up. */
async function fundOpenBatch(): Promise<HostedFundingBatchRow> {
  const batch = (await db(TABLES.HostedFundingBatch).where({ tenantId: tenant.id, status: 'reserved' }).first()) as
    | HostedFundingBatchRow
    | undefined;
  expect(batch).toBeDefined();
  await db(TABLES.HostedFundingBatch)
    .where({ id: batch!.id })
    .update({ status: 'funded', stripeChargeId: `ch_${batch!.id.slice(0, 12)}`, fundedAt: new Date() });
  return (await db(TABLES.HostedFundingBatch).where({ id: batch!.id }).first()) as HostedFundingBatchRow;
}

/** Stripe's transfers API, recording every call that could move money. */
function stripeTransfers(createImpl?: () => Promise<never>) {
  const created: Array<{ id: string; amount: number; currency: string; destination?: string; transfer_group?: string; metadata: Record<string, string> }> = [];
  const create = vi.fn(
    async (
      params: { amount: number; currency: string; destination?: string; transfer_group?: string; metadata: Record<string, string> },
      _opts?: { idempotencyKey?: string },
    ) => {
      if (createImpl) return createImpl();
      const t = { id: `tr_${ulid()}`, ...params };
      created.push(t);
      return t;
    },
  );
  const list = vi.fn(async () => ({ data: [], has_more: false }));
  const retrieve = vi.fn(async (id: string) => created.find((t) => t.id === id) ?? { id, amount: 0, currency: 'usd', metadata: {} });
  const stripe = { transfers: { create, list, retrieve } } as unknown as Stripe;
  return { stripe, create, list };
}

/** Make these partners possible matches on tomorrow's daily rescreen
 *  (one rescreen: a second the same day screens nobody). Returns the first
 *  name's new screening. */
async function flagOnRescreen(...names: string[]): Promise<SanctionsScreeningRow> {
  names.forEach((name, i) => listed.set(name.toLowerCase(), [entry(name, `sdn-${i + 1}`)]));
  const tomorrow = new Date(Date.now() + screening.RESCREEN_AFTER_MS + 60_000);
  await screening.screenPayablePartners(db, { tenantId: tenant.id, now: tomorrow });
  const rows = await db<SanctionsScreeningRow>(TABLES.SanctionsScreening)
    .where({ tenantId: tenant.id, result: 'possible_match' })
    .whereIn('screenedName', names);
  expect(rows.map((r) => r.screenedName).sort()).toEqual([...names].sort());
  return rows.find((r) => r.screenedName === names[0])!;
}

const TENANT_TABLES = [
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingAllocation,
  TABLES.HostedFundingBatch,
  TABLES.HostedFundingAuthorization,
  TABLES.Payout,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.PartnerProgram,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Partner,
  TABLES.LocationDeclaration,
  TABLES.SanctionsScreening,
];

async function cleanTenant(tenantId: string) {
  for (const t of TENANT_TABLES) await db(t).where({ tenantId }).del();
}

async function stubbedList(name: string): Promise<unknown[]> {
  cslCalls.push(name);
  if (cslDown) throw new Error('csl_http_503');
  return listed.get(name.toLowerCase()) ?? [];
}

beforeAll(async () => {
  screening.setCslLookupForTesting(stubbedList);
  setIpCountryLookupForTesting(async () => 'US');
  if (skipIntegration) return;
  const id = ulid();
  tenant = { id, slug: `scr${rnd()}` };
  await db(TABLES.Tenant).insert({
    id,
    slug: tenant.slug,
    displayName: 'Screening Brand',
    status: 'active',
    approvalStatus: 'approved',
  });
  createdTenantIds.push(id);
  adminKey = (await createApiKeyRow(db, { tenantId: id, label: 'screening admin' })).plaintext;
});

beforeEach(async () => {
  listed = new Map();
  cslDown = false;
  cslCalls.length = 0;
  process.env.CSL_API_KEY = 'test-csl-key';
  if (skipIntegration) return;
  await cleanTenant(tenant.id);
  await db(TABLES.Tenant).where({ id: tenant.id }).update({
    payoutRailPreference: 'auto',
    payoutThresholdCents: 0,
    billingPlan: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  });
});

afterEach(async () => {
  process.env.OPENPARTNER_TENANCY = 'multi';
  if (fundingFlagBefore === undefined) delete process.env.HOSTED_FUNDING_ENABLED;
  else process.env.HOSTED_FUNDING_ENABLED = fundingFlagBefore;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  screening.setCslLookupForTesting(null);
  setIpCountryLookupForTesting(null);
  if (cslKeyBefore === undefined) delete process.env.CSL_API_KEY;
  else process.env.CSL_API_KEY = cslKeyBefore;
  if (!skipIntegration) {
    await screening.settleBackgroundScreeningsForTesting();
    for (const tenantId of createdTenantIds) {
      await cleanTenant(tenantId);
      for (const t of [TABLES.ApiKey, TABLES.Admin, TABLES.MagicLinkToken, TABLES.Session, TABLES.Config]) {
        await db(t).where({ tenantId }).del();
      }
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
    // The brand backfill sweep screens every live brand, not only ours.
    await db(TABLES.SanctionsScreening).where('screenedAt', '>=', fileStartedAt).del();
    await db(TABLES.PlatformAuditLog).where({ platformAdminEmail: OPS_EMAIL }).del();
    if (operatorId) {
      await db(TABLES.PlatformAdminSession).where({ platformAdminId: operatorId }).del();
      await db(TABLES.PlatformAdmin).where({ id: operatorId }).del();
    }
  }
  await db.destroy();
});

// --------------------------------------------------------------------------

describe('the Consolidated Screening List client', () => {
  it('sends a fuzzy name search with the subscription key, and keeps only entries at the match threshold', async () => {
    screening.setCslLookupForTesting(null);
    try {
      const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            results: [entry('Ivan Listed', 'e1', 100), entry('Ivana Lister', 'e2', 70), { name: 'No Score', source: SDN }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const outcome = await screening.screenName('  Ivan   Listed ');

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(`${url.origin}${url.pathname}`).toBe('https://data.trade.gov/consolidated_screening_list/v1/search');
      expect(url.searchParams.get('name')).toBe('  Ivan   Listed ');
      expect(url.searchParams.get('fuzzy_name')).toBe('true');
      expect((init!.headers as Record<string, string>)['subscription-key']).toBe('test-csl-key');
      expect(outcome.result).toBe('possible_match');
      // Score 70 is under the threshold; an entry with no score counts.
      expect(outcome.matches.map((m) => [m.name, m.score])).toEqual([
        ['Ivan Listed', 100],
        ['No Score', null],
      ]);
      expect(outcome.matches[0]).toMatchObject({ source: SDN, entryId: 'e1', programs: ['SDGT'], countries: ['IR'] });

      fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
      expect(await screening.screenName('Anyone')).toEqual({ result: 'error', matches: [], errorDetail: 'csl_http_503' });

      delete process.env.CSL_API_KEY;
      fetchMock.mockClear();
      expect((await screening.screenName('Anyone')).result).toBe('skipped');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      screening.setCslLookupForTesting(stubbedList);
    }
  });
});

describe('pacing calls to the list', () => {
  // trade.gov answered 429 after ~17 calls in 2s on the first prod sweep.
  let sleeps: number[];
  let fetchMock: ReturnType<typeof vi.fn>;
  const ok = () =>
    new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const limited = (retryAfter?: string) =>
    new Response('rate limited', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

  beforeEach(() => {
    sleeps = [];
    screening.setCslLookupForTesting(null);
    // Record the waits instead of sleeping: time stands still, so every
    // wait shows the full gap the pacing asked for.
    screening.setCslPacingForTesting({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    screening.setCslPacingForTesting(null);
    screening.setCslLookupForTesting(stubbedList);
  });

  it('spaces calls out, one after another', async () => {
    for (const name of ['One', 'Two', 'Three']) await screening.screenName(name);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThan(400);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThan(900);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it('queues concurrent callers into their own slots instead of bunching them', async () => {
    await Promise.all(['One', 'Two', 'Three'].map((n) => screening.screenName(n)));

    const waits = [...sleeps].sort((a, b) => a - b);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(400);
    expect(waits[1]).toBeGreaterThan(900);
  });

  it('waits out Retry-After on a 429, then retries and gets the answer', async () => {
    fetchMock.mockResolvedValueOnce(limited('3')).mockResolvedValueOnce(ok());

    const outcome = await screening.screenName('Anyone');

    expect(outcome.result).toBe('clear');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2900);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it('waits a default 2s when a 429 gives no Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());

    expect((await screening.screenName('Anyone')).result).toBe('clear');
    expect(sleeps[0]).toBeGreaterThan(1900);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it('records an error once the retries are spent, never a clear', async () => {
    fetchMock.mockImplementation(async () => limited('1'));

    const outcome = await screening.screenName('Anyone');

    expect(outcome).toEqual({ result: 'error', matches: [], errorDetail: 'csl_http_429' });
    // The first try and two retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't wait out a Retry-After longer than 30s: that's an error for the next sweep", async () => {
    fetchMock.mockResolvedValueOnce(limited('120'));

    expect((await screening.screenName('Anyone')).errorDetail).toBe('csl_http_429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    const now = Date.UTC(2026, 9, 19, 21, 0, 0);
    expect(screening.retryAfterMs('7', now)).toBe(7000);
    expect(screening.retryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(screening.retryAfterMs(new Date(now - 5000).toUTCString(), now)).toBe(0);
    expect(screening.retryAfterMs('soon', now)).toBeNull();
    expect(screening.retryAfterMs(null, now)).toBeNull();
  });
});

describe.skipIf(skipIntegration)('payout holds', () => {
  it('holds a Connect partner whose declared country is blocked, and pays the others', async () => {
    const held = await seedPartner({ connect: true });
    const heldCommission = await seedCommission(held);
    await declare(held, 'IR');
    const clean = await seedPartner({ connect: true });
    await seedCommission(clean);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const result = await plan();

    expect(result.heldForCompliance).toEqual([
      { partnerId: held, currency: 'USD', amount: 50, reason: 'country_not_supported' },
    ]);
    expect(result.payouts.map((p) => p.partnerId)).toEqual([clean]);
    expect(await commission(heldCommission)).toMatchObject({ status: 'approved', payoutId: null });
    expect(await db(TABLES.Payout).where({ partnerId: held })).toHaveLength(0);
  });

  it('holds a partner whose screening is a possible match nobody has reviewed', async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const commissionId = await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const result = await plan();

    expect(result.heldForCompliance).toEqual([{ partnerId, currency: 'USD', amount: 50, reason: 'screening_review' }]);
    expect(result.payouts).toEqual([]);
    expect(await commission(commissionId)).toMatchObject({ status: 'approved', payoutId: null });
  });

  it('keeps holding a partner after an operator confirms the match', async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const [row] = await screeningsOf(partnerId);

    const res = await review(row!.id, 'confirmed_match', 'Same DOB and address as the SDN entry');
    expect(res.status).toBe(200);
    expect(res.body.brandRejected).toBe(false);

    const result = await plan();
    expect(result.heldForCompliance).toEqual([{ partnerId, currency: 'USD', amount: 50, reason: 'screening_confirmed' }]);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'screening.confirmed_match', targetId: partnerId });
    expect(audit).toHaveLength(1);
  });

  it("holds a partner screening hasn't answered for yet, and pays them once it has", async () => {
    const partnerId = await seedPartner({ connect: true });
    await seedCommission(partnerId);

    const first = await plan();
    expect(first.heldForCompliance).toEqual([{ partnerId, currency: 'USD', amount: 50, reason: 'screening_pending' }]);

    // The list is down: still pending, still held.
    cslDown = true;
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    expect((await screeningsOf(partnerId)).map((r) => r.result)).toEqual(['error']);
    expect((await plan()).heldForCompliance.map((h) => h.reason)).toEqual(['screening_pending']);

    cslDown = false;
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const paid = await plan();
    expect(paid.heldForCompliance).toEqual([]);
    expect(paid.payouts).toMatchObject([{ partnerId, method: 'stripe_connect', status: 'pending' }]);
  });

  it("releases the hold when an operator clears the match, and the next run pays", async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const commissionId = await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    expect((await plan()).heldForCompliance).toHaveLength(1);
    const [row] = await screeningsOf(partnerId);

    // Clearing needs a reason on the record.
    expect((await review(row!.id, 'cleared')).body).toEqual({ error: 'note_required' });
    const res = await review(row!.id, 'cleared', 'Different person: listed entry is a vessel owner born 1951');
    expect(res.status).toBe(200);
    expect(await review(row!.id, 'confirmed_match')).toMatchObject({ status: 409, body: { error: 'already_reviewed' } });

    const result = await plan();
    expect(result.heldForCompliance).toEqual([]);
    expect(result.payouts).toMatchObject([{ partnerId, method: 'stripe_connect', status: 'pending' }]);
    expect((await commission(commissionId)).payoutId).toBe(result.payouts[0]!.payoutId);
    const [cleared] = await screeningsOf(partnerId);
    expect(cleared).toMatchObject({ decision: 'cleared', reviewedByEmail: OPS_EMAIL });
  });

  it('holds on the funded rail too: the held partner is never reserved', async () => {
    await enableFundedRail();
    const held = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const heldCommission = await seedCommission(held);
    const clean = await seedPartner({ connect: true });
    const cleanCommission = await seedCommission(clean);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const result = await plan();

    expect(result.heldForCompliance).toEqual([{ partnerId: held, currency: 'USD', amount: 50, reason: 'screening_review' }]);
    const allocations = await db(TABLES.HostedFundingAllocation).where({ tenantId: tenant.id });
    expect(allocations.map((a: { commissionId: string }) => a.commissionId)).toEqual([cleanCommission]);
    expect(await commission(heldCommission)).toMatchObject({ status: 'approved', payoutId: null });
  });

  it('only warns on the manual rail, where the brand sends the money itself', async () => {
    const partnerId = await seedPartner({ connect: false });
    const commissionId = await seedCommission(partnerId);
    await declare(partnerId, 'IR');
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const result = await plan();

    expect(result.heldForCompliance).toEqual([]);
    expect(result.payouts).toMatchObject([{ partnerId, method: 'manual', complianceWarning: 'country_not_supported' }]);
    expect((await commission(commissionId)).status).toBe('paid');
  });

  it('holds nothing for screening without a CSL key', async () => {
    delete process.env.CSL_API_KEY;
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);

    expect(await screening.screenPayablePartners(db, { tenantId: tenant.id })).toMatchObject({ skipped: 'no_key' });
    const result = await plan();
    expect(result.heldForCompliance).toEqual([]);
    expect(result.payouts).toHaveLength(1);
    expect(cslCalls).toEqual([]);
  });

  it('holds nothing on a self-hosted install, which applies its own rules', async () => {
    const partnerId = await seedPartner({ connect: true });
    await seedCommission(partnerId);
    await declare(partnerId, 'IR');
    process.env.OPENPARTNER_TENANCY = 'single';

    expect(await screening.screenPayablePartners(db, { tenantId: tenant.id })).toMatchObject({ skipped: 'single_tenant' });
    const result = await plan();
    expect(result.heldForCompliance).toEqual([]);
    expect(result.payouts).toHaveLength(1);
  });

  it('reads the hold records on the privileged pool when planning as the app role', async () => {
    const role = (await db.raw(
      `select 1 from pg_roles where rolname = 'openpartner_app' and not rolbypassrls`,
    )) as { rows: unknown[] };
    if (role.rows.length === 0) return;
    const partnerId = await seedPartner({ connect: true });
    await seedCommission(partnerId);
    await declare(partnerId, 'IR');

    // The app role has no grant on LocationDeclaration or SanctionsScreening:
    // a hold lookup on the tenant transaction would fail with
    // "permission denied" instead of holding.
    const result = await db.transaction(async (trx) => {
      await trx.raw('set local row_security = on');
      await trx.raw('set local role openpartner_app');
      await trx.raw(`select set_config('app.tenant_id', ?, true)`, [tenant.id]);
      return runPayouts(trx, tenant.id);
    });

    expect(result.heldForCompliance.map((h) => h.reason)).toEqual(['country_not_supported']);
  });
});

// A hold that appears after the planner ran: the daily rescreen, or a
// country blocked later. The planner check can't see it, so each rail's
// executor checks again before it posts a transfer.
describe.skipIf(skipIntegration)('holds that appear after planning', () => {
  it('cancels a direct-Connect intent, and its commissions go back to approved and unclaimed', async () => {
    const partnerId = await seedPartner({ connect: true });
    const commissionId = await seedCommission(partnerId);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const planned = await plan();
    expect(planned.payouts).toMatchObject([{ partnerId, method: 'stripe_connect', status: 'pending' }]);
    const payoutId = planned.payouts[0]!.payoutId;
    expect((await commission(commissionId)).payoutId).toBe(payoutId);

    await declare(partnerId, 'IR');
    const { stripe, create } = stripeTransfers();
    const result = await executePayoutTransfers(db, { tenantId: tenant.id, stripe });

    expect(create).not.toHaveBeenCalled();
    expect(result.canceled).toEqual([{ payoutId, reason: 'compliance_hold:country_not_supported' }]);
    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout.status).toBe('failed');
    expect(payout.metadata).toMatchObject({ transferState: 'canceled', lastError: 'compliance_hold:country_not_supported' });
    expect(await commission(commissionId)).toMatchObject({ status: 'approved', payoutId: null });

    // The next run holds them like any held partner's: no new intent.
    const next = await plan();
    expect(next.heldForCompliance).toEqual([{ partnerId, currency: 'USD', amount: 50, reason: 'country_not_supported' }]);
    expect(await db(TABLES.Payout).where({ partnerId })).toHaveLength(1);
  });

  it("doesn't re-post a direct-Connect intent that was already posted, and resumes once the hold lifts", async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const commissionId = await seedCommission(partnerId);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const payoutId = (await plan()).payouts[0]!.payoutId;
    // The first POST went out an hour ago and its answer was lost: the
    // transfer may exist. Past the retry cooldown, inside the key window.
    const postedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db(TABLES.Payout)
      .where({ id: payoutId })
      .update({
        metadata: db.raw(`"metadata" || ?::jsonb`, [
          JSON.stringify({ transferState: 'posted', postedAt, leaseAt: postedAt, attempts: 1 }),
        ]),
      });

    const flagged = await flagOnRescreen('Ivan Listed');
    const { stripe, create, list } = stripeTransfers();
    const held = await executePayoutTransfers(db, { tenantId: tenant.id, stripe });

    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(held).toMatchObject({ canceled: [], confirmed: [], skipped: 1 });
    expect((await db(TABLES.Payout).where({ id: payoutId }).first()).metadata.transferState).toBe('posted');
    // Not released: if the transfer exists, re-planning would pay twice.
    expect(await commission(commissionId)).toMatchObject({ status: 'approved', payoutId });

    expect((await review(flagged.id, 'cleared', 'Different person: the listed entry is a company')).status).toBe(200);
    const resumed = await executePayoutTransfers(db, { tenantId: tenant.id, stripe });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![1]).toMatchObject({ idempotencyKey: `payout_${payoutId}` });
    expect(resumed.confirmed.map((c) => c.payoutId)).toEqual([payoutId]);
    expect(await commission(commissionId)).toMatchObject({ status: 'paid', payoutId });
  });

  it('stops a funded transfer: allocations canceled, the batch settles with a residual, ops are emailed', async () => {
    const sent: Array<{ to: string; subject: string; text: string; tag?: string }> = [];
    await enableFundedRail();
    const held = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const heldCommission = await seedCommission(held);
    const clean = await seedPartner({ connect: true });
    const cleanCommission = await seedCommission(clean, '30.00');
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    expect((await plan()).heldForCompliance).toEqual([]);
    const batch = await fundOpenBatch();
    expect(Number(batch.principalMinor)).toBe(8000);

    // The daily rescreen flags one of them while the brand's payment settles.
    const flagged = await flagOnRescreen('Ivan Listed');
    __setMailerForTests({
      send: async (_ctx, msg) => {
        sent.push({ to: msg.to, subject: msg.subject, text: msg.text, tag: msg.tag });
      },
    });
    process.env.PLATFORM_OPS_EMAIL = 'ops-inbox@openpartner.test';
    try {
      const { stripe, create } = stripeTransfers();
      const result = await runTransferExecutor(db, { stripe });

      // Only the clean partner is paid.
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]![0]).toMatchObject({ amount: 3000, destination: `acct_${clean.slice(0, 10)}` });
      expect(result.heldForCompliance).toEqual([
        { batchId: batch.id, tenantId: tenant.id, partnerId: held, reason: 'screening_review', amountMinor: 5000, currency: 'usd' },
      ]);
      expect(await db(TABLES.HostedFundingTransfer).where({ partnerId: held })).toEqual([]);
      const allocations = (await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id })) as HostedFundingAllocationRow[];
      expect(Object.fromEntries(allocations.map((a) => [a.commissionId, a.state]))).toEqual({
        [heldCommission]: 'canceled',
        [cleanCommission]: 'transferred',
      });
      const settled = (await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()) as HostedFundingBatchRow;
      expect(settled).toMatchObject({ status: 'settled_with_residual', residualDisposition: null });
      expect(Number(settled.residualMinor)).toBe(5000);
      expect(await commission(heldCommission)).toMatchObject({ status: 'approved', payoutId: null });
      expect((await commission(cleanCommission)).status).toBe('paid');

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'ops-inbox@openpartner.test',
        tag: 'funded_transfer_compliance_hold',
        subject: '[Action] Funded payout stopped for a partner of Screening Brand: compliance hold',
      });
      expect(sent[0]!.text).toContain('Ivan Listed');
      expect(sent[0]!.text).toContain('50.00 USD');
      expect(sent[0]!.text).toContain(batch.id);

      // Nothing more to stop on the next tick: no second email.
      await runTransferExecutor(db, { stripe });
      expect(sent).toHaveLength(1);
    } finally {
      delete process.env.PLATFORM_OPS_EMAIL;
      __setMailerForTests(null);
    }

    // Cleared, but the brand's money for it is still in that batch's
    // residual: it isn't batched again until ops record a disposition.
    expect((await review(flagged.id, 'cleared', 'Different person: the listed entry is a company')).status).toBe(200);
    expect((await plan()).heldForCompliance).toEqual([]);
    expect(await db(TABLES.HostedFundingAllocation).where({ commissionId: heldCommission })).toHaveLength(1);

    await db(TABLES.HostedFundingBatch).where({ id: batch.id }).update({ residualDisposition: 'refund' });
    await plan();
    const live = await db(TABLES.HostedFundingAllocation).where({ commissionId: heldCommission, state: 'reserved' });
    expect(live).toHaveLength(1);
    expect(live[0].batchId).not.toBe(batch.id);
  });

  it('closes a funded intent Stripe refused, and never re-posts one that may have landed', async () => {
    await enableFundedRail();
    const refused = await seedPartner({ connect: true, name: 'Ivan Listed' });
    const refusedCommission = await seedCommission(refused);
    const posted = await seedPartner({ connect: true, name: 'Olga Listed' });
    const postedCommission = await seedCommission(posted);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    await plan();
    const batch = await fundOpenBatch();

    // Stripe refuses both first attempts, which leaves both intents
    // `failed` and their allocations transfer_pending...
    const refusing = stripeTransfers(async () => {
      throw Object.assign(new Error('Your destination account needs the transfers capability'), { statusCode: 400 });
    });
    await runTransferExecutor(db, { stripe: refusing.stripe });
    expect(refusing.create).toHaveBeenCalledTimes(2);
    // ...then Olga's retry goes out and its answer is lost.
    await db(TABLES.HostedFundingTransfer)
      .where({ partnerId: posted })
      .update({ state: 'posted', postedAt: new Date(Date.now() - 60 * 60 * 1000) });

    await flagOnRescreen('Ivan Listed', 'Olga Listed');
    const { stripe, create } = stripeTransfers();
    const result = await runTransferExecutor(db, { stripe });

    expect(create).not.toHaveBeenCalled();
    expect(result.heldForCompliance.map((h) => [h.partnerId, h.amountMinor])).toEqual([[refused, 5000]]);
    const intents = await db(TABLES.HostedFundingTransfer).where({ batchId: batch.id });
    expect(Object.fromEntries(intents.map((i: { partnerId: string; state: string }) => [i.partnerId, i.state]))).toEqual({
      [refused]: 'failed',
      [posted]: 'posted',
    });
    expect(intents.find((i: { partnerId: string }) => i.partnerId === refused).lastError).toBe('compliance_hold:screening_review');
    const allocations = (await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id })) as HostedFundingAllocationRow[];
    expect(Object.fromEntries(allocations.map((a) => [a.commissionId, a.state]))).toEqual({
      [refusedCommission]: 'canceled',
      // May already be paid at Stripe: stays claimed for the window to settle it.
      [postedCommission]: 'transfer_pending',
    });
    expect((await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first()).status).toBe('transferring');
    expect(await commission(refusedCommission)).toMatchObject({ status: 'approved', payoutId: null });
  });
});

describe.skipIf(skipIntegration)('the screening sweep', () => {
  it('screens a partner the first time they are payable, then at most daily', async () => {
    const payable = await seedPartner({ connect: true });
    await seedCommission(payable);
    const notPayable = await seedPartner({ connect: true });

    const first = await screening.screenPayablePartners(db, { tenantId: tenant.id });
    expect(first).toMatchObject({ due: 1, screened: 1 });
    expect((await screeningsOf(payable)).map((r) => [r.result, r.trigger])).toEqual([['clear', 'first_payable']]);
    expect(await screeningsOf(notPayable)).toEqual([]);

    // Within the day: nothing to do.
    expect(await screening.screenPayablePartners(db, { tenantId: tenant.id })).toMatchObject({ due: 0, screened: 0 });

    const tomorrow = new Date(Date.now() + screening.RESCREEN_AFTER_MS + 60_000);
    expect(await screening.screenPayablePartners(db, { tenantId: tenant.id, now: tomorrow })).toMatchObject({ screened: 1 });
    expect((await screeningsOf(payable)).map((r) => r.trigger)).toEqual(['first_payable', 'rescreen']);
  });

  it('screens a renamed partner again under the new name', async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Old Name' });
    await seedCommission(partnerId);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    await db(TABLES.Partner).where({ id: partnerId }).update({ name: 'New Name' });

    // Unscreened under the new name: held until screened.
    expect((await plan()).heldForCompliance.map((h) => h.reason)).toEqual(['screening_pending']);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    expect((await screeningsOf(partnerId)).map((r) => r.screenedName)).toEqual(['Old Name', 'New Name']);
  });

  it('carries a clearance across rescreens of the same list entries, and reopens on a new one', async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const [original] = await screeningsOf(partnerId);
    await review(original!.id, 'cleared', 'Different person');

    const day2 = new Date(Date.now() + screening.RESCREEN_AFTER_MS + 60_000);
    await screening.screenPayablePartners(db, { tenantId: tenant.id, now: day2 });
    const carried = (await screeningsOf(partnerId))[1]!;
    expect(carried).toMatchObject({
      result: 'possible_match',
      decision: 'cleared',
      reviewedByEmail: OPS_EMAIL,
      decisionCarriedFromId: original!.id,
    });
    expect((await plan()).heldForCompliance).toEqual([]);
    // Settle the payout that run planned, so the next one has a balance.
    await seedCommission(partnerId);

    // The list adds a new entry for the name: back to review.
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1'), entry('Ivan Listed', 'sdn-2', 90)]);
    const day3 = new Date(day2.getTime() + screening.RESCREEN_AFTER_MS + 60_000);
    await screening.screenPayablePartners(db, { tenantId: tenant.id, now: day3 });
    expect((await screeningsOf(partnerId))[2]).toMatchObject({ result: 'possible_match', decision: null });
    expect((await plan()).heldForCompliance.map((h) => h.reason)).toEqual(['screening_review']);

    // Only the latest answer can be reviewed.
    expect(await review(carried.id, 'confirmed_match')).toMatchObject({ status: 409, body: { error: 'already_reviewed' } });
    expect(await review(original!.id, 'confirmed_match')).toMatchObject({ status: 409 });
  });

  it('refuses to review a match a later screening has superseded', async () => {
    const partnerId = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(partnerId);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });
    const [stale] = await screeningsOf(partnerId);
    listed.delete('ivan listed');
    await screening.screenPayablePartners(db, {
      tenantId: tenant.id,
      now: new Date(Date.now() + screening.RESCREEN_AFTER_MS + 60_000),
    });

    expect(await review(stale!.id, 'confirmed_match')).toMatchObject({ status: 409, body: { error: 'superseded' } });
    // Delisted: the latest answer is clear, so nothing is held.
    expect((await plan()).heldForCompliance).toEqual([]);
  });

  it('emails ops once per sweep, listing every new possible match', async () => {
    const sent: Array<{ to: string; subject: string; text: string; tag?: string }> = [];
    __setMailerForTests({
      send: async (_ctx, msg) => {
        sent.push({ to: msg.to, subject: msg.subject, text: msg.text, tag: msg.tag });
      },
    });
    process.env.PLATFORM_OPS_EMAIL = 'ops-inbox@openpartner.test';
    try {
      for (const name of ['Ivan Listed', 'Olga Listed', 'Plain Partner']) {
        await seedCommission(await seedPartner({ connect: true, name }));
      }
      listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
      listed.set('olga listed', [entry('Olga Listed', 'sdn-2')]);

      await screening.screenPayablePartners(db, { tenantId: tenant.id });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'ops-inbox@openpartner.test',
        tag: 'sanctions_screening_review',
        subject: '[Action] Sanctions screening: 2 possible matches to review',
      });
      expect(sent[0]!.text).toContain('Ivan Listed');
      expect(sent[0]!.text).toContain('Olga Listed');
      expect(sent[0]!.text).not.toContain('Plain Partner');

      // Nothing new on the next sweep: no email.
      sent.length = 0;
      await screening.screenPayablePartners(db, { tenantId: tenant.id });
      expect(sent).toEqual([]);
    } finally {
      delete process.env.PLATFORM_OPS_EMAIL;
      __setMailerForTests(null);
    }
  });

  it('gives up after three errors in a row instead of waiting out every timeout', async () => {
    for (let i = 0; i < 5; i += 1) await seedCommission(await seedPartner({ connect: true }));
    cslDown = true;

    const result = await screening.screenPayablePartners(db, { tenantId: tenant.id });

    expect(result).toMatchObject({ due: 5, screened: 3, errors: 3, stoppedEarly: true });
  });
});

describe.skipIf(skipIntegration)('brand screening', () => {
  async function signup(displayName: string, adminName: string) {
    const slug = `scr${rnd()}`;
    const res = await request(app)
      .post('/signup')
      .send({ slug, displayName, adminEmail: `admin-${rnd()}@example.test`, adminName, plan: 'flex', country: 'GB' });
    expect(res.status).toBeLessThan(300);
    const created = (await db<TenantRow>(TABLES.Tenant).where({ slug }).first())!;
    createdTenantIds.push(created.id);
    await screening.settleBackgroundScreeningsForTesting();
    return created;
  }

  it('screens the brand and admin names at signup, and a confirmed match rejects the brand', async () => {
    listed.set('listed trading co', [{ ...entry('LISTED TRADING CO', 'sdn-9', 100), type: 'Entity' }]);
    const brand = await signup('Listed Trading Co', 'Ada Lovelace');

    const rows = await screeningsOf(brand.id);
    expect(rows.map((r) => [r.screenedName, r.result, r.trigger, r.country])).toEqual([
      ['Listed Trading Co', 'possible_match', 'signup', 'GB'],
      ['Ada Lovelace', 'clear', 'signup', 'GB'],
    ]);

    const cookie = await operatorCookie();
    const list = await request(app).get('/platform-admin/brands?status=pending').set('Cookie', cookie);
    const card = list.body.brands.find((b: { id: string }) => b.id === brand.id);
    expect(card.screenings.map((s: { screenedName: string; result: string }) => [s.screenedName, s.result])).toEqual([
      ['Ada Lovelace', 'clear'],
      ['Listed Trading Co', 'possible_match'],
    ]);

    const match = rows[0]!;
    const res = await review(match.id, 'confirmed_match', 'Registered address matches the listed entity');
    expect(res.body).toMatchObject({ ok: true, brandRejected: true });
    expect(await db<TenantRow>(TABLES.Tenant).where({ id: brand.id }).first()).toMatchObject({
      approvalStatus: 'rejected',
      status: 'suspended',
    });
    const actions = await db(TABLES.PlatformAuditLog).where({ targetId: brand.id }).pluck('action');
    expect(actions.sort()).toEqual(['brand.reject', 'screening.confirmed_match']);
  });

  it("doesn't screen an admin name that is only their mailbox name", async () => {
    const brand = await signup('Plain Brand', 'admin');
    await db(TABLES.Admin).where({ tenantId: brand.id }).update({ name: 'jane', email: 'jane@example.test' });
    await db(TABLES.SanctionsScreening).where({ subjectId: brand.id }).del();

    await screening.screenTenant(db, brand.id, 'ops');

    expect((await screeningsOf(brand.id)).map((r) => r.screenedName)).toEqual(['Plain Brand']);
  });

  it('records a skipped screening without a key, and the backfill screens the brand once a key is set', async () => {
    delete process.env.CSL_API_KEY;
    const brand = await signup('Unscreened Brand', 'Grace Hopper');
    expect((await screeningsOf(brand.id)).map((r) => r.result)).toEqual(['skipped', 'skipped']);

    process.env.CSL_API_KEY = 'test-csl-key';
    await screening.screenUnscreenedBrands(db);
    const rows = await screeningsOf(brand.id);
    expect(rows.slice(2).map((r) => [r.screenedName, r.result, r.trigger])).toEqual([
      ['Unscreened Brand', 'clear', 'backfill'],
      ['Grace Hopper', 'clear', 'backfill'],
    ]);

    // Screened once per name: the next sweep leaves it alone.
    cslCalls.length = 0;
    await screening.screenUnscreenedBrands(db);
    expect(cslCalls).not.toContain('Unscreened Brand');
  });
});

describe.skipIf(skipIntegration)('surfacing holds', () => {
  it('lists held partners to the brand admin, with what they are owed', async () => {
    const held = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(held, '30.00');
    await seedCommission(held, '12.50');
    const warned = await seedPartner({ connect: false });
    await seedCommission(warned);
    await declare(warned, 'CU');
    await seedCommission(await seedPartner({ connect: true }));
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const res = await request(app).get(`/t/${tenant.slug}/payouts/holds`).set(asAdmin());

    expect(res.status).toBe(200);
    const byPartner = new Map(res.body.holds.map((h: { partnerId: string }) => [h.partnerId, h]));
    expect(byPartner.size).toBe(2);
    expect(byPartner.get(held)).toMatchObject({
      partnerName: 'Ivan Listed',
      reason: 'screening_review',
      effect: 'held',
      owed: [{ currency: 'USD', amount: 42.5 }],
    });
    expect(byPartner.get(warned)).toMatchObject({ reason: 'country_not_supported', effect: 'warning' });
  });

  it('shows ops the review queue and every held partner', async () => {
    const held = await seedPartner({ connect: true, name: 'Ivan Listed' });
    await seedCommission(held);
    listed.set('ivan listed', [entry('Ivan Listed', 'sdn-1')]);
    await screening.screenPayablePartners(db, { tenantId: tenant.id });

    const res = await request(app).get('/platform-admin/screening').set('Cookie', await operatorCookie());

    expect(res.status).toBe(200);
    expect(res.body.cslConfigured).toBe(true);
    const queued = res.body.reviews.find((r: { subjectId: string }) => r.subjectId === held);
    expect(queued).toMatchObject({
      subjectKind: 'partner',
      screenedName: 'Ivan Listed',
      brandName: 'Screening Brand',
      partnerName: 'Ivan Listed',
      matches: [expect.objectContaining({ entryId: 'sdn-1', source: SDN })],
    });
    expect(res.body.held.find((h: { partnerId: string }) => h.partnerId === held)).toMatchObject({
      brandSlug: tenant.slug,
      reason: 'screening_review',
      effect: 'held',
    });
  });
});

describe.skipIf(skipIntegration)('POST /partners country', () => {
  async function create(body: Record<string, unknown>) {
    const email = `api-${rnd()}@screening.test`;
    const res = await request(app)
      .post(`/t/${tenant.slug}/partners`)
      .set(asAdmin())
      .send({ email, name: 'API Partner', sendInvite: false, programIds: [], ...body });
    return { res, email };
  }

  it('refuses a country the platform does not serve', async () => {
    const { res, email } = await create({ country: 'ir' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'country_not_supported' });
    expect(await db(TABLES.Partner).where({ email })).toEqual([]);
  });

  it('needs the occupied-regions confirmation for Ukraine', async () => {
    expect((await create({ country: 'UA' })).res.body).toEqual({ error: 'occupied_region_confirmation_required' });
    expect((await create({ country: 'UA', outsideOccupiedRegions: true })).res.status).toBe(201);
  });

  it('records an accepted country as an api declaration, which a later block holds on', async () => {
    const { res, email } = await create({ country: 'gb' });
    expect(res.status).toBe(201);
    const partner = await db(TABLES.Partner).where({ email }).first();
    await vi.waitFor(async () => {
      const rows = await db<LocationDeclarationRow>(TABLES.LocationDeclaration).where({ subjectId: partner.id });
      expect(rows).toMatchObject([{ subjectKind: 'partner', tenantId: tenant.id, country: 'GB', source: 'api' }]);
    });
  });

  it('accepts a partner without a country, as before', async () => {
    const { res, email } = await create({});
    expect(res.status).toBe(201);
    const partner = await db(TABLES.Partner).where({ email }).first();
    expect(await db(TABLES.LocationDeclaration).where({ subjectId: partner.id })).toEqual([]);
  });
});
