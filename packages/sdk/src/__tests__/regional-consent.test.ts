// @vitest-environment jsdom
/**
 * consent: 'regional': the SDK asks GET <apiUrl>/consent-region which rule
 * applies where the visitor is, before it reads or writes anything.
 *   - opt_out starts as granted; opt_in waits for setConsent() as 'pending'.
 *   - A failed, malformed or slow (1.5 s) lookup is opt-in.
 *   - setConsent('denied') before the answer outranks an opt-out region.
 *   - A Global Privacy Control signal waits in an opt-out region unless
 *     privacySignals: 'ignore'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPartner } from '../browser.js';

const CLICK = '01M590C5ZWPP14GBCV2VJ5MFRC';
let instances: OpenPartner[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let region: () => Promise<Response>;

function init(config: Partial<Parameters<typeof OpenPartner.init>[0]> = {}) {
  const op = OpenPartner.init({ apiUrl: 'https://op.test', consent: 'regional', referralCookie: { name: 'op_ref' }, ...config });
  instances.push(op);
  return op;
}

const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const calls = (path: string) => fetchMock.mock.calls.filter((c) => String(c[0]) === `https://op.test${path}`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const stored = () => localStorage.getItem('openpartner:cref');

function setGpc(on: boolean) {
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: on, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = 'op_ref=; Max-Age=0; Path=/';
  window.history.replaceState({}, '', `/?cref=${CLICK}`);
  region = answer({ rule: 'opt_out', country: 'US' });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/consent-region')) {
      const signal = init?.signal;
      return Promise.race([
        region(),
        new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      ]);
    }
    return new Response(JSON.stringify({ ok: true, firstLanding: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  setGpc(false);
});

afterEach(() => {
  for (const op of instances) op.stopLinkingStripe();
  instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("consent: 'regional'", () => {
  it('starts in an opt-out country once the answer comes, and asked without credentials', async () => {
    const op = init();
    // Nothing before the answer.
    expect(stored()).toBeNull();
    expect(op.getReferral()).toBeNull();

    expect(await op.consentRegion()).toEqual({ rule: 'opt_out', country: 'US' });
    await flush();
    expect(stored()).toBe(CLICK);
    expect(document.cookie).toContain(`op_ref=${CLICK}`);
    expect(op.getReferral()).toBe(CLICK);
    expect(calls('/attribution/landing')).toHaveLength(1);

    const [, request] = calls('/consent-region')[0]!;
    expect(request).toMatchObject({ method: 'GET', credentials: 'omit' });
  });

  it('waits in an opt-in country, as pending, until setConsent("granted")', async () => {
    region = answer({ rule: 'opt_in', country: 'DE' });
    const op = init();
    expect(await op.consentRegion()).toEqual({ rule: 'opt_in', country: 'DE' });
    await flush();
    expect(stored()).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
    expect(calls('/attribution/landing')).toHaveLength(0);

    op.setConsent('granted');
    expect(stored()).toBe(CLICK);
  });

  it('counts a failed or malformed answer, or an opt-out without a country, as opt-in', async () => {
    const failures = [
      async () => {
        throw new TypeError('Failed to fetch');
      },
      answer({ error: 'rate_limited' }, 429),
      answer({ rule: 'maybe', country: 'US' }),
      answer({ rule: 'opt_out' }),
      answer({ rule: 'opt_out', country: null }),
      answer({ rule: 'opt_out', country: 'United States' }),
    ];
    for (const failure of failures) {
      localStorage.clear();
      region = failure;
      const op = init();
      expect((await op.consentRegion())!.rule).toBe('opt_in');
      await flush();
      expect(stored()).toBeNull();
      expect(op.getReferral()).toBeNull();
    }
  });

  it('gives up after 1.5 seconds and counts the visitor as opt-in', async () => {
    vi.useFakeTimers();
    region = () => new Promise<Response>(() => {});
    const op = init();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await op.consentRegion()).toEqual({ rule: 'opt_in', country: null });
    expect(stored()).toBeNull();
  });

  it('keeps the 1.5-second limit without AbortController, and ignores a late answer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AbortController', undefined);
    let late: (r: Response) => void = () => {};
    region = () => new Promise<Response>((resolve) => (late = resolve));
    const op = init();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await op.consentRegion()).toEqual({ rule: 'opt_in', country: null });
    late(new Response(JSON.stringify({ rule: 'opt_out', country: 'US' }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(stored()).toBeNull();
    expect(op.getReferral()).toBeNull();
  });

  it('keeps a decline made before the answer, in an opt-out country', async () => {
    const op = init();
    op.setConsent('denied');
    expect((await op.consentRegion())!.rule).toBe('opt_out');
    await flush();
    expect(stored()).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
    expect(op.getReferral()).toBeNull();
    expect(calls('/attribution/landing')).toHaveLength(0);
  });

  it('a decline after it started deletes what it stored', async () => {
    const op = init();
    await op.consentRegion();
    expect(stored()).toBe(CLICK);
    op.setConsent('denied');
    expect(stored()).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
  });

  it('waits for Global Privacy Control in an opt-out country, unless told to ignore it', async () => {
    setGpc(true);
    const waiting = init();
    await waiting.consentRegion();
    await flush();
    expect(stored()).toBeNull();
    expect(waiting.getReferral()).toBeNull();

    const ignoring = init({ privacySignals: 'ignore' });
    await ignoring.consentRegion();
    expect(stored()).toBe(CLICK);
  });

  it('only asks in regional mode', async () => {
    const op = init({ consent: 'pending' });
    expect(await op.consentRegion()).toBeNull();
    expect(calls('/consent-region')).toHaveLength(0);
  });
});

describe('the script tag (auto.ts)', () => {
  async function loadTag(dataset: Record<string, string>) {
    const tag = document.createElement('script');
    tag.src = 'https://op.test/op.js';
    Object.assign(tag.dataset, { apiUrl: 'https://op.test', ...dataset });
    Object.defineProperty(document, 'currentScript', { value: tag, configurable: true });
    delete window.openpartner;
    vi.resetModules();
    await import('../auto.js');
    instances.push(window.openpartner!);
    return window.openpartner!;
  }

  afterEach(() => {
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
    delete window.openpartnerConsent;
    delete window.openpartner;
  });

  it('applies a decline the page queued before it ran, ahead of an opt-out answer', async () => {
    window.openpartnerConsent = 'denied';
    const op = await loadTag({ consent: 'pending', consentRegion: 'on' });
    expect((await op.consentRegion())!.rule).toBe('opt_out');
    await flush();
    expect(stored()).toBeNull();
    expect(document.cookie).not.toContain('op_ref=');
    expect(calls('/attribution/landing')).toHaveLength(0);
  });

  it('starts in an opt-out country with data-consent-region="on" and nothing queued', async () => {
    const op = await loadTag({ consent: 'pending', consentRegion: 'on' });
    await op.consentRegion();
    expect(stored()).toBe(CLICK);
  });
});
