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
import { z } from 'zod';
import { TABLES, type AdminRow, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import {
  SESSION_COOKIE_NAME,
  consumeMagicLink,
  createSession,
  issueMagicLink,
  revokeSession,
  sessionCookieOptions,
} from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import {
  adminSigninEmail,
  buildMagicLinkUrl,
  partnerRevokedEmail,
  partnerSigninEmail,
} from '../email-templates.js';

export const partnerAuthRouter = Router();

const mailAuthLimit = ipRateLimit({ name: 'partner-auth-mail', max: 10, windowMs: 60_000 });
const verifyLimit = ipRateLimit({ name: 'partner-auth-verify', max: 30, windowMs: 60_000 });

const signinSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({ token: z.string().min(8) });

// -------- Signin --------

partnerAuthRouter.post('/auth/signin', mailAuthLimit, async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();

  // Admin first — if the same email is registered as both an admin and a
  // partner (unusual but possible on single-operator setups), admin wins.
  const admin = await db<AdminRow>(TABLES.Admin).where({ email }).first();
  if (admin?.activatedAt && !admin.revokedAt) {
    const issued = await issueMagicLink({
      email,
      purpose: 'admin_signin',
      principalKind: 'admin',
      principalId: admin.id,
    });
    const tmpl = adminSigninEmail(admin.name, buildMagicLinkUrl(issued.plaintext));
    await getMailer().send({
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'admin_signin',
      metadata: { purpose: 'admin_signin', adminId: admin.id },
    });
    return res.json({ ok: true });
  }

  const partner = await db<PartnerRow>(TABLES.Partner).where({ email }).first();
  if (partner?.activatedAt) {
    if (partner.revokedAt) {
      const tmpl = partnerRevokedEmail(partner.name, partner.revokeReason);
      await getMailer().send({
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'partner_revoked',
        metadata: { purpose: 'partner_revoked_signin_attempt', partnerId: partner.id },
      });
    } else {
      const issued = await issueMagicLink({
        email,
        purpose: 'partner_signin',
        principalKind: 'partner',
        principalId: partner.id,
      });
      const tmpl = partnerSigninEmail(partner.name, buildMagicLinkUrl(issued.plaintext));
      await getMailer().send({
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'partner_signin',
        metadata: { purpose: 'partner_signin', partnerId: partner.id },
      });
    }
  }
  // Unknown / pending / revoked-admin → silent 200. No email sent.
  res.json({ ok: true });
});

// -------- Verify --------

partnerAuthRouter.post('/auth/magic/verify', verifyLimit, async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;

  if (token.principalKind === 'admin') {
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: token.principalId }).first();
    if (!admin) return res.status(404).json({ error: 'admin_not_found' });
    if (admin.revokedAt) return res.status(403).json({ error: 'admin_revoked' });

    if (token.purpose === 'admin_invite' && !admin.activatedAt) {
      await db<AdminRow>(TABLES.Admin)
        .where({ id: admin.id })
        .update({ activatedAt: new Date(), updatedAt: new Date() });
    }
    await db<AdminRow>(TABLES.Admin).where({ id: admin.id }).update({ lastSignInAt: new Date() });

    const session = await createSession({ principalKind: 'admin', principalId: admin.id });
    res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
    return res.json({
      ok: true,
      role: 'admin',
      admin: { id: admin.id, email: admin.email, name: admin.name },
    });
  }

  // partner
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: token.principalId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  if (partner.revokedAt) return res.status(403).json({ error: 'partner_revoked' });

  if (token.purpose === 'partner_invite' && !partner.activatedAt) {
    await db<PartnerRow>(TABLES.Partner)
      .where({ id: partner.id })
      .update({ activatedAt: new Date(), updatedAt: new Date() });
  }

  const session = await createSession({ principalKind: 'partner', principalId: partner.id });
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
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  if (cookie) {
    const { resolveSession } = await import('../auth-sessions.js');
    const session = await resolveSession(cookie);
    if (session) await revokeSession(session.id);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});
