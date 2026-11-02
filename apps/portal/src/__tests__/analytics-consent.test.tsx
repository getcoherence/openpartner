// @vitest-environment jsdom
/**
 * PostHog runs only with the visitor's opt-in. The choice is stored under
 * localStorage "op_consent_v1" as { choice, at } for 12 months; GPC / Do
 * Not Track count as Decline; without 'granted' every load clears ph_* /
 * __ph_* cookies and storage; a build without VITE_POSTHOG_KEY shows no
 * banner at all.
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

/** A fresh posthog.ts (its import runs the startup check) + banner, with a key set. */
async function boot({ key = 'phc_test' }: { key?: string | null } = {}) {
  vi.resetModules();
  if (key) vi.stubEnv('VITE_POSTHOG_KEY', key);
  else vi.stubEnv('VITE_POSTHOG_KEY', '');
  const posthog = await import('../posthog.js');
  const ui = await import('../lib/ConsentBanner.js');
  return { posthog, ...ui };
}

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
});

describe('consent banner', () => {
  it('asks first and loads nothing until Accept', async () => {
    const init = vi.fn();
    (window as { posthog?: unknown }).posthog = { init, opt_out_capturing: vi.fn() };
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);

    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeTruthy();
    // Every page shows it, a creator's first visit and white-label portals
    // too: it names neither a page nor us.
    expect(screen.getByText(/to see how this site is used/)).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
    expect(init).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(readConsent()).toBe('granted');
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]![0]).toBe('phc_test');
    expect(init.mock.calls[0]![1]).toMatchObject({
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
    });
  });

  it('Decline stores the choice, loads nothing and clears what was there', async () => {
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const { ConsentBanner } = await boot();
    window.localStorage.setItem('ph_phc_test_posthog', '{}');
    render(<ConsentBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    expect(readConsent()).toBe('denied');
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
    expect(window.localStorage.getItem('ph_phc_test_posthog')).toBeNull();
  });

  it('a stored grant loads PostHog on startup without asking', async () => {
    writeConsent('granted');
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(1);
  });

  it('a stored decline clears leftovers on every load and stays quiet', async () => {
    writeConsent('denied');
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);
  });

  it('an expired choice asks again', async () => {
    writeConsent('granted', Date.now() - CONSENT_MAX_AGE_MS - 1);
    const { ConsentBanner } = await boot();
    render(<ConsentBanner />);
    expect(screen.getByRole('region', { name: 'Cookie consent' })).toBeTruthy();
    expect(snippetTags()).toHaveLength(0);
  });

  it.each([
    ['Global Privacy Control', () => ((navigator as Nav).globalPrivacyControl = true)],
    ['Do Not Track', () => Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })],
  ])('%s counts as declining: no banner, nothing loads, leftovers cleared', async (_name, signal) => {
    signal();
    document.cookie = 'ph_phc_test_posthog=%7B%7D;path=/';
    const { ConsentBanner, CookieSettingsButton } = await boot();
    render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    );
    expect(screen.queryByRole('region', { name: 'Cookie consent' })).toBeNull();
    expect(snippetTags()).toHaveLength(0);
    expect(cookieNames()).toEqual([]);

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
