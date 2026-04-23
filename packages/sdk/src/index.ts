/**
 * OpenPartner SDK — browser client.
 *
 * Usage (in the customer's site):
 *
 *   import { OpenPartner } from '@openpartner/sdk';
 *
 *   const op = OpenPartner.init({ apiUrl: 'https://openpartner.example.com' });
 *
 *   // On auth (login/signup):
 *   op.identify(userId);
 */

export interface OpenPartnerConfig {
  apiUrl: string;
  cookieName?: string;
  queryParam?: string;
  storageKey?: string;
}

const DEFAULTS = {
  cookieName: '_cref',
  queryParam: 'cref',
  storageKey: 'openpartner:cref',
};

export class OpenPartner {
  private config: Required<OpenPartnerConfig>;

  private constructor(config: OpenPartnerConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.captureCref();
  }

  static init(config: OpenPartnerConfig): OpenPartner {
    return new OpenPartner(config);
  }

  /**
   * Capture the cref from query param or cookie and stash in localStorage.
   * Runs on SDK init so the value survives SPA navigations and ITP cookie expiry.
   */
  private captureCref(): void {
    if (typeof window === 'undefined') return;

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

  private readCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]+)`));
    return match ? decodeURIComponent(match[2]!) : null;
  }

  /**
   * Call on login/signup to stitch the current click to the authenticated user.
   * TODO(phase-1): POST to /attribution/identify with { cref, userId, ts }
   */
  async identify(userId: string): Promise<void> {
    const cref = localStorage.getItem(this.config.storageKey);
    if (!cref) return;

    try {
      await fetch(`${this.config.apiUrl}/attribution/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cref, userId, ts: Date.now() }),
        keepalive: true,
      });
    } catch {
      // Fail silently — attribution is best-effort on the client.
    }
  }
}
