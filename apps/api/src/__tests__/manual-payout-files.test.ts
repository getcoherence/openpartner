/**
 * Payout details and batch files for the manual rail
 * (docs/manual-payout-files.md):
 *
 *   - partners, admins and scoped keys save payout details, sealed at
 *     rest, and every change emails the partner a masked notice;
 *   - a run's pending manual payouts sort into PayPal and Wise files, or
 *     say why they're in neither;
 *   - the files match the formats PayPal and Wise document;
 *   - country-blocked partners and confirmed sanctions matches stay out of
 *     every file, while a pending review stays in with its warning;
 *   - bulk confirm marks what went out and reports the rest.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_manual_payout_files_admin_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
// No sanctions screening: every partner would otherwise read as pending.
// Set (not deleted) so dotenv doesn't fill it back in from a local .env.
process.env.CSL_API_KEY = '';

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { __setMailerForTests } = await import('../mailer.js');
const profiles = await import('../payout-profile.js');
const files = await import('../manual-payout-files.js');

const T = DEFAULT_TENANT_ID;
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TABLES_TO_CLEAN = [TABLES.Payout, TABLES.ApiKey, TABLES.PartnerPayoutProfile, TABLES.Partner];
const partnerIds: string[] = [];

interface Sent {
  to: string;
  subject: string;
  text: string;
}
const sent: Sent[] = [];

const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
  post: (path: string, body: object) => request(app).post(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body),
  put: (path: string, body: object) => request(app).put(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body),
};
const as = (key: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${key}`),
  put: (path: string, body: object) => request(app).put(path).set('Authorization', `Bearer ${key}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${key}`),
});

async function partner(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: T,
    name,
    email: `${name.toLowerCase()}-${id.toLowerCase()}@partner.test`,
    activatedAt: new Date(),
    ...extra,
  });
  partnerIds.push(id);
  return id;
}

async function payout(partnerId: string, amount: string, currency: string, runId: string, status = 'pending'): Promise<string> {
  const id = ulid();
  await db(TABLES.Payout).insert({
    id,
    tenantId: T,
    partnerId,
    amount,
    currency,
    method: 'manual',
    status,
    metadata: { runId, commissionCount: 1 },
    completedAt: status === 'paid' ? new Date() : null,
  });
  return id;
}

async function save(partnerId: string, details: unknown): Promise<void> {
  const parsed = profiles.parsePayoutDetails(details);
  if (!parsed.ok) throw new Error(`bad fixture: ${JSON.stringify(parsed.error)}`);
  await profiles.savePayoutProfile(db, T, partnerId, parsed.details, 'partner');
}

/** A CSV with a header row, as objects. The fixtures hold no commas. */
function parseCsv(body: string): Array<Record<string, string>> {
  const [header, ...rows] = body.trimEnd().split('\r\n');
  const cols = header!.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i]!, v])));
}

async function cleanup(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  if (partnerIds.length) {
    await db(TABLES.LocationDeclaration).whereIn('subjectId', partnerIds).del();
    await db(TABLES.SanctionsScreening).whereIn('subjectId', partnerIds).del();
  }
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  __setMailerForTests({
    async send(_ctx, msg) {
      sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    },
  });
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  sent.length = 0;
});

afterEach(() => {
  process.env.OPENPARTNER_TENANCY = 'single';
});

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

// ---------------------------------------------------------------------------
// Validation and formats (no database)
// ---------------------------------------------------------------------------

describe('payout details validation', () => {
  it('checks IBAN and ABA checksums', () => {
    expect(profiles.isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(profiles.isValidIban('GB82WEST12345698765433')).toBe(false);
    expect(profiles.isValidAbaRouting('011000015')).toBe(true);
    expect(profiles.isValidAbaRouting('011000016')).toBe(false);
  });

  it('normalises an IBAN and keeps the method', () => {
    const r = profiles.parsePayoutDetails({
      method: 'bank',
      accountHolderName: 'Ada Lovelace',
      country: 'de',
      currency: 'eur',
      iban: 'de89 3704 0044 0532 0130 00',
    });
    expect(r).toMatchObject({ ok: true, details: { method: 'bank', country: 'DE', currency: 'EUR', iban: 'DE89370400440532013000' } });
  });

  it('asks for what each currency’s route needs', () => {
    const fields = (body: Record<string, unknown>) => {
      const r = profiles.parsePayoutDetails({ method: 'bank', accountHolderName: 'A B', ...body });
      return r.ok ? [] : Object.keys(r.error.fieldErrors).sort();
    };
    expect(fields({ country: 'GB', currency: 'GBP', accountNumber: '31926819' })).toEqual(['sortCode']);
    expect(fields({ country: 'US', currency: 'USD', accountNumber: '123456789' })).toEqual(['accountType', 'address', 'routingNumber']);
    expect(fields({ country: 'IN', currency: 'INR', accountNumber: '1234567890' })).toEqual(['ifsc']);
    expect(fields({ country: 'JP', currency: 'JPY', accountNumber: '1234567' })).toEqual(['address', 'bic']);
    expect(fields({ country: 'FR', currency: 'EUR', iban: 'GB82WEST12345698765432' })).toEqual(['iban']);
    expect(fields({ country: 'GB', currency: 'GBP' })).toEqual(['iban']);
  });

  it('asks for the address and state Wise needs (finding: US state)', () => {
    const errors = (body: Record<string, unknown>): Record<string, string[] | undefined> => {
      const r = profiles.parsePayoutDetails({ method: 'bank', accountHolderName: 'A B', ...body });
      return r.ok ? {} : r.error.fieldErrors;
    };
    const usd = { country: 'US', currency: 'USD', accountNumber: '123456789', routingNumber: '011000015', accountType: 'checking' };
    // US, Canadian and Brazilian addresses need their state or province.
    expect(errors({ ...usd, address: { line1: '1 Main St', city: 'Boston', country: 'US' } })).toEqual({
      address: ['an address in US needs its state or province'],
    });
    expect(errors({ ...usd, address: { line1: '1 Main St', city: 'Boston', state: 'MA', country: 'US' } })).toEqual({});
    expect(
      errors({ country: 'CA', currency: 'CAD', accountNumber: '1234567', bic: 'ROYCCAT2', address: { line1: '1 Bay St', city: 'Toronto', country: 'CA' } }),
    ).toEqual({ address: ['an address in CA needs its state or province'] });
    // Elsewhere the state stays optional.
    expect(
      errors({ country: 'GB', currency: 'GBP', iban: 'GB82WEST12345698765432', address: { line1: '1 High St', city: 'London', country: 'GB' } }),
    ).toEqual({});
    // An account in USD, PHP, THB or TRY needs the address, whatever the route.
    expect(errors({ country: 'PH', currency: 'PHP', accountNumber: '1234567', bic: 'BOPIPHMM' }).address).toEqual(
      expect.arrayContaining(['a PHP account needs the holder’s address']),
    );
  });

  it('refuses names a spreadsheet would run as a formula', () => {
    const r = profiles.parsePayoutDetails({
      method: 'bank',
      accountHolderName: '=HYPERLINK("https://x.test")',
      country: 'GB',
      currency: 'GBP',
      iban: 'GB82WEST12345698765432',
    });
    expect(r.ok).toBe(false);
    expect(profiles.parsePayoutDetails({ method: 'paypal', email: '-x@pay.test' }).ok).toBe(false);
  });

  it('never echoes an account number in a validation error', () => {
    const r = profiles.parsePayoutDetails({
      method: 'bank',
      accountHolderName: 'A B',
      country: 'GB',
      currency: 'GBP',
      iban: 'GB82WEST12345698765433',
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('98765433');
  });

  it('masks every method in summaries', () => {
    expect(profiles.summarizeDetails({ method: 'paypal', email: 'jane@pay.test' })).toBe('PayPal j•••@pay.test');
    const bank = profiles.parsePayoutDetails({
      method: 'bank',
      accountHolderName: 'A B',
      country: 'GB',
      currency: 'GBP',
      iban: 'GB82WEST12345698765432',
    });
    expect(bank.ok && profiles.summarizeDetails(bank.details)).toBe('Bank IBAN GB •••• 5432 (GBP)');
    expect(profiles.summarizeDetails({ method: 'upi', vpa: 'priya@okaxis' })).toBe('UPI p•••@okaxis');
  });
});

describe('PayPal amounts', () => {
  it('uses a decimal comma for EUR and BRL, whole units for HUF, JPY and TWD', () => {
    expect(files.paypalAmount('125.5', 'USD')).toBe('125.50');
    expect(files.paypalAmount('1234.50', 'EUR')).toBe('1234,50');
    expect(files.paypalAmount('10.00', 'BRL')).toBe('10,00');
    expect(files.paypalAmount('1000.00', 'JPY')).toBe('1000');
    expect(files.paypalAmount('2500.60', 'HUF')).toBe('2501');
  });
});

// ---------------------------------------------------------------------------
// Payout details API
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('payout details API', () => {
  it('a partner saves their own; stored sealed, read back in full, masked in the notice', async () => {
    const id = await partner('Jane');
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: id })).plaintext;
    const res = await as(key).put(`/partners/${id}/payout-profile`, { method: 'paypal', email: 'Jane.Pay@Pay.test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profile: { method: 'paypal', details: { method: 'paypal', email: 'jane.pay@pay.test' }, summary: 'PayPal j•••@pay.test', updatedBy: 'partner' },
      paidVia: 'manual',
      rail: 'auto',
    });

    const row = await db(TABLES.PartnerPayoutProfile).where({ partnerId: id }).first();
    expect(row.details).not.toContain('jane.pay');
    expect(row.method).toBe('paypal');

    const got = await as(key).get(`/partners/${id}/payout-profile`);
    expect(got.body.profile.details.email).toBe('jane.pay@pay.test');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toMatch(/^jane-/);
    expect(sent[0]!.subject).toMatch(/were changed/);
    expect(sent[0]!.text).toContain('PayPal j•••@pay.test');
    expect(sent[0]!.text).not.toContain('jane.pay@pay.test');
  });

  it('answers a bad body with field names, never values', async () => {
    const id = await partner('Bad');
    const res = await admin.put(`/partners/${id}/payout-profile`, {
      method: 'bank',
      accountHolderName: 'A B',
      country: 'GB',
      currency: 'GBP',
      accountNumber: '31926819',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(res.body.detail.fieldErrors.sortCode).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('31926819');
    expect(await db(TABLES.PartnerPayoutProfile).where({ partnerId: id })).toHaveLength(0);
  });

  it("reports the brand's rail, so the portal asks for these details instead of Stripe", async () => {
    const id = await partner('Rail', { stripeConnectAccountId: 'acct_rail_test' });
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: id })).plaintext;
    try {
      expect((await as(key).get(`/partners/${id}/payout-profile`)).body).toMatchObject({ paidVia: 'stripe_connect', rail: 'auto' });
      await db(TABLES.Tenant).where({ id: T }).update({ payoutRailPreference: 'manual' });
      // Connected or not, a manual-rail brand pays from the payout details.
      expect((await as(key).get(`/partners/${id}/payout-profile`)).body).toMatchObject({ profile: null, paidVia: 'manual', rail: 'manual' });
    } finally {
      await db(TABLES.Tenant).where({ id: T }).update({ payoutRailPreference: null });
    }
  });

  it('keeps a partner key to its own partner', async () => {
    const own = await partner('Own');
    const other = await partner('Other');
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: own })).plaintext;
    expect((await as(key).get(`/partners/${other}/payout-profile`)).status).toBe(403);
    expect((await as(key).put(`/partners/${other}/payout-profile`, { method: 'paypal', email: 'x@pay.test' })).status).toBe(403);
  });

  it('lets a headless brand read with payout_profiles:read and write with payout_profiles:write', async () => {
    const id = await partner('Headless', { portalAccess: false });
    const reader = (await createApiKeyRow(db, { tenantId: T, scopes: ['payout_profiles:read'] })).plaintext;
    const writer = (await createApiKeyRow(db, { tenantId: T, scopes: ['payout_profiles:write'] })).plaintext;
    const body = { method: 'upi', vpa: 'priya@okaxis', name: 'Priya' };

    const refused = await as(reader).put(`/partners/${id}/payout-profile`, body);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden_scope');
    const saved = await as(writer).put(`/partners/${id}/payout-profile`, body);
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({ method: 'upi', country: 'IN', updatedBy: 'api' });
    expect((await as(reader).get(`/partners/${id}/payout-profile`)).body.profile.details.vpa).toBe('priya@okaxis');
    // No portal access: the brand's own app tells its users, not us.
    expect(sent).toHaveLength(0);
  });

  it('removes them, and tells the partner', async () => {
    const id = await partner('Leaving');
    await admin.put(`/partners/${id}/payout-profile`, { method: 'other', instructions: 'Wire to my cooperative' });
    sent.length = 0;
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: id })).plaintext;
    expect((await as(key).delete(`/partners/${id}/payout-profile`)).status).toBe(204);
    expect((await as(key).delete(`/partners/${id}/payout-profile`)).body.error).toBe('payout_profile_not_found');
    expect((await as(key).get(`/partners/${id}/payout-profile`)).body.profile).toBeNull();
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/were removed/)]);
  });

  it('404s an unknown partner', async () => {
    expect((await admin.get('/partners/missing/payout-profile')).body.error).toBe('partner_not_found');
  });
});

// ---------------------------------------------------------------------------
// Sealing and portability
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('sealing', () => {
  it('seals a plaintext row (a SQL restore) on its first read', async () => {
    const id = await partner('Restored');
    await db(TABLES.PartnerPayoutProfile).insert({
      partnerId: id,
      tenantId: T,
      method: 'paypal',
      details: JSON.stringify({ email: 'restored@pay.test' }),
      updatedBy: 'partner',
    });
    const map = await profiles.getPayoutProfiles(db, T, [id]);
    expect(map.get(id)?.details).toEqual({ method: 'paypal', email: 'restored@pay.test' });
    const row = await db(TABLES.PartnerPayoutProfile).where({ partnerId: id }).first();
    expect(row.details).not.toContain('restored@pay.test');
  });

  it('seals every plaintext row in one sweep, whether or not anyone reads it (finding: at rest)', async () => {
    const valid = await partner('SweepValid');
    const invalid = await partner('SweepInvalid');
    const garbage = await partner('SweepGarbage');
    const already = await partner('SweepSealed');
    await db(TABLES.PartnerPayoutProfile).insert([
      { partnerId: valid, tenantId: T, method: 'paypal', details: JSON.stringify({ email: 'valid@pay.test' }), updatedBy: 'partner' },
      { partnerId: invalid, tenantId: T, method: 'paypal', details: JSON.stringify({ email: 'not-an-email' }), updatedBy: 'partner' },
      { partnerId: garbage, tenantId: T, method: 'other', details: '  {garbled', updatedBy: 'partner' },
    ]);
    await save(already, { method: 'paypal', email: 'sealed@pay.test' });
    const before = (await db(TABLES.PartnerPayoutProfile).where({ partnerId: already }).first()).details;

    expect(await profiles.sealPlaintextPayoutProfiles(db, 2)).toBe(3);
    const rows = await db(TABLES.PartnerPayoutProfile).whereIn('partnerId', [valid, invalid, garbage]);
    for (const r of rows) {
      expect(r.details).not.toMatch(/^\s*\{/);
      expect(r.details).not.toMatch(/valid@|not-an-email|garbled/);
    }
    // The valid row still opens; the others read as unreadable.
    expect((await profiles.getPayoutProfile(db, T, valid))?.details).toEqual({ method: 'paypal', email: 'valid@pay.test' });
    expect((await profiles.getPayoutProfile(db, T, invalid))?.details).toBeNull();
    // Sealed rows are left alone, and a second sweep finds nothing.
    expect((await db(TABLES.PartnerPayoutProfile).where({ partnerId: already }).first()).details).toBe(before);
    expect(await profiles.sealPlaintextPayoutProfiles(db)).toBe(0);
  });

  it('reads a row sealed under another key as unreadable, without throwing', async () => {
    const id = await partner('Elsewhere');
    await db(TABLES.PartnerPayoutProfile).insert({
      partnerId: id,
      tenantId: T,
      method: 'bank',
      country: 'GB',
      details: Buffer.alloc(64, 7).toString('base64'),
      updatedBy: 'partner',
    });
    const got = await admin.get(`/partners/${id}/payout-profile`);
    expect(got.status).toBe(200);
    expect(got.body.profile).toMatchObject({ method: 'bank', details: null, summary: null });
  });

  it('opens rows for export and seals them again on import', () => {
    const sealed = profiles.sealDetails({ method: 'paypal', email: 'x@pay.test' });
    const exported = profiles.openForExport({ partnerId: 'p', method: 'paypal', details: sealed });
    expect(exported.details).toEqual({ email: 'x@pay.test' });
    const imported = profiles.sealForImport({ partnerId: 'p', method: 'paypal', details: exported.details });
    expect(typeof imported.details).toBe('string');
    expect(imported.details).not.toContain('x@pay.test');
    expect(profiles.openDetails(imported.details as string)).toEqual({ email: 'x@pay.test' });
    // An envelope from another deployment can't be opened, so it stays as it came.
    const foreign = { partnerId: 'p', method: 'paypal', details: 'bm90LWEtcmVhbC1lbnZlbG9wZQ==' };
    expect(profiles.sealForImport(foreign)).toEqual(foreign);
  });
});

// ---------------------------------------------------------------------------
// Runs and files
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('manual payout files', () => {
  const tick = () => new Promise((r) => setTimeout(r, 3));
  const gbpLocal = (name: string, extra: Record<string, unknown> = {}) => ({
    method: 'bank',
    accountHolderName: name,
    country: 'GB',
    currency: 'GBP',
    accountNumber: '31926819',
    sortCode: '23-14-70',
    ...extra,
  });
  const address = { line1: '1 High St', city: 'London', postCode: 'E1 6AN', country: 'GB' };

  async function seedRun() {
    const runId = ulid();
    const p = {
      paypalUsd: await partner('Ana'),
      paypalEur: await partner('Ben'),
      bankGbp: await partner('Cleo'),
      usdToGbp: await partner('Dana'),
      noAddress: await partner('Eli'),
      inrAccount: await partner('Dev'),
      upi: await partner('Esha'),
      none: await partner('Finn'),
      paypalInr: await partner('Gita'),
      paid: await partner('Hal'),
      unreadable: await partner('Ivo'),
      inrSource: await partner('Jo'),
    };
    await save(p.paypalUsd, { method: 'paypal', email: 'ana@pay.test' });
    await save(p.paypalEur, { method: 'paypal', email: 'ben@pay.test' });
    await save(p.bankGbp, gbpLocal('Cleo Smith', { email: 'cleo.bank@partner.test' }));
    await save(p.usdToGbp, gbpLocal('Dana Jones', { address }));
    await save(p.noAddress, { method: 'bank', accountHolderName: 'Eli Weber', country: 'DE', currency: 'EUR', iban: 'DE89370400440532013000' });
    await save(p.inrAccount, {
      method: 'bank',
      accountHolderName: 'Dev Patel',
      country: 'IN',
      currency: 'INR',
      accountNumber: '50100123456789',
      ifsc: 'hdfc0001234',
    });
    await save(p.upi, { method: 'upi', vpa: 'esha@okaxis' });
    await save(p.paypalInr, { method: 'paypal', email: 'gita@pay.test' });
    await save(p.paid, { method: 'paypal', email: 'hal@pay.test' });
    await save(p.inrSource, gbpLocal('Jo Brown'));
    await db(TABLES.PartnerPayoutProfile).insert({
      partnerId: p.unreadable,
      tenantId: T,
      method: 'paypal',
      details: Buffer.alloc(64, 9).toString('base64'),
      updatedBy: 'partner',
    });
    const ids = {
      paypalUsd: await payout(p.paypalUsd, '125.50', 'USD', runId),
      paypalEur: await payout(p.paypalEur, '1234.50', 'EUR', runId),
      bankGbp: await payout(p.bankGbp, '40.00', 'GBP', runId),
      usdToGbp: await payout(p.usdToGbp, '75.00', 'USD', runId),
      noAddress: await payout(p.noAddress, '20.00', 'USD', runId),
      inrAccount: await payout(p.inrAccount, '30.00', 'USD', runId),
      upi: await payout(p.upi, '10.00', 'USD', runId),
      none: await payout(p.none, '5.00', 'USD', runId),
      paypalInr: await payout(p.paypalInr, '500.00', 'INR', runId),
      paid: await payout(p.paid, '9.00', 'USD', runId, 'paid'),
      unreadable: await payout(p.unreadable, '7.00', 'USD', runId),
      inrSource: await payout(p.inrSource, '100.00', 'INR', runId),
    };
    return { runId, p, ids };
  }

  async function allPayouts(runId: string, limit = 500): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const res = await admin.get(`/payouts/runs/${runId}/payouts?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      out.push(...res.body.payouts);
      cursor = res.body.nextCursor;
    } while (cursor);
    return out;
  }

  const makeFile = (runId: string, provider: string, currency: string) =>
    admin.post(`/payouts/runs/${runId}/exports`, { provider, currency });

  it('summarises what each new file would take, and why the rest are in none', async () => {
    const { runId, ids } = await seedRun();

    const runs = await admin.get('/payouts/runs');
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual({
      runs: [expect.objectContaining({ runId, pendingCount: 11 })],
      nextCursor: null,
    });
    expect(runs.body.runs[0].pendingTotals).toContainEqual({ currency: 'USD', amount: '272.50' });

    const run = await admin.get(`/payouts/runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ runId, pendingCount: 11, exports: [] });
    expect(run.body.ready).toEqual([
      { provider: 'paypal', currency: 'EUR', count: 1, total: '1234.50' },
      { provider: 'paypal', currency: 'USD', count: 1, total: '125.50' },
      { provider: 'wise', currency: 'GBP', count: 1, total: '40.00' },
      { provider: 'wise', currency: 'USD', count: 1, total: '75.00' },
    ]);
    expect(Object.fromEntries((run.body.excluded as Array<{ reason: string; count: number }>).map((e) => [e.reason, e.count]))).toEqual({
      // INR to PayPal; USD into an INR account (no purpose of payment); INR out of Wise.
      currency_not_supported: 3,
      details_incomplete: 1,
      pay_individually: 1,
      no_payout_details: 1,
      details_unreadable: 1,
    });

    const list = await allPayouts(runId, 5);
    const by = Object.fromEntries(list.map((x) => [x.payoutId, x]));
    expect(list).toHaveLength(11);
    expect(by[ids.paid]).toBeUndefined();
    expect(by[ids.paypalUsd]).toMatchObject({ ready: 'paypal', export: null, excluded: null, doNotPay: null });
    expect(by[ids.noAddress]).toMatchObject({ ready: null, excluded: 'details_incomplete' });
    expect(by[ids.inrAccount]).toMatchObject({ excluded: 'currency_not_supported' });
    expect(by[ids.inrSource]).toMatchObject({ excluded: 'currency_not_supported' });
    expect(by[ids.upi]).toMatchObject({ excluded: 'pay_individually', destination: { method: 'upi', summary: 'UPI e•••@okaxis' } });
    expect(by[ids.unreadable]).toMatchObject({ excluded: 'details_unreadable', destination: { summary: null } });
    // Masked everywhere on these pages: no full email or account number.
    expect(JSON.stringify(list)).not.toContain('ana@pay.test');
    expect(JSON.stringify(list)).not.toContain('31926819');

    expect((await admin.get(`/payouts/runs/${runId}/payouts?cursor=%25%25`)).body.error).toBe('invalid_cursor');
    expect((await admin.get('/payouts/runs/missing')).body.error).toBe('run_not_found');
    expect((await admin.get('/payouts/runs/missing/payouts')).body.error).toBe('run_not_found');
  });

  it('reads a run in chunks without changing the answer', async () => {
    const { runId } = await seedRun();
    const whole = (await admin.get(`/payouts/runs/${runId}`)).body;
    const saved = files.CHUNK.size;
    files.CHUNK.size = 2;
    try {
      expect((await admin.get(`/payouts/runs/${runId}`)).body).toEqual(whole);
      expect(await allPayouts(runId)).toHaveLength(11);
      const file = await makeFile(runId, 'wise', 'USD');
      expect(file.body.export.count).toBe(1);
    } finally {
      files.CHUNK.size = saved;
    }
  });

  it('makes a PayPal file: no header, ten columns, one currency', async () => {
    const { runId, ids } = await seedRun();
    const usd = await makeFile(runId, 'paypal', 'usd');
    expect(usd.status).toBe(201);
    expect(usd.headers['cache-control']).toBe('no-store');
    const exportId = usd.body.export.exportId as string;
    expect(usd.body.export).toMatchObject({ runId, provider: 'paypal', currency: 'USD', payoutIds: [ids.paypalUsd], count: 1, total: '125.50', createdBy: 'api' });
    expect(usd.body.filename).toBe(`paypal-payouts-${exportId}-USD.csv`);
    expect(usd.body.csv).toMatch(
      new RegExp(`^ana@pay\\.test,125\\.50,USD,${ids.paypalUsd},Commission payout( from [^,\\r\\n]+)?,PAYPAL,,,,SERVICES\\r\\n$`),
    );

    const eur = await makeFile(runId, 'paypal', 'EUR');
    expect(eur.body.csv.startsWith(`ben@pay.test,"1234,50",EUR,${ids.paypalEur},`)).toBe(true);

    // Nothing left for PayPal USD: the one payout is in its file.
    expect((await makeFile(runId, 'paypal', 'USD')).body.error).toBe('nothing_to_export');
    // Downloading again gives the same file.
    const again = await admin.get(`/payouts/exports/${exportId}.csv`);
    expect(again.status).toBe(200);
    expect(again.headers['content-type']).toMatch(/^text\/csv/);
    expect(again.headers['content-disposition']).toBe(`attachment; filename="paypal-payouts-${exportId}-USD.csv"`);
    expect(again.text).toBe(usd.body.csv);
  });

  it('makes a Wise file: one source currency, targets and addresses per row', async () => {
    const { runId, ids } = await seedRun();
    const gbp = await makeFile(runId, 'wise', 'GBP');
    // Pinned: Wise rejects a renamed column, so a change here is deliberate
    // (docs/manual-payout-files.md "Wise columns").
    expect(gbp.body.csv.split('\r\n')[0]).toBe(
      'name,recipientEmail,paymentReference,recipientType,amountCurrency,amount,sourceCurrency,targetCurrency,IBAN,BIC,accountNumber,sortCode,abartn,accountType,ifscCode,addressCountryCode,addressCity,addressFirstLine,addressPostCode,addressState',
    );
    expect(parseCsv(gbp.body.csv)).toEqual([
      expect.objectContaining({
        name: 'Cleo Smith',
        recipientEmail: 'cleo.bank@partner.test',
        paymentReference: ids.bankGbp.slice(-10),
        recipientType: 'person',
        amountCurrency: 'target',
        amount: '40.00',
        sourceCurrency: 'GBP',
        targetCurrency: 'GBP',
        IBAN: '',
        accountNumber: '31926819',
        sortCode: '231470',
      }),
    ]);

    const usd = await makeFile(runId, 'wise', 'USD');
    expect(usd.body.export.payoutIds).toEqual([ids.usdToGbp]);
    expect(parseCsv(usd.body.csv)).toEqual([
      expect.objectContaining({
        name: 'Dana Jones',
        // USD paid into a GBP account: the amount is what the brand sends.
        amountCurrency: 'source',
        amount: '75.00',
        sourceCurrency: 'USD',
        targetCurrency: 'GBP',
        // Wise needs the address for anything sent in USD.
        addressFirstLine: '1 High St',
        addressCity: 'London',
        addressCountryCode: 'GB',
      }),
    ]);
  });

  it('confirms a file’s own payouts, never what a fresh look would add (finding: Mark sent)', async () => {
    const { runId, ids } = await seedRun();
    const file = await makeFile(runId, 'paypal', 'USD');
    const exportId = file.body.export.exportId as string;
    // While the brand uploads, another partner adds PayPal details and is
    // now ready for a PayPal USD file too.
    const kim = await partner('Kim');
    await save(kim, { method: 'paypal', email: 'kim@pay.test' });
    const kimPayout = await payout(kim, '60.00', 'USD', runId);

    const run = (await admin.get(`/payouts/runs/${runId}`)).body;
    expect(run.exports).toEqual([
      expect.objectContaining({ exportId, provider: 'paypal', currency: 'USD', pendingCount: 1, pendingTotal: '125.50', changedCount: 0 }),
    ]);
    expect(run.ready).toContainEqual({ provider: 'paypal', currency: 'USD', count: 1, total: '60.00' });

    const confirmed = await admin.post(`/payouts/exports/${exportId}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmed.map((x: { id: string }) => x.id)).toEqual([ids.paypalUsd]);
    expect((await db(TABLES.Payout).where({ id: kimPayout }).first()).status).toBe('pending');
    // The file holds nothing pending now.
    expect((await admin.post(`/payouts/exports/${exportId}/confirm`, {})).body.error).toBe('export_not_found');
    expect((await admin.get(`/payouts/exports/${exportId}.csv`)).body.error).toBe('file_not_found');
  });

  it('keeps an exported payout in its file when the partner switches method (finding: pinning)', async () => {
    const { runId, ids, p } = await seedRun();
    const paypalFile = await makeFile(runId, 'paypal', 'USD');
    const exportId = paypalFile.body.export.exportId as string;
    await tick();
    // After the PayPal file was uploaded, Ana switches to a bank account
    // that the Wise USD file could pay.
    await save(p.paypalUsd, gbpLocal('Ana Silva', { address }));

    const list = await allPayouts(runId);
    expect(list.find((x) => x.payoutId === ids.paypalUsd)).toMatchObject({
      ready: null,
      export: { exportId, provider: 'paypal', destinationChanged: true },
    });
    const run = (await admin.get(`/payouts/runs/${runId}`)).body;
    expect(run.exports[0]).toMatchObject({ exportId, changedCount: 1 });

    // She is in no Wise file: only Dana is.
    const wise = await makeFile(runId, 'wise', 'USD');
    expect(wise.body.export.payoutIds).toEqual([ids.usdToGbp]);
    // A new download of the PayPal file can't carry her any more.
    expect((await admin.get(`/payouts/exports/${exportId}.csv`)).body.error).toBe('file_not_found');
    // But the file that went out held her, so confirming it confirms her.
    const confirmed = await admin.post(`/payouts/exports/${exportId}/confirm`, {});
    expect(confirmed.body.confirmed.map((x: { id: string }) => x.id)).toEqual([ids.paypalUsd]);
  });

  it('takes each new file from payouts no file holds, so files never overlap (finding: parts)', async () => {
    const runId = ulid();
    const late = await partner('Late');
    const latePayout = await payout(late, '1.00', 'EUR', runId);
    await tick();
    const early: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await partner(`Many${i}`);
      await save(id, { method: 'bank', accountHolderName: `Many ${i}`, country: 'DE', currency: 'EUR', iban: 'DE89370400440532013000' });
      early.push(await payout(id, '1.00', 'EUR', runId));
      await tick();
    }
    const saved = files.MAX_ROWS.wise;
    files.MAX_ROWS.wise = 2;
    try {
      const first = (await makeFile(runId, 'wise', 'EUR')).body.export;
      expect(first.payoutIds).toEqual(early.slice(0, 2));
      // A partner earlier in id order adds details after the first file.
      await save(late, { method: 'bank', accountHolderName: 'Late One', country: 'DE', currency: 'EUR', iban: 'DE89370400440532013000' });
      const second = (await makeFile(runId, 'wise', 'EUR')).body.export;
      expect(second.payoutIds).toEqual([latePayout, early[2]]);
      expect((await makeFile(runId, 'wise', 'EUR')).body.error).toBe('nothing_to_export');
    } finally {
      files.MAX_ROWS.wise = saved;
    }
  });

  it('discards a file that never went out, so a new file can take its payouts', async () => {
    const { runId, ids } = await seedRun();
    const exportId = (await makeFile(runId, 'paypal', 'USD')).body.export.exportId as string;
    const discarded = await admin.post(`/payouts/exports/${exportId}/discard`, {});
    expect(discarded.body).toEqual({ released: 1 });
    expect((await admin.post(`/payouts/exports/${exportId}/discard`, {})).body.error).toBe('export_not_found');
    expect((await makeFile(runId, 'paypal', 'USD')).body.export.payoutIds).toEqual([ids.paypalUsd]);
  });

  it('keeps every file route admin-only', async () => {
    const { runId, p } = await seedRun();
    const exportId = (await makeFile(runId, 'paypal', 'USD')).body.export.exportId as string;
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: p.paypalUsd })).plaintext;
    const partnerReq = (method: 'get' | 'post', path: string) =>
      request(app)[method](path).set('Authorization', `Bearer ${key}`).send({ provider: 'paypal', currency: 'EUR' });
    for (const [method, path] of [
      ['get', '/payouts/runs'],
      ['get', `/payouts/runs/${runId}`],
      ['get', `/payouts/runs/${runId}/payouts`],
      ['post', `/payouts/runs/${runId}/exports`],
      ['get', `/payouts/exports/${exportId}.csv`],
      ['post', `/payouts/exports/${exportId}/confirm`],
      ['post', `/payouts/exports/${exportId}/discard`],
    ] as const) {
      expect((await partnerReq(method, path)).status, `${method} ${path}`).toBe(403);
    }
  });

  it('confirms in bulk and reports what it couldn’t', async () => {
    const { runId, ids } = await seedRun();
    const res = await admin.post('/payouts/confirm', { payoutIds: [ids.upi, ids.none, ids.paid, 'missing'] });
    expect(res.status).toBe(200);
    expect((res.body.confirmed as Array<{ id: string }>).map((x) => x.id).sort()).toEqual([ids.upi, ids.none].sort());
    expect(res.body.notConfirmable).toEqual(
      expect.arrayContaining([
        { payoutId: ids.paid, error: 'not_confirmable', detail: expect.stringContaining('manual/paid') },
        { payoutId: 'missing', error: 'payout_not_found' },
      ]),
    );
    expect((await admin.post('/payouts/confirm', { payoutIds: [] })).status).toBe(400);
    expect((await admin.get(`/payouts/runs/${runId}`)).body.pendingCount).toBe(9);
  });

  it('pages the runs list (finding: run cursor)', async () => {
    const pid = await partner('Runner');
    const runIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const runId = ulid();
      runIds.push(runId);
      await payout(pid, '1.00', 'USD', runId);
      await tick();
    }
    const first = await admin.get('/payouts/runs?limit=2');
    expect(first.body.runs.map((r: { runId: string }) => r.runId)).toEqual([runIds[2], runIds[1]]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await admin.get(`/payouts/runs?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toEqual({ runs: [expect.objectContaining({ runId: runIds[0] })], nextCursor: null });
    expect((await admin.get('/payouts/runs?cursor=bm9wZQ')).body.error).toBe('invalid_cursor');
  });
});

describe.skipIf(skipIntegration)('compliance on OpenPartner Cloud', () => {
  async function seedHolds() {
    const runId = ulid();
    const declaredIran = await partner('Declared');
    const accountInRussia = await partner('Account');
    const underReview = await partner('Review');
    const confirmed = await partner('Confirmed');
    for (const id of [declaredIran, underReview, confirmed]) await save(id, { method: 'paypal', email: `${id.toLowerCase()}@pay.test` });
    await save(accountInRussia, {
      method: 'bank',
      accountHolderName: 'Ivan Petrov',
      country: 'RU',
      currency: 'RUB',
      accountNumber: '40817810099910004312',
      bic: 'SABRRUMM',
      address: { line1: '1 Tverskaya', city: 'Moscow', country: 'RU' },
    });
    await db(TABLES.LocationDeclaration).insert({
      id: ulid(),
      subjectKind: 'partner',
      subjectId: declaredIran,
      tenantId: T,
      country: 'IR',
      source: 'join',
    });
    await db(TABLES.SanctionsScreening).insert([screening(underReview, 'Review', null), screening(confirmed, 'Confirmed', 'confirmed_match')]);
    const ids = {
      declaredIran: await payout(declaredIran, '10.00', 'USD', runId),
      accountInRussia: await payout(accountInRussia, '10.00', 'USD', runId),
      underReview: await payout(underReview, '10.00', 'USD', runId),
      confirmed: await payout(confirmed, '10.00', 'USD', runId),
    };
    return { runId, ids, partners: { underReview } };
  }

  function screening(subjectId: string, name: string, decision: string | null) {
    return {
      id: ulid(),
      subjectKind: 'partner',
      subjectId,
      tenantId: T,
      screenedName: name,
      result: 'possible_match',
      matches: JSON.stringify([]),
      trigger: 'first_payable',
      decision,
    };
  }

  it('keeps blocked countries and confirmed matches out of every file; a review stays in, flagged', async () => {
    const { runId, ids } = await seedHolds();
    process.env.OPENPARTNER_TENANCY = 'multi';
    const run = await files.getManualRun(db, T, runId);
    expect(Object.fromEntries(run!.excluded.map((e) => [e.reason, e.count]))).toEqual({ country_not_supported: 2, screening_confirmed: 1 });
    expect(run!.ready).toEqual([{ provider: 'paypal', currency: 'USD', count: 1, total: '10.00' }]);
    const page = await files.listManualRunPayouts(db, T, runId, { limit: 100 });
    const by = new Map((page as { payouts: Array<{ payoutId: string }> }).payouts.map((x) => [x.payoutId, x]));
    expect(by.get(ids.declaredIran)).toMatchObject({ excluded: 'country_not_supported', doNotPay: 'country_not_supported', complianceWarning: 'country_not_supported' });
    expect(by.get(ids.accountInRussia)).toMatchObject({ excluded: 'country_not_supported', doNotPay: 'country_not_supported', complianceWarning: null });
    expect(by.get(ids.underReview)).toMatchObject({ ready: 'paypal', doNotPay: null, complianceWarning: 'screening_review' });
    expect(by.get(ids.confirmed)).toMatchObject({ excluded: 'screening_confirmed', doNotPay: 'screening_confirmed' });

    const file = await files.createManualExport(db, T, runId, 'paypal', 'USD', 'admin');
    expect(file?.export.payoutIds).toEqual([ids.underReview]);

    // A self-host applies its own rules: nothing is held back there.
    process.env.OPENPARTNER_TENANCY = 'single';
    const selfhost = await files.getManualRun(db, T, runId);
    expect(selfhost!.excluded).toEqual([]);
  });

  it('refuses to confirm a do-not-pay payout on every path (finding: confirm)', async () => {
    const { runId, ids, partners } = await seedHolds();
    process.env.OPENPARTNER_TENANCY = 'multi';
    const file = await files.createManualExport(db, T, runId, 'paypal', 'USD', 'admin');
    // After the file is made, the review becomes a confirmed match.
    await db(TABLES.SanctionsScreening).insert(screening(partners.underReview, 'Review', 'confirmed_match'));

    const run = await files.getManualRun(db, T, runId);
    expect(run!.exports[0]).toMatchObject({ exportId: file!.export.exportId, doNotPayCount: 1 });
    const viaFile = await files.confirmManualExport(db, T, file!.export.exportId);
    expect(viaFile!.confirmed).toEqual([]);
    expect(viaFile!.notConfirmable).toEqual([
      { payoutId: ids.underReview, error: 'not_confirmable', reason: 'screening_confirmed', detail: expect.stringContaining('do not pay') },
    ]);
    // Re-downloading leaves it out, so the file holds nothing to pay.
    expect(await files.rebuildManualExportFile(db, T, file!.export.exportId)).toBeNull();

    const bulk = await files.confirmManualPayouts(db, T, [ids.declaredIran, ids.accountInRussia, ids.confirmed]);
    expect(bulk.confirmed).toEqual([]);
    expect(bulk.notConfirmable.map((n) => [n.payoutId, n.reason])).toEqual([
      [ids.declaredIran, 'country_not_supported'],
      [ids.accountInRussia, 'country_not_supported'],
      [ids.confirmed, 'screening_confirmed'],
    ]);
    // The single-payout route asks the same question.
    const row = await db(TABLES.Payout).where({ id: ids.confirmed }).first();
    expect(await files.doNotPayReason(db, T, row)).toBe('screening_confirmed');
    expect(await db(TABLES.Payout).where({ status: 'paid' })).toHaveLength(0);
  });
});
