// @vitest-environment jsdom
/**
 * Where a referral used to go missing in the browser, and the landing
 * report that shows the rest:
 *   - a page on another subdomain (or a visit after Safari cleared
 *     localStorage) reads the referral back from the op_ref cookie;
 *   - an op_ref cookie that already holds the referral isn't rewritten
 *     from script, which in Safari would cap a server-set one at 7 days;
 *   - consent: 'pending' touches no storage until setConsent('granted');
 *   - a click arriving from the URL is reported once to /attribution/landing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPartner } from '../browser.js';

const CLICK = '01M590C5ZWPP14GBCV2VJ5MFRC';
const OTHER = '01M590C5ZWPP14GBCV2VJ5MFRD';
let instances: OpenPartner[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function init(config: Partial<Parameters<typeof OpenPartner.init>[0]> = {}) {
  const op = OpenPartner.init({ apiUrl: 'https://op.test', ...config });
  instances.push(op);
  return op;
}

function calls(path: string) {
  return fetchMock.mock.calls.filter((c) => String(c[0]) === `https://op.test${path}`);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  for (const name of ['op_ref', '_cref']) document.cookie = `${name}=; Max-Age=0; Path=/`;
  window.history.replaceState({}, '', '/');
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, firstLanding: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const op of instances) op.stopLinkingStripe();
  instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reading the referral cookie back', () => {
  it('finds the referral on a page with no ?cref= and empty storage, and identifies with it', async () => {
    // What a sibling subdomain (or the brand's server) left behind.
    document.cookie = `op_ref=${CLICK}; Path=/`;
    const op = init();
    expect(op.getReferral()).toBe(CLICK);
    expect(localStorage.getItem('openpartner:cref')).toBe(CLICK);

    await op.identify('user_1');
    const [identify] = calls('/attribution/identify');
    expect(JSON.parse(String(identify![1]!.body))).toMatchObject({ cref: CLICK, userId: 'user_1' });
  });

  it('honours a configured cookie name', () => {
    document.cookie = `brand_ref=${CLICK}; Path=/`;
    expect(init({ referralCookie: { name: 'brand_ref' } }).getReferral()).toBe(CLICK);
    document.cookie = 'brand_ref=; Max-Age=0; Path=/';
  });

  it('prefers the router cookie, and never replaces what storage already holds', () => {
    document.cookie = `_cref=${OTHER}; Path=/`;
    document.cookie = `op_ref=${CLICK}; Path=/`;
    expect(init().getReferral()).toBe(OTHER);

    localStorage.setItem('openpartner:cref', CLICK);
    expect(init().getReferral()).toBe(CLICK);
  });

  it('tags Stripe links from the cookie alone when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    document.cookie = `op_ref=${CLICK}; Path=/`;
    document.body.innerHTML = '<a id="pay" href="https://buy.stripe.com/abc">Buy</a>';
    init();
    const href = (document.getElementById('pay') as HTMLAnchorElement).href;
    expect(new URL(href).searchParams.get('client_reference_id')).toBe(CLICK);
  });

  it('keeps a fresh click from the URL when localStorage throws: cookie, Stripe tags and identify all get it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    document.body.innerHTML = '<a id="pay" href="https://buy.stripe.com/abc">Buy</a>';
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    const op = init({ referralCookie: { name: 'op_ref' } });
    expect(op.getReferral()).toBe(CLICK);
    expect(document.cookie).toContain(`op_ref=${CLICK}`);
    expect(new URL((document.getElementById('pay') as HTMLAnchorElement).href).searchParams.get('client_reference_id')).toBe(CLICK);
    await op.identify('user_1');
    expect(JSON.parse(String(calls('/attribution/identify')[0]![1]!.body))).toMatchObject({ cref: CLICK });
  });

  it("doesn't rewrite an op_ref cookie that already holds the referral, but a new click replaces it", () => {
    const writes: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
      desc!.set!.call(document, value);
    });

    document.cookie = `op_ref=${CLICK}; Path=/`;
    writes.length = 0;
    localStorage.setItem('openpartner:cref', CLICK);
    init({ referralCookie: { name: 'op_ref' } });
    expect(writes).toEqual([]);

    window.history.replaceState({}, '', `/?cref=${OTHER}`);
    init({ referralCookie: { name: 'op_ref' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`op_ref=${OTHER}`);
  });
});

describe('consent', () => {
  it("'pending' holds the URL's referral in memory: no storage, no cookie, no Stripe tag, no request", async () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    document.body.innerHTML = '<a id="pay" href="https://buy.stripe.com/abc">Buy</a>';
    const op = init({ consent: 'pending', referralCookie: { name: 'op_ref' } });
    await flush();

    expect(localStorage.getItem('openpartner:cref')).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
    expect((document.getElementById('pay') as HTMLAnchorElement).href).toBe('https://buy.stripe.com/abc');
    expect(op.getReferral()).toBeNull();
    expect(await op.identify('user_1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("'pending' doesn't read storage either", () => {
    localStorage.setItem('openpartner:cref', CLICK);
    document.cookie = `op_ref=${CLICK}; Path=/`;
    expect(init({ consent: 'pending' }).getReferral()).toBeNull();
  });

  it('setConsent("granted") stores the held referral, tags Stripe and reports the landing', async () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    const op = init({ consent: 'pending', referralCookie: { name: 'op_ref' } });
    // A single-page app moved on before the banner was answered.
    window.history.replaceState({}, '', '/pricing');
    document.body.innerHTML = '<a id="pay" href="https://buy.stripe.com/abc">Buy</a>';

    op.setConsent('granted');
    await flush();
    expect(localStorage.getItem('openpartner:cref')).toBe(CLICK);
    expect(document.cookie).toContain(`op_ref=${CLICK}`);
    const href = (document.getElementById('pay') as HTMLAnchorElement).href;
    expect(new URL(href).searchParams.get('client_reference_id')).toBe(CLICK);
    expect(calls('/attribution/landing')).toHaveLength(1);
  });

  it('setConsent("denied") stops linking and deletes what was stored', async () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    const op = init({ referralCookie: { name: 'op_ref' } });
    expect(localStorage.getItem('openpartner:cref')).toBe(CLICK);

    op.setConsent('denied');
    expect(localStorage.getItem('openpartner:cref')).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
    expect(op.getReferral()).toBeNull();

    document.body.innerHTML = '<a id="late" href="https://buy.stripe.com/late">Buy</a>';
    await flush();
    expect((document.getElementById('late') as HTMLAnchorElement).href).toBe('https://buy.stripe.com/late');
  });

  it("setConsent('denied') takes back the Stripe references it added, and leaves the brand's own", async () => {
    document.body.innerHTML = `
      <a id="ours" href="https://buy.stripe.com/abc?prefilled_email=a%40b.c">Buy</a>
      <a id="brand" href="https://buy.stripe.com/abc?client_reference_id=brand_set">Buy</a>
      <stripe-pricing-table id="table"></stripe-pricing-table>`;
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    const op = init();
    const href = (id: string) => new URL((document.getElementById(id) as HTMLAnchorElement).href);
    expect(href('ours').searchParams.get('client_reference_id')).toBe(CLICK);
    expect(document.getElementById('table')!.getAttribute('client-reference-id')).toBe(CLICK);

    op.setConsent('denied');
    expect(href('ours').searchParams.has('client_reference_id')).toBe(false);
    expect(href('ours').searchParams.get('prefilled_email')).toBe('a@b.c');
    expect(href('brand').searchParams.get('client_reference_id')).toBe('brand_set');
    expect(document.getElementById('table')!.hasAttribute('client-reference-id')).toBe(false);
    // Saying it again is harmless.
    op.setConsent('denied');
    expect(op.getReferral()).toBeNull();
  });

  it("'denied' at load deletes what an earlier visit stored", () => {
    localStorage.setItem('openpartner:cref', CLICK);
    document.cookie = `op_ref=${CLICK}; Path=/`;
    init({ consent: 'denied' });
    expect(localStorage.getItem('openpartner:cref')).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
  });

  it("'denied' uses nothing from the start", async () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    const op = init({ consent: 'denied' });
    await flush();
    expect(localStorage.getItem('openpartner:cref')).toBeNull();
    expect(op.getReferral()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the landing report', () => {
  it('posts the click id once, when it first arrives from the URL', async () => {
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    init();
    await flush();
    const landing = calls('/attribution/landing');
    expect(landing).toHaveLength(1);
    expect(JSON.parse(String(landing[0]![1]!.body))).toEqual({ cref: CLICK });
    expect(landing[0]![1]!.keepalive).toBe(true);

    // A reload of the landing page: this browser already has the click.
    init();
    await flush();
    expect(calls('/attribution/landing')).toHaveLength(1);
  });

  it('reports a second click as a landing of its own', async () => {
    localStorage.setItem('openpartner:cref', CLICK);
    window.history.replaceState({}, '', `/?cref=${OTHER}`);
    init();
    await flush();
    expect(JSON.parse(String(calls('/attribution/landing')[0]![1]!.body))).toEqual({ cref: OTHER });
  });

  it('sends nothing for a referral restored from a cookie, with reportLanding: false, or for a malformed cref', async () => {
    document.cookie = `op_ref=${CLICK}; Path=/`;
    init();
    window.history.replaceState({}, '', `/?cref=${OTHER}`);
    init({ reportLanding: false });
    localStorage.clear();
    window.history.replaceState({}, '', '/?cref=not%20a%20click');
    init();
    await flush();
    expect(calls('/attribution/landing')).toHaveLength(0);
  });

  it("reports a failed landing through onError (a click_not_found means apiUrl names another program)", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'click_not_found' }), { status: 404 }));
    const onError = vi.fn();
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    init({ onError });
    await flush();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as { code?: string }).code).toBe('click_not_found');
  });

  it("stays quiet when the landing report fails any other way (an API that predates it, offline)", async () => {
    const onError = vi.fn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    window.history.replaceState({}, '', `/?cref=${CLICK}`);
    init({ onError });
    await flush();
    await flush();

    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    localStorage.clear();
    window.history.replaceState({}, '', `/?cref=${OTHER}`);
    init({ onError });
    await flush();
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });
});
