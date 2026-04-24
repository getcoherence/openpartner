// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPartner, OpenPartnerError } from '../browser.js';

describe('OpenPartner (browser)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = '_cref=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    // jsdom preserves history across tests — reset it so stale query
    // params don't leak and trigger captureCref on the next test.
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures cref from ?cref= and stashes it in localStorage', () => {
    window.history.replaceState({}, '', '/?cref=click_123');
    OpenPartner.init({ apiUrl: 'https://op.test' });
    expect(localStorage.getItem('openpartner:cref')).toBe('click_123');
  });

  it('falls back to the _cref cookie when no query cref is present', () => {
    window.history.replaceState({}, '', '/');
    document.cookie = '_cref=from_cookie; path=/';
    OpenPartner.init({ apiUrl: 'https://op.test' });
    expect(localStorage.getItem('openpartner:cref')).toBe('from_cookie');
  });

  it('query cref wins over cookie cref', () => {
    window.history.replaceState({}, '', '/?cref=from_query');
    document.cookie = '_cref=from_cookie; path=/';
    OpenPartner.init({ apiUrl: 'https://op.test' });
    expect(localStorage.getItem('openpartner:cref')).toBe('from_query');
  });

  it('identify POSTs { cref, userId, ts } to /attribution/identify', async () => {
    localStorage.setItem('openpartner:cref', 'click_xyz');
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, identityId: 'id_1', firstStitch: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const op = OpenPartner.init({ apiUrl: 'https://op.test' });
    const result = await op.identify('user_42');

    expect(result).toMatchObject({ ok: true, identityId: 'id_1', firstStitch: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://op.test/attribution/identify');
    const body = JSON.parse(String(call[1]!.body));
    expect(body.cref).toBe('click_xyz');
    expect(body.userId).toBe('user_42');
    expect(typeof body.ts).toBe('number');
  });

  it('identify() no-ops when no cref was captured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const op = OpenPartner.init({ apiUrl: 'https://op.test' });
    const result = await op.identify('user_x');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('identify() reports errors through onError instead of throwing', async () => {
    localStorage.setItem('openpartner:cref', 'click_xyz');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'click_not_found' }), { status: 404 })),
    );
    const onError = vi.fn();
    const op = OpenPartner.init({ apiUrl: 'https://op.test', onError });
    const result = await op.identify('user_y');
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(OpenPartnerError);
    expect((err as OpenPartnerError).status).toBe(404);
  });
});
