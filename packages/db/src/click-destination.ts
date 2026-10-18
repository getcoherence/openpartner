/**
 * Where a tracking link sends the visitor, and how the click id rides along.
 *
 * By default the click router appends `cref=<clickId>` to the destination,
 * which is what the browser SDK reads. Some destinations only read their own
 * parameter: a Stripe Payment Link takes the referral from
 * `client_reference_id` and ignores everything else. A destination that
 * contains the `{click_id}` macro gets the click id substituted there instead,
 * and no `cref` is appended:
 *
 *   https://buy.stripe.com/abc?client_reference_id={click_id}
 *
 * Click ids are ULIDs (26 chars of [0-9A-Z]), so they need no escaping and
 * fit Stripe's client_reference_id alphabet (alphanumerics, `-`, `_`).
 *
 * Shared by the router (substitution at click time) and the API (validation
 * when a brand saves a destination). The Network's share router redirects to
 * the same URL (Offering.productUrl mirrors Program.destinationUrl), so it
 * has to honour the macro too.
 */

export const CLICK_ID_MACRO = '{click_id}';

// The literal macro, or its percent-encoded form: a client that normalized
// the URL (new URL() encodes `{` `}` in a path) still gets substituted.
const MACRO_RE = /\{click_id\}|%7[Bb]click_id%7[Dd]/g;

// The router fills in only the exact macro, so any other brace text
// ({subid}, { click_id }, {{click_id}}, an unclosed {click_id) reaches the
// destination as typed while the click id goes to a `cref` the destination
// never reads. Stripe then drops a client_reference_id holding a brace
// without any error, and the referral is lost. The check runs on a copy with
// encoded braces and spaces decoded, so `%7B%20click_id%20%7D` is caught too.
// A pair whose body is still percent-encoded (`%7B%22plan%22%3A1%7D`) is
// encoded data, not a macro attempt, and is left alone.
const BRACE_TOKEN_RE = /\{([^{}]*)\}/g;
// The first run can't hold a `%`, so a body full of them is scanned once
// rather than retried from every `%` (quadratic on a hostile URL).
const ENCODED_DATA_RE = /\{[^{}%]*%[^{}]*\}/g;
// Nesting levels of encoded data peeled before a leftover brace counts as
// stray. Bounds the work on a hostile URL.
const MAX_ENCODED_NESTING = 8;
const NEAR_MISS_NAMES = new Set(['clickid', 'cref']);
// Stands in for each exact macro while the rest of the URL is checked, so
// `{{click_id}}` reads as a token wrapped around a macro.
const MACRO_MARK = '\u0000';

// Stand-in click id for validating a destination before any click exists.
const SAMPLE_CLICK_ID = '01J00000000000000000000000';

// Stripe-hosted checkout pages read the referral only from
// client_reference_id, and drop a value outside this alphabet silently
// (docs.stripe.com/payment-links/url-parameters).
const STRIPE_CHECKOUT_HOSTS = new Set(['buy.stripe.com', 'checkout.stripe.com']);
const STRIPE_REFERENCE_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function hasClickIdMacro(destinationUrl: string): boolean {
  MACRO_RE.lastIndex = 0;
  return MACRO_RE.test(destinationUrl);
}

/**
 * The URL a click on a link with this destination redirects to: the click id
 * substituted for every `{click_id}`, or appended as `cref` when there is no
 * macro. Throws on a URL that doesn't parse, as `new URL()` does.
 */
export function clickDestination(destinationUrl: string, clickId: string): string {
  if (hasClickIdMacro(destinationUrl)) {
    return new URL(destinationUrl.replace(MACRO_RE, clickId)).toString();
  }
  const url = new URL(destinationUrl);
  url.searchParams.set('cref', clickId);
  return url.toString();
}

/**
 * Why this destination can't be saved, or null when it's fine. Checks only
 * what the macro adds; the caller still validates it as a URL.
 *   - the only brace text allowed is the exact macro, `{click_id}` or
 *     `%7Bclick_id%7D`, because that's all the router substitutes. Anything
 *     else ({{click_id}}, { click_id }, {CLICK_ID}, {subid}, a stray brace)
 *     would reach the destination as literal text, so it's rejected
 *   - the macro may go in the path, query or fragment, never the host: the
 *     destination's site has to be fixed when the brand saves it
 *   - the URL must still parse once a click id is substituted
 */
export function clickDestinationProblem(destinationUrl: string): string | null {
  const braces = braceProblem(destinationUrl);
  if (braces) return braces;
  if (!hasClickIdMacro(destinationUrl)) return null;

  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(destinationUrl)?.[1] ?? '';
  if (hasClickIdMacro(authority)) {
    return `${CLICK_ID_MACRO} can go in the path, query or fragment, not the host.`;
  }
  try {
    clickDestination(destinationUrl, SAMPLE_CLICK_ID);
  } catch {
    return `The URL doesn't parse once ${CLICK_ID_MACRO} is replaced with a click id.`;
  }
  return null;
}

function braceProblem(destinationUrl: string): string | null {
  let rest = destinationUrl
    .replace(MACRO_RE, MACRO_MARK)
    .replace(/%7[Bb]/g, '{')
    .replace(/%7[Dd]/g, '}')
    .replace(/%20/g, ' ');
  for (let level = 0; level < MAX_ENCODED_NESTING; level += 1) {
    const peeled = rest.replace(ENCODED_DATA_RE, '');
    if (peeled === rest) break;
    rest = peeled;
  }
  for (const match of rest.matchAll(BRACE_TOKEN_RE)) {
    const inner = match[1] ?? '';
    if (inner.includes('%')) continue; // encoded data nested too deep to peel; the stray check below refuses it
    if (inner.includes(MACRO_MARK)) {
      return `Use single braces: ${CLICK_ID_MACRO}. Double braces are Zapier and Make syntax; OpenPartner would send them through as text, so the click id would never arrive.`;
    }
    if (NEAR_MISS_NAMES.has(inner.toLowerCase().replace(/[^a-z]/g, ''))) {
      return `"${match[0]}" isn't replaced. Write the click id macro exactly as ${CLICK_ID_MACRO}: lower case, no spaces.`;
    }
    return `"${match[0]}" isn't a macro OpenPartner fills in, so it would reach the destination as text. The only macro is ${CLICK_ID_MACRO}.`;
  }
  const stray = /[{}]/.exec(rest)?.[0];
  if (stray) {
    return `The URL has an unmatched "${stray}". The only macro is ${CLICK_ID_MACRO}, written exactly like that.`;
  }
  return null;
}

/**
 * Something about this destination that will probably lose referrals but
 * doesn't stop it being saved, or null. Today: a Stripe-hosted checkout
 * (buy.stripe.com, checkout.stripe.com) reads the referral only from
 * `client_reference_id`, so without the macro there the click never reaches
 * Stripe, and a value Stripe can't accept is dropped without an error.
 * Call it only on a destination clickDestinationProblem accepts.
 */
export function clickDestinationWarning(destinationUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    return null;
  }
  if (!STRIPE_CHECKOUT_HOSTS.has(url.hostname.toLowerCase())) return null;

  if (!hasClickIdMacro(url.searchParams.get('client_reference_id') ?? '')) {
    return `Stripe reads the referral only from client_reference_id, so purchases through this link can't be credited to the partner. Add client_reference_id=${CLICK_ID_MACRO} to the query, written exactly like that.`;
  }
  let value = '';
  try {
    value = new URL(clickDestination(destinationUrl, SAMPLE_CLICK_ID)).searchParams.get('client_reference_id') ?? '';
  } catch {
    // Unparseable once substituted: clickDestinationProblem's to report.
  }
  if (!STRIPE_REFERENCE_RE.test(value)) {
    return `Stripe ignores a client_reference_id with anything but letters, digits, "-" and "_" (up to 200), so purchases through this link can't be credited. Use client_reference_id=${CLICK_ID_MACRO} on its own.`;
  }
  return null;
}
