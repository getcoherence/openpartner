/**
 * Platform-level Creator portal proxy.
 *
 * The multi-tenant deployment at app.openpartner.dev needs a creator
 * surface that lives outside any single vendor tenant. Creators sign up
 * here, get a Network-issued session, browse offerings across the
 * federation, and apply. When a vendor approves, that vendor's instance
 * federation flow creates a Partner row inside their tenant — but the
 * creator's "home" stays here.
 *
 * Implementation: thin reverse proxy from /api/creator/* into the Network
 * API. We pass cookies straight through so Network's
 * `op_network_creator_session` cookie ends up scoped to app.openpartner.dev
 * (Network sets the cookie without a Domain attribute, so the browser
 * scopes it to whichever host responded — that's us). The Network already
 * has all the Creator/magic-link/discover/apply endpoints we need; we
 * don't duplicate any of that here.
 *
 * Public endpoints (no creator session needed) are also proxied so the
 * Discover/Vendor pages render before signup.
 */

import { Router, type Request, type Response } from 'express';

export const creatorPortalRouter = Router();

// Whitelist: exact path match or prefix-with-glob. We only forward paths
// the Network exposes for creator-side flows, never anything else.
const ALLOWED_EXACT = new Set([
  '/creators/signup',
  '/creators/signin',
  '/creators/verify',
  '/creators/signout',
  '/creators/whoami',
  '/creators/me',
  '/creators/me/affiliations',
  '/creators/me/requests',
  '/creators/me/delete',
  '/creators/me/restore',
  '/creators/handle-available',
  '/creators/me/domains',
  '/creators/me/partnerships',
  '/creators/me/platforms',
  '/creators/me/recommendations',
  '/offerings',
]);

const ALLOWED_PREFIX: Array<{ prefix: string; methods: Set<string> }> = [
  { prefix: '/offerings/', methods: new Set(['GET', 'POST']) },     // /offerings/:id, /offerings/:id/apply
  { prefix: '/vendors/', methods: new Set(['GET']) },                // /vendors/:id (public profile)
  { prefix: '/creators/me/affiliations/', methods: new Set(['GET']) },
  { prefix: '/creators/me/requests/', methods: new Set(['POST']) },
  // Custom share-domain management — POST /verify, DELETE the domain.
  { prefix: '/creators/me/domains/', methods: new Set(['POST', 'DELETE']) },
  // Per-partnership slug edit (creatorSlug — the path under custom domain).
  { prefix: '/creators/me/partnerships/', methods: new Set(['PATCH']) },
  // Per-platform handle upsert (PUT) + delete.
  { prefix: '/creators/me/platforms/', methods: new Set(['PUT', 'DELETE']) },
  // Public profile lookup — no creator session required, lets brands
  // and the open web hit /creators/by-handle/<handle> on the portal.
  { prefix: '/creators/by-handle/', methods: new Set(['GET']) },
  // Invitation deeplink resolver (no auth) + consume (creator auth).
  // GET /invitations/:token, POST /invitations/:token/consume
  { prefix: '/invitations/', methods: new Set(['GET', 'POST']) },
];

function isAllowed(method: string, subpath: string): boolean {
  if (ALLOWED_EXACT.has(subpath)) return true;
  for (const { prefix, methods } of ALLOWED_PREFIX) {
    if (subpath.startsWith(prefix) && methods.has(method)) return true;
  }
  return false;
}

creatorPortalRouter.all(/^\/creator-api(\/.*)?$/, async (req: Request, res: Response) => {
  const networkUrl = process.env.NETWORK_URL;
  if (!networkUrl) {
    return res.status(503).json({ error: 'network_not_configured' });
  }

  const subpath = req.path.replace(/^\/creator-api/, '') || '/';
  if (!isAllowed(req.method, subpath)) {
    return res.status(404).json({ error: 'not_found' });
  }

  // Outer try/catch returns proxy_error instead of letting the global
  // 500 handler swallow the cause as opaque "internal_error". Anything
  // that throws past the fetch (header parsing, body decode, cookie
  // splitting) lands here with the upstream subpath in the log line.
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstreamUrl = `${networkUrl.replace(/\/$/, '')}${subpath}${qs}`;

    // Forward only the bits the upstream cares about. We strip Authorization
    // (no openpartner bearer should leak to Network) and Host (let fetch set it).
    const headers: Record<string, string> = {};
    const ct = req.header('content-type');
    if (ct) headers['content-type'] = ct;
    const cookie = req.header('cookie');
    if (cookie) headers['cookie'] = cookie;
    headers['user-agent'] = 'OpenPartner-CreatorPortal/1';
    headers['x-forwarded-for'] = req.ip ?? '';

    const init: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(10_000),
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, init);
    } catch (err) {
      console.error('[creator-portal] fetch failed', { subpath, err });
      return res.status(502).json({
        error: 'network_unreachable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Set-Cookie handling has two gotchas:
    //   1. Node fetch returns multiple Set-Cookie headers comma-joined when
    //      you call .get('set-cookie'); the browser then can't parse them.
    //      Use getSetCookie() (Node 19.7+) to get each one separately.
    //   2. Cloudflare in front of network.openpartner.dev injects its own
    //      __cf_bm cookie with Domain=network.openpartner.dev — relaying
    //      that to app.openpartner.dev confuses the browser. Filter it out.
    // We also strip any Domain attribute on the cookies we DO forward so
    // they scope to app.openpartner.dev (the host that responded).
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    const forward: string[] = [];
    for (const c of cookies) {
      const name = c.split('=', 1)[0]?.trim() ?? '';
      if (!name || name.startsWith('__cf') || name.startsWith('_cf')) continue;
      forward.push(c.replace(/;\s*Domain=[^;]+/i, ''));
    }
    if (forward.length > 0) res.setHeader('set-cookie', forward);

    const upstreamCt = upstream.headers.get('content-type') ?? '';
    const body = await upstream.text();

    // Log non-2xx upstream responses with body so we can debug Network-side
    // failures from API logs without needing to wire client-side telemetry.
    // Truncate at 500 chars in case Network returns a large HTML error page.
    if (upstream.status >= 400) {
      console.error('[creator-portal] upstream error', {
        method: req.method,
        subpath,
        status: upstream.status,
        body: body.length > 500 ? `${body.slice(0, 500)}…(truncated)` : body,
      });
    }

    res.status(upstream.status);
    if (upstreamCt.includes('application/json')) {
      res.type('application/json').send(body);
    } else {
      res.send(body);
    }
  } catch (err) {
    console.error('[creator-portal] proxy failed', { subpath, method: req.method, err });
    res.status(502).json({
      error: 'proxy_error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
