import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { createDb, TABLES, type LinkRow } from '@openpartner/db';
import { checkVelocity } from './velocity.js';
import 'dotenv/config';

const app = new Hono();
const PORT = Number(process.env.ROUTER_PORT ?? 4000);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? 'localhost';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

const db = createDb({ connectionString: process.env.DATABASE_URL! });

app.get('/health', (c) => c.json({ ok: true, service: 'router' }));

// Click router: /r/:linkKey → resolve → insert Click → set first-party cookie → 302.
app.get('/r/:linkKey', async (c) => {
  const linkKey = c.req.param('linkKey');

  const link = await db<LinkRow>(TABLES.Link).where({ linkKey }).first();
  if (!link) {
    return c.text('Link not found', 404);
  }

  const clickId = ulid();
  const destination = new URL(link.destinationUrl);
  destination.searchParams.set('cref', clickId);

  const ipHash = hashIp(
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? '',
  );

  const velocityFlagged = checkVelocity(ipHash, linkKey);

  await db(TABLES.Click).insert({
    id: clickId,
    linkId: link.id,
    partnerId: link.partnerId,
    campaignId: link.campaignId,
    landingUrl: destination.toString(),
    ipHash,
    userAgent: c.req.header('user-agent') ?? null,
    referer: c.req.header('referer') ?? null,
    fraudFlag: velocityFlagged ? 'velocity' : null,
  });

  c.header(
    'Set-Cookie',
    `_cref=${clickId}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`,
  );

  return c.redirect(destination.toString(), 302);
});

function hashIp(ip: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[router] listening on :${info.port}`);
});
