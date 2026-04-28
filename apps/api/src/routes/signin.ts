/**
 * Unified email-only signin for the multi-tenant deployment.
 *
 * The Landing on app.openpartner.dev offers a single Sign-in entry — we
 * don't make the user pick "brand vs creator" up front. Email goes in,
 * a platform-identity magic link goes out (one email regardless of how
 * many brands the user admins). Verifying the link issues a
 * PlatformSession; the SPA reads /api/me/workspaces and the user picks
 * which brand to enter. Creator signin is forwarded to the Network in
 * parallel — same email, separate flow, separate cookie.
 *
 * Always 200 silently to avoid email enumeration.
 *
 * Multi-tenant only — single-tenant deployments use the existing
 * per-tenant /auth/signin which already knows its tenant.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type AdminRow, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { issueMagicLink } from '../auth-sessions.js';
import { adminSigninEmail, buildMagicLinkUrl } from '../email-templates.js';
import { getMailer } from '../mailer.js';
import { getTenancyMode } from '../tenancy.js';

export const signinRouter = Router();

const schema = z.object({ email: z.string().trim().email() });

signinRouter.post('/signin', async (req, res) => {
  if (getTenancyMode() !== 'multi') {
    return res.status(400).json({ error: 'use_per_tenant_signin' });
  }

  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_email' });

  const email = body.data.email.toLowerCase();

  // Brand admin path. We don't care here which tenants — only whether ANY
  // non-revoked admin row matches. The picker after verify enumerates the
  // workspaces and lets the user choose. Mailer best-effort; per-tenant
  // log on failure.
  const anyAdmin = await db<AdminRow>(TABLES.Admin)
    .where({ email })
    .whereNull('revokedAt')
    .first();

  if (anyAdmin) {
    try {
      const issued = await issueMagicLink(db, {
        tenantId: DEFAULT_TENANT_ID, // placeholder — platform tokens aren't tenant-scoped
        email,
        purpose: 'platform_signin',
        principalKind: 'platform',
        principalId: email,
      });
      // Tenant-less link — verify will issue a PlatformSession, the SPA
      // routes through /workspaces to let the user pick which brand to
      // enter.
      const link = buildMagicLinkUrl(issued.plaintext);
      const tmpl = adminSigninEmail(anyAdmin.name, link);
      await getMailer().send({ db, tenantId: anyAdmin.tenantId }, {
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'platform_signin',
        metadata: { purpose: 'platform_signin', email, source: 'unified_signin' },
      });
    } catch (err) {
      console.error('[signin] platform mail failed', { email, err });
    }
  }

  // Creator side — same email, separate cookie, parallel flow. Best-effort.
  const networkUrl = process.env.NETWORK_URL;
  if (networkUrl) {
    try {
      await fetch(`${networkUrl.replace(/\/$/, '')}/creators/signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'OpenPartner-Signin/1' },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      console.error('[signin] network creator signin failed', err);
    }
  }

  res.json({ ok: true });
});
