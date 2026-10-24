import { describe, expect, it, vi } from 'vitest';
import { OpenPartnerServer, OpenPartnerError } from '../server.js';

describe('OpenPartnerServer', () => {
  it('trackEvent POSTs to /attribution/events with a Bearer header', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          eventId: 'evt_1',
          attribution: { status: 'attributed', model: 'last_click', touches: [] },
        }),
        { status: 200 },
      ),
    );

    const op = new OpenPartnerServer({
      apiUrl: 'https://op.test',
      apiKey: 'op_secret_123',
      fetch: fetchMock,
    });

    const res = await op.trackEvent({ userId: 'u1', type: 'invoice_paid', value: 249, currency: 'USD' });
    expect(res.eventId).toBe('evt_1');
    expect(res.attribution.status).toBe('attributed');

    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://op.test/attribution/events');
    const init = call[1]!;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer op_secret_123');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ userId: 'u1', type: 'invoice_paid', value: 249, currency: 'USD' });
  });

  it('trackEvent forwards externalEventId and surfaces a replay', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ ok: true, replayed: true, eventId: 'evt_1', attribution: { status: 'not_attributed' } }),
        { status: 200 },
      ),
    );
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test', apiKey: 'k', fetch: fetchMock });

    const res = await op.trackEvent({ userId: 'u1', type: 'invoice_paid', value: 249, externalEventId: 'in_123' });
    expect(res.replayed).toBe(true);
    expect(res.attribution.status).toBe('not_attributed');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({ userId: 'u1', type: 'invoice_paid', value: 249, externalEventId: 'in_123' });
  });

  it('wraps non-2xx into OpenPartnerError with status + code', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_body', detail: { whatever: 1 } }), { status: 400 }),
    );
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test', apiKey: 'k', fetch: fetchMock });
    await expect(op.trackEvent({ userId: 'u', type: 'signup' })).rejects.toMatchObject({
      name: 'OpenPartnerError',
      status: 400,
      code: 'invalid_body',
    });
  });

  it('trackConversion POSTs the click id to /attribution/conversions', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ ok: true, eventId: 'evt_9', userId: 'click:c1', attribution: { status: 'attributed' } }),
        { status: 200 },
      ),
    );
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test', apiKey: 'k', fetch: fetchMock });

    const res = await op.trackConversion({ clickId: 'c1', type: 'loan_funded', value: 5000, externalEventId: 'loan-1:funded' });
    expect(res.userId).toBe('click:c1');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://op.test/attribution/conversions');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      clickId: 'c1',
      type: 'loan_funded',
      value: 5000,
      externalEventId: 'loan-1:funded',
    });
  });

  it('identify forwards cref + userId to /attribution/identify', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, identityId: 'id_1', firstStitch: false }), { status: 200 }),
    );
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test', apiKey: 'k', fetch: fetchMock });
    await op.identify({ cref: 'c1', userId: 'u1', ts: 123456 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toEqual({ cref: 'c1', userId: 'u1', ts: 123456 });
  });

  it('requires apiUrl and apiKey', () => {
    expect(() => new OpenPartnerServer({ apiUrl: '', apiKey: 'k' })).toThrow(OpenPartnerError);
    expect(() => new OpenPartnerServer({ apiUrl: 'x', apiKey: '' })).toThrow(OpenPartnerError);
  });

  it('strips a trailing slash on apiUrl', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    );
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test/', apiKey: 'k', fetch: fetchMock });
    await op.trackEvent({ userId: 'u', type: 'signup' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://op.test/attribution/events');
  });
});

describe('the referral cookie, from the brand server', () => {
  it('builds a Set-Cookie for a landing URL with ?cref=, and nothing otherwise', async () => {
    const { referralCookieHeader } = await import('../server.js');
    expect(referralCookieHeader('/pricing?cref=01M590C5ZWPP14GBCV2VJ5MFRC&utm_source=x')).toBe(
      'op_ref=01M590C5ZWPP14GBCV2VJ5MFRC; Max-Age=7776000; Path=/; SameSite=Lax; Secure',
    );
    expect(
      referralCookieHeader('https://www.acme.test/?ref=abc', {
        queryParam: 'ref',
        name: 'acme_ref',
        domain: '.acme.test',
        days: 30,
        secure: false,
      }),
    ).toBe('acme_ref=abc; Max-Age=2592000; Path=/; SameSite=Lax; Domain=.acme.test');
    expect(referralCookieHeader('/pricing')).toBeNull();
    // Nothing a header could be split on, and nothing Stripe would drop.
    expect(referralCookieHeader('/?cref=a%3B%20Domain%3Devil.test')).toBeNull();
    expect(referralCookieHeader('/?cref=' + 'x'.repeat(201))).toBeNull();
  });

  it('middleware appends to Set-Cookie headers already queued', async () => {
    const { referralCookieMiddleware } = await import('../server.js');
    const headers = new Map<string, string | string[]>([['set-cookie', 'session=abc']]);
    const res = {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string | string[]) => headers.set(name, value),
    };
    const next = vi.fn();
    referralCookieMiddleware({ secure: false })({ originalUrl: '/?cref=CLICK1' }, res, next);
    expect(headers.get('set-cookie')).toEqual(['session=abc', 'op_ref=CLICK1; Max-Age=7776000; Path=/; SameSite=Lax']);
    expect(next).toHaveBeenCalledOnce();

    headers.clear();
    referralCookieMiddleware()({ url: '/about' }, res, next);
    expect(headers.has('set-cookie')).toBe(false);
  });

  it('reads the referral back off a Cookie header', async () => {
    const { readReferralCookie } = await import('../server.js');
    expect(readReferralCookie('a=1; op_ref=01M590C5ZWPP14GBCV2VJ5MFRC; b=2')).toBe('01M590C5ZWPP14GBCV2VJ5MFRC');
    expect(readReferralCookie('acme_ref=xyz', 'acme_ref')).toBe('xyz');
    expect(readReferralCookie('xop_ref=nope')).toBeNull();
    expect(readReferralCookie('op_ref=bad%20value')).toBeNull();
    expect(readReferralCookie(undefined)).toBeNull();
  });
});
