/**
 * The portal's referrer policy. Landing pages hold single-use secrets in
 * the query, and the browser default (strict-origin-when-cross-origin)
 * sends the full URL on same-origin requests. Hosted serves /api on the
 * portal's origin, so an /api call a landing page made before taking the
 * secret out of the address bar carried it to the API in the Referer.
 */
import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';

describe('index.html', () => {
  it('sends only the origin as the Referer, set before anything loads', () => {
    const policies = [...html.matchAll(/<meta\s+name="referrer"\s+content="([^"]*)"/g)].map((m) => m[1]);
    expect(policies).toEqual(['strict-origin']);
    const meta = html.indexOf('<meta name="referrer"');
    expect(meta).toBeLessThan(html.search(/<(script|link)\b/));
  });
});
