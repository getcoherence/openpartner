/**
 * Where to send a brand admin once they've signed in and entered a
 * workspace, carried as ?next= through /signin, the emailed sign-in link,
 * Google sign-in and /workspaces. /go/creators/<handle> starts it, so a
 * link from outside the app (the public storefront on openpartner.dev) can
 * open /t/<slug>/admin/network/creators/<handle> without knowing <slug>.
 *
 * It's a path inside the workspace, which /workspaces prefixes with
 * /t/<slug>, so only a same-origin path under /admin/ passes: no scheme or
 * host, no protocol-relative //, no backslashes (browsers read them as /),
 * nothing but printable ASCII, and no dot segments that climb out of
 * /admin/. Anything else is null and the caller lands where it always has,
 * so a crafted link can't send someone off-site. The API checks it before
 * writing it into a sign-in link; the portal checks it again on reading.
 */

export const NEXT_PATH_MAX_LENGTH = 512;

const BASE = 'https://next.invalid';

/** `raw` as a path on the page's own origin, or null for anything that
 *  could leave it. Dot segments, %2e-encoded ones too, are resolved in the
 *  result. */
function sameOriginPath(raw: string | null | undefined): URL | null {
  if (typeof raw !== 'string' || raw.length > NEXT_PATH_MAX_LENGTH) return null;
  if (!/^\/[\x21-\x7e]*$/.test(raw) || raw.startsWith('//') || raw.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  return url.origin === BASE ? url : null;
}

export function safeNextPath(raw: string | null | undefined): string | null {
  const url = sameOriginPath(raw);
  if (!url || !url.pathname.startsWith('/admin/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where a partner lands after a sign-in link the brand's backend minted
 * (POST /partners/{id}/signin-link `returnTo`, carried as ?next= on the
 * link): a path inside the partner portal, `/links` or `/commissions` say,
 * which the portal prefixes with /t/<slug> on the path-based origin. Any
 * same-origin path passes the same checks as safeNextPath; anything else
 * is null, and the partner lands on the dashboard.
 *
 * The resolved path must not start with // either: `/.//evil.example`
 * resolves to `//evil.example`, which a white-label domain (no /t/<slug>
 * prefix) would hand the router as a protocol-relative URL. safeNextPath
 * can't produce one, since its result starts with /admin/.
 */
export function safePortalPath(raw: string | null | undefined): string | null {
  const url = sameOriginPath(raw);
  if (!url || url.pathname.startsWith('//')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
