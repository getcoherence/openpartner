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
 * With the key, PostHog still loads only after the visitor clicks Accept
 * on the consent banner (lib/ConsentBanner.tsx; the choice and the
 * cleanup live in lib/consent.ts). Importing this module (main.tsx) runs
 * the startup half: load PostHog if the visitor already accepted,
 * otherwise clear anything PostHog left behind and, unless the browser
 * sends Global Privacy Control / Do Not Track, ask.
 *
 * The bootstrap below is the verbatim PostHog snippet (minus its init
 * call), injected into <head> as a <script> element. We do this instead
 * of re-implementing the array-stub in TypeScript because the snippet has
 * subtle function-shape requirements (arguments capture, push semantics)
 * that are easy to get wrong in a rewrite. Keeping it as a string ships
 * exactly what the studio-website ships.
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

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

/** This build ships PostHog at all (so there's a choice to ask for). */
export const analyticsEnabled = Boolean(KEY);

const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(/\\/$/,"")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;void 0!==a?u=e[a]=[]:a="posthog";u.analytics=u;u.init=function(i,s,a){e._i.push([i,s,a])};u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e};u.people=u.people||[];g(u,"capture");g(u,"register");g(u,"register_once");g(u,"ready");g(u,"set_config");g(u,"get_config");g(u,"get_property");g(u,"get_distinct_id");g(u,"toString");g(u,"opt_in_capturing");g(u,"opt_out_capturing");g(u,"has_opted_in_capturing");g(u,"has_opted_out_capturing");g(u,"clear_opt_in_out_capturing");g(u,"startSessionRecording");g(u,"stopSessionRecording");g(u,"sessionRecordingStarted");g(u,"getActiveMatchingSurveys");g(u,"getSurveys");g(u,"getNextSurveyStep");g(u,"onFeatureFlags");g(u,"onSessionId");g(u,"getSessionId");g(u,"identify");g(u,"setPersonProperties");g(u,"group");g(u,"getGroups");g(u,"setGroupProperties");g(u,"reloadFeatureFlags");u._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;

interface PostHog {
  init(key: string, config: Record<string, unknown>): void;
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

let loaded = false;

function loadPostHog(): void {
  if (loaded || !KEY || typeof document === 'undefined') return;
  loaded = true;
  const tag = document.createElement('script');
  tag.type = 'text/javascript';
  tag.text = SNIPPET;
  document.head.appendChild(tag);
  posthog()?.init(KEY, {
    api_host: HOST,
    person_profiles: 'identified_only',
    // Dashboards show partner names, emails and amounts. That's the
    // brand's data, not ours to send anywhere: clicks are captured
    // without element text or attributes, and nothing is recorded.
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_session_recording: true,
    before_send: scrubAnalyticsEvent,
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
  setConsentBannerOpen(false);
  if (choice === 'granted') loadPostHog();
  else stopPostHog();
}

if (KEY && typeof window !== 'undefined') {
  const choice = readConsent();
  if (choice === 'granted') {
    loadPostHog();
  } else {
    clearAnalyticsStorage();
    if (choice === null && !browserSignalsOptOut()) setConsentBannerOpen(true);
  }
  window.addEventListener('storage', onStorage);
}
