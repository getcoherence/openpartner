/**
 * Partner-facing authentication:
 *
 *   POST /auth/signin          email → magic link (returning partners)
 *   POST /auth/magic/verify    token → session cookie + whoami
 *   POST /auth/signout         revokes the session cookie
 *
 * The invite-on-create side lives on POST /partners in partners.ts — this
 * file handles everything the partner themselves interacts with.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type PartnerRow } from '@openpartner/db';
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
import { buildMagicLinkUrl, partnerSigninEmail } from '../email-templates.js';

export const partnerAuthRouter = Router();

// 10/min per IP keeps an attacker from email-bombing a known address.
const mailAuthLimit = ipRateLimit({ name: 'partner-auth-mail', max: 10, windowMs: 60_000 });
// Verify brute-force: single-use tokens make this moot, but cheap to cap.
const verifyLimit = ipRateLimit({ name: 'partner-auth-verify', max: 30, windowMs: 60_000 });

const signinSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({ token: z.string().min(8) });

// -------- Returning-partner signin --------

partnerAuthRouter.post('/auth/signin', mailAuthLimit, async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const partner = await db<PartnerRow>(TABLES.Partner).where({ email }).first();

  // Always return {ok:true} — don't leak whether the email is known.
  // Three outcomes internally:
  //   - unknown / pending           → no email, silent
  //   - active                      → magic-link email
  //   - revoked                     → suspension-notice email (the
  //     partner already knows, but a reminder short-circuits the
  //     "why doesn't my link work?" loop)
  if (partner && partner.activatedAt) {
    if (partner.revokedAt) {
      const { partnerRevokedEmail } = await import('../email-templates.js');
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
      const issued = await issueMagicLink({ email, purpose: 'partner_signin', partnerId: partner.id });
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
  res.json({ ok: true });
});

// -------- Magic-link verify (both invite + signin share this endpoint) --------

partnerAuthRouter.post('/auth/magic/verify', verifyLimit, async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const consumed = await consumeMagicLink(body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: consumed.token.partnerId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  // Invite tokens activate the partner as a side-effect of the first login.
  if (consumed.token.purpose === 'partner_invite' && !partner.activatedAt) {
    await db<PartnerRow>(TABLES.Partner)
      .where({ id: partner.id })
      .update({ activatedAt: new Date(), updatedAt: new Date() });
  }

  const session = await createSession(partner.id);
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

