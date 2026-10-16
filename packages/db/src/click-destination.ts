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

// Brace tokens that look like an attempt at the macro ({clickid}, {CLICK_ID},
// {click-id}, {cref}). Left alone they'd reach the destination as literal
// text while the click id went to a `cref` the destination never reads.
const BRACE_TOKEN_RE = /\{([^{}]*)\}|%7[Bb](.*?)%7[Dd]/g;
const NEAR_MISS_NAMES = new Set(['clickid', 'cref']);

// Stand-in click id for validating a destination before any click exists.
const SAMPLE_CLICK_ID = '01J00000000000000000000000';

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
 *   - a misspelled macro ({clickid}, {CLICK_ID}, {cref}) is rejected rather
 *     than silently sent through as literal text
 *   - the macro may go in the path, query or fragment, never the host: the
 *     destination's site has to be fixed when the brand saves it
 *   - the URL must still parse once a click id is substituted
 */
export function clickDestinationProblem(destinationUrl: string): string | null {
  for (const match of destinationUrl.matchAll(BRACE_TOKEN_RE)) {
    const inner = (match[1] ?? match[2] ?? '').trim();
    if (inner === 'click_id') continue;
    if (NEAR_MISS_NAMES.has(inner.toLowerCase().replace(/[^a-z]/g, ''))) {
      return `Unknown macro "${match[0]}". The click id macro is spelled ${CLICK_ID_MACRO}.`;
    }
  }
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
