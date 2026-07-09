import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { createDb, TABLES, type LinkRow } from '@openpartner/db';
import { checkIpCap, checkVelocity } from './velocity.js';
import './env.js';

const app = new Hono();
const PORT = Number(process.env.ROUTER_PORT ?? 4701);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? 'localhost';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

const db = await createDb({ connectionString: process.env.DATABASE_URL! });

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
// All resolve → insert Click → set first-party cookie → 302.
async function handleSlugKey(c: Context): Promise<Response> {
  const { slug, linkKey } = c.req.param() as { slug: string; linkKey: string };
  const tenant = (await db('Tenant').where({ slug, status: 'active' }).first(['id'])) as
    | { id: string }
    | undefined;
  if (!tenant) return c.text('Tenant not found', 404);
  const link = await db<LinkRow>(TABLES.Link).where({ tenantId: tenant.id, linkKey }).first();
  return resolveLink(c, link);
}

async function handleKeyOnly(c: Context): Promise<Response> {
  const linkKey = c.req.param('linkKey');
  // White-label custom domain: the Host header names the tenant, so scope
  // the lookup — two tenants may use the same key. Falls through to the
  // global lookup for single-tenant installs (and any host we don't know).
  const host = (c.req.header('host') ?? '').split(':')[0]!.toLowerCase().trim();
  if (host) {
    const tenant = (await db('Tenant')
      .where({ customDomain: host, status: 'active' })
      .first(['id'])) as { id: string } | undefined;
    if (tenant) {
      const link = await db<LinkRow>(TABLES.Link)
        .where({ tenantId: tenant.id, linkKey })
        .first();
      return resolveLink(c, link);
    }
  }
  const link = await db<LinkRow>(TABLES.Link).where({ linkKey }).first();
  return resolveLink(c, link);
}

app.get('/r/:slug/:linkKey', handleSlugKey);
app.get('/r/:linkKey', handleKeyOnly);
// Prefix-stripped variants (DO ingress). Registered after /health, and
// Hono prefers static routes over params, so /health stays unaffected.
app.get('/:slug/:linkKey', handleSlugKey);
app.get('/:linkKey', handleKeyOnly);

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

  // Destination resolution: per-Link override (deep link) wins; otherwise
  // inherit from the Campaign. This is the source-of-truth flip — brands
  // own the destination via Campaign.destinationUrl, partners only get
  // an override when the Campaign explicitly allows deep-linking.
  let destinationUrl = link.destinationUrl;
  if (!destinationUrl) {
    const campaign = (await db('Campaign').where({ id: link.programId }).first()) as
      | { destinationUrl: string }
      | undefined;
    if (!campaign) return c.text('Campaign not found', 410);
    destinationUrl = campaign.destinationUrl;
  }

  const clickId = ulid();
  const destination = new URL(destinationUrl);
  destination.searchParams.set('cref', clickId);

  // Prefer proxy headers when they're present (we run behind Caddy /
  // DO's edge), but fall back to the node socket so an attacker who
  // reaches the router directly and omits headers doesn't land on
  // ipHash=null and bypass the cap.
  const socketIp =
    (c.env as { incoming?: { socket?: { remoteAddress?: string | null } } }).incoming?.socket
      ?.remoteAddress ?? '';
  const ipHash = hashIp(
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      socketIp,
  );

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
  // destination has cref appended by us and otherwise inherits from the
  // campaign, so partners can't put UTMs there). Read-only, all 5
  // standard params for export fidelity even though we only break down
  // on source/medium/campaign in the analytics UI today.
  const inbound = new URL(c.req.url, 'http://placeholder');
  const utm = extractUtm(inbound.searchParams);
  // Cloudflare populates cf-ipcountry on every request when the router
  // sits behind their proxy. Free on every CF plan; null when the
  // router is hit directly (dev, self-host without CF in front).
  const country = (c.req.header('cf-ipcountry') ?? '').toLowerCase().slice(0, 2) || null;

  await db(TABLES.Click).insert({
    id: clickId,
    linkId: link.id,
    partnerId: link.partnerId,
    programId: link.programId,
    landingUrl: destination.toString(),
    ipHash,
    userAgent: c.req.header('user-agent') ?? null,
    referer: c.req.header('referer') ?? null,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    utmTerm: utm.term,
    utmContent: utm.content,
    country,
    fraudFlag,
  });

  c.header(
    'Set-Cookie',
    `_cref=${clickId}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`,
  );

  return c.redirect(destination.toString(), 302);
}

function hashIp(ip: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

/** Pull the standard UTM params off a URLSearchParams. Trims +
 *  truncates to the column length (255) so a malformed inbound URL
 *  with a 10KB utm_source can't blow up the insert. Empty string →
 *  null so the column stays sparse. */
function extractUtm(qs: URLSearchParams): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
} {
  const get = (k: string): string | null => {
    const raw = qs.get(k);
    if (raw == null) return null;
    const trimmed = raw.trim().slice(0, 255);
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    source: get('utm_source'),
    medium: get('utm_medium'),
    campaign: get('utm_campaign'),
    term: get('utm_term'),
    content: get('utm_content'),
  };
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[router] listening on :${info.port}`);
});
