/**
 * Browser SDK — runs inside a merchant's web app. Captures the `cref`
 * attribution token from landing-page URLs and the first-party cookie
 * the click router sets, stashes it in localStorage so it survives SPA
 * navigations and later visits, and stitches to the authenticated user on
 * signup or login.
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
 * How long a referral lasts. Safari deletes storage that a page's own
 * scripts wrote (localStorage, and cookies set through document.cookie)
 * after 7 days without a visit, so a visitor who clicks, leaves for a
 * fortnight and comes back to buy without signing up first arrives with
 * nothing. A cookie the brand's own server sets on the landing response
 * isn't capped that way: `referralCookieHeader` in `@openpartner/sdk/server`
 * writes one, and this SDK reads it back (`op_ref`), on every subdomain it
 * covers. Once identify() has run, the stitch lives server-side and no
 * browser storage matters.
 *
 * Consent. `consent: 'pending'` holds the referral in memory until
 * setConsent('granted'): nothing is read from or written to storage or
 * cookies, no Stripe link is tagged and nothing is sent until then.
 * `consent: 'regional'` asks OpenPartner which rule applies where the
 * visitor is (GET /consent-region) and starts as 'pending' or 'granted'
 * accordingly (see the option).
 *
 * Landing report. When a click first arrives from the URL the SDK tells
 * OpenPartner (POST /attribution/landing), so Admin → Tracking health can
 * count the clicks that never reached a page running it. `reportLanding:
 * false` turns it off.
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

/** Whether this visitor agreed to referral tracking. */
export type ConsentState = 'granted' | 'pending' | 'denied';

/** The consent rule where the visitor is (GET /consent-region). */
export interface ConsentRegion {
  /** `'opt_in'`: ask before storing anything. `'opt_out'`: track unless the
   *  visitor declines. */
  rule: 'opt_in' | 'opt_out';
  /** ISO 3166-1 alpha-2, or null when it isn't known. */
  country: string | null;
}

/** How long `consent: 'regional'` waits for its answer before treating the
 *  visitor as opt-in. */
const REGION_TIMEOUT_MS = 1500;
const COUNTRY_RE = /^[A-Z]{2}$/;

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
   *
   * The SDK reads this cookie back whether or not it writes it (`op_ref`
   * unless `name` says otherwise): that's how a page on another subdomain,
   * or a visit after Safari cleared localStorage, finds the referral, and
   * how one your server set (`referralCookieHeader`) reaches identify().
   */
  referralCookie?: false | { name?: string; domain?: string; days?: number };
  /**
   * Whether the visitor has agreed to referral tracking. Default
   * `'granted'`: the SDK stores the referral as soon as it loads. Behind a
   * consent banner, start at `'pending'` and call `setConsent()` from its
   * callback. Until then the referral from the URL is held in memory only,
   * so a visitor who agrees on the landing page is still credited.
   * `'denied'` uses nothing.
   *
   * `'regional'` lets where the visitor is decide. The SDK starts as
   * `'pending'` and asks OpenPartner (GET `<apiUrl>/consent-region`) which
   * rule applies, storing nothing. `'opt_in'` (the EU, the rest of the EEA,
   * the UK and Switzerland), an unknown country, or no answer within 1.5
   * seconds: it stays `'pending'`. `'opt_out'`: it starts as `'granted'`,
   * unless setConsent() has already been called or the browser sends a
   * privacy signal (`privacySignals`). Your banner reads the answer from
   * consentRegion(), and should call setConsent('denied') as soon as it
   * knows of a saved decline.
   */
  consent?: ConsentState | 'regional';
  /**
   * With `consent: 'regional'`: what a Global Privacy Control or Do Not
   * Track signal means where tracking would otherwise start by itself.
   * `'decline'` (default) waits for setConsent(), as in an opt-in region;
   * `'ignore'` starts anyway.
   */
  privacySignals?: 'decline' | 'ignore';
  /**
   * Tell OpenPartner when a partner click arrives on your site, so Admin →
   * Tracking health can show clicks lost between the partner link and your
   * page. Sends the click id once per click, nothing about the visitor.
   * Default on; `false` turns it off.
   */
  reportLanding?: boolean;
  /**
   * Called when a call to OpenPartner fails: identify(), or a landing
   * report OpenPartner answered with `click_not_found` (which usually means
   * `apiUrl` names another program; other landing failures are dropped).
   * Default: log to console. Pass a noop to suppress entirely or
   * hook into your observability stack.
   */
  onError?: (err: unknown) => void;
}

const DEFAULTS = {
  cookieName: '_cref',
  queryParam: 'cref',
  storageKey: 'openpartner:cref',
  stripe: true,
  referralCookie: false,
  consent: 'granted',
  privacySignals: 'decline',
  reportLanding: true,
  onError: (err: unknown) => {
    console.warn('[openpartner] request failed', err);
  },
};

/** Stripe accepts a client_reference_id of letters, digits, "-" and "_",
 *  up to 200, and silently drops anything else. A click id always fits; a
 *  value that doesn't came from somewhere else and isn't sent. */
const STRIPE_REFERENCE_RE = /^[A-Za-z0-9_-]{1,200}$/;
const STRIPE_EMBED_SELECTOR = 'stripe-pricing-table, stripe-buy-button';
const REFERRAL_COOKIE_DEFAULT = 'op_ref';

export class OpenPartner {
  private config: Required<OpenPartnerConfig>;
  private observer: MutationObserver | null = null;
  private consent: ConsentState;
  /** The URL's referral while consent is pending, held in memory only. */
  private held: string | null = null;
  /** This page's referral, kept here too: where localStorage throws it is
   *  the only copy until the cookie is written. */
  private current: string | null = null;
  /** The Stripe links and embeds this SDK tagged, and with what, so a
   *  withdrawn consent can take the tags back off. */
  private tagged: Array<{ el: Element; value: string }> = [];
  /** consent: 'regional' only: the visitor's rule, once known. */
  private region: Promise<ConsentRegion> | null = null;
  /** setConsent() was called: the page's answer outranks the region's. */
  private answered = false;

  private constructor(config: OpenPartnerConfig) {
    this.config = { ...DEFAULTS, ...config } as Required<OpenPartnerConfig>;
    const mode = this.config.consent;
    this.consent = mode === 'regional' ? 'pending' : mode;
    if (this.consent === 'granted') this.start();
    else if (this.consent === 'pending') this.held = this.queryCref();
    // A returning visitor who has since said no: drop what an earlier
    // visit stored.
    else this.clear();
    if (mode === 'regional') this.region = this.applyRegion();
  }

  static init(config: OpenPartnerConfig): OpenPartner {
    return new OpenPartner(config);
  }

  /** The cref we're holding onto, if any. Useful for debugging. Null until
   *  consent is granted. */
  getCref(): string | null {
    if (this.consent !== 'granted') return null;
    return this.storageGet() ?? this.current ?? this.readCookie(this.referralCookieName());
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
   * Returns null if the visitor didn't arrive via a partner link, or
   * hasn't agreed to tracking yet.
   */
  getReferral(): string | null {
    return this.getCref();
  }

  /** Explicitly discard the captured cref, the referral cookie, and the
   *  references this SDK added to Stripe links and embeds. */
  clear(): void {
    this.held = null;
    this.current = null;
    this.untagStripe();
    this.storageRemove();
    if (typeof document === 'undefined') return;
    const name = this.referralCookieName();
    if (!this.readCookie(name)) return;
    const cfg = this.config.referralCookie;
    document.cookie = `${name}=; Max-Age=0; Path=/`;
    if (cfg && cfg.domain) document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${cfg.domain}`;
  }

  /**
   * Record the visitor's answer to your consent banner. `'granted'` stores
   * the referral (the one held since the page loaded, or one already
   * stored), starts tagging Stripe links and sends the landing report.
   * `'denied'` stops all of it, takes the references it added off Stripe
   * links and embeds, and deletes what was stored. Calling it again is
   * safe.
   */
  setConsent(state: 'granted' | 'denied'): void {
    this.answered = true;
    if (state === 'granted') {
      if (this.consent === 'granted') return;
      this.consent = state;
      this.start();
      return;
    }
    this.consent = state;
    this.stopLinkingStripe();
    this.clear();
  }

  /**
   * The consent rule where the visitor is, with `consent: 'regional'`:
   * resolves once OpenPartner answers, as `'opt_in'` if it couldn't. Null in
   * the other modes. A banner uses it to choose between asking first and a
   * notice with a Decline.
   */
  consentRegion(): Promise<ConsentRegion | null> {
    return this.region ?? Promise.resolve(null);
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
      this.remember(a, referral);
      changed += 1;
    }

    const embeds: Element[] = [];
    if (root instanceof Element && root.matches(STRIPE_EMBED_SELECTOR)) embeds.push(root);
    embeds.push(...Array.from(root.querySelectorAll(STRIPE_EMBED_SELECTOR)));
    for (const el of embeds) {
      if (el.hasAttribute('client-reference-id')) continue;
      el.setAttribute('client-reference-id', referral);
      this.remember(el, referral);
      changed += 1;
    }
    return changed;
  }

  private remember(el: Element, value: string): void {
    // Elements an SPA has thrown away go, so the list can't grow forever.
    this.tagged = this.tagged.filter((t) => t.el.isConnected);
    this.tagged.push({ el, value });
  }

  /** Take back the references this SDK added. One the brand set, or one
   *  changed since, stays. */
  private untagStripe(): void {
    for (const { el, value } of this.tagged) {
      if (el instanceof HTMLAnchorElement) {
        let url: URL;
        try {
          url = new URL(el.href);
        } catch {
          continue;
        }
        if (url.searchParams.get('client_reference_id') !== value) continue;
        url.searchParams.delete('client_reference_id');
        el.href = url.toString();
      } else if (el.getAttribute('client-reference-id') === value) {
        el.removeAttribute('client-reference-id');
      }
    }
    this.tagged = [];
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

  /** Everything the SDK does once it may: store, mirror, link, report. */
  private start(): void {
    const landed = this.captureCref(this.held);
    this.held = null;
    this.writeReferralCookie();
    if (this.config.stripe !== false) this.watchStripe();
    if (landed && this.config.reportLanding !== false) void this.reportLanding(landed);
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
    if (typeof document === 'undefined' || this.observer || !this.getReferral()) return;
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

  /** Look up the visitor's rule and, where it's opt-out, start: unless the
   *  page answered first, or a privacy signal says to wait. */
  private async applyRegion(): Promise<ConsentRegion> {
    const region = await this.fetchRegion();
    const signalled = this.config.privacySignals !== 'ignore' && sendsPrivacySignal();
    if (region.rule === 'opt_out' && !this.answered && !signalled && this.consent === 'pending') {
      this.consent = 'granted';
      this.start();
    }
    return region;
  }

  /** GET /consent-region, with no credentials. Any failure, a malformed
   *  answer, an opt-out without a country, or no answer within the timeout
   *  (with or without AbortController) is opt-in; a late answer is ignored. */
  private async fetchRegion(): Promise<ConsentRegion> {
    const optIn: ConsentRegion = { rule: 'opt_in', country: null };
    if (typeof fetch === 'undefined') return optIn;
    const abort = typeof AbortController === 'undefined' ? null : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConsentRegion>((resolve) => {
      timer = setTimeout(() => {
        abort?.abort();
        resolve(optIn);
      }, REGION_TIMEOUT_MS);
    });
    const lookup = requestJson<Partial<ConsentRegion>>(`${this.config.apiUrl}/consent-region`, {
      method: 'GET',
      credentials: 'omit',
      ...(abort ? { signal: abort.signal } : {}),
    }).then(
      (res): ConsentRegion => {
        const country = typeof res?.country === 'string' && COUNTRY_RE.test(res.country) ? res.country : null;
        return res?.rule === 'opt_out' && country ? { rule: 'opt_out', country } : { rule: 'opt_in', country };
      },
      () => optIn,
    );
    try {
      return await Promise.race([lookup, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The cref on the landing URL, if any. */
  private queryCref(): string | null {
    if (typeof window === 'undefined') return null;
    return new URL(window.location.href).searchParams.get(this.config.queryParam);
  }

  /**
   * Capture the cref from the URL (or the one held while consent was
   * pending), else the router's cookie, else the referral cookie, and
   * stash it in localStorage so it survives SPA navigations and later
   * page loads. Returns the cref when it's a click arriving now, one this
   * browser didn't have yet, for the landing report.
   */
  private captureCref(held: string | null): string | null {
    if (typeof window === 'undefined') return null;

    const incoming = held ?? this.queryCref();
    if (incoming) {
      const isNew = this.storageGet() !== incoming;
      this.current = incoming;
      this.storageSet(incoming);
      return isNew ? incoming : null;
    }

    if (this.storageGet()) return null;
    // A page that isn't the landing page: the router's own cookie (a
    // self-host whose router shares the brand's domain), then the referral
    // cookie a sibling subdomain or the brand's server wrote.
    const restored = this.readCookie(this.config.cookieName) ?? this.readCookie(this.referralCookieName());
    if (restored) {
      this.current = restored;
      this.storageSet(restored);
    }
    return null;
  }

  private referralCookieName(): string {
    const cfg = this.config.referralCookie;
    return (cfg && cfg.name) || REFERRAL_COOKIE_DEFAULT;
  }

  /**
   * Mirror the referral into the brand's own first-party cookie (when
   * configured). Left alone when it already holds this referral: in Safari
   * rewriting it from script would trade a server-set cookie's full
   * lifetime for the 7-day cap. A new click overwrites it.
   */
  private writeReferralCookie(): void {
    const cfg = this.config.referralCookie;
    if (!cfg || typeof document === 'undefined') return;
    const referral = this.getReferral();
    if (!referral || !STRIPE_REFERENCE_RE.test(referral)) return;
    const name = this.referralCookieName();
    if (this.readCookie(name) === referral) return;
    const maxAge = Math.round((cfg.days ?? 90) * 86400);
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    const domain = cfg.domain ? `; Domain=${cfg.domain}` : '';
    document.cookie = `${name}=${encodeURIComponent(referral)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${domain}${secure}`;
  }

  private readCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]+)`));
    if (!match) return null;
    try {
      return decodeURIComponent(match[2]!);
    } catch {
      return null;
    }
  }

  // localStorage throws in some sandboxed iframes and with site data
  // blocked; the referral then lives in the cookie alone.
  private storageGet(): string | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(this.config.storageKey);
    } catch {
      return null;
    }
  }

  private storageSet(value: string): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(this.config.storageKey, value);
    } catch {
      // Storage unavailable; see storageGet.
    }
  }

  private storageRemove(): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(this.config.storageKey);
    } catch {
      // Storage unavailable; see storageGet.
    }
  }

  /** Tell OpenPartner the click arrived. Best-effort, once per click. */
  private async reportLanding(cref: string): Promise<void> {
    if (!STRIPE_REFERENCE_RE.test(cref) || typeof fetch === 'undefined') return;
    try {
      await requestJson(`${this.config.apiUrl}/attribution/landing`, {
        method: 'POST',
        body: { cref },
        keepalive: true,
      });
    } catch (err) {
      // Only a click this program doesn't have is worth reporting: it
      // usually means apiUrl names another program. Anything else (offline,
      // rate limited, an API from before the landing report) is dropped:
      // the report is a diagnostic, never part of attribution.
      if (err instanceof OpenPartnerError && err.code === 'click_not_found') this.config.onError(err);
    }
  }

  /**
   * Stitch the current captured click to an authenticated user. Call
   * this on login, signup, or anywhere the user becomes known.
   *
   * No-op if no cref was captured, or consent isn't granted. Errors are
   * reported through `config.onError` by default — attribution is
   * best-effort from the browser — but you can await this and try/catch
   * if you want to surface failures explicitly.
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

/** Global Privacy Control, or the older Do Not Track. */
function sendsPrivacySignal(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
}
