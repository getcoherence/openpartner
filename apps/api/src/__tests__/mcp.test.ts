/**
 * The brand's read-only MCP server: POST /t/<slug>/mcp (routes/mcp.ts,
 * mcp/server.ts, mcp/report.ts; docs/mcp.md).
 *
 *   - Auth is the REST API's: no credential, another brand's key, a partner
 *     key and a scoped key without reports:read are refused; a reports:read
 *     key and a view-only seat may read; the calls aren't written to the
 *     audit log.
 *   - Each tool answers from seeded data, through the official MCP client
 *     (2026-07-28) and, for 2025-era clients, the SDK's stateless fallback.
 *   - Another tenant's rows never show up, and its ids are "not found".
 *   - get_performance's program rows match GET /programs/stats, and its
 *     partner rows add up to the program totals.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_admin_key_mcp_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'https://portal.example.com';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { createSession } = await import('../auth-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const A = { id: 'mcp-test-tenant-a', slug: 'mcp-test-a' };
const B = { id: 'mcp-test-tenant-b', slug: 'mcp-test-b' };
const TENANTS = [A.id, B.id];

const CLEAN = [
  TABLES.AuditLog,
  TABLES.Commission,
  TABLES.Bonus,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Session,
  TABLES.Admin,
  TABLES.ApiKey,
  TABLES.Partner,
];

async function cleanup(): Promise<void> {
  for (const t of CLEAN) await db(t).whereIn('tenantId', TENANTS).del();
}

/** Seeded ids and credentials. */
const s = {} as {
  keyA: string;
  keyB: string;
  partnerKeyA: string;
  scopedKeyA: string;
  reportsKeyA: string;
  viewerCookie: string;
  spring: string;
  fall: string;
  programB: string;
  ana: string;
  ben: string;
  cy: string;
  partnerB: string;
  linkSpring: string;
  linkSummer: string;
  linkFall: string;
  linkB: string;
  springClick: string;
};

async function program(tenantId: string, name: string, createdAt: Date) {
  const id = ulid();
  await db(TABLES.Program).insert({
    id, tenantId, name, attributionModel: 'last_click', attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 10 }, destinationUrl: `https://shop.example.com/${name.toLowerCase()}`, createdAt,
  });
  return id;
}

async function partner(tenantId: string, name: string, opts: { activated?: boolean; revoked?: boolean; createdAt?: Date } = {}) {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id, tenantId, email: `${name.toLowerCase()}-${id.toLowerCase()}@example.com`, name,
    activatedAt: opts.activated === false ? null : new Date(), revokedAt: opts.revoked ? new Date() : null,
    createdAt: opts.createdAt ?? new Date(),
  });
  return id;
}

async function link(tenantId: string, partnerId: string, programId: string, linkKey: string, createdAt: Date, destinationUrl: string | null = null) {
  const id = ulid();
  await db(TABLES.Link).insert({ id, tenantId, partnerId, programId, linkKey, destinationUrl, createdAt });
  return id;
}

async function click(o: { tenantId?: string; partnerId: string; programId: string; linkId: string | null; at: Date; utmCampaign?: string }) {
  const id = ulid();
  await db(TABLES.Click).insert({
    id, tenantId: o.tenantId ?? A.id, linkId: o.linkId, partnerId: o.partnerId, programId: o.programId,
    landingUrl: 'https://shop.example.com/landing?cref=x', ipHash: 'h', ts: o.at, utmCampaign: o.utmCampaign ?? null,
    utmSource: o.utmCampaign ? 'meta' : null,
  });
  return id;
}

/** An event attributed through `clickId`, with its commission when given. */
async function conversion(o: {
  tenantId?: string;
  clickId: string;
  partnerId: string;
  programId: string;
  type: string;
  value: number | null;
  currency?: string;
  at: Date;
  commission?: { amount: number; status: 'accrued' | 'approved' | 'paid' | 'reversed' };
}) {
  const tenantId = o.tenantId ?? A.id;
  const eventId = ulid();
  const attributionId = ulid();
  await db(TABLES.Event).insert({
    id: eventId, tenantId, userId: `cust-${eventId}`, type: o.type, value: o.value === null ? null : o.value.toFixed(2),
    currency: o.currency ?? 'USD', ts: o.at,
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId, eventId, partnerId: o.partnerId, programId: o.programId, clickId: o.clickId,
    model: 'last_click', weight: '1', computedAt: o.at,
  });
  if (o.commission) {
    await db(TABLES.Commission).insert({
      id: ulid(), tenantId, attributionId, partnerId: o.partnerId, amount: o.commission.amount.toFixed(2),
      currency: o.currency ?? 'USD', status: o.commission.status, accruedAt: o.at,
    });
  }
  return eventId;
}

/**
 * Brand A:
 *   Spring program: Ana (active), Ben (invited, no activity)
 *     ana-spring   2 clicks today (one utm_campaign=spring_sale, which
 *                  converts: a signup and a $100 sale, $10 accrued), plus a
 *                  click and a $500 sale 40 days ago (outside the window)
 *     ana-summer   1 click, a $50 sale ($5 paid) refunded $20
 *     coupon       Ana's coupon click (no link): a $30 sale, $3 accrued
 *     bonus        Ana: $7 accrued, in Spring
 *   Fall program: Cy (revoked)
 *     cy-fall      2 clicks (utm_campaign=fall), a €80 sale (€8 approved)
 * Brand B: its own program, partner, link and a $999 sale.
 */
async function seed() {
  await db(TABLES.Tenant)
    .insert([
      { id: A.id, slug: A.slug, displayName: 'MCP A', status: 'active', defaultCurrency: 'USD' },
      { id: B.id, slug: B.slug, displayName: 'MCP B', status: 'active', defaultCurrency: 'USD' },
    ])
    .onConflict('id')
    .ignore();

  s.spring = await program(A.id, 'Spring', ago(3));
  s.fall = await program(A.id, 'Fall', ago(2));
  s.ana = await partner(A.id, 'Ana', { createdAt: ago(3) });
  s.ben = await partner(A.id, 'Ben', { activated: false, createdAt: ago(2) });
  s.cy = await partner(A.id, 'Cy', { revoked: true, createdAt: ago(1) });
  for (const [p, g] of [
    [s.ana, s.spring],
    [s.ben, s.spring],
    [s.cy, s.fall],
  ] as const) {
    await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: A.id, partnerId: p, programId: g, source: 'admin' });
  }
  s.linkSpring = await link(A.id, s.ana, s.spring, 'ana-spring', ago(3));
  s.linkSummer = await link(A.id, s.ana, s.spring, 'ana-summer', ago(2), 'https://shop.example.com/summer');
  s.linkFall = await link(A.id, s.cy, s.fall, 'cy-fall', ago(1));

  const now = ago(0.01);
  s.springClick = await click({ partnerId: s.ana, programId: s.spring, linkId: s.linkSpring, at: now, utmCampaign: 'spring_sale' });
  await click({ partnerId: s.ana, programId: s.spring, linkId: s.linkSpring, at: now });
  await conversion({ clickId: s.springClick, partnerId: s.ana, programId: s.spring, type: 'signup', value: null, at: now });
  await conversion({
    clickId: s.springClick, partnerId: s.ana, programId: s.spring, type: 'invoice_paid', value: 100, at: now,
    commission: { amount: 10, status: 'accrued' },
  });
  const oldClick = await click({ partnerId: s.ana, programId: s.spring, linkId: s.linkSpring, at: ago(40) });
  await conversion({
    clickId: oldClick, partnerId: s.ana, programId: s.spring, type: 'invoice_paid', value: 500, at: ago(40),
    commission: { amount: 50, status: 'paid' },
  });

  const summerClick = await click({ partnerId: s.ana, programId: s.spring, linkId: s.linkSummer, at: now });
  const summerSale = await conversion({
    clickId: summerClick, partnerId: s.ana, programId: s.spring, type: 'invoice_paid', value: 50, at: now,
    commission: { amount: 5, status: 'paid' },
  });
  await db(TABLES.Event).insert({
    id: ulid(), tenantId: A.id, userId: 'cust-refund', type: 'refund', value: '-20.00', currency: 'USD', ts: now,
    metadata: { conversionEventId: summerSale },
  });

  const couponClick = await click({ partnerId: s.ana, programId: s.spring, linkId: null, at: now });
  await conversion({
    clickId: couponClick, partnerId: s.ana, programId: s.spring, type: 'invoice_paid', value: 30, at: now,
    commission: { amount: 3, status: 'accrued' },
  });

  const bonusId = ulid();
  await db(TABLES.Bonus).insert({
    id: bonusId, tenantId: A.id, partnerId: s.ana, programId: s.spring, amount: '7.00', currency: 'USD', source: 'manual',
  });
  await db(TABLES.Commission).insert({
    id: ulid(), tenantId: A.id, attributionId: null, bonusId, partnerId: s.ana, amount: '7.00', currency: 'USD',
    status: 'accrued', accruedAt: now,
  });

  const fallClick = await click({ partnerId: s.cy, programId: s.fall, linkId: s.linkFall, at: now, utmCampaign: 'fall' });
  await click({ partnerId: s.cy, programId: s.fall, linkId: s.linkFall, at: now, utmCampaign: 'fall' });
  await conversion({
    clickId: fallClick, partnerId: s.cy, programId: s.fall, type: 'invoice_paid', value: 80, currency: 'EUR', at: now,
    commission: { amount: 8, status: 'approved' },
  });

  s.programB = await program(B.id, 'Other', ago(1));
  s.partnerB = await partner(B.id, 'Other');
  s.linkB = await link(B.id, s.partnerB, s.programB, 'other-link', ago(1));
  const clickB = await click({ tenantId: B.id, partnerId: s.partnerB, programId: s.programB, linkId: s.linkB, at: now });
  await conversion({
    tenantId: B.id, clickId: clickB, partnerId: s.partnerB, programId: s.programB, type: 'invoice_paid', value: 999, at: now,
    commission: { amount: 99, status: 'accrued' },
  });

  s.keyA = (await createApiKeyRow(db, { tenantId: A.id, label: 'agent' })).plaintext;
  s.keyB = (await createApiKeyRow(db, { tenantId: B.id, label: 'agent' })).plaintext;
  s.partnerKeyA = (await createApiKeyRow(db, { tenantId: A.id, partnerId: s.ana })).plaintext;
  s.scopedKeyA = (await createApiKeyRow(db, { tenantId: A.id, scopes: ['partners:read'] })).plaintext;
  s.reportsKeyA = (await createApiKeyRow(db, { tenantId: A.id, scopes: ['reports:read'] })).plaintext;
  const viewerId = ulid();
  await db(TABLES.Admin).insert({
    id: viewerId, tenantId: A.id, email: `viewer-${viewerId.toLowerCase()}@example.com`, name: 'Viewer', role: 'viewer',
    activatedAt: new Date(),
  });
  const session = await createSession(db, { tenantId: A.id, principalKind: 'admin', principalId: viewerId });
  s.viewerCookie = `op_session=${session.plaintext}`;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  if (skipIntegration) return;
  await cleanup();
  await seed();
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!skipIntegration) {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await cleanup();
    await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  }
  await db.destroy();
});

async function connect(headers: Record<string, string>, slug = A.slug): Promise<Client> {
  const client = new Client({ name: 'openpartner-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/t/${slug}/mcp`), { requestInit: { headers } }));
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
  return res.structuredContent as T;
}

/** A 2025-era JSON-RPC POST, as an older client sends it. */
function legacyPost(slug: string, body: object, auth?: Record<string, string>) {
  const req = request(app)
    .post(`/t/${slug}/mcp`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(auth ?? {})) req.set(k, v);
  return req.send(body);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
};

type Row = Record<string, unknown> & {
  clicks: number;
  attributedEvents: number;
  signups: number;
  paidConversions: number;
  revenue: Array<{ currency: string; gross: number; refunded: number; net: number }>;
  commission: Array<{ currency: string; accrued: number; approved: number; paid: number; reversed: number }>;
};

describe.skipIf(skipIntegration)('MCP auth', () => {
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  it('refuses a request with no credential', async () => {
    const res = await legacyPost(A.slug, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it("refuses another brand's key, both ways", async () => {
    expect((await legacyPost(A.slug, INITIALIZE, bearer(s.keyB))).status).toBe(401);
    expect((await legacyPost(B.slug, INITIALIZE, bearer(s.keyA))).status).toBe(401);
  });

  it('refuses partner keys and scoped keys without reports:read', async () => {
    const partnerRes = await legacyPost(A.slug, INITIALIZE, bearer(s.partnerKeyA));
    expect([partnerRes.status, partnerRes.body]).toEqual([403, { error: 'forbidden' }]);
    const scopedRes = await legacyPost(A.slug, INITIALIZE, bearer(s.scopedKeyA));
    expect([scopedRes.status, scopedRes.body]).toEqual([403, { error: 'forbidden_scope', required: 'reports:read' }]);
  });

  it('lets a reports:read key read here, and nowhere else', async () => {
    const client = await connect(bearer(s.reportsKeyA));
    const out = await call<{ partners: unknown[] }>(client, 'list_partners');
    expect(out.partners).toHaveLength(3);
    await client.close();
    const elsewhere = await request(app).get(`/t/${A.slug}/partners`).set(bearer(s.reportsKeyA));
    expect([elsewhere.status, elsewhere.body]).toEqual([403, { error: 'forbidden_scope', required: 'partners:read' }]);
    const overview = await request(app).get(`/t/${A.slug}/admin/overview`).set(bearer(s.reportsKeyA));
    expect(overview.status).toBe(403);
  });

  it('lets a view-only seat read', async () => {
    const client = await connect({ Cookie: s.viewerCookie });
    const out = await call<{ programs: Array<{ name: string }> }>(client, 'list_programs');
    expect(out.programs.map((p) => p.name)).toEqual(['Fall', 'Spring']);
    await client.close();
  });

  it('serves 2025-era clients statelessly, and answers GET with 405', async () => {
    const init = await legacyPost(A.slug, INITIALIZE, bearer(s.keyA));
    expect(init.status).toBe(200);
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(init.text).toContain('"serverInfo"');
    const listed = await legacyPost(A.slug, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_programs', arguments: {} } }, {
      ...bearer(s.keyA),
      'MCP-Protocol-Version': '2025-06-18',
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('Spring');
    expect(listed.text).not.toContain('Other');

    const get = await request(app).get(`/t/${A.slug}/mcp`).set(bearer(s.keyA));
    expect(get.status).toBe(405);
  });

  it("doesn't write the audit log", async () => {
    const client = await connect(bearer(s.keyA));
    await call(client, 'list_partners');
    await client.close();
    expect(await db(TABLES.AuditLog).whereIn('tenantId', TENANTS).count({ n: '*' })).toEqual([{ n: '0' }]);
  });
});

describe.skipIf(skipIntegration)('MCP tools', () => {
  let client: Client;
  beforeAll(async () => {
    if (skipIntegration) return;
    client = await connect({ Authorization: `Bearer ${s.keyA}` });
  });
  afterAll(async () => {
    await client?.close();
  });

  it('lists five read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_performance', 'list_links', 'list_partners', 'list_programs', 'recent_conversions']);
    for (const t of tools) expect([t.name, t.annotations?.readOnlyHint]).toEqual([t.name, true]);
  });

  it('list_programs', async () => {
    const out = await call<{ currency: string; programs: Array<Record<string, unknown>> }>(client, 'list_programs');
    expect(out.currency).toBe('USD');
    expect(out.programs).toEqual([
      expect.objectContaining({ programId: s.fall, name: 'Fall', status: 'active', destinationUrl: 'https://shop.example.com/fall' }),
      expect.objectContaining({ programId: s.spring, name: 'Spring', status: 'active', attributionModel: 'last_click', attributionWindowDays: 60 }),
    ]);
  });

  it('list_partners, by status and program, paged', async () => {
    const all = await call<{ partners: Array<{ partnerId: string; name: string; status: string }>; nextCursor: string | null }>(
      client,
      'list_partners',
    );
    expect(all.partners.map((p) => [p.name, p.status])).toEqual([
      ['Cy', 'revoked'],
      ['Ben', 'invited'],
      ['Ana', 'active'],
    ]);
    expect(all.nextCursor).toBeNull();

    const spring = await call<{ partners: Array<{ name: string }> }>(client, 'list_partners', { programId: s.spring });
    expect(spring.partners.map((p) => p.name)).toEqual(['Ben', 'Ana']);
    const invited = await call<{ partners: Array<{ name: string }> }>(client, 'list_partners', { status: 'invited' });
    expect(invited.partners.map((p) => p.name)).toEqual(['Ben']);

    const first = await call<{ partners: Array<{ name: string }>; nextCursor: string }>(client, 'list_partners', { limit: 2 });
    expect(first.partners.map((p) => p.name)).toEqual(['Cy', 'Ben']);
    const second = await call<{ partners: Array<{ name: string }>; nextCursor: string | null }>(client, 'list_partners', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect([second.partners.map((p) => p.name), second.nextCursor]).toEqual([['Ana'], null]);
  });

  it('list_links, with the URL partners share', async () => {
    const out = await call<{ links: Array<Record<string, unknown>> }>(client, 'list_links', { partnerId: s.ana });
    expect(out.links).toEqual([
      expect.objectContaining({
        linkId: s.linkSummer,
        linkKey: 'ana-summer',
        shareUrl: `https://portal.example.com/r/${A.slug}/ana-summer`,
        destinationUrl: 'https://shop.example.com/summer',
        partnerName: 'Ana',
        programName: 'Spring',
      }),
      expect.objectContaining({
        linkId: s.linkSpring,
        shareUrl: `https://portal.example.com/r/${A.slug}/ana-spring`,
        destinationUrl: 'https://shop.example.com/spring',
      }),
    ]);
  });

  it('get_performance by link', async () => {
    const out = await call<{ rows: Row[]; totalRows: number; currency: string; nextOffset: number | null }>(client, 'get_performance', {
      groupBy: 'link',
    });
    expect(out.totalRows).toBe(4);
    const byLink = new Map(out.rows.map((r) => [r.linkKey ?? `none:${r.partnerId}`, r]));
    expect(byLink.get('ana-spring')).toMatchObject({
      linkId: s.linkSpring,
      shareUrl: `https://portal.example.com/r/${A.slug}/ana-spring`,
      partnerId: s.ana,
      partnerName: 'Ana',
      programId: s.spring,
      programName: 'Spring',
      clicks: 2,
      attributedEvents: 2,
      signups: 1,
      paidConversions: 1,
      revenue: [{ currency: 'USD', gross: 100, refunded: 0, net: 100 }],
      commission: [{ currency: 'USD', accrued: 10, approved: 0, paid: 0, reversed: 0 }],
    });
    expect(byLink.get('ana-summer')).toMatchObject({
      clicks: 1,
      paidConversions: 1,
      revenue: [{ currency: 'USD', gross: 50, refunded: 20, net: 30 }],
      commission: [{ currency: 'USD', accrued: 0, approved: 0, paid: 5, reversed: 0 }],
    });
    expect(byLink.get(`none:${s.ana}`)).toMatchObject({
      linkId: null,
      shareUrl: null,
      clicks: 1,
      revenue: [{ currency: 'USD', gross: 30, refunded: 0, net: 30 }],
      commission: [{ currency: 'USD', accrued: 3, approved: 0, paid: 0, reversed: 0 }],
    });
    expect(byLink.get('cy-fall')).toMatchObject({
      clicks: 2,
      revenue: [{ currency: 'EUR', gross: 80, refunded: 0, net: 80 }],
      commission: [{ currency: 'EUR', accrued: 0, approved: 8, paid: 0, reversed: 0 }],
    });
    // Ranked by net revenue in USD: spring 100, then summer and coupon at 30.
    expect(out.rows[0]!.linkKey).toBe('ana-spring');
    expect(out.rows.at(-1)!.linkKey).toBe('cy-fall');
  });

  it('get_performance with a window reaching back 45 days', async () => {
    const out = await call<{ rows: Row[] }>(client, 'get_performance', {
      groupBy: 'link',
      linkId: s.linkSpring,
      since: ago(45).toISOString(),
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      clicks: 3,
      paidConversions: 2,
      revenue: [{ currency: 'USD', gross: 600, refunded: 0, net: 600 }],
      commission: [{ currency: 'USD', accrued: 10, approved: 0, paid: 50, reversed: 0 }],
    });
  });

  it('get_performance by utm_campaign', async () => {
    const out = await call<{ rows: Row[] }>(client, 'get_performance', { groupBy: 'utm_campaign', sort: 'clicks' });
    const byCampaign = new Map(out.rows.map((r) => [r.utmCampaign, r]));
    expect(byCampaign.get('spring_sale')).toMatchObject({
      clicks: 1,
      signups: 1,
      paidConversions: 1,
      revenue: [{ currency: 'USD', gross: 100, refunded: 0, net: 100 }],
    });
    expect(byCampaign.get('fall')).toMatchObject({ clicks: 2, revenue: [{ currency: 'EUR', gross: 80, refunded: 0, net: 80 }] });
    expect(byCampaign.get(null)).toMatchObject({ clicks: 3, revenue: [{ currency: 'USD', gross: 80, refunded: 20, net: 60 }] });
  });

  it('get_performance by partner: own commission, bonuses included', async () => {
    const out = await call<{ rows: Row[] }>(client, 'get_performance', { groupBy: 'partner' });
    expect(out.rows.map((r) => r.partnerName)).toEqual(['Ana', 'Cy']);
    expect(out.rows[0]).toMatchObject({
      clicks: 4,
      attributedEvents: 4,
      signups: 1,
      paidConversions: 3,
      revenue: [{ currency: 'USD', gross: 180, refunded: 20, net: 160 }],
      commission: [{ currency: 'USD', accrued: 20, approved: 0, paid: 5, reversed: 0 }],
    });
  });

  it('get_performance by program matches GET /programs/stats', async () => {
    const since = ago(30);
    const until = new Date();
    const out = await call<{ rows: Row[] }>(client, 'get_performance', {
      groupBy: 'program',
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const stats = await request(app)
      .get(`/t/${A.slug}/programs/stats`)
      .query({ since: since.toISOString(), until: until.toISOString() })
      .set('Authorization', `Bearer ${s.keyA}`);
    expect(stats.status).toBe(200);
    for (const p of stats.body.programs as Array<{
      programId: string;
      clicks: number;
      attributedEvents: number;
      attributedRevenueByCurrency: Record<string, number>;
      commissionByCurrency: Record<string, Record<string, number>>;
    }>) {
      const row = out.rows.find((r) => r.programId === p.programId)!;
      expect(row.clicks).toBe(p.clicks);
      expect(row.attributedEvents).toBe(p.attributedEvents);
      expect(Object.fromEntries(row.revenue.map((a) => [a.currency, a.gross]))).toEqual(p.attributedRevenueByCurrency);
      expect(
        Object.fromEntries(
          row.commission.map(({ currency, ...amounts }) => [currency, Object.fromEntries(Object.entries(amounts).filter(([, v]) => v !== 0))]),
        ),
      ).toEqual(p.commissionByCurrency);
    }
    expect(out.rows.find((r) => r.programId === s.spring)).toMatchObject({
      programName: 'Spring',
      commission: [{ currency: 'USD', accrued: 20, approved: 0, paid: 5, reversed: 0 }],
    });
  });

  it("get_performance refuses another brand's ids and bad windows", async () => {
    for (const [args, error] of [
      [{ groupBy: 'link', programId: s.programB }, 'program_not_found'],
      [{ groupBy: 'link', partnerId: s.partnerB }, 'partner_not_found'],
      [{ groupBy: 'link', linkId: s.linkB }, 'link_not_found'],
      [{ groupBy: 'link', since: ago(1).toISOString(), until: ago(2).toISOString() }, 'invalid_window'],
      [{ groupBy: 'link', since: ago(400).toISOString() }, 'window_too_long'],
    ] as const) {
      const res = await client.callTool({ name: 'get_performance', arguments: args });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(error);
    }
  });

  it('recent_conversions for a link, with the click to join on', async () => {
    const out = await call<{ conversions: Array<Record<string, unknown>>; nextOffset: number | null }>(client, 'recent_conversions', {
      linkId: s.linkSpring,
    });
    expect(out.conversions.map((c) => [c.type, c.value])).toEqual(
      expect.arrayContaining([
        ['signup', null],
        ['invoice_paid', 100],
        ['invoice_paid', 500],
      ]),
    );
    expect(out.conversions).toHaveLength(3);
    expect(out.conversions.at(-1)).toMatchObject({ value: 500 });
    const sale = out.conversions.find((c) => c.value === 100)!;
    expect(sale).toMatchObject({
      partnerId: s.ana,
      programId: s.spring,
      currency: 'USD',
      attribution: { model: 'last_click', weight: 1 },
      click: { clickId: s.springClick, linkId: s.linkSpring, linkKey: 'ana-spring', utmCampaign: 'spring_sale', utmSource: 'meta' },
    });
    expect(sale.referralId).toMatch(/^ref_/);
    expect(out.nextOffset).toBeNull();
  });

  it('recent_conversions for a partner, paged and filtered', async () => {
    const page = await call<{ conversions: Array<{ type: string }>; nextOffset: number | null }>(client, 'recent_conversions', {
      partnerId: s.ana,
      type: 'invoice_paid',
      limit: 2,
    });
    expect([page.conversions.length, page.nextOffset]).toEqual([2, 2]);
    const rest = await call<{ conversions: Array<{ type: string }>; nextOffset: number | null }>(client, 'recent_conversions', {
      partnerId: s.ana,
      type: 'invoice_paid',
      limit: 2,
      offset: 2,
    });
    expect([rest.conversions.length, rest.nextOffset]).toEqual([2, null]);

    const none = await client.callTool({ name: 'recent_conversions', arguments: {} });
    expect(none.isError).toBe(true);
    const other = await client.callTool({ name: 'recent_conversions', arguments: { partnerId: s.partnerB } });
    expect(JSON.stringify(other.content)).toContain('partner_not_found');
  });
});
