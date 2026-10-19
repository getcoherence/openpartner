/**
 * Script-tag build of the browser SDK — for sites with no bundler. An
 * OpenPartner portal serves it at /op.js:
 *
 *   <script src="https://app.openpartner.dev/op.js"
 *           data-api-url="https://app.openpartner.dev/api/t/your-slug"></script>
 *
 * It starts itself: captures the partner click, links Stripe Payment Links
 * and Pricing Table / Buy Button embeds to it, and keeps it in a first-party
 * `op_ref` cookie your server can read. The instance is `window.openpartner`
 * (`openpartner.identify(userId)`, `openpartner.getReferral()`).
 *
 * Attributes on the tag:
 *   data-api-url         API base for identify(). Default: the script's
 *                        origin + /api.
 *   data-stripe-hosts    Extra Payment Link hosts, comma-separated
 *                        (a custom Payment Link domain).
 *   data-stripe          "off" leaves Stripe links alone.
 *   data-cookie-domain   Share op_ref across subdomains (".yourbrand.com").
 *   data-cookie          "off" skips the op_ref cookie.
 *
 * Put it in <head>, before any Stripe embed script (see watchStripe).
 */

import { OpenPartner } from './browser.js';

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
  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    stripe: d.stripe === 'off' ? (false as const) : { linkHosts },
    referralCookie:
      d.cookie === 'off' ? (false as const) : { name: 'op_ref', ...(d.cookieDomain ? { domain: d.cookieDomain } : {}) },
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
