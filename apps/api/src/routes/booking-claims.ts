/**
 * A public storefront request continues as a brand (openpartner-network
 * docs/creator-storefront.md §8.4).
 *
 *   POST /booking-claims/preview { token }   what the emailed link is for, and how to continue
 *   POST /booking-claims/signup  { token, displayName, slug, country, outsideOccupiedRegions?, adminName? }
 *
 * Someone sends a request from a creator's public storefront (the marketing
 * site). The Network emails a link (PORTAL_URL/booking/confirm?token=, 48
 * hours) to the address they typed. The landing page asks this API what's
 * behind it; the token is read with the Network admin key, so a browser never
 * asks the Network itself.
 *
 *   - No brand for that address yet: /signup creates one here and then
 *     claims the request into it. The admin is activated straight away
 *     (following the link proved the inbox, so no second email) and both
 *     sessions are set. The brand clears the same checks as any signup
 *     (reserved slugs, country, blocklist, sanctions screening) and lands in
 *     operator review. It has no plan, so it pays the Revshare booking fee
 *     (booking-fee.ts) until it picks one.
 *   - The address already has a brand, or the visitor is signed in: they
 *     sign in the usual way (a 48-hour link never signs anyone into an
 *     existing account) and the brand's claim page (/admin/network/claim)
 *     calls POST /admin/network/bookings/claim (settings.ts).
 *
 * Mounted before tenantMiddleware (there's no tenant yet), like signup.ts.
 */

import { Router, type Response } from 'express';
import { z } from '../zod.js';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
import { db, appDb } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth-sessions.js';
import { RESERVED_SLUGS, getTenancyMode } from '../tenancy.js';
import { newTrialEnd } from '../billing-plan.js';
import { checkCountryAccess, countryAccessStatus, countryCodeSchema, recordLocationDeclaration } from '../country-access.js';
import { findBlockingEntry, notifyOpsNewBrand } from '../brand-review.js';
import { screenTenantInBackground } from '../sanctions-screening.js';
import {
  attachSessionToBundle,
  createPlatformBundle,
  createPlatformSession,
  PLATFORM_BUNDLE_COOKIE,
  PLATFORM_SESSION_COOKIE,
  platformBundleCookieOptions,
  platformSessionCookieOptions,
  platformSessionTokenHash,
} from '../platform-sessions.js';
import {
  NetworkAdminError,
  NetworkProxyError,
  networkProxy,
  platformNetworkUrl,
  previewBookingClaim,
  type BookingClaimPreview,
} from '../network-client.js';
import { bookingFeeBpsFor } from '../booking-fee.js';
import { autoEnrollBrandOnNetwork } from './signup.js';

export const bookingClaimsRouter = Router();

const claimLimit = ipRateLimit({ name: 'booking-claim', max: 20, windowMs: 60_000 });

const tokenSchema = z.string().regex(/^opbk_[0-9a-f]{48}$/);

const signupSchema = z.object({
  token: tokenSchema,
  slug: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumerics or hyphens'),
  displayName: z.string().trim().min(1).max(120),
  adminName: z.string().trim().min(1).max(120).optional(),
  country: countryCodeSchema(),
  outsideOccupiedRegions: z.boolean().optional(),
});

class ClaimSignupError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** The request behind a token, or the Network's reason it can't be used
 *  (invalid_or_used, expired, creator_unavailable), answered on `res`. */
async function previewOrAnswer(token: string, res: Response): Promise<BookingClaimPreview | null> {
  const networkUrl = platformNetworkUrl();
  if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) {
    res.status(503).json({ error: 'network_not_configured' });
    return null;
  }
  try {
    return await previewBookingClaim(networkUrl, token);
  } catch (err) {
    if (err instanceof NetworkAdminError && (err.status === 404 || err.status === 410)) {
      res.status(err.status).json({ error: err.code ?? 'invalid_or_used' });
      return null;
    }
    console.error('[booking-claims] preview failed', err);
    res.status(502).json({ error: 'network_unavailable' });
    return null;
  }
}

/** Does this address already admin a brand? Then it signs in instead. */
async function hasBrand(email: string): Promise<boolean> {
  const row = await db(TABLES.Admin)
    .join(TABLES.Tenant, `${TABLES.Tenant}.id`, `${TABLES.Admin}.tenantId`)
    .whereRaw(`lower("${TABLES.Admin}"."email") = ?`, [email.toLowerCase()])
    .whereNull(`${TABLES.Admin}.revokedAt`)
    .andWhere(`${TABLES.Tenant}.status`, 'active')
    .first(`${TABLES.Admin}.id`);
  return !!row;
}

/** A workspace address to start the form with: from the company, else the
 *  email's domain. Only a suggestion; signup checks it. */
export function suggestSlug(company: string | null, email: string): string {
  const base = (company ?? email.split('@')[1]?.split('.')[0] ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : '';
}

bookingClaimsRouter.post('/booking-claims/preview', claimLimit, async (req, res) => {
  if (getTenancyMode() !== 'multi') return res.status(400).json({ error: 'not_available_in_single_tenant' });
  const body = z.object({ token: tokenSchema }).safeParse(req.body ?? {});
  if (!body.success) return res.status(404).json({ error: 'invalid_or_used' });
  const preview = await previewOrAnswer(body.data.token, res);
  if (!preview) return;
  res.json({
    creator: preview.creator,
    packageTitle: preview.packageTitle,
    contactName: preview.contactName,
    company: preview.company,
    website: preview.website,
    brief: preview.brief,
    budgetNote: preview.budgetNote,
    expiresAt: preview.expiresAt,
    // The link was sent to this address, so showing it to whoever holds the
    // link is no disclosure; the form says the brand is created for it.
    email: preview.contactEmail,
    accountExists: await hasBrand(preview.contactEmail),
    suggested: { displayName: preview.company ?? '', slug: suggestSlug(preview.company, preview.contactEmail) },
  });
});

bookingClaimsRouter.post('/booking-claims/signup', claimLimit, async (req, res) => {
  if (getTenancyMode() !== 'multi') return res.status(400).json({ error: 'not_available_in_single_tenant' });
  const body = signupSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const slug = body.data.slug.toLowerCase();
  if (RESERVED_SLUGS.has(slug)) return res.status(409).json({ error: 'slug_reserved' });

  const preview = await previewOrAnswer(body.data.token, res);
  if (!preview) return;
  const email = preview.contactEmail.toLowerCase();
  // An existing account signs in the usual way; this link only creates.
  if (await hasBrand(email)) return res.status(409).json({ error: 'account_exists' });

  const location = await checkCountryAccess(db, {
    declared: body.data.country,
    ip: req.ip,
    outsideOccupiedRegions: body.data.outsideOccupiedRegions,
  });
  if (!location.ok) {
    console.warn('[booking-claims] country refused', { via: location.via, ipCountry: location.ipCountry });
    return res.status(countryAccessStatus(location.error)).json({ error: location.error });
  }
  // Same anti-spam gate as public /signup, with the same generic 403.
  const blocked = await findBlockingEntry(db, email);
  if (blocked) {
    console.warn('[booking-claims] blocked', { email, rule: `${blocked.type}:${blocked.value}` });
    return res.status(403).json({ error: 'signup_unavailable' });
  }

  const adminName = body.data.adminName ?? preview.contactName;
  const tenantId = ulid();
  const adminId = ulid();
  const now = new Date();
  try {
    await db.transaction(async (trx) => {
      const existing = await trx<TenantRow>(TABLES.Tenant).where({ slug }).first(['id']);
      if (existing) throw new ClaimSignupError('slug_taken');
      await trx<TenantRow>(TABLES.Tenant).insert({
        id: tenantId,
        slug,
        displayName: body.data.displayName,
        status: 'active',
        // Like every public signup: in the review queue until an operator
        // approves. It can still talk and pay in the conversation its
        // request opens (the Network allows that much for brands in review).
        approvalStatus: 'pending',
        // No plan yet: bookings pay their own fee at Checkout.
        billingPlan: null,
        trialEndsAt: newTrialEnd(),
        firstTrialActivatedAt: now,
        metadata: { createdBy: 'booking_claim', creatorId: preview.creator.id } as unknown as never,
      });
      await trx<AdminRow>(TABLES.Admin).insert({ id: adminId, tenantId, email, name: adminName, activatedAt: now });
    });
  } catch (err) {
    if (err instanceof ClaimSignupError) return res.status(409).json({ error: err.code });
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'slug_taken' });
    }
    throw err;
  }

  await recordLocationDeclaration(db, {
    subjectKind: 'tenant',
    subjectId: tenantId,
    tenantId,
    country: body.data.country,
    outsideOccupiedRegions: body.data.outsideOccupiedRegions ?? null,
    ipCountry: location.ipCountry,
    source: 'signup',
    declaredByEmail: email,
  });
  screenTenantInBackground(db, tenantId, 'signup');

  const network = await autoEnrollBrandOnNetwork({
    tenantId,
    slug,
    displayName: body.data.displayName,
    contactEmail: email,
    contactName: adminName,
    protoHost: `${req.protocol}://${req.get('host') ?? ''}`,
    approvalStatus: 'pending',
  });
  await notifyOpsNewBrand(db, { brandName: body.data.displayName, slug, adminEmail: email });

  // Signed in: a platform identity (so the brand is in the switcher) and a
  // session in the new brand.
  const platform = await createPlatformSession(db, email);
  const bundle = await createPlatformBundle(db);
  const created = await db(TABLES.PlatformSession).where({ tokenHash: platformSessionTokenHash(platform.plaintext) }).first(['id']);
  if (created) await attachSessionToBundle(db, (created as { id: string }).id, bundle.id);
  const trx = await appDb.transaction();
  let sessionPlaintext: string;
  try {
    await trx.raw(`set local app.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    sessionPlaintext = (await createSession(trx, { tenantId, principalKind: 'admin', principalId: adminId })).plaintext;
    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }
  res.cookie(PLATFORM_SESSION_COOKIE, platform.plaintext, platformSessionCookieOptions());
  res.cookie(PLATFORM_BUNDLE_COOKIE, bundle.cookie, platformBundleCookieOptions());
  res.cookie(SESSION_COOKIE_NAME, sessionPlaintext, sessionCookieOptions());

  // Claim the request into the new brand. If that can't happen now (the
  // Network enrolment is still pending, or the request was claimed in the
  // meantime), the brand exists and the claim page can try again.
  let conversationId: string | null = null;
  let claimError: string | null = null;
  if (network.status === 'active') {
    try {
      const fee = await bookingFeeBpsFor(db, tenantId);
      const claimed = await networkProxy.claimBooking(db, tenantId, {
        token: body.data.token,
        authorName: adminName,
        authorEmail: email,
        ...(fee == null ? {} : { bookingFeeBps: fee }),
      });
      conversationId = claimed.conversationId;
    } catch (err) {
      claimError = err instanceof NetworkProxyError ? err.message : 'claim_failed';
      console.error('[booking-claims] claim after signup failed', { tenantId, err });
    }
  } else {
    claimError = `network_${network.status}`;
  }

  res.status(201).json({
    ok: true,
    tenant: { id: tenantId, slug },
    home: `/t/${slug}/`,
    approvalStatus: 'pending',
    conversationId,
    claimError,
  });
});
