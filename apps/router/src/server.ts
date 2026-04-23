import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import 'dotenv/config';

const app = new Hono();
const PORT = Number(process.env.ROUTER_PORT ?? 4000);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? 'localhost';

app.get('/health', (c) => c.json({ ok: true, service: 'router' }));

// Click router: /r/:linkKey → resolve → set first-party cookie → 302
// Stub: resolution against DB + Click row insert happens in Phase 1 build.
app.get('/r/:linkKey', async (c) => {
  const linkKey = c.req.param('linkKey');
  const clickId = ulid();

  // TODO(phase-1): resolve linkKey → { partnerId, campaignId, destinationUrl }
  // TODO(phase-1): insert Click row with { clickId, partnerId, campaignId, ip, ua, referer, ts }
  // TODO(phase-1): set cookie _cref=clickId scoped to COOKIE_DOMAIN

  const destination = new URL('https://example.com/landing');
  destination.searchParams.set('cref', clickId);

  c.header(
    'Set-Cookie',
    `_cref=${clickId}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=7776000; SameSite=Lax`,
  );

  return c.redirect(destination.toString(), 302);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[router] listening on :${info.port}`);
});
