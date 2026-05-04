/**
 * Platform-identity auth: verify the unified-signin magic link, list
 * the user's workspaces, and exchange the platform session for a
 * tenant-scoped one.
 *
 * Routes here all run BEFORE tenantMiddleware (no /t/<slug>/ prefix in
 * URLs), so they reach for the privileged `db` directly. Tenant-scoped
 * follow-on writes (creating the per-workspace Session) open their own
 * transaction with `app.tenant_id` set.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
import { db, appDb } from '../db.js';
import { consumeMagicLink, createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth-sessions.js';
import {
  createPlatformSession,
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  resolvePlatformSession,
  revokePlatformSession,
} from '../platform-sessions.js';

export const platformAuthRouter = Router();

const verifySchema = z.object({ token: z.string().min(8) });

// -------- Verify the platform magic-link token --------

platformAuthRouter.post('/auth/platform-verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(db, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;

  if (token.purpose !== 'platform_signin' || token.principalKind !== 'platform') {
    return res.status(400).json({ error: 'wrong_token_kind' });
  }

  // The token's principalId is the email; use it as the canonical identity.
  const email = (token.email || token.principalId).toLowerCase();

  const session = await createPlatformSession(db, email);
  res.cookie(PLATFORM_SESSION_COOKIE, session.plaintext, platformSessionCookieOptions());

  res.json({ ok: true, kind: 'platform', email });
});

// -------- List workspaces the platform-identity owns --------

interface Workspace {
  tenantSlug: string;
  tenantDisplayName: string;
  adminId: string;
  activated: boolean;
}

function readPlatformCookie(req: Request): string | null {
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[PLATFORM_SESSION_COOKIE];
  return cookie ?? null;
}

platformAuthRouter.get('/me/workspaces', async (req, res) => {
  const cookie = readPlatformCookie(req);
  if (!cookie) return res.status(401).json({ error: 'no_platform_session' });

  const session = await resolvePlatformSession(db, cookie);
  if (!session) return res.status(401).json({ error: 'invalid_or_expired_session' });

  const rows = (await db(TABLES.Admin)
    .join(TABLES.Tenant, `${TABLES.Tenant}.id`, `${TABLES.Admin}.tenantId`)
    .where(`${TABLES.Admin}.email`, session.email)
    .whereNull(`${TABLES.Admin}.revokedAt`)
    .andWhere(`${TABLES.Tenant}.status`, 'active')
    .select(
      `${TABLES.Tenant}.slug as tenantSlug`,
      `${TABLES.Tenant}.displayName as tenantDisplayName`,
      `${TABLES.Admin}.id as adminId`,
      `${TABLES.Admin}.activatedAt as activatedAt`,
    )) as Array<{ tenantSlug: string; tenantDisplayName: string; adminId: string; activatedAt: Date | null }>;

  const workspaces: Workspace[] = rows.map((r) => ({
    tenantSlug: r.tenantSlug,
    tenantDisplayName: r.tenantDisplayName,
    adminId: r.adminId,
    activated: !!r.activatedAt,
  }));

  res.json({ email: session.email, workspaces });
});

// -------- Enter a workspace: trade platform session for a tenant Session --------

const enterSchema = z.object({ slug: z.string().trim().min(1) });

platformAuthRouter.post('/workspaces/enter', async (req, res) => {
  const body = enterSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });

  const cookie = readPlatformCookie(req);
  if (!cookie) return res.status(401).json({ error: 'no_platform_session' });
  const platform = await resolvePlatformSession(db, cookie);
  if (!platform) return res.status(401).json({ error: 'invalid_or_expired_session' });

  const tenant = await db<TenantRow>(TABLES.Tenant).where({ slug: body.data.slug, status: 'active' }).first();
  if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });

  const admin = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId: tenant.id, email: platform.email })
    .whereNull('revokedAt')
    .first();
  if (!admin) return res.status(403).json({ error: 'not_a_member' });

  // Activate on first entry — the platform-signin link doubles as
  // activation if signup's invite email never landed. Aligns with the
  // recovery path in /signin.
  if (!admin.activatedAt) {
    await db<AdminRow>(TABLES.Admin)
      .where({ id: admin.id })
      .update({ activatedAt: new Date(), updatedAt: new Date() });
  }
  await db<AdminRow>(TABLES.Admin).where({ id: admin.id }).update({ lastSignInAt: new Date() });

  // Per-tenant Session insert needs to run with app.tenant_id set so RLS
  // (when enabled) accepts the write. Use the appDb pool.
  const trx = await appDb.transaction();
  let sessionPlaintext: string;
  try {
    await trx.raw(`set local app.tenant_id = '${tenant.id.replace(/'/g, "''")}'`);
    const created = await createSession(trx, { tenantId: tenant.id, principalKind: 'admin', principalId: admin.id });
    sessionPlaintext = created.plaintext;
    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }

  res.cookie(SESSION_COOKIE_NAME, sessionPlaintext, sessionCookieOptions());
  res.json({ ok: true, tenantSlug: tenant.slug, home: `/t/${tenant.slug}/` });
});

// -------- Sign out the platform identity --------

platformAuthRouter.post('/auth/platform-signout', async (req, res) => {
  const cookie = readPlatformCookie(req);
  if (cookie) await revokePlatformSession(db, cookie);
  // Mirror cookie attributes from set-time so the browser actually
  // clears it. See partner-auth's /auth/signout for the same fix
  // and the underlying Express clearCookie behavior.
  res.clearCookie(PLATFORM_SESSION_COOKIE, platformSessionCookieOptions());
  res.json({ ok: true });
});
