/**
 * The Stripe event catch-up (stripe-event-catchup.ts) records the brand
 * events no webhook delivered:
 *
 *   - a missed checkout is recorded and attributed as the webhook would
 *     have, tagged recoveredBy, and logged so the next run skips it
 *   - an event a webhook already processed (a StripeEventLog row) is
 *     skipped, and every event the pipeline processes is logged
 *   - the window: never before the connection's eventLogSince, never the
 *     last hour, never past 72 hours; other-mode events are ignored
 *   - pages through Stripe's list; one connection failing doesn't stop
 *     the others; old log rows are pruned
 *   - self-host and inactive tenants are left alone
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type Stripe from 'stripe';
import { DEFAULT_TENANT_ID, TABLES, type TenantStripeConnectionRow } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'flat';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { runStripeEventCatchup, LOOKBACK_HOURS, SETTLE_MINUTES } = await import('../stripe-event-catchup.js');
const { processBrandStripeEvent } = await import('../routes/stripe-webhook.js');
const { StripeConnectionUnavailableError } = await import('../stripe-app.js');
const { withTenantTransaction } = await import('../tenancy.js');
const { encryptSecret } = await import('../crypto.js');

const OTHER_TENANT_ID = '01J000000STRIPECATCHUPOTHR';

const TABLES_TO_CLEAN = [
  TABLES.StripeEventLog,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
  TABLES.TenantStripeConnection,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const NOW = new Date();
const HOUR = 3_600_000;
const secondsAgo = (ms: number) => Math.floor((NOW.getTime() - ms) / 1000);

/** A Stripe client whose events.list honours `created`, `limit` and
 *  `starting_after` over a fixed list, newest first like Stripe's. */
function fakeStripe(events: Stripe.Event[]) {
  const calls: Array<Record<string, unknown>> = [];
  const sorted = [...events].sort((a, b) => b.created - a.created);
  const client = {
    events: {
      list: async (params: { created: { gte: number; lte: number }; limit: number; starting_after?: string; types: string[] }) => {
        calls.push(params);
        const inRange = sorted.filter(
          (e) => e.created >= params.created.gte && e.created <= params.created.lte && params.types.includes(e.type),
        );
        const start = params.starting_after ? inRange.findIndex((e) => e.id === params.starting_after) + 1 : 0;
        const data = inRange.slice(start, start + params.limit);
        return { object: 'list', data, has_more: start + params.limit < inRange.length };
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

function checkoutEvent(clickId: string, createdSecondsAgo: number, fields: Partial<Stripe.Event> = {}): Stripe.Event {
  const session = {
    id: `cs_${ulid()}`,
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 4900,
    currency: 'usd',
    customer: null,
    payment_intent: `pi_${ulid()}`,
    invoice: null,
    client_reference_id: clickId,
  };
  return {
    id: `evt_${ulid()}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: secondsAgo(createdSecondsAgo * 1000),
    livemode: true,
    data: { object: session },
    ...fields,
  } as unknown as Stripe.Event;
}

async function seedClick(tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'P', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'Program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://brand.example/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/',
    ts: new Date(NOW.getTime() - 5 * HOUR),
  });
  return clickId;
}

async function seedConnection(o: { tenantId?: string; livemode?: boolean; eventLogSince?: Date } = {}): Promise<string> {
  const id = `tsc_${ulid()}`;
  const livemode = o.livemode ?? true;
  await db(TABLES.TenantStripeConnection).insert({
    id,
    tenantId: o.tenantId ?? DEFAULT_TENANT_ID,
    stripeAccountId: `acct_${ulid()}`,
    livemode,
    keyMode: livemode ? 'live' : 'test',
    // Never used: the test hands the catch-up its own client.
    refreshTokenEnc: encryptSecret('rt_unused'),
    accessTokenEnc: encryptSecret('at_unused'),
    accessTokenExpiresAt: new Date(NOW.getTime() + HOUR),
    permissionsVersion: 1,
    connectedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    eventLogSince: o.eventLogSince ?? new Date(NOW.getTime() - 10 * 24 * HOUR),
  });
  return id;
}

const run = (clients: Record<string, Stripe>, now = NOW) =>
  runStripeEventCatchup({
    now,
    clientFor: async (conn: TenantStripeConnectionRow) => {
      const client = clients[conn.id];
      if (!client) throw new StripeConnectionUnavailableError('reconnect_needed', conn.id);
      return client;
    },
  });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'stripe-catchup-other', displayName: 'Other', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID, OTHER_TENANT_ID]).del();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  process.env.OPENPARTNER_MODE = 'selfhost';
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  process.env.OPENPARTNER_MODE = 'flat';
  for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID, OTHER_TENANT_ID]).del();
  await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).update({ status: 'active' });
});

describe.skipIf(skipIntegration)('runStripeEventCatchup', () => {
  it('records and attributes a checkout no webhook delivered, then skips it', async () => {
    const clickId = await seedClick();
    const conn = await seedConnection();
    const missed = checkoutEvent(clickId, 2 * 3600);
    const { client } = fakeStripe([missed]);

    const first = await run({ [conn]: client });
    expect(first.connections).toEqual([
      expect.objectContaining({ tenantId: DEFAULT_TENANT_ID, connectionId: conn, listed: 1, recovered: 1, truncated: false }),
    ]);
    const revenue = await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID, type: 'invoice_paid' }).first();
    expect(revenue).toMatchObject({ value: '49.00', currency: 'USD' });
    expect(revenue.metadata).toMatchObject({ recoveredBy: 'stripe_catchup', via: 'stripe_app', stripeEventId: missed.id });
    expect(await db(TABLES.Attribution).where({ eventId: revenue.id })).toHaveLength(1);
    expect(await db(TABLES.StripeEventLog).where({ stripeEventId: missed.id }).first()).toMatchObject({
      tenantId: DEFAULT_TENANT_ID,
      type: 'checkout.session.completed',
      via: 'catchup',
    });

    const again = await run({ [conn]: client });
    expect(again.connections[0]).toMatchObject({ listed: 1, recovered: 0 });
    expect(await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(2); // signup + revenue, once
  });

  it("skips what a webhook already processed, and the webhook path logs what it processes", async () => {
    const clickId = await seedClick();
    const conn = await seedConnection();
    const delivered = checkoutEvent(clickId, 3 * 3600);
    const { client } = fakeStripe([delivered]);
    // The webhook route's pipeline call, as /webhooks/stripe-app makes it.
    await withTenantTransaction(DEFAULT_TENANT_ID, (trx) =>
      processBrandStripeEvent(
        trx,
        { stripe: client, brandAccount: true, writeCustomerMetadata: false, keyRevenueByTransaction: true },
        delivered,
        DEFAULT_TENANT_ID,
      ),
    );
    expect(await db(TABLES.StripeEventLog).where({ stripeEventId: delivered.id }).first()).toMatchObject({ via: 'webhook' });

    const result = await run({ [conn]: client });
    expect(result.connections[0]).toMatchObject({ listed: 1, recovered: 0 });
    const revenue = await db(TABLES.Event).where({ tenantId: DEFAULT_TENANT_ID, type: 'invoice_paid' }).first();
    expect(revenue.metadata.recoveredBy).toBeUndefined();
  });

  it('asks for the window: after eventLogSince, within 72 hours, not the last hour', async () => {
    await seedClick();
    const since = new Date(NOW.getTime() - 10 * HOUR);
    const conn = await seedConnection({ eventLogSince: since });
    const { client, calls } = fakeStripe([]);
    await run({ [conn]: client });
    expect(calls[0]).toMatchObject({
      created: { gte: Math.floor(since.getTime() / 1000), lte: secondsAgo(SETTLE_MINUTES * 60_000) },
      limit: 100,
    });
    expect((calls[0]!.types as string[]).sort()).toContain('invoice.paid');

    // An old connection reaches back 72 hours, no further.
    await db(TABLES.TenantStripeConnection).where({ id: conn }).update({ eventLogSince: new Date(NOW.getTime() - 30 * 24 * HOUR) });
    const second = fakeStripe([]);
    await run({ [conn]: second.client });
    expect((second.calls[0]!.created as { gte: number }).gte).toBe(secondsAgo(LOOKBACK_HOURS * HOUR));

    // A connection made minutes ago has nothing settled yet: no call.
    await db(TABLES.TenantStripeConnection).where({ id: conn }).update({ eventLogSince: new Date(NOW.getTime() - 10 * 60_000) });
    const third = fakeStripe([]);
    await run({ [conn]: third.client });
    expect(third.calls).toHaveLength(0);
  });

  it("ignores the other mode's events and pages through Stripe's list", async () => {
    const clickId = await seedClick();
    const conn = await seedConnection();
    const events = Array.from({ length: 230 }, (_, i) => checkoutEvent(clickId, 2 * 3600 + i));
    const testMode = checkoutEvent(clickId, 4 * 3600, { livemode: false });
    // Two of them a webhook already delivered.
    await db(TABLES.StripeEventLog).insert(
      events.slice(0, 228).map((e) => ({ stripeEventId: e.id, tenantId: DEFAULT_TENANT_ID, type: e.type, via: 'webhook' })),
    );
    const { client, calls } = fakeStripe([...events, testMode]);

    const result = await run({ [conn]: client });
    expect(calls).toHaveLength(3);
    expect(result.connections[0]).toMatchObject({ listed: 230, recovered: 2 });
    expect(await db(TABLES.StripeEventLog).where({ stripeEventId: testMode.id })).toEqual([]);
  });

  it("carries on past a connection that can't be used, and leaves inactive tenants alone", async () => {
    const broken = await seedConnection();
    const otherClick = await seedClick(OTHER_TENANT_ID);
    const working = await seedConnection({ tenantId: OTHER_TENANT_ID });
    const { client } = fakeStripe([checkoutEvent(otherClick, 2 * 3600)]);

    const result = await run({ [working]: client });
    expect(result.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: broken, recovered: 0, error: 'reconnect_needed' }),
        expect.objectContaining({ connectionId: working, recovered: 1 }),
      ]),
    );

    await db(TABLES.StripeEventLog).where({ tenantId: OTHER_TENANT_ID }).del();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).update({ status: 'suspended' });
    const inactive = await run({ [working]: client });
    expect(inactive.connections.map((c) => c.connectionId)).not.toContain(working);
  });

  it('prunes log rows older than Stripe keeps events, and does nothing on a self-host', async () => {
    await db(TABLES.StripeEventLog).insert([
      { stripeEventId: `evt_old_${ulid()}`, tenantId: DEFAULT_TENANT_ID, type: 'invoice.paid', via: 'webhook', receivedAt: new Date(NOW.getTime() - 40 * 24 * HOUR) },
      { stripeEventId: `evt_new_${ulid()}`, tenantId: DEFAULT_TENANT_ID, type: 'invoice.paid', via: 'webhook', receivedAt: new Date(NOW.getTime() - 2 * 24 * HOUR) },
    ]);
    const result = await run({});
    expect(result.pruned).toBe(1);
    expect(await db(TABLES.StripeEventLog).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(1);

    process.env.OPENPARTNER_MODE = 'selfhost';
    expect(await run({})).toEqual({ connections: [], pruned: 0, skipped: 'selfhost' });
  });
});
