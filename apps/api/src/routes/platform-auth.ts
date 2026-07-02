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
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type PlatformSessionRow, type TenantRow } from '@openpartner/db';
import { db, appDb } from '../db.js';
import { consumeMagicLink, createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth-sessions.js';
import { RESERVED_SLUGS, getTenancyMode } from '../tenancy.js';
import { newTrialEnd } from '../billing-plan.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { autoEnrollBrandOnNetwork } from './signup.js';
import {
  attachSessionToBundle,
  createPlatformBundle,
  createPlatformSession,
  findPlatformSessionById,
  listBundleSessions,
  PLATFORM_BUNDLE_COOKIE,
  PLATFORM_SESSION_COOKIE,
  platformBundleCookieOptions,
  platformSessionCookieOptions,
  platformSessionTokenHash,
  resolveBundle,
  resolvePlatformSession,
  revokePlatformSession,
  rotatePlatformSessionToken,
  touchBundle,
} from '../platform-sessions.js';

export const platformAuthRouter = Router();

const verifySchema = z.object({ token: z.string().min(8) });

function readBundleCookie(req: Request): string | null {
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[PLATFORM_BUNDLE_COOKIE];
  return cookie ?? null;
}

// -------- Verify the platform magic-link token --------

platformAuthRouter.post('/auth/platform-verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(db, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;

  if (
    (token.purpose !== 'platform_signin' && token.purpose !== 'platform_add_account') ||
    token.principalKind !== 'platform'
  ) {
    return res.status(400).json({ error: 'wrong_token_kind' });
  }

  // The token's principalId is the email; use it as the canonical identity.
  const email = (token.email || token.principalId).toLowerCase();
  const isAddIntent = token.purpose === 'platform_add_account';

  const session = await createPlatformSession(db, email);

  // Bundle resolution. Two intents → two policies:
  //
  //   platform_add_account: always attach to existing bundle (or create
  //                         one if there isn't one). This is the explicit
  //                         "stack another identity" path from the sidebar
  //                         switcher.
  //
  //   platform_signin:      attach if the email already belongs to the
  //                         bundle (re-sign-in as same identity). Otherwise
  //                         REPLACE — revoke prior bundle sessions and
  //                         create a fresh bundle for this identity.
  //                         Prevents a second person at the same device
  //                         from silently inheriting the previous user's
  //                         stacked accounts.
  const existingBundleId = readBundleCookie(req);
  const existingBundle = await resolveBundle(db, existingBundleId);

  let bundleId: string;
  let bundleCookieChanged = false;
  if (existingBundle) {
    if (isAddIntent) {
      bundleId = existingBundle.id;
    } else {
      const bundleHasThisEmail = await db<PlatformSessionRow>(TABLES.PlatformSession)
        .where({ bundleId: existingBundle.id, email })
        .whereNull('revokedAt')
        .first();
      if (bundleHasThisEmail) {
        bundleId = existingBundle.id;
      } else {
        // Different-email fresh sign-in. Revoke the prior bundle's
        // sessions (best-effort — bundle row stays for audit; cookie
        // gets repointed at a brand-new bundle).
        const priorSessions = await db<PlatformSessionRow>(TABLES.PlatformSession)
          .where({ bundleId: existingBundle.id })
          .whereNull('revokedAt');
        if (priorSessions.length > 0) {
          await db<PlatformSessionRow>(TABLES.PlatformSession)
            .whereIn('id', priorSessions.map((s) => s.id))
            .update({ revokedAt: new Date() });
        }
        bundleId = await createPlatformBundle(db);
        bundleCookieChanged = true;
      }
    }
  } else {
    bundleId = await createPlatformBundle(db);
    bundleCookieChanged = true;
  }

  const created = await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ tokenHash: platformSessionTokenHash(session.plaintext) })
    .first();
  if (created) {
    await attachSessionToBundle(db, created.id, bundleId);
  }

  res.cookie(PLATFORM_SESSION_COOKIE, session.plaintext, platformSessionCookieOptions());
  if (bundleCookieChanged) {
    res.cookie(PLATFORM_BUNDLE_COOKIE, bundleId, platformBundleCookieOptions());
  }

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

// -------- Create another brand under this platform identity (§13) --------

const addBrandSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumerics or hyphens'),
  displayName: z.string().trim().min(1).max(120),
  /** REQUIRED — every brand is its own independently-billed tenant, so the
   *  flow forces a plan choice up front (§13.3c). Enterprise is sales-led
   *  and deliberately not self-serve: `hasActivePlan()` trusts it without
   *  a Stripe subscription, so accepting it here would let anyone
   *  self-declare past the plan-required gate. */
  plan: z.enum(['flex', 'revshare']),
});

class AddBrandError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const addBrandLimit = ipRateLimit({ name: 'add-brand', max: 10, windowMs: 60_000 });

/**
 * Authenticated add-brand. Replaces the old switcher link to the PUBLIC
 * /signup form, which re-asked for an email and orphaned the new brand from
 * the switcher whenever the typed email differed from the platform-session
 * email (/me/workspaces filters by email). Here the first Admin is ALWAYS
 * the platform identity — mismatch impossible — and the Admin is created
 * activated (the platform session already proved control of the inbox), so
 * the brand appears in the switcher and is enterable immediately.
 */
platformAuthRouter.post('/me/brands', addBrandLimit, async (req, res) => {
  if (getTenancyMode() !== 'multi') {
    return res.status(400).json({ error: 'not_available_in_single_tenant' });
  }
  const cookie = readPlatformCookie(req);
  if (!cookie) return res.status(401).json({ error: 'no_platform_session' });
  const platform = await resolvePlatformSession(db, cookie);
  if (!platform) return res.status(401).json({ error: 'invalid_or_expired_session' });

  const body = addBrandSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const slug = body.data.slug.toLowerCase();
  if (RESERVED_SLUGS.has(slug)) return res.status(409).json({ error: 'slug_reserved' });

  const email = platform.email;
  // Reuse the person's display name from any brand they already admin;
  // fall back to the mailbox name.
  const prior = await db<AdminRow>(TABLES.Admin)
    .where({ email })
    .orderBy('createdAt', 'desc')
    .first(['name']);
  const adminName = prior?.name ?? email.split('@')[0]!;

  const tenantId = ulid();
  const adminId = ulid();
  const now = new Date();
  try {
    await db.transaction(async (trx) => {
      const existing = await trx<TenantRow>(TABLES.Tenant).where({ slug }).first(['id']);
      if (existing) throw new AddBrandError('slug_taken');
      await trx<TenantRow>(TABLES.Tenant).insert({
        id: tenantId,
        slug,
        displayName: body.data.displayName,
        status: 'active',
        billingPlan: body.data.plan as TenantRow['billingPlan'],
        // Same evaluation-window semantics as public signup: the trial
        // starts now, and firstTrialActivatedAt prevents a second trial
        // via post-trial Checkout.
        trialEndsAt: newTrialEnd(),
        firstTrialActivatedAt: now,
        metadata: { createdBy: 'add_brand', createdByEmail: email } as unknown as never,
      });
      await trx<AdminRow>(TABLES.Admin).insert({
        id: adminId,
        tenantId,
        email,
        name: adminName,
        activatedAt: now,
      });
    });
  } catch (err) {
    if (err instanceof AddBrandError) return res.status(409).json({ error: err.code });
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'slug_taken' });
    }
    throw err;
  }

  const network = await autoEnrollBrandOnNetwork({
    tenantId,
    slug,
    displayName: body.data.displayName,
    contactEmail: email,
    contactName: adminName,
    protoHost: `${req.protocol}://${req.get('host') ?? ''}`,
  });

  res.status(201).json({
    ok: true,
    tenant: { id: tenantId, slug },
    home: `/t/${slug}/`,
    // The brand has a plan CHOICE but not yet a subscription — the SPA
    // routes to billing checkout next. Partner onboarding stays 402-gated
    // (plan-required backstop) until checkout completes.
    checkoutRequired: true,
    network,
  });
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

// -------- Multi-identity: list bundle, switch, remove --------

/** List identities (sibling platform sessions) in the active bundle.
 *  The "active" session is whichever one the current op_platform_session
 *  cookie points at; included with isActive=true so the UI can highlight
 *  it. Returns empty when there's no bundle cookie (legacy sessions). */
platformAuthRouter.get('/me/identities', async (req, res) => {
  const bundleId = readBundleCookie(req);
  const bundle = await resolveBundle(db, bundleId);
  if (!bundle) return res.json({ bundleId: null, identities: [] });

  // The active session = whatever the current platform-session cookie
  // resolves to AND is a member of this bundle. Mismatch (cookie points
  // at a session that doesn't belong to this bundle id) is treated as
  // "no active session" — the bundle is the source of truth.
  const currentCookie = readPlatformCookie(req);
  const current = currentCookie ? await resolvePlatformSession(db, currentCookie) : null;
  const currentInBundle = current?.bundleId === bundle.id ? current : null;

  const sessions = await listBundleSessions(db, bundle.id);
  await touchBundle(db, bundle.id);

  res.json({
    bundleId: bundle.id,
    identities: sessions.map((s) => ({
      sessionId: s.id,
      email: s.email,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      isActive: s.id === currentInBundle?.id,
    })),
  });
});

const switchSchema = z.object({ sessionId: z.string().min(8) });

/** Switch the active identity within a bundle. Rotates the target session's
 *  token, sets it as the new op_platform_session cookie, also clears the
 *  per-tenant op_session cookie so the SPA lands back at /workspaces and
 *  the user picks which brand to enter as this identity. */
platformAuthRouter.post('/identities/switch', async (req, res) => {
  const body = switchSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });

  const bundleId = readBundleCookie(req);
  const bundle = await resolveBundle(db, bundleId);
  if (!bundle) return res.status(401).json({ error: 'no_bundle' });

  const target = await findPlatformSessionById(db, body.data.sessionId);
  if (!target || target.bundleId !== bundle.id) {
    return res.status(404).json({ error: 'session_not_in_bundle' });
  }
  if (target.revokedAt) return res.status(401).json({ error: 'session_revoked' });
  if (target.expiresAt <= new Date()) return res.status(401).json({ error: 'session_expired' });

  const rotated = await rotatePlatformSessionToken(db, target.id);
  await touchBundle(db, bundle.id);

  res.cookie(PLATFORM_SESSION_COOKIE, rotated.plaintext, platformSessionCookieOptions());
  // Tenant cookie belongs to the previous identity — clear so the SPA
  // routes through /workspaces and picks a brand for the new identity.
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
  res.json({ ok: true, email: target.email, sessionId: target.id });
});

/** Remove an identity from the bundle. Revokes the session row. If the
 *  removed session was the active one, falls through to the next-most-
 *  recently-used session in the bundle (rotates + sets cookie); if the
 *  bundle is now empty, clears both cookies. */
platformAuthRouter.delete('/identities/:sessionId', async (req, res) => {
  const bundleId = readBundleCookie(req);
  const bundle = await resolveBundle(db, bundleId);
  if (!bundle) return res.status(401).json({ error: 'no_bundle' });

  const target = await findPlatformSessionById(db, req.params.sessionId);
  if (!target || target.bundleId !== bundle.id) {
    return res.status(404).json({ error: 'session_not_in_bundle' });
  }

  const currentCookie = readPlatformCookie(req);
  const current = currentCookie ? await resolvePlatformSession(db, currentCookie) : null;
  const wasActive = current?.id === target.id;

  await revokeSessionRow(target.id);

  if (!wasActive) {
    return res.json({ ok: true, removed: target.id, fellThroughTo: null });
  }

  // Removed the active session — find a sibling to promote.
  const siblings = await listBundleSessions(db, bundle.id);
  const next = siblings[siblings.length - 1] ?? null;
  if (!next) {
    res.clearCookie(PLATFORM_SESSION_COOKIE, platformSessionCookieOptions());
    res.clearCookie(PLATFORM_BUNDLE_COOKIE, platformBundleCookieOptions());
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
    return res.json({ ok: true, removed: target.id, fellThroughTo: null });
  }
  const rotated = await rotatePlatformSessionToken(db, next.id);
  await touchBundle(db, bundle.id);
  res.cookie(PLATFORM_SESSION_COOKIE, rotated.plaintext, platformSessionCookieOptions());
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
  res.json({ ok: true, removed: target.id, fellThroughTo: next.id });
});

/** Helper: revoke a single session row without needing its plaintext. */
async function revokeSessionRow(sessionId: string): Promise<void> {
  await db<PlatformSessionRow>(TABLES.PlatformSession)
    .where({ id: sessionId })
    .update({ revokedAt: new Date() });
}

// -------- Sign out the platform identity --------

const signoutSchema = z.object({ all: z.boolean().optional() }).optional();

platformAuthRouter.post('/auth/platform-signout', async (req, res) => {
  const body = signoutSchema.safeParse(req.body) as { success: true; data?: { all?: boolean } } | { success: false };
  const all = body.success && body.data?.all === true;

  const cookie = readPlatformCookie(req);
  const current = cookie ? await resolvePlatformSession(db, cookie) : null;
  const bundleId = readBundleCookie(req);
  const bundle = await resolveBundle(db, bundleId);

  if (all && bundle) {
    // Sign out every identity in the bundle. Revoke all rows + drop both
    // cookies.
    const sessions = await listBundleSessions(db, bundle.id);
    if (sessions.length > 0) {
      await db<PlatformSessionRow>(TABLES.PlatformSession)
        .whereIn('id', sessions.map((s) => s.id))
        .update({ revokedAt: new Date() });
    }
    res.clearCookie(PLATFORM_SESSION_COOKIE, platformSessionCookieOptions());
    res.clearCookie(PLATFORM_BUNDLE_COOKIE, platformBundleCookieOptions());
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
    return res.json({ ok: true, signedOutAll: true });
  }

  // Default: sign out just the active identity. Fall through to the next
  // bundled identity if any so "sign out" doesn't dump the user to the
  // login page when they have other accounts stacked.
  if (cookie) await revokePlatformSession(db, cookie);

  if (bundle && current) {
    const remaining = (await listBundleSessions(db, bundle.id)).filter((s) => s.id !== current.id);
    const next = remaining[remaining.length - 1];
    if (next) {
      const rotated = await rotatePlatformSessionToken(db, next.id);
      await touchBundle(db, bundle.id);
      res.cookie(PLATFORM_SESSION_COOKIE, rotated.plaintext, platformSessionCookieOptions());
      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
      return res.json({ ok: true, fellThroughTo: next.id, email: next.email });
    }
  }

  // No bundle or no fall-through — clear everything.
  res.clearCookie(PLATFORM_SESSION_COOKIE, platformSessionCookieOptions());
  res.clearCookie(PLATFORM_BUNDLE_COOKIE, platformBundleCookieOptions());
  res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
  res.json({ ok: true });
});
