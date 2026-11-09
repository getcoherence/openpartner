import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const stripeApi = vi.hoisted(() => ({
  accounts: { create: vi.fn(), retrieve: vi.fn(), retrieveCurrent: vi.fn(), update: vi.fn() },
  accountLinks: { create: vi.fn() },
}));
const mode = vi.hoisted(() => ({ current: 'selfhost' as 'selfhost' | 'flat' | 'revshare' }));
vi.mock('../stripe.js', () => ({ stripe: stripeApi, requireStripe: () => stripeApi, getMode: () => mode.current }));

import { db } from '../db.js';
import { createApp } from '../app.js';
import { createApiKeyRow } from '../auth.js';
import { setConfig } from '../config.js';
import { CONNECT_DEFAULTS, CONNECT_SETTINGS_KEY, readConnectSettings, saveConnectSettings } from '../connect-settings.js';

const ADMIN_KEY = 'op_test_connect_onboarding_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
const app = createApp({ enableLogger: false });
const partnerId = ulid();
const otherTenantId = ulid();
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
const body = { returnUrl: 'http://localhost:5673/connect?done=1', refreshUrl: 'http://localhost:5673/connect' };
const customBody = { ...body, country: 'US' };
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

beforeAll(async () => {
  if (skipIntegration) return;
  await db(TABLES.Tenant).insert({ id: otherTenantId, slug: `connect-${otherTenantId.toLowerCase()}`, displayName: 'Other company' });
  await db(TABLES.Partner).insert({
    id: partnerId, tenantId: DEFAULT_TENANT_ID,
    email: 'onboarding-test@example.test', name: 'Onboarding test',
  });
});

beforeEach(async () => {
  vi.resetAllMocks();
  mode.current = 'selfhost';
  stripeApi.accounts.retrieveCurrent.mockResolvedValue({ id: 'acct_platform', country: 'US' });
  stripeApi.accounts.create.mockResolvedValue({ id: 'acct_onboarding_test' });
  stripeApi.accounts.retrieve.mockResolvedValue({
    id: 'acct_onboarding_test', type: 'custom', country: 'US',
    capabilities: { transfers: 'inactive', tax_reporting_us_1099_misc: 'inactive' },
  });
  stripeApi.accounts.update.mockResolvedValue({ id: 'acct_onboarding_test' });
  stripeApi.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/test', expires_at: 123 });
  if (!skipIntegration) {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: null });
    await db(TABLES.Config).whereIn('tenantId', [DEFAULT_TENANT_ID, otherTenantId]).where({ key: CONNECT_SETTINGS_KEY }).del();
  }
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.ApiKey).where({ partnerId }).del();
    await db(TABLES.Partner).where({ id: partnerId }).del();
    await db(TABLES.Config).whereIn('tenantId', [DEFAULT_TENANT_ID, otherTenantId]).where({ key: CONNECT_SETTINGS_KEY }).del();
    await db(TABLES.Tenant).where({ id: otherTenantId }).del();
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('configurable Connect onboarding', () => {

  it('defaults new capability options off for previously saved settings', async () => {
    await setConfig(db, DEFAULT_TENANT_ID, CONNECT_SETTINGS_KEY, {
      accountMode: 'custom_payouts', collectTaxInformation: true, collectEventuallyDue: true,
      productDescription: 'Referral services.',
    });
    const response = await request(app).get('/config/stripe-connect').set(admin).expect(200);
    expect(response.body).toEqual({
      ...CONNECT_DEFAULTS, accountMode: 'custom_payouts', productDescription: 'Referral services.', customAccountsAvailable: true,
    });
  });

  it('defaults to the original Standard account and Stripe-default onboarding', async () => {
    const settings = await request(app).get('/config/stripe-connect').set(admin).expect(200);
    expect(settings.body).toEqual({ ...CONNECT_DEFAULTS, customAccountsAvailable: true });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0]).toEqual({
      type: 'standard', email: 'onboarding-test@example.test',
      metadata: { openpartner_partner_id: partnerId, openpartner_tenant_id: DEFAULT_TENANT_ID },
    });
    expect(stripeApi.accountLinks.create.mock.calls[0]![0]).not.toHaveProperty('collection_options');
  });

  it('saves custom options, preserves omitted fields, and can switch back to Standard', async () => {
    await request(app).post('/config/stripe-connect').set(admin).send({
      accountMode: 'custom_payouts', collectTaxInformation: false,
      collect1099KTaxInformation: true, collectFutureRequirements: true,
      collectEventuallyDue: false, productDescription: ' Referral services. ',
    }).expect(200);
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(customBody).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0]).toMatchObject({
      type: 'custom', country: 'US', capabilities: { transfers: { requested: true } },
      business_profile: { product_description: 'Referral services.' },
    });
    expect(stripeApi.accounts.create.mock.calls[0]![0].capabilities).not.toHaveProperty('tax_reporting_us_1099_misc');
    expect(stripeApi.accounts.create.mock.calls[0]![0].capabilities).toEqual({
      transfers: { requested: true }, tax_reporting_us_1099_k: { requested: true },
    });
    expect(stripeApi.accountLinks.create.mock.calls[0]![0].collection_options.fields).toBe('currently_due');
    expect(stripeApi.accountLinks.create.mock.calls[0]![0].collection_options.future_requirements).toBe('include');
    const updated = await request(app).post('/config/stripe-connect').set(admin).send({ accountMode: 'standard' }).expect(200);
    expect(updated.body).toMatchObject({ accountMode: 'standard', collectTaxInformation: false, productDescription: 'Referral services.' });
    // A subsequent new account uses the default setup, regardless of saved Custom options.
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: null });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accounts.create.mock.calls[1]![0].type).toBe('standard');
    expect(stripeApi.accounts.create.mock.calls[1]![0]).not.toHaveProperty('capabilities');
    expect(stripeApi.accountLinks.create.mock.calls[1]![0]).not.toHaveProperty('collection_options');
  });

  it('does not let partners override account setup in the start request', async () => {
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin)
      .send({ ...body, accountMode: 'custom_payouts', collectTaxInformation: true }).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0].type).toBe('standard');
  });

  it('clears the optional activity description and reports accurate partner copy', async () => {
    await request(app).post('/config/stripe-connect').set(admin)
      .send({ accountMode: 'custom_payouts', productDescription: '' }).expect(200);
    const status = await request(app).get(`/partners/${partnerId}/connect/status`).set(admin).expect(200);
    expect(status.body).toEqual({ connected: false, accountMode: 'custom_payouts', activityDescriptionPrefilled: false });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(customBody).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0]).not.toHaveProperty('business_profile');
  });

  it('isolates the settings between companies', async () => {
    await saveConnectSettings(db, otherTenantId, { accountMode: 'custom_payouts', productDescription: 'Other activity' });
    expect(await readConnectSettings(db, DEFAULT_TENANT_ID)).toEqual(CONNECT_DEFAULTS);
    expect((await readConnectSettings(db, otherTenantId)).accountMode).toBe('custom_payouts');
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0].type).toBe('standard');
  });

  it.each([{ accountMode: 'express' }, { collectTaxInformation: 'yes' }, { requestCardPayments: true },
    { collect1099KTaxInformation: 1 }, { collectFutureRequirements: null },
    { productDescription: 'x'.repeat(501) }, { feesPayer: 'stripe' }])(
    'rejects invalid settings: %j', async (patch) => {
      await request(app).post('/config/stripe-connect').set(admin).send(patch).expect(400);
      expect(await readConnectSettings(db, DEFAULT_TENANT_ID)).toEqual(CONNECT_DEFAULTS);
    },
  );

  it('allows only admins to read and save settings', async () => {
    const key = await createApiKeyRow(db, { tenantId: DEFAULT_TENANT_ID, partnerId, label: 'connect-settings-test' });
    for (const method of ['get', 'post'] as const) {
      await request(app)[method]('/config/stripe-connect').expect(401);
      await request(app)[method]('/config/stripe-connect').set('Authorization', `Bearer ${key.plaintext}`).expect(403);
    }
  });

  it('uses a different idempotency key if account settings change after a failed attempt', async () => {
    stripeApi.accountLinks.create.mockRejectedValueOnce(new Error('temporary onboarding error'));
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(500);
    await request(app).post('/config/stripe-connect').set(admin).send({ accountMode: 'custom_payouts' }).expect(200);
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(customBody).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![1].idempotencyKey).not.toBe(stripeApi.accounts.create.mock.calls[1]![1].idempotencyKey);
  });

  it('creates a payout-only Custom account with tax collection and upfront verification', async () => {
    await request(app).post('/config/stripe-connect').set(admin).send({ accountMode: 'custom_payouts' }).expect(200);
    const res = await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(customBody);
    expect(res.status).toBe(200);
    expect(stripeApi.accounts.create).toHaveBeenCalledWith({
      type: 'custom',
      country: 'US',
      email: 'onboarding-test@example.test',
      capabilities: {
        transfers: { requested: true },
        tax_reporting_us_1099_misc: { requested: true },
      },
      business_profile: { product_description: 'Affiliate marketing and referral commissions.' },
      metadata: { openpartner_partner_id: partnerId, openpartner_tenant_id: DEFAULT_TENANT_ID },
    }, { idempotencyKey: expect.stringMatching(new RegExp(`^connect-account:${DEFAULT_TENANT_ID}:${partnerId}:[a-f0-9]{24}$`)) });
    expect(stripeApi.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_onboarding_test', type: 'account_onboarding',
      return_url: body.returnUrl, refresh_url: body.refreshUrl,
      collection_options: { fields: 'eventually_due', future_requirements: 'omit' },
    });
    expect(res.body).toEqual({ url: 'https://connect.stripe.com/test', expiresAt: 123 });
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBe('acct_onboarding_test');
  });

  it.each([
    { type: 'standard', country: 'US', capabilities: { transfers: 'active', card_payments: 'active' } },
    { type: 'custom', country: 'US', capabilities: { transfers: 'active', tax_reporting_us_1099_misc: 'active' } },
  ])('reuses a saved $type account without changing its capabilities or account ID', async (account) => {
    await saveConnectSettings(db, DEFAULT_TENANT_ID, {
      accountMode: account.type === 'standard' ? 'custom_payouts' : 'standard',
      collect1099KTaxInformation: true, collectFutureRequirements: true,
    });
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_existing' });
    stripeApi.accounts.retrieve.mockResolvedValue({ id: 'acct_existing', ...account });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accounts.create).not.toHaveBeenCalled();
    expect(stripeApi.accounts.update).not.toHaveBeenCalled();
    expect(stripeApi.accounts.retrieve).toHaveBeenCalledWith('acct_existing');
    expect(stripeApi.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({
      account: 'acct_existing', type: 'account_onboarding',
    }));
    expect(stripeApi.accountLinks.create.mock.calls[0]![0].collection_options).toEqual(
      account.type === 'custom' ? { fields: 'eventually_due', future_requirements: 'include' } : undefined,
    );
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBe('acct_existing');
  });

  it('keeps an existing account linked when Stripe fails instead of creating a replacement', async () => {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_existing' });
    stripeApi.accountLinks.create.mockRejectedValueOnce(new Error('Stripe account unavailable'));
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(500);
    expect(stripeApi.accounts.create).not.toHaveBeenCalled();
    expect(stripeApi.accounts.update).not.toHaveBeenCalled();
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBe('acct_existing');
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accountLinks.create).toHaveBeenLastCalledWith(expect.objectContaining({ account: 'acct_existing' }));
  });

  it('uses the same Stripe idempotency key after an account-link failure rolls back the DB write', async () => {
    stripeApi.accountLinks.create.mockRejectedValueOnce(new Error('temporary onboarding error'));
    const first = await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body);
    expect(first.status).toBe(500);
    const retry = await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body);
    expect(retry.status).toBe(200);
    expect(stripeApi.accounts.create).toHaveBeenCalledTimes(2);
    expect(stripeApi.accounts.create.mock.calls[0]).toEqual(stripeApi.accounts.create.mock.calls[1]);
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBe('acct_onboarding_test');
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(200);
    expect(stripeApi.accounts.create).toHaveBeenCalledTimes(2);
  });

  it('leaves the partner unlinked if account creation fails', async () => {
    stripeApi.accounts.create.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(500);
    expect(stripeApi.accountLinks.create).not.toHaveBeenCalled();
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBeNull();
  });

  it('reports transfers ready without requiring card payment capability', async () => {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_onboarding_test' });
    stripeApi.accounts.retrieve.mockResolvedValue({
      id: 'acct_onboarding_test', charges_enabled: false, payouts_enabled: true,
      details_submitted: true, capabilities: { transfers: 'active' },
    });
    const res = await request(app).get(`/partners/${partnerId}/connect/status`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, chargesEnabled: false, transfersEnabled: true, payoutsEnabled: true });
  });

  it.each([
    { requirements: { currently_due: [], past_due: [], current_deadline: null }, due: false, by: null },
    { requirements: { currently_due: ['individual.id_number'], past_due: [], current_deadline: 1798200000 }, due: true, by: '2026-12-25T12:00:00.000Z' },
    { requirements: { currently_due: ['external_account'], past_due: ['external_account'], current_deadline: null }, due: true, by: null },
    { requirements: undefined, due: false, by: null },
  ])('reports details Stripe needs: due=$due by=$by', async ({ requirements, due, by }) => {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_onboarding_test' });
    stripeApi.accounts.retrieve.mockResolvedValue({
      id: 'acct_onboarding_test', type: 'custom', payouts_enabled: true, details_submitted: true,
      capabilities: { transfers: 'active' }, requirements,
    });
    const res = await request(app).get(`/partners/${partnerId}/connect/status`).set(admin).expect(200);
    expect(res.body).toMatchObject({ connected: true, requirementsDue: due, requirementsDueBy: by });
  });

  it('asks for the partner country before creating a Custom account', async () => {
    await saveConnectSettings(db, DEFAULT_TENANT_ID, { accountMode: 'custom_payouts' });
    const res = await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(body).expect(400);
    expect(res.body.error).toBe('country_required');
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send({ ...body, country: 'XX' }).expect(400);
    expect(stripeApi.accounts.create).not.toHaveBeenCalled();
  });

  it('onboards a partner outside the platform country as a transfers-only recipient', async () => {
    await saveConnectSettings(db, DEFAULT_TENANT_ID, { accountMode: 'custom_payouts', collect1099KTaxInformation: true });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send({ ...body, country: 'gb' }).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0]).toMatchObject({
      type: 'custom', country: 'GB',
      capabilities: { transfers: { requested: true } },
      tos_acceptance: { service_agreement: 'recipient' },
    });
    expect(stripeApi.accounts.create.mock.calls[0]![0].capabilities).toEqual({ transfers: { requested: true } });
  });

  it('keeps the full service agreement for a partner in the platform country', async () => {
    stripeApi.accounts.retrieveCurrent.mockResolvedValue({ id: 'acct_platform', country: 'GB' });
    await saveConnectSettings(db, DEFAULT_TENANT_ID, { accountMode: 'custom_payouts' });
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send({ ...body, country: 'GB' }).expect(200);
    const params = stripeApi.accounts.create.mock.calls[0]![0];
    expect(params).toMatchObject({ type: 'custom', country: 'GB' });
    expect(params).not.toHaveProperty('tos_acceptance');
    // US tax capabilities only apply to US accounts.
    expect(params.capabilities).toEqual({ transfers: { requested: true } });
  });

  it('reports a Stripe refusal as the partner\'s to fix, and leaves them unlinked', async () => {
    await saveConnectSettings(db, DEFAULT_TENANT_ID, { accountMode: 'custom_payouts' });
    stripeApi.accounts.create.mockRejectedValueOnce(Object.assign(
      new Error('Cross-border payouts are not supported for this country.'), { type: 'StripeInvalidRequestError' },
    ));
    const res = await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send({ ...body, country: 'IN' }).expect(400);
    expect(res.body).toEqual({ error: 'stripe_account_rejected', detail: 'Cross-border payouts are not supported for this country.' });
    expect(stripeApi.accountLinks.create).not.toHaveBeenCalled();
    expect((await db(TABLES.Partner).where({ id: partnerId }).first()).stripeConnectAccountId).toBeNull();
  });

  it.each(['flat', 'revshare'] as const)('keeps %s tenants on Standard accounts', async (hosted) => {
    mode.current = hosted;
    const rejected = await request(app).post('/config/stripe-connect').set(admin).send({ accountMode: 'custom_payouts' }).expect(403);
    expect(rejected.body.error).toBe('custom_accounts_disabled_on_hosted');
    expect((await request(app).get('/config/stripe-connect').set(admin).expect(200)).body)
      .toEqual({ ...CONNECT_DEFAULTS, customAccountsAvailable: false });
    // A Custom setting saved while the instance was self-hosted reads as Standard.
    await setConfig(db, DEFAULT_TENANT_ID, CONNECT_SETTINGS_KEY, { accountMode: 'custom_payouts' });
    expect((await readConnectSettings(db, DEFAULT_TENANT_ID)).accountMode).toBe('standard');
    const status = await request(app).get(`/partners/${partnerId}/connect/status`).set(admin).expect(200);
    expect(status.body.accountMode).toBe('standard');
    await request(app).post(`/partners/${partnerId}/connect/start`).set(admin).send(customBody).expect(200);
    expect(stripeApi.accounts.create.mock.calls[0]![0]).toEqual({
      type: 'standard', email: 'onboarding-test@example.test',
      metadata: { openpartner_partner_id: partnerId, openpartner_tenant_id: DEFAULT_TENANT_ID },
    });
  });

  it('gives a Custom account an account_update link for its payout details', async () => {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_onboarding_test' });
    const res = await request(app).post(`/partners/${partnerId}/connect/update`).set(admin).send(body).expect(200);
    expect(stripeApi.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_onboarding_test', type: 'account_update',
      return_url: body.returnUrl, refresh_url: body.refreshUrl,
    });
    expect(res.body).toEqual({ url: 'https://connect.stripe.com/test', expiresAt: 123 });
  });

  it('refuses an update link without a Custom account', async () => {
    let res = await request(app).post(`/partners/${partnerId}/connect/update`).set(admin).send(body).expect(409);
    expect(res.body.error).toBe('connect_not_started');
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_existing' });
    stripeApi.accounts.retrieve.mockResolvedValue({ id: 'acct_existing', type: 'standard' });
    res = await request(app).post(`/partners/${partnerId}/connect/update`).set(admin).send(body).expect(409);
    expect(res.body.error).toBe('not_a_custom_account');
    expect(stripeApi.accountLinks.create).not.toHaveBeenCalled();
  });

  it('reports the saved account type so the portal can offer updates', async () => {
    await db(TABLES.Partner).where({ id: partnerId }).update({ stripeConnectAccountId: 'acct_onboarding_test' });
    const res = await request(app).get(`/partners/${partnerId}/connect/status`).set(admin).expect(200);
    expect(res.body.accountType).toBe('custom');
  });

  it('rejects unauthenticated account creation without contacting Stripe', async () => {
    const res = await request(app).post(`/partners/${partnerId}/connect/start`).send(body);
    expect(res.status).toBe(401);
    expect(stripeApi.accounts.create).not.toHaveBeenCalled();
  });
});
