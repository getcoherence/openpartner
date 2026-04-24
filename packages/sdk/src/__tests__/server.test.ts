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

  it('identify forwards cref + userId to /attribution/identify', async () => {
    const fetchMock = vi.fn(async () =>
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
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const op = new OpenPartnerServer({ apiUrl: 'https://op.test/', apiKey: 'k', fetch: fetchMock });
    await op.trackEvent({ userId: 'u', type: 'signup' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://op.test/attribution/events');
  });
});
