// @vitest-environment jsdom
/**
 * Magic-link tokens must not reach analytics. PostHog records the page URL
 * on every event, and the landing pages used to leave ?token= in the
 * address bar for as long as they were open. The landings now strip it
 * before the verify call, and PostHog's before_send scrubs it from any
 * event that still caught it.
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MagicLandingPage } from '../pages/auth/MagicLanding.js';
import { PlatformMagicLandingPage } from '../pages/auth/PlatformMagicLanding.js';
import { scrubSensitiveEvent, scrubSensitiveParams } from '../lib/sensitive-url.js';

interface Sent {
  url: string;
  body: unknown;
  /** The address bar at the moment the request went out. */
  addressBar: string;
}
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      addressBar: window.location.href,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderAt(path: string, page: ReactElement) {
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{page}</BrowserRouter>
    </QueryClientProvider>,
  );
}

/** The one verify request the page made. (The frame's branding query
 *  also fetches, during render, before any effect runs.) */
async function verifyCall(url: string): Promise<Sent> {
  await waitFor(() => expect(sent.filter((s) => s.url === url)).toHaveLength(1));
  return sent.find((s) => s.url === url)!;
}

describe('magic-link landings', () => {
  it('brand landing: the token leaves the address bar before verify, and verify still gets it', async () => {
    renderAt('/t/acme/auth/magic?token=op_ml_secret123&utm_source=email', <MagicLandingPage />);

    const verify = await verifyCall('/api/t/acme/auth/magic/verify');
    expect(verify.body).toEqual({ token: 'op_ml_secret123' });
    expect(verify.addressBar).not.toContain('op_ml_secret123');
    expect(window.location.pathname).toBe('/t/acme/auth/magic');
    // Unrelated params survive.
    expect(window.location.search).toBe('?utm_source=email');
  });

  it('platform landing: same for the unified sign-in token', async () => {
    renderAt('/auth/platform-magic?token=op_pml_secret456', <PlatformMagicLandingPage />);

    const verify = await verifyCall('/api/auth/platform-verify');
    expect(verify.body).toEqual({ token: 'op_pml_secret456' });
    expect(verify.addressBar).not.toContain('op_pml_secret456');
    expect(window.location.search).toBe('');
  });
});

describe('PostHog before_send scrubber', () => {
  it('drops token and ntoken from every URL in an event, at any depth', () => {
    const timestamp = new Date('2026-10-19T00:00:00Z');
    const event = {
      event: '$pageview',
      uuid: 'u1',
      timestamp,
      properties: {
        $current_url: 'https://app.example.test/t/acme/auth/magic?token=op_ml_abc&x=1',
        $referrer: 'https://app.example.test/admin/network/complete?ntoken=nt_def',
        $pathname: '/t/acme/auth/magic',
        $elements_chain: 'a:href="/auth/magic?token=op_ml_ghi"nth-child="1"',
        $click_token: 'kept',
        count: 3,
      },
      $set: { $current_url: 'https://app.example.test/auth/magic?token=op_ml_abc' },
      $set_once: { $initial_current_url: 'https://app.example.test/auth/magic?token=op_ml_abc#top' },
    };

    const out = scrubSensitiveEvent(event);

    expect(out.properties.$current_url).toBe('https://app.example.test/t/acme/auth/magic?x=1');
    expect(out.properties.$referrer).toBe('https://app.example.test/admin/network/complete');
    expect(out.properties.$pathname).toBe('/t/acme/auth/magic');
    expect(out.properties.$elements_chain).toBe('a:href="/auth/magic?token=redacted"nth-child="1"');
    expect(out.properties.$click_token).toBe('kept');
    expect(out.properties.count).toBe(3);
    expect(out.$set.$current_url).toBe('https://app.example.test/auth/magic');
    expect(out.$set_once.$initial_current_url).toBe('https://app.example.test/auth/magic#top');
    expect(out.timestamp).toBe(timestamp);
    expect(JSON.stringify(out)).not.toMatch(/op_ml_|nt_def/);
    // The input event is left alone.
    expect(event.properties.$current_url).toContain('token=op_ml_abc');
  });

  it('leaves strings without a sensitive param untouched', () => {
    expect(scrubSensitiveParams('https://app.example.test/?click_token=1&tokens=2')).toBe(
      'https://app.example.test/?click_token=1&tokens=2',
    );
  });
});
