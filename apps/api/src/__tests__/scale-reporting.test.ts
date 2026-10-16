/**
 * Admin reporting + headless API at partner-program scale (tens of
 * thousands of partners).
 *
 *   - GET /admin/overview: totals are whole-tenant aggregates (it used to
 *     load the 200 newest partners and sum commission over only those),
 *     and the per-partner rows page by a ranked cursor.
 *   - GET /partners + GET /commissions: keyset cursors survive rows that
 *     share one microsecond timestamp (a CSV import, a batch accrual).
 *   - GET /partners?q=: server-side name/email search, so admin pickers
 *     find a partner without loading the whole roster; it pages with the
 *     same cursor and ordering.
 *   - Scoped integration keys can read per-partner links, payouts and the
 *     partner record; partner keys stay confined to their own data.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_scale_reporting_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const OTHER_TENANT_ID = 'scale-reporting-test-tenant-b';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Payout,
  TABLES.ApiKey,
  TABLES.Partner,
];

const STATUSES = ['accrued', 'approved', 'paid', 'reversed'] as const;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'scale-reporting-b', displayName: 'B', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

function admin(path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`);
}

async function createProgram(tenantId: string = DEFAULT_TENANT_ID): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name: 'Prog',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: 'https://example.com',
  });
  return id;
}

/** One click → event → attribution → commission chain for a partner. */
async function seedActivity(opts: {
  tenantId?: string;
  partnerId: string;
  programId: string;
  revenue: number;
  commission: number;
  status: (typeof STATUSES)[number];
}) {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  await db(TABLES.Link).insert({
    id: linkId, tenantId, partnerId: opts.partnerId, programId: opts.programId,
    linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId, tenantId, linkId, partnerId: opts.partnerId, programId: opts.programId,
    landingUrl: 'https://example.com/l', ipHash: 'h', ts: new Date(),
  });
  await db(TABLES.Event).insert({
    id: eventId, tenantId, userId: `u-${eventId}`, type: 'invoice_paid',
    value: opts.revenue.toFixed(2), currency: 'USD', ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId, eventId, partnerId: opts.partnerId, programId: opts.programId,
    clickId, model: 'last_click', weight: '1', computedAt: new Date(),
  });
  await db(TABLES.Commission).insert({
    id: ulid(), tenantId, attributionId, partnerId: opts.partnerId,
    amount: opts.commission.toFixed(2), currency: 'USD', status: opts.status,
  });
}

/** Insert `count` partners in ONE statement so they share a single
 *  microsecond `now()` createdAt — the shape a CSV import produces. */
async function insertPartnerBatch(count: number, prefix: string): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: ulid(),
    tenantId: DEFAULT_TENANT_ID,
    email: `${prefix}-${i}@example.com`,
    name: `${prefix} ${i}`,
  }));
  await db(TABLES.Partner).insert(rows);
  return rows.map((r) => r.id);
}

interface OverviewPartner {
  id: string;
  revenue: number;
  clicks: number;
  events: number;
  commission: Record<string, number>;
}

async function pageOverview(sort: string, limit: number): Promise<OverviewPartner[][]> {
  const pages: OverviewPartner[][] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ sort, limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const res = await admin(`/admin/overview?${qs}`);
    expect(res.status).toBe(200);
    pages.push(res.body.partners);
    cursor = res.body.nextCursor;
    expect(pages.length).toBeLessThan(50); // runaway guard
  } while (cursor);
  return pages;
}

describe.skipIf(skipIntegration)('GET /admin/overview at scale', () => {
  // 40 older partners carry all the activity; 210 newer ones (one batch,
  // shared createdAt) have none. The old endpoint loaded only the 200
  // newest — so it reported 200 partners and $0 commission.
  async function seedProgram() {
    const programId = await createProgram();
    const active: Array<{ id: string; revenue: number; commission: number; status: (typeof STATUSES)[number] }> = [];
    for (let k = 0; k < 40; k++) {
      const id = ulid();
      await db(TABLES.Partner).insert({
        id, tenantId: DEFAULT_TENANT_ID, email: `old-${k}@example.com`, name: `Old ${k}`,
        createdAt: new Date(Date.now() - 10 * DAY),
      });
      const row = { id, revenue: (k + 1) * 10, commission: k + 1, status: STATUSES[k % 4]! };
      await seedActivity({ partnerId: id, programId, ...row });
      active.push(row);
    }
    const idle = await insertPartnerBatch(210, 'new');
    return { active, idle };
  }

  it('totals cover every partner in the tenant, not the newest 200', async () => {
    const { active } = await seedProgram();

    // Another tenant's activity must not leak into this tenant's totals.
    const otherProgram = await createProgram(OTHER_TENANT_ID);
    const otherPartner = ulid();
    await db(TABLES.Partner).insert({ id: otherPartner, tenantId: OTHER_TENANT_ID, email: 'b@example.com', name: 'B' });
    await seedActivity({
      tenantId: OTHER_TENANT_ID, partnerId: otherPartner, programId: otherProgram,
      revenue: 99999, commission: 9999, status: 'accrued',
    });

    const res = await admin('/admin/overview');
    expect(res.status).toBe(200);
    const sumWhere = (s: string) => active.filter((a) => a.status === s).reduce((n, a) => n + a.commission, 0);
    expect(res.body.totals).toEqual({
      partners: 250,
      clicks: 40,
      attributedRevenue: active.reduce((n, a) => n + a.revenue, 0),
      attributedEvents: 40,
      commissionAccrued: sumWhere('accrued'),
      commissionApproved: sumWhere('approved'),
      commissionPaid: sumWhere('paid'),
    });
    expect(sumWhere('accrued')).toBeGreaterThan(0);
  });

  it('pages every partner exactly once, ranked by revenue', async () => {
    const { active, idle } = await seedProgram();
    const pages = await pageOverview('revenue', 100);
    expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);

    const rows = pages.flat();
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(250);
    expect(new Set(ids)).toEqual(new Set([...active.map((a) => a.id), ...idle]));

    // Ranked: revenue non-increasing across page boundaries, ties by id desc.
    for (let i = 1; i < rows.length; i++) {
      const [prev, cur] = [rows[i - 1]!, rows[i]!];
      expect(cur.revenue).toBeLessThanOrEqual(prev.revenue);
      if (cur.revenue === prev.revenue) expect(cur.id < prev.id).toBe(true);
    }
    const top = active[39]!;
    expect(rows[0]).toMatchObject({ id: top.id, revenue: top.revenue, clicks: 1, events: 1 });
  });

  it('ranks by non-reversed commission when sort=commission', async () => {
    const { active } = await seedProgram();
    const res = await admin('/admin/overview?sort=commission&limit=3');
    expect(res.status).toBe(200);
    // k=39 has the largest amount but it is reversed — k=38 (paid) leads.
    const [first, second] = res.body.partners as OverviewPartner[];
    expect(first!.id).toBe(active[38]!.id);
    expect(first!.commission).toEqual({ accrued: 0, approved: 0, paid: 39, reversed: 0 });
    expect(second!.id).toBe(active[37]!.id);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it('rejects a cursor minted under a different sort, and garbage cursors', async () => {
    await seedProgram();
    const first = await admin('/admin/overview?sort=revenue&limit=5');
    const cursor = first.body.nextCursor as string;
    expect((await admin(`/admin/overview?sort=clicks&cursor=${cursor}`)).status).toBe(400);
    const bad = await admin('/admin/overview?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_cursor');
    expect((await admin('/admin/overview?sort=bogus')).status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('keyset cursors survive shared timestamps', () => {
  it('GET /partners pages through a same-transaction batch without skipping rows', async () => {
    const ids = await insertPartnerBatch(250, 'batch');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await admin(`/partners?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.partners.map((p: { id: string }) => p.id));
      expect(res.body.partners[0]?._cursorTs).toBeUndefined();
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(250);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('GET /partners still accepts a millisecond cursor minted before the fix', async () => {
    const [a, b] = await insertPartnerBatch(2, 'legacy');
    // Pin distinct millisecond timestamps, as POST /partners rows had.
    await db(TABLES.Partner).where({ id: a }).update({ createdAt: new Date('2026-01-02T00:00:00.000Z') });
    await db(TABLES.Partner).where({ id: b }).update({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const legacy = Buffer.from(`2026-01-02T00:00:00.000Z|${a}`).toString('base64url');
    const res = await admin(`/partners?cursor=${legacy}`);
    expect(res.status).toBe(200);
    expect(res.body.partners.map((p: { id: string }) => p.id)).toEqual([b]);
  });

  it('GET /partners?q= pages a search across shared-timestamp batches in createdAt DESC, id DESC order', async () => {
    // Non-matching rows on both sides of, and between, the matching
    // batches: the cursor has to step over them, not stop at them.
    await insertPartnerBatch(40, 'hay-old');
    const older = await insertPartnerBatch(150, 'needle-a');
    await insertPartnerBatch(40, 'hay-mid');
    const newer = await insertPartnerBatch(100, 'needle-b');
    await insertPartnerBatch(40, 'hay-new');

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ q: 'NEEDLE', limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const res = await admin(`/partners?${qs}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.partners.map((p: { id: string }) => p.id));
      cursor = res.body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(pages).toBe(3);
    // Each batch shares one createdAt, so the newer batch comes first and
    // each batch runs in id order, descending.
    const desc = (ids: string[]) => [...ids].sort().reverse();
    expect(seen).toEqual([...desc(newer), ...desc(older)]);
  });

  async function seedCommissionBatch(partnerIds: string[], perPartner: number) {
    const programId = await createProgram();
    const rows: Array<Record<string, unknown>> = [];
    for (const partnerId of partnerIds) {
      const linkId = ulid();
      const clickId = ulid();
      await db(TABLES.Link).insert({
        id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId,
        linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com',
      });
      await db(TABLES.Click).insert({
        id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
        landingUrl: 'https://example.com/l', ipHash: 'h',
      });
      for (let i = 0; i < perPartner; i++) {
        const eventId = ulid();
        const attributionId = ulid();
        await db(TABLES.Event).insert({
          id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`, type: 'invoice_paid', value: '10.00',
        });
        await db(TABLES.Attribution).insert({
          id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId,
          clickId, model: 'last_click', weight: '1',
        });
        rows.push({
          id: ulid(), tenantId: DEFAULT_TENANT_ID, attributionId, partnerId,
          amount: '1.00', currency: 'USD', status: i % 2 === 0 ? 'accrued' : 'approved',
        });
      }
    }
    // One statement → one shared accruedAt, like a batch accrual.
    await db(TABLES.Commission).insert(rows);
    return rows.map((r) => r.id as string);
  }

  async function pageCommissions(base: string, limit: number) {
    const seen: Array<{ id: string; accruedAt: string; status: string; partnerId: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = base.includes('?') ? '&' : '?';
      const res = await admin(`${base}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.commissions);
      cursor = res.body.nextCursor;
      pages++;
      expect(pages).toBeLessThan(50);
    } while (cursor);
    return { seen, pages };
  }

  it('GET /commissions pages the whole history past the old 500 cap', async () => {
    const partners = await insertPartnerBatch(3, 'comm');
    const ids = await seedCommissionBatch(partners, 210); // 630 commissions

    const { seen, pages } = await pageCommissions('/commissions', 250);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(630);
    expect(new Set(seen.map((c) => c.id))).toEqual(new Set(ids));
    // Shared accruedAt → order falls to the id tiebreak.
    const order = seen.map((c) => c.id);
    expect(order).toEqual([...order].sort().reverse());
    expect(seen[0]).not.toHaveProperty('_cursorTs');
    expect(seen[0]).toHaveProperty('matureAt');

    // Status filter composes with the cursor.
    const approved = await pageCommissions('/commissions?status=approved', 100);
    expect(approved.seen).toHaveLength(315);
    expect(approved.seen.every((c) => c.status === 'approved')).toBe(true);
  });

  it('GET /partners/:id/commissions pages a single partner', async () => {
    const partners = await insertPartnerBatch(2, 'one');
    await seedCommissionBatch(partners, 120);
    const { seen } = await pageCommissions(`/partners/${partners[0]}/commissions`, 50);
    expect(seen).toHaveLength(120);
    expect(seen.every((c) => c.partnerId === partners[0])).toBe(true);
  });

  it('GET /commissions rejects an undecodable cursor', async () => {
    const res = await admin('/commissions?cursor=garbage');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });
});

describe.skipIf(skipIntegration)('GET /partners?q= search', () => {
  async function insertPartner(name: string, email: string, createdAt = new Date()): Promise<string> {
    const id = ulid();
    await db(TABLES.Partner).insert({ id, tenantId: DEFAULT_TENANT_ID, name, email, createdAt });
    return id;
  }

  async function search(qs: string): Promise<string[]> {
    const res = await admin(`/partners?${qs}`);
    expect(res.status).toBe(200);
    return res.body.partners.map((p: { id: string }) => p.id);
  }

  it('matches any part of the name or email, case-insensitively, newest first', async () => {
    const t = Date.now();
    const ada = await insertPartner('Ada Lovelace', 'ada@example.com', new Date(t - 3 * DAY));
    const grace = await insertPartner('Grace Hopper', 'grace@navy.example', new Date(t - 2 * DAY));
    const alan = await insertPartner('Alan Turing', 'lovelace-fan@example.org', new Date(t - DAY));
    await insertPartner('Someone Else', 'nobody@example.net', new Date(t));

    // Ada matches on name, Alan on email.
    expect(await search('q=LOVELACE')).toEqual([alan, ada]);
    expect(await search('q=hopp')).toEqual([grace]);
    expect(await search('q=NAVY.example')).toEqual([grace]);
    expect(await search('q=zzz')).toEqual([]);
    // Surrounding whitespace is trimmed.
    expect(await search(`q=${encodeURIComponent('  grace  ')}`)).toEqual([grace]);
    // Combines with the exact email lookup (both must hold).
    expect(await search('q=lovelace&email=ada@example.com')).toEqual([ada]);
    expect(await search('q=hopper&email=ada@example.com')).toEqual([]);
  });

  it('treats LIKE wildcards in the term literally', async () => {
    const pct = await insertPartner('Promo 50% Club', 'pct@example.com');
    await insertPartner('Promo 500 Club', 'p500@example.com');
    const under = await insertPartner('snake_case', 'under@example.com');
    await insertPartner('snakeXcase', 'x@example.com');
    const slash = await insertPartner('back\\slash', 'slash@example.com');
    await insertPartner('backslash', 'noslash@example.com');

    expect(await search(`q=${encodeURIComponent('50%')}`)).toEqual([pct]);
    expect(await search(`q=${encodeURIComponent('e_c')}`)).toEqual([under]);
    expect(await search(`q=${encodeURIComponent('\\')}`)).toEqual([slash]);
  });

  it('a blank q is no filter; an overlong one is rejected', async () => {
    const ids = await insertPartnerBatch(3, 'blank');
    expect(new Set(await search(`q=${encodeURIComponent('   ')}`))).toEqual(new Set(ids));
    expect(new Set(await search('q='))).toEqual(new Set(ids));

    const res = await admin(`/partners?q=${'x'.repeat(201)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
  });
});

describe.skipIf(skipIntegration)('per-partner reads for headless integrations', () => {
  async function mintScoped(scopes: string[]): Promise<string> {
    const res = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes, label: 'headless-test' });
    expect(res.status).toBe(201);
    return res.body.plaintext as string;
  }

  async function seedPartnerWithLinkAndPayout(): Promise<string> {
    const programId = await createProgram();
    const partnerId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, email: `h-${partnerId}@example.com`, name: 'H' });
    await db(TABLES.Link).insert({
      id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId, programId,
      linkKey: `lk-${partnerId}`, destinationUrl: 'https://example.com',
    });
    await db(TABLES.Payout).insert({
      id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId, amount: '12.00', currency: 'USD',
      method: 'manual', status: 'paid',
    });
    return partnerId;
  }

  const get = (path: string, key: string) => request(app).get(path).set('Authorization', `Bearer ${key}`);

  it('links:read and payouts:read open the per-partner reads for scoped keys', async () => {
    const partnerId = await seedPartnerWithLinkAndPayout();
    const reader = await mintScoped(['links:read', 'payouts:read', 'partners:read']);

    const links = await get(`/partners/${partnerId}/links`, reader);
    expect(links.status).toBe(200);
    expect(links.body.links).toHaveLength(1);

    const payouts = await get(`/partners/${partnerId}/payouts`, reader);
    expect(payouts.status).toBe(200);
    expect(payouts.body.payouts).toHaveLength(1);

    const profile = await get(`/partners/${partnerId}`, reader);
    expect(profile.status).toBe(200);
    expect(profile.body.id).toBe(partnerId);

    // Read scopes don't confer writes.
    const write = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${reader}`)
      .send({ linkKey: 'nope-123', programId: 'x' });
    expect(write.status).toBe(403);
    expect(write.body).toEqual({ error: 'forbidden_scope', required: 'links:write' });
  });

  it('a scoped key without the read scope is refused with the scope it needs', async () => {
    const partnerId = await seedPartnerWithLinkAndPayout();
    const crmOnly = await mintScoped(['events:write']);
    for (const [path, scope] of [
      [`/partners/${partnerId}/links`, 'links:read'],
      [`/partners/${partnerId}/payouts`, 'payouts:read'],
      [`/partners/${partnerId}`, 'partners:read'],
    ] as const) {
      const res = await get(path, crmOnly);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden_scope', required: scope });
    }
  });

  it('partner keys still read only their own links and payouts', async () => {
    const mine = await seedPartnerWithLinkAndPayout();
    const theirs = await seedPartnerWithLinkAndPayout();
    const minted = await request(app)
      .post(`/partners/${mine}/api-keys`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ label: 'partner' });
    expect(minted.status).toBe(201);
    const partnerKey = minted.body.plaintext as string;

    expect((await get(`/partners/${mine}/links`, partnerKey)).status).toBe(200);
    expect((await get(`/partners/${mine}/payouts`, partnerKey)).status).toBe(200);
    expect((await get(`/partners/${theirs}/links`, partnerKey)).status).toBe(403);
    expect((await get(`/partners/${theirs}/payouts`, partnerKey)).status).toBe(403);
    expect((await get(`/partners/${theirs}`, partnerKey)).status).toBe(403);
    // Partner principals can't reach the tenant-wide lists either.
    expect((await get('/commissions', partnerKey)).status).toBe(403);
    expect((await get('/admin/overview', partnerKey)).status).toBe(403);
  });
});
