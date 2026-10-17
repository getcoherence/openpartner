/**
 * Request-log hygiene. pino-http records every request's URL, query and
 * headers, and log stores keep them. Credentials riding in those are
 * replaced before a line is written:
 *   - the `token` query parameter: the conversion postback token on
 *     GET /postback is a URL credential by design
 *   - Authorization and Cookie headers: Bearer API keys, session cookies
 */

const REDACTED = '[REDACTED]';
const SECRET_QUERY_PARAMS = new Set(['token']);
const SECRET_HEADERS = ['authorization', 'cookie'];

/** The URL with every secret query parameter's value replaced. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      return SECRET_QUERY_PARAMS.has(decodeName(rawName).toLowerCase()) ? `${rawName}=${REDACTED}` : pair;
    })
    .join('&');
  return `${url.slice(0, q + 1)}${redacted}${hash === -1 ? '' : url.slice(hash)}`;
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
  if (req.headers && typeof req.headers === 'object') {
    out.headers = { ...req.headers };
    for (const h of SECRET_HEADERS) if (h in out.headers) out.headers[h] = REDACTED;
  }
  return out;
}
