/**
 * Analytics consent: the visitor's Accept / Decline, and the cleanup that
 * makes Decline mean "nothing left behind".
 *
 * Same contract as the marketing site's ConsentBanner.astro (separate
 * origin, so the choice is asked for again here):
 *  - The choice sits in localStorage under `op_consent_v1` as
 *    `{ choice, at }`. That's strictly necessary storage, so it needs no
 *    consent of its own. It expires after 12 months and the visitor is
 *    asked again. Bump the key's version when a new script is added.
 *  - A Global Privacy Control or Do Not Track signal counts as declining:
 *    nothing loads and the banner doesn't show (the visitor can still
 *    accept from "Cookie settings").
 *  - Without a 'granted' choice, every page load clears PostHog's cookies
 *    and storage: PostHog re-saves its cookie while the page unloads, so
 *    clearing only at the moment of Decline isn't enough.
 *
 * Every storage access is guarded: private windows, blocked site data and
 * jsdom must degrade to "no choice yet", never throw.
 */
import { useSyncExternalStore } from 'react';

export type ConsentChoice = 'granted' | 'denied';

export const CONSENT_STORAGE_KEY = 'op_consent_v1';
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** The stored choice; missing, expired, malformed or unreadable → null. */
export function readConsent(now: number = Date.now()): ConsentChoice | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null') as {
      choice?: unknown;
      at?: unknown;
    } | null;
    if (!saved || (saved.choice !== 'granted' && saved.choice !== 'denied')) return null;
    if (typeof saved.at !== 'number' || now - saved.at >= CONSENT_MAX_AGE_MS) return null;
    return saved.choice;
  } catch {
    return null;
  }
}

export function writeConsent(choice: ConsentChoice, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ choice, at: now }));
  } catch {
    /* storage blocked — the choice still applies for this page view */
  }
}

/** Global Privacy Control or Do Not Track: treated as Decline. */
export function browserSignalsOptOut(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
}

/** PostHog's cookie and storage names: `ph_<token>_posthog`, `__ph_opt_in_out_<token>`, … */
export function isAnalyticsKey(name: string): boolean {
  return name.startsWith('ph_') || name.startsWith('__ph_');
}

/**
 * Every domain a cookie for this page could have been set on: host-only,
 * the host, `.host`, and each parent domain. PostHog writes its cookie to
 * the widest domain the browser accepts (`.openpartner.dev` from
 * app.openpartner.dev, `.brand.com` from a white-label partners.brand.com),
 * and a cookie can only be deleted with the domain it was set with.
 */
export function cookieDomains(hostname: string): string[] {
  const labels = hostname.split('.');
  const domains = ['', hostname, `.${hostname}`];
  for (let i = 1; i < labels.length - 1; i++) domains.push(`.${labels.slice(i).join('.')}`);
  return domains;
}

/** Delete PostHog's cookies (on every domain) and local/session storage keys. */
export function clearAnalyticsStorage(): void {
  try {
    const names = document.cookie
      .split(';')
      .map((c) => c.split('=')[0]!.trim())
      .filter(isAnalyticsKey);
    const domains = cookieDomains(window.location.hostname);
    for (const name of names) {
      for (const domain of domains) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/${domain ? `;domain=${domain}` : ''}`;
      }
    }
  } catch {
    /* cookies blocked — nothing could have been written either */
  }
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try {
      const store = window[area];
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key !== null && isAnalyticsKey(key)) keys.push(key);
      }
      for (const key of keys) store.removeItem(key);
    } catch {
      /* storage blocked */
    }
  }
}

// ---------------- banner visibility ----------------

let bannerOpen = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function setConsentBannerOpen(open: boolean): void {
  if (bannerOpen === open) return;
  bannerOpen = open;
  notify();
}

/** "Cookie settings": show the banner again so the choice can be changed. */
export function openConsentSettings(): void {
  setConsentBannerOpen(true);
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function useConsentBannerOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => bannerOpen,
    () => false,
  );
}
