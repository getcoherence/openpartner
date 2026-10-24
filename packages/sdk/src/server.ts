/**
 * Server SDK — runs inside a merchant's backend. Used for the
 * server-to-server pieces of the attribution pipeline: posting
 * conversion events (signup / invoice_paid / custom), stitching
 * clicks to users from the backend, and reading dashboard snapshots.
 *
 * Typical integration:
 *
 *   import { OpenPartnerServer } from '@openpartner/sdk/server';
 *
 *   const op = new OpenPartnerServer({
 *     apiUrl: process.env.OPENPARTNER_API_URL!,
 *     apiKey: process.env.OPENPARTNER_API_KEY!,
 *   });
 *
 *   // On signup:
 *   await op.trackEvent({ userId, type: 'signup' });
 *
 *   // On invoice paid — externalEventId makes retries safe:
 *   await op.trackEvent({ userId, type: 'invoice_paid', value: 249, currency: 'USD', externalEventId: invoice.id });
 *
 *   // Holding only the click id (from the link's {click_id} macro)? One call:
 *   await op.trackConversion({ clickId, type: 'loan_funded', value: 5000, externalEventId: `${loan.id}:funded` });
 */

import {
  OpenPartnerError,
  requestJson,
  type ConversionResponse,
  type EventResponse,
  type IdentifyResponse,
  type JsonRequestInit,
} from './shared.js';

export { OpenPartnerError };
export type { ConversionResponse, EventResponse, IdentifyResponse };
export type { EventAttribution } from './shared.js';

export interface OpenPartnerServerConfig {
  /** Base URL of the OpenPartner API. */
  apiUrl: string;
  /**
   * Admin or scoped API key. Event ingest (/attribution/events) accepts
   * an admin key or a scoped key with `events:write`. Never expose this
   * to the browser.
   */
  apiKey: string;
  /** Optional fetch override for tests or custom transports. */
  fetch?: typeof fetch;
}

export interface TrackEventParams {
  /** The user the event pertains to. Must match how the browser SDK called identify(). */
  userId: string;
  /** Event type — typically 'signup' | 'trial_started' | 'subscription_created' | 'invoice_paid' | custom. */
  type: string;
  /** Dollar (or currency) value of the event, for percent-commission rules. */
  value?: number;
  /** ISO 4217 currency code. Defaults to USD on the server if omitted. */
  currency?: string;
  /** Arbitrary metadata you want to attach (stripeEventId, invoiceId, etc). */
  metadata?: Record<string, unknown>;
  /** Event time. Defaults to now on the server. Pass ISO 8601 to override. */
  ts?: string;
  /**
   * Idempotency key: your system's stable id for this one event (order id,
   * invoice id, CRM deal-stage change id), max 120 chars. Strongly
   * recommended. A retried call with the same key returns the original
   * event and attribution (`replayed: true`) instead of recording and
   * commissioning it twice. Unique per event, not per order: an order's
   * `subscription_created` and its `invoice_paid` need different keys.
   * Reusing a key for a different userId / type / value / currency throws
   * an `OpenPartnerError` with code `external_event_id_conflict` (409).
   */
  externalEventId?: string;
}

export interface TrackConversionParams {
  /** The click id the partner link handed you: the `{click_id}` macro in the
   *  destination URL, or the `cref` query parameter. */
  clickId: string;
  /** Event type, e.g. 'loan_funded', 'opportunity_won', 'invoice_paid'. */
  type: string;
  /** Value of the conversion, for percent-commission rules. */
  value?: number;
  /** ISO 4217 currency code. Defaults to USD on the server if omitted. */
  currency?: string;
  /**
   * Required idempotency key: your stable id for this one conversion (loan
   * id plus stage, order id), max 120 chars. A retry returns the original
   * result (`replayed: true`); reusing it for a different click or
   * conversion throws `external_event_id_conflict` (409).
   */
  externalEventId: string;
  /**
   * Your own id for the user, if you have one. Omit it and the conversion is
   * recorded under the click's own user, credited to that click alone.
   */
  userId?: string;
  metadata?: Record<string, unknown>;
  /** Event time. Defaults to now on the server. ISO 8601. */
  ts?: string;
}

export class OpenPartnerServer {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenPartnerServerConfig) {
    if (!config.apiUrl) throw new OpenPartnerError('apiUrl is required', 400, 'config_missing');
    if (!config.apiKey) throw new OpenPartnerError('apiKey is required', 400, 'config_missing');
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  /**
   * Record a conversion event. The server walks the userId back to a
   * click, applies the campaign's attribution model, and writes the
   * resulting attribution + commission rows.
   */
  async trackEvent(params: TrackEventParams): Promise<EventResponse> {
    return this.request<EventResponse>('/attribution/events', { method: 'POST', body: params });
  }

  /**
   * Record a conversion against a click in one call, for when you have the
   * click id but no identify()'d user: a lender reporting a funded loan, a
   * CRM closing a deal. Stitches the click and records the event together.
   * Throws `click_not_found` (404) for a click outside your program and
   * `click_flagged` (422) for one flagged as fraud.
   */
  async trackConversion(params: TrackConversionParams): Promise<ConversionResponse> {
    return this.request<ConversionResponse>('/attribution/conversions', { method: 'POST', body: params });
  }

  /**
   * Stitch an attribution token (cref) to a known userId. Normally the
   * browser SDK does this; use this overload if your backend receives
   * the cref from the browser (e.g. as part of a signup payload) and
   * wants to own the stitch call.
   */
  async identify(params: { cref: string; userId: string; ts?: number }): Promise<IdentifyResponse> {
    return this.request<IdentifyResponse>('/attribution/identify', {
      method: 'POST',
      body: params,
    });
  }

  private async request<T>(path: string, init: JsonRequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.apiKey}`);
    return requestJson<T>(
      `${this.apiUrl}${path}`,
      { ...init, headers },
      // Inject the configured fetch so tests (or alternate transports)
      // can intercept.
      this.fetchImpl,
    );
  }
}

// ---------------------------------------------------------------------------
// The referral cookie, set from your own server
// ---------------------------------------------------------------------------

export interface ReferralCookieOptions {
  /** Cookie name. Default `op_ref`, the one the browser SDK reads back. */
  name?: string;
  /** Share it across subdomains, e.g. ".yourbrand.com" (land on www., buy on app.). */
  domain?: string;
  /** Lifetime in days. Default 90. */
  days?: number;
  /** Send it over HTTPS only. Default true; set false for plain-http local development. */
  secure?: boolean;
  /** Query parameter that carries the click on the landing URL. Default `cref`. */
  queryParam?: string;
}

/** A click id, or anything Stripe would accept as client_reference_id. */
const REFERRAL_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The `Set-Cookie` header value that keeps a partner click on your own
 * domain, for a request whose URL carries `?cref=`; null otherwise. Send it
 * on the landing page's own response.
 *
 * Why from the server: Safari deletes what a page's scripts store
 * (localStorage, and cookies written through document.cookie) after 7 days
 * without a visit. A cookie your server sets on the page's own response
 * keeps its full lifetime, so a visitor who clicks today and buys in a
 * month, without signing up in between, is still credited. Not HttpOnly:
 * the browser SDK reads it back for identify() and Stripe links. Set it
 * from the server that serves the page itself: Safari caps a cookie from a
 * server on another IP (an API host on a different provider) at 7 days too.
 *
 *   const header = referralCookieHeader(req.url, { domain: '.yourbrand.com' });
 *   if (header) res.append('Set-Cookie', header);
 */
export function referralCookieHeader(url: string, options: ReferralCookieOptions = {}): string | null {
  let referral: string | null;
  try {
    referral = new URL(url, 'http://localhost').searchParams.get(options.queryParam ?? 'cref');
  } catch {
    return null;
  }
  if (!referral || !REFERRAL_RE.test(referral)) return null;
  const name = options.name ?? 'op_ref';
  const maxAge = Math.round((options.days ?? 90) * 86400);
  const parts = [`${name}=${referral}`, `Max-Age=${maxAge}`, 'Path=/', 'SameSite=Lax'];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure !== false) parts.push('Secure');
  return parts.join('; ');
}

/** The slice of Node's request and response the middleware uses. */
interface CookieRequest {
  url?: string;
  originalUrl?: string;
}
interface CookieResponse {
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: string | string[]): unknown;
}

/**
 * Express / Connect middleware: sets the referral cookie on every request
 * that arrives with `?cref=`, adding to any Set-Cookie already queued.
 *
 *   app.use(referralCookieMiddleware({ domain: '.yourbrand.com' }));
 */
export function referralCookieMiddleware(options: ReferralCookieOptions = {}) {
  return (req: CookieRequest, res: CookieResponse, next: () => void): void => {
    const header = referralCookieHeader(req.originalUrl ?? req.url ?? '', options);
    if (header) {
      const existing = res.getHeader('set-cookie');
      const list = existing == null ? [] : Array.isArray(existing) ? existing : [String(existing)];
      res.setHeader('set-cookie', [...list, header]);
    }
    next();
  };
}

/**
 * Read the referral back off a request's `Cookie` header: for identify()
 * from your backend at signup, or `client_reference_id` on a Checkout
 * Session you create. Null when there's none.
 *
 *   const cref = readReferralCookie(req.headers.cookie);
 *   if (cref) await op.identify({ cref, userId: user.id });
 */
export function readReferralCookie(cookieHeader: string | null | undefined, name = 'op_ref'): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    return REFERRAL_RE.test(value) ? value : null;
  }
  return null;
}
