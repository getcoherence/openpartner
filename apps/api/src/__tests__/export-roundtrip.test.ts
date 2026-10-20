/**
 * Export portability round-trip (audit #8).
 *
 * The promise in CLAUDE.md/README: everything in the bundle exports to
 * CSV + JSON + SQL, and the self-hosted build re-imports what the hosted
 * one produced. These tests seed one row in every exportable table, wipe
 * the database, restore, and compare — once through the JSON path and
 * once through the SQL dump actually executed against Postgres.
 *
 * Tables NOT in the bundle are listed in docs/data-portability.md; this
 * suite deliberately does not assert anything about them.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { generateApiKey, hashKey } from '../auth.js';
import { verifyPostbackToken } from '../conversion-postback.js';
import { createSession } from '../auth-sessions.js';
import {
  EXPORT_TABLES,
  SCHEMA_VERSION,
  buildSqlDump,
  exportAll,
  exportColumnTypes,
  exportTable,
  importBundle,
  isSafeTenantId,
  legacyPartnerCommissionId,
  PORTABLE_CONFIG_KEYS,
  primaryKeyOf,
  upgradeBundle,
} from '../export.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

/** The source instance's credentials. None of them may appear in a
 *  bundle, and none of them may work after a restore. */
const SOURCE_WEBHOOK_SECRET = 'whsec_source_secret_never_exported_0001';
const SOURCE_POSTBACK_TOKEN = `opcp_${'ab'.repeat(24)}`;

interface Seeded {
  webhookEndpointId: string;
  postbackTokenId: string;
  partnerId: string;
  programId: string;
  linkId: string;
  clickId: string;
  eventId: string;
  attributionId: string;
  commissionId: string;
  bonusId: string;
  bonusCommissionId: string;
  bountyId: string;
  payoutId: string;
  couponId: string;
}

/** Rows seedEverything writes per table, where it isn't one: a bonus has
 *  its own commission next to the attributed sale's. */
const SEEDED_ROWS: Partial<Record<string, number>> = { [TABLES.Commission]: 2 };
const seededRows = (table: string) => SEEDED_ROWS[table] ?? 1;

/** One row in every exportable table, with the FK chain intact. */
async function seedEverything(): Promise<Seeded> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const identityId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  const commissionId = ulid();
  const payoutId = ulid();
  const couponId = ulid();
  const bonusId = ulid();
  const bonusCommissionId = ulid();
  const bountyId = ulid();

  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: `p${partnerId}@x.test`,
    name: "O'Hara & Co", // apostrophe + ampersand: exercises SQL escaping
    metadata: { source: 'seed', note: 'has "double" quotes' },
    // Not the column default, so a restore that dropped it would show.
    portalAccess: false,
  });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'Program',
    // jsonb holding an ARRAY, and a real text[] alongside it — the pair
    // that used to break the round-trip (a JS array is ambiguous unless
    // the exporter reads the column type).
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    categories: ['saas', 'devtools'],
    destinationUrl: 'https://x.test/landing',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
    // Not the column default, so a restore that dropped it would show.
    renewalsStayWithPartner: false,
  });
  await db(TABLES.PartnerProgram).insert({
    id: ulid(),
    tenantId: TENANT,
    partnerId,
    programId,
    source: 'admin',
  });
  await db(TABLES.PartnerCommission).insert({
    partnerId,
    tenantId: TENANT,
    commissionType: 'percent',
    commissionValue: '20.0000',
    recurring: true,
    holdbackDays: 30,
    source: 'approval',
  });
  // A partner who opted in to the Network on the join page, then withdrew.
  await db(TABLES.PartnerNetworkConsent).insert({
    partnerId,
    tenantId: TENANT,
    status: 'withdrawn',
    source: 'join_page',
    consentedAt: new Date('2026-10-01T09:00:00.000Z'),
    withdrawnAt: new Date('2026-10-12T17:30:00.000Z'),
  });
  await db(TABLES.Coupon).insert({
    id: couponId,
    tenantId: TENANT,
    partnerId,
    programId,
    code: 'CREATOR15',
  });
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: TENANT,
    linkKey: `k${linkId.slice(0, 8)}`,
    partnerId,
    programId,
    destinationUrl: 'https://x.test/landing',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://x.test/landing',
    // The publisher's ?sub_id= (schemaVersion 8).
    subId: 'wct_9f2a-17',
    ts: new Date(),
  });
  await db(TABLES.Identity).insert({
    id: identityId,
    tenantId: TENANT,
    clickId,
    userId: `u-${clickId}`,
  });
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: '200.00',
    currency: 'USD',
    ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: TENANT,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId: TENANT,
    partnerId,
    attributionId,
    amount: '40.00',
    currency: 'USD',
    status: 'approved',
  });
  // A performance bounty (schemaVersion 7): every column off its default.
  await db(TABLES.Bounty).insert({
    id: bountyId,
    tenantId: TENANT,
    programId,
    name: 'Q4 push',
    description: "Hit 10 sales by year's end — we'll send $500",
    metric: 'revenue',
    eventType: 'invoice_paid',
    threshold: '2500.5000',
    scope: 'lifetime',
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-31T00:00:00.000Z'),
    rewardAmount: '500.00',
    currency: 'EUR',
    partnerIds: JSON.stringify([partnerId]),
    status: 'active',
    startNotifiedAt: new Date('2026-11-01T01:00:00.000Z'),
  });
  // A bonus (schemaVersion 6) and its commission: no attribution behind it.
  await db(TABLES.Bonus).insert({
    id: bonusId,
    tenantId: TENANT,
    partnerId,
    programId,
    amount: '25.00',
    currency: 'USD',
    source: 'network',
    externalRef: 'sub_0001',
    note: "Thanks for the launch-week video — it's great",
    createdBy: 'key_network',
  });
  await db(TABLES.Commission).insert({
    id: bonusCommissionId,
    tenantId: TENANT,
    partnerId,
    attributionId: null,
    bonusId,
    amount: '25.00',
    currency: 'USD',
    status: 'approved',
    metadata: { rateType: 'fixed' },
  });
  await db(TABLES.Payout).insert({
    id: payoutId,
    tenantId: TENANT,
    partnerId,
    amount: '40.00',
    currency: 'USD',
    method: 'manual',
    status: 'pending',
    metadata: { runId: 'seed', platformFee: 0 },
  });
  await db(TABLES.PortalCustomDomain).insert({
    id: ulid(),
    tenantId: TENANT,
    domain: `partners-${partnerId.slice(0, 8).toLowerCase()}.example.test`,
    verificationToken: 'tok',
    status: 'pending',
    edgeKind: 'do_native',
  });
  await db(TABLES.CommissionAdjustment).insert({
    id: ulid(),
    tenantId: TENANT,
    commissionId,
    amount: '-5.00',
    currency: 'USD',
    reason: 'admin_correction',
    metadata: {},
  });
  await db(TABLES.BrandAsset).insert({
    id: ulid(),
    tenantId: TENANT,
    kind: 'image',
    label: 'Logo, dark',
    description: "Use on light backgrounds — don't recolour",
    url: 'https://cdn.x.test/tenants/t/brand-assets/0123abcd.png',
    sortOrder: 0,
  });
  const webhookEndpointId = ulid();
  await db(TABLES.WebhookEndpoint).insert({
    id: webhookEndpointId,
    tenantId: TENANT,
    url: 'https://hooks.x.test/openpartner',
    secretPrefix: SOURCE_WEBHOOK_SECRET.slice(0, 12),
    secret: SOURCE_WEBHOOK_SECRET,
    events: JSON.stringify(['commission.paid', 'partner.created']),
    label: 'CRM sync',
    active: true,
  });
  await db(TABLES.PartnerPostback).insert({
    id: ulid(),
    tenantId: TENANT,
    partnerId,
    url: 'https://tracker.x.test/pb?cid={click_id}&amt={commission_amount}',
    events: JSON.stringify(['commission.accrued']),
    enabled: true,
  });
  const postbackTokenId = ulid();
  await db(TABLES.ConversionPostbackToken).insert({
    id: postbackTokenId,
    tenantId: TENANT,
    prefix: SOURCE_POSTBACK_TOKEN.slice(0, 13),
    tokenHash: hashKey(SOURCE_POSTBACK_TOKEN),
    ipAllowlist: JSON.stringify(['203.0.113.0/24']),
  });
  await db(TABLES.Config).insert({
    tenantId: TENANT,
    key: 'program_settings',
    value: { programName: "O'Hara Partners", supportEmail: 'partners@x.test', routerUrl: null, partnerNetworkVisible: true },
    updatedAt: new Date(),
  });

  return {
    webhookEndpointId,
    postbackTokenId,
    partnerId,
    programId,
    linkId,
    clickId,
    eventId,
    attributionId,
    commissionId,
    bonusId,
    bonusCommissionId,
    bountyId,
    payoutId,
    couponId,
  };
}

/** A schemaVersion 7 bundle: its Click rows have no `subId`. */
function beforeSubIds(full: Record<string, unknown[]>): Record<string, unknown[]> {
  return {
    ...full,
    [TABLES.Click]: (full[TABLES.Click] as Record<string, unknown>[]).map(({ subId: _dropped, ...row }) => row),
  };
}

/** A schemaVersion 6 bundle: no bounties. */
function beforeBounties(full: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = beforeSubIds(full);
  delete out[TABLES.Bounty];
  return out;
}

/** What a bundle written before schemaVersion 6 looks like: no Bonus table,
 *  no bonus commissions, and no `bonusId` on Commission rows. */
function beforeBonuses(full: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = beforeBounties(full);
  delete out[TABLES.Bonus];
  out[TABLES.Commission] = (full[TABLES.Commission] as Record<string, unknown>[])
    .filter((c) => c.bonusId === null)
    .map(({ bonusId: _dropped, ...row }) => row);
  return out;
}

/** Reverse of IMPORT_ORDER so foreign keys never block the delete. */
async function wipe(): Promise<void> {
  for (const { table } of [...EXPORT_TABLES].reverse()) {
    await db(table).del();
  }
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table } of EXPORT_TABLES) {
    const [row] = (await db(table).count({ n: '*' })) as Array<{ n: string }>;
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}

/**
 * Run a multi-statement script the way psql would — straight to the pg
 * connection, so knex never tries to parse `?` as a binding.
 */
async function runSql(sql: string): Promise<void> {
  const conn = (await db.client.acquireConnection()) as { query: (q: string) => Promise<unknown> };
  try {
    await conn.query(sql);
  } finally {
    await db.client.releaseConnection(conn);
  }
}

/** What psql does with `-v tenant_id=<id>`: substitute, then drop its own
 *  meta-commands (which never reach the server). */
function asPsqlWould(dump: string, tenantId: string): string {
  return dump
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n')
    .replace(/:'tenant_id'/g, `'${tenantId}'`);
}

/** What psql does with NO `-v` at all: the file's own `\set` fallback
 *  supplies the value. Exercises the default restore path, which is the
 *  one the docs tell operators to use. */
function asPsqlWouldWithoutVar(dump: string): string {
  const fallback = /^\\set tenant_id '([^']*)'$/m.exec(dump);
  if (!fallback) throw new Error('dump has no \\set tenant_id fallback');
  return asPsqlWould(dump, fallback[1]!);
}

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
});

afterAll(async () => {
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('export coverage', () => {
  it('covers every table the attribution → payout chain needs', async () => {
    const names = EXPORT_TABLES.map((s) => s.table);
    // The three the audit found missing: grants, coupon attribution, and
    // the snapshotted commission terms.
    expect(names).toContain(TABLES.PartnerProgram);
    expect(names).toContain(TABLES.Coupon);
    expect(names).toContain(TABLES.PartnerCommission);
    // Who agreed to have their details shared with the Network.
    expect(names).toContain(TABLES.PartnerNetworkConsent);
  });

  it('knows each table real primary key — not just `id`', () => {
    // PartnerCommission was keyed on partnerId until schemaVersion 3; its
    // natural key now lives in partial unique indexes.
    expect(primaryKeyOf(TABLES.PartnerCommission)).toBe('id');
    expect(EXPORT_TABLES.find((s) => s.table === TABLES.PartnerCommission)).toMatchObject({ conflict: 'any' });
    expect(primaryKeyOf(TABLES.PartnerNetworkConsent)).toBe('partnerId');
    expect(primaryKeyOf(TABLES.Commission)).toBe('id');
  });

  it('orders tables so foreign keys resolve top to bottom', () => {
    const at = (t: string) => EXPORT_TABLES.findIndex((s) => s.table === t);
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.PartnerProgram));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.PartnerProgram));
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.PartnerCommission));
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.PartnerNetworkConsent));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.Coupon));
    expect(at(TABLES.Link)).toBeLessThan(at(TABLES.Click));
    expect(at(TABLES.Click)).toBeLessThan(at(TABLES.Identity));
    expect(at(TABLES.Event)).toBeLessThan(at(TABLES.Attribution));
    expect(at(TABLES.Attribution)).toBeLessThan(at(TABLES.Commission));
    expect(at(TABLES.Partner)).toBeLessThan(at(TABLES.Bonus));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.Bonus));
    expect(at(TABLES.Program)).toBeLessThan(at(TABLES.Bounty));
    expect(at(TABLES.Bounty)).toBeLessThan(at(TABLES.Bonus));
    expect(at(TABLES.Bonus)).toBeLessThan(at(TABLES.Commission));
    expect(at(TABLES.Commission)).toBeLessThan(at(TABLES.CommissionAdjustment));
  });
});

describe.skipIf(skipIntegration)('JSON round-trip', () => {
  it('export → wipe → import restores every table', async () => {
    const seeded = await seedEverything();
    const bundle = await exportAll(db, TENANT);
    const before = await counts();
    for (const { table } of EXPORT_TABLES) {
      expect(before[table], `${table} should have been seeded`).toBe(seededRows(table));
    }

    await wipe();
    const report = await importBundle(db, TENANT, bundle);

    expect(await counts()).toEqual(before);
    for (const { table } of EXPORT_TABLES) {
      expect(report.inserted[table], `${table} should have been imported`).toBe(seededRows(table));
    }

    // Spot-check the three that used not to round-trip.
    const grant = await db(TABLES.PartnerProgram).first();
    expect(grant.partnerId).toBe(seeded.partnerId);
    expect(grant.programId).toBe(seeded.programId);
    const terms = await db(TABLES.PartnerCommission).where({ partnerId: seeded.partnerId }).first();
    expect(terms.commissionType).toBe('percent');
    expect(Number(terms.commissionValue)).toBe(20);
    expect(terms.recurring).toBe(true);
    expect(terms.holdbackDays).toBe(30);
    const coupon = await db(TABLES.Coupon).where({ id: seeded.couponId }).first();
    expect(coupon.code).toBe('CREATOR15');
    // The publisher's sub-ID stays on its click (schemaVersion 8).
    expect((await db(TABLES.Click).where({ id: seeded.clickId }).first()).subId).toBe('wct_9f2a-17');
    // The Network consent record keeps how and when, not just the status.
    const consent = await db(TABLES.PartnerNetworkConsent).where({ partnerId: seeded.partnerId }).first();
    expect(consent.status).toBe('withdrawn');
    expect(consent.source).toBe('join_page');
    expect(new Date(consent.consentedAt).toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(new Date(consent.withdrawnAt).toISOString()).toBe('2026-10-12T17:30:00.000Z');
    // jsonb array + text[] both survive with their own shapes.
    const program = await db(TABLES.Program).where({ id: seeded.programId }).first();
    expect(program.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 20 }]);
    expect(program.categories).toEqual(['saas', 'devtools']);
    expect(program.renewalsStayWithPartner).toBe(false);
    // …and that the money ledger survived with its shape intact.
    const commission = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(commission.amount).toBe('40.00');
    expect(commission.status).toBe('approved');
    expect(commission.bonusId).toBeNull();
    // A bonus and its commission (schemaVersion 6), still linked.
    const bonus = await db(TABLES.Bonus).where({ id: seeded.bonusId }).first();
    expect(bonus).toMatchObject({ source: 'network', externalRef: 'sub_0001', amount: '25.00', programId: seeded.programId });
    expect(bonus.note).toBe("Thanks for the launch-week video — it's great");
    const bonusCommission = await db(TABLES.Commission).where({ id: seeded.bonusCommissionId }).first();
    expect(bonusCommission).toMatchObject({ bonusId: seeded.bonusId, attributionId: null, amount: '25.00' });
    // A bounty keeps its goal, window, allowlist and stamps (schemaVersion 7).
    const bounty = await db(TABLES.Bounty).where({ id: seeded.bountyId }).first();
    expect(bounty).toMatchObject({
      metric: 'revenue',
      eventType: 'invoice_paid',
      threshold: '2500.5000',
      scope: 'lifetime',
      rewardAmount: '500.00',
      currency: 'EUR',
      partnerIds: [seeded.partnerId],
      status: 'active',
    });
    expect(bounty.description).toBe("Hit 10 sales by year's end — we'll send $500");
    expect(new Date(bounty.endsAt).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(new Date(bounty.startNotifiedAt).toISOString()).toBe('2026-11-01T01:00:00.000Z');
    // A headless partner stays locked out of the portal on the new instance.
    const partner = await db(TABLES.Partner).where({ id: seeded.partnerId }).first();
    expect(partner.portalAccess).toBe(false);
    // Settings, the asset library and integrations (schemaVersion 5).
    const settings = await db(TABLES.Config).where({ key: 'program_settings' }).first();
    expect(settings.value).toMatchObject({ programName: "O'Hara Partners", supportEmail: 'partners@x.test' });
    const asset = await db(TABLES.BrandAsset).first();
    expect(asset.url).toBe('https://cdn.x.test/tenants/t/brand-assets/0123abcd.png');
    const postback = await db(TABLES.PartnerPostback).first();
    expect(postback.url).toBe('https://tracker.x.test/pb?cid={click_id}&amt={commission_amount}');
    expect(postback.events).toEqual(['commission.accrued']);
  }, 30_000);

  it('credentials never leave: the bundle has none, and the restore gets fresh ones', async () => {
    const seeded = await seedEverything();
    const bundle = await exportAll(db, TENANT);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(SOURCE_WEBHOOK_SECRET);
    expect(text).not.toContain(SOURCE_WEBHOOK_SECRET.slice(0, 12));
    expect(text).not.toContain(hashKey(SOURCE_POSTBACK_TOKEN));
    expect(bundle[TABLES.WebhookEndpoint]![0]).not.toHaveProperty('secret');
    expect(bundle[TABLES.ConversionPostbackToken]![0]).not.toHaveProperty('tokenHash');

    await wipe();
    const report = await importBundle(db, TENANT, bundle);

    // The endpoint is back with a new secret, paused until its receiver
    // has that secret — which the report shows, once.
    const endpoint = await db(TABLES.WebhookEndpoint).where({ id: seeded.webhookEndpointId }).first();
    expect(endpoint).toMatchObject({ url: 'https://hooks.x.test/openpartner', label: 'CRM sync', active: false });
    expect(endpoint.events).toEqual(['commission.paid', 'partner.created']);
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(endpoint.secret).not.toBe(SOURCE_WEBHOOK_SECRET);
    expect(endpoint.secretPrefix).toBe(endpoint.secret.slice(0, 12));
    expect(report.credentials[TABLES.WebhookEndpoint]).toEqual([
      { id: seeded.webhookEndpointId, url: 'https://hooks.x.test/openpartner', secret: endpoint.secret },
    ]);

    // The postback token keeps its allowlist and history, but no URL works
    // until it is rotated — not even the source's own.
    const token = await db(TABLES.ConversionPostbackToken).where({ id: seeded.postbackTokenId }).first();
    expect(token.ipAllowlist).toEqual(['203.0.113.0/24']);
    expect(token.revokedAt).toBeNull();
    expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPostbackToken(db, TENANT, SOURCE_POSTBACK_TOKEN)).toBeNull();
    expect(report.credentials[TABLES.ConversionPostbackToken]).toBeUndefined();

    // Re-importing shows nothing: no row landed, so no new credential.
    const again = await importBundle(db, TENANT, bundle);
    expect(again.credentials).toEqual({});
  }, 30_000);

  it('per-table downloads and the SQL dump leave credentials out too', async () => {
    await seedEverything();
    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    for (const path of [
      `/export/${TABLES.WebhookEndpoint}.json`,
      `/export/${TABLES.WebhookEndpoint}.csv`,
      `/export/${TABLES.ConversionPostbackToken}.csv`,
      '/export.json',
      '/export.sql',
    ]) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status, path).toBe(200);
      expect(res.text, path).not.toContain(SOURCE_WEBHOOK_SECRET.slice(0, 12));
      expect(res.text, path).not.toContain(hashKey(SOURCE_POSTBACK_TOKEN));
    }
    const csv = await request(app).get(`/export/${TABLES.WebhookEndpoint}.csv`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(csv.text.split('\n')[0]).not.toMatch(/secret/i);
  }, 30_000);

  it('Config: only program settings travel — never credentials or hosted bookkeeping', async () => {
    await seedEverything();
    const others = {
      network_membership: { enabled: true, networkUrl: 'https://n.test', vendorTokenCiphertext: 'ct:vendor-token', scopedKeyId: null, autoEnroll: true },
      mail_settings: { kind: 'smtp', from: 'a@x.test', smtp: { host: 'smtp.x.test', port: 587, secure: false, user: 'u', passwordCiphertext: 'ct:smtp-password' } },
      'stripe.merchant.lastUsageReportedAt': '2026-10-01T00:00:00.000Z',
    };
    for (const [key, value] of Object.entries(others)) {
      await db(TABLES.Config).insert({ tenantId: TENANT, key, value: JSON.stringify(value), updatedAt: new Date() });
    }
    await db(TABLES.Config).insert({
      tenantId: TENANT,
      key: 'partner_signup',
      value: { policy: 'require_review', disabled: false },
      updatedAt: new Date(),
    });
    // A headless program's portal-access default travels with it.
    await db(TABLES.Config).insert({
      tenantId: TENANT,
      key: 'partner_access',
      value: { uninvitedPortalAccess: false },
      updatedAt: new Date(),
    });

    const bundle = await exportAll(db, TENANT);
    const keys = (bundle[TABLES.Config] as Array<{ key: string }>).map((r) => r.key).sort();
    expect(keys).toEqual([...PORTABLE_CONFIG_KEYS].sort());
    expect(JSON.stringify(bundle)).not.toContain('ct:');

    // A hand-made bundle that smuggles one in doesn't get it imported.
    await wipe();
    const smuggled = {
      ...bundle,
      [TABLES.Config]: [...bundle[TABLES.Config]!, { tenantId: 'x', key: 'network_membership', value: others.network_membership }],
    };
    const report = await importBundle(db, TENANT, smuggled);
    expect(report.inserted[TABLES.Config]).toBe(3);
    expect((await db(TABLES.Config).where({ key: 'partner_access' }).first()).value).toEqual({ uninvitedPortalAccess: false });
    expect(report.skipped[TABLES.Config]).toBe(1);
    expect(await db(TABLES.Config).where({ key: 'network_membership' })).toHaveLength(0);
    expect((await db(TABLES.Config).where({ key: 'partner_signup' }).first()).value).toEqual({
      policy: 'require_review',
      disabled: false,
    });
  }, 30_000);

  it('a setting or live postback token the destination already has is kept, not overwritten', async () => {
    await seedEverything();
    const bundle = await exportAll(db, TENANT);
    await wipe();
    await db(TABLES.Config).insert({
      tenantId: TENANT,
      key: 'program_settings',
      value: { programName: 'Destination', supportEmail: null, routerUrl: null, partnerNetworkVisible: true },
      updatedAt: new Date(),
    });
    const destinationToken = ulid();
    await db(TABLES.ConversionPostbackToken).insert({
      id: destinationToken,
      tenantId: TENANT,
      prefix: 'opcp_11111111',
      tokenHash: hashKey('opcp_destination'),
      ipAllowlist: JSON.stringify([]),
    });

    const report = await importBundle(db, TENANT, bundle);
    expect(report.skipped[TABLES.Config]).toBe(1);
    expect(report.skipped[TABLES.ConversionPostbackToken]).toBe(1);
    expect((await db(TABLES.Config).where({ key: 'program_settings' }).first()).value.programName).toBe('Destination');
    const live = await db(TABLES.ConversionPostbackToken).whereNull('revokedAt');
    expect(live.map((t: { id: string }) => t.id)).toEqual([destinationToken]);
  }, 30_000);

  it('is idempotent — importing the same bundle twice inserts nothing new', async () => {
    await seedEverything();
    const bundle = await exportAll(db, TENANT);
    await wipe();

    await importBundle(db, TENANT, bundle);
    const second = await importBundle(db, TENANT, bundle);

    // PartnerCommission used to be keyed on partnerId: with the old
    // hardcoded `id` conflict target this threw instead of skipping.
    for (const { table } of EXPORT_TABLES) {
      expect(second.inserted[table] ?? 0, `${table} should not re-insert`).toBe(0);
      expect(second.skipped[table] ?? 0, `${table} should be skipped`).toBe(seededRows(table));
    }
    expect((await counts())[TABLES.PartnerCommission]).toBe(1);
  }, 30_000);

  it('accepts a v1 bundle — older exports keep working', async () => {
    await seedEverything();
    const full = beforeBonuses(await exportAll(db, TENANT));
    const v1: Record<string, unknown[]> = { ...full };
    // v1 didn't know about these three.
    delete v1[TABLES.PartnerProgram];
    delete v1[TABLES.PartnerCommission];
    delete v1[TABLES.Coupon];
    await wipe();

    const report = await importBundle(db, TENANT, v1);
    expect(report.inserted[TABLES.Partner]).toBe(1);
    expect(report.inserted[TABLES.PartnerProgram]).toBeUndefined();
    expect((await counts())[TABLES.Commission]).toBe(1);

    // Round 6: the above calls importBundle directly and never supplies a
    // schemaVersion, so it would stay green if v1 were dropped from the
    // HTTP contract — which is where the version gate actually lives. Go
    // through the route as a real client would.
    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    await wipe();
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 1, tables: v1 });
    expect(viaRoute.status).toBe(200);
    expect((await counts())[TABLES.Commission]).toBe(1);

    // And an unsupported version is still refused, so this is a gate rather
    // than an unconditional accept.
    const bogus = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 99, tables: v1 });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe('unsupported_schema_version');
  }, 30_000);

  it('accepts a v2 bundle — one exported before Network consent existed', async () => {
    await seedEverything();
    const full = beforeBonuses(await exportAll(db, TENANT));
    const v2: Record<string, unknown[]> = { ...full };
    delete v2[TABLES.PartnerNetworkConsent];
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 2, tables: v2 });
    expect(viaRoute.status).toBe(200);
    const after = await counts();
    expect(after[TABLES.Partner]).toBe(1);
    // No consent rows: every restored partner starts undecided, so nobody
    // is pushed to the Network until they opt in on the new instance.
    expect(after[TABLES.PartnerNetworkConsent]).toBe(0);
  }, 30_000);

  it('accepts a v3 bundle — program-scoped commission terms, but no Network consent yet', async () => {
    await seedEverything();
    const full = beforeBonuses(await exportAll(db, TENANT));
    const v3: Record<string, unknown[]> = { ...full };
    delete v3[TABLES.PartnerNetworkConsent];
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 3, tables: v3 });
    expect(viaRoute.status).toBe(200);
    const after = await counts();
    expect(after[TABLES.Partner]).toBe(1);
    expect(after[TABLES.PartnerCommission]).toBe((full[TABLES.PartnerCommission] ?? []).length);
    expect(after[TABLES.PartnerNetworkConsent]).toBe(0);
  }, 30_000);

  it('accepts a v4 bundle — no settings, assets or integrations; programs and partners take the new defaults', async () => {
    const seeded = await seedEverything();
    const full = beforeBonuses(await exportAll(db, TENANT));
    // A v4 bundle: no v5 tables, and no v5 columns on Program and Partner.
    const v4: Record<string, unknown[]> = {
      ...full,
      [TABLES.Program]: (full[TABLES.Program] ?? []).map((r) => {
        const { renewalsStayWithPartner: _dropped, ...row } = r as Record<string, unknown>;
        return row;
      }),
      [TABLES.Partner]: (full[TABLES.Partner] as Record<string, unknown>[]).map(({ portalAccess: _dropped, ...row }) => row),
    };
    for (const t of [TABLES.BrandAsset, TABLES.WebhookEndpoint, TABLES.PartnerPostback, TABLES.ConversionPostbackToken, TABLES.Config]) {
      delete v4[t];
    }
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 4, tables: v4 });
    expect(viaRoute.status).toBe(200);
    // The same value the migration gave every program that existed before it.
    const program = await db(TABLES.Program).where({ id: seeded.programId }).first();
    expect(program.renewalsStayWithPartner).toBe(true);
    // Every partner could use the portal before the column existed.
    const partner = await db(TABLES.Partner).where({ id: seeded.partnerId }).first();
    expect(partner.portalAccess).toBe(true);
    expect(viaRoute.body.report.credentials).toEqual({});
    const after = await counts();
    expect(after[TABLES.PartnerNetworkConsent]).toBe(1);
    expect(after[TABLES.WebhookEndpoint]).toBe(0);
    expect(after[TABLES.Config]).toBe(0);
  }, 30_000);

  it('the import route hands back the restored webhook secrets', async () => {
    await seedEverything();
    const full = await exportAll(db, TENANT);
    await wipe();
    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const res = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: SCHEMA_VERSION, tables: full });
    expect(res.status).toBe(200);
    const shown = res.body.report.credentials[TABLES.WebhookEndpoint] as Array<{ secret: string }>;
    expect(shown).toHaveLength(1);
    expect((await db(TABLES.WebhookEndpoint).first()).secret).toBe(shown[0]!.secret);
  }, 30_000);

  it('accepts a v5 bundle — no bonuses; its commissions are all attributed sales', async () => {
    const seeded = await seedEverything();
    const v5 = beforeBonuses(await exportAll(db, TENANT));
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 5, tables: v5 });
    expect(viaRoute.status).toBe(200);
    const after = await counts();
    expect(after[TABLES.Bonus]).toBe(0);
    expect(after[TABLES.Commission]).toBe(1);
    const commission = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(commission).toMatchObject({ attributionId: seeded.attributionId, bonusId: null });
  }, 30_000);

  it('accepts a v6 bundle — bonuses but no bounties', async () => {
    const seeded = await seedEverything();
    const v6 = beforeBounties(await exportAll(db, TENANT));
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 6, tables: v6 });
    expect(viaRoute.status).toBe(200);
    const after = await counts();
    expect(after[TABLES.Bounty]).toBe(0);
    expect(after[TABLES.Bonus]).toBe(1);
    expect((await db(TABLES.Bonus).where({ id: seeded.bonusId }).first()).bountyId).toBeNull();
  }, 30_000);

  it('accepts a v7 bundle — clicks restore without a sub-ID', async () => {
    const seeded = await seedEverything();
    const v7 = beforeSubIds(await exportAll(db, TENANT));
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const viaRoute = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 7, tables: v7 });
    expect(viaRoute.status).toBe(200);
    const click = await db(TABLES.Click).where({ id: seeded.clickId }).first();
    expect(click).toMatchObject({ linkId: seeded.linkId, subId: null });
    expect((await counts())[TABLES.Bounty]).toBe(1);
  }, 30_000);

  it('exports at schemaVersion 8', () => {
    expect(SCHEMA_VERSION).toBe(8);
  });
});

describe.skipIf(skipIntegration)('PartnerCommission program scope (schemaVersion 3)', () => {
  /** A second program with a program-scoped row on it, next to the
   *  seeded partner-wide row. */
  async function seedProgramScoped(seeded: Seeded): Promise<{ programId: string; id: string }> {
    const programId = ulid();
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: TENANT,
      name: 'Second program',
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
      destinationUrl: 'https://x.test/second',
      attributionWindowDays: 60,
      attributionModel: 'last_click',
    });
    const id = `pcm_${ulid()}`;
    await db(TABLES.PartnerCommission).insert({
      id,
      partnerId: seeded.partnerId,
      tenantId: TENANT,
      programId,
      commissionType: 'fixed',
      commissionValue: '50.0000',
      recurring: false,
      commissionRules: JSON.stringify([{ trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 50 }]),
      holdbackDays: 7,
      source: 'amendment',
    });
    return { programId, id };
  }

  /** Terms rows keyed by scope ('*' = partner-wide). */
  async function termsByScope(): Promise<Record<string, Record<string, unknown>>> {
    const rows = (await db(TABLES.PartnerCommission).select(
      'id',
      'partnerId',
      'programId',
      'commissionRules',
      'holdbackDays',
      'source',
    )) as Array<Record<string, unknown>>;
    return Object.fromEntries(rows.map((r) => [(r.programId as string | null) ?? '*', r]));
  }

  it('JSON: partner-wide and program-scoped rows both restore with their ids and scope', async () => {
    const seeded = await seedEverything();
    const scoped = await seedProgramScoped(seeded);
    const before = await termsByScope();
    expect(Object.keys(before).sort()).toEqual(['*', scoped.programId].sort());

    const bundle = await exportAll(db, TENANT);
    await wipe();
    const report = await importBundle(db, TENANT, bundle);

    expect(report.inserted[TABLES.PartnerCommission]).toBe(2);
    expect(await termsByScope()).toEqual(before);
    expect((await termsByScope())[scoped.programId]!.id).toBe(scoped.id);
  }, 30_000);

  it('JSON: a row whose natural key is taken under another id is skipped, not a failed import', async () => {
    const seeded = await seedEverything();
    await seedProgramScoped(seeded);
    const bundle = await exportAll(db, TENANT);
    // Same (partner, scope) pairs, fresh ids — e.g. the bundle came from an
    // instance that re-created the terms. Nothing is wiped.
    const reKeyed = {
      ...bundle,
      [TABLES.PartnerCommission]: (bundle[TABLES.PartnerCommission] as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        id: `pcm_${ulid()}`,
      })),
    };

    const report = await importBundle(db, TENANT, reKeyed);

    expect(report.inserted[TABLES.PartnerCommission]).toBe(0);
    expect(report.skipped[TABLES.PartnerCommission]).toBe(2);
    expect((await counts())[TABLES.PartnerCommission]).toBe(2);
  }, 30_000);

  it('a v2 bundle imports its PartnerCommission rows as partner-wide, with the migration id', async () => {
    const seeded = await seedEverything();
    const bundle = await exportAll(db, TENANT);
    // What a v2 export carried: no id, no programId.
    const v2 = {
      ...bundle,
      [TABLES.PartnerCommission]: (bundle[TABLES.PartnerCommission] as Array<Record<string, unknown>>).map(
        ({ id: _id, programId: _programId, ...rest }) => rest,
      ),
    };
    expect(upgradeBundle(bundle)).toEqual(bundle); // current rows pass through untouched
    await wipe();

    const app = createApp();
    const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';
    const first = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 2, tables: v2 });
    expect(first.status).toBe(200);
    expect(first.body.report.inserted[TABLES.PartnerCommission]).toBe(1);

    const terms = await termsByScope();
    expect(Object.keys(terms)).toEqual(['*']);
    expect(terms['*']!.id).toBe(legacyPartnerCommissionId(seeded.partnerId));
    expect(terms['*']!.holdbackDays).toBe(30);

    // Idempotent on re-import, same as every other version.
    const again = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 2, tables: v2 });
    expect(again.status).toBe(200);
    expect(again.body.report.skipped[TABLES.PartnerCommission]).toBe(1);
    expect((await counts())[TABLES.PartnerCommission]).toBe(1);
  }, 30_000);

  it('SQL: program-scoped rows restore, and re-running the dump skips them', async () => {
    const seeded = await seedEverything();
    await seedProgramScoped(seeded);
    const before = await termsByScope();
    const dump = buildSqlDump(await exportAll(db, TENANT), { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });

    await wipe();
    await runSql(dump);
    expect(await termsByScope()).toEqual(before);

    await runSql(dump);
    expect((await counts())[TABLES.PartnerCommission]).toBe(2);
  }, 30_000);

  // docs/data-portability.md: a dump written before schemaVersion 3 says
  // ON CONFLICT ("partnerId") for PartnerCommission, which no longer names
  // a unique index. Relaxed to a bare ON CONFLICT DO NOTHING it restores —
  // the id default covers the column the old dump doesn't have.
  it('SQL: a pre-v3 PartnerCommission insert restores once its ON CONFLICT is made bare', async () => {
    const partnerId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId: TENANT, email: `v2-${partnerId}@x.test`, name: 'V2' });
    const v2Insert = (onConflict: string) => `
      INSERT INTO "PartnerCommission" ("partnerId", "tenantId", "commissionType", "commissionValue", "recurring", "holdbackDays", "source", "snapshottedAt") VALUES
        ('${partnerId}', '${TENANT}', 'percent', '25.0000', true, 14, 'approval', '2026-09-01T00:00:00.000Z')
      ${onConflict};`;

    await expect(runSql(v2Insert('ON CONFLICT ("partnerId") DO NOTHING'))).rejects.toThrow(
      /no unique or exclusion constraint/,
    );
    await runSql(v2Insert('ON CONFLICT DO NOTHING'));
    await runSql(v2Insert('ON CONFLICT DO NOTHING')); // still idempotent

    const rows = await db(TABLES.PartnerCommission).where({ partnerId });
    expect(rows).toHaveLength(1);
    expect(rows[0].programId).toBeNull();
    expect(rows[0].id).toMatch(/^pcm_/);
  }, 30_000);
});

describe.skipIf(skipIntegration)('SQL dump', () => {
  it('restores a wiped database when run as plain SQL', async () => {
    await seedEverything();
    const bundle = await exportAll(db, TENANT);
    const before = await counts();
    const dump = buildSqlDump(bundle, { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });

    await wipe();
    await runSql(dump);

    expect(await counts()).toEqual(before);
    const program = await db(TABLES.Program).first();
    expect(program.commissionRule).toEqual([{ trigger: 'every', type: 'percent', value: 20 }]);
    expect(program.categories).toEqual(['saas', 'devtools']);
    expect(program.renewalsStayWithPartner).toBe(false);
    expect((await db(TABLES.Click).first()).subId).toBe('wct_9f2a-17');
  }, 30_000);

  it('generates fresh credentials on restore, and the file carries none', async () => {
    const seeded = await seedEverything();
    const dump = buildSqlDump(await exportAll(db, TENANT), { columnTypes: await exportColumnTypes(db) });
    expect(dump).not.toContain(SOURCE_WEBHOOK_SECRET.slice(0, 12));
    expect(dump).not.toContain(hashKey(SOURCE_POSTBACK_TOKEN));
    expect(dump).toContain('-- Not exported: secret, secretPrefix.');

    await wipe();
    await runSql(asPsqlWould(dump, TENANT));

    const endpoint = await db(TABLES.WebhookEndpoint).where({ id: seeded.webhookEndpointId }).first();
    expect(endpoint.active).toBe(false);
    expect(endpoint.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(endpoint.secretPrefix).toBe(endpoint.secret.slice(0, 12));
    const token = await db(TABLES.ConversionPostbackToken).where({ id: seeded.postbackTokenId }).first();
    expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.ipAllowlist).toEqual(['203.0.113.0/24']);
    expect(await verifyPostbackToken(db, TENANT, SOURCE_POSTBACK_TOKEN)).toBeNull();

    // Two endpoints never share a generated secret.
    await db(TABLES.WebhookEndpoint).del();
    const two = buildSqlDump(
      {
        [TABLES.WebhookEndpoint]: [
          { id: ulid(), tenantId: 'source', url: 'https://a.x.test', events: ['*'], active: true, label: null, createdAt: new Date() },
          { id: ulid(), tenantId: 'source', url: 'https://b.x.test', events: ['*'], active: true, label: null, createdAt: new Date() },
        ],
      },
      { tenantId: TENANT, columnTypes: await exportColumnTypes(db) },
    );
    await runSql(two);
    const secrets = (await db(TABLES.WebhookEndpoint).pluck('secret')) as string[];
    expect(new Set(secrets).size).toBe(2);
  }, 30_000);

  it('the portable form restores under whatever tenant psql is given', async () => {
    await seedEverything();
    const bundle = await exportAll(db, TENANT);
    const before = await counts();
    const dump = buildSqlDump(bundle, { sourceTenantId: 'acme', columnTypes: await exportColumnTypes(db) });

    // Portable form carries the psql preamble and no baked tenant id.
    expect(dump).toContain(`\\set tenant_id '${DEFAULT_TENANT_ID}'`);
    expect(dump).toContain(":'tenant_id'");

    await wipe();
    await runSql(asPsqlWould(dump, TENANT));

    expect(await counts()).toEqual(before);
    const partner = await db(TABLES.Partner).first();
    expect(partner.tenantId).toBe(TENANT); // rewritten, not 'acme'
  }, 30_000);

  it('is idempotent — re-running the dump inserts nothing new', async () => {
    await seedEverything();
    const dump = buildSqlDump(await exportAll(db, TENANT), { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    const before = await counts();

    await runSql(dump); // rows already exist
    expect(await counts()).toEqual(before);
  }, 30_000);

  it('escapes quotes, json, decimals and nulls', async () => {
    await seedEverything();
    const dump = buildSqlDump(await exportAll(db, TENANT), { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    expect(dump).toContain(`'O''Hara & Co'`); // doubled quote
    // jsonb → a JSON literal; text[] → a Postgres array literal. Same JS
    // array shape, two different renderings — that's the whole point.
    // (jsonb doesn't preserve key order, so match on the shape, not the string)
    expect(dump).toMatch(/'\[\{[^']*"type":"percent"[^']*\}\]'/);
    expect(dump).toContain(`'{"saas","devtools"}'`);
    expect(dump).toContain('NULL');
    // PartnerCommission: bare, so a row whose natural key is taken under a
    // different id is skipped instead of aborting the restore.
    expect(dump).toMatch(/INSERT INTO "PartnerCommission" [^;]*\nON CONFLICT DO NOTHING;/);
    expect(dump).toContain(`ON CONFLICT ("id") DO NOTHING;`); // everything else
    expect(dump).toContain(`-- OpenPartner export — schemaVersion ${SCHEMA_VERSION}`);
  });

  it('emits a header and a no-rows marker for empty tables', () => {
    const dump = buildSqlDump({}, { tenantId: TENANT, exportedAt: '2026-08-09T00:00:00.000Z' });
    expect(dump).toContain('-- exported 2026-08-09T00:00:00.000Z');
    expect(dump).toContain(`-- ${TABLES.Partner}: no rows`);
    expect(dump).toContain('BEGIN;');
    expect(dump.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});

// ---- Restore safety (Codex review, 2026-08-09) -----------------------------

describe.skipIf(skipIntegration)('SQL dump restore safety', () => {
  it('the no -v path works: the built-in fallback is the tenant PRIMARY KEY', async () => {
    // Regression: the fallback used to be the tenant SLUG ('default'), so
    // the documented `psql -f dump.sql` restore failed the tenantId → Tenant.id
    // foreign key on the very first row.
    await seedEverything();
    const before = await counts();
    const dump = buildSqlDump(await exportAll(db, TENANT), { columnTypes: await exportColumnTypes(db) });
    expect(dump).toContain(`\\set tenant_id '${TENANT}'`);

    await wipe();
    await runSql(asPsqlWouldWithoutVar(dump));

    expect(await counts()).toEqual(before);
    expect((await db(TABLES.Partner).first()).tenantId).toBe(TENANT);
  }, 30_000);

  it('pins the string-literal mode its escaping assumes', async () => {
    const dump = buildSqlDump({}, { tenantId: TENANT });
    expect(dump).toContain('SET LOCAL standard_conforming_strings = on;');
  });

  it('refuses a tenant id that could carry a psql meta-command', () => {
    // `\!` at the start of a line makes psql run a shell command on the
    // machine doing the restore. The value lands in a header comment of a
    // file psql executes, so it is validated rather than escaped.
    expect(isSafeTenantId(TENANT)).toBe(true);
    expect(isSafeTenantId("x\n\\! rm -rf /\n--")).toBe(false);
    expect(isSafeTenantId("x'; drop table \"Partner\"; --")).toBe(false);
    expect(isSafeTenantId('')).toBe(false);
    expect(isSafeTenantId('a'.repeat(65))).toBe(false);
    expect(() => buildSqlDump({}, { tenantId: "x\n\\! calc" })).toThrow(/invalid tenant id/);
  });

  it('never lets a header comment be broken out of', () => {
    const dump = buildSqlDump({}, { tenantId: TENANT, sourceTenantId: 'acme\n\\! calc\n--' });
    for (const line of dump.split('\n')) {
      // Every line before BEGIN; is either a comment, a psql meta-command
      // the generator itself emitted, or blank.
      if (line.startsWith('BEGIN;')) break;
      const isOwnMetaCommand =
        line === '\\if :{?tenant_id}' ||
        line === '\\else' ||
        line === '\\endif' ||
        line.startsWith('\\set tenant_id ');
      expect(line === '' || line.startsWith('--') || isOwnMetaCommand).toBe(true);
    }
  });

  it('backslashes and quotes in row data survive the SQL round-trip', async () => {
    const { partnerId } = await seedEverything();
    await db(TABLES.Partner)
      .where({ id: partnerId })
      .update({ name: `back\\slash '; select pg_sleep(0); -- and "quotes"` });
    const before = await counts();
    const dump = buildSqlDump(await exportAll(db, TENANT), {
      tenantId: TENANT,
      columnTypes: await exportColumnTypes(db),
    });

    await wipe();
    await runSql(dump);

    expect(await counts()).toEqual(before);
    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    expect(partner.name).toBe(`back\\slash '; select pg_sleep(0); -- and "quotes"`);
  }, 30_000);

  it('text that merely looks like a timestamp stays text', async () => {
    // normalizeRow used to revive ANY ISO-shaped string as a Date.
    const { partnerId } = await seedEverything();
    await db(TABLES.Partner).where({ id: partnerId }).update({ name: '2026-08-09T00:00:00' });
    const bundle = await exportAll(db, TENANT);
    await wipe();
    await importBundle(db, TENANT, bundle);

    const partner = await db(TABLES.Partner).where({ id: partnerId }).first();
    expect(partner.name).toBe('2026-08-09T00:00:00');
  }, 30_000);
});

describe.skipIf(skipIntegration)('SQL route validation', () => {
  const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'op_test_admin_key_0123456789abcdef0123';

  it('400s a malformed tenantId rather than quietly ignoring it', async () => {
    const app = createApp();
    // A repeated parameter parses as an array. Treating "present but not a
    // string" as absent returned a portable 200 dump instead of the 400
    // the contract promises.
    const repeated = await request(app)
      .get('/export.sql?tenantId=a&tenantId=b')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(repeated.status).toBe(400);

    const newline = await request(app)
      .get(`/export.sql?tenantId=${encodeURIComponent('x\n\\! whoami')}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(newline.status).toBe(400);

    expect(repeated.body.error).toBe('invalid_tenant_id');

    // …and a well-formed one is actually HONOURED, not just accepted. A
    // 200 alone would also pass if the parameter were ignored and a
    // portable dump returned.
    const ok = await request(app)
      .get(`/export.sql?tenantId=${TENANT}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(`'${TENANT}'`);
    expect(ok.text).not.toContain(":'tenant_id'");
    expect(ok.text).not.toContain('\\set tenant_id');
  });

  it('validates on the per-table SQL route too', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/export/Partner.sql?tenantId=a&tenantId=b')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_tenant_id');
  });
});

describe.skipIf(skipIntegration)('cross-tenant restore', () => {
  const OTHER_TENANT = '01J0000000OTHERTENANT00000';

  afterAll(async () => {
    if (skipIntegration) return;
    for (const { table } of [...EXPORT_TABLES].reverse()) {
      await db(table).where({ tenantId: OTHER_TENANT }).del();
    }
    await db(TABLES.Tenant).where({ id: OTHER_TENANT }).del();
  });

  it('rewrites tenantId on import — the whole point of hosted → self-host', async () => {
    // Every other round-trip test exports and imports under the SAME
    // tenant, so they would all pass with the rewrite deleted. This one
    // restores into a different tenant, which is the actual promise:
    // a hosted export lands in a self-host instance under ITS tenant id.
    await db(TABLES.Tenant)
      .insert({
        id: OTHER_TENANT,
        slug: 'other-restore-target',
        displayName: 'Restore Target',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();

    const seeded = await seedEverything();
    const bundle = await exportAll(db, TENANT);
    const sourceCounts = await counts();

    // Wipe first: primary keys are GLOBAL, not per-tenant, so importing a
    // bundle alongside its source in the same database is a no-op —
    // `onConflict(pk).ignore()` sees the original rows. The real scenario
    // is a different database (hosted → self-host), which this models.
    await wipe();
    const report = await importBundle(db, OTHER_TENANT, bundle);
    expect(report.inserted[TABLES.Partner]).toBe(1);

    for (const { table } of EXPORT_TABLES) {
      const [row] = (await db(table).where({ tenantId: OTHER_TENANT }).count({ n: '*' })) as Array<{
        n: string;
      }>;
      expect(Number(row?.n ?? 0), `${table} should have landed in the target tenant`).toBe(
        sourceCounts[table],
      );
    }

    // The rows really moved tenant, ids and all.
    const moved = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(moved.tenantId).toBe(OTHER_TENANT);
  }, 30_000);
});

// ---- Round-6 review fixes (Codex, 2026-08-12) -----------------------------

describe.skipIf(skipIntegration)('round-6: scalar and null JSON round-trip', () => {
  it('a jsonb column holding a STRING survives export → SQL restore', async () => {
    // pg parses json/jsonb through JSON.parse, so a stored '"hello"' arrives
    // as the JS string `hello`. Both serializers only re-serialized when
    // `typeof v === 'object'`, so the dump emitted the SQL literal 'hello' —
    // not valid JSON — and the restore failed outright. A scalar is a legal
    // JSON value and NOT NULL jsonb accepts it.
    await seedEverything();
    const partner = (await db(TABLES.Partner).where({ tenantId: TENANT }).first()) as { id: string };
    await db.raw(`update "Partner" set metadata = '"hello"'::jsonb where id = ?`, [partner.id]);

    const bundle = await exportAll(db, TENANT);
    const dump = buildSqlDump(bundle, { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    await wipe();
    await runSql(dump);

    const restored = (await db(TABLES.Partner).where({ id: partner.id }).first()) as {
      metadata: unknown;
    };
    expect(restored.metadata).toBe('hello');
  }, 30_000);

  it('a jsonb column holding a STRING survives the JSON import path', async () => {
    // This used to use the number 42 and passed with the fix reverted: pg
    // prepares a JS number as the parameter text "42", which is already
    // valid JSON input, so the old `typeof v === 'object'` guard was never
    // exercised. A string is the effective mutation killer — `hello` is
    // prepared bare and jsonb rejects it.
    await seedEverything();
    const partner = (await db(TABLES.Partner).where({ tenantId: TENANT }).first()) as { id: string };
    await db.raw(`update "Partner" set metadata = '"hello"'::jsonb where id = ?`, [partner.id]);

    const bundle = await exportAll(db, TENANT);
    await wipe();
    await importBundle(db, TENANT, bundle);

    const restored = (await db(TABLES.Partner).where({ id: partner.id }).first()) as {
      metadata: unknown;
    };
    expect(restored.metadata).toBe('hello');
  }, 30_000);

  it('a JSON number beyond IEEE-754 range does NOT survive — documented, not fixed', async () => {
    // Honest coverage of a known lossy case rather than a claim that null
    // is the only residual. pg parses jsonb through JSON.parse, so an
    // integer past 2^53 is already rounded before either serializer sees
    // it. If this test ever starts passing, someone has made the parse
    // lossless and docs/data-portability.md should be updated.
    await seedEverything();
    const partner = (await db(TABLES.Partner).where({ tenantId: TENANT }).first()) as { id: string };
    await db.raw(`update "Partner" set metadata = '9007199254740993'::jsonb where id = ?`, [
      partner.id,
    ]);

    const bundle = await exportAll(db, TENANT);
    await wipe();
    await importBundle(db, TENANT, bundle);

    const restored = (await db(TABLES.Partner).where({ id: partner.id }).first()) as {
      metadata: unknown;
    };
    expect(restored.metadata).toBe(9007199254740992); // rounded, not 993
  }, 30_000);
});

describe.skipIf(skipIntegration)('commission slabs round-trip', () => {
  // Slab tables live inside the rule JSON (Program + PartnerCommission) and
  // the band/tier that applied lives in Commission.metadata. All three have
  // to come back exactly, or an imported instance re-derives different
  // commissions — or can't show why the ledger says what it says.
  const slabRules = [
    {
      trigger: 'every',
      eventType: 'invoice_paid',
      type: 'percent',
      value: 10,
      currency: 'INR',
      bands: { mode: 'marginal', levels: [{ above: 50000, value: 15 }, { above: 100000, value: 20 }] },
    },
    {
      trigger: 'first',
      eventType: 'subscription_created',
      type: 'fixed',
      value: 50,
      tiers: { metric: 'conversions', window: 'rolling_days', windowDays: 90, levels: [{ atLeast: 10, value: 100 }] },
    },
  ];
  const trace = {
    slab: {
      kind: 'band',
      ruleIndex: 0,
      type: 'percent',
      mode: 'marginal',
      level: 1,
      threshold: 50000,
      value: 15,
      currency: 'INR',
      basis: 60000.5,
      slices: [
        { level: 0, from: 0, to: 50000, portion: 50000, value: 10 },
        { level: 1, from: 50000, to: null, portion: 10000.5, value: 15 },
      ],
    },
  };

  async function seedSlabs(): Promise<Seeded> {
    const seeded = await seedEverything();
    await db(TABLES.Program).where({ id: seeded.programId }).update({ commissionRule: JSON.stringify(slabRules) });
    await db(TABLES.PartnerCommission)
      .where({ partnerId: seeded.partnerId })
      .update({ commissionRules: JSON.stringify(slabRules) });
    await db(TABLES.Commission).where({ id: seeded.commissionId }).update({ metadata: trace });
    return seeded;
  }

  async function expectSlabsRestored(seeded: Seeded): Promise<void> {
    const program = await db(TABLES.Program).where({ id: seeded.programId }).first();
    expect(program.commissionRule).toEqual(slabRules);
    const terms = await db(TABLES.PartnerCommission).where({ partnerId: seeded.partnerId }).first();
    expect(terms.commissionRules).toEqual(slabRules);
    const commission = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(commission.metadata).toEqual(trace);
  }

  it('survives the JSON export → import path', async () => {
    const seeded = await seedSlabs();
    const bundle = await exportAll(db, TENANT);
    await wipe();
    await importBundle(db, TENANT, bundle);
    await expectSlabsRestored(seeded);
  }, 30_000);

  it('survives the SQL dump run as plain SQL', async () => {
    const seeded = await seedSlabs();
    const bundle = await exportAll(db, TENANT);
    const dump = buildSqlDump(bundle, { tenantId: TENANT, columnTypes: await exportColumnTypes(db) });
    await wipe();
    await runSql(dump);
    await expectSlabsRestored(seeded);
  }, 30_000);

  it('a bundle from before Commission.metadata existed imports with {}', async () => {
    const seeded = await seedEverything();
    const bundle = await exportAll(db, TENANT);
    for (const row of bundle[TABLES.Commission] as Array<Record<string, unknown>>) delete row.metadata;
    await wipe();
    await importBundle(db, TENANT, bundle);
    const commission = await db(TABLES.Commission).where({ id: seeded.commissionId }).first();
    expect(commission.metadata).toEqual({});
  }, 30_000);
});

describe.skipIf(skipIntegration)('round-6: export is scoped without relying on RLS', () => {
  it('exportTable filters by tenantId even on a privileged connection', async () => {
    // Exports were an unfiltered `select *`, leaning entirely on RLS. But
    // appDb falls back to the privileged DATABASE_URL when DATABASE_URL_APP
    // is unset — a configuration db.ts documents as supported because
    // "app-level tenantId filtering still applies". It did not apply here.
    //
    // `db` in this suite IS the privileged pool, so this test runs in
    // exactly the configuration that used to leak.
    await seedEverything();
    const otherTenant = '01J0000000ROUND6TENANT0000';
    await db(TABLES.Tenant)
      .insert({
        id: otherTenant,
        slug: 'round6-scoping',
        displayName: 'Round6 Scoping',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();
    const foreignId = ulid();
    await db(TABLES.Partner).insert({
      id: foreignId,
      tenantId: otherTenant,
      email: `foreign-${foreignId}@x.test`,
      name: 'Foreign partner',
    });

    const rows = (await exportTable(db, TABLES.Partner as never, TENANT)) as Array<{
      id: string;
      tenantId: string;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true);
    expect(rows.some((r) => r.id === foreignId)).toBe(false);

    await db(TABLES.Partner).where({ id: foreignId }).del();
    await db(TABLES.Tenant).where({ id: otherTenant }).del();
  }, 30_000);
});

describe.skipIf(skipIntegration)('round-7: an API key is bound to its tenant', () => {
  it('another tenant\'s admin key cannot authenticate against this tenant', async () => {
    // The key lookup filtered on prefix alone and leaned on RLS to keep it
    // inside the tenant. That holds on the app role — but appDb falls back
    // to the privileged DATABASE_URL when DATABASE_URL_APP is unset, a
    // configuration db.ts documents as supported, and there RLS is bypassed.
    // Tenant A's key then authenticated against tenant B's path and every
    // tenant-scoped query below it, including the export, served B's data.
    //
    // This suite runs on the privileged pool, which is exactly the
    // configuration that used to leak.
    const foreignTenant = '01J0000000R7AUTHTENANT0000';
    await db(TABLES.Tenant)
      .insert({
        id: foreignTenant,
        slug: 'r7-auth',
        displayName: 'R7 Auth',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();

    const { plaintext, prefix, hash } = generateApiKey();
    await db(TABLES.ApiKey).insert({
      id: ulid(),
      tenantId: foreignTenant, // belongs to the OTHER tenant
      label: 'foreign admin key',
      prefix,
      keyHash: hash,
    });

    const app = createApp({ enableLogger: false });
    // Hit the default tenant's export with a key issued to another tenant.
    const res = await request(app)
      .get('/export.json')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(401);

    await db(TABLES.ApiKey).where({ tenantId: foreignTenant }).del();
    await db(TABLES.Tenant).where({ id: foreignTenant }).del();
  }, 30_000);

  it('a key issued to THIS tenant still works', async () => {
    // The other half — the fix must not lock everyone out.
    const { plaintext, prefix, hash } = generateApiKey();
    await db(TABLES.ApiKey).insert({
      id: ulid(),
      tenantId: TENANT,
      label: 'local admin key',
      prefix,
      keyHash: hash,
    });

    const app = createApp({ enableLogger: false });
    const res = await request(app)
      .get('/export.json')
      .set('Authorization', `Bearer ${plaintext}`);

    expect(res.status).toBe(200);

    await db(TABLES.ApiKey).where({ prefix }).del();
  }, 30_000);
});

describe.skipIf(skipIntegration)('round-8: a session cookie is bound to its tenant too', () => {
  it('another tenant\'s admin session cannot authenticate against this tenant', async () => {
    // Round 7 bound the API-key path. The cookie path had the identical
    // hole: resolveSession matched on {prefix, tokenHash} with no tenant
    // predicate, so on the privileged pool tenant A's cookie resolved
    // against tenant B's URL and resolvePrincipal handed back an admin
    // principal for B. Fixing one credential path and not the other is
    // exactly the kind of half-fix these rounds keep finding.
    const foreignTenant = '01J0000000R8SESSTENANT0000';
    await db(TABLES.Tenant)
      .insert({
        id: foreignTenant,
        slug: 'r8-session',
        displayName: 'R8 Session',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();

    const adminId = ulid();
    await db(TABLES.Admin).insert({
      id: adminId,
      tenantId: foreignTenant,
      email: `r8-${adminId}@x.test`,
      name: 'Foreign admin',
      activatedAt: new Date(),
    });
    const { plaintext } = await createSession(db, {
      tenantId: foreignTenant,
      principalKind: 'admin',
      principalId: adminId,
    });

    const app = createApp({ enableLogger: false });
    const res = await request(app)
      .get('/export.json')
      .set('Cookie', `op_session=${plaintext}`);

    expect(res.status).toBe(401);

    await db(TABLES.Session).where({ tenantId: foreignTenant }).del();
    await db(TABLES.Admin).where({ id: adminId }).del();
    await db(TABLES.Tenant).where({ id: foreignTenant }).del();
  }, 30_000);

  it('a session issued for THIS tenant still works', async () => {
    // The other direction — the binding must not lock legitimate admins out.
    const adminId = ulid();
    await db(TABLES.Admin).insert({
      id: adminId,
      tenantId: TENANT,
      email: `r8-local-${adminId}@x.test`,
      name: 'Local admin',
      activatedAt: new Date(),
    });
    const { plaintext } = await createSession(db, {
      tenantId: TENANT,
      principalKind: 'admin',
      principalId: adminId,
    });

    const app = createApp({ enableLogger: false });
    const res = await request(app)
      .get('/export.json')
      .set('Cookie', `op_session=${plaintext}`);

    expect(res.status).toBe(200);

    await db(TABLES.Session).where({ principalId: adminId }).del();
    await db(TABLES.Admin).where({ id: adminId }).del();
  }, 30_000);
});

describe.skipIf(skipIntegration)('round-9: signout revokes the token it was given', () => {
  it('a stale-tab signout still revokes the session, even for another tenant', async () => {
    // Round 8 routed signout through resolveSession, which it had just bound
    // to the request tenant — and that silently broke logout. `op_session`
    // is host-wide at path '/', so entering a second workspace overwrites
    // it; a signout from a stale tab then carries tenant B's token to tenant
    // A's URL. The filtered lookup found nothing, the route cleared the
    // browser cookie and returned 200, and B's session stayed live.
    //
    // Revert revokeSessionByToken and this test finds the session still
    // usable after "logging out".
    const otherTenant = '01J0000000R9SIGNOUTTENANT0';
    await db(TABLES.Tenant)
      .insert({
        id: otherTenant,
        slug: 'r9-signout',
        displayName: 'R9 Signout',
        status: 'active',
        approvalStatus: 'approved',
      })
      .onConflict('id')
      .ignore();

    const adminId = ulid();
    await db(TABLES.Admin).insert({
      id: adminId,
      tenantId: otherTenant,
      email: `r9-${adminId}@x.test`,
      name: 'Other-tenant admin',
      activatedAt: new Date(),
    });
    const { plaintext, id: sessionId } = await createSession(db, {
      tenantId: otherTenant,
      principalKind: 'admin',
      principalId: adminId,
    });

    // Signout hits the DEFAULT tenant's URL carrying the other tenant's
    // cookie — the stale-tab shape.
    const app = createApp({ enableLogger: false });
    const res = await request(app)
      .post('/auth/signout')
      .set('Cookie', `op_session=${plaintext}`);
    expect(res.status).toBe(200);

    const row = (await db(TABLES.Session).where({ id: sessionId }).first()) as {
      revokedAt: Date | null;
    };
    expect(row.revokedAt).not.toBeNull(); // actually logged out

    await db(TABLES.Session).where({ id: sessionId }).del();
    await db(TABLES.Admin).where({ id: adminId }).del();
    await db(TABLES.Tenant).where({ id: otherTenant }).del();
  }, 30_000);
});
