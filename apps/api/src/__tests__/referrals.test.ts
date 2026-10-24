/**
 * GET /partners/:id/referrals: each customer a partner referred, with the
 * stages the brand chose to show (POST /config/referrals) and what the
 * customer has earned the partner.
 *
 * The scenario is a CRM pipeline sent as events (Volza's Zoho stages):
 * lead_created → demo_booked → deal_won → invoice_paid, where only
 * deal_won and invoice_paid pay. Partners must see a customer move through
 * the stages the brand shows, never one it hides, never the brand's userId,
 * and never a customer label unless the brand turns those on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { REFERRAL_SETTINGS_CONFIG_KEY } from '../referrals.js';

const ADMIN_KEY = 'op_test_referrals_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
// No Stripe: auto-minted coupons would otherwise check codes against it.
process.env.STRIPE_SECRET_KEY = '';

const TABLES_TO_CLEAN = [
  TABLES.CommissionAdjustment,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.ApiKey,
  TABLES.Session,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const CRM_RULE = [
  { trigger: 'every', eventType: 'deal_won', type: 'fixed', value: 100 },
  { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10, recurring: true },
];
const CRM_STAGES = [
  { eventType: 'demo_booked', label: 'Demo booked' },
  { eventType: 'deal_won', label: 'Deal won' },
  { eventType: 'invoice_paid', label: 'Paid' },
];

interface Stage {
  eventType: string;
  label: string;
  firstAt: string;
  lastAt: string;
  count: number;
  reversed: boolean;
}
interface Referral {
  referralId: string;
  number: number;
  label: string;
  customerLabel: string | null;
  userId?: string;
  referredAt: string;
  stages: Stage[];
  latestStage: { eventType: string; label: string; at: string } | null;
  commission: number;
  commissionByCurrency: Record<string, number>;
}
interface ReferralPage {
  partnerId: string;
  stages: Array<{ eventType: string; label: string }>;
  currency: string;
  referrals: Referral[];
  total: number;
  nextCursor: string | null;
}

async function clean() {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: REFERRAL_SETTINGS_CONFIG_KEY }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) await clean();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
});

// Each scenario makes a few dozen API calls.
describe.skipIf(skipIntegration)('partner referral timeline', { timeout: 30_000 }, () => {
  it("shows a partner only their own referrals; admins and partners:read keys see any partner's", async () => {
    const program = await createProgram();
    await setStages({ stages: CRM_STAGES });
    const a = await createPartner();
    const b = await createPartner();
    const aCustomer = await referCustomer(a.id, program.id);
    await event(aCustomer, 'deal_won', 30);
    const bCustomer = await referCustomer(b.id, program.id);
    await event(bCustomer, 'deal_won', 30);
    const aKey = await partnerKey(a.id);

    // Partner A reads their own, never partner B's.
    const own = await getReferrals(a.id, aKey);
    expect(own.total).toBe(1);
    expect(own.referrals[0]!.stages.map((s) => s.eventType)).toEqual(['deal_won']);
    const other = await request(app).get(`/partners/${b.id}/referrals`).set('Authorization', `Bearer ${aKey}`);
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('forbidden');
    expect(JSON.stringify(other.body)).not.toContain(bCustomer);

    // The brand reads anyone's, with the userId.
    expect((await getReferrals(b.id)).referrals[0]!.userId).toBe(bCustomer);
    const reader = await scopedKey(['partners:read']);
    expect((await getReferrals(a.id, reader)).referrals[0]!.userId).toBe(aCustomer);
    const unrelated = await scopedKey(['links:read']);
    const denied = await request(app).get(`/partners/${a.id}/referrals`).set('Authorization', `Bearer ${unrelated}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');

    const missing = await request(app).get('/partners/nobody/referrals').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(missing.status).toBe(404);
  });

  it('never sends a partner the userId, here or on /customers and /events', async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const userId = await referCustomer(partner.id, program.id);
    await event(userId, 'demo_booked', 10);
    await event(userId, 'invoice_paid', 9, 500);
    const key = await partnerKey(partner.id);

    const asPartner = await request(app).get(`/partners/${partner.id}/referrals`).set('Authorization', `Bearer ${key}`);
    expect(asPartner.status).toBe(200);
    expect(JSON.stringify(asPartner.body)).not.toContain(userId);
    const ref = (asPartner.body as ReferralPage).referrals[0]!;
    expect(ref.userId).toBeUndefined();
    expect(ref.referralId).toMatch(/^ref_[A-Za-z0-9_-]{12}$/);
    // The cursor can't carry it either: it is keyed on an event id.
    const paged = await getReferrals(partner.id, key, { limit: '1' });
    expect(paged.nextCursor).toBeNull();

    const customers = await request(app).get(`/partners/${partner.id}/customers`).set('Authorization', `Bearer ${key}`);
    expect(customers.status).toBe(200);
    expect(JSON.stringify(customers.body)).not.toContain(userId);
    expect(customers.body.customers[0]).toMatchObject({ userId: null, referralId: ref.referralId });

    // The default stages show invoice_paid, not demo_booked.
    const events = await request(app).get(`/partners/${partner.id}/events`).set('Authorization', `Bearer ${key}`);
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).not.toContain(userId);
    expect(events.body.events.map((e: { type: string }) => e.type)).toEqual(['invoice_paid']);
    expect(events.body.events[0]).toMatchObject({ userId: null, referralId: ref.referralId });

    // The brand's own callers keep the userId and every type.
    const adminCustomers = await request(app).get(`/partners/${partner.id}/customers`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(adminCustomers.body.customers[0]).toMatchObject({ userId, referralId: ref.referralId });
    const adminEvents = await request(app).get(`/partners/${partner.id}/events`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(adminEvents.body.events.map((e: { type: string }) => e.type)).toEqual(['invoice_paid', 'demo_booked']);
  });

  it('keeps hidden stages hidden, while they still make the referral and count toward its commission', async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const key = await partnerKey(partner.id);
    await setStages({ stages: CRM_STAGES });

    // lead_created and the deal's stage are recorded, but the brand shows
    // only demo_booked / deal_won / invoice_paid.
    const won = await referCustomer(partner.id, program.id);
    await event(won, 'lead_created', 20);
    await event(won, 'demo_booked', 15);
    await event(won, 'deal_won', 10);
    await event(won, 'invoice_paid', 9, 1000);
    await event(won, 'invoice_paid', 5, 1000);
    // A customer who's only a lead so far: still a referral, no stage shown.
    const lead = await referCustomer(partner.id, program.id);
    await event(lead, 'lead_created', 2);

    const page = await getReferrals(partner.id, key);
    expect(page.stages).toEqual(CRM_STAGES);
    expect(page.total).toBe(2);
    expect(JSON.stringify(page)).not.toContain('lead_created');

    const [leadRef, wonRef] = page.referrals;
    expect(leadRef!.stages).toEqual([]);
    expect(leadRef!.latestStage).toBeNull();
    expect(leadRef!.commission).toBe(0);
    expect(wonRef!.stages.map((s) => [s.eventType, s.label, s.count])).toEqual([
      ['demo_booked', 'Demo booked', 1],
      ['deal_won', 'Deal won', 1],
      ['invoice_paid', 'Paid', 2],
    ]);
    const paid = wonRef!.stages[2]!;
    expect(paid.firstAt).toBe(daysAgoIso(9));
    expect(paid.lastAt).toBe(daysAgoIso(5));
    expect(wonRef!.latestStage).toEqual({ eventType: 'invoice_paid', label: 'Paid', at: daysAgoIso(9) });
    // 100 for the deal + 10% of two 1,000 invoices.
    expect(wonRef!.commission).toBe(300);
    expect(wonRef!.commissionByCurrency).toEqual({ USD: 300 });
    // referredAt is when they clicked the partner's link, never a hidden event's date.
    expect(wonRef!.referredAt).toBe(daysAgoIso(30));
    expect(JSON.stringify(page)).not.toContain(daysAgoIso(20));

    // /customers counts only shown stages for the partner: the lead-only
    // customer isn't there, and the hidden lead isn't counted or dated.
    const customers = await request(app).get(`/partners/${partner.id}/customers`).set('Authorization', `Bearer ${key}`);
    expect(customers.body.customers).toHaveLength(1);
    expect(customers.body.customers[0]).toMatchObject({ referralId: wonRef!.referralId, eventCount: 4, firstEventAt: daysAgoIso(15) });
    const brandView = await request(app).get(`/partners/${partner.id}/customers`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(brandView.body.customers).toHaveLength(2);

    // Hiding a stage that pays: the commission still counts, the stage doesn't show.
    await setStages({ stages: [{ eventType: 'demo_booked', label: 'Demo' }] });
    const narrowed = (await getReferrals(partner.id, key)).referrals[1]!;
    expect(narrowed.stages.map((s) => s.eventType)).toEqual(['demo_booked']);
    expect(narrowed.latestStage).toMatchObject({ eventType: 'demo_booked', label: 'Demo' });
    expect(narrowed.commission).toBe(300);
    const events = await request(app).get(`/partners/${partner.id}/events`).set('Authorization', `Bearer ${key}`);
    expect(events.body.events.map((e: { type: string }) => e.type)).toEqual(['demo_booked']);
  });

  it('shows the customer label only once the brand turns it on', async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const key = await partnerKey(partner.id);
    const userId = await referCustomer(partner.id, program.id);
    await event(userId, 'signup', 6, undefined, { customerLabel: 'Acme Tra' });
    await event(userId, 'invoice_paid', 4, 200, { customerLabel: '  Acme   Trading Co ' });
    await event(userId, 'invoice_paid', 2, 200);

    const off = (await getReferrals(partner.id, key)).referrals[0]!;
    expect(off).toMatchObject({ number: 1, label: 'Referral #1', customerLabel: null });
    expect(JSON.stringify(await getReferrals(partner.id, key))).not.toContain('Acme');

    const saved = await setStages({ showCustomerLabels: true });
    expect(saved.showCustomerLabels).toBe(true);
    // The stages kept their value: only the toggle was sent.
    expect(saved.stages.map((s: { eventType: string }) => s.eventType)).toEqual(['signup', 'trial_started', 'subscription_created', 'invoice_paid']);
    const on = (await getReferrals(partner.id, key)).referrals[0]!;
    // The newest label sent, tidied; the last event sent none.
    expect(on).toMatchObject({ label: 'Acme Trading Co', customerLabel: 'Acme Trading Co', number: 1 });

    await setStages({ showCustomerLabels: false });
    expect((await getReferrals(partner.id, key)).referrals[0]!.label).toBe('Referral #1');
  });

  it('pages newest referral first with a cursor, numbering in the order they became referrals', async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const key = await partnerKey(partner.id);
    // Five customers, each clicking and signing up a little later than the last.
    for (let i = 0; i < 5; i += 1) {
      const userId = await referCustomer(partner.id, program.id, 40 - i * 5);
      await event(userId, 'signup', 30 - i * 5);
    }
    // Two more who became referrals at the same instant still page apart.
    const twins: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const userId = await referCustomer(partner.id, program.id, 2);
      twins.push(await event(userId, 'signup', 1));
    }
    await db(TABLES.Attribution).whereIn('eventId', twins).update({ computedAt: new Date() });

    const seen: Referral[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ReferralPage = await getReferrals(partner.id, key, { limit: '1', ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(7);
      expect(page.referrals).toHaveLength(1);
      // The cursor is encrypted: no userId, no date.
      if (cursor) expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toMatch(/u-|20\d\d-/);
      seen.push(...page.referrals);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(7);
    expect(seen.map((r) => r.number)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(seen.map((r) => r.referralId)).size).toBe(7);
    expect(seen.map((r) => r.label)).toEqual(seen.map((r) => `Referral #${r.number}`));
    const firstFive = seen.slice(2).reverse();
    for (let i = 0; i < 5; i += 1) expect(firstFive[i]!.referredAt).toBe(daysAgoIso(40 - i * 5));
    expect((await getReferrals(partner.id, key, { limit: '3' })).referrals.map((r) => r.number)).toEqual([7, 6, 5]);

    // A new referral takes the next number; nobody else's changes.
    const late = await referCustomer(partner.id, program.id, 60);
    await event(late, 'signup', 0);
    const after = await getReferrals(partner.id, key, { limit: '8' });
    expect(after.referrals.map((r) => [r.number, r.referralId])).toEqual([
      [8, expect.any(String)],
      ...seen.map((r) => [r.number, r.referralId]),
    ]);
    expect(after.referrals[0]!.referredAt).toBe(daysAgoIso(60));

    const bad = await request(app).get(`/partners/${partner.id}/referrals?cursor=nope`).set('Authorization', `Bearer ${key}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_cursor');
    const tooMany = await request(app).get(`/partners/${partner.id}/referrals?limit=500`).set('Authorization', `Bearer ${key}`);
    expect(tooMany.status).toBe(400);
  });

  it('marks a stage reversed when its commission is reversed or clawed back, and leaves it out of the total', async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const key = await partnerKey(partner.id);
    await setStages({ stages: CRM_STAGES });
    const userId = await referCustomer(partner.id, program.id);
    await event(userId, 'demo_booked', 12);
    const deal = await event(userId, 'deal_won', 10);
    const invoice = await event(userId, 'invoice_paid', 8, 1000);

    // The brand reverses the deal's commission.
    const dealCommission = await commissionOf(deal);
    const reversed = await request(app).post(`/commissions/${dealCommission}/reverse`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(reversed.status).toBe(200);
    let ref = (await getReferrals(partner.id, key)).referrals[0]!;
    expect(ref.stages.map((s) => [s.eventType, s.reversed])).toEqual([
      ['demo_booked', false],
      ['deal_won', true],
      ['invoice_paid', false],
    ]);
    expect(ref.commission).toBe(100);
    expect(ref.latestStage?.eventType).toBe('invoice_paid');

    // The invoice's commission was paid, then refunded in full: a clawback.
    const invoiceCommission = await commissionOf(invoice);
    await db(TABLES.Commission).where({ id: invoiceCommission }).update({ status: 'paid', paidAt: new Date() });
    await db(TABLES.CommissionAdjustment).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      commissionId: invoiceCommission,
      amount: '-100.00',
      currency: 'USD',
      reason: 'refund_clawback',
      metadata: {},
    });
    ref = (await getReferrals(partner.id, key)).referrals[0]!;
    expect(ref.stages.map((s) => s.reversed)).toEqual([false, true, true]);
    expect(ref.commission).toBe(0);
    expect(ref.commissionByCurrency).toEqual({});
    // A stage that never paid isn't "reversed": the demo is still the furthest live stage.
    expect(ref.latestStage).toMatchObject({ eventType: 'demo_booked', at: daysAgoIso(12) });

    // A second invoice keeps the stage live.
    await event(userId, 'invoice_paid', 3, 1000);
    ref = (await getReferrals(partner.id, key)).referrals[0]!;
    expect(ref.stages[2]).toMatchObject({ eventType: 'invoice_paid', count: 2, reversed: false });
    expect(ref.commission).toBe(100);
  });

  it("keeps a revoked partner's referrals for the brand, and shuts the partner out", async () => {
    const program = await createProgram();
    const partner = await createPartner();
    const key = await partnerKey(partner.id);
    const userId = await referCustomer(partner.id, program.id);
    await event(userId, 'invoice_paid', 3, 100);

    const revoke = await request(app)
      .post(`/partners/${partner.id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ notify: false });
    expect(revoke.status).toBe(200);
    // Revoking ended their key.
    expect((await request(app).get(`/partners/${partner.id}/referrals`).set('Authorization', `Bearer ${key}`)).status).toBe(401);
    // Nor does a key minted for them since, here or anywhere else.
    const late = await partnerKey(partner.id);
    for (const path of ['referrals', 'customers', 'events', 'commissions']) {
      const refused = await request(app).get(`/partners/${partner.id}/${path}`).set('Authorization', `Bearer ${late}`);
      expect(refused.status, path).toBe(401);
    }
    // The brand still sees the history.
    expect((await getReferrals(partner.id)).referrals[0]).toMatchObject({ userId, commission: 10 });
  });

  it('validates the stage setting and offers recent event types', async () => {
    await createProgram();
    const defaults = await request(app).get('/config/referrals').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body).toMatchObject({ showCustomerLabels: false });
    expect(defaults.body.stages).toEqual(defaults.body.defaultStages);

    const dupe = await setStagesRaw({ stages: [{ eventType: 'deal_won', label: 'Won' }, { eventType: 'deal_won', label: 'Again' }] });
    expect(dupe.status).toBe(400);
    expect(dupe.body).toMatchObject({ error: 'duplicate_stage', eventType: 'deal_won' });
    const corrective = await setStagesRaw({ stages: [{ eventType: 'refund', label: 'Refunded' }] });
    expect(corrective.status).toBe(400);
    expect(corrective.body.error).toBe('corrective_stage');
    const blank = await setStagesRaw({ stages: [{ eventType: '  ', label: 'Blank' }] });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('invalid_body');
    const partnerTries = await request(app)
      .post('/config/referrals')
      .set('Authorization', `Bearer ${await partnerKey((await createPartner()).id)}`)
      .send({ showCustomerLabels: true });
    expect(partnerTries.status).toBe(403);

    // Trimmed on save; an empty list is allowed (no stages shown). Saving
    // stages leaves the label setting as it was, and the other way round.
    await setStages({ showCustomerLabels: true });
    const trimmed = await setStages({ stages: [{ eventType: ' demo_booked ', label: ' Demo booked ' }] });
    expect(trimmed).toMatchObject({ stages: [{ eventType: 'demo_booked', label: 'Demo booked' }], showCustomerLabels: true });
    expect((await setStages({ showCustomerLabels: false })).stages).toEqual(trimmed.stages);
    expect((await setStages({ stages: [] })).stages).toEqual([]);

    await db(TABLES.Event).insert([
      { id: ulid(), tenantId: DEFAULT_TENANT_ID, userId: 'u-x', type: 'demo_booked', metadata: {}, ts: daysAgo(3) },
      { id: ulid(), tenantId: DEFAULT_TENANT_ID, userId: 'u-x', type: 'demo_booked', metadata: {}, ts: daysAgo(2) },
      { id: ulid(), tenantId: DEFAULT_TENANT_ID, userId: 'u-x', type: 'lead_created', metadata: {}, ts: daysAgo(2) },
      { id: ulid(), tenantId: DEFAULT_TENANT_ID, userId: 'u-x', type: 'refund', metadata: {}, ts: daysAgo(1) },
      { id: ulid(), tenantId: DEFAULT_TENANT_ID, userId: 'u-x', type: 'old_type', metadata: {}, ts: daysAgo(200) },
    ]);
    const recent = await request(app).get('/config/referrals').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(recent.body.recentEventTypes).toEqual(['demo_booked', 'lead_created']);
  });

  // ---------- helpers ----------

  function daysAgoIso(n: number): string {
    return dayStamp(n).toISOString();
  }

  // Events are stamped at whole days before a fixed instant, so expected
  // timestamps can be recomputed exactly.
  const NOW = new Date();
  NOW.setUTCMilliseconds(0);
  function dayStamp(n: number): Date {
    return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  }

  async function getReferrals(partnerId: string, key = ADMIN_KEY, query: Record<string, string> = {}): Promise<ReferralPage> {
    const qs = new URLSearchParams(query).toString();
    const res = await request(app)
      .get(`/partners/${partnerId}/referrals${qs ? `?${qs}` : ''}`)
      .set('Authorization', `Bearer ${key}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ReferralPage;
  }

  function setStagesRaw(body: Record<string, unknown>) {
    return request(app).post('/config/referrals').set('Authorization', `Bearer ${ADMIN_KEY}`).send(body);
  }

  async function setStages(body: Record<string, unknown>) {
    const res = await setStagesRaw(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { stages: Array<{ eventType: string; label: string }>; showCustomerLabels: boolean };
  }

  async function createPartner() {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: `p+${ulid()}@example.com`, name: 'Referrer', sendInvite: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function createProgram() {
    const res = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Refer & earn', commissionRule: CRM_RULE, destinationUrl: 'https://example.com/signup', attributionWindowDays: 90 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function partnerKey(partnerId: string): Promise<string> {
    const res = await request(app).post(`/partners/${partnerId}/api-keys`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({});
    expect(res.status).toBe(201);
    return res.body.plaintext as string;
  }

  async function scopedKey(scopes: string[]): Promise<string> {
    const res = await request(app).post('/api-keys/scoped').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ scopes });
    expect(res.status).toBe(201);
    return res.body.plaintext as string;
  }

  /** A new customer who clicked the partner's link `clickedDaysAgo` days ago. */
  async function referCustomer(partnerId: string, programId: string, clickedDaysAgo = 30): Promise<string> {
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: null,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      fraudFlag: null,
      ts: dayStamp(clickedDaysAgo),
    });
    const userId = `u-${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
    return userId;
  }

  /** Record a conversion through the API, as a CRM would. Returns its id. */
  async function event(
    userId: string,
    type: string,
    at: number | Date,
    value?: number,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const ts = typeof at === 'number' ? dayStamp(at) : at;
    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type, ts: ts.toISOString(), ...(value != null ? { value, currency: 'USD' } : {}), ...(metadata ? { metadata } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.attribution.status).toBe('attributed');
    return res.body.eventId as string;
  }

  async function commissionOf(eventId: string): Promise<string> {
    const row = await db(`${TABLES.Commission} as c`)
      .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
      .where('a.eventId', eventId)
      .first('c.id');
    expect(row).toBeTruthy();
    return (row as { id: string }).id;
  }
});
