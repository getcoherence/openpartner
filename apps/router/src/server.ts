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

const db = createDb({ connectionString: process.env.DATABASE_URL! });

app.get('/health', (c) => c.json({ ok: true, service: 'router' }));

// Click router. Two URL shapes depending on tenancy:
//   /r/:slug/:linkKey  — multi-tenant, slug disambiguates per-tenant
//                        unique linkKeys. The shared share-URL format
//                        Network's deriveShareUrl produces.
//   /r/:linkKey        — single-tenant fallback. linkKey is globally
//                        unique here, so no slug needed. Self-host
//                        deployments use this.
//
// Both resolve → insert Click → set first-party cookie → 302.
app.get('/r/:slug/:linkKey', async (c) => {
  const { slug, linkKey } = c.req.param();
  const tenant = (await db('Tenant').where({ slug, status: 'active' }).first(['id'])) as
    | { id: string }
    | undefined;
  if (!tenant) return c.text('Tenant not found', 404);
  const link = await db<LinkRow>(TABLES.Link).where({ tenantId: tenant.id, linkKey }).first();
  return resolveLink(c, link);
});

app.get('/r/:linkKey', async (c) => {
  const linkKey = c.req.param('linkKey');
  const link = await db<LinkRow>(TABLES.Link).where({ linkKey }).first();
  return resolveLink(c, link);
});

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

  await db(TABLES.Click).insert({
    id: clickId,
    linkId: link.id,
    partnerId: link.partnerId,
    programId: link.programId,
    landingUrl: destination.toString(),
    ipHash,
    userAgent: c.req.header('user-agent') ?? null,
    referer: c.req.header('referer') ?? null,
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[router] listening on :${info.port}`);
});
