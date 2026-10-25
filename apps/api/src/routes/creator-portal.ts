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
 *
 * The Network sees this server as the caller, so every proxied request
 * vouches for the creator's own address with a signed header the Network
 * uses for its country checks (docs/country-access.md; the Network's
 * src/client-ip.ts verifies it).
 */

import { createHmac } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';

export const creatorPortalRouter = Router();

export const CLIENT_IP_HEADER = 'x-openpartner-client-ip';

/**
 * `<ip>;t=<unix seconds>;sig=<hex HMAC-SHA256(key, "<ip>.<t>")>`. The key is
 * NETWORK_ADMIN_API_KEY, which the Network holds as ADMIN_API_KEY; the key
 * itself never travels with creator traffic. The Network ignores a header
 * older than five minutes, so it can't be replayed later.
 */
export function signClientIp(ip: string, key: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  const sig = createHmac('sha256', key).update(`${ip}.${t}`).digest('hex');
  return `${ip};t=${t};sig=${sig}`;
}

// Image-upload bodies arrive as raw binary, not JSON. The global
// express.json() middleware ignores image content-types, so without this
// raw parser req.body would be {} and the proxy would forward an empty
// payload to the Network. Cap matches the Network-side limit.
creatorPortalRouter.use(
  express.raw({
    type: ['image/jpeg', 'image/png', 'image/webp'],
    limit: 2 * 1024 * 1024,
  }),
);

// Whitelist: exact path match or prefix-with-glob. We only forward paths
// the Network exposes for creator-side flows, never anything else.
const ALLOWED_EXACT = new Set([
  '/creators/signup',
  '/creators/signin',
  '/creators/verify',
  // Passwords (the Network's docs/creator-auth.md): a correct password
  // returns the token /creators/signin would mail, redeemed at
  // /creators/verify; "forgot" mails a reset link to /creator/reset-password.
  // /creators/me/password is GET (has one?) + PUT (set / change).
  '/creators/signin/password',
  '/creators/password/forgot',
  '/creators/password/reset',
  '/creators/me/password',
  '/creators/signout',
  '/creators/whoami',
  '/creators/me',
  '/creators/me/affiliations',
  '/creators/me/requests',
  '/creators/me/delete',
  '/creators/me/restore',
  // GDPR access: the "Download my data" link on the creator profile.
  '/creators/me/export',
  '/creators/handle-available',
  '/creators/me/domains',
  '/creators/me/partnerships',
  '/creators/me/platforms',
  '/creators/me/recommendations',
  '/creators/me/uploads/avatar',
  // The banner on the public profile and the marketplace storefront card.
  '/creators/me/uploads/cover',
  // Where the creator is based: the one-time prompt (GET + PUT).
  '/creators/me/location',
  // Storefront (the Network's docs/creator-storefront.md): the bookings
  // switch, packages (list/create + reorder) and the requests inbox.
  '/creators/me/storefront',
  '/creators/me/packages',
  '/creators/me/packages/order',
  '/creators/me/bookings',
  // Import a storefront from Passionfroot: read and plan, then apply the
  // chosen items (the Network's docs/creator-storefront.md §7.3).
  '/creators/me/storefront/import/preview',
  '/creators/me/storefront/import/apply',
  // Conversations with brands, and the creator's own Stripe account that
  // bookings are paid into (the Network's docs/creator-storefront.md §8).
  '/creators/me/conversations',
  '/creators/me/payments',
  '/creators/me/payments/onboarding',
  '/offerings',
]);

const ALLOWED_PREFIX: Array<{ prefix: string; methods: Set<string> }> = [
  { prefix: '/offerings/', methods: new Set(['GET', 'POST']) },     // /offerings/:id, /offerings/:id/apply
  { prefix: '/vendors/', methods: new Set(['GET']) },                // /vendors/:id (public profile)
  { prefix: '/creators/me/affiliations/', methods: new Set(['GET']) },
  { prefix: '/creators/me/requests/', methods: new Set(['POST']) },
  // Custom share-domain management — POST /verify, DELETE the domain.
  { prefix: '/creators/me/domains/', methods: new Set(['POST', 'DELETE']) },
  // Per-partnership operations: slug edit (PATCH), coupon
  // append/deactivate (POST/DELETE .../coupons), and analytics reads
  // (GET .../timeseries|events|customers|commissions). Single prefix
  // covers all since the matcher is method+prefix only — finer
  // method/path checks live on the Network side.
  { prefix: '/creators/me/partnerships/', methods: new Set(['GET', 'PATCH', 'POST', 'DELETE']) },
  // Per-platform handle upsert (PUT) + delete, and account verification
  // (POST .../:platform/verify/start, POST .../:platform/verify).
  { prefix: '/creators/me/platforms/', methods: new Set(['PUT', 'DELETE', 'POST']) },
  // Public profile lookup — no creator session required, lets brands
  // and the open web hit /creators/by-handle/<handle> on the portal.
  // POST is the storefront request form: /creators/by-handle/<handle>/bookings
  // (no auth; the requester continues from an emailed link as a brand before
  // the creator sees it).
  { prefix: '/creators/by-handle/', methods: new Set(['GET', 'POST']) },
  // Storefront: edit/delete a package (PATCH/DELETE /creators/me/packages/:id),
  // answer, withdraw, deliver, refund or delete a booking (POST
  // .../:id/accept|decline|withdraw|deliver|refund, DELETE .../:id).
  { prefix: '/creators/me/packages/', methods: new Set(['PATCH', 'DELETE']) },
  { prefix: '/creators/me/bookings/', methods: new Set(['POST', 'DELETE']) },
  // A conversation: read it (GET .../:id), write, send an offer, block
  // (POST .../:id/messages|offers|block|unblock).
  { prefix: '/creators/me/conversations/', methods: new Set(['GET', 'POST']) },
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
    // Without it the Network can only check this server's address.
    const adminKey = process.env.NETWORK_ADMIN_API_KEY;
    if (adminKey && req.ip) headers[CLIENT_IP_HEADER] = signClientIp(req.ip, adminKey);

    const init: RequestInit = {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(10_000),
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Binary bodies (image uploads, populated by the express.raw
      // middleware above) forward as-is. Everything else gets JSON
      // serialized — the global express.json() middleware put a parsed
      // object on req.body for application/json requests.
      if (Buffer.isBuffer(req.body)) {
        init.body = req.body;
      } else if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
      }
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

    // The data export arrives as an attachment with a filename; relay that
    // so the browser saves it rather than showing the JSON.
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) res.setHeader('content-disposition', disposition);

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
    // Force JSON content-type on the response. The upstream is the
    // Network — which we control — but pinning the type here means a
    // future Network change that returns html/plain (e.g. an error
    // page) can't end up XSS'd into a browser-rendered page on
    // app.openpartner.dev. All Network endpoints we proxy already
    // return JSON; if they didn't, the body string is JSON-serialized
    // and rendered as text by the browser regardless.
    if (upstreamCt.includes('application/json')) {
      res.type('application/json').send(body);
    } else {
      res.type('application/json').send(JSON.stringify({ raw: body, contentType: upstreamCt || null }));
    }
  } catch (err) {
    console.error('[creator-portal] proxy failed', { subpath, method: req.method, err });
    res.status(502).json({
      error: 'proxy_error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
