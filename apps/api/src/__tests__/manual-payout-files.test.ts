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
  async function seedRun() {
    const runId = ulid();
    const p = {
      paypalUsd: await partner('Ana'),
      paypalEur: await partner('Ben'),
      bankGbp: await partner('Cleo'),
      bankInr: await partner('Dev'),
      upi: await partner('Esha'),
      none: await partner('Finn'),
      paypalInr: await partner('Gita'),
      paid: await partner('Hal'),
      unreadable: await partner('Ivo'),
    };
    await save(p.paypalUsd, { method: 'paypal', email: 'ana@pay.test' });
    await save(p.paypalEur, { method: 'paypal', email: 'ben@pay.test' });
    await save(p.bankGbp, {
      method: 'bank',
      accountHolderName: 'Cleo Smith',
      country: 'GB',
      currency: 'GBP',
      accountNumber: '31926819',
      sortCode: '23-14-70',
      email: 'cleo.bank@partner.test',
    });
    await save(p.bankInr, {
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
      bankInr: await payout(p.bankInr, '75.00', 'USD', runId),
      upi: await payout(p.upi, '10.00', 'USD', runId),
      none: await payout(p.none, '5.00', 'USD', runId),
      paypalInr: await payout(p.paypalInr, '500.00', 'INR', runId),
      paid: await payout(p.paid, '9.00', 'USD', runId, 'paid'),
      unreadable: await payout(p.unreadable, '7.00', 'USD', runId),
    };
    return { runId, p, ids };
  }

  it('sorts each pending payout into a file, or says why not', async () => {
    const { runId, ids } = await seedRun();

    const runs = await admin.get('/payouts/runs');
    expect(runs.status).toBe(200);
    expect(runs.body.runs).toEqual([
      expect.objectContaining({ runId, payoutCount: 9, pendingCount: 8 }),
    ]);
    expect(runs.body.runs[0].pendingTotals).toContainEqual({ currency: 'USD', amount: '222.50' });

    const res = await admin.get(`/payouts/runs/${runId}`);
    expect(res.status).toBe(200);
    const by = Object.fromEntries((res.body.payouts as Array<{ payoutId: string }>).map((x) => [x.payoutId, x])) as Record<string, Record<string, unknown>>;
    expect(by[ids.paypalUsd]).toMatchObject({ file: { provider: 'paypal', currency: 'USD', part: 1, reference: ids.paypalUsd }, excluded: null });
    expect(by[ids.paypalEur]).toMatchObject({ file: { provider: 'paypal', currency: 'EUR' } });
    expect(by[ids.bankGbp]).toMatchObject({ file: { provider: 'wise', currency: 'GBP', reference: ids.bankGbp.slice(-10) } });
    expect(by[ids.bankInr]).toMatchObject({ file: { provider: 'wise', currency: 'USD' } });
    expect(by[ids.upi]).toMatchObject({ file: null, excluded: 'pay_individually', destination: { method: 'upi', summary: 'UPI e•••@okaxis' } });
    expect(by[ids.none]).toMatchObject({ file: null, excluded: 'no_payout_details', destination: null });
    expect(by[ids.paypalInr]).toMatchObject({ file: null, excluded: 'currency_not_supported' });
    expect(by[ids.paid]).toMatchObject({ status: 'paid', file: null, excluded: null });
    expect(by[ids.unreadable]).toMatchObject({ file: null, excluded: 'details_unreadable', destination: { summary: null } });
    // Masked everywhere on this page: no full email or account number.
    expect(JSON.stringify(res.body)).not.toContain('ana@pay.test');
    expect(JSON.stringify(res.body)).not.toContain('31926819');
    expect(res.body.files).toEqual(
      expect.arrayContaining([
        { provider: 'paypal', currency: 'USD', part: 1, count: 1, total: '125.50' },
        { provider: 'paypal', currency: 'EUR', part: 1, count: 1, total: '1234.50' },
        { provider: 'wise', currency: 'GBP', part: 1, count: 1, total: '40.00' },
        { provider: 'wise', currency: 'USD', part: 1, count: 1, total: '75.00' },
      ]),
    );
    expect(res.body.files).toHaveLength(4);
  });

  it('writes the PayPal Payouts format: no header, ten columns, one currency', async () => {
    const { runId, ids } = await seedRun();
    const usd = await admin.get(`/payouts/runs/${runId}/paypal.csv?currency=usd`);
    expect(usd.status).toBe(200);
    expect(usd.headers['content-type']).toMatch(/^text\/csv/);
    expect(usd.headers['cache-control']).toBe('no-store');
    expect(usd.headers['content-disposition']).toBe(`attachment; filename="paypal-payouts-${runId}-USD.csv"`);
    expect(usd.text).toMatch(
      new RegExp(`^ana@pay\\.test,125\\.50,USD,${ids.paypalUsd},Commission payout( from [^,\\r\\n]+)?,PAYPAL,,,,SERVICES\\r\\n$`),
    );

    const eur = await admin.get(`/payouts/runs/${runId}/paypal.csv?currency=EUR`);
    expect(eur.text.startsWith(`ben@pay.test,"1234,50",EUR,${ids.paypalEur},`)).toBe(true);
    expect(eur.text.trimEnd().split('\r\n')).toHaveLength(1);
  });

  it('writes the Wise bank-account template: one source currency, targets per row', async () => {
    const { runId, ids, p } = await seedRun();
    const gbp = await admin.get(`/payouts/runs/${runId}/wise.csv?currency=GBP`);
    expect(gbp.status).toBe(200);
    // Pinned: Wise rejects a renamed column, so a change here is deliberate
    // (docs/manual-payout-files.md "Wise columns").
    expect(gbp.text.split('\r\n')[0]).toBe(
      'name,recipientEmail,paymentReference,recipientType,amountCurrency,amount,sourceCurrency,targetCurrency,IBAN,BIC,accountNumber,sortCode,abartn,accountType,ifscCode,addressCountryCode,addressCity,addressFirstLine,addressPostCode,addressState',
    );
    expect(parseCsv(gbp.text)).toEqual([
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
        ifscCode: '',
      }),
    ]);

    const usd = await admin.get(`/payouts/runs/${runId}/wise.csv?currency=USD`);
    const partnerEmail = (await db(TABLES.Partner).where({ id: p.bankInr }).first()).email as string;
    expect(parseCsv(usd.text)).toEqual([
      expect.objectContaining({
        name: 'Dev Patel',
        // No account email given: Wise notifies the partner's own address.
        recipientEmail: partnerEmail,
        // USD paid into an INR account: the amount is what the brand sends.
        amountCurrency: 'source',
        amount: '75.00',
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        accountNumber: '50100123456789',
        ifscCode: 'HDFC0001234',
        sortCode: '',
      }),
    ]);
  });

  it('stamps what was downloaded, and refuses files that don’t exist', async () => {
    const { runId, ids } = await seedRun();
    await admin.get(`/payouts/runs/${runId}/paypal.csv?currency=USD`);
    const run = await admin.get(`/payouts/runs/${runId}`);
    const usd = (run.body.payouts as Array<{ payoutId: string; lastExport: unknown }>).find((x) => x.payoutId === ids.paypalUsd);
    expect(usd?.lastExport).toMatchObject({ provider: 'paypal', at: expect.any(String) });
    const eur = (run.body.payouts as Array<{ payoutId: string; lastExport: unknown }>).find((x) => x.payoutId === ids.paypalEur);
    expect(eur?.lastExport).toBeNull();

    expect((await admin.get(`/payouts/runs/${runId}/wise.csv?currency=EUR`)).body.error).toBe('file_not_found');
    expect((await admin.get(`/payouts/runs/${runId}/venmo.csv?currency=USD`)).body.error).toBe('unknown_provider');
    expect((await admin.get(`/payouts/runs/${runId}/paypal.csv?currency=dollars`)).body.error).toBe('invalid_query');
    expect((await admin.get(`/payouts/runs/missing`)).body.error).toBe('run_not_found');
  });

  it('keeps the files admin-only', async () => {
    const { runId, p } = await seedRun();
    const key = (await createApiKeyRow(db, { tenantId: T, partnerId: p.paypalUsd })).plaintext;
    expect((await as(key).get(`/payouts/runs/${runId}/paypal.csv?currency=USD`)).status).toBe(403);
    expect((await as(key).get(`/payouts/runs/${runId}`)).status).toBe(403);
    expect((await as(key).get('/payouts/runs')).status).toBe(403);
  });

  it('confirms in bulk and reports what it couldn’t', async () => {
    const { runId, ids } = await seedRun();
    const res = await admin.post('/payouts/confirm', { payoutIds: [ids.paypalUsd, ids.paypalEur, ids.paid, 'missing'] });
    expect(res.status).toBe(200);
    expect((res.body.confirmed as Array<{ id: string; status: string }>).map((x) => x.id).sort()).toEqual([ids.paypalUsd, ids.paypalEur].sort());
    expect(res.body.confirmed.every((x: { status: string; completedAt: string }) => x.status === 'paid' && x.completedAt)).toBe(true);
    expect(res.body.notConfirmable).toEqual(
      expect.arrayContaining([
        { payoutId: ids.paid, error: 'not_confirmable', detail: expect.stringContaining('manual/paid') },
        { payoutId: 'missing', error: 'payout_not_found' },
      ]),
    );
    // Confirmed payouts leave their file.
    expect((await admin.get(`/payouts/runs/${runId}/paypal.csv?currency=USD`)).status).toBe(404);
    expect((await admin.post('/payouts/confirm', { payoutIds: [] })).status).toBe(400);
  });

  it('splits a currency past one upload’s limit into parts', async () => {
    const runId = ulid();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await partner(`Many${i}`);
      await save(id, {
        method: 'bank',
        accountHolderName: `Many ${i}`,
        country: 'DE',
        currency: 'EUR',
        iban: 'DE89370400440532013000',
      });
      ids.push(await payout(id, '1.00', 'EUR', runId));
    }
    const limits = files.MAX_ROWS as Record<string, number>;
    const saved = limits.wise!;
    limits.wise = 2;
    try {
      const run = await files.getManualRun(db, T, runId);
      expect(run?.files).toEqual([
        { provider: 'wise', currency: 'EUR', part: 1, count: 2, total: '2.00' },
        { provider: 'wise', currency: 'EUR', part: 2, count: 1, total: '1.00' },
      ]);
      const second = await files.buildManualPayoutFile(db, T, runId, 'wise', 'EUR', 2);
      expect(second?.filename).toBe(`wise-payouts-${runId}-EUR-part2.csv`);
      expect(parseCsv(second!.body)).toHaveLength(1);
    } finally {
      limits.wise = saved;
    }
  });
});

describe.skipIf(skipIntegration)('compliance on OpenPartner Cloud', () => {
  it('keeps blocked countries and confirmed matches out of every file; a review stays in, flagged', async () => {
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
    const screening = (subjectId: string, decision: string | null) => ({
      id: ulid(),
      subjectKind: 'partner',
      subjectId,
      tenantId: T,
      screenedName: subjectId === underReview ? 'Review' : 'Confirmed',
      result: 'possible_match',
      matches: JSON.stringify([]),
      trigger: 'first_payable',
      decision,
    });
    await db(TABLES.SanctionsScreening).insert([screening(underReview, null), screening(confirmed, 'confirmed_match')]);
    const ids = {
      declaredIran: await payout(declaredIran, '10.00', 'USD', runId),
      accountInRussia: await payout(accountInRussia, '10.00', 'USD', runId),
      underReview: await payout(underReview, '10.00', 'USD', runId),
      confirmed: await payout(confirmed, '10.00', 'USD', runId),
    };

    process.env.OPENPARTNER_TENANCY = 'multi';
    const run = await files.getManualRun(db, T, runId);
    const by = new Map(run!.payouts.map((x) => [x.payoutId, x]));
    expect(by.get(ids.declaredIran)).toMatchObject({ file: null, excluded: 'country_not_supported', complianceWarning: 'country_not_supported' });
    expect(by.get(ids.accountInRussia)).toMatchObject({ file: null, excluded: 'country_not_supported', complianceWarning: null });
    expect(by.get(ids.underReview)).toMatchObject({ file: { provider: 'paypal' }, excluded: null, complianceWarning: 'screening_review' });
    expect(by.get(ids.confirmed)).toMatchObject({ file: null, excluded: 'screening_confirmed', complianceWarning: 'screening_confirmed' });

    const file = await files.buildManualPayoutFile(db, T, runId, 'paypal', 'USD', 1);
    expect(file?.payoutIds).toEqual([ids.underReview]);

    // A self-host applies its own rules: nothing is held back there.
    process.env.OPENPARTNER_TENANCY = 'single';
    const selfhost = await files.getManualRun(db, T, runId);
    expect(selfhost!.payouts.filter((x) => x.excluded)).toEqual([]);
  });
});
