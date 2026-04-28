/**
 * Unified email-only signin for the multi-tenant deployment.
 *
 * The Landing on app.openpartner.dev offers a single Sign-in entry — we
 * don't make the user pick "brand vs creator" up front. The user enters
 * their email; we look up which accounts they have (Admin rows across
 * tenants for the brand side; Network Creator for the creator side) and
 * email magic links for whichever apply. Always 200 silently to avoid
 * email enumeration.
 *
 * Multi-tenant only — single-tenant deployments use the existing
 * per-tenant /auth/signin which already knows its tenant.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
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

  // 1) Brand admins. One person can be the admin of more than one tenant
  // (rare, but possible) — email a link for each so they can pick which
  // brand to sign into. We include unactivated admins so a brand whose
  // initial activation email got lost (e.g. mailer misconfigured at
  // signup time) can self-recover here: an admin_invite token activates
  // the admin on consume, so signin doubles as a resend-activation flow.
  const admins = await db<AdminRow>(TABLES.Admin)
    .where({ email })
    .whereNull('revokedAt');

  for (const admin of admins) {
    try {
      const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: admin.tenantId, status: 'active' }).first();
      if (!tenant) continue;
      const purpose = admin.activatedAt ? 'admin_signin' : 'admin_invite';
      const issued = await issueMagicLink(db, {
        tenantId: admin.tenantId,
        email,
        purpose,
        principalKind: 'admin',
        principalId: admin.id,
      });
      const tmpl = adminSigninEmail(admin.name, buildMagicLinkUrl(issued.plaintext, tenant.slug));
      await getMailer().send({ db, tenantId: tenant.id }, {
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: purpose,
        metadata: { purpose, adminId: admin.id, source: 'unified_signin' },
      });
    } catch (err) {
      // Don't fail the whole signin on one mail send issue. Log and move on.
      console.error('[signin] admin mail failed', { tenantId: admin.tenantId, err });
    }
  }

  // 2) Network creator. Forward to the Network's /creators/signin which
  // does its own existence-check + magic-link mail. Best-effort — if the
  // Network is down the user just gets the brand-side link (if any).
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
