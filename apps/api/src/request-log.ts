/**
 * Request-log hygiene. pino-http records every request's URL, query, route
 * params and headers, and log stores keep them. Credentials riding in those
 * are replaced before a line is written:
 *   - the `token` query parameter: the conversion postback token on
 *     GET /postback is a URL credential by design
 *   - the Network's offering-invitation token, a path segment: the creator
 *     portal resolves and consumes an invitation through the proxy at
 *     /creator-api/invitations/<token>[/consume] (routes/creator-portal.ts).
 *     Anyone holding it can read the invitation, the brand's note included,
 *     without signing in. The Network keeps it out of its own log the same
 *     way (its src/request-log.ts).
 *   - the `code` query parameter: the OAuth authorization code Google and
 *     Stripe redirect back with (/auth/google/callback,
 *     /stripe-app/oauth/callback)
 *   - Authorization and Cookie headers: Bearer API keys, session cookies
 *   - the Referer header's whole query, whatever its names: portal landing
 *     pages hold single-use secrets there (?token=, ?ntoken=, ?invitation=,
 *     ?code=), and a page that calls /api before taking them out of the
 *     address bar sends the full landing URL. The portal's own referrer
 *     policy (apps/portal/index.html) keeps current browsers to the origin;
 *     this covers whatever else sends one.
 *   - Set-Cookie on the response: every sign-in hands the browser a session
 *     token (op_session, op_platform_session, op_platform_admin_session) and
 *     the op_bundle_id cookie this way. The values are replaced; cookie
 *     names and attributes stay, so a log still shows what was set or cleared.
 *   - Location on the response, with the same query rules as the URL: the
 *     Google callback redirects to a magic-link landing whose ?token= signs
 *     in whoever holds it (routes/google-auth.ts).
 */

const REDACTED = '[REDACTED]';
const SECRET_QUERY_PARAMS = new Set(['token', 'code']);
const SECRET_HEADERS = ['authorization', 'cookie'];
// The invitation token's segment, behind whatever came before /creator-api
// (/api from a proxy that keeps it, /t/<slug>), or with /creator-api already
// cut off, as the proxy itself sees the path.
const SECRET_PATH = /^((?:[^?#]*\/creator-api)?\/invitations\/)[^/?#]+/i;

/** The path (or URL) with the invitation token replaced. */
export function redactPath(path: string): string {
  return path.replace(SECRET_PATH, `$1${REDACTED}`);
}

/** The URL with the invitation token and every secret query parameter's value replaced. */
export function redactUrl(url: string): string {
  const path = redactPath(url);
  const q = path.indexOf('?');
  if (q === -1) return path;
  const hash = path.indexOf('#', q);
  const query = path.slice(q + 1, hash === -1 ? undefined : hash);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      return SECRET_QUERY_PARAMS.has(decodeName(rawName).toLowerCase()) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');
  return `${path.slice(0, q + 1)}${redacted}${hash === -1 ? '' : path.slice(hash)}`;
}

/**
 * A Referer cut at its query: `https://app.example/reset-password?token=x`
 * → `https://app.example/reset-password?[REDACTED]`. Unlike the request
 * URL, nothing in a Referer's query is worth keeping, so there is no list
 * of names to fall behind the portal's landing pages. A fragment goes too.
 */
export function redactReferer(referer: unknown): unknown {
  if (typeof referer !== 'string') return REDACTED;
  const cut = referer.search(/[?#]/);
  if (cut === -1) return referer;
  return referer[cut] === '?' ? `${referer.slice(0, cut)}?${REDACTED}` : referer.slice(0, cut);
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return name;
  }
}

interface SerializedRequest {
  url?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * pino-http `req` serializer. It receives the standard serialized request
 * (wrapSerializers), and returns a redacted copy without touching the live
 * request.
 */
export function redactRequest(req: SerializedRequest): SerializedRequest {
  const out: SerializedRequest = { ...req };
  if (typeof req.url === 'string') out.url = redactUrl(req.url);
  if (req.query && typeof req.query === 'object') {
    out.query = Object.fromEntries(
      Object.entries(req.query).map(([k, v]) => [k, SECRET_QUERY_PARAMS.has(k.toLowerCase()) ? REDACTED : v]),
    );
  }
  // pino-http serializes the request before routing, so params is {} today.
  // Once the proxy's route has matched, its params[0] is the path it
  // forwards: /invitations/<token>.
  if (req.params && typeof req.params === 'object') {
    out.params = Object.fromEntries(
      Object.entries(req.params).map(([k, v]) => [k, typeof v === 'string' ? redactPath(v) : v]),
    );
  }
  if (req.headers && typeof req.headers === 'object') {
    out.headers = { ...req.headers };
    for (const h of SECRET_HEADERS) if (h in out.headers) out.headers[h] = REDACTED;
    if ('referer' in out.headers) out.headers.referer = redactReferer(out.headers.referer);
  }
  return out;
}

interface SerializedResponse {
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `name=value; Path=/…` → `name=[REDACTED]; Path=/…` */
function redactSetCookie(line: unknown): unknown {
  return typeof line === 'string' ? line.replace(/=[^;]*/, `=${REDACTED}`) : REDACTED;
}

/** pino-http `res` serializer, the response-side twin of `redactRequest`. */
export function redactResponse(res: SerializedResponse): SerializedResponse {
  const setCookie = res.headers?.['set-cookie'];
  const location = res.headers?.location;
  if (setCookie === undefined && location === undefined) return res;
  return {
    ...res,
    headers: {
      ...res.headers,
      ...(setCookie === undefined
        ? {}
        : { 'set-cookie': Array.isArray(setCookie) ? setCookie.map(redactSetCookie) : redactSetCookie(setCookie) }),
      ...(location === undefined ? {} : { location: typeof location === 'string' ? redactUrl(location) : REDACTED }),
    },
  };
}
