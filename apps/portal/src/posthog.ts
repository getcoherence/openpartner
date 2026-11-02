/**
 * PostHog product analytics — same array-stub bootstrap as
 * studio-website (apps/studio-website/src/app/layout.tsx) so events
 * land in the same project / dashboards.
 *
 * Opt-in via env: VITE_POSTHOG_KEY in .env.local (dev) or DO App
 * Platform env (prod). Without the key, no script loads, no requests
 * fire and no consent banner shows — graceful no-op for self-hosters and
 * contributors.
 *
 * With the key, the visitor's choice decides (lib/consent.ts; the banner
 * is lib/ConsentBanner.tsx). Importing this module (main.tsx) runs the
 * startup half: load PostHog if the visitor accepted; clear anything
 * PostHog left behind if they declined or the browser sends Global
 * Privacy Control / Do Not Track. With no choice yet, ask the API which
 * rule applies where they are (GET /api/consent-region): outside the EU,
 * EEA, UK and Switzerland PostHog loads with no banner, so problems in
 * the app show up in session replays; there, or when the lookup fails,
 * show the banner.
 *
 * The bootstrap below is the verbatim PostHog snippet, injected into
 * <head> as a <script> element. We do this instead of re-implementing
 * the array-stub in TypeScript because the snippet has subtle
 * function-shape requirements (arguments capture, push semantics) that
 * are easy to get wrong in a rewrite. Keeping it as a string ships
 * exactly what the studio-website ships, minus its trailing
 * posthog.init(...) call: that call is made from TypeScript below so the
 * config can carry functions (before_send), which a string can't.
 */
import {
  CONSENT_STORAGE_KEY,
  browserSignalsOptOut,
  clearAnalyticsStorage,
  readConsent,
  setConsentBannerOpen,
  writeConsent,
  type ConsentChoice,
} from './lib/consent.js';
import { scrubSensitiveEvent } from './lib/sensitive-url.js';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

/** This build ships PostHog at all (so there's a choice to ask for). */
export const analyticsEnabled = Boolean(KEY);

const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(/\\/$/,"")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;void 0!==a?u=e[a]=[]:a="posthog";u.analytics=u;u.init=function(i,s,a){e._i.push([i,s,a])};u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e};u.people=u.people||[];g(u,"capture");g(u,"register");g(u,"register_once");g(u,"ready");g(u,"set_config");g(u,"get_config");g(u,"get_property");g(u,"get_distinct_id");g(u,"toString");g(u,"opt_in_capturing");g(u,"opt_out_capturing");g(u,"has_opted_in_capturing");g(u,"has_opted_out_capturing");g(u,"clear_opt_in_out_capturing");g(u,"startSessionRecording");g(u,"stopSessionRecording");g(u,"sessionRecordingStarted");g(u,"getActiveMatchingSurveys");g(u,"getSurveys");g(u,"getNextSurveyStep");g(u,"onFeatureFlags");g(u,"onSessionId");g(u,"getSessionId");g(u,"identify");g(u,"setPersonProperties");g(u,"group");g(u,"getGroups");g(u,"setGroupProperties");g(u,"reloadFeatureFlags");u._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;

interface PostHog {
  init?(key: string, config: Record<string, unknown>): void;
  opt_out_capturing(): void;
}

function posthog(): PostHog | undefined {
  return (window as unknown as { posthog?: PostHog }).posthog;
}

type Props = Record<string, unknown>;

/**
 * Query strings and fragments never leave the browser: magic-link and
 * invitation tokens travel in them. Applied to every URL-shaped string
 * PostHog would send ($current_url, $referrer, $initial_* in $set_once, …)
 * and to the hrefs inside autocapture's $elements_chain.
 */
function stripUrlQuery(value: string): string {
  return /^(https?:\/\/|\/)/i.test(value) ? value.replace(/[?#].*$/, '') : value;
}

function scrubProps(props: Props | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (key === '$elements_chain' && typeof value === 'string') {
      props[key] = value.replace(/(href="[^"?#]*)[?#][^"]*"/g, '$1"');
    } else if (typeof value === 'string') {
      props[key] = stripUrlQuery(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubProps(value as Props);
    }
  }
}

type CaptureResult = { properties?: Props; $set?: Props; $set_once?: Props };

export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (event) {
    scrubProps(event.properties);
    scrubProps(event.$set);
    scrubProps(event.$set_once);
  }
  return event;
}

/** Replays keep each request's URL, and the page's, without its query string or fragment. */
export function scrubRecordedRequest(request: Props | null): Props | null {
  if (request && typeof request.name === 'string') request.name = stripUrlQuery(request.name);
  return request;
}

/** Pages nothing is captured on: a shared booking report (/reports) is
 *  someone else's deal, opened by a link with a token in it. */
const UNTRACKED_PATHS = ['/reports'];

function onUntrackedPage(): boolean {
  return typeof window !== 'undefined' && UNTRACKED_PATHS.includes(window.location.pathname);
}

export function dropUntrackedPages(event: CaptureResult | null): CaptureResult | null {
  return onUntrackedPage() ? null : event;
}

let loaded = false;
/** The visitor (here or in another tab) chose during this page view. */
let chosen = false;
/** PostHog runs because of where the visitor is, not because they accepted. */
let onByRegion = false;

function loadPostHog(): void {
  if (loaded || !KEY || typeof document === 'undefined') return;
  loaded = true;
  const tag = document.createElement('script');
  tag.type = 'text/javascript';
  tag.text = SNIPPET;
  // An inline script runs on insertion, so the stub exists from here on
  // (unless something blocked it, e.g. a future CSP: then analytics is
  // off, and the app must still boot).
  document.head.appendChild(tag);
  posthog()?.init?.(KEY, {
    api_host: HOST,
    person_profiles: 'identified_only',
    // Dashboards show partner names, emails and amounts. That's the
    // brand's data, not ours to send anywhere: clicks are captured
    // without element text or attributes, and session replays keep the
    // layout and the clicks with every text node and input masked, no
    // request headers or bodies, and URLs without their query strings.
    // Whether replays record at all is the PostHog project's setting. A
    // page load that starts on an untracked page records no replay.
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_session_recording: onUntrackedPage(),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: scrubRecordedRequest,
    },
    // Sign-in links carry a one-time token in the query string. The
    // landing pages strip it from the address bar as soon as they read
    // it, but array.js loads async and the first pageview can win that
    // race: scrubSensitiveEvent redacts token / ntoken wherever they
    // appear, then scrubAnalyticsEvent drops every remaining query string
    // and fragment from URL properties (invitations, Stripe session ids).
    before_send: [dropUntrackedPages, scrubSensitiveEvent, scrubAnalyticsEvent],
  });
}

/** Opt out, clear what PostHog wrote, and reload so nothing keeps running. */
function stopPostHog(): void {
  try {
    posthog()?.opt_out_capturing();
  } catch {
    /* PostHog half-loaded — the clear + reload still stop it */
  }
  clearAnalyticsStorage();
  if (loaded) window.location.reload();
}

/** The visitor clicked Accept or Decline on the banner. */
export function chooseAnalyticsConsent(choice: ConsentChoice): void {
  chosen = true;
  onByRegion = false;
  writeConsent(choice);
  setConsentBannerOpen(false);
  if (choice === 'granted') loadPostHog();
  else stopPostHog();
}

/** A choice made in another tab applies here too. */
function onStorage(e: StorageEvent): void {
  // key === null → another tab called localStorage.clear().
  if (e.key !== CONSENT_STORAGE_KEY && e.key !== null) return;
  const choice = readConsent();
  if (choice === null) return;
  chosen = true;
  onByRegion = false;
  setConsentBannerOpen(false);
  if (choice === 'granted') loadPostHog();
  else stopPostHog();
}

/** Analytics are on without a choice: the banner tells them so instead of asking. */
export function analyticsOnByDefault(): boolean {
  return onByRegion;
}

/** As long as the browser SDK's regional mode waits before asking instead. */
const REGION_TIMEOUT_MS = 1_500;

/**
 * GET /api/consent-region (apps/api/src/consent-region.ts) answers
 * 'opt_out' where the visitor's country needs no prior consent. An
 * 'opt_in', an error or no answer in time all mean ask first.
 */
async function regionAllowsDefault(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGION_TIMEOUT_MS);
  try {
    const res = await fetch('/api/consent-region', { credentials: 'omit', signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { rule?: unknown };
    return body.rule === 'opt_out';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startWithoutChoice(): Promise<void> {
  const byRegion = await regionAllowsDefault();
  // Accept or Decline while the lookup ran already settled it.
  if (chosen) return;
  if (byRegion) {
    onByRegion = true;
    loadPostHog();
  } else {
    clearAnalyticsStorage();
    setConsentBannerOpen(true);
  }
}

if (KEY && typeof window !== 'undefined') {
  const choice = readConsent();
  if (choice === 'granted') {
    loadPostHog();
  } else if (choice === 'denied' || browserSignalsOptOut()) {
    clearAnalyticsStorage();
  } else {
    void startWithoutChoice();
  }
  window.addEventListener('storage', onStorage);
}
