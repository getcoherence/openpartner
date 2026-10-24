/**
 * Payout statements (payout-statements.ts, GET /payouts/:id/statement):
 *
 *   - a payout's commissions, bonuses and netted refund clawbacks, each a
 *     line, with totals that agree with the amount paid;
 *   - totals per currency, never added across currencies, and amounts in
 *     each currency's own format;
 *   - masked payout details only, and every value escaped in the page;
 *   - a partner sees only their own payouts' statements;
 *   - tenant isolation on a pool that bypasses RLS, so only the explicit
 *     tenantId filters keep another tenant's rows out;
 *   - the payment reference a brand gives when it confirms a payout sent
 *     one at a time: validated, kept on the payout, printed unless a batch
 *     file's own reference is, scoped to the tenant, and never logged;
 *   - the brand's statement settings, including the tax-lines stub (off
 *     by default), and the statement URL on payout.created.
 *
 * Multi-tenant mode with DATABASE_URL_APP unset, as in
 * tenant-scope-no-rls.test.ts: the app pool runs as the privileged role,
 * so a query that leaned on RLS would leak here.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { expectShape } from './openapi-strict.js';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
delete process.env.DATABASE_URL_APP;
delete process.env.ADMIN_API_KEY; // env admin keys are valid on every tenant
// No sanctions screening. Set (not deleted) so dotenv doesn't fill it back in.
process.env.CSL_API_KEY = '';
process.env.PORTAL_URL = 'https://portal.statements.test';

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { runPayouts } = await import('../payouts.js');
const { savePayoutProfile, parsePayoutDetails } = await import('../payout-profile.js');
const { formatMoney } = await import('../payout-statements.js');
const { getApiBaseUrl } = await import('../portal-url.js');
const S = await import('../openapi/schemas.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const tag = () => ulid().slice(-6).toLowerCase();
const A = { id: `01STMTA${ulid().slice(7)}`, slug: `stmt-a-${tag()}` };
const B = { id: `01STMTB${ulid().slice(7)}`, slug: `stmt-b-${tag()}` };
const TENANTS = [A.id, B.id];

/** Delete every row of both tenants, children first (tenant-scope-no-rls.test.ts). */
async function wipe(): Promise<void> {
  const tables = (await db('information_schema.columns')
    .where({ table_schema: 'public', column_name: 'tenantId' })
    .pluck('table_name')) as string[];
  let pending = tables.filter((t) => t !== TABLES.Tenant);
  for (let pass = 0; pass < 8 && pending.length > 0; pass += 1) {
    const blocked: string[] = [];
    for (const t of pending) {
      try {
        await db(t).whereIn('tenantId', TENANTS).del();
      } catch {
        blocked.push(t);
      }
    }
    pending = blocked;
  }
  if (pending.length > 0) throw new Error(`wipe: could not clear ${pending.join(', ')}`);
}

// ---------- seeding ----------

async function seedProgram(tenantId: string, name: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: 'https://example.test/',
  });
  return id;
}

async function seedPartner(tenantId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId,
    name,
    email: `p-${id.toLowerCase()}@partner.test`,
    metadata: {},
    activatedAt: new Date(),
    ...extra,
  });
  return id;
}

async function seedPayout(
  tenantId: string,
  partnerId: string,
  amount: string,
  currency: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.Payout).insert({
    id,
    tenantId,
    partnerId,
    amount,
    currency,
    method: 'manual',
    status: 'paid',
    metadata: {},
    completedAt: new Date(),
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    ...extra,
  });
  return id;
}

/** An attributed sale's commission: event, attribution, commission. */
async function seedSale(
  tenantId: string,
  o: { partnerId: string; programId: string; amount: string; currency: string; payoutId: string | null; type?: string; accruedAt?: Date },
): Promise<string> {
  const eventId = ulid();
  const attributionId = ulid();
  const commissionId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId,
    userId: `u-${ulid()}`,
    type: o.type ?? 'invoice_paid',
    value: '1000.00',
    currency: o.currency,
    metadata: {},
    ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId,
    eventId,
    partnerId: o.partnerId,
    programId: o.programId,
    clickId: ulid(),
    model: 'last_click',
    weight: '1',
  });
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId,
    attributionId,
    partnerId: o.partnerId,
    amount: o.amount,
    currency: o.currency,
    status: o.payoutId ? 'paid' : 'approved',
    payoutId: o.payoutId,
    paidAt: o.payoutId ? new Date() : null,
    accruedAt: o.accruedAt ?? new Date('2026-10-01T12:00:00Z'),
    metadata: {},
  });
  return commissionId;
}

async function seedBonus(
  tenantId: string,
  o: { partnerId: string; programId: string; amount: string; currency: string; payoutId: string; note: string },
): Promise<string> {
  const bonusId = ulid();
  await db(TABLES.Bonus).insert({
    id: bonusId,
    tenantId,
    partnerId: o.partnerId,
    programId: o.programId,
    amount: o.amount,
    currency: o.currency,
    source: 'manual',
    note: o.note,
    createdAt: new Date('2026-10-05T12:00:00Z'),
  });
  await db(TABLES.Commission).insert({
    id: ulid(),
    tenantId,
    attributionId: null,
    bonusId,
    partnerId: o.partnerId,
    amount: o.amount,
    currency: o.currency,
    status: 'paid',
    payoutId: o.payoutId,
    paidAt: new Date(),
    accruedAt: new Date('2026-10-05T12:00:00Z'),
    metadata: { rateType: 'fixed' },
  });
  return bonusId;
}

async function seedClawback(tenantId: string, commissionId: string, amount: string, currency: string, payoutId: string | null): Promise<string> {
  const id = ulid();
  await db(TABLES.CommissionAdjustment).insert({
    id,
    tenantId,
    commissionId,
    amount,
    currency,
    reason: 'refund_clawback',
    appliedPayoutId: payoutId,
    metadata: {},
    createdAt: new Date('2026-10-10T08:00:00Z'),
  });
  return id;
}

async function saveDetails(tenantId: string, partnerId: string, details: unknown): Promise<void> {
  const parsed = parsePayoutDetails(details);
  if (!parsed.ok) throw new Error(`bad fixture: ${JSON.stringify(parsed.error)}`);
  await savePayoutProfile(db, tenantId, partnerId, parsed.details, 'partner');
}

const key = async (tenantId: string, extra: { partnerId?: string; scopes?: string[] } = {}) =>
  (await createApiKeyRow(db, { tenantId, label: 'statement test', ...extra })).plaintext;

const get = (tenant: { slug: string }, path: string, token: string | null) => {
  const t = request(app).get(`/t/${tenant.slug}${path}`);
  return token ? t.set('Authorization', `Bearer ${token}`) : t;
};

interface StatementJson {
  statement: {
    statementNumber: string;
    issuer: { name: string; tradingName: string | null; address: string | null; gstin: string | null };
    partner: { id: string; name: string | null; destination: string | null; destinationChanged: boolean };
    payout: {
      amount: string;
      currency: string;
      methodLabel: string;
      reference: { label: string; value: string } | null;
      sent: { amount: string; currency: string; rate: string; rateSource: string; rateDate: string } | null;
      status: string;
    };
    commissions: Array<{ description: string; programName: string | null; amount: string; currency: string; date: string }>;
    bonuses: Array<{ description: string; amount: string }>;
    clawbacks: Array<{ description: string; amount: string; commissionId: string }>;
    reversals: Array<{ description: string; amount: string }>;
    taxLines: Array<{ label: string; amount: string | null }>;
    totals: Array<{ currency: string; commissions: string; bonuses: string; clawbacks: string; net: string }>;
    notes: string[];
    footer: string | null;
  };
}

async function statementJson(tenant: { slug: string }, payoutId: string, token: string): Promise<StatementJson['statement']> {
  const res = await get(tenant, `/payouts/${payoutId}/statement?format=json`, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Strict: a field the route sends that the spec doesn't name fails here.
  expectShape(S.PayoutStatement, res.body.statement, 'statement');
  return (res.body as StatementJson).statement;
}

let aAdmin = '';
let bAdmin = '';
let programId = '';

beforeAll(async () => {
  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  await db(TABLES.Tenant).insert([
    { id: A.id, slug: A.slug, displayName: 'Volza', status: 'active', approvalStatus: 'approved', defaultCurrency: 'INR' },
    { id: B.id, slug: B.slug, displayName: 'Other Brand', status: 'active', approvalStatus: 'approved' },
  ]);
});

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
  aAdmin = await key(A.id);
  bAdmin = await key(B.id);
  programId = await seedProgram(A.id, 'Refer & Earn');
});

afterAll(async () => {
  if (!skipIntegration) {
    await wipe();
    await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  }
  await db.destroy();
  await appDb.destroy();
});

describe('formatMoney', () => {
  it("formats each currency its own way, keeping fractions a whole-unit currency's line has", () => {
    expect(formatMoney('125000.50', 'INR')).toBe('₹1,25,000.50');
    expect(formatMoney('1234.50', 'USD')).toBe('$1,234.50');
    expect(formatMoney('-120.00', 'INR')).toBe('-₹120.00');
    expect(formatMoney('1001.00', 'JPY')).toBe('¥1,001');
    expect(formatMoney('1000.50', 'JPY')).toBe('¥1,000.50');
    expect(formatMoney('5.00', 'XYZ1')).toBe('5.00 XYZ1');
  });
});

describe('statement URL', () => {
  it('points at the API through the portal origin, tenant-scoped the way requests are', () => {
    expect(getApiBaseUrl({ slug: 'volza' })).toBe('https://portal.statements.test/api/t/volza');
    expect(getApiBaseUrl({ slug: 'volza', customDomain: 'partners.volza.test' })).toBe('https://partners.volza.test/api');
    process.env.OPENPARTNER_TENANCY = 'single';
    try {
      expect(getApiBaseUrl({ slug: 'default' })).toBe('https://portal.statements.test/api');
    } finally {
      process.env.OPENPARTNER_TENANCY = 'multi';
    }
  });
});

describe.skipIf(skipIntegration)('GET /payouts/:id/statement', () => {
  it('lists commissions, bonuses and refund clawbacks, and totals them to the amount paid', async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    await saveDetails(A.id, ada, { method: 'upi', vpa: 'ada.pay@okaxis', name: 'Ada Rao' });
    await db(TABLES.HostedBillingProfile).insert({ tenantId: A.id, daysUntilDue: 15, graceDays: 7, gstin: '27AAPFU0939F1ZV' });
    expect(
      (await request(app)
        .post(`/t/${A.slug}/config/payout-statements`)
        .set('Authorization', `Bearer ${aAdmin}`)
        .send({ legalName: 'Volza Technologies Pvt Ltd', address: '12 MG Road\nBengaluru 560001', numberPrefix: 'VZ-', footer: 'Questions? payouts@volza.test' })).status,
    ).toBe(200);

    // An earlier payout paid a sale that was later refunded: its clawback
    // comes off this one. 1,500.00 + 250.50 + 100.00 − 120.00 = 1,730.50.
    const earlier = await seedPayout(A.id, ada, '120.00', 'INR');
    const refunded = await seedSale(A.id, { partnerId: ada, programId, amount: '120.00', currency: 'INR', payoutId: earlier, accruedAt: new Date('2026-09-14T00:00:00Z') });
    const payout = await seedPayout(A.id, ada, '1730.50', 'INR', {
      metadata: { runId: ulid(), netting: { grossCents: 185050, clawbackCents: 12000, adjustmentIds: [] } },
    });
    await seedSale(A.id, { partnerId: ada, programId, amount: '1500.00', currency: 'INR', payoutId: payout });
    await seedSale(A.id, { partnerId: ada, programId, amount: '250.50', currency: 'INR', payoutId: payout, type: 'subscription_created' });
    await seedBonus(A.id, { partnerId: ada, programId, amount: '100.00', currency: 'INR', payoutId: payout, note: 'Diwali push' });
    await seedClawback(A.id, refunded, '-120.00', 'INR', payout);
    // Outstanding, not netted by this payout: not on its statement.
    await seedClawback(A.id, refunded, '-5.00', 'INR', null);

    const s = await statementJson(A, payout, aAdmin);
    expect(s.statementNumber).toBe(`VZ-${payout}`);
    expect(s.issuer).toMatchObject({ name: 'Volza Technologies Pvt Ltd', tradingName: 'Volza', address: '12 MG Road\nBengaluru 560001', gstin: '27AAPFU0939F1ZV' });
    expect(s.partner).toMatchObject({ id: ada, name: 'Ada Rao', destination: 'UPI a•••@okaxis', destinationChanged: false });
    expect(s.payout).toMatchObject({ amount: '1730.50', currency: 'INR', methodLabel: 'Manual · UPI', reference: null, status: 'paid' });
    expect(s.commissions.map((c) => [c.description, c.programName, c.amount])).toEqual([
      ['Invoice paid', 'Refer & Earn', '1500.00'],
      ['Subscription created', 'Refer & Earn', '250.50'],
    ]);
    expect(s.bonuses.map((b) => [b.description, b.amount])).toEqual([['Bonus: Diwali push', '100.00']]);
    expect(s.clawbacks).toEqual([
      expect.objectContaining({ commissionId: refunded, amount: '-120.00', description: 'Refund clawback: Invoice paid (earned 2026-09-14)' }),
    ]);
    expect(s.totals).toEqual([{ currency: 'INR', commissions: '1750.50', bonuses: '100.00', clawbacks: '-120.00', net: '1730.50' }]);
    expect(s.notes).toEqual([]);
    expect(s.taxLines).toEqual([]);

    const page = await get(A, `/payouts/${payout}/statement`, aAdmin);
    expect(page.status).toBe(200);
    expect(page.type).toBe('text/html');
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.text).toContain(`VZ-${payout}`);
    expect(page.text).toContain('GSTIN: 27AAPFU0939F1ZV');
    expect(page.text).toContain('12 MG Road<br>Bengaluru 560001');
    expect(page.text).toContain('₹1,500.00');
    expect(page.text).toContain('-₹120.00');
    expect(page.text).toContain('₹1,730.50');
    expect(page.text).toContain('Bonus: Diwali push');
    expect(page.text).toContain('Questions? payouts@volza.test');
    expect(page.text).toContain('It is not a tax invoice.');
    // Masked only.
    expect(page.text).not.toContain('ada.pay');
    expect(page.text).not.toMatch(/<script/i);
  });

  it('escapes everything it prints', async () => {
    const mallory = await seedPartner(A.id, '<script>alert(1)</script>');
    await db(TABLES.Program).where({ id: programId }).update({ name: '"><img src=x onerror=alert(1)>' });
    await request(app)
      .post(`/t/${A.slug}/config/payout-statements`)
      .set('Authorization', `Bearer ${aAdmin}`)
      .send({ footer: '</footer><script>alert(2)</script>' });
    const payout = await seedPayout(A.id, mallory, '10.00', 'USD', { metadata: { externalReference: '<script>alert(3)</script>' } });
    await seedSale(A.id, { partnerId: mallory, programId, amount: '10.00', currency: 'USD', payoutId: payout });

    const page = await get(A, `/payouts/${payout}/statement`, aAdmin);
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.text).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(page.text).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('totals each currency on its own, and formats each in its own way', async () => {
    const ravi = await seedPartner(A.id, 'Ravi Shah');
    const usd = await seedPayout(A.id, ravi, '40.00', 'USD');
    await seedSale(A.id, { partnerId: ravi, programId, amount: '40.00', currency: 'USD', payoutId: usd });
    // ¥1,000.50 is paid as ¥1,001: yen go out in whole units.
    const jpy = await seedPayout(A.id, ravi, '1001.00', 'JPY');
    await seedSale(A.id, { partnerId: ravi, programId, amount: '1000.50', currency: 'JPY', payoutId: jpy });
    // A payout whose lines don't share its currency (legacy lower-case
    // codes, or a hand-edited row): one total per currency, never summed.
    const mixed = await seedPayout(A.id, ravi, '300.00', 'INR');
    await seedSale(A.id, { partnerId: ravi, programId, amount: '200.00', currency: 'inr', payoutId: mixed });
    await seedSale(A.id, { partnerId: ravi, programId, amount: '100.00', currency: 'INR', payoutId: mixed });
    await seedSale(A.id, { partnerId: ravi, programId, amount: '15.00', currency: 'USD', payoutId: mixed });

    expect((await statementJson(A, usd, aAdmin)).totals).toEqual([
      { currency: 'USD', commissions: '40.00', bonuses: '0.00', clawbacks: '0.00', net: '40.00' },
    ]);

    const yen = await statementJson(A, jpy, aAdmin);
    expect(yen.totals).toEqual([{ currency: 'JPY', commissions: '1000.50', bonuses: '0.00', clawbacks: '0.00', net: '1000.50' }]);
    expect(yen.payout.amount).toBe('1001.00');
    expect(yen.notes).toEqual(['The amount paid is the net rounded to whole JPY: JPY is paid without fractions.']);
    const yenPage = (await get(A, `/payouts/${jpy}/statement`, aAdmin)).text;
    expect(yenPage).toContain('¥1,000.50');
    expect(yenPage).toContain('¥1,001');

    const both = await statementJson(A, mixed, aAdmin);
    expect(both.totals).toEqual([
      { currency: 'INR', commissions: '300.00', bonuses: '0.00', clawbacks: '0.00', net: '300.00' },
      { currency: 'USD', commissions: '15.00', bonuses: '0.00', clawbacks: '0.00', net: '15.00' },
    ]);
    expect(both.commissions.every((c) => c.currency === c.currency.toUpperCase())).toBe(true);
    const bothPage = (await get(A, `/payouts/${mixed}/statement`, aAdmin)).text;
    expect(bothPage).toContain('Net (INR)');
    expect(bothPage).toContain('Net (USD)');
  });

  it("shows a Stripe payout's masked account, its transfer, and any reversal", async () => {
    const lee = await seedPartner(A.id, 'Lee Park', { stripeConnectAccountId: 'acct_1PxYzAbCdEf9876' });
    const payout = await seedPayout(A.id, lee, '80.00', 'USD', {
      method: 'stripe_connect',
      stripeTransferId: 'tr_1Statement',
      status: 'partially_reversed',
      metadata: { destinationAccountId: 'acct_1PxYzAbCdEf9876', transferState: 'confirmed' },
    });
    await seedSale(A.id, { partnerId: lee, programId, amount: '80.00', currency: 'USD', payoutId: payout });
    await db(TABLES.PayoutReversal).insert({
      id: ulid(),
      tenantId: A.id,
      payoutId: payout,
      stripeReversalId: 'trr_1',
      amountMinor: '2500',
      reason: null,
      createdAt: new Date('2026-10-21T00:00:00Z'),
    });

    const s = await statementJson(A, payout, aAdmin);
    expect(s.partner.destination).toBe('Stripe account •••• 9876');
    expect(s.payout).toMatchObject({ methodLabel: 'Stripe Connect transfer', reference: { label: 'Stripe transfer', value: 'tr_1Statement' } });
    expect(s.reversals).toEqual([expect.objectContaining({ description: 'Stripe transfer reversed', amount: '-25.00' })]);
    expect(s.totals[0]!.net).toBe('80.00');
    expect(s.notes).toEqual(['Part of this transfer was reversed after it was paid.']);
    const page = (await get(A, `/payouts/${payout}/statement`, aAdmin)).text;
    expect(page).toContain('Kept after reversals');
    expect(page).toContain('$55.00');
    expect(page).not.toContain('acct_1PxYzAbCdEf9876');
  });

  it('says when a payout is not sent yet, or failed', async () => {
    const mo = await seedPartner(A.id, 'Mo Iyer');
    await saveDetails(A.id, mo, { method: 'paypal', email: 'mo.iyer@example.com' });
    const pending = await seedPayout(A.id, mo, '25.00', 'USD', { status: 'pending', completedAt: null });
    await seedSale(A.id, { partnerId: mo, programId, amount: '25.00', currency: 'USD', payoutId: pending });
    const failed = await seedPayout(A.id, mo, '30.00', 'USD', {
      method: 'stripe_connect',
      status: 'failed',
      completedAt: null,
      metadata: { error: 'stripe_connect_account_missing' },
    });

    const p = await statementJson(A, pending, aAdmin);
    expect(p.notes).toEqual(['Volza sends this payout itself, and hasn’t confirmed sending it yet.']);
    expect(p.partner.destination).toBe('PayPal m•••@example.com');
    expect((await get(A, `/payouts/${pending}/statement`, aAdmin)).text).toContain('Amount to be paid');

    const f = await statementJson(A, failed, aAdmin);
    expect(f.commissions).toEqual([]);
    expect(f.totals).toEqual([]);
    expect(f.notes[0]).toBe(
      'This payout failed because the partner hadn’t connected a Stripe account, and nothing was sent. Its commissions stay approved and are paid in a later payout.',
    );
    const page = (await get(A, `/payouts/${failed}/statement`, aAdmin)).text;
    expect(page).toContain('Payout amount');
    expect(page).toContain('No commissions are recorded on this payout.');

    // Cancelled with its commissions released: the partner wasn't paid by it.
    const canceled = await seedPayout(A.id, mo, '30.00', 'USD', {
      method: 'stripe_connect',
      status: 'failed',
      completedAt: null,
      metadata: { transferState: 'canceled', lastError: 'card_declined' },
    });
    expect((await statementJson(A, canceled, aAdmin)).notes).toEqual([
      'This payout failed, and the partner wasn’t paid by it. Its commissions are paid in a later payout.',
    ]);
    // Failed while a duplicate transfer is reviewed: money may have moved,
    // so it promises nothing.
    const review = await seedPayout(A.id, mo, '30.00', 'USD', {
      method: 'stripe_connect',
      status: 'failed',
      completedAt: null,
      metadata: { transferState: 'duplicate_review', destinationAccountId: 'acct_review0001' },
    });
    expect((await statementJson(A, review, aAdmin)).notes).toEqual(['This payout is marked failed while it’s looked into. Ask Volza what was paid.']);
  });

  it('names the Stripe account a transfer was frozen to, not the one the partner has now', async () => {
    const kai = await seedPartner(A.id, 'Kai Moana', { stripeConnectAccountId: 'acct_1NewAccount1111' });
    // A funded payout: the destination is on its funding transfer.
    const funded = await seedPayout(A.id, kai, '45.00', 'USD', { method: 'stripe_connect', stripeTransferId: 'tr_funded' });
    const batchId = ulid();
    const intentId = ulid();
    await db(TABLES.HostedFundingBatch).insert({
      id: batchId,
      tenantId: A.id,
      currency: 'usd',
      principalMinor: 4500,
      grossChargeMinor: 4500,
      status: 'settled',
      fundingAttempts: 0,
    });
    await db(TABLES.HostedFundingTransfer).insert({
      id: intentId,
      tenantId: A.id,
      batchId,
      partnerId: kai,
      currency: 'usd',
      amountMinor: 4500,
      destinationAccountId: 'acct_1OldAccount2222',
      idempotencyKey: `fbt:${intentId}`,
      state: 'confirmed',
      stripeTransferId: 'tr_funded',
      payoutId: funded,
    });
    await db(TABLES.Payout).where({ id: funded }).update({ metadata: { fundingBatchId: batchId, transferIntentId: intentId, commissionCount: 0 } });
    expect((await statementJson(A, funded, aAdmin)).partner.destination).toBe('Stripe account •••• 2222');

    // An older payout that froze no destination doesn't guess.
    const legacy = await seedPayout(A.id, kai, '15.00', 'USD', { method: 'stripe_connect', stripeTransferId: 'tr_legacy' });
    expect((await statementJson(A, legacy, aAdmin)).partner.destination).toBe('Stripe account (not recorded on this payout)');
  });

  it("names the batch file reference, and says when the partner's details changed since", async () => {
    const zoe = await seedPartner(A.id, 'Zoe Brandt');
    await saveDetails(A.id, zoe, { method: 'paypal', email: 'zoe@example.com' });
    await db(TABLES.PartnerPayoutProfile).where({ partnerId: zoe }).update({ updatedAt: new Date(Date.now() - 10 * 60_000) });
    const payout = await seedPayout(A.id, zoe, '60.00', 'USD', {
      completedAt: new Date(Date.now() - 60_000),
      metadata: { manualExport: { exportId: ulid(), provider: 'paypal', currency: 'USD', at: new Date(Date.now() - 120_000).toISOString(), by: 'admin' } },
    });
    let s = await statementJson(A, payout, aAdmin);
    expect(s.payout).toMatchObject({ methodLabel: 'Manual · PayPal Payouts', reference: { label: 'PayPal Customer ID', value: payout } });
    expect(s.partner.destinationChanged).toBe(false);

    await saveDetails(A.id, zoe, { method: 'paypal', email: 'zoe.new@example.com' });
    s = await statementJson(A, payout, aAdmin);
    expect(s.partner).toMatchObject({ destination: 'PayPal z•••@example.com', destinationChanged: true });
    // PayPal's reference is the payout id whatever the details say.
    expect(s.payout.reference).toEqual({ label: 'PayPal Customer ID', value: payout });
  });

  it('measures a change from when the batch file was made, and drops a Wise reference it can no longer vouch for', async () => {
    const ines = await seedPartner(A.id, 'Ines Duarte');
    const gbp = { method: 'bank', accountHolderName: 'Ines Duarte', country: 'GB', currency: 'GBP', accountNumber: '31926819', sortCode: '231470' };
    await saveDetails(A.id, ines, gbp);
    await db(TABLES.PartnerPayoutProfile).where({ partnerId: ines }).update({ updatedAt: new Date(Date.now() - 20 * 60_000) });
    // The file was made 10 minutes ago and the payout confirmed just now.
    const payout = await seedPayout(A.id, ines, '70.00', 'GBP', {
      completedAt: new Date(),
      metadata: { manualExport: { exportId: ulid(), provider: 'wise', currency: 'GBP', at: new Date(Date.now() - 10 * 60_000).toISOString(), by: 'admin' } },
    });
    let s = await statementJson(A, payout, aAdmin);
    expect(s.payout).toMatchObject({ methodLabel: 'Manual · Wise batch payment', reference: { label: 'Wise payment reference', value: payout.slice(-10) } });
    expect(s.partner.destinationChanged).toBe(false);

    // Details changed after the file but before the confirm: the money
    // went where the file said, so that's a change.
    await saveDetails(A.id, ines, { ...gbp, accountNumber: '55779911' });
    await db(TABLES.PartnerPayoutProfile).where({ partnerId: ines }).update({ updatedAt: new Date(Date.now() - 5 * 60_000) });
    s = await statementJson(A, payout, aAdmin);
    expect(s.partner.destinationChanged).toBe(true);
    expect(s.payout.reference).toBeNull();
  });

  it('shows what Pay with PayPal sent when it sent an INR balance in USD, and the frozen rate', async () => {
    const ravi = await seedPartner(A.id, 'Ravi Menon');
    await saveDetails(A.id, ravi, { method: 'paypal', email: 'ravi@example.com' });
    const conversion = { sourceAmount: '1500.00', sourceCurrency: 'INR', sentAmount: '18.75', sentCurrency: 'USD', rate: '0.0125', rateSource: 'ecb', rateDate: '2026-10-22' };
    const payout = await seedPayout(A.id, ravi, '1500.00', 'INR', {
      metadata: { manualExport: { exportId: ulid(), provider: 'paypal', currency: 'USD', at: new Date().toISOString(), by: 'admin', via: 'api', conversion } },
    });
    await seedSale(A.id, { partnerId: ravi, programId, amount: '1500.00', currency: 'INR', payoutId: payout });

    const s = await statementJson(A, payout, aAdmin);
    // The ledger stays in INR; what PayPal sent sits beside it.
    expect(s.payout).toMatchObject({ amount: '1500.00', currency: 'INR' });
    expect(s.payout.sent).toEqual({ amount: '18.75', currency: 'USD', rate: '0.0125', rateSource: 'ecb', rateDate: '2026-10-22' });
    expect(s.totals).toEqual([{ currency: 'INR', commissions: '1500.00', bonuses: '0.00', clawbacks: '0.00', net: '1500.00' }]);
    const page = (await get(A, `/payouts/${payout}/statement`, aAdmin)).text;
    expect(page).toContain('Sent as (ECB reference rate 0.0125 on 2026-10-22)');
    expect(page).toContain('$18.75');

    // A batch file has no conversion, whatever its metadata carries.
    const filed = await seedPayout(A.id, ravi, '900.00', 'INR', {
      metadata: { manualExport: { exportId: ulid(), provider: 'paypal', currency: 'INR', at: new Date().toISOString(), by: 'admin', conversion } },
    });
    expect((await statementJson(A, filed, aAdmin)).payout.sent).toBeNull();
  });

  it("lets a partner fetch their own statements, and answers another partner's as not found", async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    const bob = await seedPartner(A.id, 'Bob Lin');
    const adasPayout = await seedPayout(A.id, ada, '10.00', 'USD');
    const adaKey = await key(A.id, { partnerId: ada });
    const bobKey = await key(A.id, { partnerId: bob });

    expect((await get(A, `/payouts/${adasPayout}/statement`, adaKey)).status).toBe(200);
    const asBob = await get(A, `/payouts/${adasPayout}/statement`, bobKey);
    expect(asBob.status).toBe(404);
    expect(asBob.body).toEqual({ error: 'payout_not_found' });
    expect((await get(A, `/payouts/${adasPayout}/statement?format=json`, bobKey)).status).toBe(404);
    // Indistinguishable from a payout that doesn't exist.
    expect((await get(A, `/payouts/${ulid()}/statement`, bobKey)).body).toEqual({ error: 'payout_not_found' });

    // Scoped keys: payouts:read reads any payout's; other scopes don't.
    expect((await get(A, `/payouts/${adasPayout}/statement`, await key(A.id, { scopes: ['payouts:read'] }))).status).toBe(200);
    const wrongScope = await get(A, `/payouts/${adasPayout}/statement`, await key(A.id, { scopes: ['commissions:read'] }));
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body).toEqual({ error: 'forbidden_scope', required: 'payouts:read' });
    expect((await get(A, `/payouts/${adasPayout}/statement`, null)).status).toBe(401);
    expect((await get(A, `/payouts/${adasPayout}/statement?format=pdf`, aAdmin)).status).toBe(400);
  });

  it("never shows another tenant's payout or rows, even without RLS", async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await seedPayout(A.id, ada, '50.00', 'USD');
    await seedSale(A.id, { partnerId: ada, programId, amount: '50.00', currency: 'USD', payoutId: payout });

    // Tenant B's admin asks for A's payout on B's own address.
    expect((await get(B, `/payouts/${payout}/statement`, bAdmin)).status).toBe(404);
    // B's key on A's address isn't a credential there at all.
    expect((await get(A, `/payouts/${payout}/statement`, bAdmin)).status).toBe(401);

    // Rows in B that name A's payout: a commission claimed onto it and a
    // clawback stamped with it. RLS isn't there to hide them; the
    // statement's own tenant filters must.
    const bob = await seedPartner(B.id, 'Bob of B');
    const bProgram = await seedProgram(B.id, 'B program');
    const bSale = await seedSale(B.id, { partnerId: bob, programId: bProgram, amount: '999.00', currency: 'USD', payoutId: payout });
    await seedClawback(B.id, bSale, '-7.00', 'USD', payout);
    await db(TABLES.PayoutReversal).insert({
      id: ulid(),
      tenantId: B.id,
      payoutId: payout,
      stripeReversalId: 'trr_b',
      amountMinor: '100',
      reason: null,
    });
    await request(app)
      .post(`/t/${B.slug}/config/payout-statements`)
      .set('Authorization', `Bearer ${bAdmin}`)
      .send({ legalName: 'B Legal Name', footer: 'B footer' });

    const s = await statementJson(A, payout, aAdmin);
    expect(s.commissions.map((c) => c.amount)).toEqual(['50.00']);
    expect(s.clawbacks).toEqual([]);
    expect(s.reversals).toEqual([]);
    expect(s.totals).toEqual([{ currency: 'USD', commissions: '50.00', bonuses: '0.00', clawbacks: '0.00', net: '50.00' }]);
    expect(s.issuer.name).toBe('Volza');
    expect(s.footer).toBeNull();
    const page = (await get(A, `/payouts/${payout}/statement`, aAdmin)).text;
    expect(page).not.toContain('B Legal Name');
    expect(page).not.toContain('999');
  });
});

describe.skipIf(skipIntegration)('the payment reference given at confirm (POST /payouts/:id/confirm)', () => {
  const confirm = (tenant: { slug: string }, payoutId: string, token: string, body?: object, target = app) => {
    const t = request(target).post(`/t/${tenant.slug}/payouts/${payoutId}/confirm`).set('Authorization', `Bearer ${token}`);
    return body === undefined ? t : t.send(body);
  };
  const pendingPayout = (tenantId: string, partnerId: string, extra: Record<string, unknown> = {}) =>
    seedPayout(tenantId, partnerId, '1500.00', 'INR', { status: 'pending', completedAt: null, ...extra });

  it('keeps it on the payout and prints it on the statement, the partner’s copy too', async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    await saveDetails(A.id, ada, { method: 'upi', vpa: 'ada.pay@okaxis', name: 'Ada Rao' });
    const runId = ulid();
    const payout = await pendingPayout(A.id, ada, { metadata: { runId } });
    await seedSale(A.id, { partnerId: ada, programId, amount: '1500.00', currency: 'INR', payoutId: payout });

    const res = await confirm(A, payout, aAdmin, { reference: '  UPI 412345678901  ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectShape(S.Payout, res.body.payout, 'payout');
    expect(res.body.payout).toMatchObject({ status: 'paid', metadata: { runId, externalReference: 'UPI 412345678901' } });

    const s = await statementJson(A, payout, aAdmin);
    expect(s.payout).toMatchObject({
      status: 'paid',
      methodLabel: 'Manual · UPI',
      reference: { label: 'Payment reference', value: 'UPI 412345678901' },
    });
    expect(s.notes).toEqual([]);
    expect((await get(A, `/payouts/${payout}/statement`, aAdmin)).text).toContain('<dt>Payment reference</dt><dd>UPI 412345678901</dd>');
    const adaKey = await key(A.id, { partnerId: ada });
    expect((await statementJson(A, payout, adaKey)).payout.reference).toEqual({ label: 'Payment reference', value: 'UPI 412345678901' });
  });

  it('confirms without one as before: no body, an empty one, or a blank reference', async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    for (const body of [undefined, {}, { reference: '   ' }]) {
      const payout = await pendingPayout(A.id, ada);
      const res = await confirm(A, payout, aAdmin, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.payout.metadata).toEqual({});
      expect((await statementJson(A, payout, aAdmin)).payout.reference).toBeNull();
    }
    // A bundle from elsewhere may hold anything there: only text prints.
    const odd = await seedPayout(A.id, ada, '5.00', 'INR', { metadata: { externalReference: 42 } });
    expect((await statementJson(A, odd, aAdmin)).payout.reference).toBeNull();
  });

  it('refuses one that is too long or not one printable line, naming the rule rather than the value', async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await pendingPayout(A.id, ada);
    for (const reference of [`UTR${'9'.repeat(98)}`, 'UTR 1\nUTR 2', 'UTR\u0000123', 'UTR 123', 42]) {
      const res = await confirm(A, payout, aAdmin, { reference });
      expect(res.status, JSON.stringify(reference)).toBe(400);
      expect(res.body.error).toBe('invalid_body');
      expect(JSON.stringify(res.body)).not.toContain('UTR');
    }
    expect(await db(TABLES.Payout).where({ id: payout }).first()).toMatchObject({ status: 'pending', metadata: {}, completedAt: null });

    const res = await confirm(A, payout, aAdmin, { reference: 'x'.repeat(100) });
    expect(res.status).toBe(200);
    expect(res.body.payout.metadata.externalReference).toBe('x'.repeat(100));
  });

  it('records nothing on a payout it refuses, and the reference is fixed once confirmed', async () => {
    const lee = await seedPartner(A.id, 'Lee Park');
    const stripe = await seedPayout(A.id, lee, '80.00', 'USD', { method: 'stripe_connect', status: 'pending', completedAt: null });
    expect((await confirm(A, stripe, aAdmin, { reference: 'NOT-MANUAL' })).status).toBe(409);
    expect((await db(TABLES.Payout).where({ id: stripe }).first()).metadata).toEqual({});

    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await pendingPayout(A.id, ada);
    expect((await confirm(A, payout, aAdmin, { reference: 'FIRST' })).status).toBe(200);
    expect((await confirm(A, payout, aAdmin, { reference: 'SECOND' })).status).toBe(409);
    expect((await db(TABLES.Payout).where({ id: payout }).first()).metadata).toEqual({ externalReference: 'FIRST' });
  });

  it("prints a batch file's own reference over it, unless the file's can't be vouched for", async () => {
    const zoe = await seedPartner(A.id, 'Zoe Brandt');
    await saveDetails(A.id, zoe, { method: 'paypal', email: 'zoe@example.com' });
    const paypalStamp = { exportId: ulid(), provider: 'paypal', currency: 'USD', at: new Date().toISOString(), by: 'admin' };
    const paypal = await pendingPayout(A.id, zoe, { currency: 'USD', metadata: { manualExport: paypalStamp } });
    expect((await confirm(A, paypal, aAdmin, { reference: 'PP-BATCH-77' })).body.payout.metadata).toEqual({
      manualExport: paypalStamp,
      externalReference: 'PP-BATCH-77',
    });
    expect((await statementJson(A, paypal, aAdmin)).payout.reference).toEqual({ label: 'PayPal Customer ID', value: paypal });

    // A Wise reference is dropped once the partner's details change after
    // the file (payout-statements.ts): the brand's own then prints.
    const ines = await seedPartner(A.id, 'Ines Duarte');
    const gbp = { method: 'bank', accountHolderName: 'Ines Duarte', country: 'GB', currency: 'GBP', accountNumber: '31926819', sortCode: '231470' };
    await saveDetails(A.id, ines, gbp);
    await db(TABLES.PartnerPayoutProfile).where({ partnerId: ines }).update({ updatedAt: new Date(Date.now() - 20 * 60_000) });
    const wise = await pendingPayout(A.id, ines, {
      currency: 'GBP',
      metadata: { manualExport: { exportId: ulid(), provider: 'wise', currency: 'GBP', at: new Date(Date.now() - 10 * 60_000).toISOString(), by: 'admin' } },
    });
    expect((await confirm(A, wise, aAdmin, { reference: 'WISE-TRANSFER-123' })).status).toBe(200);
    expect((await statementJson(A, wise, aAdmin)).payout.reference).toEqual({ label: 'Wise payment reference', value: wise.slice(-10) });
    await saveDetails(A.id, ines, { ...gbp, accountNumber: '55779911' });
    expect((await statementJson(A, wise, aAdmin)).payout.reference).toEqual({ label: 'Payment reference', value: 'WISE-TRANSFER-123' });
  });

  it("never confirms or stamps another tenant's payout, even without RLS", async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await pendingPayout(A.id, ada);
    // B's admin on B's own address, then B's key on A's address.
    const asB = await confirm(B, payout, bAdmin, { reference: 'B-REF' });
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual({ error: 'payout_not_found' });
    expect((await confirm(A, payout, bAdmin, { reference: 'B-REF' })).status).toBe(401);
    expect(await db(TABLES.Payout).where({ id: payout }).first()).toMatchObject({ status: 'pending', metadata: {}, completedAt: null });

    // B confirming its own payout leaves A's statements alone.
    const bob = await seedPartner(B.id, 'Bob of B');
    const bPayout = await pendingPayout(B.id, bob);
    expect((await confirm(B, bPayout, bAdmin, { reference: 'B-REF' })).status).toBe(200);
    expect((await confirm(A, payout, aAdmin)).status).toBe(200);
    expect((await statementJson(A, payout, aAdmin)).payout.reference).toBeNull();
    expect((await get(A, `/payouts/${bPayout}/statement?format=json`, aAdmin)).status).toBe(404);
  });

  it('never writes the reference to the request log', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logged = createApp({ logDestination: sink });
    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await pendingPayout(A.id, ada);
    expect((await confirm(A, payout, aAdmin, { reference: 'UTR\nHDFCN52026102399887766' }, logged)).status).toBe(400);
    expect((await confirm(A, payout, aAdmin, { reference: 'UTR HDFCN52026102399887766' }, logged)).status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const log = lines.join('');
    expect(log).toContain(`/payouts/${payout}/confirm`);
    expect(log).not.toContain('HDFCN52026102399887766');
  });
});

describe.skipIf(skipIntegration)('statement settings', () => {
  const post = (body: object) => request(app).post(`/t/${A.slug}/config/payout-statements`).set('Authorization', `Bearer ${aAdmin}`).send(body);

  it('keeps what a change leaves out, clears with an empty value, and refuses a bad prefix', async () => {
    const empty = await get(A, '/config/payout-statements', aAdmin);
    expect(empty.body).toEqual({
      legalName: null,
      address: null,
      footer: null,
      numberPrefix: null,
      taxLines: { enabled: false, labels: ['Tax withheld'] },
    });
    expect((await post({ legalName: '  Volza Technologies  ', numberPrefix: 'VZ/2026-' })).body).toMatchObject({
      legalName: 'Volza Technologies',
      numberPrefix: 'VZ/2026-',
    });
    expect((await post({ footer: 'Thanks!' })).body).toMatchObject({ legalName: 'Volza Technologies', footer: 'Thanks!' });
    expect((await post({ legalName: '', footer: null })).body).toMatchObject({ legalName: null, footer: null, numberPrefix: 'VZ/2026-' });
    const bad = await post({ numberPrefix: 'VZ 2026' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_body');
    // Partners can't read or change them.
    const partnerKey = await key(A.id, { partnerId: await seedPartner(A.id, 'Ada Rao') });
    expect((await get(A, '/config/payout-statements', partnerKey)).status).toBe(403);
  });

  it('prints tax lines only when the brand turns the stub on, with no amount recorded', async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    const payout = await seedPayout(A.id, ada, '10.00', 'INR');
    expect((await statementJson(A, payout, aAdmin)).taxLines).toEqual([]);
    expect((await get(A, `/payouts/${payout}/statement`, aAdmin)).text).not.toContain('Not recorded');

    expect((await post({ taxLines: { enabled: true, labels: ['TDS withheld (194H)'] } })).status).toBe(200);
    const s = await statementJson(A, payout, aAdmin);
    expect(s.taxLines).toEqual([{ label: 'TDS withheld (194H)', amount: null, currency: 'INR' }]);
    expect(s.notes).toContain('Tax lines show only amounts recorded for this payout. A line with no amount has none recorded.');
    const page = (await get(A, `/payouts/${payout}/statement`, aAdmin)).text;
    expect(page).toContain('TDS withheld (194H)');
    expect(page).toContain('Not recorded');
  });
});

describe.skipIf(skipIntegration)('payout.created', () => {
  it("carries the payout's statement URL on the tenant's API address", async () => {
    const ada = await seedPartner(A.id, 'Ada Rao');
    await seedSale(A.id, { partnerId: ada, programId, amount: '75.00', currency: 'INR', payoutId: null });
    const result = await appDb.transaction((trx) => runPayouts(trx, A.id));
    expect(result.payouts).toHaveLength(1);
    const [notification] = result.pendingNotifications;
    expect(notification!.payout.statementUrl).toBe(
      `https://portal.statements.test/api/t/${A.slug}/payouts/${result.payouts[0]!.payoutId}/statement`,
    );
  });
});
