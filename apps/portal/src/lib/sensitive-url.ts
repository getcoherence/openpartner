/**
 * One-time credentials that arrive in a URL query string: the magic-link
 * `token` (brand, platform, operator and creator sign-in) and the Network
 * onboarding `ntoken`. Anything that records the page URL (PostHog
 * pageviews, browser history, the Referer on outbound requests) would
 * otherwise hold a working sign-in link until the token is consumed or
 * expires.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = ['token', 'ntoken'];

const SENSITIVE_PARAM = /([?&#;])(token|ntoken)=[^&#\s"'<>]*/i;
const SENSITIVE_PARAM_ALL = new RegExp(SENSITIVE_PARAM.source, 'gi');

/**
 * Take the named params out of the address bar. replaceState keeps the
 * router's history state, adds no history entry and triggers no
 * navigation, so the page keeps the values it already read.
 */
export function stripQueryParamsFromAddressBar(names: readonly string[] = SENSITIVE_QUERY_PARAMS): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const present = names.filter((n) => url.searchParams.has(n));
  if (present.length === 0) return;
  for (const n of present) url.searchParams.delete(n);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/**
 * `value` without its sensitive query params: dropped when the string is
 * a URL, otherwise (a URL embedded in a longer string, such as an element
 * chain) their values are replaced with "redacted".
 */
export function scrubSensitiveParams(value: string): string {
  if (!SENSITIVE_PARAM.test(value)) return value;
  let out = value;
  if (/^https?:\/\//i.test(out)) {
    try {
      const url = new URL(out);
      for (const n of SENSITIVE_QUERY_PARAMS) url.searchParams.delete(n);
      out = url.toString();
    } catch {
      // Not a parseable URL after all; the redaction below still applies.
    }
  }
  return out.replace(SENSITIVE_PARAM_ALL, '$1$2=redacted');
}

/** A copy of `value` with {@link scrubSensitiveParams} applied to every
 *  string inside it, at any depth. Used as PostHog's before_send, so it
 *  covers $current_url, $referrer, the $set / $set_once person props and
 *  anything else that carries a URL. */
export function scrubSensitiveEvent<T>(value: T): T {
  if (typeof value === 'string') return scrubSensitiveParams(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubSensitiveEvent(v)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSensitiveEvent(v);
    return out as T;
  }
  return value;
}
