/**
 * Browser SDK — runs inside a merchant's web app. Captures the `cref`
 * attribution token from landing-page URLs and the first-party cookie
 * the click router sets, stashes it in localStorage so it survives
 * Safari / ITP cookie expiry and SPA navigations, and stitches to the
 * authenticated user on signup or login.
 *
 * Typical integration:
 *
 *   import { OpenPartner } from '@openpartner/sdk';
 *
 *   const op = OpenPartner.init({ apiUrl: 'https://openpartner.example.com' });
 *
 *   // After login/signup, once you know who the user is:
 *   await op.identify(user.id);
 *
 * With a captured referral it also hands the click to Stripe on its own:
 * Payment Links (buy.stripe.com) get `client_reference_id`, and Stripe
 * Pricing Table / Buy Button embeds get `client-reference-id`, including
 * ones added to the page later. A brand whose Stripe account is connected
 * to OpenPartner then needs no code for those checkouts. `stripe: false`
 * turns it off.
 *
 * No bundler? The same SDK ships as a script tag that starts itself
 * (auto.ts), served at /op.js by an OpenPartner portal.
 */

import { OpenPartnerError, requestJson, type IdentifyResponse } from './shared.js';

export { OpenPartnerError };
export type { IdentifyResponse };

export interface StripeLinkingConfig {
  /** Extra Payment Link hosts — a custom domain set up for Payment Links
   *  in Stripe (e.g. "pay.yourbrand.com"). buy.stripe.com is always on. */
  linkHosts?: string[];
}

export interface OpenPartnerConfig {
  /** Base URL of your OpenPartner API, e.g. "https://openpartner.example.com". */
  apiUrl: string;
  /** First-party cookie name set by the click router. Default `_cref`. */
  cookieName?: string;
  /** Query-string parameter that carries the cref on the landing URL. Default `cref`. */
  queryParam?: string;
  /** localStorage key the captured cref is stashed under. Default `openpartner:cref`. */
  storageKey?: string;
  /**
   * Hand the captured referral to Stripe Payment Links and Pricing Table /
   * Buy Button embeds on the page. Default on; `false` turns it off.
   */
  stripe?: boolean | StripeLinkingConfig;
  /**
   * Also keep the referral in a first-party cookie, so your server can read
   * it straight off the request when it creates a Stripe Checkout Session
   * (`client_reference_id: req.cookies.op_ref`). Off by default; the
   * script-tag build turns it on. `domain` shares it across subdomains
   * (".yourbrand.com") when visitors land on one and check out on another.
   */
  referralCookie?: false | { name?: string; domain?: string; days?: number };
  /**
   * Called when identify() fails. Default: log to console. Pass a noop
   * to suppress entirely or hook into your observability stack.
   */
  onError?: (err: unknown) => void;
}

const DEFAULTS = {
  cookieName: '_cref',
  queryParam: 'cref',
  storageKey: 'openpartner:cref',
  stripe: true,
  referralCookie: false,
  onError: (err: unknown) => {
    console.warn('[openpartner] identify failed', err);
  },
};

/** Stripe accepts a client_reference_id of letters, digits, "-" and "_",
 *  up to 200, and silently drops anything else. A click id always fits; a
 *  value that doesn't came from somewhere else and isn't sent. */
const STRIPE_REFERENCE_RE = /^[A-Za-z0-9_-]{1,200}$/;
const STRIPE_EMBED_SELECTOR = 'stripe-pricing-table, stripe-buy-button';

export class OpenPartner {
  private config: Required<OpenPartnerConfig>;
  private observer: MutationObserver | null = null;

  private constructor(config: OpenPartnerConfig) {
    this.config = { ...DEFAULTS, ...config } as Required<OpenPartnerConfig>;
    this.captureCref();
    this.writeReferralCookie();
    if (this.config.stripe !== false) this.watchStripe();
  }

  static init(config: OpenPartnerConfig): OpenPartner {
    return new OpenPartner(config);
  }

  /** The cref we're holding onto, if any. Useful for debugging. */
  getCref(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(this.config.storageKey);
  }

  /**
   * Captured referral token for this visitor. Pass to Stripe Checkout
   * as `client_reference_id` to enable webhook-based attribution
   * without an explicit identify() call:
   *
   *   stripe.checkout.sessions.create({
   *     client_reference_id: op.getReferral() ?? undefined,
   *     // ...
   *   });
   *
   * Returns null if the visitor didn't arrive via a partner link.
   */
  getReferral(): string | null {
    return this.getCref();
  }

  /** Explicitly discard the captured cref. */
  clear(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.config.storageKey);
  }

  /**
   * Add the referral to every Stripe Payment Link and Pricing Table / Buy
   * Button embed under `root` that doesn't carry a reference already.
   * Runs on its own at init and for anything added later; call it yourself
   * only if you build Stripe elements inside a shadow root. Returns how
   * many it changed.
   */
  linkStripe(root: ParentNode = document): number {
    const referral = this.getReferral();
    if (!referral || !STRIPE_REFERENCE_RE.test(referral) || typeof document === 'undefined') return 0;
    const hosts = new Set(['buy.stripe.com', ...this.stripeLinkHosts()]);
    let changed = 0;

    const anchors: HTMLAnchorElement[] = [];
    if (root instanceof HTMLAnchorElement) anchors.push(root);
    anchors.push(...Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')));
    for (const a of anchors) {
      let url: URL;
      try {
        url = new URL(a.href);
      } catch {
        continue;
      }
      // One the brand set itself (or an earlier pass) stays as it is.
      if (!hosts.has(url.hostname.toLowerCase()) || url.searchParams.has('client_reference_id')) continue;
      url.searchParams.set('client_reference_id', referral);
      a.href = url.toString();
      changed += 1;
    }

    const embeds: Element[] = [];
    if (root instanceof Element && root.matches(STRIPE_EMBED_SELECTOR)) embeds.push(root);
    embeds.push(...Array.from(root.querySelectorAll(STRIPE_EMBED_SELECTOR)));
    for (const el of embeds) {
      if (el.hasAttribute('client-reference-id')) continue;
      el.setAttribute('client-reference-id', referral);
      changed += 1;
    }
    return changed;
  }

  /** Stop watching the page for new Stripe links and embeds. */
  stopLinkingStripe(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private stripeLinkHosts(): string[] {
    const cfg = this.config.stripe;
    return typeof cfg === 'object' && cfg.linkHosts ? cfg.linkHosts.map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  }

  /**
   * Link what's on the page now, then anything added or re-pointed later
   * (SPAs, Stripe embeds mounted on demand). Only with a referral: a visitor
   * who didn't come from a partner link costs nothing.
   *
   * Pricing Table and Buy Button embeds read client-reference-id when
   * Stripe's script renders them, so the script tag belongs in <head>,
   * ahead of the embed: the observer then sets the attribute as the
   * element is parsed, before Stripe upgrades it.
   */
  private watchStripe(): void {
    if (typeof document === 'undefined' || !this.getReferral()) return;
    this.linkStripe(document);
    if (typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          // An href re-pointed at a Payment Link.
          if (record.target instanceof HTMLAnchorElement) this.linkStripe(record.target);
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) this.linkStripe(node);
        }
      }
    });
    // Our own edits only ever add a missing reference, so the second pass
    // they trigger finds nothing to change.
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  /**
   * Capture the cref from query string or cookie and stash in
   * localStorage. Runs on init so the value survives SPA navigations,
   * ITP cookie expiry, and subsequent page loads.
   */
  private captureCref(): void {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;

    const url = new URL(window.location.href);
    const queryCref = url.searchParams.get(this.config.queryParam);

    if (queryCref) {
      localStorage.setItem(this.config.storageKey, queryCref);
      return;
    }

    const cookieCref = this.readCookie(this.config.cookieName);
    if (cookieCref && !localStorage.getItem(this.config.storageKey)) {
      localStorage.setItem(this.config.storageKey, cookieCref);
    }
  }

  /** Mirror the referral into the brand's own first-party cookie (when
   *  configured), refreshed on every page load that has one. */
  private writeReferralCookie(): void {
    const cfg = this.config.referralCookie;
    if (!cfg || typeof document === 'undefined') return;
    const referral = this.getReferral();
    if (!referral || !STRIPE_REFERENCE_RE.test(referral)) return;
    const name = cfg.name ?? 'op_ref';
    const maxAge = Math.round((cfg.days ?? 90) * 86400);
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    const domain = cfg.domain ? `; Domain=${cfg.domain}` : '';
    document.cookie = `${name}=${encodeURIComponent(referral)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${domain}${secure}`;
  }

  private readCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]+)`));
    return match ? decodeURIComponent(match[2]!) : null;
  }

  /**
   * Stitch the current captured click to an authenticated user. Call
   * this on login, signup, or anywhere the user becomes known.
   *
   * No-op if no cref was captured. Errors are reported through
   * `config.onError` by default — attribution is best-effort from the
   * browser — but you can await this and try/catch if you want to
   * surface failures explicitly.
   */
  async identify(userId: string): Promise<IdentifyResponse | null> {
    const cref = this.getCref();
    if (!cref) return null;

    try {
      return await requestJson<IdentifyResponse>(`${this.config.apiUrl}/attribution/identify`, {
        method: 'POST',
        body: { cref, userId, ts: Date.now() },
        keepalive: true,
      });
    } catch (err) {
      this.config.onError(err);
      return null;
    }
  }
}
