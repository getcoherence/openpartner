/**
 * The dashboard's "Getting started" card for brands that don't list on the
 * OpenPartner Network.
 *
 * GET /admin/onboarding-status only said `complete` once the brand was on
 * the Network with a published program, so a brand that didn't want the
 * Network (a headless Refer & Earn, say) could never clear the card. Now:
 *
 *   - "Not now" (`POST /config/onboarding`) settles the Network steps;
 *   - a white-label brand, which can't join the Network, never waits on them;
 *   - joining the Network later clears the skip, so the publish step is
 *     back;
 *   - "Offer the Network to your partners" (autoEnroll) is a separate
 *     choice: toggling it neither clears the skip nor stands in for it;
 *   - the setup-reminder checklist stops asking a skipped brand to list.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_onboardingskip_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { brandSetupFor } = await import('../brand-setup.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const createdTenants: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

/** A brand that has done every step except the Network ones: named,
 *  approved, a program, a partner, and tracking (a verified coupon
 *  integration). Self-host mode, so billing is ready. */
async function seedReadyBrand(opts: { whiteLabel?: boolean } = {}): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `ob${rnd()}`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: `Brand ${slug}`,
    status: 'active',
    approvalStatus: 'approved',
    whiteLabel: opts.whiteLabel ?? false,
    couponIntegrationVerifiedAt: new Date(),
  });
  createdTenants.push(id);
  await db(TABLES.Program).insert({
    id: ulid(),
    tenantId: id,
    name: 'Refer & Earn',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://brand.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  await db(TABLES.Partner).insert({
    id: ulid(),
    tenantId: id,
    email: `p-${rnd()}@brand.test`,
    name: 'Riya',
    metadata: {},
    activatedAt: new Date(),
  });
  return { id, slug };
}

const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${ADMIN_KEY}`);
const status = (slug: string) => asAdmin(request(app).get(`/t/${slug}/admin/onboarding-status`));
const setSkip = (slug: string, networkListingSkipped: unknown) =>
  asAdmin(request(app).post(`/t/${slug}/config/onboarding`)).send({ networkListingSkipped });

// ----- fake Network: answers every call with `netReply` -----
let netServer: Server;
let netUrl = '';
let netReply: unknown = {};

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(netReply));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  netReply = { offerings: [], requests: [] };
});

afterEach(async () => {
  if (skipIntegration) return;
  delete process.env.NETWORK_URL;
  for (const id of createdTenants.splice(0)) {
    for (const t of [TABLES.Partner, TABLES.Program, TABLES.Config]) await db(t).where({ tenantId: id }).del();
    await db(TABLES.Tenant).where({ id }).del();
  }
});

afterAll(async () => {
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
});

describe.skipIf(skipIntegration)('Getting started card: the Network is optional', () => {
  it('"Not now" lets a brand off the Network finish; undoing it brings the step back', async () => {
    const b = await seedReadyBrand();
    let res = await status(b.slug);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ networkConnected: false, networkListingSkipped: false, complete: false });

    const saved = await setSkip(b.slug, true);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ networkListingSkipped: true });
    expect((await asAdmin(request(app).get(`/t/${b.slug}/config/onboarding`))).body).toEqual({ networkListingSkipped: true });

    res = await status(b.slug);
    expect(res.body).toMatchObject({ networkConnected: false, networkListingSkipped: true, complete: true });

    await setSkip(b.slug, false);
    res = await status(b.slug);
    expect(res.body).toMatchObject({ networkListingSkipped: false, complete: false });
  });

  it('the skip only settles the Network: other missing steps still keep the card up', async () => {
    const b = await seedReadyBrand();
    await db(TABLES.Partner).where({ tenantId: b.id }).del();
    await setSkip(b.slug, true);
    const res = await status(b.slug);
    expect(res.body).toMatchObject({ networkListingSkipped: true, partnerCount: 0, complete: false });
  });

  it('a white-label brand finishes without the Network, skip or no skip', async () => {
    const b = await seedReadyBrand({ whiteLabel: true });
    const res = await status(b.slug);
    expect(res.body).toMatchObject({ networkConnected: false, networkListingSkipped: false, complete: true });
  });

  it('rejects a body that isn\'t a boolean, and keeps the value when the field is omitted', async () => {
    const b = await seedReadyBrand();
    expect((await setSkip(b.slug, 'yes')).status).toBe(400);
    await setSkip(b.slug, true);
    const kept = await asAdmin(request(app).post(`/t/${b.slug}/config/onboarding`)).send({});
    expect(kept.body).toEqual({ networkListingSkipped: true });
  });

  it('toggling "Offer the Network to your partners" neither clears the skip nor replaces it', async () => {
    const b = await seedReadyBrand();
    await setSkip(b.slug, true);
    for (const autoEnroll of [false, true]) {
      const r = await asAdmin(request(app).post(`/t/${b.slug}/config/network`)).send({ autoEnroll });
      expect(r.status).toBe(200);
      expect((await status(b.slug)).body).toMatchObject({ networkListingSkipped: true, complete: true });
    }

    // And with no skip, the offer being off doesn't count as skipping.
    await setSkip(b.slug, false);
    await asAdmin(request(app).post(`/t/${b.slug}/config/network`)).send({ autoEnroll: false });
    expect((await status(b.slug)).body).toMatchObject({ networkListingSkipped: false, complete: false });
  });

  it('joining the Network after skipping brings the publish step back', async () => {
    const b = await seedReadyBrand();
    await setSkip(b.slug, true);

    const joined = await asAdmin(request(app).post(`/t/${b.slug}/config/network`)).send({
      enabled: true,
      networkUrl: netUrl,
      vendorToken: 'vt_fake_vendor_token_0123456789',
    });
    expect(joined.status).toBe(200);

    let res = await status(b.slug);
    expect(res.body).toMatchObject({
      networkConnected: true,
      offeringPublishedCount: 0,
      networkListingSkipped: false,
      complete: false,
    });

    netReply = { offerings: [{ id: 'off_1', published: true }], requests: [] };
    res = await status(b.slug);
    expect(res.body).toMatchObject({ offeringPublishedCount: 1, complete: true });
  });

  it('finishing the email-verify connect also clears the skip', async () => {
    const b = await seedReadyBrand();
    await setSkip(b.slug, true);
    process.env.NETWORK_URL = netUrl;
    netReply = { vendorToken: 'vt_fake_vendor_token_0123456789', vendorId: 'ven_1', displayName: 'Brand', offerings: [], requests: [] };

    const res = await asAdmin(request(app).post(`/t/${b.slug}/config/network/complete-connect`)).send({
      ntoken: 'nt_fake_connect_token_0123456789',
    });
    expect(res.status).toBe(200);
    expect((await status(b.slug)).body).toMatchObject({ networkConnected: true, networkListingSkipped: false, complete: false });
  });

  it('a brand already on the Network can skip publishing', async () => {
    const b = await seedReadyBrand();
    await db(TABLES.Config).insert({
      tenantId: b.id,
      key: 'network_membership',
      value: {
        enabled: true,
        networkUrl: netUrl,
        vendorTokenCiphertext: encryptSecret('vt_fake_vendor_token_0123456789'),
        scopedKeyId: null,
        autoEnroll: false,
      },
      updatedAt: new Date(),
    });
    expect((await status(b.slug)).body).toMatchObject({ networkConnected: true, offeringPublishedCount: 0, complete: false });

    await setSkip(b.slug, true);
    expect((await status(b.slug)).body).toMatchObject({ networkConnected: true, complete: true });
  });
});

describe.skipIf(skipIntegration)('setup checklist (reminder emails)', () => {
  it('drops the listing step for an on-Network brand that said "Not now"', async () => {
    const b = await seedReadyBrand();
    await db(TABLES.Config).insert({
      tenantId: b.id,
      key: 'network_membership',
      value: { enabled: true, networkUrl: netUrl, vendorTokenCiphertext: '', scopedKeyId: null, autoEnroll: true },
      updatedAt: new Date(),
    });
    let setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.steps.map((s) => s.key)).toContain('listing');
    expect(setup.complete).toBe(false);

    await setSkip(b.slug, true);
    setup = (await brandSetupFor(db, [b.id])).get(b.id)!;
    expect(setup.steps.map((s) => s.key)).not.toContain('listing');
    expect(setup.complete).toBe(true);
  });
});
