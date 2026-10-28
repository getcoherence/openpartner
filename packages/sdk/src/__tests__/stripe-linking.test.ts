// @vitest-environment jsdom
/**
 * The browser SDK hands a captured referral to Stripe on its own: Payment
 * Links get client_reference_id, Pricing Table / Buy Button embeds get
 * client-reference-id, including ones added later. That's what makes those
 * checkouts code-free for a brand whose Stripe is connected to OpenPartner.
 * Plus the script-tag build's config and its first-party op_ref cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPartner } from '../browser.js';
import { configFromScript } from '../auto.js';

const CLICK = '01M590C5ZWPP14GBCV2VJ5MFRC';
let instances: OpenPartner[] = [];

function init(config: Partial<Parameters<typeof OpenPartner.init>[0]> = {}) {
  const op = OpenPartner.init({ apiUrl: 'https://op.test', ...config });
  instances.push(op);
  return op;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.cookie = 'op_ref=; Max-Age=0; Path=/';
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
});

afterEach(() => {
  for (const op of instances) op.stopLinkingStripe();
  instances = [];
  vi.unstubAllGlobals();
});

describe('linking Stripe checkouts to the referral', () => {
  it('adds client_reference_id to Payment Links on the page, and nothing else', () => {
    document.body.innerHTML = `
      <a id="plain" href="https://buy.stripe.com/abc123">Buy</a>
      <a id="query" href="https://buy.stripe.com/abc123?prefilled_email=a%40b.c">Buy</a>
      <a id="own" href="https://buy.stripe.com/abc123?client_reference_id=brand_set">Buy</a>
      <a id="other" href="https://example.com/pricing">Pricing</a>`;
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    init();

    const href = (id: string) => (document.getElementById(id) as HTMLAnchorElement).href;
    expect(new URL(href('plain')).searchParams.get('client_reference_id')).toBe(CLICK);
    expect(new URL(href('query')).searchParams.get('client_reference_id')).toBe(CLICK);
    expect(new URL(href('query')).searchParams.get('prefilled_email')).toBe('a@b.c');
    // The brand's own value wins.
    expect(new URL(href('own')).searchParams.get('client_reference_id')).toBe('brand_set');
    expect(href('other')).toBe('https://example.com/pricing');
  });

  it('sets client-reference-id on Pricing Table and Buy Button embeds, unless already set', () => {
    document.body.innerHTML = `
      <stripe-pricing-table id="table" pricing-table-id="prctbl_1" publishable-key="pk_live_x"></stripe-pricing-table>
      <stripe-buy-button id="button" buy-button-id="buy_btn_1" publishable-key="pk_live_x"></stripe-buy-button>
      <stripe-buy-button id="set" buy-button-id="buy_btn_2" client-reference-id="brand_set"></stripe-buy-button>`;
    localStorage.setItem('openpartner:cref', CLICK);
    init();

    expect(document.getElementById('table')!.getAttribute('client-reference-id')).toBe(CLICK);
    expect(document.getElementById('button')!.getAttribute('client-reference-id')).toBe(CLICK);
    expect(document.getElementById('set')!.getAttribute('client-reference-id')).toBe('brand_set');
  });

  it('links Stripe elements added later, and links re-pointed at a Payment Link', async () => {
    localStorage.setItem('openpartner:cref', CLICK);
    init();

    const later = document.createElement('div');
    later.innerHTML = '<a id="late" href="https://buy.stripe.com/late">Buy</a><stripe-pricing-table id="lateTable"></stripe-pricing-table>';
    document.body.appendChild(later);
    const repointed = document.createElement('a');
    repointed.id = 'repointed';
    repointed.href = 'https://example.com/';
    document.body.appendChild(repointed);
    await flush();
    repointed.href = 'https://buy.stripe.com/now';
    await flush();

    expect(new URL((document.getElementById('late') as HTMLAnchorElement).href).searchParams.get('client_reference_id')).toBe(CLICK);
    expect(document.getElementById('lateTable')!.getAttribute('client-reference-id')).toBe(CLICK);
    expect(new URL(repointed.href).searchParams.get('client_reference_id')).toBe(CLICK);
  });

  it('covers a custom Payment Link domain when configured', () => {
    document.body.innerHTML = '<a id="custom" href="https://pay.acme.test/abc">Buy</a>';
    localStorage.setItem('openpartner:cref', CLICK);
    init({ stripe: { linkHosts: ['pay.acme.test'] } });
    expect(new URL((document.getElementById('custom') as HTMLAnchorElement).href).searchParams.get('client_reference_id')).toBe(CLICK);
  });

  it('does nothing without a referral, with stripe: false, or for a value Stripe would drop', () => {
    document.body.innerHTML = '<a id="link" href="https://buy.stripe.com/abc">Buy</a>';
    init();
    expect((document.getElementById('link') as HTMLAnchorElement).href).toBe('https://buy.stripe.com/abc');

    localStorage.setItem('openpartner:cref', CLICK);
    init({ stripe: false });
    expect((document.getElementById('link') as HTMLAnchorElement).href).toBe('https://buy.stripe.com/abc');

    localStorage.setItem('openpartner:cref', 'not ok!');
    expect(init().linkStripe()).toBe(0);
    expect((document.getElementById('link') as HTMLAnchorElement).href).toBe('https://buy.stripe.com/abc');
  });
});

describe('the first-party referral cookie', () => {
  it('is written only when asked for, so a server can read the referral off the request', () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    init();
    expect(document.cookie).not.toContain('op_ref=');

    init({ referralCookie: { name: 'op_ref' } });
    expect(document.cookie).toContain(`op_ref=${CLICK}`);
  });
});

describe('the script-tag build', () => {
  it('reads its config from the tag, defaulting the API to the script origin', () => {
    expect(configFromScript({ src: 'https://app.openpartner.dev/op.js', dataset: {} })).toEqual({
      apiUrl: 'https://app.openpartner.dev/api',
      stripe: { linkHosts: [] },
      referralCookie: { name: 'op_ref' },
      consent: 'granted',
      privacySignals: 'decline',
      reportLanding: true,
    });
    expect(
      configFromScript({
        src: 'https://partners.acme.test/op.js',
        dataset: {
          apiUrl: 'https://partners.acme.test/api/t/acme/',
          stripeHosts: 'pay.acme.test, buy.acme.test',
          cookieDomain: '.acme.test',
        },
      }),
    ).toEqual({
      apiUrl: 'https://partners.acme.test/api/t/acme',
      stripe: { linkHosts: ['pay.acme.test', 'buy.acme.test'] },
      referralCookie: { name: 'op_ref', domain: '.acme.test' },
      consent: 'granted',
      privacySignals: 'decline',
      reportLanding: true,
    });
    expect(configFromScript({ src: 'https://x.test/op.js', dataset: { stripe: 'off', cookie: 'off' } })).toMatchObject({
      stripe: false,
      referralCookie: false,
    });
    expect(
      configFromScript({ src: 'https://x.test/op.js', dataset: { consent: 'pending', landing: 'off' } }),
    ).toMatchObject({ consent: 'pending', reportLanding: false });
    expect(configFromScript({ src: 'https://x.test/op.js', dataset: { consent: 'denied' } })).toMatchObject({
      consent: 'denied',
    });
    expect(configFromScript({ src: 'https://x.test/op.js', dataset: { consent: 'regional', gpc: 'ignore' } })).toMatchObject({
      consent: 'regional',
      privacySignals: 'ignore',
    });
    // Anything else is the default, never a value the SDK doesn't know.
    expect(configFromScript({ src: 'https://x.test/op.js', dataset: { consent: 'yes' } })).toMatchObject({
      consent: 'granted',
    });
  });
});
