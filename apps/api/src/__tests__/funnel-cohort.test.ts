/**
 * GET /partners/:id/funnel counts one cohort: the partner's clicks in the
 * window and what those visitors went on to do.
 *
 * It used to count each stage by a different clock: clicks by Click.ts but
 * signups and paid by Attribution.computedAt. A partner six months in with
 * monthly subscribers showed "Clicks 124 → Stitched 7 → Signups 9 → Paid 20"
 * and "from prev 222%": every renewal attributed this month counted as a
 * paying user of this month's clicks.
 *
 * Every scenario runs relative to now, since the window is the last 30
 * days by default.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type EventRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeEvent } from '../attribution.js';

const ADMIN_KEY = 'op_test_funnel_cohort_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const RECURRING_20 = [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true }];

interface Funnel {
  stages: { clicks: number; identities: number; signups: number; paid: number };
  rates: { stitchRate: number; signupRate: number; paidRate: number; overall: number };
  currency: string;
  revenue: number;
  revenueByCurrency: Record<string, number>;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('partner funnel cohort', () => {
  it('leaves out renewals from customers won by older clicks', async () => {
    const partner = await createPartner();
    const program = await createProgram();

    // Six customers won ~5-6 months ago, each still paying monthly; their
    // latest renewal lands inside the window. The renewals stay with the
    // original click (renewalsStayWithPartner, the default).
    const subscribers: string[] = [];
    let subscriberPayments = 0;
    for (let i = 0; i < 6; i += 1) {
      const clickedAt = 170 - i * 5;
      const userId = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(clickedAt)));
      subscribers.push(userId);
      await attribute(userId, 'signup', null, daysAgo(clickedAt - 1));
      for (let paidAt = clickedAt - 1; paidAt > 0; paidAt -= 30) {
        await attribute(userId, 'invoice_paid', '50.00', daysAgo(paidAt));
        subscriberPayments += 1;
      }
    }

    // This month: ten clicks, four of them identified, three signed up,
    // one paid.
    const clicks: string[] = [];
    for (let i = 0; i < 10; i += 1) clicks.push(await insertClick(partner.id, program.id, daysAgo(25 - i * 2)));
    const newUsers: string[] = [];
    for (const click of clicks.slice(0, 4)) newUsers.push(await stitchNewUser(click));
    for (const userId of newUsers.slice(0, 3)) await attribute(userId, 'signup', null, daysAgo(4));
    await attribute(newUsers[0]!, 'invoice_paid', '80.00', daysAgo(3));

    // A fraud-flagged click whose visitor signed up and paid is in none of it.
    const flagged = await insertClick(partner.id, program.id, daysAgo(6), 'velocity');
    const flaggedUser = await stitchNewUser(flagged);
    await attribute(flaggedUser, 'signup', null, daysAgo(5));

    // Each subscriber renewed inside the window, and every attribution was
    // computed just now: counted by computedAt, all six were in signups and
    // paid next to this month's ten clicks.
    const renewalsInWindow = await db(TABLES.Attribution)
      .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
      .whereIn(`${TABLES.Event}.userId`, subscribers)
      .andWhere(`${TABLES.Event}.ts`, '>=', daysAgo(30))
      .andWhere(`${TABLES.Event}.type`, 'invoice_paid');
    expect(renewalsInWindow.length).toBe(6);

    const funnel = await getFunnel(partner.id);
    expect(funnel.stages).toEqual({ clicks: 10, identities: 4, signups: 3, paid: 1 });
    expect(funnel.rates.stitchRate).toBeCloseTo(0.4, 5);
    expect(funnel.rates.signupRate).toBeCloseTo(0.75, 5);
    expect(funnel.rates.paidRate).toBeCloseTo(1 / 3, 5);
    expect(funnel.rates.overall).toBeCloseTo(0.1, 5);
    expect(funnel.revenue).toBe(80);
    expect(funnel.revenueByCurrency).toEqual({ USD: 80 });

    // A wider window takes in the older cohort, renewals and all.
    const wide = await getFunnel(partner.id, daysAgo(200));
    expect(wide.stages).toEqual({ clicks: 16, identities: 10, signups: 9, paid: 7 });
    expect(wide.revenue).toBe(80 + subscriberPayments * 50); // every payment so far, renewals included
    for (const rate of [wide.rates.stitchRate, wide.rates.signupRate, wide.rates.paidRate]) expect(rate).toBeLessThanOrEqual(1);
  });

  it('keeps a returning subscriber who clicks again out of signups and paid', async () => {
    const partner = await createPartner();
    const program = await createProgram();
    const oldClick = await insertClick(partner.id, program.id, daysAgo(120));
    const userId = await stitchNewUser(oldClick);
    await attribute(userId, 'signup', null, daysAgo(119));
    await attribute(userId, 'invoice_paid', '50.00', daysAgo(119));

    // Clicks the partner's link again this month, then renews.
    await stitch(await insertClick(partner.id, program.id, daysAgo(10)), userId);
    const renewal = await attribute(userId, 'invoice_paid', '50.00', daysAgo(5));
    expect(renewal.result.status).toBe('attributed');
    expect(renewal.result.touches?.[0]?.clickId).toBe(oldClick);

    const funnel = await getFunnel(partner.id);
    expect(funnel.stages).toEqual({ clicks: 1, identities: 1, signups: 0, paid: 0 });
    expect(funnel.revenue).toBe(0);
  });

  it('counts a paying customer as signed up when the brand never sends signup', async () => {
    const partner = await createPartner();
    const program = await createProgram();
    const payer = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(8)));
    await attribute(payer, 'invoice_paid', '120.00', daysAgo(7));
    const trial = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(8)));
    await attribute(trial, 'trial_started', null, daysAgo(7));
    // A custom event doesn't say the visitor has an account.
    const lead = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(8)));
    await attribute(lead, 'demo_booked', null, daysAgo(7));

    const funnel = await getFunnel(partner.id);
    expect(funnel.stages).toEqual({ clicks: 3, identities: 3, signups: 2, paid: 1 });
    expect(funnel.rates.paidRate).toBeCloseTo(0.5, 5);
  });

  it('only counts conversions credited to this partner', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const program = await createProgram();
    const userId = await stitchNewUser(await insertClick(a.id, program.id, daysAgo(9)));
    // Then clicks partner B's link; last click wins the signup and payment.
    await stitch(await insertClick(b.id, program.id, daysAgo(8)), userId);
    await attribute(userId, 'signup', null, daysAgo(7));
    await attribute(userId, 'invoice_paid', '60.00', daysAgo(7));

    expect((await getFunnel(a.id)).stages).toEqual({ clicks: 1, identities: 1, signups: 0, paid: 0 });
    expect((await getFunnel(b.id)).stages).toEqual({ clicks: 1, identities: 1, signups: 1, paid: 1 });
  });

  it('keeps currencies apart in revenue', async () => {
    const partner = await createPartner();
    const program = await createProgram();
    const usd = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(5)));
    await attribute(usd, 'invoice_paid', '40.00', daysAgo(4));
    const eur = await stitchNewUser(await insertClick(partner.id, program.id, daysAgo(5)));
    await attribute(eur, 'invoice_paid', '30.00', daysAgo(4), 'EUR');

    const funnel = await getFunnel(partner.id);
    expect(funnel.stages.paid).toBe(2);
    expect(funnel.currency).toBe('USD');
    expect(funnel.revenue).toBe(40);
    expect(funnel.revenueByCurrency).toEqual({ USD: 40, EUR: 30 });
  });

  async function getFunnel(partnerId: string, since?: Date): Promise<Funnel> {
    const qs = since ? `?since=${encodeURIComponent(since.toISOString())}` : '';
    const res = await request(app).get(`/partners/${partnerId}/funnel${qs}`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    return res.body as Funnel;
  }

  async function createPartner() {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: `p+${ulid()}@example.com`, name: 'Test' });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function createProgram() {
    const res = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Funnel', commissionRule: RECURRING_20, destinationUrl: 'https://example.com/signup' });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function insertClick(partnerId: string, programId: string, ts: Date, fraudFlag: string | null = null): Promise<string> {
    const id = ulid();
    await db(TABLES.Click).insert({
      id,
      tenantId: DEFAULT_TENANT_ID,
      linkId: null,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      fraudFlag,
      ts,
    });
    return id;
  }

  async function stitch(clickId: string, userId: string) {
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  }

  async function stitchNewUser(clickId: string): Promise<string> {
    const userId = `u-${ulid()}`;
    await stitch(clickId, userId);
    return userId;
  }

  async function attribute(userId: string, type: string, value: string | null, ts: Date, currency = 'USD') {
    const id = ulid();
    await db(TABLES.Event).insert({
      id,
      tenantId: DEFAULT_TENANT_ID,
      userId,
      type,
      value,
      currency: value ? currency : null,
      externalEventId: `evt_${ulid()}`,
      metadata: {},
      ts,
    });
    const event = (await db(TABLES.Event).where({ id }).first()) as EventRow;
    return { event, result: await attributeEvent(db, event) };
  }
});
