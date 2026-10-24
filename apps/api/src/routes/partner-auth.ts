/**
 * Human authentication — covers both admin and partner personas.
 *
 *   POST /auth/signin          email → magic-link email (whichever table
 *                              the address lives in). 200 always so
 *                              email existence can't be enumerated.
 *   POST /auth/magic/verify    token → session cookie + whoami. Branches
 *                              on the token's principalKind.
 *   POST /auth/signout         revokes the session cookie.
 *
 * Invite-on-create sides live in /partners and /admins.
 */

import { Router } from 'express';
import { z } from '../zod.js';
import { TABLES, type AdminRow, type PartnerRow } from '@openpartner/db';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  consumeMagicLink,
  createSession,
  issueMagicLink,
  revokeSession,
  revokeSessionByToken,
  sessionCookieOptions,
} from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { adminSigninEmail, buildMagicLinkUrl, partnerSigninEmail } from '../email-templates.js';
import { linkTenantOf } from '../portal-url.js';
import { tenantOf } from '../tenancy.js';
import { onCommit } from '../on-commit.js';
import { isPendingReview, partnerReviewOf } from '../partner-review.js';
import type { WebhookPayload } from '../openapi/webhook-events.js';
// The privileged pool: the country rules live in PlatformSetting, which the
// app role can't read. Used for that lookup only.
import { db as platformDb } from '../db.js';
import { requireServedCountry } from '../country-access.js';
import { claimSignupPassword } from '../passwords.js';

export const partnerAuthRouter = Router();

const mailAuthLimit = ipRateLimit({ name: 'partner-auth-mail', max: 10, windowMs: 60_000 });
const verifyLimit = ipRateLimit({ name: 'partner-auth-verify', max: 30, windowMs: 60_000 });

const signinSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({ token: z.string().min(8) });

// -------- Signin --------

partnerAuthRouter.post('/auth/signin', mailAuthLimit, requireServedCountry(platformDb, 'tenant-signin'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();

  // Admin first — if the same email is registered as both an admin and a
  // partner (unusual but possible on single-operator setups), admin wins.
  // Email is unique per tenant, so both lookups name it: a pool that
  // bypasses RLS would otherwise mint this tenant's sign-in link for
  // another tenant's admin or partner.
  const admin = await db<AdminRow>(TABLES.Admin).where({ tenantId, email }).first();
  if (admin?.activatedAt && !admin.revokedAt) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'admin_signin',
      principalKind: 'admin',
      principalId: admin.id,
    });
    const tmpl = adminSigninEmail(admin.name, buildMagicLinkUrl(issued.plaintext, linkTenantOf(req)));
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'admin_signin',
      metadata: { purpose: 'admin_signin', adminId: admin.id },
    });
    return res.json({ ok: true });
  }

  const partner = await db<PartnerRow>(TABLES.Partner).where({ tenantId, email }).first();
  // Revoked partners fall through silently — they were notified at
  // revoke time (if admin opted in) and emailing on every signin
  // attempt turns /auth/signin into a harassment vector: anyone can
  // cause arbitrary emails to the victim by POSTing their address
  // here repeatedly.
  // So do partners without portal access (partner-portal-access.ts): a
  // headless program's customers, who never learn OpenPartner exists.
  // Same 200 as an unknown email, so the form can't tell who's a partner.
  if (partner?.activatedAt && !partner.revokedAt && partner.portalAccess) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'partner_signin',
      principalKind: 'partner',
      principalId: partner.id,
    });
    const { resolveBrandName } = await import('../brand-name.js');
    const brandName = await resolveBrandName(db, tenantId);
    const tmpl = partnerSigninEmail(partner.name, buildMagicLinkUrl(issued.plaintext, linkTenantOf(req)), brandName);
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_signin',
      metadata: { purpose: 'partner_signin', partnerId: partner.id },
    });
  }
  // Unknown / pending / revoked / no portal access → silent 200. No email sent.
  res.json({ ok: true });
});

// -------- Verify --------

partnerAuthRouter.post('/auth/magic/verify', verifyLimit, requireServedCountry(platformDb, 'tenant-verify'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(db, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;
  // A link only signs in to the tenant that issued it. RLS hides other
  // tenants' tokens from req.db; on a pool that bypasses RLS, another
  // tenant's admin link would otherwise open a session here.
  if (token.tenantId !== tenantId) return res.status(400).json({ error: 'invalid_or_expired_token' });
  // A reset link sets a password (POST /auth/password/reset); it isn't a
  // sign-in link.
  if (token.purpose === 'password_reset') return res.status(400).json({ error: 'wrong_token_kind' });

  if (token.principalKind === 'admin') {
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: token.principalId, tenantId }).first();
    if (!admin) return res.status(404).json({ error: 'admin_not_found' });
    if (admin.revokedAt) return res.status(403).json({ error: 'admin_revoked' });

    if (token.purpose === 'admin_invite' && !admin.activatedAt) {
      await db<AdminRow>(TABLES.Admin)
        .where({ id: admin.id, tenantId })
        .update({ activatedAt: new Date(), updatedAt: new Date() });
    }
    // A password typed on the signup form waits on this very link.
    if (token.purpose === 'admin_invite') await claimSignupPassword(platformDb, token);
    await db<AdminRow>(TABLES.Admin).where({ id: admin.id, tenantId }).update({ lastSignInAt: new Date() });

    const session = await createSession(db, { tenantId, principalKind: 'admin', principalId: admin.id });
    res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
    return res.json({
      ok: true,
      role: 'admin',
      admin: { id: admin.id, email: admin.email, name: admin.name },
    });
  }

  // partner
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: token.principalId, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  if (partner.revokedAt) return res.status(403).json({ error: 'partner_revoked' });
  // An applicant held for review can't sign in, or activate themselves,
  // until an admin approves (POST /partners/:id/invite records that).
  if (isPendingReview(partner)) return res.status(403).json({ error: 'pending_review' });
  // Turning access off spends the partner's unused links, so this only
  // catches a link that predates a change made some other way. The link
  // was mailed to the partner, so naming the reason tells nobody else
  // anything.
  if (!partner.portalAccess) return res.status(403).json({ error: 'portal_access_disabled' });

  if (token.purpose === 'partner_invite' && !partner.activatedAt) {
    const activatedAt = new Date();
    await db<PartnerRow>(TABLES.Partner)
      .where({ id: partner.id, tenantId })
      .update({ activatedAt, updatedAt: activatedAt });
    // Fire once, on the actual activation. partner.created already
    // fired at invite time; this is the "they accepted + are now
    // promoting" signal Zapier subscribers want for welcome
    // sequences, Slack pings, etc. (A partner created active, with
    // sendInvite:false or approved automatically on the join page, gets
    // theirs when they're added instead.) So the only join-page partner
    // activated here is an applicant held for review, and only they carry
    // a review state. After COMMIT, so a receiver reading the partner sees
    // them activated (on-commit.ts).
    const { dispatchEvent } = await import('../webhook-dispatcher.js');
    const activatedPayload = {
      partnerId: partner.id,
      email: partner.email,
      name: partner.name,
      activatedAt: activatedAt.toISOString(),
      invited: true,
      source: partnerReviewOf(partner.metadata) ? 'join_page' : 'api',
    } satisfies WebhookPayload<'partner.activated'>;
    onCommit(db, 'partner.activated webhook', () => dispatchEvent(tenantId, 'partner.activated', activatedPayload));
  }

  const session = await createSession(db, { tenantId, principalKind: 'partner', principalId: partner.id });
  res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
  res.json({
    ok: true,
    role: 'partner',
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      stripeConnected: !!partner.stripeConnectAccountId,
    },
  });
});

// -------- Signout --------

partnerAuthRouter.post('/auth/signout', async (req, res) => {
  const { db } = tenantOf(req);
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  if (cookie) {
    // Revoke the token PRESENTED, whichever tenant it belongs to.
    //
    // This went through resolveSession, which round 8 bound to the request
    // tenant — and that broke logout (round 9). `op_session` is host-wide at
    // path '/', so entering a second workspace overwrites it, and a signout
    // from a stale tab carries tenant B's token to tenant A's URL. The
    // filtered lookup found nothing, we cleared the browser cookie and
    // returned 200, and B's session stayed live.
    await revokeSessionByToken(db, cookie);
  }
  // Express's clearCookie only works when the options match the
  // original cookie's attributes (path + secure + sameSite + domain
  // — anything that would key the cookie distinctly in the browser).
  // Passing just { path: '/' } would emit a Set-Cookie the browser
  // sees as a DIFFERENT cookie (no secure, no sameSite) and the
  // original op_session would persist. Reuse the same factory used
  // at set time to guarantee they match.
  clearSessionCookie(res, SESSION_COOKIE_NAME, sessionCookieOptions());
  res.json({ ok: true });
});
