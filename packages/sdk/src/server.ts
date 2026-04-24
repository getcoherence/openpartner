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
 *   // On invoice paid:
 *   await op.trackEvent({ userId, type: 'invoice_paid', value: 249, currency: 'USD' });
 */

import { OpenPartnerError, requestJson, type EventResponse, type IdentifyResponse, type JsonRequestInit } from './shared.js';

export { OpenPartnerError };
export type { EventResponse, IdentifyResponse };
export type { EventAttribution } from './shared.js';

export interface OpenPartnerServerConfig {
  /** Base URL of the OpenPartner API. */
  apiUrl: string;
  /**
   * Admin or scoped API key. For event ingest you need admin or a key
   * with the right scope (the core API currently uses admin-only for
   * /attribution/events). Never expose this to the browser.
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
