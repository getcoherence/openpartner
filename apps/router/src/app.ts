import { Hono, type Context } from 'hono';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import {
  clickDestination,
  createDb,
  forwardedClientAddress,
  TABLES,
  trustProxyFromEnv,
  type LinkRow,
  type TestClickRow,
  type TrustProxy,
} from '@openpartner/db';
import { checkIpCap, checkVelocity } from './velocity.js';

type Db = Awaited<ReturnType<typeof createDb>>;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

/** A test link's token: 32 random bytes, base64url (the API's test-clicks.ts). */
const TEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TEST_LINK_GONE = 'This test link has expired or was already used. Send a new test click from Tracking health.';

/** The Tenant columns {@link servesClicks} needs. */
const TENANT_GATE_COLUMNS = ['id', 'status', 'approvalStatus', 'pendingDeletionAt'];

interface TenantGate {
  id: string;
  status: string;
  approvalStatus: string;
  pendingDeletionAt: Date | null;
}

/**
 * Whether a brand's links still record clicks. Only an active brand that
 * the platform approved: a pending (or rejected) brand collects no
 * attribution data, and backfilled/self-host tenants are 'approved', so
 * that check is a no-op there (see migration 20260712000000). A brand
 * pending deletion stops collecting the moment it asks to be deleted,
 * not when the 30-day grace window ends.
 */
function servesClicks(tenant: TenantGate | undefined): tenant is TenantGate {
  return (
    !!tenant &&
    tenant.status === 'active' &&
    tenant.approvalStatus === 'approved' &&
    tenant.pendingDeletionAt == null
  );
}

export function createRouterApp(db: Db): Hono {
  const app = new Hono();
  const cookieDomain = process.env.COOKIE_DOMAIN ?? 'localhost';
  const trustProxy = trustProxyFromEnv(process.env.TRUST_PROXY);

  app.get('/health', (c) => c.json({ ok: true, service: 'router' }));

  // Click router. Two URL shapes depending on tenancy:
  //   /r/:slug/:linkKey  — multi-tenant, slug disambiguates per-tenant
  //                        unique linkKeys. The shared share-URL format
  //                        Network's deriveShareUrl produces.
  //   /r/:linkKey        — key-only. Single-tenant deployments (globally
  //                        unique keys), AND white-label custom domains,
  //                        where the Host header resolves the tenant so the
  //                        key is scoped without a slug in the URL.
  //
  // Every shape is ALSO mounted without the /r prefix: DO App Platform's
  // ingress strips the matched `/r` path prefix before forwarding (same as
  // it strips /api for the api component), so in production the router
  // receives `/<key>`, not `/r/<key>`. The prefixed routes stay for dev,
  // self-host reverse proxies that preserve the path, and direct hits.
  //
  // All resolve → check the tenant serves clicks → insert Click → set
  // first-party cookie → 302. A tenant that doesn't serve clicks gets a
  // 404 on every shape: no Click row, no redirect.
  async function handleSlugKey(c: Context): Promise<Response> {
    const { slug, linkKey } = c.req.param() as { slug: string; linkKey: string };
    const tenant = (await db('Tenant').where({ slug }).first(TENANT_GATE_COLUMNS)) as TenantGate | undefined;
    if (!servesClicks(tenant)) return c.text('Tenant not found', 404);
    const link = await db<LinkRow>(TABLES.Link).where({ tenantId: tenant.id, linkKey }).first();
    return resolveLink(c, link);
  }

  async function handleKeyOnly(c: Context): Promise<Response> {
    const linkKey = c.req.param('linkKey');
    // White-label custom domain: the Host header names the tenant, so scope
    // the lookup — two tenants may use the same key. A domain we know never
    // falls through to another tenant's key. Unknown hosts (and
    // single-tenant installs) use the global lookup.
    const host = (c.req.header('host') ?? '').split(':')[0]!.toLowerCase().trim();
    if (host) {
      const tenant = (await db('Tenant').where({ customDomain: host }).first(TENANT_GATE_COLUMNS)) as
        | TenantGate
        | undefined;
      if (tenant) {
        if (!servesClicks(tenant)) return c.text('Tenant not found', 404);
        const link = await db<LinkRow>(TABLES.Link)
          .where({ tenantId: tenant.id, linkKey })
          .first();
        return resolveLink(c, link);
      }
    }
    const link = await db<LinkRow>(TABLES.Link).where({ linkKey }).first();
    if (link) {
      const tenant = (await db('Tenant').where({ id: link.tenantId }).first(TENANT_GATE_COLUMNS)) as
        | TenantGate
        | undefined;
      if (!servesClicks(tenant)) return c.text('Tenant not found', 404);
    }
    return resolveLink(c, link);
  }

  // An admin's test click (Admin → Tracking health → Send a test click;
  // the API's test-clicks.ts). The token is single-use and expires, and
  // only the admin API creates TestClick rows, so a partner can't mark a
  // click of their own as a test. It goes to the program's destination
  // exactly as a partner's click would, but it is recorded on its TestClick
  // row, never in Click, so nothing that reads clicks (attribution,
  // payouts, counts, fraud review) can see it.
  //
  // No tenant slug in the URL: the token names the brand. Registered before
  // the link shapes, which would otherwise read `_test` as a slug (tenant
  // slugs are [a-z0-9-], so none is `_test`).
  async function handleTestClick(c: Context): Promise<Response> {
    const token = c.req.param('token') ?? '';
    if (!TEST_TOKEN_RE.test(token)) return c.text('Link not found', 404);
    const test = (await db<TestClickRow>(TABLES.TestClick)
      .where({ tokenHash: createHash('sha256').update(token).digest('hex') })
      .first()) as TestClickRow | undefined;
    if (!test) return c.text('Link not found', 404);
    if (test.clickedAt || new Date(test.expiresAt).getTime() <= Date.now()) return c.text(TEST_LINK_GONE, 410);

    const tenant = (await db('Tenant').where({ id: test.tenantId }).first(TENANT_GATE_COLUMNS)) as
      | TenantGate
      | undefined;
    if (!servesClicks(tenant)) return c.text('Tenant not found', 404);
    const program = (await db(TABLES.Program)
      .where({ id: test.programId, tenantId: test.tenantId })
      .first(['destinationUrl', 'blockedAt'])) as { destinationUrl: string; blockedAt: Date | null } | undefined;
    if (!program) return c.text('Program not found', 410);
    if (program.blockedAt) return c.text('Link unavailable', 410);

    if (process.env.NODE_ENV !== 'test' && checkIpCap(clientIpHash(c, trustProxy))) {
      c.header('Retry-After', '60');
      return c.text('Rate limited', 429);
    }

    const clickId = ulid();
    const destination = clickDestination(program.destinationUrl, clickId);
    // Claimed at most once: a second open, even a racing one, finds it used.
    const claimed = await db(TABLES.TestClick)
      .where({ id: test.id, clickedAt: null })
      .where('expiresAt', '>', new Date())
      .update({ clickId, clickedAt: new Date(), destination });
    if (!claimed) return c.text(TEST_LINK_GONE, 410);

    c.header('Set-Cookie', clickCookie(clickId));
    return c.redirect(destination, 302);
  }

  app.get('/r/_test/:token', handleTestClick);
  app.get('/r/:slug/:linkKey', handleSlugKey);
  app.get('/r/:linkKey', handleKeyOnly);
  // Prefix-stripped variants (DO ingress). Registered after /health, and
  // Hono prefers static routes over params, so /health stays unaffected.
  app.get('/_test/:token', handleTestClick);
  app.get('/:slug/:linkKey', handleSlugKey);
  app.get('/:linkKey', handleKeyOnly);

  /** The first-party cookie a click sets, holding its id. */
  function clickCookie(clickId: string): string {
    return `_cref=${clickId}; Domain=${cookieDomain}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  }

  async function resolveLink(c: Context, link: LinkRow | undefined) {
    if (!link) {
      return c.text('Link not found', 404);
    }

    // If the partner's been revoked by the admin, we still redirect to
    // keep end-user UX intact (no broken links from a pulled partner)
    // but flag the click so attribution silently skips it.
    const partner = (await db('Partner').where({ id: link.partnerId }).first()) as
      | { revokedAt: Date | null }
      | undefined;
    const partnerRevoked = !!partner?.revokedAt;

    // Always resolve the Program — even for a per-Link deep-link override —
    // so a platform-operator takedown (Program.blockedAt) is enforced here:
    // a blocked program's partner links stop redirecting regardless of
    // whether they carry their own destination.
    const program = (await db(TABLES.Program)
      .where({ id: link.programId })
      .first(['destinationUrl', 'blockedAt'])) as
      | { destinationUrl: string; blockedAt: Date | null }
      | undefined;
    if (!program) return c.text('Program not found', 410);
    if (program.blockedAt) return c.text('Link unavailable', 410);

    // Destination resolution: per-Link override (deep link) wins; otherwise
    // inherit from the Program. This is the source-of-truth flip — brands
    // own the destination via Program.destinationUrl, partners only get
    // an override when the Program explicitly allows deep-linking.
    const destinationUrl = link.destinationUrl || program.destinationUrl;

    // The click id goes wherever the destination's {click_id} macro says
    // (e.g. a Stripe Payment Link's client_reference_id), else as ?cref=.
    const clickId = ulid();
    const destination = clickDestination(destinationUrl, clickId);

    const ipHash = clientIpHash(c, trustProxy);

    // Hard per-IP cap — refuse before we hit the DB. Unlike velocity this
    // rejects outright; a real user clicking 300 links in a minute doesn't
    // exist. Tests share the process and bypass to avoid fighting it.
    if (process.env.NODE_ENV !== 'test' && checkIpCap(ipHash)) {
      c.header('Retry-After', '60');
      return c.text('Rate limited', 429);
    }

    const velocityFlagged = checkVelocity(ipHash, link.linkKey);

    // Precedence: revoked beats velocity — a click on a pulled partner's
    // link is not a velocity signal, it's a revoked signal.
    const fraudFlag = partnerRevoked ? 'revoked' : velocityFlagged ? 'velocity' : null;

    // UTM extraction off the inbound URL (NOT the destination — the
    // destination carries our click id and otherwise inherits from the
    // campaign, so partners can't put UTMs there). Read-only, all 5
    // standard params for export fidelity even though we only break down
    // on source/medium/campaign in the analytics UI today.
    const inbound = new URL(c.req.url, 'http://placeholder');
    const utm = extractUtm(inbound.searchParams);
    // The publisher's own sub-ID: tracking tools (wecantrack and the like)
    // put their click id here and match conversions on it when it comes
    // back on the commission webhooks and the {sub_id} postback macro.
    // Stored, never forwarded: the destination only gets our click id.
    const subId = boundedParam(inbound.searchParams, 'sub_id');
    // Cloudflare populates cf-ipcountry on every request when the router
    // sits behind their proxy. Free on every CF plan; null when the
    // router is hit directly (dev, self-host without CF in front).
    const country = (c.req.header('cf-ipcountry') ?? '').toLowerCase().slice(0, 2) || null;

    await db(TABLES.Click).insert({
      id: clickId,
      // Clicks inherit the tenant from the Link (NOT NULL since the DB
      // dropped the single-tenant column default) — the router runs on
      // the privileged pool, so nothing else stamps it.
      tenantId: link.tenantId,
      linkId: link.id,
      partnerId: link.partnerId,
      programId: link.programId,
      landingUrl: destination,
      ipHash,
      userAgent: c.req.header('user-agent') ?? null,
      referer: c.req.header('referer') ?? null,
      utmSource: utm.source,
      utmMedium: utm.medium,
      utmCampaign: utm.campaign,
      utmTerm: utm.term,
      utmContent: utm.content,
      subId,
      country,
      fraudFlag,
    });

    c.header('Set-Cookie', clickCookie(clickId));

    return c.redirect(destination, 302);
  }

  return app;
}

/**
 * The visitor's IP, hashed. Prefer proxy headers when they're present (we
 * run behind Caddy / DO's edge), but fall back to the node socket so an
 * attacker who reaches the router directly and omits headers doesn't land
 * on ipHash=null and bypass the cap. With TRUST_PROXY set, it's the API's
 * req.ip rule instead (packages/db/src/trusted-proxy.ts): walk in from the
 * socket, so a forged left-most X-Forwarded-For entry is never the answer.
 */
function clientIpHash(c: Context, trust: TrustProxy | null): string | null {
  const socketIp =
    (c.env as { incoming?: { socket?: { remoteAddress?: string | null } } }).incoming?.socket?.remoteAddress ?? '';
  const forwardedFor = c.req.header('x-forwarded-for');
  if (trust) return hashIp(forwardedClientAddress(socketIp, forwardedFor, trust));
  return hashIp(forwardedFor?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? socketIp);
}

function hashIp(ip: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

/** One query param, trimmed and cut to the column length (255) so a
 *  malformed inbound URL with a 10KB utm_source can't blow up the insert.
 *  Empty string → null so the column stays sparse. */
function boundedParam(qs: URLSearchParams, key: string): string | null {
  const raw = qs.get(key);
  if (raw == null) return null;
  const trimmed = raw.trim().slice(0, 255);
  return trimmed.length > 0 ? trimmed : null;
}

/** Pull the standard UTM params off a URLSearchParams (see boundedParam). */
function extractUtm(qs: URLSearchParams): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
} {
  return {
    source: boundedParam(qs, 'utm_source'),
    medium: boundedParam(qs, 'utm_medium'),
    campaign: boundedParam(qs, 'utm_campaign'),
    term: boundedParam(qs, 'utm_term'),
    content: boundedParam(qs, 'utm_content'),
  };
}
