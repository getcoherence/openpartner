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
 */

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    posthog?: any;
  }
}

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';

if (KEY && typeof document !== 'undefined' && typeof window !== 'undefined') {
  // The bootstrap below is the standard PostHog array-stub: it stubs
  // out posthog.* methods that buffer to an array, then async-loads
  // /static/array.js which replaces the stubs and replays the buffer.
  // Lets early code call posthog.capture() / posthog.identify() safely
  // before the real script lands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((t: Document, e: any) => {
    let p: HTMLScriptElement;
    let r: HTMLScriptElement;
    if (e.__SV) return;
    window.posthog = e;
    e._i = [];
    e.init = function (i: string, s: { api_host: string }, a: string) {
      function g(t2: Record<string, unknown>, e2: string) {
        const o = e2.split('.');
        if (o.length === 2) {
          t2 = t2[o[0]!] as Record<string, unknown>;
          e2 = o[1]!;
        }
        t2[e2] = function () {
          (t2 as { push: (x: unknown) => void }).push(
            // eslint-disable-next-line prefer-rest-params
            ([e2] as unknown[]).concat(Array.prototype.slice.call(arguments, 0)),
          );
        };
      }
      p = t.createElement('script');
      p.type = 'text/javascript';
      p.crossOrigin = 'anonymous';
      p.async = true;
      p.src = s.api_host.replace(/\/$/, '') + '/static/array.js';
      r = t.getElementsByTagName('script')[0]!;
      r.parentNode!.insertBefore(p, r);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let u: any = e;
      if (a !== undefined) {
        u = e[a] = [];
      } else {
        a = 'posthog';
      }
      u.analytics = u;
      u.init = function (i2: string, s2: unknown, a2: string) {
        e._i.push([i2, s2, a2]);
      };
      u.toString = function (t2: boolean) {
        let e2 = 'posthog';
        if (a !== 'posthog') e2 += '.' + a;
        if (!t2) e2 += ' (stub)';
        return e2;
      };
      u.people = u.people || [];
      const methods = [
        'capture', 'register', 'register_once', 'ready', 'set_config', 'get_config',
        'get_property', 'get_distinct_id', 'toString', 'opt_in_capturing',
        'opt_out_capturing', 'has_opted_in_capturing', 'has_opted_out_capturing',
        'clear_opt_in_out_capturing', 'startSessionRecording', 'stopSessionRecording',
        'sessionRecordingStarted', 'getActiveMatchingSurveys', 'getSurveys',
        'getNextSurveyStep', 'onFeatureFlags', 'onSessionId', 'getSessionId',
        'identify', 'setPersonProperties', 'group', 'getGroups',
        'setGroupProperties', 'reloadFeatureFlags',
      ];
      for (const m of methods) g(u, m);
      u._i.push([i, s, a]);
    };
    e.__SV = 1;
  })(document, window.posthog || []);

  window.posthog.init(KEY, { api_host: HOST, person_profiles: 'identified_only' });
}
