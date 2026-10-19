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
 * Always 200 silently to avoid email enumeration. When no brand admin
 * matches, the address itself may hear why (sendNoAccountNotice) — the
 * response never says.
 *
 * Multi-tenant only — single-tenant deployments use the existing
 * per-tenant /auth/signin which already knows its tenant.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { TABLES, type AdminRow, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { issueMagicLink } from '../auth-sessions.js';
import { adminSigninEmail, buildMagicLinkUrl, signinNoAccountEmail } from '../email-templates.js';
import { getMailer } from '../mailer.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { PLATFORM_SESSION_COOKIE, resolvePlatformSession } from '../platform-sessions.js';
import { getPortalBaseUrl } from '../portal-url.js';
import { getTenancyMode } from '../tenancy.js';
import { isAllowedOperator } from './platform-admin.js';
import { requireServedCountry } from '../country-access.js';

export const signinRouter = Router();

const signinLimit = ipRateLimit({ name: 'unified-signin', max: 10, windowMs: 60_000 });

const schema = z.object({
  email: z.string().trim().email(),
  /** When true, the magic link issued is a "add this identity to the
   *  existing browser bundle" link (purpose=platform_add_account). The
   *  switcher in the sidebar sets this when the user clicks "Add another
   *  account". Without it, the verify path treats a different-email
   *  sign-in as a fresh login that REPLACES the bundle on this device. */
  add: z.boolean().optional(),
});

signinRouter.post('/signin', signinLimit, requireServedCountry(db, 'signin'), async (req, res) => {
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
        purpose: body.data.add ? 'platform_add_account' : 'platform_signin',
        principalKind: 'platform',
        principalId: email,
      });
      // Tenant-less link — verify will issue a PlatformSession, the SPA
      // routes through /workspaces to let the user pick which brand to
      // enter.
      const link = buildMagicLinkUrl(issued.plaintext);
      const tmpl = adminSigninEmail(anyAdmin.name, link);
      // Platform mail context, not the matched Admin row's tenant: workspace
      // sign-in spans every brand the person admins, and a brand that wired
      // up its own mail provider would otherwise carry OpenPartner's sign-in
      // link through its SMTP/Postmark and From address.
      await getMailer().send({ db, tenantId: DEFAULT_TENANT_ID }, {
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'platform_signin',
        metadata: { purpose: 'platform_signin', email, source: 'unified_signin' },
        platform: true,
      });
    } catch (err) {
      console.error('[signin] platform mail failed', { email, err });
    }
  } else {
    await sendNoAccountNotice(req, email, body.data.add === true);
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

/**
 * No brand admin matched. The response stays the same 200, but the
 * address's owner hears why no link came, in the two cases where they can
 * act on it and nobody can make us mail a stranger:
 *   - an ops-console address (PlatformAdmin / PLATFORM_ADMIN_EMAILS): its
 *     sign-in is /platform/login, not this page;
 *   - "Add another account" from a browser with a live platform session:
 *     a signed-in admin expected a brand account at that address.
 * A plain sign-in for an unknown address stays silent. The Network sends
 * the creator link in parallel and we can't see whether it did, so a
 * creator would get a "no account" email on every sign-in.
 */
async function sendNoAccountNotice(req: Request, email: string, addMode: boolean): Promise<void> {
  try {
    const opsIdentity = await isAllowedOperator(email);
    if (!opsIdentity && !(addMode && (await hasLivePlatformSession(req)))) return;
    const base = getPortalBaseUrl();
    const tmpl = signinNoAccountEmail({
      email,
      opsConsoleUrl: opsIdentity ? `${base}/platform/login` : null,
      signupUrl: `${base}/signup`,
    });
    await getMailer().send({ db, tenantId: DEFAULT_TENANT_ID }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'signin_no_account',
      metadata: { purpose: 'signin_no_account', email, source: 'unified_signin', opsIdentity },
      platform: true,
    });
  } catch (err) {
    console.error('[signin] no-account mail failed', { email, err });
  }
}

async function hasLivePlatformSession(req: Request): Promise<boolean> {
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[PLATFORM_SESSION_COOKIE];
  return !!cookie && (await resolvePlatformSession(db, cookie)) !== null;
}
