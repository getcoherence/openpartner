/**
 * Tenant isolation when RLS is NOT enforced.
 *
 * Multi-tenant mode with DATABASE_URL_APP unset: the app pool falls back to
 * the privileged DATABASE_URL, so Postgres row-level security never applies.
 * An Oct 2026 verification ran the API like this and found:
 *   - another tenant's scoped key read partners (email + CRM metadata)
 *     through GET /partners?email= and ?q=,
 *   - the CSV import, and POST /partners without programIds, granted every
 *     tenant's programs,
 *   - aggregateAttributedGmv summed every tenant's GMV.
 *
 * Two fixes are covered here:
 *   1. The boot guard (tenant-isolation-guard.ts) refuses to start a
 *      multi-tenant API in this configuration.
 *   2. Those paths filter on tenantId explicitly, so the misconfiguration
 *      can't leak even if the guard is bypassed.
 *
 * The isolation tests assert their own precondition (the app pool really
 * bypasses RLS here), so they can't pass vacuously on an app-role setup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
// The configuration under test: no app role, so appDb = DATABASE_URL.
delete process.env.DATABASE_URL_APP;
delete process.env.ADMIN_API_KEY; // env admin keys are valid on every tenant
delete process.env.NETWORK_URL;

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { assertAppPoolEnforcesRls, inspectAppRole, rlsProblem } = await import('../tenant-isolation-guard.js');
const { aggregateAttributedGmv, aggregateNetworkOriginatedPayouts, NETWORK_ORIGIN_SOURCE } = await import(
  '../usage-billing.js'
);

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// Tenant A plays the victim (a tenant whose roster carries CRM
// metadata), tenant B the other tenant holding a scoped key.
const A = { id: `01NORLSA${ulid().slice(8)}`, slug: `norls-a-${ulid().slice(-6).toLowerCase()}` };
const B = { id: `01NORLSB${ulid().slice(8)}`, slug: `norls-b-${ulid().slice(-6).toLowerCase()}` };
const TENANTS = [A.id, B.id];

// Children before parents, for the FKs.
const TABLES_TO_CLEAN = [
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Click,
  TABLES.Link,
  TABLES.Payout,
  TABLES.Coupon,
  TABLES.PartnerCommission,
  TABLES.PartnerProgram,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Program,
  TABLES.Config,
];

async function wipe(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', TENANTS).del();
}

async function seedProgram(tenantId: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name: `Program ${id.slice(-4)}`,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.test/',
  });
  return id;
}

async function seedPartner(
  tenantId: string,
  email: string,
  name: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, email, name, metadata, activatedAt: new Date() });
  return id;
}

async function grantsOf(partnerId: string): Promise<string[]> {
  const rows = (await db(TABLES.PartnerProgram).where({ partnerId }).select('programId')) as Array<{
    programId: string;
  }>;
  return rows.map((r) => r.programId).sort();
}

let aPrograms: string[] = [];
let bPrograms: string[] = [];
let aPartnerId = '';
const A_EMAIL = `ada-${ulid().slice(-6).toLowerCase()}@tenant-a.test`;
let bKey = '';

beforeAll(async () => {
  if (skipIntegration) return;
  await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  await db(TABLES.Tenant).insert([
    { id: A.id, slug: A.slug, displayName: 'Tenant A', status: 'active', approvalStatus: 'approved' },
    { id: B.id, slug: B.slug, displayName: 'Tenant B', status: 'active', approvalStatus: 'approved' },
  ]);
});

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
  aPrograms = [await seedProgram(A.id), await seedProgram(A.id), await seedProgram(A.id)];
  bPrograms = [await seedProgram(B.id)];
  aPartnerId = await seedPartner(A.id, A_EMAIL, 'Ada Lovelace', { crm: { accountId: 'CRM-SECRET-1' } });
  await seedPartner(A.id, `grace-${ulid().slice(-6).toLowerCase()}@tenant-a.test`, 'Grace Hopper');
  await seedPartner(B.id, `bob-${ulid().slice(-6).toLowerCase()}@tenant-b.test`, 'Bob B');
  bKey = (
    await createApiKeyRow(db, { tenantId: B.id, scopes: ['partners:read', 'partners:write'], label: 'B scoped' })
  ).plaintext;
});

afterAll(async () => {
  if (!skipIntegration) {
    await wipe();
    await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  }
  await db.destroy();
  await appDb.destroy();
});

describe.skipIf(skipIntegration)('boot guard', () => {
  it('refuses multi-tenant mode when the app pool bypasses RLS', async () => {
    await expect(assertAppPoolEnforcesRls(appDb, 'multi')).rejects.toThrow(
      /Refusing to start: OPENPARTNER_TENANCY=multi.*DATABASE_URL_APP is unset/s,
    );
  });

  it('lets single-tenant self-host run on the migration role', async () => {
    await expect(assertAppPoolEnforcesRls(appDb, 'single')).resolves.toBeUndefined();
  });

  it('accepts the openpartner_app role', async () => {
    const role = (await db.raw(
      `select 1 from pg_roles where rolname = 'openpartner_app' and not rolsuper and not rolbypassrls`,
    )) as { rows: unknown[] };
    if (role.rows.length === 0) {
      console.warn('[tenant-isolation-no-rls] openpartner_app role missing; app-role guard check skipped');
      return;
    }
    // SET ROLE inside a transaction: the guard reads current_user, which is
    // then openpartner_app, with no password needed.
    await db.transaction(async (trx) => {
      await trx.raw('set local role openpartner_app');
      const status = await inspectAppRole(trx);
      expect(status).toMatchObject({ role: 'openpartner_app', superuser: false, bypassRls: false });
      expect(status.tablesWithoutRls).toEqual([]);
      await expect(assertAppPoolEnforcesRls(trx, 'multi')).resolves.toBeUndefined();
    });
  });

  it('names the tables an owner role is not subject to RLS on', () => {
    // A table owner (a managed cluster's admin user) is neither superuser nor
    // BYPASSRLS, but skips the policies of tables without FORCE RLS.
    const problem = rlsProblem({ role: 'doadmin', superuser: false, bypassRls: false, tablesWithoutRls: ['Coupon'] });
    expect(problem).toMatch(/"doadmin" is not subject to RLS on Coupon/);
    expect(rlsProblem({ role: 'openpartner_app', superuser: false, bypassRls: false, tablesWithoutRls: [] })).toBeNull();
  });
});

describe.skipIf(skipIntegration)('multi-tenant without RLS: no cross-tenant reads or writes', () => {
  it('runs on a pool that really bypasses RLS (precondition)', async () => {
    expect(rlsProblem(await inspectAppRole(appDb))).not.toBeNull();
  });

  it("GET /partners?email= doesn't find another tenant's partner", async () => {
    const res = await request(app)
      .get(`/t/${B.slug}/partners`)
      .query({ email: A_EMAIL })
      .set('Authorization', `Bearer ${bKey}`);
    expect(res.status).toBe(200);
    expect(res.body.partners).toEqual([]);
  });

  it("GET /partners?q= and the unfiltered list return only the tenant's own partners", async () => {
    const search = await request(app)
      .get(`/t/${B.slug}/partners`)
      .query({ q: 'tenant-a' })
      .set('Authorization', `Bearer ${bKey}`);
    expect(search.status).toBe(200);
    expect(search.body.partners).toEqual([]);

    const all = await request(app).get(`/t/${B.slug}/partners`).set('Authorization', `Bearer ${bKey}`);
    expect(all.status).toBe(200);
    expect(all.body.partners.map((p: { tenantId: string }) => p.tenantId)).toEqual([B.id]);
    expect(JSON.stringify(all.body)).not.toContain('CRM-SECRET-1');
  });

  it("GET /partners/:id 404s on another tenant's partner", async () => {
    const res = await request(app).get(`/t/${B.slug}/partners/${aPartnerId}`).set('Authorization', `Bearer ${bKey}`);
    expect(res.status).toBe(404);
  });

  it("POST /partners without programIds grants only the tenant's own programs", async () => {
    const res = await request(app)
      .post(`/t/${B.slug}/partners`)
      .set('Authorization', `Bearer ${bKey}`)
      .send({ email: `new-${ulid().slice(-6).toLowerCase()}@tenant-b.test`, name: 'New B', sendInvite: false });
    expect(res.status).toBe(201);
    expect(await grantsOf(res.body.id)).toEqual([...bPrograms].sort());
    expect(await db(TABLES.PartnerProgram).whereIn('programId', aPrograms)).toEqual([]);
  });

  it("POST /partners rejects another tenant's programIds", async () => {
    const res = await request(app)
      .post(`/t/${B.slug}/partners`)
      .set('Authorization', `Bearer ${bKey}`)
      .send({ email: `x-${ulid().slice(-6).toLowerCase()}@tenant-b.test`, name: 'X', sendInvite: false, programIds: [aPrograms[0]] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'unknown_campaign_ids', missing: [aPrograms[0]] });
    expect(await db(TABLES.PartnerProgram).whereIn('programId', aPrograms)).toEqual([]);
  });

  it("POST /partners doesn't treat another tenant's email as taken", async () => {
    // Email is unique per tenant. An unscoped pre-check 409'd here, and told
    // tenant B that tenant A has a partner with this address.
    const res = await request(app)
      .post(`/t/${B.slug}/partners`)
      .set('Authorization', `Bearer ${bKey}`)
      .send({ email: A_EMAIL, name: 'Same address, other tenant', sendInvite: false });
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(B.id);
  });

  it("CSV import grants only the tenant's own programs and ignores other tenants' emails", async () => {
    const fresh = `csv-${ulid().slice(-6).toLowerCase()}@tenant-b.test`;
    const res = await request(app)
      .post(`/t/${B.slug}/import/partners-csv`)
      .set('Authorization', `Bearer ${bKey}`)
      .set('Content-Type', 'text/csv')
      .send(`email,name\n${fresh},Fresh B\n${A_EMAIL},Ada in B\n`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 2, created: 2, skipped: 0 });
    // The report never hands back tenant A's partner ID.
    expect(JSON.stringify(res.body)).not.toContain(aPartnerId);

    const created = await db(TABLES.Partner).where({ tenantId: B.id }).whereIn('email', [fresh, A_EMAIL]);
    expect(created).toHaveLength(2);
    for (const p of created) expect(await grantsOf(p.id)).toEqual([...bPrograms].sort());
    expect(await db(TABLES.PartnerProgram).whereIn('programId', aPrograms)).toEqual([]);
    // Tenant A's roster is untouched.
    expect(await db(TABLES.Partner).where({ tenantId: A.id })).toHaveLength(2);
  });
});

describe.skipIf(skipIntegration)('usage-billing aggregates without RLS', () => {
  async function seedAttributedEvent(tenantId: string, programId: string, value: number): Promise<void> {
    const partnerId = await seedPartner(tenantId, `gmv-${ulid()}@x.test`, 'GMV partner');
    const linkId = ulid();
    const clickId = ulid();
    const eventId = ulid();
    await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x/' });
    await db(TABLES.Click).insert({ id: clickId, tenantId, linkId, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts: new Date() });
    await db(TABLES.Event).insert({ id: eventId, tenantId, userId: `u-${eventId}`, type: 'invoice_paid', value: value.toFixed(2), currency: 'USD', ts: new Date() });
    await db(TABLES.Attribution).insert({ id: ulid(), tenantId, eventId, partnerId, programId, clickId, model: 'last_click', weight: '1', computedAt: new Date() });
  }

  async function seedNetworkPayout(tenantId: string, amount: string): Promise<void> {
    const partnerId = await seedPartner(tenantId, `net-${ulid()}@x.test`, 'Network partner', { source: NETWORK_ORIGIN_SOURCE });
    await db(TABLES.Payout).insert({
      id: ulid(),
      tenantId,
      partnerId,
      amount,
      currency: 'USD',
      method: 'manual',
      status: 'paid',
      metadata: {},
      completedAt: new Date(),
    });
  }

  it("aggregateAttributedGmv sums only the given tenant's GMV", async () => {
    await seedAttributedEvent(A.id, aPrograms[0]!, 1000);
    await seedAttributedEvent(B.id, bPrograms[0]!, 25);
    // appDb here is the privileged role, as in the verification run.
    expect(await aggregateAttributedGmv(appDb, B.id, null, new Date(Date.now() + 60_000))).toEqual({ USD: 25 });
    expect(await aggregateAttributedGmv(appDb, A.id, null, new Date(Date.now() + 60_000))).toEqual({ USD: 1000 });
  });

  it("aggregateNetworkOriginatedPayouts sums only the given tenant's payouts", async () => {
    await seedNetworkPayout(A.id, '500.00');
    await seedNetworkPayout(B.id, '40.00');
    expect(await aggregateNetworkOriginatedPayouts(appDb, B.id, null, new Date(Date.now() + 60_000))).toEqual({ USD: 40 });
  });
});
