/**
 * GET /partners/:id/links/:linkId/results (link-results.ts): one link's
 * clicks and the conversions credited to them, which the Network reads for
 * a booking's report.
 *
 *   - only the link's clicks count: not the partner's other link, not a
 *     fraud-flagged click, not one outside the click window;
 *   - leads and sales are distinct events, revenue the link's share of
 *     each sale under the event's live (first-computed) model;
 *   - conversions after conversionUntil are left out, and a passed
 *     conversionUntil wins over the program's window;
 *   - refunds net as bounties net them: API refunds add up, a value-less one
 *     refunds it all, a Stripe refund reports its share, the larger wins;
 *   - currencies never add up, sources are hostnames only;
 *   - another partner's link answers link_not_found, and a partner can't
 *     read another partner's links.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_link_results_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { createApiKeyRow } = await import('../auth.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
const T = DEFAULT_TENANT_ID;
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const TABLES_TO_CLEAN = [
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.ApiKey,
  TABLES.Program,
  TABLES.Partner,
];

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
}

let programId = '';

async function seedProgram(windowDays = 60): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: 'Launch',
    attributionModel: 'last_click',
    attributionWindowDays: windowDays,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
    destinationUrl: 'https://x.test',
  });
  return id;
}

async function seedPartner(): Promise<{ id: string; bookingLink: string; generalLink: string }> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: T, name: `P ${id.slice(-4)}`, email: `p-${id}@x.test`, activatedAt: new Date() });
  await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: T, partnerId: id, programId, source: 'admin' });
  const bookingLink = ulid();
  const generalLink = ulid();
  await db(TABLES.Link).insert([
    { id: bookingLink, tenantId: T, partnerId: id, programId, linkKey: `bk-${bookingLink}` },
    { id: generalLink, tenantId: T, partnerId: id, programId, linkKey: `lk-${generalLink}` },
  ]);
  return { id, bookingLink, generalLink };
}

async function click(partnerId: string, linkId: string, opts: { ts?: Date; referer?: string | null; fraud?: boolean } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Click).insert({
    id,
    tenantId: T,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://x.test',
    ipHash: 'h',
    referer: opts.referer ?? null,
    fraudFlag: opts.fraud ? 'velocity' : null,
    ts: opts.ts ?? ago(5),
  });
  return id;
}

async function event(opts: {
  type?: string;
  value?: number | null;
  currency?: string;
  ts?: Date;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = ulid();
  await db(TABLES.Event).insert({
    id,
    tenantId: T,
    userId: `u-${id}`,
    type: opts.type ?? 'invoice_paid',
    value: opts.value === null ? null : (opts.value ?? 100).toFixed(2),
    currency: opts.currency ?? 'USD',
    metadata: opts.metadata ?? {},
    ts: opts.ts ?? ago(4),
  });
  return id;
}

async function attribute(
  eventId: string,
  partnerId: string,
  clickId: string,
  opts: { model?: string; weight?: number; computedAt?: Date } = {},
): Promise<void> {
  await db(TABLES.Attribution).insert({
    id: ulid(),
    tenantId: T,
    eventId,
    partnerId,
    programId,
    clickId,
    model: opts.model ?? 'last_click',
    weight: (opts.weight ?? 1).toFixed(4),
    computedAt: opts.computedAt ?? new Date(),
  });
}

async function refund(eventId: string, amount: number | null): Promise<void> {
  await event({ type: 'refund', value: amount === null ? null : -amount, metadata: { conversionEventId: eventId }, ts: ago(1) });
}

function results(partnerId: string, linkId: string, query: Record<string, string>, auth = admin) {
  return request(app).get(`/partners/${partnerId}/links/${linkId}/results`).query(query).set(auth);
}

const window = () => ({ clickSince: ago(10).toISOString(), clickUntil: ago(0).toISOString() });

describe.skipIf(skipIntegration)('GET /partners/:id/links/:linkId/results', () => {
  beforeAll(clean);
  afterAll(clean);
  beforeEach(async () => {
    await clean();
    programId = await seedProgram();
  });

  it('counts only the booking link, in its window, without flagged clicks', async () => {
    const p = await seedPartner();
    const c1 = await click(p.id, p.bookingLink, { referer: 'https://www.youtube.com/watch?v=abc' });
    await click(p.id, p.bookingLink, { referer: 'https://m.youtube.com/' });
    await click(p.id, p.bookingLink, { referer: 'not a url' });
    await click(p.id, p.bookingLink, { fraud: true, referer: 'https://spam.test/' });
    await click(p.id, p.bookingLink, { ts: ago(30) });
    const other = await click(p.id, p.generalLink, { referer: 'https://twitter.com/' });

    const sale = await event({ value: 200 });
    await attribute(sale, p.id, c1);
    const otherSale = await event({ value: 999 });
    await attribute(otherSale, p.id, other);

    const res = await results(p.id, p.bookingLink, window());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reportingVersion: 1,
      linkId: p.bookingLink,
      partnerId: p.id,
      programId,
      attributionWindowDays: 60,
      clicks: 3,
      sales: 1,
      leads: 0,
      refundedSales: 0,
      revenueByCurrency: { USD: 200 },
      refundedByCurrency: {},
    });
    expect(res.body.bySource).toEqual([
      { host: 'm.youtube.com', clicks: 1 },
      { host: 'youtube.com', clicks: 1 },
    ]);
    const days = res.body.daily as Array<{ date: string; clicks: number; sales: number }>;
    expect(days.reduce((s, d) => s + d.clicks, 0)).toBe(3);
    expect(days.reduce((s, d) => s + d.sales, 0)).toBe(1);
    expect(days[0]!.date).toBe(ago(10).toISOString().slice(0, 10));
  });

  it('counts each event once and credits the link its share under the live model', async () => {
    const p = await seedPartner();
    const other = await seedPartner();
    const a = await click(p.id, p.bookingLink, { ts: ago(6) });
    const b = await click(p.id, p.bookingLink, { ts: ago(5) });
    const theirs = await click(other.id, other.bookingLink, { ts: ago(5) });

    // Linear over two of the link's clicks and another partner's: one sale,
    // two thirds of it ours.
    const split = await event({ value: 300 });
    for (const c of [a, b]) await attribute(split, p.id, c, { model: 'linear', weight: 1 / 3, computedAt: ago(3) });
    await attribute(split, other.id, theirs, { model: 'linear', weight: 1 / 3, computedAt: ago(3) });

    // Re-run under another model later: the first-computed one stays live.
    const rerun = await event({ value: 100 });
    await attribute(rerun, other.id, theirs, { model: 'last_click', weight: 1, computedAt: ago(3) });
    await attribute(rerun, p.id, a, { model: 'first_click', weight: 1, computedAt: ago(1) });

    const lead = await event({ type: 'signup', value: null });
    await attribute(lead, p.id, a);
    await attribute(lead, p.id, b);

    const res = await results(p.id, p.bookingLink, window());
    expect(res.status).toBe(200);
    expect(res.body.sales).toBe(1);
    expect(res.body.leads).toBe(1);
    expect(res.body.revenueByCurrency).toEqual({ USD: 200 });
  });

  it('stops at conversionUntil, and a passed one wins over the program window', async () => {
    programId = await seedProgram(7);
    const p = await seedPartner();
    const c = await click(p.id, p.bookingLink, { ts: ago(9) });
    const early = await event({ value: 50, ts: ago(8) });
    const late = await event({ value: 70, ts: ago(2) });
    await attribute(early, p.id, c);
    await attribute(late, p.id, c);

    const clickUntil = ago(8.5).toISOString();
    const res = await results(p.id, p.bookingLink, { clickSince: ago(10).toISOString(), clickUntil });
    expect(res.body.attributionWindowDays).toBe(7);
    expect(Date.parse(res.body.conversionUntil)).toBe(Date.parse(clickUntil) + 7 * DAY);
    expect(res.body.revenueByCurrency).toEqual({ USD: 120 });

    const narrow = await results(p.id, p.bookingLink, { clickSince: ago(10).toISOString(), clickUntil, conversionUntil: ago(5).toISOString() });
    expect(narrow.body.sales).toBe(1);
    expect(narrow.body.revenueByCurrency).toEqual({ USD: 50 });
  });

  it('nets refunds the way bounties do', async () => {
    const p = await seedPartner();
    const c = await click(p.id, p.bookingLink);
    const partial = await event({ value: 100 });
    const full = await event({ value: 40 });
    const valueless = await event({ value: 60 });
    const stripe = await event({ value: 80, metadata: { stripeInvoiceId: 'in_1' } });
    for (const e of [partial, full, valueless, stripe]) await attribute(e, p.id, c);
    await refund(partial, 30);
    await refund(full, 25);
    await refund(full, 15);
    await refund(valueless, null);
    await event({
      type: 'refund',
      value: -20,
      metadata: { stripeInvoiceId: 'in_1', amountRefunded: 2000, chargeCollected: 8000, fullRefund: false },
      ts: ago(1),
    });

    const res = await results(p.id, p.bookingLink, window());
    expect(res.body.sales).toBe(4);
    expect(res.body.refundedSales).toBe(2);
    expect(res.body.revenueByCurrency).toEqual({ USD: 280 });
    expect(res.body.refundedByCurrency).toEqual({ USD: 30 + 40 + 60 + 20 });
  });

  it('keeps currencies apart', async () => {
    const p = await seedPartner();
    const c = await click(p.id, p.bookingLink);
    for (const [value, currency] of [[100, 'USD'], [9000, 'JPY'], [50, 'eur']] as const) {
      await attribute(await event({ value, currency }), p.id, c);
    }
    const res = await results(p.id, p.bookingLink, window());
    expect(res.body.revenueByCurrency).toEqual({ USD: 100, JPY: 9000, EUR: 50 });
  });

  it('finds the link by its key too', async () => {
    const p = await seedPartner();
    await click(p.id, p.bookingLink);
    const res = await results(p.id, `bk-${p.bookingLink}`, window());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linkId: p.bookingLink, clicks: 1 });
  });

  it("answers link_not_found for another partner's link and partner_not_found for a stranger", async () => {
    const p = await seedPartner();
    const other = await seedPartner();
    expect((await results(p.id, other.bookingLink, window())).body).toEqual({ error: 'link_not_found' });
    expect((await results(p.id, `bk-${other.bookingLink}`, window())).body).toEqual({ error: 'link_not_found' });
    expect((await results(p.id, ulid(), window())).status).toBe(404);
    expect((await results(ulid(), p.bookingLink, window())).body).toEqual({ error: 'partner_not_found' });
  });

  it('lets a partner read its own link but not another partner’s', async () => {
    const p = await seedPartner();
    const other = await seedPartner();
    const key = await createApiKeyRow(db, { tenantId: T, partnerId: p.id });
    const auth = { Authorization: `Bearer ${key.plaintext}` };
    expect((await results(p.id, p.bookingLink, window(), auth)).status).toBe(200);
    expect((await results(other.id, other.bookingLink, window(), auth)).status).toBe(403);
  });

  it('refuses a window that runs backwards or is too long', async () => {
    const p = await seedPartner();
    const backwards = await results(p.id, p.bookingLink, { clickSince: ago(1).toISOString(), clickUntil: ago(2).toISOString() });
    expect(backwards.status).toBe(400);
    const long = await results(p.id, p.bookingLink, { clickSince: ago(500).toISOString(), clickUntil: ago(0).toISOString() });
    expect(long.status).toBe(400);
    const early = await results(p.id, p.bookingLink, { ...window(), conversionUntil: ago(20).toISOString() });
    expect(early.status).toBe(400);
    // A conversion tail without end would make an endless daily series.
    const ancient = await results(p.id, p.bookingLink, {
      clickSince: '0001-01-01T00:00:00Z',
      clickUntil: '0001-01-02T00:00:00Z',
      conversionUntil: new Date().toISOString(),
    });
    expect(ancient.status).toBe(400);
  });
});
