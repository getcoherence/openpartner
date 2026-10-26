/**
 * Network federation → POST /partners program scoping.
 *
 * When the Network approves a partnership request it provisions the
 * Partner on the brand via POST /partners, scoping the grant to the
 * Offering's program. Network deployments send that scope as
 * `campaignIds` (the pre-rename spelling); the Campaign → Program rename
 * made zod strip it, so the handler fell through to "grant ALL programs"
 * and every Network-approved creator got the brand's whole catalog (plus
 * an auto-minted coupon per program). These tests pin the alias.
 *
 * Skipped if DATABASE_URL isn't set, like the rest of the integration
 * suite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_federation_grants_0123456789abcdef0';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { saveNetworkMembership } = await import('../network-client.js');
const { NETWORK_FEDERATION_SCOPES } = await import('../routes/api-keys.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// Child tables before Partner / Program so FK constraints don't fire.
const TABLES_TO_CLEAN = [
  TABLES.NetworkOutbox,
  TABLES.MagicLinkToken,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.PartnerNetworkConsent,
  TABLES.Payout,
  TABLES.Program,
  TABLES.Partner,
  TABLES.Config,
  TABLES.ApiKey,
];

let offeringProgramId: string;
let otherProgramId: string;

async function seedProgram(name: string): Promise<string> {
  const id = `prg_${ulid()}`;
  await db(TABLES.Program).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    name,
    commissionRule: JSON.stringify({ type: 'percent', value: 20 }),
    destinationUrl: 'https://brand.test/landing',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  return id;
}

/** Body exactly as openpartner-network's approve route sends it via
 *  createPartnerOnVendor (src/routes/partnerships.ts). */
function networkApproveBody(scope: { campaignIds?: string[]; programIds?: string[] }) {
  return {
    email: 'ada@creator.test',
    name: 'Ada',
    metadata: {
      source: 'openpartner_network',
      networkCreatorId: 'crt_ada',
      creatorHandle: 'ada-promotes',
    },
    sendInvite: false,
    ...scope,
    campaignGrantSource: 'offering',
    commissionSnapshot: {
      commissionType: 'percent',
      commissionValue: 20,
      recurring: true,
      holdbackDays: 30,
    },
  };
}

async function grantsFor(partnerId: string) {
  return (await db(TABLES.PartnerProgram)
    .where({ tenantId: DEFAULT_TENANT_ID, partnerId })
    .select('programId', 'source')) as Array<{ programId: string; source: string }>;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  // Don't leave the last test's rows for later files.
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  }
  offeringProgramId = await seedProgram('Offering program');
  otherProgramId = await seedProgram('Unrelated program');
});

describe.skipIf(skipIntegration)('POST /partners — Network federation program scoping', () => {
  it('legacy campaignIds scopes the grant to the offering program only', async () => {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(networkApproveBody({ campaignIds: [offeringProgramId] }));
    expect(res.status).toBe(201);

    const grants = await grantsFor(res.body.id);
    expect(grants).toEqual([{ programId: offeringProgramId, source: 'offering' }]);

    // Auto-mint follows the grants — no coupon on the unrelated program.
    const coupons = (await db(TABLES.Coupon)
      .where({ tenantId: DEFAULT_TENANT_ID, partnerId: res.body.id })
      .select('programId')) as Array<{ programId: string }>;
    expect(coupons.map((c) => c.programId)).toEqual([offeringProgramId]);
  });

  it('programIds wins when both spellings are sent', async () => {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(networkApproveBody({ programIds: [offeringProgramId], campaignIds: [otherProgramId] }));
    expect(res.status).toBe(201);

    const grants = await grantsFor(res.body.id);
    expect(grants).toEqual([{ programId: offeringProgramId, source: 'offering' }]);
  });

  it('unknown campaignIds 400s without leaving an orphan Partner behind', async () => {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(networkApproveBody({ campaignIds: ['prg_deleted_on_brand'] }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'unknown_campaign_ids', missing: ['prg_deleted_on_brand'] });

    // A leftover row would turn every Network re-approve into 409 email_taken.
    const partner = await db(TABLES.Partner).where({ email: 'ada@creator.test' }).first();
    expect(partner).toBeUndefined();
  });

  it('omitting both still grants every program (admin default unchanged)', async () => {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'admin-added@example.test', name: 'Admin Added', sendInvite: false });
    expect(res.status).toBe(201);

    const grants = await grantsFor(res.body.id);
    expect(grants.map((g) => g.programId).sort()).toEqual([offeringProgramId, otherProgramId].sort());
    expect(grants.every((g) => g.source === 'admin')).toBe(true);
  });
});

describe.skipIf(skipIntegration)('POST /partners — a Network approval for someone already a partner', () => {
  /** The key this brand registered with the Network: only it counts as
   *  the Network (isNetworkFederationCall). */
  async function networkKey(): Promise<string> {
    const key = await createApiKeyRow(db, { tenantId: DEFAULT_TENANT_ID, scopes: [...NETWORK_FEDERATION_SCOPES], label: 'network_federation' });
    await saveNetworkMembership(db, DEFAULT_TENANT_ID, { enabled: true, networkUrl: 'https://network.example.test', scopedKeyId: key.id });
    return key.plaintext;
  }

  async function commissionFor(partnerId: string, programId: string) {
    return db(TABLES.PartnerCommission).where({ tenantId: DEFAULT_TENANT_ID, partnerId, programId }).first();
  }

  it('grants the new program to the partner the Network approved before, with its terms', async () => {
    const key = await networkKey();
    const first = await request(app).post('/partners').set('Authorization', `Bearer ${key}`).send(networkApproveBody({ programIds: [offeringProgramId] }));
    expect(first.status).toBe(201);

    // Approved for a second program: the same partner, not a 409.
    const second = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${key}`)
      .send({ ...networkApproveBody({ programIds: [otherProgramId] }), commissionSnapshot: { commissionType: 'percent', commissionValue: 35, recurring: false } });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: first.body.id, existing: true });
    expect(await db(TABLES.Partner).where({ email: 'ada@creator.test' })).toHaveLength(1);

    const grants = await grantsFor(first.body.id);
    expect(grants.map((g) => g.programId).sort()).toEqual([offeringProgramId, otherProgramId].sort());
    expect(grants.every((g) => g.source === 'offering')).toBe(true);
    expect(await commissionFor(first.body.id, otherProgramId)).toMatchObject({ commissionType: 'percent', source: 'approval' });
    expect(Number((await commissionFor(first.body.id, otherProgramId)).commissionValue)).toBe(35);
    // The first program's terms are untouched.
    expect(Number((await commissionFor(first.body.id, offeringProgramId)).commissionValue)).toBe(20);
  });

  it("keeps the terms a brand already set, and a partner's own no to the Network", async () => {
    const key = await networkKey();
    const own = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'ada@creator.test', name: 'Ada', sendInvite: false, programIds: [offeringProgramId] });
    expect(own.status).toBe(201);
    await request(app)
      .put(`/partners/${own.body.id}/programs/${otherProgramId}/commission`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ commissionType: 'percent', commissionValue: 50 });
    await db(TABLES.PartnerNetworkConsent).insert({ partnerId: own.body.id, tenantId: DEFAULT_TENANT_ID, status: 'declined', declinedAt: new Date(), updatedAt: new Date() });

    const linked = await request(app).post('/partners').set('Authorization', `Bearer ${key}`).send(networkApproveBody({ programIds: [otherProgramId] }));
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ id: own.body.id, existing: true });
    expect((await grantsFor(own.body.id)).map((g) => g.programId).sort()).toEqual([offeringProgramId, otherProgramId].sort());
    const terms = await commissionFor(own.body.id, otherProgramId);
    expect(Number(terms.commissionValue)).toBe(50);
    expect(terms.source).toBe('amendment');
    expect((await db(TABLES.PartnerNetworkConsent).where({ partnerId: own.body.id }).first()).status).toBe('declined');
  });

  it('records consent for a partner who never decided', async () => {
    const key = await networkKey();
    const own = await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'ada@creator.test', name: 'Ada', sendInvite: false });
    await request(app).post('/partners').set('Authorization', `Bearer ${key}`).send(networkApproveBody({ programIds: [otherProgramId] }));
    expect(await db(TABLES.PartnerNetworkConsent).where({ partnerId: own.body.id }).first()).toMatchObject({ status: 'granted', source: 'network_offering' });
  });

  it('still refuses a duplicate address from anyone but the Network, and a partner the brand revoked', async () => {
    const key = await networkKey();
    const first = await request(app).post('/partners').set('Authorization', `Bearer ${key}`).send(networkApproveBody({ programIds: [offeringProgramId] }));
    const again = await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'ada@creator.test', name: 'Ada', sendInvite: false });
    expect(again).toMatchObject({ status: 409, body: { error: 'email_taken' } });
    // Network metadata on someone else's key isn't the Network.
    const posing = await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send(networkApproveBody({ programIds: [otherProgramId] }));
    expect(posing.body.error).toBe('email_taken');

    await db(TABLES.Partner).where({ id: first.body.id }).update({ revokedAt: new Date() });
    const revoked = await request(app).post('/partners').set('Authorization', `Bearer ${key}`).send(networkApproveBody({ programIds: [otherProgramId] }));
    expect(revoked).toMatchObject({ status: 409, body: { error: 'partner_revoked' } });
    expect((await grantsFor(first.body.id)).map((g) => g.programId)).toEqual([offeringProgramId]);
  });
});
