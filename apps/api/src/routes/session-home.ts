/**
 * Where does the current session belong?
 *
 * Used by the public Landing on app.openpartner.dev to auto-redirect
 * already-signed-in visitors into their portal instead of dumping them
 * on the marketing page. Reads the op_session cookie, resolves the
 * session through the privileged db (no tenant context needed since
 * sessions table carries tenantId on the row), and returns the home
 * path the SPA should navigate to.
 *
 * Public — no auth gate. Returns 200 + `{ home: null }` for anonymous
 * visitors so the Landing can render normally without a 401 in devtools.
 */

import { Router } from 'express';
import { TABLES, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { resolveSession, SESSION_COOKIE_NAME } from '../auth-sessions.js';
import { PLATFORM_SESSION_COOKIE, resolvePlatformSession } from '../platform-sessions.js';

export const sessionHomeRouter = Router();

sessionHomeRouter.get('/session/home', async (req, res) => {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};

  // Tenant session takes precedence — they've already picked a workspace.
  const tenantCookie = cookies[SESSION_COOKIE_NAME];
  if (tenantCookie) {
    const session = await resolveSession(db, tenantCookie);
    if (session) {
      const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: session.tenantId, status: 'active' }).first();
      if (tenant) {
        return res.json({
          home: `/t/${tenant.slug}/`,
          kind: session.principalKind,
          tenantSlug: tenant.slug,
        });
      }
    }
  }

  // Platform session = identity verified, no workspace picked yet.
  const platformCookie = cookies[PLATFORM_SESSION_COOKIE];
  if (platformCookie) {
    const platform = await resolvePlatformSession(db, platformCookie);
    if (platform) {
      return res.json({ home: '/workspaces', kind: 'platform', email: platform.email });
    }
  }

  res.json({ home: null });
});
