/**
 * PostHog product analytics — same array-stub bootstrap as
 * studio-website (apps/studio-website/src/app/layout.tsx) so events
 * land in the same project / dashboards.
 *
 * Opt-in via env: VITE_POSTHOG_KEY in .env.local (dev) or DO App
 * Platform env (prod). Without the key, no script loads, no requests
 * fire — graceful no-op for self-hosters and contributors.
 *
 * Side-effecting on import: just `import './posthog.js'` from main.tsx.
 *
 * The bootstrap below is the verbatim PostHog snippet, injected into
 * <head> as a <script> element. We do this instead of re-implementing
 * the array-stub in TypeScript because the snippet has subtle
 * function-shape requirements (arguments capture, push semantics) that
 * are easy to get wrong in a rewrite. Keeping it as a string ships
 * exactly what the studio-website ships.
 */

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

if (KEY && typeof document !== 'undefined') {
  const snippet = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(/\\/$/,"")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;void 0!==a?u=e[a]=[]:a="posthog";u.analytics=u;u.init=function(i,s,a){e._i.push([i,s,a])};u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e};u.people=u.people||[];g(u,"capture");g(u,"register");g(u,"register_once");g(u,"ready");g(u,"set_config");g(u,"get_config");g(u,"get_property");g(u,"get_distinct_id");g(u,"toString");g(u,"opt_in_capturing");g(u,"opt_out_capturing");g(u,"has_opted_in_capturing");g(u,"has_opted_out_capturing");g(u,"clear_opt_in_out_capturing");g(u,"startSessionRecording");g(u,"stopSessionRecording");g(u,"sessionRecordingStarted");g(u,"getActiveMatchingSurveys");g(u,"getSurveys");g(u,"getNextSurveyStep");g(u,"onFeatureFlags");g(u,"onSessionId");g(u,"getSessionId");g(u,"identify");g(u,"setPersonProperties");g(u,"group");g(u,"getGroups");g(u,"setGroupProperties");g(u,"reloadFeatureFlags");u._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(KEY)},{api_host:${JSON.stringify(HOST)},person_profiles:'identified_only'});`;
  const tag = document.createElement('script');
  tag.type = 'text/javascript';
  tag.text = snippet;
  document.head.appendChild(tag);
}
