/**
 * Setup checks: pass/fail checks on each step of a brand's tracking chain,
 * from a partner who can share the program to the payment that credits
 * them. GET /admin/tracking-health/setup serves them, and the daily alert
 * job (tracking-alerts.ts) emails a check that turns failing.
 *
 * Tracking health's flags (tracking-flags.ts) compare a brand with its own
 * past, so a brand whose chain never worked reads "Nothing unusual". These
 * are absolute: they say which step doesn't work, whatever it did before.
 *
 * Derived on read, like the rest of Tracking health, from the raw tables
 * plus two reads of the outside world that nothing stores: a fetch of each
 * program's destination, and one list call to the brand's Stripe. Those are
 * kept in this process for PROBE_TTL_MS; `refresh` skips that.
 *
 * Per active program (campaign-lifecycle.ts), at most MAX_PROGRAMS:
 *   partners     someone can share it: a partner with a link or a code.
 *                A program younger than a week is still waiting for them.
 *   destination  the destination answers 2xx after its redirects and the
 *                click survives them: `?cref=` on the final URL, the click
 *                id wherever `{click_id}` put it, or in a cookie set on the
 *                way. Fetched from here with a marked user agent and a
 *                click id of zeros, never through the router, so no Click
 *                is recorded. A Stripe-hosted checkout isn't fetched (a
 *                visit opens a Checkout Session); it must carry
 *                client_reference_id={click_id} (clickDestinationWarning).
 *   script       the program's partner clicks reach a page running the
 *                script (ClickLanding): none ever, or none since a date
 *                after which that many misses would be chance less than
 *                once in a thousand at the program's own landing rate.
 *                Clicks that are linked to a customer anyway reach the
 *                brand some other way (its server reads ?cref=), and pass.
 *                Skipped for a Stripe-hosted checkout: nothing lands there.
 * Account-wide:
 *   linking      the partner clicks that reached the site are linked to a
 *                customer (Identity: identify(), a Stripe checkout, a
 *                conversion call), with the same never / stopped rules.
 *   stripe       when the brand has a Stripe connection (or a single-tenant
 *                self-host's own key): it isn't waiting for a reconnect or
 *                uninstalled, and Stripe's events reach OpenPartner while
 *                Stripe shows payments.
 *   codes        when partner codes promise customers a discount: each has
 *                its promotion code in the brand's Stripe once the hourly
 *                retry has had its turn, quoting Stripe's last refusal
 *                (TrackingIssue reward_code_refused).
 *
 * Clicks are partner-link clicks that aren't flagged, from browsers rather
 * than bots, and at least a day old (a week for linking), so they've had
 * their chance to land or be linked. Every threshold is in
 * SETUP_THRESHOLDS (docs/tracking-health.md).
 *
 * Each check is one of:
 *   pass     works
 *   fail     doesn't; the alert job emails it when it turns failing
 *   waiting  too soon to tell (too few clicks, a program days old), or
 *            waiting on an earlier step
 *   unknown  couldn't be checked (the site turned the fetch away, Stripe
 *            refused the read); shown, never emailed
 */

import type { Knex } from 'knex';
import {
  TABLES,
  clickDestination,
  clickDestinationWarning,
  hasClickIdMacro,
  type ProgramRow,
  type TenantStripeConnectionRow,
} from '@openpartner/db';
import { campaignStatus } from './campaign-lifecycle.js';
import { customerRewardBackfillRunning, customerRewardDelivery, rewardCodeCounts } from './customer-rewards.js';
import { OutboundBlockedError, safeFetch, type SafeFetchResult } from './outbound-guard.js';
import { activeConnectionForTenant, isHostedMode } from './stripe-app.js';
import { brandStripeAccess, type ReconcileUnavailable } from './stripe-reconciliation.js';
import { getMode, stripe as platformStripe } from './stripe.js';
import { getTenancyMode } from './tenancy.js';
import { parseUserAgent } from './ua-parse.js';

export const SETUP_THRESHOLDS = {
  /** Traffic checks read this many days of clicks. */
  windowDays: 90,
  /** "Stopped" fails when that many misses in a row would happen by chance
   *  less often than this, at the rate the window shows. */
  maxChance: 0.001,
  script: {
    /** Clicks this old have had their chance to land. */
    maturityHours: 24,
    /** Clicks before "none has ever landed" can fail. */
    minClicks: 10,
    /** Clicks since the last landing before "stopped" can fail. */
    minClicksSince: 10,
    /** How far back "none has ever landed" looks when the window is quiet. */
    lookbackDays: 365,
  },
  linking: {
    /** Clicks this old have had their chance to be linked (a signup or a
     *  purchase days after the visit). */
    maturityDays: 7,
    /** Clicks that reached the site before "none has ever been linked" fails. */
    minClicks: 100,
    /** Such clicks since the last link before "stopped" can fail. */
    minClicksSince: 20,
  },
  partners: {
    /** A program this young is still waiting for partners. */
    graceDays: 7,
  },
  codes: {
    /** A code issued this recently may still be waiting for the hourly retry. */
    graceHours: 2,
    /** A connection this new may still be checking its codes. */
    verifyGraceHours: 24,
  },
  stripe: {
    /** Stripe payments this recent should have sent events. */
    paymentDays: 7,
    /** …once they're this old: the catch-up runs every six hours. */
    settleHours: 6,
  },
} as const;

export type SetupCheckId = 'partners' | 'destination' | 'script' | 'linking' | 'stripe' | 'codes';
export type SetupCheckStatus = 'pass' | 'fail' | 'waiting' | 'unknown';

export const SETUP_CHECK_TITLES: Record<SetupCheckId, string> = {
  partners: 'Partners can share it',
  destination: 'Destination keeps the click',
  script: 'Clicks reach the script',
  linking: 'Clicks are linked to customers',
  stripe: 'Stripe events arrive',
  codes: 'Partner codes have their discount',
};

export interface SetupCheck {
  id: SetupCheckId;
  title: string;
  /** A program id, or `account`. With `id`, what the alert job keys on. */
  subject: string;
  program: { id: string; name: string } | null;
  status: SetupCheckStatus;
  /** What was found. */
  summary: string;
  /** What to do about it, when there's something to do. */
  fix: string | null;
  /** The numbers behind it. */
  detail: Record<string, unknown>;
}

export interface SetupChecks {
  computedAt: string;
  checks: SetupCheck[];
}

/** Programs checked at most, oldest first. */
const MAX_PROGRAMS = 20;
/** Outside reads (destination fetches, Stripe) are kept this long. */
export const PROBE_TTL_MS = 10 * 60_000;
const PROBE_CACHE_MAX = 2000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The click id the destination fetch carries: recognisably not a click. */
export const SETUP_CHECK_CLICK_ID = '00000000000000000000000000';
export const SETUP_CHECK_USER_AGENT = 'Mozilla/5.0 (compatible; OpenPartner-SetupCheck/1; +https://openpartner.dev)';
const HOP_TIMEOUT_MS = 6_000;
const PROBE_DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 6;
const MAX_BODY_BYTES = 512 * 1024;
let retryDelayMs = 1_500;

/** Stripe-hosted checkout (click-destination.ts): a visit opens a session. */
const STRIPE_CHECKOUT_HOSTS = new Set(['buy.stripe.com', 'checkout.stripe.com']);
/** The script tag Integrations hands out loads /op.js. The npm SDK is
 *  bundled, so its absence from the HTML proves nothing. */
const OP_SCRIPT_RE = /\/op\.js\b/i;

type ActiveProgram = Pick<ProgramRow, 'id' | 'name' | 'destinationUrl' | 'createdAt'>;

export async function computeSetupChecks(
  db: Knex,
  tenantId: string,
  opts: { now?: Date; refresh?: boolean } = {},
): Promise<SetupChecks> {
  const now = opts.now ?? new Date();
  const refresh = opts.refresh ?? false;

  const programs = (
    (await db<ProgramRow>(TABLES.Program)
      .where({ tenantId })
      .whereNull('blockedAt')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .select('id', 'name', 'destinationUrl', 'startsAt', 'endsAt', 'createdAt')) as Array<
      ActiveProgram & Pick<ProgramRow, 'startsAt' | 'endsAt'>
    >
  )
    .filter((p) => campaignStatus(p, now) === 'active')
    .slice(0, MAX_PROGRAMS);

  // The fetches go out together, while the database reads run one after
  // another (`db` is usually a single-connection transaction).
  const probes = probeDestinations(tenantId, programs, refresh);
  const sharing = await partnerSharing(db, tenantId, programs);
  const traffic = await scriptTraffic(db, tenantId, programs, now);
  const linking = await linkingCheck(db, tenantId, now);
  const stripeCheck = await stripeEventsCheck(db, tenantId, now, refresh);
  const codes = await codesCheck(db, tenantId, now);
  const destination = await probes;

  const checks: SetupCheck[] = [];
  for (const p of programs) {
    checks.push(partnersCheck(p, sharing.get(p.id), now));
    const probe = destination.get(p.destinationUrl);
    checks.push(destinationCheck(p, probe ?? null));
    if (!isStripeCheckout(p.destinationUrl)) {
      checks.push(scriptCheck(p, traffic.get(p.id)!, probe ?? null));
    }
  }
  checks.push(linking);
  if (stripeCheck) checks.push(stripeCheck);
  if (codes) checks.push(codes);
  return { computedAt: now.toISOString(), checks };
}

/** One line per failing check, for the alert email. */
export function describeSetupCheck(check: SetupCheck): string {
  const where = check.program ? `${check.program.name}: ` : '';
  return `${where}${check.summary}${check.fix ? ` ${check.fix}` : ''}`;
}

function check(
  id: SetupCheckId,
  program: { id: string; name: string } | null,
  status: SetupCheckStatus,
  summary: string,
  fix: string | null,
  detail: Record<string, unknown> = {},
): SetupCheck {
  return {
    id,
    title: SETUP_CHECK_TITLES[id],
    subject: program?.id ?? 'account',
    program: program ? { id: program.id, name: program.name } : null,
    status,
    summary,
    fix,
    detail,
  };
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const day = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Would `misses` misses in a row, at `rate` per try, be this unlikely? */
function beyondChance(rate: number, misses: number): boolean {
  return rate > 0 && Math.pow(1 - rate, misses) < SETUP_THRESHOLDS.maxChance;
}

function isStripeCheckout(url: string): boolean {
  try {
    return STRIPE_CHECKOUT_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// partners
// ---------------------------------------------------------------------------

type Sharing = {
  enrolled: number;
  withLinks: number;
  withCodes: number;
  sharers: number;
};

async function partnerSharing(db: Knex, tenantId: string, programs: ActiveProgram[]): Promise<Map<string, Sharing>> {
  const out = new Map<string, Sharing>();
  if (programs.length === 0) return out;
  const active = `join ?? pa on pa.id = x."partnerId" and pa."tenantId" = x."tenantId" and pa."revokedAt" is null`;
  const { rows } = await db.raw<{ rows: Array<{ programId: string; source: 'enrolled' | 'link' | 'code'; partners: number }> }>(
    `with x as (
       select "tenantId", "programId", "partnerId", 'enrolled' as source from ?? where "tenantId" = ? and "programId" = any(?)
       union all
       select "tenantId", "programId", "partnerId", 'link' from ?? where "tenantId" = ? and "programId" = any(?)
       union all
       select "tenantId", "programId", "partnerId", 'code' from ??
        where "tenantId" = ? and "programId" = any(?) and "deactivatedAt" is null
     )
     select x."programId", x.source, count(distinct x."partnerId")::int as partners
       from x ${active}
      group by x."programId", x.source
     union all
     select x."programId", 'sharer', count(distinct x."partnerId")::int
       from x ${active}
      where x.source <> 'enrolled'
      group by x."programId"`,
    [
      TABLES.PartnerProgram,
      tenantId,
      programs.map((p) => p.id),
      TABLES.Link,
      tenantId,
      programs.map((p) => p.id),
      TABLES.Coupon,
      tenantId,
      programs.map((p) => p.id),
      TABLES.Partner,
      TABLES.Partner,
    ],
  );
  for (const p of programs) out.set(p.id, { enrolled: 0, withLinks: 0, withCodes: 0, sharers: 0 });
  for (const row of rows) {
    const s = out.get(row.programId)!;
    if (row.source === 'enrolled') s.enrolled = row.partners;
    else if (row.source === 'link') s.withLinks = row.partners;
    else if (row.source === 'code') s.withCodes = row.partners;
    else s.sharers = row.partners;
  }
  return out;
}

function partnersCheck(p: ActiveProgram, s: Sharing | undefined, now: Date): SetupCheck {
  const sharing = s ?? { enrolled: 0, withLinks: 0, withCodes: 0, sharers: 0 };
  if (sharing.sharers > 0) {
    const how = [
      sharing.withLinks ? `${plural(sharing.withLinks, 'partner')} with a link` : null,
      sharing.withCodes ? `${plural(sharing.withCodes, 'partner')} with a code` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return check('partners', p, 'pass', `${plural(sharing.sharers, 'partner')} can share it (${how}).`, null, sharing);
  }
  const young = now.getTime() - new Date(p.createdAt).getTime() < SETUP_THRESHOLDS.partners.graceDays * DAY;
  if (sharing.enrolled === 0) {
    return check(
      'partners',
      p,
      young ? 'waiting' : 'fail',
      'No partners in this program yet, so nobody can send it traffic.',
      'Invite partners from Partners, or share the program’s signup page.',
      sharing,
    );
  }
  return check(
    'partners',
    p,
    young ? 'waiting' : 'fail',
    `${plural(sharing.enrolled, 'partner is', 'partners are')} in this program, but none has a link or a code to share.`,
    'Partners make their links in their portal, and you can make one for them from their page under Partners.',
    sharing,
  );
}

// ---------------------------------------------------------------------------
// destination
// ---------------------------------------------------------------------------

export type ProbeOutcome =
  | 'ok'
  | 'lost_click'
  | 'http_error'
  | 'too_many_redirects'
  | 'unreachable'
  | 'turned_away'
  | 'blocked'
  | 'left_the_web';

export interface DestinationProbe {
  outcome: ProbeOutcome;
  /** Where the fetch ended, without query or fragment. */
  finalUrl: string | null;
  status: number | null;
  redirects: number;
  /** For unreachable / blocked / left_the_web: dns, timeout, refused, tls,
   *  network, the outbound guard's code, or the scheme. */
  reason: string | null;
  /** The final page's HTML loads /op.js. Null when no HTML was read. */
  scriptTag: boolean | null;
  checkedAt: string;
}

const probeCache = new Map<string, { expires: number; probe: DestinationProbe }>();
const stripeCache = new Map<string, { expires: number; payment: StripePaymentProbe }>();

/** For tests. */
export function __clearSetupProbeCache(): void {
  probeCache.clear();
  stripeCache.clear();
}

/** For tests: the pause before a failed fetch is tried again. */
export function __setProbeRetryDelayForTests(ms: number): void {
  retryDelayMs = ms;
}

function cacheSet<T>(cache: Map<string, { expires: number } & T>, key: string, value: { expires: number } & T): void {
  if (cache.size >= PROBE_CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

async function probeDestinations(
  tenantId: string,
  programs: ActiveProgram[],
  refresh: boolean,
): Promise<Map<string, DestinationProbe>> {
  const urls = [...new Set(programs.map((p) => p.destinationUrl).filter((u) => !isStripeCheckout(u)))];
  const out = new Map<string, DestinationProbe>();
  await Promise.all(
    urls.map(async (url) => {
      const key = `${tenantId}|${url}`;
      const cached = probeCache.get(key);
      if (cached && cached.expires > Date.now() && !refresh) {
        out.set(url, cached.probe);
        return;
      }
      let probe: DestinationProbe;
      try {
        probe = await probeDestination(url);
      } catch {
        // A destination saved before today's validation that doesn't parse.
        probe = {
          outcome: 'blocked',
          finalUrl: null,
          status: null,
          redirects: 0,
          reason: 'invalid_url',
          scriptTag: null,
          checkedAt: new Date().toISOString(),
        };
      }
      cacheSet(probeCache, key, { expires: Date.now() + PROBE_TTL_MS, probe });
      out.set(url, probe);
    }),
  );
  return out;
}

/**
 * Fetch a destination the way a partner click reaches it: with a click id
 * where the router puts one, following redirects one guarded hop at a
 * time (outbound-guard.ts, the brand admin's trust level), and say how far
 * it got. A failure that may pass (no answer, a 5xx) is tried once more.
 */
export async function probeDestination(destinationUrl: string): Promise<DestinationProbe> {
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  let probe = await walk(destinationUrl, deadline);
  const transient = probe.outcome === 'unreachable' || (probe.outcome === 'http_error' && (probe.status ?? 0) >= 500);
  if (transient && deadline - Date.now() > retryDelayMs + 1_000) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    probe = await walk(destinationUrl, deadline);
  }
  return probe;
}

async function walk(destinationUrl: string, deadline: number): Promise<DestinationProbe> {
  const macro = hasClickIdMacro(destinationUrl);
  let url = clickDestination(destinationUrl, SETUP_CHECK_CLICK_ID);
  let redirects = 0;
  const jar = new CookieJar();
  const end = (o: Pick<DestinationProbe, 'outcome'> & Partial<DestinationProbe>): DestinationProbe => ({
    finalUrl: bare(url),
    status: null,
    redirects,
    reason: null,
    scriptTag: null,
    checkedAt: new Date().toISOString(),
    ...o,
  });

  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return end({ outcome: 'unreachable', reason: 'timeout' });
    let res: SafeFetchResult;
    const hop = Math.min(HOP_TIMEOUT_MS, left);
    const cookie = jar.header(url);
    try {
      // safeFetch's own timeout starts after its DNS lookup; this one
      // covers the lookup too.
      res = await within(
        safeFetch(url, {
          trust: 'admin',
          timeoutMs: hop,
          readBody: MAX_BODY_BYTES,
          headers: {
            'user-agent': SETUP_CHECK_USER_AGENT,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            ...(cookie ? { cookie } : {}),
          },
        }),
        hop + 500,
      );
    } catch (err) {
      if (err instanceof OutboundBlockedError) return end({ outcome: 'blocked', reason: err.message });
      return end({ outcome: 'unreachable', reason: networkReason(err) });
    }
    // Cookies set on the way go with later hops, as a browser's would: a
    // server-side helper (referralCookieMiddleware) may keep the click in
    // one and redirect to a clean URL, and some sites redirect until a
    // cookie they set comes back.
    jar.store(url, res.headers.getSetCookie());

    if (res.status >= 300 && res.status < 400) {
      let next: URL | null = null;
      try {
        const location = res.headers.get('location');
        next = location ? new URL(location, url) : null;
      } catch {
        next = null;
      }
      if (!next) return end({ outcome: 'http_error', status: res.status, reason: 'no_location' });
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return end({ outcome: 'left_the_web', status: res.status, reason: next.protocol.replace(/:$/, '') });
      }
      if (redirects >= MAX_REDIRECTS) return end({ outcome: 'too_many_redirects', status: res.status });
      redirects += 1;
      url = next.toString();
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      const html = /html/i.test(res.headers.get('content-type') ?? '') ? (res.body ?? '') : null;
      return end({
        outcome: carriesClick(url, macro) || jar.holds(url, SETUP_CHECK_CLICK_ID) ? 'ok' : 'lost_click',
        status: res.status,
        scriptTag: html === null ? null : OP_SCRIPT_RE.test(html),
      });
    }
    // Bot protection answers a fetch like this one and lets a browser in.
    const turnedAway = res.status === 401 || res.status === 403 || res.status === 429 || res.headers.has('cf-mitigated');
    return end({ outcome: turnedAway ? 'turned_away' : 'http_error', status: res.status });
  }
}

/**
 * Just enough of a browser's cookie jar to follow redirects: name, value,
 * the host or domain it belongs to, Secure, and removal by Max-Age or an
 * Expires in the past. Paths are ignored.
 */
class CookieJar {
  private cookies = new Map<string, { value: string; domain: string; hostOnly: boolean; secure: boolean }>();

  store(url: string, setCookies: string[]): void {
    const host = new URL(url).hostname.toLowerCase();
    for (const line of setCookies) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      let hostOnly = true;
      let secure = false;
      let expired = false;
      for (const attr of attrs) {
        const [k = '', v = ''] = attr.split('=').map((x) => x.trim());
        const key = k.toLowerCase();
        if (key === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          // A domain the host doesn't belong to is refused, as browsers do.
          if (host !== d && !host.endsWith(`.${d}`)) {
            expired = true;
            break;
          }
          domain = d;
          hostOnly = false;
        } else if (key === 'secure') secure = true;
        else if (key === 'max-age' && Number(v) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(v) <= Date.now()) expired = true;
      }
      const id = `${domain}|${name}`;
      if (expired) this.cookies.delete(id);
      else this.cookies.set(id, { value, domain, hostOnly, secure });
    }
  }

  private matching(url: string) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return [...this.cookies.entries()].filter(
      ([, c]) =>
        (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)) &&
        (!c.secure || u.protocol === 'https:'),
    );
  }

  /** The Cookie header a browser would send to `url`. */
  header(url: string): string {
    return this.matching(url)
      .map(([id, c]) => `${id.slice(id.indexOf('|') + 1)}=${c.value}`)
      .join('; ');
  }

  /** Would `url` receive a cookie holding `text`? */
  holds(url: string, text: string): boolean {
    return this.matching(url).some(([, c]) => c.value.includes(text));
  }
}

function carriesClick(url: string, macro: boolean): boolean {
  if (!macro) {
    try {
      return new URL(url).searchParams.get('cref') === SETUP_CHECK_CLICK_ID;
    } catch {
      return false;
    }
  }
  return url.includes(SETUP_CHECK_CLICK_ID);
}

function bare(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function networkReason(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = e.cause?.code ?? e.code ?? '';
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code)) {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'dns';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'refused';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'tls';
  return 'network';
}

const UNREACHABLE: Record<string, string> = {
  dns: 'its name doesn’t resolve',
  timeout: 'it didn’t answer in time',
  refused: 'the connection was refused',
  tls: 'its HTTPS certificate wasn’t accepted',
  network: 'the connection failed',
};

const LOOK_YOURSELF =
  'Open one of your partner links yourself and check that the address still has ?cref= (or your {click_id}) when the page has loaded.';

function destinationCheck(p: ActiveProgram, probe: DestinationProbe | null): SetupCheck {
  const dest = p.destinationUrl;
  if (isStripeCheckout(dest)) {
    const warning = clickDestinationWarning(dest);
    return warning
      ? check('destination', p, 'fail', 'Partner links go straight to Stripe Checkout, which won’t receive the click.', warning)
      : check(
          'destination',
          p,
          'pass',
          'Partner links go straight to Stripe Checkout with client_reference_id={click_id}, so Stripe receives the click.',
          null,
        );
  }
  if (!probe) return check('destination', p, 'unknown', `Couldn’t fetch ${hostOf(dest)}.`, LOOK_YOURSELF);

  const host = hostOf(dest);
  const final = probe.finalUrl ?? dest;
  const after = probe.redirects ? ` after ${plural(probe.redirects, 'redirect')}` : '';
  const detail = { ...probe };
  const fixAddress = 'Point the program’s destination (Programs → Edit) at a page that loads.';
  switch (probe.outcome) {
    case 'ok':
      return check('destination', p, 'pass', `${final} answers${after} and keeps the click.`, null, detail);
    case 'lost_click': {
      const where = hasClickIdMacro(dest) ? 'the click id where {click_id} put it' : '?cref=';
      return check(
        'destination',
        p,
        'fail',
        probe.redirects
          ? `The click is lost on the way: ${host} redirects to ${final} without ${where}, so the page can’t tell which partner sent the visitor.`
          : `${final} answers without ${where} in its address, so the page can’t tell which partner sent the visitor.`,
        `Make the redirect keep the query string, or point the program’s destination at the final address (${final}).`,
        detail,
      );
    }
    case 'http_error':
      return check(
        'destination',
        p,
        'fail',
        probe.reason === 'no_location'
          ? `${final} answers HTTP ${probe.status} without saying where to go.`
          : `${final} answers HTTP ${probe.status}${after}, so partner clicks land on an error.`,
        fixAddress,
        detail,
      );
    case 'too_many_redirects':
      return check('destination', p, 'fail', `${host} redirects more than ${MAX_REDIRECTS} times, probably in a loop.`, fixAddress, detail);
    case 'unreachable':
      return check(
        'destination',
        p,
        'fail',
        `OpenPartner couldn’t reach ${hostOf(final)}: ${UNREACHABLE[probe.reason ?? 'network'] ?? UNREACHABLE.network}.`,
        'Check the address in the program’s settings, and that the site is up.',
        detail,
      );
    case 'turned_away':
      return check(
        'destination',
        p,
        'unknown',
        `${hostOf(final)} turned OpenPartner’s check away (HTTP ${probe.status}), as bot protection often does.`,
        LOOK_YOURSELF,
        detail,
      );
    case 'blocked':
      return check(
        'destination',
        p,
        'unknown',
        probe.reason === 'destination_not_public'
          ? `${hostOf(final)} resolves to a private address, which OpenPartner doesn’t fetch.`
          : `${hostOf(final)} isn’t an address OpenPartner fetches.`,
        LOOK_YOURSELF,
        detail,
      );
    case 'left_the_web':
      return check(
        'destination',
        p,
        'unknown',
        `${hostOf(final)} redirects to a ${probe.reason}: link, which only a device can open.`,
        LOOK_YOURSELF,
        detail,
      );
  }
}

// ---------------------------------------------------------------------------
// script
// ---------------------------------------------------------------------------

interface ProgramTraffic {
  clicks: number;
  landed: number;
  linked: number;
  lastLandedAt: Date | null;
  /** Clicks after the last landing, and how many of those were linked. */
  since: { clicks: number; linked: number } | null;
  /** No click of the program has ever landed (any age). */
  neverLanded: boolean;
  /** Over SETUP_THRESHOLDS.script.lookbackDays, when the window had too
   *  few clicks and nothing ever landed. */
  lookback: { clicks: number; linked: number } | null;
  /** The window before this one, when this one has no landing and earlier
   *  clicks did: the rate the silence is measured against. */
  prior: { clicks: number; landed: number } | null;
}

interface UaRow {
  programId: string;
  userAgent: string | null;
  clicks: number;
  landed: number;
  linked: number;
  lastLandedAt: Date | null;
}

const human = (ua: string | null) => parseUserAgent(ua).device !== 'bot';

async function scriptTraffic(
  db: Knex,
  tenantId: string,
  programs: ActiveProgram[],
  now: Date,
): Promise<Map<string, ProgramTraffic>> {
  const S = SETUP_THRESHOLDS.script;
  const out = new Map<string, ProgramTraffic>();
  const ids = programs.filter((p) => !isStripeCheckout(p.destinationUrl)).map((p) => p.id);
  if (ids.length === 0) return out;
  const until = new Date(now.getTime() - S.maturityHours * HOUR);
  const since = new Date(now.getTime() - SETUP_THRESHOLDS.windowDays * DAY);
  const linked = `exists (select 1 from ?? i where i."clickId" = c.id and i."tenantId" = c."tenantId")`;

  const { rows } = await db.raw<{ rows: UaRow[] }>(
    `select c."programId", c."userAgent",
            count(*)::int as clicks,
            count(l."clickId")::int as landed,
            count(*) filter (where ${linked})::int as linked,
            max(c.ts) filter (where l."clickId" is not null) as "lastLandedAt"
       from ?? c
       left join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"
      where c."tenantId" = ? and c."programId" = any(?) and c.ts >= ? and c.ts < ?
        and c."linkId" is not null and c."fraudFlag" is null
      group by c."programId", c."userAgent"`,
    [TABLES.Identity, TABLES.Click, TABLES.ClickLanding, tenantId, ids, since, until],
  );
  for (const id of ids) {
    out.set(id, { clicks: 0, landed: 0, linked: 0, lastLandedAt: null, since: null, neverLanded: false, lookback: null, prior: null });
  }
  for (const row of rows) {
    if (!human(row.userAgent)) continue;
    const t = out.get(row.programId)!;
    t.clicks += row.clicks;
    t.landed += row.landed;
    t.linked += row.linked;
    if (row.lastLandedAt && (!t.lastLandedAt || new Date(row.lastLandedAt) > t.lastLandedAt)) {
      t.lastLandedAt = new Date(row.lastLandedAt);
    }
  }

  for (const [programId, t] of out) {
    if (t.lastLandedAt) {
      const { rows: after } = await db.raw<{ rows: Array<{ userAgent: string | null; clicks: number; linked: number }> }>(
        `select c."userAgent", count(*)::int as clicks, count(*) filter (where ${linked})::int as linked
           from ?? c
          where c."tenantId" = ? and c."programId" = ? and c.ts > ? and c.ts < ?
            and c."linkId" is not null and c."fraudFlag" is null
          group by c."userAgent"`,
        [TABLES.Identity, TABLES.Click, tenantId, programId, t.lastLandedAt, until],
      );
      t.since = { clicks: 0, linked: 0 };
      for (const r of after.filter((r) => human(r.userAgent))) {
        t.since.clicks += r.clicks;
        t.since.linked += r.linked;
      }
      continue;
    }
    if (t.landed > 0) continue;
    const { rows: ever } = await db.raw<{ rows: Array<{ landed: boolean }> }>(
      `select exists (
         select 1 from ?? l join ?? c on c.id = l."clickId" and c."tenantId" = l."tenantId"
          where l."tenantId" = ? and c."programId" = ?
            and c."linkId" is not null and c."fraudFlag" is null
       ) as landed`,
      [TABLES.ClickLanding, TABLES.Click, tenantId, programId],
    );
    t.neverLanded = !ever[0]?.landed;
    if (!t.neverLanded) {
      const { rows: before } = await db.raw<{ rows: Array<{ userAgent: string | null; clicks: number; landed: number }> }>(
        `select c."userAgent", count(*)::int as clicks, count(l."clickId")::int as landed
           from ?? c
           left join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"
          where c."tenantId" = ? and c."programId" = ? and c.ts >= ? and c.ts < ?
            and c."linkId" is not null and c."fraudFlag" is null
          group by c."userAgent"`,
        [TABLES.Click, TABLES.ClickLanding, tenantId, programId, new Date(since.getTime() - SETUP_THRESHOLDS.windowDays * DAY), since],
      );
      t.prior = { clicks: 0, landed: 0 };
      for (const r of before.filter((r) => human(r.userAgent))) {
        t.prior.clicks += r.clicks;
        t.prior.landed += r.landed;
      }
      continue;
    }
    if (t.clicks >= S.minClicks) continue;
    // A quiet window: look further back, at the latest clicks only.
    const { rows: back } = await db.raw<{ rows: Array<{ userAgent: string | null; clicks: number; linked: number }> }>(
      `select x."userAgent", count(*)::int as clicks, count(*) filter (where x.linked)::int as linked
         from (
           select c."userAgent", ${linked} as linked
             from ?? c
            where c."tenantId" = ? and c."programId" = ? and c.ts >= ? and c.ts < ?
              and c."linkId" is not null and c."fraudFlag" is null
            order by c.ts desc
            limit 2000
         ) x
        group by x."userAgent"`,
      [TABLES.Identity, TABLES.Click, tenantId, programId, new Date(now.getTime() - S.lookbackDays * DAY), until],
    );
    t.lookback = { clicks: 0, linked: 0 };
    for (const r of back.filter((r) => human(r.userAgent))) {
      t.lookback.clicks += r.clicks;
      t.lookback.linked += r.linked;
    }
  }
  return out;
}

function scriptCheck(p: ActiveProgram, t: ProgramTraffic, probe: DestinationProbe | null): SetupCheck {
  const S = SETUP_THRESHOLDS.script;
  const detail = { ...t, scriptTag: probe?.scriptTag ?? null };
  const tagHint =
    probe?.scriptTag === false
      ? ' The destination page doesn’t load op.js.'
      : probe?.scriptTag === true
        ? ' The destination page loads op.js, so the script is there but not reporting.'
        : '';
  const fixMissing =
    probe?.scriptTag === true
      ? 'Check the script tag’s data-api-url against Integrations, and whether a consent banner holds it back (data-consent="pending").'
      : 'Add the script tag from Integrations to the destination page, and to every page a partner link can land on. If you load the SDK from npm, check that it runs there.';

  if (t.landed > 0) {
    const s = t.since;
    const rate = t.landed / t.clicks;
    if (s && s.linked === 0 && s.clicks >= S.minClicksSince && beyondChance(rate, s.clicks)) {
      return check(
        'script',
        p,
        'fail',
        `No partner click has reached a page running the script since ${day(t.lastLandedAt!)}: ${plural(s.clicks, 'click')} since, where ${pct(t.landed, t.clicks)} used to.${tagHint}`,
        'Something changed on the site around then: a page that lost the script tag, a redirect that drops ?cref=, or a consent banner that now holds the script back.',
        detail,
      );
    }
    return check(
      'script',
      p,
      'pass',
      `${pct(t.landed, t.clicks)} of the ${plural(t.clicks, 'partner click')} in the last ${SETUP_THRESHOLDS.windowDays} days reached a page running the script.`,
      null,
      detail,
    );
  }
  if (t.linked > 0) {
    return check(
      'script',
      p,
      'pass',
      `No landing reports, but ${t.linked.toLocaleString('en-US')} of the ${plural(t.clicks, 'partner click')} in the last ${SETUP_THRESHOLDS.windowDays} days were linked to a customer, so the click reaches you another way.`,
      null,
      detail,
    );
  }
  const seen =
    t.clicks >= S.minClicks
      ? { clicks: t.clicks, linked: 0, days: SETUP_THRESHOLDS.windowDays }
      : t.lookback
        ? { ...t.lookback, days: S.lookbackDays }
        : null;
  if (t.neverLanded && seen && seen.clicks >= S.minClicks && seen.linked === 0) {
    const when = seen.days === S.lookbackDays ? 'over the last year' : `in the last ${seen.days} days`;
    return check(
      'script',
      p,
      'fail',
      `None of the ${plural(seen.clicks, 'partner click')} ${when} reached a page running the OpenPartner script, and none was linked to a customer.${tagHint}`,
      fixMissing,
      detail,
    );
  }
  // Landings stopped before this window began. Measured against the window
  // before it; with too little there, against a stricter count.
  // A window before with enough clicks and no landing either: it stopped
  // long ago.
  const priorRate = t.prior && t.prior.clicks >= S.minClicks ? t.prior.landed / t.prior.clicks : null;
  const silent =
    priorRate === null ? t.clicks >= 3 * S.minClicks : priorRate === 0 || beyondChance(priorRate, t.clicks);
  if (!t.neverLanded && t.clicks >= S.minClicks && silent) {
    return check(
      'script',
      p,
      'fail',
      `None of the ${plural(t.clicks, 'partner click')} in the last ${SETUP_THRESHOLDS.windowDays} days reached a page running the script, though earlier ones did.${tagHint}`,
      'Something changed on the site: a page that lost the script tag, a redirect that drops ?cref=, or a consent banner that now holds the script back.',
      detail,
    );
  }
  // Too soon to say the script isn't reporting; a page without it is
  // worth knowing about already.
  const clicks = Math.max(t.clicks, t.lookback?.clicks ?? 0);
  const early = probe?.scriptTag === false ? tagHint : '';
  return check(
    'script',
    p,
    'waiting',
    clicks === 0
      ? `No partner clicks to judge by yet.${early}`
      : `${plural(clicks, 'partner click')} so far, none reported landing; judged at ${S.minClicks}.${early}`,
    null,
    detail,
  );
}

// ---------------------------------------------------------------------------
// linking
// ---------------------------------------------------------------------------

async function linkingCheck(db: Knex, tenantId: string, now: Date): Promise<SetupCheck> {
  const L = SETUP_THRESHOLDS.linking;
  const until = new Date(now.getTime() - L.maturityDays * DAY);
  const since = new Date(now.getTime() - SETUP_THRESHOLDS.windowDays * DAY);
  const { rows } = await db.raw<{
    rows: Array<{ userAgent: string | null; clicks: number; landed: number; linked: number; landedLinked: number }>;
  }>(
    `with w as (
       select c."userAgent",
              l."clickId" is not null as landed,
              exists (select 1 from ?? i where i."clickId" = c.id and i."tenantId" = c."tenantId") as linked
         from ?? c
         left join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"
        where c."tenantId" = ? and c.ts >= ? and c.ts < ?
          and c."linkId" is not null and c."fraudFlag" is null
     )
     select "userAgent",
            count(*)::int as clicks,
            count(*) filter (where landed)::int as landed,
            count(*) filter (where linked)::int as linked,
            count(*) filter (where landed and linked)::int as "landedLinked"
       from w
      group by "userAgent"`,
    [TABLES.Identity, TABLES.Click, TABLES.ClickLanding, tenantId, since, until],
  );
  const t = { clicks: 0, landed: 0, linked: 0, landedLinked: 0 };
  for (const r of rows.filter((r) => human(r.userAgent))) {
    t.clicks += r.clicks;
    t.landed += r.landed;
    t.linked += r.linked;
    t.landedLinked += r.landedLinked;
  }
  // The clicks that reached the site: those that landed, or every click
  // when none reports landing but some are linked (a server reads ?cref=).
  const viaLanding = t.landed > 0;
  const base = viaLanding ? t.landed : t.linked > 0 ? t.clicks : 0;
  const linked = viaLanding ? t.landedLinked : t.linked;
  const reached = viaLanding ? ' that reached your site' : '';
  const window = `in the last ${SETUP_THRESHOLDS.windowDays} days`;
  const detail = { ...t, base, baseLinked: linked, viaLanding };
  const fix =
    'Call identify() (or POST /attribution/identify) when someone signs up or logs in, pass client_reference_id on Stripe Checkout, or send the click with each conversion call.';

  if (base === 0) {
    return check(
      'linking',
      null,
      'waiting',
      t.clicks === 0
        ? 'No partner clicks a week old or more to judge by yet.'
        : 'Waiting for partner clicks to reach a page running the script.',
      null,
      detail,
    );
  }
  if (linked === 0) {
    const { rows: ever } = await db.raw<{ rows: Array<{ at: Date | null }> }>(
      `select max(i."stitchedAt") as at
         from ?? i join ?? c on c.id = i."clickId" and c."tenantId" = i."tenantId"
        where i."tenantId" = ? and c."linkId" is not null`,
      [TABLES.Identity, TABLES.Click, tenantId],
    );
    const lastLinkedAt = ever[0]?.at ?? null;
    if (base < L.minClicks) {
      return check(
        'linking',
        null,
        'waiting',
        `${plural(base, 'partner click')}${reached} ${window}, none linked to a customer yet; judged at ${L.minClicks}.`,
        null,
        { ...detail, lastLinkedAt },
      );
    }
    return check(
      'linking',
      null,
      'fail',
      lastLinkedAt
        ? `None of the ${plural(base, 'partner click')}${reached} ${window} was linked to a customer. The last link was on ${day(lastLinkedAt)}.`
        : `None of the ${plural(base, 'partner click')}${reached} ${window} was linked to a customer, and no partner click ever has been.`,
      fix,
      { ...detail, lastLinkedAt },
    );
  }

  // Linked before: how many reached the site since the last one that was?
  const { rows: last } = await db.raw<{ rows: Array<{ userAgent: string | null; at: Date | null }> }>(
    `select c."userAgent", max(c.ts) as at
       from ?? c
       ${viaLanding ? 'join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"' : ''}
      where c."tenantId" = ? and c.ts >= ? and c.ts < ?
        and c."linkId" is not null and c."fraudFlag" is null
        and exists (select 1 from ?? i where i."clickId" = c.id and i."tenantId" = c."tenantId")
      group by c."userAgent"`,
    [TABLES.Click, ...(viaLanding ? [TABLES.ClickLanding] : []), tenantId, since, until, TABLES.Identity],
  );
  const lastLinked = last
    .filter((r) => human(r.userAgent) && r.at)
    .map((r) => new Date(r.at!))
    .sort((a, b) => b.getTime() - a.getTime())[0]!;
  const { rows: after } = await db.raw<{ rows: Array<{ userAgent: string | null; clicks: number }> }>(
    `select c."userAgent", count(*)::int as clicks
       from ?? c
       ${viaLanding ? 'join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"' : ''}
      where c."tenantId" = ? and c.ts > ? and c.ts < ?
        and c."linkId" is not null and c."fraudFlag" is null
      group by c."userAgent"`,
    [TABLES.Click, ...(viaLanding ? [TABLES.ClickLanding] : []), tenantId, lastLinked, until],
  );
  const sinceClicks = after.filter((r) => human(r.userAgent)).reduce((n, r) => n + r.clicks, 0);
  if (sinceClicks >= L.minClicksSince && beyondChance(linked / base, sinceClicks)) {
    return check(
      'linking',
      null,
      'fail',
      `None of the ${plural(sinceClicks, 'partner click')}${reached} since ${day(lastLinked)} was linked to a customer, where ${pct(linked, base)} used to be.`,
      fix,
      { ...detail, lastLinkedAt: lastLinked, sinceClicks },
    );
  }
  return check(
    'linking',
    null,
    'pass',
    `${pct(linked, base)} of the ${plural(base, 'partner click')}${reached} ${window} were linked to a customer.`,
    null,
    { ...detail, lastLinkedAt: lastLinked, sinceClicks },
  );
}

// ---------------------------------------------------------------------------
// stripe
// ---------------------------------------------------------------------------

type StripePaymentProbe =
  | { ok: true; latestPaymentAt: string | null }
  | { ok: false; reason: ReconcileUnavailable; detail?: string };

const RECONNECT = 'Reconnect Stripe under Integrations.';

/** Event types a payment sends: what shows that payments' events arrive. */
const PAYMENT_EVENT_TYPES = ['invoice.paid', 'checkout.session.completed', 'checkout.session.async_payment_succeeded'];

async function stripeEventsCheck(db: Knex, tenantId: string, now: Date, refresh: boolean): Promise<SetupCheck | null> {
  const X = SETUP_THRESHOLDS.stripe;
  let conn: TenantStripeConnectionRow | null = null;
  if (isHostedMode()) {
    conn = await activeConnectionForTenant(db, tenantId);
    if (!conn) {
      const last = (await db<TenantStripeConnectionRow>(TABLES.TenantStripeConnection)
        .where({ tenantId })
        .orderBy('connectedAt', 'desc')
        .first('stripeAccountId', 'disconnectReason', 'disconnectedAt')) as
        | Pick<TenantStripeConnectionRow, 'stripeAccountId' | 'disconnectReason' | 'disconnectedAt'>
        | undefined;
      if (last?.disconnectReason !== 'deauthorized') return null;
      return check(
        'stripe',
        null,
        'fail',
        `The OpenPartner Stripe App was removed from ${last.stripeAccountId}${last.disconnectedAt ? ` on ${day(last.disconnectedAt)}` : ''}, so Stripe payments no longer reach OpenPartner.`,
        RECONNECT,
        { stripeAccountId: last.stripeAccountId, disconnectedAt: last.disconnectedAt },
      );
    }
    if (conn.refreshFailedAt) {
      return check(
        'stripe',
        null,
        'fail',
        `Stripe stopped accepting OpenPartner’s connection to ${conn.stripeAccountId} on ${day(conn.refreshFailedAt)}, so Stripe payments no longer reach OpenPartner.`,
        RECONNECT,
        { stripeAccountId: conn.stripeAccountId, refreshFailedAt: conn.refreshFailedAt },
      );
    }
  } else if (getTenancyMode() !== 'single' || !platformStripe) {
    return null;
  }

  const [log] = (await db(TABLES.StripeEventLog)
    .where({ tenantId })
    .whereIn('type', PAYMENT_EVENT_TYPES)
    .max({ at: 'receivedAt' })) as Array<{ at: Date | null }>;
  const lastEventAt = log?.at ? new Date(log.at) : null;
  const account = conn ? `${conn.stripeAccountId} (${conn.livemode ? 'live' : 'test'} mode)` : 'your Stripe account';
  const detail: Record<string, unknown> = { stripeAccountId: conn?.stripeAccountId ?? null, lastEventAt };

  // Payments paid since the event log began for this account (a hosted
  // connection's eventLogSince; on a self-host, the migration that created
  // the log), within the last paymentDays, and long enough ago that the
  // webhook, or the catch-up, has had its turn.
  const logSince = conn ? new Date(conn.eventLogSince) : await eventLogStart(db);
  const from = new Date(Math.max(now.getTime() - X.paymentDays * DAY, logSince?.getTime() ?? 0));
  const to = new Date(now.getTime() - X.settleHours * HOUR);
  if (to <= from) return check('stripe', null, 'pass', `Connected to ${account}.`, null, detail);

  const payment = await stripePayments(db, tenantId, from, to, refresh);
  detail.payments = payment;
  // No Stripe of the brand's after all (a self-host whose key isn't the
  // brand's): nothing to check.
  if (!payment.ok && payment.reason === 'not_connected') return null;
  if (!payment.ok) {
    return check(
      'stripe',
      null,
      'unknown',
      payment.reason === 'missing_permissions'
        ? `Connected to ${account}, but the connection can’t read invoices and Checkout Sessions to compare with.`
        : `Connected to ${account}, but Stripe didn’t answer when OpenPartner asked for recent payments.`,
      payment.reason === 'missing_permissions' ? RECONNECT : null,
      detail,
    );
  }
  // A payment's own event arrives when it's paid: one logged at or after the
  // latest settled payment shows they're arriving.
  const latest = payment.latestPaymentAt ? new Date(payment.latestPaymentAt) : null;
  if (latest && !(lastEventAt && lastEventAt >= latest)) {
    return check(
      'stripe',
      null,
      'fail',
      `Stripe shows payments from the last ${X.paymentDays} days (the latest on ${day(latest)}), but their events never reached OpenPartner${lastEventAt ? `: the last arrived ${day(lastEventAt)}` : ''}.`,
      conn
        ? 'The connection looks healthy, so this is on OpenPartner’s side: contact support.'
        : 'Check the webhook endpoint in your Stripe Dashboard: it should point at this instance’s /webhooks/stripe and send invoice and Checkout events.',
      detail,
    );
  }
  return check(
    'stripe',
    null,
    'pass',
    latest
      ? `Connected to ${account}. Payment events are arriving: the last on ${day(lastEventAt!)}.`
      : `Connected to ${account}. No payments in the last ${X.paymentDays} days to expect events from.`,
    null,
    detail,
  );
}

/** When this instance began logging Stripe events: the migration that made
 *  StripeEventLog. In a savepoint, so a role that can't read the migration
 *  table only loses the floor. */
async function eventLogStart(db: Knex): Promise<Date | null> {
  try {
    return await db.transaction(async (sp) => {
      const row = (await sp('knex_migrations').where('name', 'like', '20261024110000%').first('migration_time')) as
        | { migration_time: Date }
        | undefined;
      return row ? new Date(row.migration_time) : null;
    });
  } catch {
    return null;
  }
}

/** Stripe calls here never wait long or retry: the page and the daily job
 *  read on. */
const STRIPE_REQUEST = { timeout: 8_000, maxNetworkRetries: 0 };
/** Objects read per kind: the first page, newest first. */
const PAYMENT_SCAN = 20;

/**
 * When the latest payment in [from, to] was made: a paid invoice with an
 * amount, by its paid time, or a paid Checkout with an amount, by its
 * creation (a session completes within a day of it, so only sessions a day
 * older than `to` count). Zero-value invoices, setup-mode and still-unpaid
 * Checkouts aren't payments. Through the access the reconciliation uses.
 */
async function stripePayments(db: Knex, tenantId: string, from: Date, to: Date, refresh: boolean): Promise<StripePaymentProbe> {
  let access: Awaited<ReturnType<typeof brandStripeAccess>>;
  try {
    access = await brandStripeAccess(db, tenantId);
  } catch {
    return { ok: false, reason: 'stripe_error' };
  }
  if (!access.ok) return { ok: false, reason: access.reason };
  const key = `${tenantId}|${access.identity}`;
  const cached = stripeCache.get(key);
  if (cached && cached.expires > Date.now() && !refresh) return cached.payment;

  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  let payment: StripePaymentProbe;
  try {
    const invoices = await within(
      access.stripe.invoices.list(
        // Created up to three days before it was paid.
        { status: 'paid', created: { gte: sec(from) - 3 * 86_400, lte: sec(to) }, limit: PAYMENT_SCAN },
        STRIPE_REQUEST,
      ),
      STRIPE_REQUEST.timeout,
    );
    const sessions = await within(
      access.stripe.checkout.sessions.list(
        { status: 'complete', created: { gte: sec(from), lte: sec(to) - 86_400 }, limit: PAYMENT_SCAN },
        STRIPE_REQUEST,
      ),
      STRIPE_REQUEST.timeout,
    );
    const paidAt = [
      ...invoices.data
        .filter((i) => i.amount_paid > 0)
        .map((i) => i.status_transitions?.paid_at ?? i.created)
        .filter((t) => t >= sec(from) && t <= sec(to)),
      ...sessions.data.filter((c) => c.payment_status === 'paid' && (c.amount_total ?? 0) > 0).map((c) => c.created),
    ];
    const latest = paidAt.length ? Math.max(...paidAt) : 0;
    payment = { ok: true, latestPaymentAt: latest ? new Date(latest * 1000).toISOString() : null };
  } catch (err) {
    const type = (err as { type?: string }).type;
    payment =
      type === 'StripePermissionError'
        ? { ok: false, reason: 'missing_permissions' }
        : { ok: false, reason: 'stripe_error', detail: err instanceof Error ? err.message : String(err) };
  }
  cacheSet(stripeCache, key, { expires: Date.now() + PROBE_TTL_MS, payment });
  return payment;
}

/** `promise`, or a rejection once `ms` have passed. The work itself may run
 *  on; nobody waits for it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

async function codesCheck(db: Knex, tenantId: string, now: Date): Promise<SetupCheck | null> {
  const C = SETUP_THRESHOLDS.codes;
  const { total, missing, recent } = await rewardCodeCounts(db, tenantId, new Date(now.getTime() - C.graceHours * HOUR));
  if (total === 0) return null;
  const detail: Record<string, unknown> = { total, missing, recent };
  const delivery = await customerRewardDelivery(tenantId);
  detail.delivery = delivery;
  const codes = plural(total, 'partner code');

  if (delivery === 'brand') {
    return check(
      'codes',
      null,
      'unknown',
      `${codes} promise customers a discount, and OpenPartner has no Stripe connection that can create it, so it can’t check that the discount exists at your checkout.`,
      getMode() === 'selfhost'
        ? 'Create a matching discount for each code in your own checkout.'
        : 'Connect Stripe under Integrations to have each code’s discount created there, or create matching discounts in your own checkout.',
      detail,
    );
  }
  if (delivery === 'unconfigured') {
    return check(
      'codes',
      null,
      'unknown',
      `${codes} promise customers a discount, and this instance has no Stripe key to create it with.`,
      'Set STRIPE_SECRET_KEY to your Stripe account’s key, or create a matching discount for each code in your own checkout.',
      detail,
    );
  }
  // On hosted, a code's promotion code may be from an earlier connection
  // (another account, or test mode) until a pass verifies them all against
  // this one.
  const conn = isHostedMode() ? await activeConnectionForTenant(db, tenantId) : null;
  const unverified = conn != null && conn.rewardsVerifiedAt == null;
  if (missing === 0 && recent === 0 && !unverified) {
    const all = total === 1 ? 'The partner code has its' : `All ${codes} have their`;
    return check('codes', null, 'pass', `${all} customer discount in your Stripe.`, null, detail);
  }
  const checking =
    customerRewardBackfillRunning(tenantId) ||
    (unverified && now.getTime() - new Date(conn!.connectedAt).getTime() < C.verifyGraceHours * HOUR);
  if (missing === 0 && unverified && !checking) {
    return check(
      'codes',
      null,
      'unknown',
      `OpenPartner hasn’t been able to check partner codes’ discounts against ${conn!.stripeAccountId} since it was connected.`,
      'It tries every hour. If this stays, reconnect Stripe under Integrations.',
      detail,
    );
  }
  if (checking || missing === 0) {
    return check(
      'codes',
      null,
      'waiting',
      missing + recent > 0
        ? `Creating partner codes’ discounts in your Stripe: ${(missing + recent).toLocaleString('en-US')} to go.`
        : 'Checking partner codes’ discounts against your Stripe.',
      null,
      detail,
    );
  }

  const issue = (await db(TABLES.TrackingIssue)
    .where({ tenantId, kind: 'reward_code_refused' })
    .andWhere('lastSeenAt', '>=', new Date(now.getTime() - 7 * DAY))
    .orderBy('lastSeenAt', 'desc')
    .first('sampleRef', 'detail', 'lastSeenAt')) as { sampleRef: string | null; detail: string | null; lastSeenAt: Date } | undefined;
  detail.lastRefusal = issue ?? null;
  const why = issue?.detail ? ` Stripe’s last answer${issue.sampleRef ? `, for ${issue.sampleRef}` : ''}: “${issue.detail}”` : '';
  return check(
    'codes',
    null,
    'fail',
    `${
      missing < total
        ? `${missing.toLocaleString('en-US')} of the ${codes} ${missing === 1 ? 'has' : 'have'} no discount`
        : total === 1
          ? 'The partner code has no discount'
          : `None of the ${codes} has its discount`
    } in your Stripe, so customers who enter ${missing === 1 ? 'it' : 'them'} pay full price.${why}`,
    getMode() === 'selfhost'
      ? 'Fix what Stripe objects to, then retire each code and issue it again, which creates its discount.'
      : 'OpenPartner tries again every hour. If Stripe’s answer is about your account (a code you already use, a permission), fix it there; otherwise contact support.',
    detail,
  );
}
