/**
 * The request log's Referer. Portal landing pages hold single-use secrets
 * in the query, and a page that calls /api before taking them out of the
 * address bar sends the whole landing URL as the Referer. The log keeps
 * the page, never its query. No DB needed: /health answers without one.
 */

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { redactReferer, redactRequest } from '../request-log.js';

const ORIGIN = 'https://app.example.com';

/** Each landing page, its query as the browser would send it, and the
 *  secrets in that query. */
const LANDINGS = [
  { path: '/reset-password', query: 'token=rst_8f2c41d0a9e6b7c35d1e', secrets: ['rst_8f2c41d0a9e6b7c35d1e'] },
  {
    path: '/t/acme/reset-password',
    query: 'token=rst_31b7e9c0d4a25f86e1aa&scope=account',
    secrets: ['rst_31b7e9c0d4a25f86e1aa'],
  },
  { path: '/booking/confirm', query: 'token=bk_c94e1a7f02b8d36e5f10', secrets: ['bk_c94e1a7f02b8d36e5f10'] },
  { path: '/creator/claim', query: 'token=clm_5a0e93d7c1f2b48e6a7c', secrets: ['clm_5a0e93d7c1f2b48e6a7c'] },
  { path: '/admin/network/claim', query: 'token=nclm_0d6b2f8e4a1c97e3b5d2', secrets: ['nclm_0d6b2f8e4a1c97e3b5d2'] },
  { path: '/admin/network/complete', query: 'ntoken=ntk_7e1c5b9a3d0f26e84c1b', secrets: ['ntk_7e1c5b9a3d0f26e84c1b'] },
  { path: '/creator/offerings/off_1', query: 'invitation=inv_2f9d4c6e8a1b03e7d5c9', secrets: ['inv_2f9d4c6e8a1b03e7d5c9'] },
  {
    path: '/platform/mailboxes',
    query: 'code=4%2F0AeanS_mbx3c81e0f7d2a9&state=st_6c2e90a1f4b7',
    secrets: ['0AeanS_mbx3c81e0f7d2a9', 'st_6c2e90a1f4b7'],
  },
  // A name nothing lists today still goes.
  {
    path: '/admin/settings',
    query: 'tab=network&next_secret=ns_b81f0c3e7a5d29e4c6f0',
    secrets: ['ns_b81f0c3e7a5d29e4c6f0'],
  },
];

describe('redactReferer', () => {
  it('cuts every landing secret, keeping the page', () => {
    for (const { path, query } of LANDINGS) {
      expect(redactReferer(`${ORIGIN}${path}?${query}`)).toBe(`${ORIGIN}${path}?[REDACTED]`);
    }
  });

  it('leaves a Referer with no query alone, and drops a fragment', () => {
    expect(redactReferer(`${ORIGIN}/admin/partners`)).toBe(`${ORIGIN}/admin/partners`);
    expect(redactReferer(`${ORIGIN}/`)).toBe(`${ORIGIN}/`);
    expect(redactReferer(ORIGIN)).toBe(ORIGIN);
    expect(redactReferer(`${ORIGIN}/auth/magic#token=abc`)).toBe(`${ORIGIN}/auth/magic`);
    expect(redactReferer(`${ORIGIN}/auth/magic#x?token=abc`)).toBe(`${ORIGIN}/auth/magic`);
    expect(redactReferer(`${ORIGIN}/x?a=1#token=abc`)).toBe(`${ORIGIN}/x?[REDACTED]`);
  });

  it('replaces anything that is not a string', () => {
    expect(redactReferer(['https://a.example/?token=1', 'https://b.example/?token=2'])).toBe('[REDACTED]');
    expect(redactReferer(42)).toBe('[REDACTED]');
  });
});

describe('redactRequest', () => {
  it('redacts the referer next to the other secret headers, without touching the live request', () => {
    const headers = {
      referer: `${ORIGIN}/reset-password?token=rst_live`,
      authorization: 'Bearer opk_live',
      cookie: 'op_session=sess_live',
      'user-agent': 'Mozilla/5.0',
    };
    const req = { url: '/auth/me', headers };
    const out = redactRequest(req);
    expect(out.headers).toEqual({
      referer: `${ORIGIN}/reset-password?[REDACTED]`,
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'user-agent': 'Mozilla/5.0',
    });
    expect(req.headers.referer).toBe(`${ORIGIN}/reset-password?token=rst_live`);
  });

  it('adds no referer header when the request had none', () => {
    expect(redactRequest({ url: '/health', headers: { host: 'api' } }).headers).toEqual({ host: 'api' });
  });
});

describe('the request log', () => {
  it('never holds a landing secret that arrived as the Referer', async () => {
    const lines: string[] = [];
    const logged = createApp({
      logDestination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });

    for (const { path, query } of LANDINGS) {
      const res = await request(logged).get('/health').set('Referer', `${ORIGIN}${path}?${query}`);
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setImmediate(r));

    const log = lines.join('');
    expect(lines).toHaveLength(LANDINGS.length);
    for (const { path, secrets } of LANDINGS) {
      expect(log).toContain(`"referer":"${ORIGIN}${path}?[REDACTED]"`);
      for (const secret of secrets) expect(log).not.toContain(secret);
    }
  });
});
