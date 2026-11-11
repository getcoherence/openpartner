// @vitest-environment jsdom
/**
 * The first-run setup wizard (pages/admin/SetupWizard.tsx), against a
 * stand-in API that keeps state the way the real routes do:
 *
 *   - each step saves through the existing routes, in an order that keeps
 *     the wizard resumable (the start stamp before the program exists);
 *   - two-tier commission starts on at 10%, and the worked example shows
 *     the partner's commission, the recruiter's share and the brand's total;
 *   - a reload resumes after the last saved step;
 *   - Revshare continues with no card; Flex goes to Stripe Checkout and
 *     comes back to the recap, or, cancelled, to the plan step with the
 *     choice kept;
 *   - "Finish later" leaves at any step, and the dashboard offers the way
 *     back in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SetupWizardGate, SetupWizardPage } from '../pages/admin/SetupWizard.js';
import { Dashboard } from '../pages/Dashboard.js';
import { commissionExample } from '../lib/commission-example.js';

const DAY = 86_400_000;

interface Program {
  id: string;
  name: string;
  destinationUrl: string;
  commissionRule: unknown;
  attributionWindowDays: number;
  recruiterCommissionPercent: string | null;
  shareOnNetwork: boolean;
  marketplaceDescription: string | null;
  createdAt: string;
}

let wizard: { available: boolean; redirect: boolean; completedAt: string | null; exitedAt: string | null; step: number; programId: string | null; hints: { percent: string; fixed: string } };
let onboarding: { networkConnected: boolean; networkListingSkipped: boolean; trackingInstalled: boolean; approvalStatus: 'pending' | 'approved' };
let programs: Program[];
let billing: Record<string, unknown>;
/** Every write, in order: "METHOD path" and its body. */
let writes: Array<[string, Record<string, unknown>]>;
/** Flip `billing.subscribed` after this many status reads (the webhook landing). */
let subscribeAfterReads: number | null;
let billingReads: number;

function json(code: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
}

function existingProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p1',
    name: 'Acme partner program',
    destinationUrl: 'https://acme.test',
    commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
    attributionWindowDays: 60,
    recruiterCommissionPercent: null,
    shareOnNetwork: false,
    marketplaceDescription: null,
    createdAt: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  wizard = { available: true, redirect: true, completedAt: null, exitedAt: null, step: 0, programId: null, hints: { percent: 'Most SaaS programs pay 20–30%.', fixed: 'Flat hint.' } };
  onboarding = { networkConnected: false, networkListingSkipped: false, trackingInstalled: false, approvalStatus: 'pending' };
  programs = [];
  billing = {
    mode: 'revshare',
    plan: null,
    subscribed: false,
    trialEndsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    collection: { method: 'charge_automatically', gstin: null, gstinRequired: false },
  };
  writes = [];
  subscribeAfterReads = null;
  billingReads = 0;
  // jsdom doesn't navigate; the wizard only needs the assignment not to throw.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push([`${method} ${path}`, body]);

    if (path === '/config/program') return json(200, { programName: 'Acme', defaultCurrency: 'USD', whiteLabel: false, routerUrl: null });
    if (path === '/branding') return json(200, { tenantSlug: 'acme' });
    if (path === '/admin/onboarding-status') {
      return json(200, { ...onboarding, campaignCount: programs.length, complete: false, wizard: { ...wizard, programId: programs[0]?.id ?? null } });
    }
    if (path === '/config/onboarding' && method === 'POST') {
      if (typeof body.wizardStep === 'number') wizard.step = Math.max(wizard.step, body.wizardStep);
      if (body.wizardExited !== undefined) wizard.exitedAt = body.wizardExited ? 'now' : null;
      if (body.wizardCompleted) wizard = { ...wizard, completedAt: 'now', available: false };
      if (body.networkListingSkipped !== undefined) onboarding.networkListingSkipped = body.networkListingSkipped;
      wizard.redirect = wizard.available && !wizard.exitedAt;
      return json(200, {});
    }
    if (path === '/programs' && method === 'GET') return json(200, { programs });
    if (path === '/programs' && method === 'POST') {
      const made = existingProgram({ ...body, recruiterCommissionPercent: null, attributionWindowDays: 60 });
      programs = [made];
      return json(201, made);
    }
    if (path === '/programs/p1' && method === 'PATCH') {
      programs = [
        {
          ...programs[0]!,
          ...body,
          ...(body.recruiterCommissionPercent !== undefined
            ? { recruiterCommissionPercent: body.recruiterCommissionPercent == null ? null : Number(body.recruiterCommissionPercent).toFixed(2) }
            : {}),
        },
      ];
      return json(200, programs[0]);
    }
    if (path === '/billing/status') {
      billingReads += 1;
      if (subscribeAfterReads !== null && billingReads > subscribeAfterReads) {
        billing = { ...billing, subscribed: true, trialEnd: Math.floor(Date.parse(String(billing.trialEndsAt)) / 1000) };
      }
      return json(200, billing);
    }
    if (path === '/billing/plan' && method === 'POST') {
      billing = { ...billing, plan: body.plan };
      return json(200, { ok: true, plan: body.plan });
    }
    if (path === '/billing/tax-details' && method === 'PUT') {
      billing = { ...billing, collection: { ...(billing.collection as object), gstin: body.gstin } };
      return json(200, { ok: true });
    }
    if (path === '/billing/checkout' && method === 'POST') return json(200, { url: 'https://checkout.stripe.com/test' });
    if (path === '/admin/tracking-health/send-to-developer' && method === 'POST') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWizard(entry = '/setup') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/" element={<div>the dashboard</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const next = (name = 'Continue') => fireEvent.click(screen.getByRole('button', { name }));
const heading = (name: string) => screen.findByRole('heading', { name });
const sent = (key: string) => writes.filter(([k]) => k === key).map(([, b]) => b);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const example = () => within(screen.getByTestId('commission-example'));

describe('commissionExample', () => {
  it('pays the recruiter on top of the partner, never out of it', () => {
    expect(commissionExample({ type: 'percent', value: 20, recruiterPercent: 10 })).toEqual({ sale: 10_000, partner: 2000, recruiter: 200, total: 2200 });
    expect(commissionExample({ type: 'percent', value: 20, recruiterPercent: null })).toEqual({ sale: 10_000, partner: 2000, recruiter: 0, total: 2000 });
    expect(commissionExample({ type: 'fixed', value: 50, recruiterPercent: 12.5 })).toEqual({ sale: 10_000, partner: 5000, recruiter: 625, total: 5625 });
    expect(commissionExample({ type: 'percent', value: Number.NaN, recruiterPercent: 10 }).total).toBe(0);
  });
});

describe('setup wizard', () => {
  it('walks a new brand from program to dashboard on Revshare, with no card', async () => {
    renderWizard();

    // 1. Program
    await heading('Your program');
    expect((screen.getByLabelText('Program name') as HTMLInputElement).value).toBe('Acme partner program');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    type('Product URL', 'acme.test');
    expect(screen.getByText('Enter a full URL, starting with https://')).toBeTruthy();
    type('Product URL', 'https://acme.test');
    next();

    // 2. Commission: two-tier on at 10%, and the brand's total says so.
    await heading('Commission');
    // The start stamp went first, then the program, private and on the default rule.
    expect(writes.slice(0, 2)).toEqual([
      ['POST /config/onboarding', { wizardStep: 1, wizardStarted: true }],
      [
        'POST /programs',
        {
          name: 'Acme partner program',
          destinationUrl: 'https://acme.test',
          commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }],
          shareOnNetwork: false,
        },
      ],
    ]);
    expect(screen.getByText('Most SaaS programs pay 20–30%.')).toBeTruthy();
    expect((screen.getByLabelText('Recruiter commission') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Recruiter’s share (%)') as HTMLInputElement).value).toBe('10');
    expect(example().getByText('On a $100.00 sale')).toBeTruthy();
    expect(example().getByText('$20.00')).toBeTruthy();
    expect(example().getByText('$2.00')).toBeTruthy();
    expect(example().getByText('$22.00')).toBeTruthy();

    // Off: the recruiter's row goes, and the total is the commission alone.
    fireEvent.click(screen.getByLabelText('Recruiter commission'));
    expect(example().queryByText('Recruiter’s share')).toBeNull();
    expect(example().getAllByText('$20.00')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Recruiter commission'));

    type('Percent', '25');
    expect(example().getByText('$25.00')).toBeTruthy();
    expect(example().getByText('$2.50')).toBeTruthy();
    expect(example().getByText('$27.50')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Attribution window'), { target: { value: '90' } });
    next();

    // 3. Tracking
    await heading('Tracking');
    expect(sent('PATCH /programs/p1')[0]).toEqual({
      commissionRule: [{ trigger: 'every', type: 'percent', value: 25, recurring: true }],
      attributionWindowDays: 90,
      recruiterCommissionPercent: 10,
      recruiterCommissionMonths: null,
    });
    expect(screen.getByLabelText('Tracking script tag').textContent).toBe(
      '<script src="http://localhost:3000/op.js" data-api-url="http://localhost:3000/api"></script>',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send to a developer' }));
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    type('Developer’s email', 'dev@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent to dev@example.com.')).toBeTruthy();
    expect(sent('POST /admin/tracking-health/send-to-developer')).toEqual([{ email: 'dev@example.com' }]);
    // Nothing here is required to go on.
    next();

    // 5. Plan (this brand isn't on the Network: no marketplace step)
    await heading('Plan');
    expect(screen.queryByText('Marketplace')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('Enterprise')).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Revshare/));
    expect(screen.getByText('No card now. You’ll add one before your first partner joins.')).toBeTruthy();
    next();

    // Recap
    await heading('You’re set up');
    expect(sent('POST /billing/plan')).toEqual([{ plan: 'revshare' }]);
    expect(sent('POST /billing/checkout')).toEqual([]);
    expect(screen.getByText('25% on every payment')).toBeTruthy();
    expect(screen.getByText('10% of a recruit’s commissions')).toBeTruthy();
    expect(screen.getByText('Not verified yet')).toBeTruthy();
    expect(screen.getByText('Revshare, add a card before your first partner')).toBeTruthy();
    expect(screen.getByText(/We’re reviewing your brand/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finish later' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }));
    expect(await screen.findByText('the dashboard')).toBeTruthy();
    expect(sent('POST /config/onboarding').at(-1)).toEqual({ wizardCompleted: true });
    expect(sent('POST /config/onboarding').map((b) => b.wizardStep).filter(Boolean)).toEqual([1, 2, 3, 5]);
  });

  it('resumes after the last saved step, with what was saved', async () => {
    programs = [existingProgram({ recruiterCommissionPercent: null })];
    wizard.step = 2;
    renderWizard();
    await heading('Tracking');

    // Back to a step saved with two-tier off: it stays off.
    next('Back');
    await heading('Commission');
    expect((screen.getByLabelText('Recruiter commission') as HTMLInputElement).checked).toBe(false);
    expect(example().queryByText('Recruiter’s share')).toBeNull();
    next('Back');
    await heading('Your program');
    expect((screen.getByLabelText('Product URL') as HTMLInputElement).value).toBe('https://acme.test');
    next();
    await heading('Commission');
    // An existing program is edited, never created twice.
    expect(sent('POST /programs')).toEqual([]);
    expect(sent('PATCH /programs/p1')).toEqual([{ name: 'Acme partner program', destinationUrl: 'https://acme.test' }]);
  });

  it('leaves custom rules from the Programs page alone', async () => {
    programs = [
      existingProgram({
        commissionRule: [
          { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
          { trigger: 'every', type: 'percent', value: 20, recurring: true },
        ],
      }),
    ];
    wizard.step = 1;
    renderWizard();
    await heading('Commission');
    expect(screen.getByText(/custom commission rules/)).toBeTruthy();
    next();
    await heading('Tracking');
    expect(sent('PATCH /programs/p1')[0]).toEqual({ attributionWindowDays: 60, recruiterCommissionPercent: 10, recruiterCommissionMonths: null });
  });

  it('marketplace: listing needs a description; private is the checklist’s "Not now"', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    onboarding.networkConnected = true;
    renderWizard();
    await heading('Marketplace');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Goes live once your brand is approved and your tracking is verified.')).toBeTruthy();
    type('What creators should know', 'Accounting for bakeries.');
    next();
    await heading('Plan');
    expect(sent('PATCH /programs/p1')).toEqual([{ shareOnNetwork: true, marketplaceDescription: 'Accounting for bakeries.' }]);
    expect(sent('POST /config/onboarding').at(-1)).toEqual({ wizardStep: 4, networkListingSkipped: false });

    next('Back');
    await heading('Marketplace');
    fireEvent.click(screen.getByLabelText(/^Keep it private/));
    next();
    await heading('Plan');
    expect(sent('PATCH /programs/p1').at(-1)).toEqual({ shareOnNetwork: false });
    expect(sent('POST /config/onboarding').at(-1)).toEqual({ wizardStep: 4, networkListingSkipped: true });
  });

  it('Flex: the plan from sign-up is preselected and goes to Stripe, first charge at the trial’s end', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex' };
    renderWizard();
    await heading('Plan');
    expect((screen.getByLabelText(/^Flex/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Card required\. First charge on .*, when your free trial ends\./)).toBeTruthy();

    next('Continue to Stripe');
    await waitFor(() => expect(sent('POST /billing/checkout')).toHaveLength(1));
    expect(sent('POST /billing/plan')).toEqual([{ plan: 'flex' }]);
    expect(sent('POST /billing/checkout')[0]).toEqual({
      successUrl: 'http://localhost:3000/setup?checkout=success',
      cancelUrl: 'http://localhost:3000/setup?checkout=cancelled',
    });
    // The step isn't marked done until Checkout is: backing out returns here.
    expect(sent('POST /config/onboarding').some((b) => b.wizardStep === 5)).toBe(false);
  });

  it('Flex with the trial nearly over says the card is charged today', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex', trialEndsAt: new Date(Date.now() + DAY).toISOString() };
    renderWizard();
    await heading('Plan');
    expect(screen.getByText('Card required. Your first month is charged today.')).toBeTruthy();
  });

  it('a cancelled Checkout comes back to the plan step: retry, or switch to Revshare', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex' };
    renderWizard('/setup?checkout=cancelled');
    await heading('Plan');
    expect(screen.getByText(/Checkout wasn’t completed, and nothing was charged/)).toBeTruthy();
    expect((screen.getByLabelText(/^Flex/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Continue to Stripe' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/^Revshare/));
    next();
    await heading('You’re set up');
    expect(sent('POST /billing/plan')).toEqual([{ plan: 'revshare' }]);
    expect(sent('POST /billing/checkout')).toEqual([]);
  });

  it('a completed Checkout comes back to the recap and waits for the subscription to show', async () => {
    programs = [existingProgram({ recruiterCommissionPercent: '10.00' })];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex' };
    subscribeAfterReads = 1;
    renderWizard('/setup?checkout=success');
    await heading('You’re set up');
    expect(screen.getByText('Flex, confirming your payment method…')).toBeTruthy();
    expect(await screen.findByText(/^Flex, first charge on /, {}, { timeout: 6000 })).toBeTruthy();
    expect(sent('POST /config/onboarding')).toContainEqual({ wizardStep: 5 });
    // Subscribed: the plan is no longer the wizard's to change.
    const rows = screen.getAllByRole('button', { name: 'Edit' });
    expect(rows).toHaveLength(4);
  }, 10_000);

  it('a brand already subscribed sees its plan, not the picker', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex', subscribed: true, trialEnd: Math.floor((Date.now() + 10 * DAY) / 1000) };
    renderWizard();
    await heading('Plan');
    expect(screen.getByText(/Flex plan active\. First charge on /)).toBeTruthy();
    expect(screen.queryByLabelText(/^Revshare/)).toBeNull();
    next();
    await heading('You’re set up');
    expect(sent('POST /billing/plan')).toEqual([]);
  });

  it('an Indian brand paying by card gives its GSTIN before Stripe', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, mode: 'flat', plan: 'flex', collection: { method: 'charge_automatically', gstin: null, gstinRequired: true } };
    renderWizard();
    await heading('Plan');
    expect(screen.getByRole('button', { name: 'Continue to Stripe' }).hasAttribute('disabled')).toBe(true);
    type('GSTIN', '27aapfu0939f1zv');
    next('Continue to Stripe');
    await waitFor(() => expect(sent('POST /billing/checkout')).toHaveLength(1));
    expect(writes.map(([k]) => k)).toEqual(['POST /billing/plan', 'PUT /billing/tax-details', 'POST /billing/checkout']);
    expect(sent('PUT /billing/tax-details')).toEqual([{ gstin: '27AAPFU0939F1ZV' }]);
  });

  it('a pay-by-invoice brand picks its plan and is sent to Billing to start it: no Checkout', async () => {
    programs = [existingProgram()];
    wizard.step = 3;
    billing = { ...billing, collection: { method: 'send_invoice', gstin: null, gstinRequired: true } };
    renderWizard();
    await heading('Plan');
    fireEvent.click(screen.getByLabelText(/^Flex/));
    expect(screen.getByText('Billed by invoice. Start the plan from Billing when you’re ready.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to Stripe' })).toBeNull();
    type('GSTIN', '27AAPFU0939F1ZV');
    next();
    await heading('You’re set up');
    expect(sent('POST /billing/checkout')).toEqual([]);
    expect(screen.getByText('Flex, start it from Billing')).toBeTruthy();
  });

  it('"Finish later" leaves from any step and stays left', async () => {
    programs = [existingProgram()];
    wizard.step = 1;
    renderWizard();
    await heading('Commission');
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }));
    expect(await screen.findByText('the dashboard')).toBeTruthy();
    expect(sent('POST /config/onboarding')).toEqual([{ wizardExited: true }]);
    // Nothing on the step was saved by leaving.
    expect(sent('PATCH /programs/p1')).toEqual([]);
  });

  it('coming back after "Finish later" takes the wizard up again', async () => {
    programs = [existingProgram()];
    wizard = { ...wizard, step: 1, exitedAt: 'earlier', redirect: false };
    renderWizard();
    await heading('Commission');
    await waitFor(() => expect(sent('POST /config/onboarding')).toEqual([{ wizardExited: false }]));
  });

  it('an edit from the recap returns to the recap', async () => {
    programs = [existingProgram({ recruiterCommissionPercent: '10.00' })];
    wizard.step = 5;
    billing = { ...billing, plan: 'revshare' };
    renderWizard();
    await heading('You’re set up');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    await heading('Your program');
    type('Program name', 'Acme Partners');
    next();
    await heading('You’re set up');
    expect(screen.getByText('Acme Partners')).toBeTruthy();
  });

  it('sends a brand the wizard isn’t for to the dashboard', async () => {
    programs = [existingProgram()];
    wizard = { ...wizard, available: false, redirect: false };
    renderWizard();
    expect(await screen.findByText('the dashboard')).toBeTruthy();
    expect(writes).toEqual([]);
  });
});

describe('the dashboard and the wizard', () => {
  function renderGate(enabled: boolean) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MemoryRouter initialEntries={['/']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/setup" element={<div>the wizard</div>} />
            <Route
              path="/"
              element={
                <SetupWizardGate enabled={enabled}>
                  <div>the dashboard</div>
                </SetupWizardGate>
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('a new brand lands in the wizard instead of the dashboard', async () => {
    renderGate(true);
    expect(await screen.findByText('the wizard')).toBeTruthy();
  });

  it('a brand that left it, a partner and a view-only seat get the dashboard', async () => {
    wizard = { ...wizard, exitedAt: 'earlier', redirect: false };
    renderGate(true);
    expect(await screen.findByText('the dashboard')).toBeTruthy();
    cleanup();

    wizard = { ...wizard, exitedAt: null, redirect: true };
    renderGate(false);
    expect(await screen.findByText('the dashboard')).toBeTruthy();
  });

  it('an API that fails or predates the wizard shows the dashboard', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/admin/onboarding-status') ? json(500, { error: 'boom' }) : real(input, init)) as typeof fetch;
    renderGate(true);
    expect(await screen.findByText('the dashboard')).toBeTruthy();
  });

  it('the Getting started card offers "Continue setup" while the wizard is unfinished', async () => {
    wizard = { ...wizard, exitedAt: 'earlier', redirect: false, step: 2 };
    programs = [existingProgram()];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <Dashboard principal={{ role: 'admin' }} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: 'Continue setup' });
    expect(button.closest('a')?.getAttribute('href')).toBe('/setup');
    cleanup();

    wizard = { ...wizard, available: false, completedAt: 'now' };
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
          <Dashboard principal={{ role: 'admin' }} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Getting started')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue setup' })).toBeNull();
  });
});
