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
import { newTrialEnd } from '../billing-plan.js';
import { findBlockingEntry, notifyOpsNewBrand } from '../brand-review.js';

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
  /** Optional billing plan picked from the marketing pricing CTAs. Stored
   *  on Tenant.billingPlan; the actual subscription is created when the
   *  admin completes Stripe Checkout post-activation. Deliberately NOT
   *  'enterprise': that plan is sales-led AND `hasActivePlan()` trusts it
   *  without a Stripe subscription, so accepting it on a public endpoint
   *  would let anyone self-declare past the plan-required gate (§13). */
  plan: z.enum(['flex', 'revshare']).optional(),
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

  // Signup blocklist (anti-spam): a banned admin email or email domain is
  // refused before any Tenant row is created. Deliberately a generic 403 —
  // we don't confirm to the sender that they're specifically banned.
  const blocked = await findBlockingEntry(db, adminEmail);
  if (blocked) {
    console.warn('[signup] blocked signup', { adminEmail, rule: `${blocked.type}:${blocked.value}` });
    return res.status(403).json({ error: 'signup_unavailable' });
  }

  let tenantId = ulid();
  const adminId = ulid();
  const now = new Date();

  try {
    await db.transaction(async (trx) => {
      // Re-check inside the transaction. A racing signup with the same
      // slug would otherwise both pass the pre-check and one would hit
      // the unique constraint as a generic 500. The unique constraint is
      // still our final guard; this just gives us a clean error.
      const existing = await trx<TenantRow>(TABLES.Tenant).where({ slug }).first();
      if (existing) {
        // Recovery path: if the slug exists but no admin has activated
        // yet, the previous signup was abandoned (typo'd email, mailer
        // misconfigured, etc.). Replace the unactivated admins + magic
        // links + the network membership Config so the new email can
        // claim the brand cleanly. If anyone has activated we still
        // refuse — that's a real conflict.
        const activatedExists = await trx<AdminRow>(TABLES.Admin)
          .where({ tenantId: existing.id })
          .whereNotNull('activatedAt')
          .first();
        if (activatedExists) throw new SignupGuardError('slug_taken');

        tenantId = existing.id;
        await trx<AdminRow>(TABLES.Admin).where({ tenantId }).del();
        await trx(TABLES.MagicLinkToken).where({ tenantId }).del();
        await trx(TABLES.Config).where({ tenantId, key: 'network_membership' }).del();
        await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({
          displayName: body.data.displayName,
          // Reclaiming an abandoned signup re-enters the review queue.
          approvalStatus: 'pending',
          approvalReason: null,
          reviewedAt: null,
          reviewedByEmail: null,
          // Refresh the plan choice on recovery — the user may have come
          // back via a different pricing CTA than their first attempt.
          ...(body.data.plan ? { billingPlan: body.data.plan as TenantRow['billingPlan'] } : {}),
          // Reset the 14-day evaluation window on recovery — the brand
          // is effectively starting over.
          trialEndsAt: newTrialEnd(),
          firstTrialActivatedAt: now,
          updatedAt: new Date(),
        });
      } else {
        await trx<TenantRow>(TABLES.Tenant).insert({
          id: tenantId,
          slug,
          displayName: body.data.displayName,
          status: 'active',
          // Public signups land in the review queue — they can sign in and
          // configure, but stay 403-gated from going live and serve no
          // clicks until a platform operator approves (anti-spam).
          approvalStatus: 'pending',
          billingPlan: (body.data.plan ?? null) as TenantRow['billingPlan'],
          // Trial starts at signup, not at Stripe Checkout — brands get a
          // 14-day evaluation window from t=0. firstTrialActivatedAt is
          // stamped now so the post-trial Stripe Checkout never grants a
          // second trial via subscription_data.trial_period_days.
          trialEndsAt: newTrialEnd(),
          firstTrialActivatedAt: now,
          metadata: { createdBy: 'signup' } as unknown as never,
        });
      }

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
    const tmpl = adminInviteEmail(body.data.adminName, buildMagicLinkUrl(issued.plaintext, { slug }), body.data.displayName);
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

  const network = await autoEnrollBrandOnNetwork({
    tenantId,
    slug,
    displayName: body.data.displayName,
    contactEmail: adminEmail,
    contactName: body.data.adminName,
    protoHost: `${req.protocol}://${req.get('host') ?? ''}`,
  });

  // Tell the platform-ops inbox a new brand is waiting for review.
  // Best-effort — a mailer blip must not fail the signup.
  await notifyOpsNewBrand(db, {
    brandName: body.data.displayName,
    slug,
    adminEmail,
  });

  res.status(201).json({
    ok: true,
    tenant: { id: tenantId, slug },
    mailDelivered: true,
    createdAt: now,
    network,
  });
});

/**
 * Auto-enroll a hosted brand on the Network. The hosted value prop INCLUDES
 * partner discovery; new brands shouldn't have to find a "connect" button to
 * use what they signed up for. Visibility is controlled by whether they
 * publish offerings, not by membership.
 *
 * If NETWORK_ADMIN_API_KEY is set we take the admin fast path — Network
 * skips its email verify and returns the vendorToken inline so membership is
 * `enabled: true` from t=0. Otherwise we fall back to the email-verify flow
 * (used by self-host and any operator who didn't wire the admin key).
 *
 * Shared by public /signup and the authenticated add-brand flow (§13).
 */
export async function autoEnrollBrandOnNetwork(opts: {
  tenantId: string;
  slug: string;
  displayName: string;
  contactEmail: string;
  contactName: string;
  protoHost: string;
}): Promise<{ status: 'active' | 'pending' | 'skipped' | 'failed'; vendorId: string | null }> {
  const networkUrl = process.env.NETWORK_URL;
  const networkAdminKey = process.env.NETWORK_ADMIN_API_KEY;
  if (!networkUrl) return { status: 'skipped', vendorId: null };
  try {
    const { signupWithNetwork, saveNetworkMembership } = await import('../network-client.js');
    const { createApiKeyRow } = await import('../auth.js');
    const { NETWORK_FEDERATION_SCOPES } = await import('./api-keys.js');

    const scoped = await createApiKeyRow(db, {
      tenantId: opts.tenantId,
      scopes: [...NETWORK_FEDERATION_SCOPES],
      label: 'network_federation',
    });
    const signupResult = await signupWithNetwork({
      networkUrl,
      // /api comes BEFORE /t/<slug> so the DO App Platform ingress
      // (/api → api component) actually routes to us. The tenant
      // middleware accepts both /t/<slug>/* and /api/t/<slug>/* via
      // its regex, so the api still resolves the tenant correctly.
      instanceUrl: `${opts.protoHost}/api/t/${opts.slug}`,
      scopedKey: scoped.plaintext,
      displayName: opts.displayName,
      contactEmail: opts.contactEmail,
      contactName: opts.contactName,
      tier: 'hosted',
      portalCallbackUrl: `${opts.protoHost}/t/${opts.slug}/admin/network/complete`,
      adminAuthToken: networkAdminKey,
    });
    if (signupResult.status === 'active') {
      await saveNetworkMembership(db, opts.tenantId, {
        enabled: true,
        networkUrl,
        vendorToken: signupResult.vendorToken,
        scopedKeyId: scoped.id,
        autoEnroll: true,
        vendorId: signupResult.vendorId,
      });
      return { status: 'active', vendorId: signupResult.vendorId };
    }
    // Email-verify path — vendorToken comes back at complete-connect.
    await saveNetworkMembership(db, opts.tenantId, {
      enabled: false,
      networkUrl,
      scopedKeyId: scoped.id,
      autoEnroll: true,
      vendorId: signupResult.vendorId,
    });
    return { status: 'pending', vendorId: signupResult.vendorId };
  } catch (err) {
    console.error('[signup] auto-network-register failed', err);
    return { status: 'failed', vendorId: null };
  }
}
