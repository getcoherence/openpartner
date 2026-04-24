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
 */

import { OpenPartnerError, requestJson, type IdentifyResponse } from './shared.js';

export { OpenPartnerError };
export type { IdentifyResponse };

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
   * Called when identify() fails. Default: log to console. Pass a noop
   * to suppress entirely or hook into your observability stack.
   */
  onError?: (err: unknown) => void;
}

const DEFAULTS = {
  cookieName: '_cref',
  queryParam: 'cref',
  storageKey: 'openpartner:cref',
  onError: (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('[openpartner] identify failed', err);
  },
};

export class OpenPartner {
  private config: Required<OpenPartnerConfig>;

  private constructor(config: OpenPartnerConfig) {
    this.config = { ...DEFAULTS, ...config } as Required<OpenPartnerConfig>;
    this.captureCref();
  }

  static init(config: OpenPartnerConfig): OpenPartner {
    return new OpenPartner(config);
  }

  /** The cref we're holding onto, if any. Useful for debugging. */
  getCref(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(this.config.storageKey);
  }

  /** Explicitly discard the captured cref. */
  clear(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.config.storageKey);
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
