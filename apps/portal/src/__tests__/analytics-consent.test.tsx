// @vitest-environment jsdom
/**
 * PostHog runs with the visitor's opt-in where consent comes first (GET
 * /api/consent-region says opt_in, fails or times out), and until they
 * decline everywhere else. The choice is stored under localStorage
 * "op_consent_v2" as { choice, at } for 12 months, and a v1 Decline still
 * counts; GPC / Do Not Track count as Decline; whenever PostHog isn't
 * running, every load clears ph_* / __ph_* cookies and storage; a build
 * without VITE_POSTHOG_KEY shows no banner at all.
 *
 * jsdom doesn't execute injected <script> text, so "PostHog loaded" here
 * means the snippet tag was added to <head> and init() reached a stubbed
 * window.posthog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CONSENT_MAX_AGE_MS,
  CONSENT_STORAGE_KEY,
  PREVIOUS_CONSENT_KEYS,
  clearAnalyticsStorage,
  cookieDomains,
  readConsent,
  writeConsent,
} from '../lib/consent.js';

type Nav = Navigator & { globalPrivacyControl?: boolean };

const snippetTags = () =>
  [...document.head.querySelectorAll('script')].filter((s) => s.text.includes('posthog'));

const cookieNames = () =>
  document.cookie
    .split(';')
    .map((c) => c.split('=')[0]!.trim())
    .filter(Boolean);

function clearCookies() {
  for (const name of cookieNames()) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

/** GET /api/consent-region answering with `rule`. */
const regionFetch = (rule: string) => vi.fn(async () => ({ ok: true, json: async () => ({ rule, country: 'XX' }) }));

/**
 * A fresh posthog.ts (its import runs the startup check) + banner, with a
 * key set. The region lookup answers opt_in unless `fetch` says otherwise.
 */
async function boot({ key = 'phc_test', fetch = regionFetch('opt_in') }: { key?: string | null; fetch?: unknown } = {}) {
  vi.resetModules();
  if (key) vi.stubEnv('VITE_POSTHOG_KEY', key);
  else vi.stubEnv('VITE_POSTHOG_KEY', '');
  vi.stubGlobal('fetch', fetch);
  const posthog = await import('../posthog.js');
  const ui = await import('../lib/ConsentBanner.js');
  return { posthog, ...ui };
}

const banner = () => screen.queryByRole('region', { name: 'Cookie consent' });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearCookies();
  for (const s of snippetTags()) s.remove();
  delete (window as { posthog?: unknown }).posthog;
  delete (navigator as Nav).globalPrivacyControl;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (navigator as Nav).globalPrivacyControl;
  delete (navigator as { doNotTrack?: unknown }).doNotTrack;
});

describe('consent store', () => {
  it('reads back a fresh choice and forgets it after 12 months', () => {
    expect(readConsent()).toBeNull();
    writeConsent('granted', 1_000);
    expect(JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY)!)).toEqual({ choice: 'granted', at: 1_000 });
    expect(readConsent(1_000 + CONSENT_MAX_AGE_MS - 1)).toBe('granted');
    expect(readConsent(1_000 + CONSENT_MAX_AGE_MS)).toBeNull();
  });

  it('keeps a Decline stored under an older key and asks again after an older Accept', () => {
    const [v1] = PREVIOUS_CONSENT_KEYS;
    window.localStorage.setItem(v1!, JSON.stringify({ choice: 'denied', at: Date.now() }));
    expect(readConsent()).toBe('denied');
    window.localStorage.setItem(v1!, JSON.stringify({ choice: 'granted', at: Date.now() }));
    expect(readConsent()).toBeNull();
    // An expired older Decline is no choice, and the current key wins.
    window.localStorage.setItem(v1!, JSON.stringify({ choice: 'denied', at: Date.now() - CONSENT_MAX_AGE_MS }));
    expect(readConsent()).toBeNull();
    window.localStorage.setItem(v1!, JSON.stringify({ choice: 'denied', at: Date.now() }));
    writeConsent('granted');
    expect(readConsent()).toBe('granted');
  });

  it('treats malformed or unreadable storage as no choice', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, '{not json');
    expect(readConsent()).toBeNull();
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ choice: 'maybe', at: Date.now() }));
    expect(readConsent()).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readConsent()).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeConsent('denied')).not.toThrow();
  });

  it('covers the host, .host and every parent domain', () => {
    expect(cookieDomains('app.openpartner.dev')).toEqual(['', 'app.openpartner.dev', '.app.openpartner.dev', '.openpartner.dev']);
    expect(cookieDomains('partners.brand.co.uk')).toEqual([
      '',
      'partners.brand.co.uk',
      '.partners.brand.co.uk',
      '.brand.co.uk',
      '.co.uk',
    ]);
    expect(cookieDomains('localhost')).toEqual(['', 'localhost', '.localhost']);
  });

  it('clears only PostHog cookies and storage keys', () => {
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    document.cookie = '__ph_opt_in_out_phc_test=0;path=/';
    document.cookie = 'op_session_hint=1;path=/';
    window.localStorage.setItem('ph_phc_test_posthog', '{}');
    window.localStorage.setItem('__ph_opt_in_out_phc_test', '0');
    window.localStorage.setItem('op-theme', 'light');
    writeConsent('denied');
    window.sessionStorage.setItem('ph_phc_test_window_id', 'w');

    clearAnalyticsStorage();

    expect(cookieNames()).toEqual(['op_session_hint']);
    expect(Object.keys(window.localStorage).sort()).toEqual(['op-theme', CONSENT_STORAGE_KEY].sort());
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('event scrubbing', () => {
  it('drops query strings and fragments from every URL PostHog would send', async () => {
    const { posthog } = await boot();
    const event = posthog.scrubAnalyticsEvent({
      properties: {
        $current_url: 'https://app.openpartner.dev/t/acme/auth/magic?token=secret#x',
        $pathname: '/t/acme/auth/magic',
        $referrer: '$direct',
        $elements_chain: 'a:attr__href="/t/acme/payouts?partnerId=p_1"nth-child="1"',
        $set_once: { $initial_current_url: 'https://app.openpartner.dev/signup?ref=abc' },
        count: 3,
      },
      $set: { $current_url: 'https://partners.brand.com/?invitation=inv_1' },
    })!;
    expect(event.properties).toEqual({
      $current_url: 'https://app.openpartner.dev/t/acme/auth/magic',
      $pathname: '/t/acme/auth/magic',
      $referrer: '$direct',
      $elements_chain: 'a:attr__href="/t/acme/payouts"nth-child="1"',
      $set_once: { $initial_current_url: 'https://app.openpartner.dev/signup' },
      count: 3,
    });
    expect(event.$set).toEqual({ $current_url: 'https://partners.brand.com/' });
    expect(posthog.scrubAnalyticsEvent(null)).toBeNull();
  });

  it('drops query strings from the request and page URLs a replay keeps', async () => {
    const { posthog } = await boot();
    expect(
      posthog.scrubRecordedRequest({ name: 'https://app.openpartner.dev/t/acme/auth/magic?token=secret#x', isInitial: true }),
    ).toEqual({ name: 'https://app.openpartner.dev/t/acme/auth/magic', isInitial: true });
    expect(posthog.scrubRecordedRequest({ name: '/api/partners?email=a%40b.com' })).toEqual({ name: '/api/partners' });
    expect(posthog.scrubRecordedRequest(null)).toBeNull();
  });

  it('captures nothing on a shared booking report', async () => {
    const { posthog } = await boot();
    const event = { properties: { $current_url: 'https://app.openpartner.dev/reports' } };
    window.history.pushState({}, '', '/reports');
    expect(posthog.dropUntrackedPages(event)).toBeNull();
    window.history.pushState({}, '', '/creators/ada');
    expect(posthog.dropUntrackedPages(event)).toBe(event);
  });

  it('records no replay on a page load that starts on a shared booking report', async () => {
    const init = vi.fn();
    (window as { posthog?: unknown }).posthog = { init, opt_out_capturing: vi.fn() };
    writeConsent('granted');
    window.history.pushState({}, '', '/reports');
    try {
      await boot();
      expect(init.mock.calls[0]![1]).toMatchObject({ disable_session_recording: true });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('consent banner', () => {
  it('asks first where the region needs consent and loads nothing until Accept', async () => {
    const init = vi.fn();
    (window as { posthog?: unknown }).posthog = { init, opt_out_capturing: vi.fn() };
    const fetch = regionFetch('opt_in');
    const { ConsentBanner } = await boot({ fetch });
    render(<ConsentBanner />);

    expect(await screen.findByRole('region', { name: 'Cookie consent' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/consent-region', expect.objectContaining({ credentials: 'omit' }));
    // Every page shows it, a creator's first visit and white-label portals
    // too: it names neither a page nor us.
    expect(screen.getByText(/Can we use analytics cookies and session replays to see how this site is used/)).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
    expect(init).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(readConsent()).toBe('granted');
    expect(banner()).toBeNull();
    expect(snippetTags()).toHaveLength(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]![0]).toBe('phc_test');
    const config = init.mock.calls[0]![1] as Record<string, unknown>;
    expect(config).toMatchObject({
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: false,
      session_recording: { maskAllInputs: true, maskTextSelector: '*', recordHeaders: false, recordBody: false },
    });
  });

  it.each([
    ['an error status', vi.fn(async () => ({ ok: false, json: async () => ({ rule: 'opt_out' }) }))],
    ['a network failure', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')))],
    ['a malformed body', vi.fn(async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError('bad')) }))],
  ])('%s from the region lookup asks first', async (_name, fetch) => {
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const { ConsentBanner } = await boot({ fetch });
    render(<ConsentBanner />);
    expect(await screen.findByRole('region', { name: 'Cookie consent' })).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
  });

  it('a region lookup with no answer in 1.5 s asks first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const { ConsentBanner } = await boot({ fetch });
    render(<ConsentBanner />);
    await act(() => vi.advanceTimersByTimeAsync(1_499));
    expect(banner()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(banner()).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
  });

  it('elsewhere loads with no banner, keeps its cookie, and Cookie settings says it is on', async () => {
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const init = vi.fn();
    (window as { posthog?: unknown }).posthog = { init, opt_out_capturing: vi.fn() };
    const { posthog, ConsentBanner, CookieSettingsButton } = await boot({ fetch: regionFetch('opt_out') });
    render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );

    await vi.waitFor(() => expect(snippetTags()).toHaveLength(1));
    expect(init).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    expect(readConsent()).toBeNull();
    // Same visitor across page loads: the cookie isn't wiped on startup.
    expect(cookieNames()).toEqual(['ph_phc_test_posthog']);
    expect(posthog.analyticsOnByDefault()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(screen.getByText(/Analytics cookies and session replays are on/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(readConsent()).toBe('granted');
    expect(posthog.analyticsOnByDefault()).toBe(false);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('a choice made while the region lookup runs wins', async () => {
    let answer!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const { ConsentBanner, CookieSettingsButton } = await boot({ fetch });
    render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await act(async () => answer({ ok: true, json: async () => ({ rule: 'opt_out' }) }));

    expect(readConsent()).toBe('denied');
    expect(snippetTags()).toHaveLength(0);
    expect(banner()).toBeNull();
  });

  it('Decline stores the choice, loads nothing and clears what was there', async () => {
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);
    await screen.findByRole('region', { name: 'Cookie consent' });
    window.localStorage.setItem('ph_phc_test_posthog', '{}');

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    expect(readConsent()).toBe('denied');
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
    expect(window.localStorage.getItem('ph_phc_test_posthog')).toBeNull();
  });

  it('a stored grant loads PostHog on startup without asking', async () => {
    writeConsent('granted');
    const fetch = regionFetch('opt_in');
    const { ConsentBanner } = await boot({ fetch });
    render(<ConsentBanner />);
    expect(banner()).toBeNull();
    expect(snippetTags()).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['now', () => writeConsent('denied')],
    ['before session replay (v1)', () => window.localStorage.setItem('op_consent_v1', JSON.stringify({ choice: 'denied', at: Date.now() }))],
  ])('a decline stored %s clears leftovers on every load and stays quiet, wherever the visitor is', async (_when, store) => {
    store();
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const fetch = regionFetch('opt_out');
    const { ConsentBanner } = await boot({ fetch });
    render(<ConsentBanner />);
    expect(banner()).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an expired choice asks again', async () => {
    writeConsent('granted', Date.now() - CONSENT_MAX_AGE_MS - 1);
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);
    expect(await screen.findByRole('region', { name: 'Cookie consent' })).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
  });

  it.each([
    ['Global Privacy Control', () => ((navigator as Nav).globalPrivacyControl = true)],
    ['Do Not Track', () => Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })],
  ])('%s counts as declining wherever the visitor is: no banner, nothing loads, leftovers cleared', async (_name, signal) => {
    signal();
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const fetch = regionFetch('opt_out');
    const { ConsentBanner, CookieSettingsButton } = await boot({ fetch });
    render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );
    expect(banner()).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    // Still reachable on purpose, with the signal explained.
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));
    expect(screen.getByText(/Your browser asks sites not to track you/)).toBeTruthy();
  });

  it('Cookie settings reopens the banner after a choice', async () => {
    writeConsent('denied');
    const { ConsentBanner, CookieSettingsButton } = await boot();
    render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();

    act(() => {
      screen.getByRole('button', { name: 'Cookie settings' }).focus();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cookie settings' }));

    const banner = screen.getByRole('region', { name: 'Cookie consent' });
    expect(document.activeElement).toBe(banner);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(readConsent()).toBe('granted');
    expect(snippetTags()).toHaveLength(1);
  });

  it('a build without VITE_POSTHOG_KEY renders no banner and no settings entry', async () => {
    const { ConsentBanner, CookieSettingsButton } = await boot({ key: null });
    const { container } = render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );
    expect(container.innerHTML).toBe('');
    expect(snippetTags()).toHaveLength(0);
  });
});
