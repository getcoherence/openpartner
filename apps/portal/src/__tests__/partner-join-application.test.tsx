// @vitest-environment jsdom
/**
 * Public join page: applicants can't apply without a complete application
 * (website, 1–5 socials, audience size, 40+ character pitch). The form
 * mirrors POST /partner-signup's rules and keeps Apply disabled until they
 * pass; a 400 invalid_body surfaces the API's own messages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PartnerJoinPage, validateJoinForm, type JoinFormValues } from '../pages/PartnerJoin.js';

const PITCH = 'I review design tools weekly on YouTube and would build a full walkthrough.';

const VALID: JoinFormValues = {
  name: 'Ada',
  email: 'ada@example.com',
  websiteUrl: 'https://ada.example',
  socialUrls: ['https://youtube.com/@ada'],
  audienceSize: '10k_50k',
  pitch: PITCH,
};

describe('validateJoinForm mirrors the API', () => {
  it('accepts a complete application and normalizes it', () => {
    const { errors, application } = validateJoinForm({
      ...VALID,
      websiteUrl: '  https://ada.example ',
      socialUrls: [' https://youtube.com/@ada', '', 'https://youtube.com/@ada', 'https://x.com/ada'],
      pitch: `  ${PITCH}  `,
    });
    expect(errors).toEqual({});
    expect(application).toEqual({
      websiteUrl: 'https://ada.example',
      socialUrls: ['https://youtube.com/@ada', 'https://x.com/ada'],
      audienceSize: '10k_50k',
      pitch: PITCH,
    });
  });

  it.each<[string, Partial<JoinFormValues>, keyof JoinFormValues]>([
    ['a short pitch', { pitch: 'Too short.' }, 'pitch'],
    ['a pitch over 1000 characters', { pitch: 'x'.repeat(1001) }, 'pitch'],
    ['no socials', { socialUrls: ['', '  '] }, 'socialUrls'],
    ['six socials', { socialUrls: [1, 2, 3, 4, 5, 6].map((n) => `https://s${n}.example`) }, 'socialUrls'],
    ['a social without a scheme', { socialUrls: ['instagram.com/ada'] }, 'socialUrls'],
    ['a javascript: website', { websiteUrl: 'javascript:alert(1)' }, 'websiteUrl'],
    ['no audience size', { audienceSize: '' }, 'audienceSize'],
    ['a bad email', { email: 'ada@' }, 'email'],
  ])('rejects %s', (_label, patch, field) => {
    const { errors, application } = validateJoinForm({ ...VALID, ...patch });
    expect(errors[field]).toBeTruthy();
    expect(application).toBeNull();
  });
});

interface Sent {
  url: string;
  body: unknown;
}
let sent: Sent[] = [];
let respond: () => Response = () => json(201, { ok: true, status: 'active', partnerId: 'p1' });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sent = [];
  respond = () => json(201, { ok: true, status: 'active', partnerId: 'p1' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return respond();
  }) as typeof fetch;
});
afterEach(cleanup);

function renderJoin(
  status: { open: boolean; reviewRequired: boolean; countryRequired?: boolean } | null = { open: true, reviewRequired: false },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // GET /partner-signup/status; null = let the page fetch it.
  if (status) qc.setQueryData(['partner-signup-status', null], status);
  qc.setQueryData(['public-branding', null], {
    tenantSlug: 'acme',
    programName: 'Acme',
    logoUrl: null,
    faviconUrl: null,
    brandColor: null,
    supportEmail: null,
    programTermsUrl: null,
    whiteLabel: false,
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <PartnerJoinPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('PartnerJoinPage', () => {
  it('keeps Apply disabled until every answer is valid, then posts the application', async () => {
    const page = renderJoin();
    const apply = page.getByRole('button', { name: 'Apply to join' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(page.getByPlaceholderText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('you@example.com'), { target: { value: 'Ada@Example.com' } });
    const website = page.getByLabelText('Website or main channel');
    fireEvent.change(website, { target: { value: 'ada.example' } });
    fireEvent.blur(website);
    // A missing scheme is filled in rather than rejected.
    expect((website as HTMLInputElement).value).toBe('https://ada.example');
    fireEvent.change(page.getByLabelText('Social profile 1'), { target: { value: 'https://youtube.com/@ada' } });
    fireEvent.change(page.getByLabelText('Audience size'), { target: { value: '10k_50k' } });
    expect(apply.disabled).toBe(true);

    const pitch = page.getByLabelText('How would you promote Acme?');
    fireEvent.change(pitch, { target: { value: 'Short pitch' } });
    expect(page.getByTestId('pitch-hint').textContent).toBe('11/40 characters minimum');
    fireEvent.blur(pitch);
    expect(page.getByText('Write at least 40 characters')).toBeTruthy();
    expect(apply.disabled).toBe(true);

    fireEvent.change(pitch, { target: { value: PITCH } });
    expect(page.getByTestId('pitch-hint').textContent).toBe(`${PITCH.length}/1000 characters`);
    expect(apply.disabled).toBe(false);

    fireEvent.click(apply);
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/api/partner-signup');
    expect(sent[0]!.body).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      application: {
        websiteUrl: 'https://ada.example',
        socialUrls: ['https://youtube.com/@ada'],
        audienceSize: '10k_50k',
        pitch: PITCH,
      },
    });
  });

  it('adds social rows up to five, and a bad one blocks Apply', () => {
    const page = renderJoin();
    for (let i = 0; i < 4; i++) fireEvent.click(page.getByRole('button', { name: /Add another/ }));
    expect(page.getByLabelText('Social profile 5')).toBeTruthy();
    expect(page.queryByRole('button', { name: /Add another/ })).toBeNull();

    const bad = page.getByLabelText('Social profile 2');
    fireEvent.change(bad, { target: { value: '@ada' } });
    fireEvent.blur(bad);
    expect(page.getByText('Each profile must be a full link, starting with https://')).toBeTruthy();

    fireEvent.click(page.getByRole('button', { name: 'Remove social profile 2' }));
    expect(page.queryByLabelText('Social profile 5')).toBeNull();
    expect(page.queryByText('Each profile must be a full link, starting with https://')).toBeNull();
  });

  it('shows the API’s messages when it rejects the body', async () => {
    respond = () =>
      json(400, {
        error: 'invalid_body',
        detail: { formErrors: [], fieldErrors: { application: ['Pick your audience size'] } },
      });
    const page = renderJoin();
    fireEvent.change(page.getByPlaceholderText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('you@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.getByLabelText('Website or main channel'), { target: { value: 'https://ada.example' } });
    fireEvent.change(page.getByLabelText('Social profile 1'), { target: { value: 'https://youtube.com/@ada' } });
    fireEvent.change(page.getByLabelText('Audience size'), { target: { value: 'over_1m' } });
    fireEvent.change(page.getByLabelText('How would you promote Acme?'), { target: { value: PITCH } });
    fireEvent.click(page.getByRole('button', { name: 'Apply to join' }));
    await waitFor(() => expect(page.getByRole('alert').textContent).toBe('Please check your answers: Pick your audience size.'));
  });
});

describe('PartnerJoinPage signup status', () => {
  it('shows "Signups are closed" on load when the program is closed, before any form', async () => {
    respond = () => json(200, { open: false, reviewRequired: false });
    const page = renderJoin(null);
    await waitFor(() => expect(page.getByText('Signups are closed')).toBeTruthy());
    expect(page.queryByLabelText('Website or main channel')).toBeNull();
    expect(sent.map((c) => c.url)).toEqual(['/api/partner-signup/status']);
  });

  it('says up front that applications are reviewed', () => {
    const page = renderJoin({ open: true, reviewRequired: true });
    expect(page.getByText(/Acme reviews each application before you can sign in./)).toBeTruthy();
    expect(page.getByLabelText('Website or main channel')).toBeTruthy();
  });

  it('still shows the form when the status check fails', async () => {
    respond = () => json(404, { error: 'not_found' });
    const page = renderJoin(null);
    await waitFor(() => expect(page.getByLabelText('Website or main channel')).toBeTruthy());
  });
});

describe('PartnerJoinPage country (hosted platform)', () => {
  function fillApplication(page: ReturnType<typeof renderJoin>) {
    fireEvent.change(page.getByPlaceholderText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(page.getByPlaceholderText('you@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(page.getByLabelText('Website or main channel'), { target: { value: 'https://ada.example' } });
    fireEvent.change(page.getByLabelText('Social profile 1'), { target: { value: 'https://youtube.com/@ada' } });
    fireEvent.change(page.getByLabelText('Audience size'), { target: { value: '10k_50k' } });
    fireEvent.change(page.getByLabelText('How would you promote Acme?'), { target: { value: PITCH } });
  }

  it('does not ask on a self-hosted install', () => {
    const page = renderJoin({ open: true, reviewRequired: false });
    expect(page.queryByLabelText('Where are you based?')).toBeNull();
  });

  it('requires a country, asks Ukrainians to confirm, and sends both', async () => {
    const page = renderJoin({ open: true, reviewRequired: false, countryRequired: true });
    fillApplication(page);
    const apply = page.getByRole('button', { name: 'Apply to join' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(page.getByLabelText('Where are you based?'), { target: { value: 'UA' } });
    expect(apply.disabled).toBe(true);
    fireEvent.click(page.getByRole('checkbox', { name: /occupied areas/ }));
    expect(apply.disabled).toBe(false);

    fireEvent.click(apply);
    await waitFor(() => expect(page.getByText('Check your inbox')).toBeTruthy());
    expect(sent[0]!.body).toMatchObject({ country: 'UA', outsideOccupiedRegions: true });
  });

  it('says plainly when the country is not served', async () => {
    respond = () => json(403, { error: 'country_not_supported' });
    const page = renderJoin({ open: true, reviewRequired: false, countryRequired: true });
    fillApplication(page);
    fireEvent.change(page.getByLabelText('Where are you based?'), { target: { value: 'DE' } });
    fireEvent.click(page.getByRole('button', { name: 'Apply to join' }));
    await waitFor(() => expect(page.getByText("Sorry — OpenPartner isn't available in your country.")).toBeTruthy());
  });
});
