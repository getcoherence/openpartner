/**
 * A `first` sub-rule pays at most once per (partner, customer, event type),
 * and `subsequent` pays on every other event of that type, whatever order
 * the events arrive in: two events stamped the same second, an older event
 * delivered after a newer one, and two requests racing for one customer.
 *
 * The engine side is isFirstConversion and lockCustomer in attribution.ts.
 * Slab-specific first/subsequent cases are in
 * commission-slabs.integration.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type EventRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeBacklogForUser, attributeEvent, lockCustomer } from '../attribution.js';

const ADMIN_KEY = 'op_test_commission_first_trigger_0123456789';
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
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

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

const CLICK_TS = new Date('2025-12-31T23:59:00Z');

/** $100 the first time, $10 every time after. */
const FIRST_AND_SUBSEQUENT = [
  { trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 100 },
  { trigger: 'subsequent', eventType: 'invoice_paid', type: 'fixed', value: 10 },
];

describe.skipIf(skipIntegration)('first trigger pays once', () => {
  it('two events stamped the same second: one first, one subsequent, either way round', async () => {
    for (const order of ['lower id first', 'higher id first'] as const) {
      const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT);
      const ts = new Date('2026-01-05T10:00:00Z');
      const [lo, hi] = [ulid(), ulid()].sort();
      const a = await insertEvent(userId, 'invoice_paid', '50.00', ts, lo);
      const b = await insertEvent(userId, 'invoice_paid', '50.00', ts, hi);
      const [x, y] = order === 'lower id first' ? [a, b] : [b, a];

      await attributeEvent(db, x);
      await attributeEvent(db, y);

      expect(await amountsByEvent(partner.id), order).toEqual({ [x.id]: ['100.00'], [y.id]: ['10.00'] });
    }
  });

  it('an older event delivered after a newer one has paid: no second first, it pays subsequent', async () => {
    const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT);
    const older = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const newer = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-02-01T00:00:00Z'));

    await attributeEvent(db, newer);
    await attributeEvent(db, older);

    expect(await amountsByEvent(partner.id)).toEqual({ [newer.id]: ['100.00'], [older.id]: ['10.00'] });

    // A third, in order, is subsequent too.
    const third = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-03-01T00:00:00Z'));
    await attributeEvent(db, third);
    expect((await amountsByEvent(partner.id))[third.id]).toEqual(['10.00']);
  });

  it('a first-only rule pays once however the events arrive', async () => {
    const { partner, userId } = await setup([{ trigger: 'first', eventType: 'invoice_paid', type: 'percent', value: 50 }]);
    const ts = new Date('2026-01-05T10:00:00Z');
    const events = [
      await insertEvent(userId, 'invoice_paid', '80.00', new Date('2026-01-09T00:00:00Z')),
      await insertEvent(userId, 'invoice_paid', '40.00', ts),
      await insertEvent(userId, 'invoice_paid', '60.00', ts),
      await insertEvent(userId, 'invoice_paid', '20.00', new Date('2026-01-01T00:00:00Z')),
    ];
    for (const e of events) await attributeEvent(db, e);

    // The first one attributed takes it.
    expect(await amountsByEvent(partner.id)).toEqual({ [events[0]!.id]: ['40.00'] });
  });

  it('each partner, customer and event type has its own first', async () => {
    const program = await createProgram([
      { trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 100 },
      { trigger: 'first', eventType: 'trial_started', type: 'fixed', value: 5 },
    ]);
    const a = await createPartner();
    const b = await createPartner();
    const userA = `u-${ulid()}`;
    const userB = `u-${ulid()}`;
    await click(a.id, program.id, userA, CLICK_TS);
    await click(b.id, program.id, userB, CLICK_TS);

    // Newer first for each, so the old `ts <` test would have paid twice.
    for (const userId of [userA, userB]) {
      const newer = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-02-01T00:00:00Z'));
      const older = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
      const trial = await insertEvent(userId, 'trial_started', null, new Date('2026-01-01T00:00:00Z'));
      await attributeEvent(db, newer);
      await attributeEvent(db, older);
      await attributeEvent(db, trial);
    }

    for (const partnerId of [a.id, b.id]) {
      const rows = await db(TABLES.Commission).where({ partnerId }).orderBy('amount').pluck('amount');
      expect(rows).toEqual(['5.00', '100.00']);
    }
  });

  it("two touches of one partner on the first event each pay their share, and the next event doesn't pay again", async () => {
    const program = await createProgram(FIRST_AND_SUBSEQUENT, { attributionModel: 'linear' });
    const partner = await createPartner();
    const userId = `u-${ulid()}`;
    await click(partner.id, program.id, userId, CLICK_TS);
    await click(partner.id, program.id, userId, new Date(CLICK_TS.getTime() + 1000));

    const first = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const second = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    await attributeEvent(db, first);
    await attributeEvent(db, second);

    expect(await amountsByEvent(partner.id)).toEqual({ [first.id]: ['50.00', '50.00'], [second.id]: ['5.00', '5.00'] });
  });

  it('commissions record their trigger', async () => {
    const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT);
    await attributeEvent(db, await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z')));
    await attributeEvent(db, await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-02T00:00:00Z')));
    const rows = (await db(TABLES.Commission).where({ partnerId: partner.id }).orderBy('id')) as Array<{
      metadata: Record<string, unknown>;
    }>;
    expect(rows.map((r) => r.metadata)).toEqual([
      { rateType: 'fixed', trigger: 'first' },
      { rateType: 'fixed', trigger: 'subsequent' },
    ]);
  });

  it('an event that paid no first-time commission holds nothing: an older one delivered later still pays it', async () => {
    // The program ended on Jan 15: a Feb event is attributed but earns nothing.
    const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT, { endsAt: new Date('2026-01-15T00:00:00Z') });
    const late = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-02-01T00:00:00Z'));
    const early = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-10T00:00:00Z'));

    await attributeEvent(db, late);
    await attributeEvent(db, early);

    expect(await db(TABLES.Attribution).where({ eventId: late.id })).toHaveLength(1);
    expect(await amountsByEvent(partner.id)).toEqual({ [early.id]: ['100.00'] });
  });

  it('a commission from before triggers were recorded counts as the first: never paid twice', async () => {
    const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT);
    const newer = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-02-01T00:00:00Z'));
    await attributeEvent(db, newer);
    // As an old ledger row: no trigger in its metadata.
    await db(TABLES.Commission).where({ partnerId: partner.id }).update({ metadata: { rateType: 'fixed' } });

    const older = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    await attributeEvent(db, older);

    expect(await amountsByEvent(partner.id)).toEqual({ [newer.id]: ['100.00'], [older.id]: ['10.00'] });
  });

  it('a replay attributes same-second events in Event id order, so the lower id takes the first', async () => {
    const program = await createProgram(FIRST_AND_SUBSEQUENT);
    const partner = await createPartner();
    const userId = `u-${ulid()}`;
    const ts = new Date('2026-01-05T10:00:00Z');
    const [lo, hi] = [ulid(), ulid()].sort();
    // Inserted higher id first, so a replay going by row order would pick it.
    const high = await insertEvent(userId, 'invoice_paid', '50.00', ts, hi);
    const low = await insertEvent(userId, 'invoice_paid', '50.00', ts, lo);

    // No click yet: nothing attributes until the stitch, then the backlog
    // replays both.
    await click(partner.id, program.id, userId, CLICK_TS);
    expect(await attributeBacklogForUser(db, DEFAULT_TENANT_ID, userId)).toBe(2);

    expect(await amountsByEvent(partner.id)).toEqual({ [low.id]: ['100.00'], [high.id]: ['10.00'] });
  });

  it("a rule limited to products: once per product however they arrive, and another product's first holds nothing", async () => {
    const { partner, userId } = await setup([
      { trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 50, products: [{ id: 'prod_team' }] },
      { trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 20, products: [{ id: 'prod_pro' }] },
    ]);
    const team = { products: [{ id: 'prod_team', amount: 99 }] };
    const pro = { products: [{ id: 'prod_pro', amount: 80 }] };
    const proSale = await insertEvent(userId, 'invoice_paid', '80.00', new Date('2026-03-01T00:00:00Z'), ulid(), pro);
    const teamNewer = await insertEvent(userId, 'invoice_paid', '99.00', new Date('2026-02-01T00:00:00Z'), ulid(), team);
    const teamOlder = await insertEvent(userId, 'invoice_paid', '99.00', new Date('2026-01-01T00:00:00Z'), ulid(), team);

    // The Pro sale's first-time commission doesn't hold the Team rule's; the
    // older Team sale, delivered last, finds the newer one holding it.
    for (const e of [proSale, teamNewer, teamOlder]) await attributeEvent(db, e);

    expect(await amountsByEvent(partner.id)).toEqual({ [proSale.id]: ['20.00'], [teamNewer.id]: ['50.00'] });
  });
});

describe.skipIf(skipIntegration)('first trigger through a fraud-review replay', () => {
  /** P's clean click, and Q's flagged one before it, on a last-click
   *  program: P takes every event, now and after Q is unflagged. */
  async function withFlaggedClick(rules: unknown[]) {
    const program = await createProgram(rules);
    const p = await createPartner();
    const q = await createPartner();
    const userId = `u-${ulid()}`;
    const flagged = await click(q.id, program.id, userId, new Date(CLICK_TS.getTime() - 86_400_000));
    await db(TABLES.Click).where({ id: flagged }).update({ fraudFlag: 'manual' });
    await click(p.id, program.id, userId, CLICK_TS);
    return { p, userId, flagged };
  }

  async function unflag(clickId: string) {
    const res = await request(app).post(`/clicks/${clickId}/unflag`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  it('a first-only rule: the replayed first event pays again, though a later event kept its attribution', async () => {
    const { p, userId, flagged } = await withFlaggedClick([{ trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 100 }]);
    const e1 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const e2 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-02T00:00:00Z'));
    await attributeEvent(db, e1);
    await attributeEvent(db, e2);
    expect(await amountsByEvent(p.id)).toEqual({ [e1.id]: ['100.00'] });

    // e1's accrued commission and attribution are dropped and replayed; e2
    // has no commission, so its attribution stays.
    await unflag(flagged);

    expect(await amountsByEvent(p.id)).toEqual({ [e1.id]: ['100.00'] });
  });

  it('a later event already settled on the subsequent rate: the replayed first event still pays first', async () => {
    const { p, userId, flagged } = await withFlaggedClick(FIRST_AND_SUBSEQUENT);
    const e1 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const e2 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-02T00:00:00Z'));
    await attributeEvent(db, e1);
    await attributeEvent(db, e2);
    const e2Commission = await db(`${TABLES.Commission} as c`)
      .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
      .where('a.eventId', e2.id)
      .first('c.id');
    await db(TABLES.Commission).where({ id: e2Commission.id }).update({ status: 'approved' });

    await unflag(flagged);

    expect(await amountsByEvent(p.id)).toEqual({ [e1.id]: ['100.00'], [e2.id]: ['10.00'] });
  });
});

describe.skipIf(skipIntegration)('first trigger under concurrent requests', () => {
  it('two transactions attributing one customer: the second waits, then pays subsequent', async () => {
    const { partner, userId } = await setup(FIRST_AND_SUBSEQUENT);
    const e1 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const e2 = await insertEvent(userId, 'invoice_paid', '50.00', new Date('2026-01-02T00:00:00Z'));

    // Request 1 attributes e1 and hasn't committed yet.
    const trx1 = await db.transaction();
    let second: Promise<unknown> | undefined;
    try {
      await attributeEvent(trx1, e1);

      // Request 2 attributes e2 on its own connection. Without the customer
      // lock it would run to the end now, see none of trx1's rows, and pay
      // a second first-time commission.
      let settled = false;
      second = db.transaction((trx2) => attributeEvent(trx2, e2)).finally(() => {
        settled = true;
      });
      await waitFor(async () => settled || (await advisoryWaiters()) > 0);
      expect(settled, 'request 2 should be waiting on the customer lock').toBe(false);

      await trx1.commit();
    } catch (err) {
      await trx1.rollback().catch(() => {});
      throw err;
    }
    await second;

    expect(await amountsByEvent(partner.id)).toEqual({ [e1.id]: ['100.00'], [e2.id]: ['10.00'] });
  });

  it('identify waits for the customer lock before stitching, so a checkout holding it can stitch the same pair', async () => {
    // A Stripe checkout for a merchant-set userId takes the customer lock,
    // then stitches. identify for the same (click, user) used to insert the
    // Identity first and then wait for the lock: each waited on the other.
    const program = await createProgram(FIRST_AND_SUBSEQUENT);
    const partner = await createPartner();
    const userId = `u-${ulid()}`;
    const clickId = await click(partner.id, program.id, `other-${ulid()}`, CLICK_TS);

    const checkout = await db.transaction();
    let identify: Promise<request.Response> | undefined;
    try {
      await lockCustomer(checkout, DEFAULT_TENANT_ID, userId);
      let settled = false;
      identify = request(app)
        .post('/attribution/identify')
        .send({ cref: clickId, userId })
        .then((r) => r)
        .finally(() => {
          settled = true;
        });
      await waitFor(async () => settled || (await advisoryWaiters()) > 0);
      expect(settled, 'identify should be waiting on the customer lock').toBe(false);

      await checkout(TABLES.Identity)
        .insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId })
        .onConflict(['clickId', 'userId'])
        .ignore();
      await checkout.commit();
    } catch (err) {
      await checkout.rollback().catch(() => {});
      throw err;
    }
    const res = await identify;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.firstStitch).toBe(false);
  });

  it('two transactions on different customers do not wait for each other', async () => {
    const program = await createProgram(FIRST_AND_SUBSEQUENT);
    const partner = await createPartner();
    const [u1, u2] = [`u-${ulid()}`, `u-${ulid()}`];
    await click(partner.id, program.id, u1, CLICK_TS);
    await click(partner.id, program.id, u2, CLICK_TS);
    const e1 = await insertEvent(u1, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));
    const e2 = await insertEvent(u2, 'invoice_paid', '50.00', new Date('2026-01-01T00:00:00Z'));

    const trx1 = await db.transaction();
    try {
      await attributeEvent(trx1, e1);
      // Would hang (and time out) if the lock were wider than one customer.
      await db.transaction((trx2) => attributeEvent(trx2, e2));
      await trx1.commit();
    } catch (err) {
      await trx1.rollback().catch(() => {});
      throw err;
    }

    expect(await amountsByEvent(partner.id)).toEqual({ [e1.id]: ['100.00'], [e2.id]: ['100.00'] });
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

/** Commission amounts per event for one partner, each list sorted. */
async function amountsByEvent(partnerId: string): Promise<Record<string, string[]>> {
  const rows = (await db(`${TABLES.Commission} as c`)
    .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
    .where('c.partnerId', partnerId)
    .select('a.eventId', 'c.amount')) as Array<{ eventId: string; amount: string }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.eventId] ??= []).push(r.amount);
  for (const list of Object.values(out)) list.sort((x, y) => Number(y) - Number(x));
  return out;
}

/** Sessions in this database waiting for an advisory lock. */
async function advisoryWaiters(): Promise<number> {
  const res = (await db.raw(
    `select count(*)::int as n from pg_locks l join pg_stat_activity s on s.pid = l.pid
      where l.locktype = 'advisory' and not l.granted and s.datname = current_database()`,
  )) as { rows: Array<{ n: number }> };
  return res.rows[0]!.n;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

async function setup(rules: unknown[], programExtra: Record<string, unknown> = {}) {
  const partner = await createPartner();
  const program = await createProgram(rules, programExtra);
  const userId = `u-${ulid()}`;
  await click(partner.id, program.id, userId, CLICK_TS);
  return { partner, program, userId };
}

async function createPartner() {
  const res = await request(app)
    .post('/partners')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ email: `p+${ulid()}@example.com`, name: 'First trigger test', sendInvite: false, programIds: [] });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function createProgram(rules: unknown[], extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/programs')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({
      name: 'First trigger',
      commissionRule: rules,
      attributionWindowDays: 365,
      destinationUrl: 'https://example.com/signup',
      deepLinkAllowedDomains: 'example.com',
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (Object.keys(extra).length > 0) await db(TABLES.Program).where({ id: res.body.id }).update(extra);
  return res.body as { id: string };
}

/** A click by `partnerId` on `programId`, stitched to `userId`. */
async function click(partnerId: string, programId: string, userId: string, ts: Date): Promise<string> {
  const linkId = ulid();
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: DEFAULT_TENANT_ID,
    linkKey: `k${linkId.toLowerCase()}`,
    partnerId,
    programId,
    destinationUrl: 'https://example.com/',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/',
    ts,
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  return clickId;
}

async function insertEvent(
  userId: string,
  type: string,
  value: string | null,
  ts: Date,
  id = ulid(),
  metadata: Record<string, unknown> = {},
): Promise<EventRow> {
  await db(TABLES.Event).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    userId,
    type,
    value,
    currency: 'USD',
    externalEventId: `evt_${ulid()}`,
    metadata,
    ts,
  });
  return (await db(TABLES.Event).where({ id }).first()) as EventRow;
}
