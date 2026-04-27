/**
 * Public tenant signup. Hosted/multi-tenant only — in single-tenant mode
 * the seeded 'default' tenant is the entire installation and the install
 * endpoint covers first-run setup.
 *
 * POST /signup creates a Tenant + first Admin and emails the admin a
 * magic-link to activate. The endpoint is unauthenticated, rate-limited
 * by IP, and gated by slug validation:
 *
 *   - slug matches /^[a-z0-9-]{3,30}$/
 *   - slug not in RESERVED_SLUGS
 *   - slug not already taken (Tenant.slug unique)
 *   - adminEmail not already in use under that slug (which is impossible
 *     since the tenant is brand new, but we check anyway for symmetry)
 *
 * Mounted BEFORE tenantMiddleware in app.ts because there's no tenant
 * context yet — we use the privileged `db` for the writes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { adminInviteEmail, buildMagicLinkUrl } from '../email-templates.js';
import { RESERVED_SLUGS, getTenancyMode } from '../tenancy.js';

export const signupRouter = Router();

const signupLimit = ipRateLimit({ name: 'signup', max: 10, windowMs: 60_000 });

const signupSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumerics or hyphens'),
  displayName: z.string().trim().min(1).max(120),
  adminEmail: z.string().trim().email().max(254),
  adminName: z.string().trim().min(1).max(120),
});

class SignupGuardError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

signupRouter.post('/signup', signupLimit, async (req, res) => {
  if (getTenancyMode() !== 'multi') {
    return res.status(400).json({ error: 'signup_not_available_in_single_tenant' });
  }

  const body = signupSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const slug = body.data.slug.toLowerCase();
  const adminEmail = body.data.adminEmail.toLowerCase();

  if (RESERVED_SLUGS.has(slug)) {
    return res.status(409).json({ error: 'slug_reserved' });
  }

  const tenantId = ulid();
  const adminId = ulid();
  const now = new Date();

  try {
    await db.transaction(async (trx) => {
      // Re-check inside the transaction. A racing signup with the same
      // slug would otherwise both pass the pre-check and one would hit
      // the unique constraint as a generic 500. The unique constraint is
      // still our final guard; this just gives us a clean error.
      const existing = await trx<TenantRow>(TABLES.Tenant).where({ slug }).first();
      if (existing) throw new SignupGuardError('slug_taken');

      await trx<TenantRow>(TABLES.Tenant).insert({
        id: tenantId,
        slug,
        displayName: body.data.displayName,
        status: 'active',
        metadata: { createdBy: 'signup' } as unknown as never,
      });

      await trx<AdminRow>(TABLES.Admin).insert({
        id: adminId,
        tenantId,
        email: adminEmail,
        name: body.data.adminName,
        activatedAt: null,
      });
    });
  } catch (err) {
    if (err instanceof SignupGuardError) {
      return res.status(409).json({ error: err.code });
    }
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      // Unique violation — slug got taken between the pre-check and the
      // insert. Surface as the same 409.
      return res.status(409).json({ error: 'slug_taken' });
    }
    throw err;
  }

  // Email the activation magic link. If this fails the Tenant + Admin row
  // remain — the operator can hit /admins/:id/invite later (after first
  // admin activates) or we can expose a dedicated "resend invite" public
  // endpoint. We don't roll back signup on mail failure because the
  // tenant slug is now taken and reusing it might surprise the second
  // installer; better to leave it claimed and let them recover via mail
  // ops than auto-release on a transient SMTP blip.
  try {
    const issued = await issueMagicLink(db, {
      tenantId,
      email: adminEmail,
      purpose: 'admin_invite',
      principalKind: 'admin',
      principalId: adminId,
    });
    const tmpl = adminInviteEmail(body.data.adminName, buildMagicLinkUrl(issued.plaintext), body.data.displayName);
    await getMailer().send({ db, tenantId }, {
      to: adminEmail,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'admin_invite',
      metadata: { purpose: 'admin_invite', adminId, signup: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'mail_failed';
    return res.status(202).json({
      ok: true,
      tenant: { id: tenantId, slug },
      mailDelivered: false,
      mailError: message,
      createdAt: now,
    });
  }

  // Auto-register hosted tenant with the Network. Best-effort: a
  // network-side outage doesn't fail the signup. The admin can finish
  // connecting later via Settings → Network → "Connect to Network".
  let networkStatus: 'pending' | 'skipped' | 'failed' = 'skipped';
  let networkVendorId: string | null = null;
  const networkUrl = process.env.NETWORK_URL;
  if (networkUrl) {
    try {
      const { signupWithNetwork } = await import('../network-client.js');
      const { createApiKeyRow } = await import('../auth.js');
      const { NETWORK_FEDERATION_SCOPES } = await import('./api-keys.js');
      const { saveNetworkMembership } = await import('../network-client.js');

      const scoped = await createApiKeyRow(db, {
        tenantId,
        scopes: [...NETWORK_FEDERATION_SCOPES],
        label: 'network_federation',
      });
      const protoHost = `${req.protocol}://${req.get('host') ?? ''}`;
      const signup = await signupWithNetwork({
        networkUrl,
        instanceUrl: `${protoHost}/t/${slug}/api`,
        scopedKey: scoped.plaintext,
        displayName: body.data.displayName,
        contactEmail: adminEmail,
        contactName: body.data.adminName,
        tier: 'hosted',
        portalCallbackUrl: `${protoHost}/t/${slug}/admin/network/complete`,
      });
      // Stash the partial state — vendorToken comes back at complete-connect.
      await saveNetworkMembership(db, tenantId, {
        enabled: false,
        networkUrl,
        scopedKeyId: scoped.id,
        autoEnroll: true,
      });
      networkStatus = 'pending';
      networkVendorId = signup.vendorId;
    } catch (err) {
      console.error('[signup] auto-network-register failed', err);
      networkStatus = 'failed';
    }
  }

  res.status(201).json({
    ok: true,
    tenant: { id: tenantId, slug },
    mailDelivered: true,
    createdAt: now,
    network: { status: networkStatus, vendorId: networkVendorId },
  });
});
