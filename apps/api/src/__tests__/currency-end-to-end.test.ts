/**
 * A non-USD brand end to end. An Oct 2026 verification as an INR brand found:
 *
 *   - currency stored as sent: "inr" became its own currency, its own
 *     commission currency and its own payout
 *   - a conversion with no currency stored as USD, whatever the brand
 *   - a `fixed` rule with currency INR booked its amount in the event's
 *     currency: a lead with no currency earned "100.00 USD"
 *   - the payout minimum capped at 100,000 hundredths: ₹5,000 was refused
 *   - dashboards adding rupees and dollars into one "$" total
 *
 * These lock in: every ingest path upper-cases and falls back to the
 * tenant's default currency; fixed amounts book in the rule's currency;
 * payouts group case-insensitively and the minimum is in the default
 * currency; reporting returns every currency apart.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { rotatePostbackToken } from '../conversion-postback.js';
import { runPayouts } from '../payouts.js';
import { commissionCurrency } from '../attribution.js';

const ADMIN_KEY = 'op_test_currency_e2e_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Program,
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.ConversionPostbackToken,
  TABLES.Partner,
  TABLES.Config,
];

const TENANT_COLUMNS = ['defaultCurrency', 'payoutThresholdCents', 'payoutRailPreference', 'couponIntegrationVerifiedAt'] as const;
type TenantSnapshot = Pick<TenantRow, (typeof TENANT_COLUMNS)[number]>;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
let tenantBefore: TenantSnapshot | undefined;

beforeAll(async () => {
  if (skipIntegration) return;
  tenantBefore = (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first(...TENANT_COLUMNS)) as TenantSnapshot;
});

afterAll(async () => {
  if (!skipIntegration) {
    await clean();
    if (tenantBefore) await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update(tenantBefore);
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
  await setTenant({ defaultCurrency: 'USD', payoutThresholdCents: null, payoutRailPreference: 'manual' });
});

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
}

async function setTenant(patch: Partial<TenantRow>): Promise<void> {
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update(patch);
}

/** A partner with one click on a program paying `commissionRule`. */
async function seedClick(commissionRule: unknown = [{ trigger: 'every', type: 'percent', value: 10 }]) {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const userId = `user-${ulid()}`;
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.test` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Refer & Earn',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify(commissionRule),
    destinationUrl: 'https://brand.example/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/',
    ts: new Date(Date.now() - 60_000),
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  return { partnerId, programId, clickId, userId };
}

function postEvent(body: Record<string, unknown>) {
  return request(app).post('/attribution/events').set(admin).send(body);
}

async function eventRow(eventId: string) {
  return db(TABLES.Event).where({ id: eventId }).first();
}

async function commissionsFor(eventId: string) {
  return db(TABLES.Commission)
    .join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
    .where(`${TABLES.Attribution}.eventId`, eventId)
    .select(`${TABLES.Commission}.amount`, `${TABLES.Commission}.currency`);
}

describe.skipIf(skipIntegration)('ingest: currency case and the tenant default', () => {
  it('/attribution/events upper-cases "inr" and books the commission in INR', async () => {
    const { userId } = await seedClick();
    const res = await postEvent({ userId, type: 'invoice_paid', value: 60_000, currency: 'inr', externalEventId: `inv-${ulid()}` });
    expect(res.status).toBe(200);
    expect((await eventRow(res.body.eventId)).currency).toBe('INR');
    expect(await commissionsFor(res.body.eventId)).toEqual([{ amount: '6000.00', currency: 'INR' }]);
  });

  it('an event without a currency is stored in the tenant default, not USD', async () => {
    await setTenant({ defaultCurrency: 'INR' });
    const { userId } = await seedClick();
    const res = await postEvent({ userId, type: 'invoice_paid', value: 25_000, externalEventId: `inv-${ulid()}` });
    expect((await eventRow(res.body.eventId)).currency).toBe('INR');
    expect(await commissionsFor(res.body.eventId)).toEqual([{ amount: '2500.00', currency: 'INR' }]);
  });

  it('a retry in another case replays instead of 409ing', async () => {
    const { userId } = await seedClick();
    const body = { userId, type: 'invoice_paid', value: 100, currency: 'inr', externalEventId: `inv-${ulid()}` };
    const first = await postEvent(body);
    const retry = await postEvent({ ...body, currency: 'INR' });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, eventId: first.body.eventId });
  });

  it('refuses a currency that is not three letters, and a null value', async () => {
    const { userId } = await seedClick();
    expect((await postEvent({ userId, type: 'invoice_paid', value: 1, currency: 'Rs.' })).status).toBe(400);
    expect((await postEvent({ userId, type: 'invoice_paid', value: null, currency: 'INR' })).status).toBe(400);
    expect((await postEvent({ userId, type: 'invoice_paid', value: '25000', currency: 'INR' })).status).toBe(400);
  });

  it('/attribution/conversions upper-cases and falls back to the tenant default', async () => {
    await setTenant({ defaultCurrency: 'INR' });
    const a = await seedClick();
    const lower = await request(app)
      .post('/attribution/conversions')
      .set(admin)
      .send({ clickId: a.clickId, type: 'invoice_paid', value: 10, currency: 'eur', externalEventId: `c-${ulid()}` });
    expect((await eventRow(lower.body.eventId)).currency).toBe('EUR');
    const b = await seedClick();
    const none = await request(app)
      .post('/attribution/conversions')
      .set(admin)
      .send({ clickId: b.clickId, type: 'invoice_paid', value: 10, externalEventId: `c-${ulid()}` });
    expect((await eventRow(none.body.eventId)).currency).toBe('INR');
  });

  it('/postback treats an unfilled currency macro as the tenant default and upper-cases a real one', async () => {
    await setTenant({ defaultCurrency: 'INR' });
    const { plaintext } = await rotatePostbackToken(db, DEFAULT_TENANT_ID);
    const a = await seedClick();
    const blank = await request(app).get(`/postback?token=${plaintext}&click_id=${a.clickId}&type=sale&amount=500&currency=&txn_id=t-${ulid()}`);
    expect(blank.status).toBe(200);
    const b = await seedClick();
    const lower = await request(app).get(`/postback?token=${plaintext}&click_id=${b.clickId}&type=sale&amount=5&currency=usd&txn_id=t-${ulid()}`);
    expect(lower.status).toBe(200);
    const rows = await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID }).orderBy('ts', 'asc').pluck('currency');
    expect(rows.sort()).toEqual(['INR', 'USD']);
  });

  it('/coupons/redeem stores the tenant default rather than null, and upper-cases', async () => {
    await setTenant({ defaultCurrency: 'INR' });
    const { partnerId, programId } = await seedClick();
    const code = `CUR${ulid().slice(-8)}`;
    await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId, code });
    const redeem = (body: Record<string, unknown>) =>
      request(app)
        .post('/coupons/redeem')
        .set(admin)
        .send({ code, eventType: 'invoice_paid', externalEventId: `ord-${ulid()}`, userId: `u-${ulid()}`, ...body });

    const none = await redeem({ value: 900 });
    expect(none.status).toBe(201);
    expect((await eventRow(none.body.eventId)).currency).toBe('INR');
    const lower = await redeem({ value: 9, currency: 'usd' });
    expect((await eventRow(lower.body.eventId)).currency).toBe('USD');
  });
});

describe.skipIf(skipIntegration)('fixed rules book in the rule currency', () => {
  it('a ₹100-per-lead rule pays ₹100 on a lead sent with no currency (tenant still on USD)', async () => {
    const { userId } = await seedClick([{ trigger: 'every', eventType: 'lead', type: 'fixed', value: 100, currency: 'INR' }]);
    const res = await postEvent({ userId, type: 'lead', externalEventId: `lead-${ulid()}` });
    expect((await eventRow(res.body.eventId)).currency).toBe('USD');
    expect(await commissionsFor(res.body.eventId)).toEqual([{ amount: '100.00', currency: 'INR' }]);
  });

  it('…and on an event in another currency: the amount is the rule’s, so is its currency', async () => {
    const { userId } = await seedClick([{ trigger: 'every', type: 'fixed', value: 100, currency: 'inr' }]);
    const res = await postEvent({ userId, type: 'invoice_paid', value: 49, currency: 'USD', externalEventId: `inv-${ulid()}` });
    expect(await commissionsFor(res.body.eventId)).toEqual([{ amount: '100.00', currency: 'INR' }]);
  });

  it('a fixed rule with no currency, and every percent rule, stay in the event currency', async () => {
    const { userId } = await seedClick([
      { trigger: 'every', type: 'fixed', value: 5 },
      { trigger: 'every', type: 'percent', value: 10, currency: 'INR' },
    ]);
    const res = await postEvent({ userId, type: 'invoice_paid', value: 200, currency: 'EUR', externalEventId: `inv-${ulid()}` });
    const rows = await commissionsFor(res.body.eventId);
    expect(rows.map((r) => `${r.amount} ${r.currency}`).sort()).toEqual(['20.00 EUR', '5.00 EUR']);
  });

  it('commissionCurrency, pure', () => {
    expect(commissionCurrency({ type: 'fixed', currency: 'inr' }, { currency: 'USD' })).toBe('INR');
    expect(commissionCurrency({ type: 'fixed' }, { currency: 'eur' })).toBe('EUR');
    expect(commissionCurrency({ type: 'percent', currency: 'INR' }, { currency: 'USD' })).toBe('USD');
    expect(commissionCurrency({ type: 'percent' }, { currency: null })).toBe('USD');
  });
});

describe.skipIf(skipIntegration)('payouts', () => {
  async function approvedCommission(partnerId: string, programId: string, clickId: string, amount: string, currency: string) {
    const eventId = ulid();
    const attributionId = ulid();
    await db(TABLES.Event).insert({ id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`, type: 'invoice_paid', value: amount, currency, ts: new Date() });
    await db(TABLES.Attribution).insert({ id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId, clickId, model: 'last_click', weight: '1' });
    await db(TABLES.Commission).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, attributionId, partnerId, amount, currency, status: 'approved' });
  }

  it('pays legacy "inr" and "INR" commissions as one INR payout', async () => {
    const { partnerId, programId, clickId } = await seedClick();
    await approvedCommission(partnerId, programId, clickId, '300.00', 'inr');
    await approvedCommission(partnerId, programId, clickId, '700.00', 'INR');
    const run = await db.transaction((trx) => runPayouts(trx, DEFAULT_TENANT_ID));
    expect(run.payouts.map((p) => `${p.amount} ${p.currency}`)).toEqual(['1000 INR']);
  });

  it('reads the minimum in the default currency: ₹5,000 holds ₹4,000, a $5 balance still pays', async () => {
    await setTenant({ defaultCurrency: 'INR', payoutThresholdCents: 500_000 });
    const a = await seedClick();
    await approvedCommission(a.partnerId, a.programId, a.clickId, '4000.00', 'INR');
    await approvedCommission(a.partnerId, a.programId, a.clickId, '5.00', 'USD');
    const run = await db.transaction((trx) => runPayouts(trx, DEFAULT_TENANT_ID));
    expect(run.skippedBelowThreshold).toEqual([{ partnerId: a.partnerId, currency: 'INR', amount: 4000 }]);
    expect(run.payouts.map((p) => `${p.amount} ${p.currency}`)).toEqual(['5 USD']);
  });
});

describe.skipIf(skipIntegration)('settings', () => {
  it('sets the default currency in Settings → Program (any case) and refuses a bad code', async () => {
    const ok = await request(app).post('/config/program').set(admin).send({ defaultCurrency: 'inr' });
    expect(ok.status).toBe(200);
    expect(ok.body.defaultCurrency).toBe('INR');
    expect((await request(app).get('/config/program').set(admin)).body.defaultCurrency).toBe('INR');
    expect((await request(app).post('/config/program').set(admin).send({ defaultCurrency: 'RUPEE' })).status).toBe(400);
  });

  it('accepts a ₹5,000 minimum payout and reports its currency', async () => {
    await setTenant({ defaultCurrency: 'INR' });
    const res = await request(app).post('/config/payouts').set(admin).send({ thresholdCents: 500_000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ thresholdCents: 500_000, thresholdCurrency: 'INR' });
    expect((await request(app).post('/config/payouts').set(admin).send({ thresholdCents: 1_000_000_001 })).status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('reporting never adds currencies together', () => {
  async function seedMix() {
    await setTenant({ defaultCurrency: 'INR' });
    const { partnerId, userId } = await seedClick();
    await postEvent({ userId, type: 'invoice_paid', value: 963_377, currency: 'INR', externalEventId: `a-${ulid()}` });
    await postEvent({ userId, type: 'invoice_paid', value: 85_000, currency: 'USD', externalEventId: `b-${ulid()}` });
    await postEvent({ userId, type: 'invoice_paid', value: 60_000, currency: 'inr', externalEventId: `c-${ulid()}` });
    return { partnerId };
  }

  it('partner dashboard: scalars in the default currency, every currency in the maps', async () => {
    const { partnerId } = await seedMix();
    const res = await request(app).get(`/partners/${partnerId}/dashboard?includeLinks=true`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: 'INR',
      attributedEvents: 3,
      attributedRevenue: 1_023_377,
      attributedRevenueByCurrency: { INR: 1_023_377, USD: 85_000 },
      commissionByStatus: { accrued: 102_337.7 },
      commissionByCurrency: { INR: { accrued: 102_337.7 }, USD: { accrued: 8_500 } },
    });
    expect(res.body.links[0]).toMatchObject({ attributedRevenue: 1_023_377, attributedRevenueByCurrency: { INR: 1_023_377, USD: 85_000 } });
  });

  it('admin overview: totals and partner rows per currency', async () => {
    const { partnerId } = await seedMix();
    const res = await request(app).get('/admin/overview').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      currency: 'INR',
      attributedRevenue: 1_023_377,
      attributedRevenueByCurrency: { INR: 1_023_377, USD: 85_000 },
      commissionAccrued: 102_337.7,
      commissionByCurrency: { INR: { accrued: 102_337.7 }, USD: { accrued: 8_500 } },
    });
    const row = res.body.partners.find((p: { id: string }) => p.id === partnerId);
    expect(row).toMatchObject({
      revenue: 1_023_377,
      revenueByCurrency: { INR: 1_023_377, USD: 85_000 },
      commission: { accrued: 102_337.7 },
      commissionByCurrency: { INR: { accrued: 102_337.7 }, USD: { accrued: 8_500 } },
    });
  });
});
