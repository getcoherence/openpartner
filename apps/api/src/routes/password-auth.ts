/**
 * Email + password sign-in, "forgot password", and changing a password
 * while signed in. A correct password earns the same single-use token the
 * sign-in email would carry ({ token } in the response); the SPA redeems it
 * at the existing verify endpoint (signin-handoff.ts). Emailed links keep
 * working alongside.
 *
 * Two routers:
 *
 *   passwordPlatformRouter — mounted before tenantMiddleware, privileged pool.
 *     POST /signin/password   brand admin → platform identity (multi-tenant)
 *     POST /password/forgot   mail a reset link for the platform password
 *     POST /password/reset    redeem it (both tenancy modes: single-tenant
 *                             admins' resets land here too)
 *     GET|PUT /me/password    set / change it with a platform session
 *
 *   passwordTenantRouter — tenant scope (/t/<slug>/…, custom domain, or
 *   single-tenant root).
 *     POST /auth/signin/password   admin or partner of this brand
 *     POST /auth/password/forgot
 *     POST /auth/password/reset    partner resets
 *     GET|PUT /auth/password       set / change with a session cookie
 *
 * Whose password is it? A brand admin's or operator's belongs to the email
 * (PasswordCredential 'platform') — one password for every brand they admin
 * and the ops console, so it is only ever set through platform-mailed links
 * or platform sessions. A partner's belongs to that one brand ('partner'),
 * so a brand's own mail provider, which carries its partners' reset links,
 * can't touch a credential any other brand accepts.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type PartnerRow } from '@openpartner/db';
import { db as platformDb } from '../db.js';
import { consumeMagicLink, issueMagicLink } from '../auth-sessions.js';
import { requireAuth } from '../auth.js';
import { getMailer } from '../mailer.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { passwordResetEmail } from '../email-templates.js';
import { getPortalBaseUrl, linkTenantOf } from '../portal-url.js';
import { getTenancyMode, tenantOf } from '../tenancy.js';
import { requireServedCountry } from '../country-access.js';
import { isPendingReview } from '../partner-review.js';
import { PLATFORM_SESSION_COOKIE, resolvePlatformSession } from '../platform-sessions.js';
import {
  checkPassword,
  type CredentialKey,
  failureKey,
  hasPassword,
  partnerCredential,
  passwordFailures,
  passwordSchema,
  platformCredential,
  resetMailLimit,
  setPassword,
  signOutIdentityEverywhere,
} from '../passwords.js';
import { platformSigninToken, tenantSigninCandidates, tenantSigninToken, type TenantSigninPrincipal } from '../signin-handoff.js';
import { isAllowedOperator } from './platform-admin.js';

export const passwordPlatformRouter = Router();
export const passwordTenantRouter = Router();

const signinLimit = ipRateLimit({ name: 'password-signin', max: 20, windowMs: 60_000 });
const forgotLimit = ipRateLimit({ name: 'password-forgot', max: 10, windowMs: 60_000 });
const resetLimit = ipRateLimit({ name: 'password-reset', max: 30, windowMs: 60_000 });

const email = z.string().trim().email().max(254);
const signinSchema = z.object({
  email,
  // Sign-in checks whatever was typed; only setting a password enforces
  // the length rules (an old password must keep working if they change).
  password: z.string().min(1).max(200),
  /** "Add another account" from the identity switcher — see /signin. */
  add: z.boolean().optional(),
});
const forgotSchema = z.object({
  email,
  /** Asked from the ops console's sign-in page: the link lands there. */
  context: z.enum(['ops']).optional(),
});
const resetSchema = z.object({ token: z.string().min(8), password: passwordSchema });
const changeSchema = z.object({ currentPassword: z.string().max(200).optional(), password: passwordSchema });

/**
 * Change or first-time set. With a password already set, the current one is
 * required: whoever holds a session but not the password can't replace it
 * (a borrowed laptop, a link read off a mail provider's logs). Without one,
 * the session itself — minted from a link to this inbox, Google, or the
 * password — is the proof, same as "forgot password" would be.
 */
async function changePassword(
  key: CredentialKey,
  scope: string,
  address: string,
  body: z.infer<typeof changeSchema>,
): Promise<{ status: number; error: string } | null> {
  if (await hasPassword(platformDb, key)) {
    const failures = failureKey(scope, address);
    if (passwordFailures.blocked(failures)) return { status: 429, error: 'too_many_attempts' };
    if (!body.currentPassword || !(await checkPassword(platformDb, key, body.currentPassword))) {
      passwordFailures.hit(failures);
      return { status: 403, error: 'current_password_incorrect' };
    }
  }
  await setPassword(platformDb, key, body.password);
  return null;
}

/** Mail a platform-password reset link. The caller decided the address is
 *  eligible; this applies the per-address cap. Never throws. */
async function sendPlatformReset(address: string, landing: '/reset-password' | '/platform/reset-password'): Promise<void> {
  if (!resetMailLimit.hit(failureKey('platform', address))) return;
  try {
    const issued = await issueMagicLink(platformDb, {
      tenantId: DEFAULT_TENANT_ID, // placeholder — platform tokens aren't tenant-scoped
      email: address,
      purpose: 'password_reset',
      principalKind: 'platform',
      principalId: address,
    });
    const link = `${getPortalBaseUrl()}${landing}?token=${encodeURIComponent(issued.plaintext)}&scope=account`;
    const { resolveBrandName } = await import('../brand-name.js');
    const tmpl = passwordResetEmail(
      link,
      getTenancyMode() === 'multi' ? null : await resolveBrandName(platformDb, DEFAULT_TENANT_ID),
    );
    // Platform mail context, never a brand's: this password opens every
    // brand the person admins, so no brand's mail provider may carry it.
    // (Single-tenant: that context is the one installation's own mail, in
    // its own voice.)
    await getMailer().send({ db: platformDb, tenantId: DEFAULT_TENANT_ID }, {
      to: address,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'password_reset',
      metadata: { purpose: 'password_reset', email: address, scope: 'platform' },
      platform: getTenancyMode() === 'multi',
    });
  } catch (err) {
    console.error('[password] platform reset mail failed', { email: address, err });
  }
}

function readPlatformCookie(req: Request): string | null {
  return (req as unknown as { cookies?: Record<string, string> }).cookies?.[PLATFORM_SESSION_COOKIE] ?? null;
}

// =====================================================================
// Platform
// =====================================================================

passwordPlatformRouter.post(
  '/signin/password',
  signinLimit,
  requireServedCountry(platformDb, 'signin-password'),
  async (req, res) => {
    if (getTenancyMode() !== 'multi') return res.status(400).json({ error: 'use_per_tenant_signin' });
    const body = signinSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const address = body.data.email.toLowerCase();

    const failures = failureKey('platform', address);
    if (passwordFailures.blocked(failures)) return res.status(429).json({ error: 'too_many_attempts' });
    if (!(await checkPassword(platformDb, platformCredential(address), body.data.password))) {
      passwordFailures.hit(failures);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    passwordFailures.reset(failures);

    // Redeemed at POST /auth/platform-verify, like the emailed link.
    const token = await platformSigninToken(platformDb, address, body.data.add === true);
    res.json({ ok: true, token });
  },
);

passwordPlatformRouter.post('/password/forgot', forgotLimit, async (req, res) => {
  if (getTenancyMode() !== 'multi') return res.status(400).json({ error: 'use_per_tenant_signin' });
  const body = forgotSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_email' });
  const address = body.data.email.toLowerCase();

  // Whoever /signin or the ops console would mail a link to, plus anyone
  // who already has a password. Everyone else: the same 200, no mail.
  const operator = await isAllowedOperator(address);
  const admin = await platformDb<AdminRow>(TABLES.Admin).where({ email: address }).whereNull('revokedAt').first('id');
  if (operator || admin || (await hasPassword(platformDb, platformCredential(address)))) {
    await sendPlatformReset(address, body.data.context === 'ops' && operator ? '/platform/reset-password' : '/reset-password');
  }
  res.json({ ok: true });
});

passwordPlatformRouter.post('/password/reset', resetLimit, async (req, res) => {
  const body = resetSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(platformDb, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;
  if (token.purpose !== 'password_reset' || token.principalKind !== 'platform') {
    return res.status(400).json({ error: 'wrong_token_kind' });
  }

  const address = (token.email || token.principalId).toLowerCase();
  await setPassword(platformDb, platformCredential(address), body.data.password);
  await signOutIdentityEverywhere(platformDb, address);
  passwordFailures.reset(failureKey('platform', address));
  res.json({ ok: true, email: address });
});

passwordPlatformRouter.get('/me/password', async (req, res) => {
  const cookie = readPlatformCookie(req);
  const session = cookie ? await resolvePlatformSession(platformDb, cookie) : null;
  if (!session) return res.status(401).json({ error: 'no_platform_session' });
  res.json({ email: session.email, hasPassword: await hasPassword(platformDb, platformCredential(session.email)) });
});

passwordPlatformRouter.put('/me/password', async (req, res) => {
  const cookie = readPlatformCookie(req);
  const session = cookie ? await resolvePlatformSession(platformDb, cookie) : null;
  if (!session) return res.status(401).json({ error: 'no_platform_session' });
  const body = changeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const failed = await changePassword(platformCredential(session.email), 'platform', session.email, body.data);
  if (failed) return res.status(failed.status).json({ error: failed.error });
  res.json({ ok: true });
});

// =====================================================================
// Tenant
// =====================================================================

passwordTenantRouter.post(
  '/auth/signin/password',
  signinLimit,
  requireServedCountry(platformDb, 'tenant-signin-password'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = signinSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const address = body.data.email.toLowerCase();

    // Admin first, as /auth/signin does — but an admin who has never set a
    // password falls through to a partner row on the same address.
    const candidates = await tenantSigninCandidates(db, tenantId, address);
    let principal: TenantSigninPrincipal | null = null;
    let key: CredentialKey | null = null;
    if (candidates.admin && (await hasPassword(platformDb, platformCredential(address)))) {
      principal = { kind: 'admin', row: candidates.admin };
      key = platformCredential(address);
    } else if (candidates.partner) {
      principal = { kind: 'partner', row: candidates.partner };
      key = partnerCredential(tenantId, candidates.partner.id);
    }

    const failures = failureKey(key?.principalKind === 'platform' ? 'platform' : tenantId, address);
    if (passwordFailures.blocked(failures)) return res.status(429).json({ error: 'too_many_attempts' });
    if (!principal || !(await checkPassword(platformDb, key, body.data.password))) {
      passwordFailures.hit(failures);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    passwordFailures.reset(failures);

    // Redeemed at POST /auth/magic/verify, like the emailed link.
    const token = await tenantSigninToken(db, tenantId, principal);
    res.json({ ok: true, token, role: principal.kind });
  },
);

passwordTenantRouter.post(
  '/auth/password/forgot',
  forgotLimit,
  requireServedCountry(platformDb, 'tenant-password-forgot'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = forgotSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_email' });
    const address = body.data.email.toLowerCase();

    // Same people /auth/signin mails, same silent 200 for everyone else.
    const candidates = await tenantSigninCandidates(db, tenantId, address);
    if (candidates.admin) {
      // An admin's password is the platform one; its link goes out as
      // platform mail and lands on the platform origin.
      await sendPlatformReset(address, '/reset-password');
    } else if (candidates.partner && resetMailLimit.hit(failureKey(tenantId, address))) {
      const partner = candidates.partner;
      try {
        const issued = await issueMagicLink(db, {
          tenantId,
          email: address,
          purpose: 'password_reset',
          principalKind: 'partner',
          principalId: partner.id,
        });
        const link = `${getPortalBaseUrl(linkTenantOf(req))}/reset-password?token=${encodeURIComponent(issued.plaintext)}`;
        const { resolveBrandName } = await import('../brand-name.js');
        const tmpl = passwordResetEmail(link, await resolveBrandName(db, tenantId));
        await getMailer().send({ db, tenantId }, {
          to: address,
          subject: tmpl.subject,
          text: tmpl.text,
          html: tmpl.html,
          tag: 'password_reset',
          metadata: { purpose: 'password_reset', partnerId: partner.id },
        });
      } catch (err) {
        console.error('[password] partner reset mail failed', { tenantId, partnerId: partner.id, err });
      }
    }
    res.json({ ok: true });
  },
);

passwordTenantRouter.post('/auth/password/reset', resetLimit, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = resetSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(db, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;
  // Only this brand's links (RLS hides others' from req.db; a pool that
  // bypasses RLS would not).
  if (token.tenantId !== tenantId) return res.status(400).json({ error: 'invalid_or_expired_token' });
  if (token.purpose !== 'password_reset' || token.principalKind !== 'partner') {
    return res.status(400).json({ error: 'wrong_token_kind' });
  }

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: token.principalId, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  if (partner.revokedAt) return res.status(403).json({ error: 'partner_revoked' });
  if (isPendingReview(partner)) return res.status(403).json({ error: 'pending_review' });
  if (!partner.portalAccess) return res.status(403).json({ error: 'portal_access_disabled' });

  await setPassword(platformDb, partnerCredential(tenantId, partner.id), body.data.password);
  // Sessions from before the reset end with it.
  await db(TABLES.Session)
    .where({ tenantId, principalKind: 'partner', principalId: partner.id })
    .whereNull('revokedAt')
    .update({ revokedAt: new Date() });
  passwordFailures.reset(failureKey(tenantId, partner.email));
  res.json({ ok: true, email: partner.email });
});

/**
 * Which credential the signed-in person manages from inside a brand. A
 * multi-tenant admin's password is the platform one; a brand session may
 * come from a link that brand's mail provider carried, so it isn't proof
 * enough to set a password every brand accepts — that lives on /account.
 */
async function sessionCredential(
  req: Request,
): Promise<{ key: CredentialKey; scope: string; email: string } | 'managed_on_account' | null> {
  const { db, tenantId } = tenantOf(req);
  const p = req.principal;
  if (p?.role === 'admin' && p.source === 'session') {
    if (getTenancyMode() === 'multi') return 'managed_on_account';
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: p.adminId, tenantId }).first();
    return admin ? { key: platformCredential(admin.email), scope: 'platform', email: admin.email } : null;
  }
  if (p?.role === 'partner' && p.source === 'session') {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: p.partnerId, tenantId }).first();
    return partner ? { key: partnerCredential(tenantId, partner.id), scope: tenantId, email: partner.email } : null;
  }
  return null;
}

passwordTenantRouter.get('/auth/password', requireAuth, async (req, res) => {
  const found = await sessionCredential(req);
  // Absolute: on a custom domain the platform's /account is another host.
  if (found === 'managed_on_account') return res.json({ managedOn: 'account', accountUrl: `${getPortalBaseUrl()}/account` });
  // API keys (env, admin, partner) aren't a person signed in.
  if (!found) return res.status(403).json({ error: 'session_required' });
  res.json({ managedOn: 'here', hasPassword: await hasPassword(platformDb, found.key) });
});

passwordTenantRouter.put('/auth/password', requireAuth, async (req, res) => {
  const found = await sessionCredential(req);
  if (found === 'managed_on_account') return res.status(409).json({ error: 'managed_on_account' });
  if (!found) return res.status(403).json({ error: 'session_required' });
  const body = changeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const failed = await changePassword(found.key, found.scope, found.email, body.data);
  if (failed) return res.status(failed.status).json({ error: failed.error });
  res.json({ ok: true });
});
