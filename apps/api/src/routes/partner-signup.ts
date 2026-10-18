/**
 * Public creator-facing partner signup.
 *
 * Lets a creator self-serve onto a vendor's program without admin
 * pre-invite. The vendor's `Settings → Partners` page chooses the
 * post-signup state:
 *
 *   - `auto_approve` (default): activatedAt set immediately, magic-link
 *     issued, partner can sign in straight away.
 *   - `require_review`: activatedAt stays null and Partner.metadata.review
 *     is 'pending' (see partner-review.ts). No magic link: the applicant
 *     gets an acknowledgement, the brand's admins get a review request, and
 *     an admin approves via /partners/:id/invite, which sends the link.
 *
 * Under both policies the body must carry an `application` (website or
 * main channel, 1–5 social profile URLs, an audience-size bucket and a
 * pitch). It's stored on Partner.metadata.application for the admin's
 * review, included in the admin notice, and its first three answers are
 * sent to the Network as `creatorProfile` to fill blanks in the creator's
 * Network profile.
 *
 * GET /partner-signup/status ({ open, reviewRequired }) lets the join page
 * show "closed" before anyone fills in the form; POST checks closed first
 * too, so a closed program answers signup_disabled whatever the body.
 *
 * The endpoint is mounted INSIDE tenantMiddleware — in multi-tenant
 * mode the URL is /t/<slug>/partner-signup; in single-tenant mode
 * (self-host) it's /partner-signup. Tenant context comes from req.db
 * either way.
 *
 * Network behavior: when the brand offers the Network to its partners
 * (status reports networkOffered), the join page shows an optional,
 * unchecked opt-in. Only an applicant who ticks it is recorded as
 * consented and pushed to /partners/upsert (network-consent.ts); the
 * returned networkCreatorId is stamped on Partner.metadata.network.
 * Everyone else is asked once in the portal. Network failures are queued
 * in NetworkOutbox and don't fail the signup.
 *
 * Webhooks: every signup fires `partner.created` with `source: 'join_page'`.
 * An auto-approved applicant is active from the moment they apply, so
 * `partner.activated` (`invited: false`) follows straight away; one held
 * for review fires it from magic-link verify on their first sign-in after
 * approval.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  AUDIENCE_SIZES,
  AUDIENCE_SIZE_LABELS,
  PARTNER_APPLICATION_LIMITS,
  TABLES,
  isHttpUrl,
  type AdminRow,
  type ConfigRow,
  type PartnerApplication,
  type PartnerRow,
} from '@openpartner/db';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import {
  buildMagicLinkUrl,
  partnerApplicationAdminEmail,
  partnerApplicationReceivedEmail,
  partnerInviteEmail,
} from '../email-templates.js';
import { getPortalBaseUrl, linkTenantOf } from '../portal-url.js';
import type { PartnerReview } from '../partner-review.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { tenantOf } from '../tenancy.js';
import { grantNetworkConsent, isNetworkOfferedToPartners, syncPartnerToNetwork } from '../network-consent.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import type { WebhookPayload } from '../openapi/webhook-events.js';

export const partnerSignupRouter = Router();

const signupLimit = ipRateLimit({ name: 'partner-signup', max: 10, windowMs: 60_000 });
// Same limit, own bucket: loading the join page shouldn't eat into the
// applicant's submit budget.
const statusLimit = ipRateLimit({ name: 'partner-signup-status', max: 10, windowMs: 60_000 });

const L = PARTNER_APPLICATION_LIMITS;
const httpUrl = (message: string) => z.string().trim().max(L.urlMax, message).refine(isHttpUrl, message);

// The join-page application. Required under BOTH signup policies: a
// creator can't join without a complete profile. Messages are written for
// the applicant; the portal shows them on a 400.
const applicationSchema = z.object(
  {
    websiteUrl: httpUrl('Enter your website or main channel as a full link, starting with https://'),
    socialUrls: z
      .array(httpUrl('Each social profile must be a full link, starting with https://'))
      .min(L.socialMin, 'Add at least one social profile')
      .max(L.socialMax, `Add at most ${L.socialMax} social profiles`)
      .transform((urls) => [...new Set(urls)]),
    audienceSize: z.enum(AUDIENCE_SIZES, { errorMap: () => ({ message: 'Pick your audience size' }) }),
    pitch: z
      .string()
      .trim()
      .min(L.pitchMin, `Tell the brand how you'd promote it, in at least ${L.pitchMin} characters`)
      .max(L.pitchMax, `Keep your pitch under ${L.pitchMax} characters`),
  },
  { required_error: 'Complete the application: website, social profiles, audience size and pitch' },
);

const schema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(120),
  profile: z.record(z.unknown()).optional(),
  application: applicationSchema,
  /** The join page's optional "also join the OpenPartner Network"
   *  checkbox. Unchecked (or absent) = not asked yet: the partner gets the
   *  portal prompt instead. Ignored unless the brand offers the Network. */
  networkOptIn: z.boolean().optional(),
});

// Partner.metadata keys the server owns. This endpoint is public, so a
// signup's profile must not set them: `source` decides the Network-access
// fee (usage-billing.ts), `network` is the Network sync stamp, `stripe`
// mirrors Connect payout state, `review` gates sign-in for applicants
// held for review (partner-review.ts), and `application` is the validated
// join-page answers admins review.
const RESERVED_METADATA_KEYS = new Set(['source', 'network', 'stripe', 'review', 'application']);

/**
 * Email every active admin of the tenant that an application is waiting.
 * Best-effort: a mail failure is logged and never fails the signup.
 */
async function notifyAdminsOfApplication(
  db: import('knex').Knex,
  tenantId: string,
  partner: PartnerRow,
  brandName: string | null,
  reviewUrl: string,
  application: PartnerApplication,
): Promise<void> {
  const admins = (await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .select('id', 'email')) as Array<Pick<AdminRow, 'id' | 'email'>>;
  const tmpl = partnerApplicationAdminEmail(partner.name, partner.email, brandName, reviewUrl, {
    websiteUrl: application.websiteUrl,
    socialUrls: application.socialUrls,
    audienceSize: AUDIENCE_SIZE_LABELS[application.audienceSize],
    pitch: application.pitch,
  });
  for (const admin of admins) {
    try {
      await getMailer().send({ db, tenantId }, {
        to: admin.email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'partner_application',
        metadata: { purpose: 'partner_application', partnerId: partner.id, adminId: admin.id },
      });
    } catch (err) {
      console.error('[partner-signup] admin application notice failed', {
        partnerId: partner.id,
        adminId: admin.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type PartnerSignupPolicy = 'auto_approve' | 'require_review';

interface PartnerSignupSettings {
  policy: PartnerSignupPolicy;
  /** Disable signup entirely. Defaults false (signup open). */
  disabled?: boolean;
}

const PARTNER_SIGNUP_CONFIG_KEY = 'partner_signup';

async function readSignupSettings(
  db: import('knex').Knex,
  tenantId: string,
): Promise<PartnerSignupSettings> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: PARTNER_SIGNUP_CONFIG_KEY }).first();
  const value = (row?.value ?? {}) as Partial<PartnerSignupSettings>;
  return {
    policy: value.policy === 'require_review' ? 'require_review' : 'auto_approve',
    disabled: value.disabled === true,
  };
}

/**
 * Public, unauthenticated: lets the join page say "closed" (or "reviewed")
 * before an applicant fills in the form. Exposes the two policy bits and
 * nothing else.
 */
partnerSignupRouter.get('/partner-signup/status', statusLimit, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const settings = await readSignupSettings(db, tenantId);
  res.json({
    open: !settings.disabled,
    reviewRequired: settings.policy === 'require_review',
    // Shows the optional Network checkbox. Never true for white-label.
    networkOffered: await isNetworkOfferedToPartners(db, tenantId),
  });
});

partnerSignupRouter.post('/partner-signup', signupLimit, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // Closed is checked first: a closed program answers signup_disabled
  // whatever the body, so nobody is asked to fix answers that can't be
  // accepted anyway.
  const settings = await readSignupSettings(db, tenantId);
  if (settings.disabled) {
    return res.status(403).json({ error: 'signup_disabled' });
  }

  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const profile = body.data.profile
    ? Object.fromEntries(Object.entries(body.data.profile).filter(([k]) => !RESERVED_METADATA_KEYS.has(k)))
    : undefined;

  // Existence check is intentionally generic — same response shape on
  // taken vs not. We don't want this endpoint to leak whether an email
  // is registered with this vendor (creator-facing privacy + a minor
  // hardening against credential-stuffing reconnaissance).
  // Email is unique per tenant: another brand's partner with this
  // address must not swallow the signup.
  const existing = await db<PartnerRow>(TABLES.Partner).where({ tenantId, email }).first();
  if (existing) {
    return res.json({ ok: true, status: 'already_registered' });
  }

  const id = ulid();
  const now = new Date();
  const activatedAt = settings.policy === 'auto_approve' ? now : null;
  const application: PartnerApplication = { ...body.data.application, submittedAt: now.toISOString() };
  let partner: PartnerRow;
  try {
    const inserted = (await db<PartnerRow>(TABLES.Partner)
      .insert({
        id,
        tenantId,
        email,
        name: body.data.name,
        metadata: {
          ...(profile ?? {}),
          application,
          ...(activatedAt ? {} : { review: { status: 'pending', appliedAt: now.toISOString() } satisfies PartnerReview }),
        },
        activatedAt,
      })
      .returning('*')) as PartnerRow[];
    if (inserted.length === 0) {
      // Should be impossible — INSERT without ON CONFLICT either succeeds
      // or throws — but typing-wise returning('*') is PartnerRow[].
      throw new Error('partner_insert_returned_no_rows');
    }
    partner = inserted[0]!;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      // Race against the existence check — same generic response.
      return res.json({ ok: true, status: 'already_registered' });
    }
    throw err;
  }

  // Network: only if the applicant ticked the join page's opt-in AND the
  // brand offers the Network. Fire-and-forget on the request hot path: a
  // Network outage must not fail the signup (it queues in NetworkOutbox).
  if (body.data.networkOptIn === true && (await isNetworkOfferedToPartners(db, tenantId))) {
    await grantNetworkConsent(db, tenantId, partner.id, 'join_page');
    await syncPartnerToNetwork(db, tenantId, partner, { profile });
  }

  // Webhooks, as POST /partners fires them, so a CRM or Zapier relay sees
  // join-page partners too. Sent before the email: a mail failure still
  // leaves a partner the subscriber should know about. `invited` is the
  // sign-in link below, which only an auto-approved applicant gets; they
  // are active now, so this is also their activation (verify only fires it
  // for a partner who isn't active yet). Applicants start with no program
  // grants: an admin grants them.
  dispatchEvent(tenantId, 'partner.created', {
    partnerId: partner.id,
    email,
    name: partner.name,
    activatedAt: partner.activatedAt ? partner.activatedAt.toISOString() : null,
    invited: activatedAt !== null,
    portalAccess: partner.portalAccess,
    programIds: [],
    source: 'join_page',
  } satisfies WebhookPayload<'partner.created'>);
  if (partner.activatedAt) {
    dispatchEvent(tenantId, 'partner.activated', {
      partnerId: partner.id,
      email,
      name: partner.name,
      activatedAt: partner.activatedAt.toISOString(),
      invited: false,
      source: 'join_page',
    } satisfies WebhookPayload<'partner.activated'>);
  }

  const { resolveBrandName } = await import('../brand-name.js');
  const brandName = await resolveBrandName(db, tenantId);

  // Auto-approve: the invite link signs the partner straight in. Review:
  // NO link. The verify route activates a pending partner on any
  // partner_invite link, so sending one here let applicants approve
  // themselves. They get an acknowledgement, the brand's admins get a
  // review request, and the sign-in link goes out with the approval
  // (POST /partners/:id/invite).
  let tmpl: { subject: string; text: string; html: string };
  if (activatedAt) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: partner.id,
    });
    tmpl = partnerInviteEmail(partner.name, buildMagicLinkUrl(issued.plaintext, linkTenantOf(req)), brandName);
  } else {
    tmpl = partnerApplicationReceivedEmail(partner.name, brandName);
    await notifyAdminsOfApplication(db, tenantId, partner, brandName, `${getPortalBaseUrl(linkTenantOf(req))}/admin/partners`, application);
  }
  try {
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: activatedAt ? 'partner_invite' : 'partner_application_received',
      metadata: {
        purpose: activatedAt ? 'partner_invite' : 'partner_application_received',
        partnerId: partner.id,
        source: 'self_signup',
      },
    });
  } catch (err) {
    // Mail failure on signup is recoverable — the row exists, the admin
    // can resend. Surface a 202 so the client knows partial success.
    return res.status(202).json({
      ok: true,
      status: activatedAt ? 'active_pending_email' : 'pending_review_pending_email',
      partnerId: partner.id,
      mailError: err instanceof Error ? err.message : String(err),
    });
  }

  res.status(201).json({
    ok: true,
    status: activatedAt ? 'active' : 'pending_review',
    partnerId: partner.id,
  });
});
