/**
 * The first-run setup wizard's API side (apps/portal SetupWizard):
 *
 *   - who gets the wizard, and that its progress survives its own first step
 *     (GET /admin/onboarding-status, POST /config/onboarding);
 *   - the plan step: a plan can be changed until a subscription exists, and
 *     a Checkout started during the sign-up trial first charges when that
 *     trial ends, never later and never as a new trial;
 *   - a brand that subscribed while in review is not charged: its first
 *     charge moves out while it is pending, and rejecting it cancels the
 *     subscription;
 *   - "Send to a developer" mails the script tag the server builds.
 *
 * Stripe is a recording fake. Skipped if DATABASE_URL isn't set.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_setup_wizard_admin_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.STRIPE_FLAT_PRICE_ID = 'price_wiz_flat';
process.env.STRIPE_FLAT_USAGE_PRICE_ID = 'price_wiz_flat_usage';
process.env.STRIPE_REVSHARE_USAGE_PRICE_ID = 'price_wiz_rev';
delete process.env.NETWORK_URL;
delete process.env.PLATFORM_OPS_EMAIL;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GSTIN = '27AAPFU0939F1ZV';

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  failCancel: false,
}));

function fakeStripe() {
  return {
    customers: {
      create: async (args: unknown) => {
        h.calls.push(['customers.create', args]);
        return { id: 'cus_wiz_test' };
      },
      update: async (id: string) => ({ id }),
      retrieve: async (id: string) => ({ id, deleted: false, address: null }),
      listTaxIds: async () => ({ data: [] }),
      createTaxId: async (_id: string, args: unknown) => {
        h.calls.push(['customers.createTaxId', args]);
        return { id: 'txi_1' };
      },
      deleteTaxId: async () => ({ deleted: true }),
    },
    subscriptions: {
      cancel: async (id: string) => {
        h.calls.push(['subscriptions.cancel', id]);
        if (h.failCancel) throw new Error('stripe is down');
        return { id, status: 'canceled' };
      },
      update: async (id: string, args: unknown) => {
        h.calls.push(['subscriptions.update', { id, ...(args as object) }]);
        return { id };
      },
    },
    checkout: {
      sessions: {
        create: async (args: unknown) => {
          h.calls.push(['checkout.sessions.create', args]);
          return { url: 'https://checkout.stripe.com/test' };
        },
      },
    },
  };
}

vi.mock('../stripe.js', async () => {
  const actual = await vi.importActual<typeof import('../stripe.js')>('../stripe.js');
  return { ...actual, stripe: fakeStripe(), requireStripe: () => fakeStripe() };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { __setMailerForTests } = await import('../mailer.js');
const { checkoutTrialEnd } = await import('../billing-plan.js');
const { deferChargeWhilePendingReview, reconcileTenantSubscriptions } = await import('../billing-lifecycle.js');
const { rejectBrand } = await import('../brand-review.js');
const { setupWizardStatus } = await import('../routes/onboarding.js');
const { __resetDeveloperMailLimit } = await import('../routes/tracking-health.js');
const { getSetupWizardSettings, setSetupWizardSettings, SETUP_WIZARD_DEFAULTS } = await import('../platform-settings.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const mail: Array<{ to: string; subject: string; text: string; tag?: string }> = [];
__setMailerForTests({ send: async (_ctx: unknown, m: { to: string; subject: string; text: string; tag?: string }) => void mail.push(m) });

const tenants: string[] = [];
const operators: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

/** A brand as sign-up leaves it: pending review, on its 14-day trial. */
async function brand(overrides: Partial<TenantRow> = {}): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `wz${rnd()}`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: `Brand ${slug}`,
    status: 'active',
    approvalStatus: 'pending',
    trialEndsAt: new Date(Date.now() + 14 * DAY),
    firstTrialActivatedAt: new Date(),
    ...overrides,
  });
  tenants.push(id);
  return { id, slug };
}

async function tenantRow(id: string): Promise<TenantRow> {
  return (await db<TenantRow>(TABLES.Tenant).where({ id }).first())!;
}

async function program(tenantId: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name: 'Partners',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20, recurring: true }]),
    destinationUrl: 'https://brand.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  return id;
}

const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${ADMIN_KEY}`);
const status = async (slug: string) => (await asAdmin(request(app).get(`/t/${slug}/admin/onboarding-status`))).body;
const onboarding = (slug: string, body: unknown) => asAdmin(request(app).post(`/t/${slug}/config/onboarding`)).send(body as object);
const checkout = (slug: string) =>
  asAdmin(request(app).post(`/t/${slug}/billing/checkout`)).send({
    successUrl: 'https://x.test/setup?checkout=success',
    cancelUrl: 'https://x.test/setup?checkout=cancelled',
  });
const sessions = () => h.calls.filter(([n]) => n === 'checkout.sessions.create').map(([, a]) => a as Record<string, unknown> & { subscription_data: { trial_end: number; trial_period_days?: number }; line_items: unknown[] });
const called = (name: string) => h.calls.filter(([n]) => n === name).map(([, a]) => a);

const TENANT_TABLES = [
  TABLES.Session,
  TABLES.Admin,
  TABLES.Program,
  TABLES.Config,
  TABLES.AuditLog,
  TABLES.HostedBillingProfile,
  TABLES.HostedBillingState,
];

async function wipe(): Promise<void> {
  for (const id of tenants.splice(0)) {
    for (const t of TENANT_TABLES) await db(t).where({ tenantId: id }).del();
    await db(TABLES.LocationDeclaration).where({ subjectKind: 'tenant', subjectId: id }).del();
    await db(TABLES.PlatformAuditLog).where({ targetId: id }).del();
    await db(TABLES.Tenant).where({ id }).del();
  }
  for (const id of operators.splice(0)) await db(TABLES.PlatformAdmin).where({ id }).del();
  await db(TABLES.PlatformSetting).whereIn('key', ['setupWizard', 'invoiceBilling']).del();
}

beforeEach(() => {
  h.calls = [];
  h.failCancel = false;
  mail.length = 0;
});

afterEach(async () => {
  if (!skipIntegration) await wipe();
});

afterAll(async () => {
  __setMailerForTests(null);
  await db.destroy();
});

describe('checkoutTrialEnd', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  it('carries the rest of the sign-up trial, to the second', () => {
    const end = new Date(now.getTime() + 10 * DAY);
    expect(checkoutTrialEnd({ trialEndsAt: end }, now)).toBe(Math.floor(end.getTime() / 1000));
  });
  it('charges at once with under 48 hours left, after the trial, or with no trial', () => {
    expect(checkoutTrialEnd({ trialEndsAt: new Date(now.getTime() + 47 * HOUR) }, now)).toBeNull();
    expect(checkoutTrialEnd({ trialEndsAt: new Date(now.getTime() - DAY) }, now)).toBeNull();
    expect(checkoutTrialEnd({ trialEndsAt: null }, now)).toBeNull();
  });
});

describe('setupWizardStatus', () => {
  const base = {
    multiTenant: true,
    enabled: true,
    hints: { percent: 'p', fixed: 'f' },
    campaignCount: 0,
    firstProgramId: null,
    startedAt: null,
    completedAt: null,
    exitedAt: null,
    step: 0,
  };
  it('is for hosted brands only, and only with the switch on', () => {
    expect(setupWizardStatus(base)).toMatchObject({ available: true, redirect: true });
    expect(setupWizardStatus({ ...base, multiTenant: false })).toMatchObject({ available: false, redirect: false });
    expect(setupWizardStatus({ ...base, enabled: false })).toMatchObject({ available: false, redirect: false });
  });
  it('leaves a brand that set itself up before the wizard alone', () => {
    expect(setupWizardStatus({ ...base, campaignCount: 2, firstProgramId: 'p1' }).available).toBe(false);
  });
});

describe.skipIf(skipIntegration)('wizard status and progress', () => {
  it('is off until an operator turns it on', async () => {
    const b = await brand();
    expect((await status(b.slug)).wizard).toMatchObject({ available: false, redirect: false });
    expect(await getSetupWizardSettings(db)).toEqual(SETUP_WIZARD_DEFAULTS);
  });

  it('opens for a new brand, stays open once its first step creates the program, and resumes', async () => {
    await setSetupWizardSettings(db, { enabled: true, hints: { percent: 'Typical: 20–30%.' } }, 'ops@openpartner.test');
    const b = await brand();
    expect((await status(b.slug)).wizard).toMatchObject({
      available: true,
      redirect: true,
      step: 0,
      programId: null,
      hints: { percent: 'Typical: 20–30%.', fixed: SETUP_WIZARD_DEFAULTS.hints.fixed },
    });

    expect((await onboarding(b.slug, { wizardStarted: true, wizardStep: 1 })).status).toBe(200);
    // What the portal's first step does, as a brand on the Network would
    // need: private until the marketplace step.
    const created = await asAdmin(request(app).post(`/t/${b.slug}/programs`)).send({
      name: 'Partners',
      destinationUrl: 'https://brand.test',
      commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
      shareOnNetwork: false,
    });
    expect(created.status).toBe(201);
    let s = await status(b.slug);
    expect(s.campaignCount).toBe(1);
    expect(s.wizard).toMatchObject({ available: true, redirect: true, step: 1, programId: created.body.id });

    // The commission step: two-tier at the wizard's default, no time limit.
    const patched = await asAdmin(request(app).patch(`/t/${b.slug}/programs/${created.body.id}`)).send({
      commissionRule: [{ trigger: 'every', type: 'percent', value: 25, recurring: true }],
      attributionWindowDays: 90,
      recruiterCommissionPercent: 10,
      recruiterCommissionMonths: null,
    });
    expect(patched.status).toBe(200);
    expect(Number(patched.body.recruiterCommissionPercent)).toBe(10);
    expect(patched.body.recruiterCommissionMonths).toBeNull();

    // Progress only moves forward.
    await onboarding(b.slug, { wizardStep: 3 });
    await onboarding(b.slug, { wizardStep: 2 });
    s = await status(b.slug);
    expect(s.wizard.step).toBe(3);
  });

  it('"Finish later" stops the redirect but keeps the wizard on offer; finishing ends it', async () => {
    await setSetupWizardSettings(db, { enabled: true }, 'ops@openpartner.test');
    const b = await brand();
    await onboarding(b.slug, { wizardStarted: true, wizardStep: 1 });
    await program(b.id);

    await onboarding(b.slug, { wizardExited: true });
    expect((await status(b.slug)).wizard).toMatchObject({ available: true, redirect: false });
    await onboarding(b.slug, { wizardExited: false });
    expect((await status(b.slug)).wizard).toMatchObject({ available: true, redirect: true });

    await onboarding(b.slug, { wizardCompleted: true });
    const done = (await status(b.slug)).wizard;
    expect(done).toMatchObject({ available: false, redirect: false });
    expect(done.completedAt).toBeTruthy();
  });

  it('never opens for a brand that already has a program and never started it', async () => {
    await setSetupWizardSettings(db, { enabled: true }, 'ops@openpartner.test');
    const b = await brand();
    await program(b.id);
    expect((await status(b.slug)).wizard).toMatchObject({ available: false, redirect: false });
  });

  it('the Programs page default for two-tier is still off', async () => {
    const b = await brand();
    const created = await asAdmin(request(app).post(`/t/${b.slug}/programs`)).send({
      name: 'Plain',
      destinationUrl: 'https://brand.test',
      commissionRule: [{ trigger: 'every', type: 'percent', value: 20 }],
      shareOnNetwork: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.recruiterCommissionPercent ?? null).toBeNull();
  });

  it('rejects a step outside the wizard', async () => {
    const b = await brand();
    expect((await onboarding(b.slug, { wizardStep: 9 })).status).toBe(400);
    expect((await onboarding(b.slug, { wizardCompleted: false })).status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('plan step', () => {
  it('a pending brand may change its plan until it subscribes', async () => {
    const b = await brand({ billingPlan: 'flex' });
    const toRev = await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'revshare' });
    expect(toRev.status).toBe(200);
    expect((await tenantRow(b.id)).billingPlan).toBe('revshare');

    await db(TABLES.Tenant).where({ id: b.id }).update({ stripeSubscriptionId: 'sub_wiz_live' });
    const blocked = await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'flex' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('plan_already_set');
    expect((await tenantRow(b.id)).billingPlan).toBe('revshare');
  });

  it('never lets a brand take or leave Enterprise', async () => {
    const b = await brand({ billingPlan: 'enterprise' });
    expect((await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'flex' })).status).toBe(409);
    expect((await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'enterprise' })).status).toBe(400);
  });

  it('Flex Checkout during the trial takes the card and first charges when the trial ends', async () => {
    const trialEndsAt = new Date(Date.now() + 14 * DAY);
    const b = await brand({ billingPlan: 'flex', trialEndsAt });
    const res = await checkout(b.slug);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/test');
    expect(res.body.firstChargeAt).toBe(new Date(Math.floor(trialEndsAt.getTime() / 1000) * 1000).toISOString());

    const [session] = sessions();
    expect(session).toMatchObject({
      mode: 'subscription',
      payment_method_collection: 'always',
      success_url: 'https://x.test/setup?checkout=success',
      cancel_url: 'https://x.test/setup?checkout=cancelled',
      subscription_data: { trial_end: Math.floor(trialEndsAt.getTime() / 1000) },
      metadata: { openpartner_tenant_id: b.id, openpartner_plan: 'flex' },
    });
    // The remainder of the one trial: no trial length of Stripe's own.
    expect(session!.subscription_data.trial_period_days).toBeUndefined();
    expect(session!.line_items[0]).toEqual({ price: 'price_wiz_flat', quantity: 1 });
    // Sign-up owns the trial dates.
    expect((await tenantRow(b.id)).trialEndsAt!.getTime()).toBe(trialEndsAt.getTime());
  });

  it('Revshare gets the same rule', async () => {
    const b = await brand({ billingPlan: 'revshare' });
    expect((await checkout(b.slug)).status).toBe(200);
    expect(sessions()[0]!.subscription_data.trial_end).toBeGreaterThan(Date.now() / 1000);
  });

  it('no second trial: under 48 hours left, or after the trial, Checkout charges at once', async () => {
    const closing = await brand({ billingPlan: 'flex', trialEndsAt: new Date(Date.now() + 47 * HOUR) });
    const closingRes = await checkout(closing.slug);
    expect(closingRes.body.firstChargeAt).toBeNull();
    const lapsed = await brand({ billingPlan: 'flex', trialEndsAt: new Date(Date.now() - DAY) });
    await checkout(lapsed.slug);
    const legacy = await brand({ billingPlan: 'flex', trialEndsAt: null, firstTrialActivatedAt: null });
    await checkout(legacy.slug);

    expect(sessions()).toHaveLength(3);
    for (const s of sessions()) expect(s.subscription_data).toBeUndefined();
  });

  it('a retry after a cancelled Checkout reuses the customer and keeps the plan', async () => {
    const b = await brand({ billingPlan: 'flex' });
    await checkout(b.slug);
    expect((await tenantRow(b.id)).stripeCustomerId).toBe('cus_wiz_test');
    // Backed out: no subscription. Try again, then switch.
    expect((await checkout(b.slug)).status).toBe(200);
    expect(called('customers.create')).toHaveLength(1);
    expect((await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'revshare' })).status).toBe(200);
  });

  it('a pay-by-invoice brand keeps its plan choice; Checkout sends it to Billing', async () => {
    const b = await brand();
    await db(TABLES.LocationDeclaration).insert({ id: ulid(), subjectKind: 'tenant', subjectId: b.id, tenantId: b.id, country: 'IN', source: 'signup' });
    expect((await asAdmin(request(app).post(`/t/${b.slug}/billing/plan`)).send({ plan: 'flex' })).status).toBe(200);
    const res = await checkout(b.slug);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invoice_billing');
    expect(sessions()).toHaveLength(0);
    expect((await tenantRow(b.id)).stripeSubscriptionId).toBeNull();
  });

  it('an Indian brand paying by card gives its GSTIN first, then gets the same trial', async () => {
    const b = await brand({ billingPlan: 'flex' });
    await db(TABLES.LocationDeclaration).insert({ id: ulid(), subjectKind: 'tenant', subjectId: b.id, tenantId: b.id, country: 'IN', source: 'signup' });
    await db(TABLES.HostedBillingProfile).insert({ tenantId: b.id, collectionMethod: 'charge_automatically' });

    const refused = await checkout(b.slug);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('gstin_required');

    const tax = await asAdmin(request(app).put(`/t/${b.slug}/billing/tax-details`)).send({ gstin: GSTIN });
    expect(tax.status).toBe(200);
    expect((await checkout(b.slug)).status).toBe(200);
    expect(sessions()[0]!.subscription_data.trial_end).toBeGreaterThan(Date.now() / 1000);
    expect(called('customers.createTaxId')).toEqual([{ type: 'in_gst', value: GSTIN }]);
  });
});

describe.skipIf(skipIntegration)('a brand that subscribed while in review', () => {
  async function operator() {
    const id = ulid();
    await db(TABLES.PlatformAdmin).insert({ id, email: `ops-${rnd()}@openpartner.test`, name: 'Ops', role: 'admin', createdAt: new Date() });
    operators.push(id);
    return { id, email: 'ops@openpartner.test', role: 'admin' as const };
  }

  it('is cancelled in Stripe when rejected', async () => {
    const b = await brand({ billingPlan: 'flex', stripeCustomerId: 'cus_wiz_test', stripeSubscriptionId: 'sub_wiz_trial' });
    await rejectBrand(db, await tenantRow(b.id), await operator(), { reason: 'spam' });

    expect(called('subscriptions.cancel')).toEqual(['sub_wiz_trial']);
    const after = await tenantRow(b.id);
    expect(after).toMatchObject({ approvalStatus: 'rejected', status: 'suspended', stripeSubscriptionId: null });
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: b.id }).first();
    expect(mirror?.subscriptionStatus).toBe('canceled');
  });

  it('is still rejected when Stripe refuses the cancel; the pointer stays for ops', async () => {
    h.failCancel = true;
    const b = await brand({ billingPlan: 'flex', stripeCustomerId: 'cus_wiz_test', stripeSubscriptionId: 'sub_wiz_trial' });
    await rejectBrand(db, await tenantRow(b.id), await operator());
    expect(await tenantRow(b.id)).toMatchObject({ approvalStatus: 'rejected', stripeSubscriptionId: 'sub_wiz_trial' });
  });

  it('a brand with no subscription is rejected without a Stripe call', async () => {
    const b = await brand();
    await rejectBrand(db, await tenantRow(b.id), await operator());
    expect(called('subscriptions.cancel')).toHaveLength(0);
  });

  it('has its first charge moved out while it is still pending', async () => {
    const now = new Date();
    const b = await brand({ billingPlan: 'flex', stripeSubscriptionId: 'sub_wiz_trial' });
    const stripe = fakeStripe() as never;
    const due = { id: 'sub_wiz_trial', status: 'trialing' as const, trial_end: Math.floor((now.getTime() + 3 * DAY) / 1000) };

    expect(await deferChargeWhilePendingReview(db, stripe, b.id, due, now)).toBe('deferred');
    expect(called('subscriptions.update')).toEqual([
      { id: 'sub_wiz_trial', trial_end: Math.floor((now.getTime() + 7 * DAY) / 1000), proration_behavior: 'none' },
    ]);
    // The product trial is sign-up's: untouched.
    expect((await tenantRow(b.id)).trialEndsAt!.getTime()).toBeGreaterThan(now.getTime() + 13 * DAY);

    h.calls = [];
    // Not yet due, not a trial, or no longer pending: left alone.
    const far = { ...due, trial_end: Math.floor((now.getTime() + 6 * DAY) / 1000) };
    expect(await deferChargeWhilePendingReview(db, stripe, b.id, far, now)).toBe('not_due');
    expect(await deferChargeWhilePendingReview(db, stripe, b.id, { ...due, status: 'active' as const, trial_end: null }, now)).toBe('not_due');
    await db(TABLES.Tenant).where({ id: b.id }).update({ approvalStatus: 'approved' });
    expect(await deferChargeWhilePendingReview(db, stripe, b.id, due, now)).toBe('not_pending');
    expect(called('subscriptions.update')).toHaveLength(0);
  });

  it('is caught by the nightly reconcile when the webhook never arrives', async () => {
    const b = await brand({ billingPlan: 'flex', stripeSubscriptionId: `sub_wiz_${rnd()}` });
    const sub = (await tenantRow(b.id)).stripeSubscriptionId!;
    const stripe = {
      ...fakeStripe(),
      subscriptions: {
        ...fakeStripe().subscriptions,
        retrieve: async (id: string) => ({
          id,
          status: id === sub ? 'trialing' : 'active',
          trial_end: id === sub ? Math.floor((Date.now() + 2 * DAY) / 1000) : null,
          collection_method: 'charge_automatically',
          cancel_at_period_end: false,
          cancel_at: null,
          customer: 'cus_wiz_test',
          items: { data: [] },
        }),
      },
      invoices: { list: async () => ({ data: [] }) },
    };
    const result = await reconcileTenantSubscriptions(db, stripe as never);
    expect(result).toMatchObject({ chargeDeferred: [b.slug] });
    expect(called('subscriptions.update')).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('send to a developer', () => {
  const send = (slug: string, body: unknown) =>
    asAdmin(request(app).post(`/t/${slug}/admin/tracking-health/send-to-developer`)).send(body as object);

  it('mails the script tag and guide the server builds, to the address given', async () => {
    const b = await brand();
    const res = await send(b.slug, { email: ' dev@example.com ', scriptTag: '<script src="https://evil.test/x.js"></script>' });
    expect(res.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'dev@example.com', tag: 'tracking_install_for_developer' });
    expect(mail[0]!.subject).toContain(`Brand ${b.slug}`);
    expect(mail[0]!.text).toContain(`<script src="http://localhost:5673/op.js" data-api-url="http://localhost:5673/api/t/${b.slug}"></script>`);
    expect(mail[0]!.text).toContain('openpartner.identify(');
    expect(mail[0]!.text).toContain('packages/sdk/README.md');
    expect(mail[0]!.text).not.toContain('evil.test');
    __resetDeveloperMailLimit(b.id);
  });

  it('names the admin who asked, and is on the audit log', async () => {
    const b = await brand();
    const adminId = ulid();
    await db(TABLES.Admin).insert({ id: adminId, tenantId: b.id, email: 'owner@example.com', name: 'Owner', role: 'admin', activatedAt: new Date() });
    const session = await createSession(db, { tenantId: b.id, principalKind: 'admin', principalId: adminId });
    const res = await request(app)
      .post(`/t/${b.slug}/admin/tracking-health/send-to-developer`)
      .set('Cookie', `op_session=${session.plaintext}`)
      .send({ email: 'dev@example.com' });
    expect(res.status).toBe(200);
    expect(mail[0]!.text).toContain('owner@example.com asked us to send you this');
    const logged = await db(TABLES.AuditLog).where({ tenantId: b.id });
    expect(logged.map((l) => l.action)).toContain('POST /admin/tracking-health/send-to-developer');
    __resetDeveloperMailLimit(b.id);
  });

  it('refuses a bad address and a view-only seat', async () => {
    const b = await brand();
    expect((await send(b.slug, { email: 'not-an-address' })).status).toBe(400);
    expect((await send(b.slug, {})).status).toBe(400);

    const viewerId = ulid();
    await db(TABLES.Admin).insert({ id: viewerId, tenantId: b.id, email: 'viewer@example.com', name: 'Viewer', role: 'viewer', activatedAt: new Date() });
    const session = await createSession(db, { tenantId: b.id, principalKind: 'admin', principalId: viewerId });
    const res = await request(app)
      .post(`/t/${b.slug}/admin/tracking-health/send-to-developer`)
      .set('Cookie', `op_session=${session.plaintext}`)
      .send({ email: 'dev@example.com' });
    expect(res.status).toBe(403);
    expect(mail).toHaveLength(0);
  });

  it('stops at five a day per brand', async () => {
    const b = await brand();
    for (let i = 0; i < 5; i += 1) expect((await send(b.slug, { email: `dev${i}@example.com` })).status).toBe(200);
    const sixth = await send(b.slug, { email: 'dev6@example.com' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too_many_emails');
    expect(mail).toHaveLength(5);
    // Another brand has its own allowance.
    const other = await brand();
    expect((await send(other.slug, { email: 'dev@example.com' })).status).toBe(200);
    __resetDeveloperMailLimit(b.id);
    __resetDeveloperMailLimit(other.id);
  });
});
