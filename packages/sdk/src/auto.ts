/**
 * Script-tag build of the browser SDK — for sites with no bundler. An
 * OpenPartner portal serves it at /op.js:
 *
 *   <script src="https://app.openpartner.dev/op.js"
 *           data-api-url="https://app.openpartner.dev/api/t/your-slug"></script>
 *
 * It starts itself: captures the partner click, links Stripe Payment Links
 * and Pricing Table / Buy Button embeds to it, keeps it in a first-party
 * `op_ref` cookie your server can read, and reports the click's landing.
 * The instance is `window.openpartner` (`openpartner.identify(userId)`,
 * `openpartner.getReferral()`, `openpartner.setConsent('granted')`).
 *
 * Attributes on the tag:
 *   data-api-url         API base for identify(). Default: the script's
 *                        origin + /api.
 *   data-stripe-hosts    Extra Payment Link hosts, comma-separated
 *                        (a custom Payment Link domain).
 *   data-stripe          "off" leaves Stripe links alone.
 *   data-cookie-domain   Share op_ref across subdomains (".yourbrand.com").
 *   data-cookie          "off" skips the op_ref cookie.
 *   data-consent         "pending" waits for openpartner.setConsent()
 *                        (call it from your consent banner's callback);
 *                        "denied" starts with nothing; "regional" waits
 *                        where the visitor's country needs opt-in consent
 *                        and starts elsewhere (openpartner.consentRegion()
 *                        says which). Default: granted.
 *   data-gpc             "ignore": with data-consent="regional", start in
 *                        an opt-out country even when the browser sends
 *                        Global Privacy Control or Do Not Track. Default:
 *                        such a signal waits for setConsent().
 *   data-landing         "off" skips the landing report.
 *
 * Put it in <head>, before any Stripe embed script (see watchStripe).
 */

import { OpenPartner, type OpenPartnerConfig } from './browser.js';

export interface AutoInitOptions {
  src: string;
  dataset: Record<string, string | undefined>;
}

/** The SDK config a script tag's attributes describe. Exported for tests. */
export function configFromScript(tag: AutoInitOptions) {
  const d = tag.dataset;
  let apiUrl = (d.apiUrl ?? '').trim();
  if (!apiUrl) {
    try {
      apiUrl = `${new URL(tag.src).origin}/api`;
    } catch {
      apiUrl = '/api';
    }
  }
  const linkHosts = (d.stripeHosts ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const consent: NonNullable<OpenPartnerConfig['consent']> =
    d.consent === 'pending' || d.consent === 'denied' || d.consent === 'regional' ? d.consent : 'granted';
  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    stripe: d.stripe === 'off' ? (false as const) : { linkHosts },
    referralCookie:
      d.cookie === 'off' ? (false as const) : { name: 'op_ref', ...(d.cookieDomain ? { domain: d.cookieDomain } : {}) },
    consent,
    privacySignals: d.gpc === 'ignore' ? ('ignore' as const) : ('decline' as const),
    reportLanding: d.landing !== 'off',
  };
}

declare global {
  interface Window {
    openpartner?: OpenPartner;
    OpenPartner?: typeof OpenPartner;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.openpartner) {
  const script = document.currentScript as HTMLScriptElement | null;
  window.OpenPartner = OpenPartner;
  window.openpartner = OpenPartner.init(
    configFromScript({ src: script?.src ?? window.location.href, dataset: { ...(script?.dataset ?? {}) } }),
  );
}
