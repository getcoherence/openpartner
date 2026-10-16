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
 * The endpoint is mounted INSIDE tenantMiddleware — in multi-tenant
 * mode the URL is /t/<slug>/partner-signup; in single-tenant mode
 * (self-host) it's /partner-signup. Tenant context comes from req.db
 * either way.
 *
 * Network behavior: if the vendor has Network membership enabled with
 * autoEnroll on, the new partner is pushed to /partners/upsert and the
 * returned networkCreatorId is stamped on Partner.metadata.network.
 * Network failures are queued in NetworkOutbox and don't fail the
 * signup.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type ConfigRow, type PartnerRow } from '@openpartner/db';
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
import { getNetworkMembership, pushPartnerUpsert } from '../network-client.js';

export const partnerSignupRouter = Router();

const signupLimit = ipRateLimit({ name: 'partner-signup', max: 10, windowMs: 60_000 });

const schema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(120),
  profile: z.record(z.unknown()).optional(),
});

// Partner.metadata keys the server owns. This endpoint is public, so a
// signup's profile must not set them: `source` decides the Network-access
// fee (usage-billing.ts), `network` is the Network sync stamp, `stripe`
// mirrors Connect payout state, and `review` gates sign-in for applicants
// held for review (partner-review.ts).
const RESERVED_METADATA_KEYS = new Set(['source', 'network', 'stripe', 'review']);

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
): Promise<void> {
  const admins = (await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .select('id', 'email')) as Array<Pick<AdminRow, 'id' | 'email'>>;
  const tmpl = partnerApplicationAdminEmail(partner.name, partner.email, brandName, reviewUrl);
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

partnerSignupRouter.post('/partner-signup', signupLimit, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = schema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const settings = await readSignupSettings(db, tenantId);
  if (settings.disabled) {
    return res.status(403).json({ error: 'signup_disabled' });
  }

  const email = body.data.email.toLowerCase();
  const profile = body.data.profile
    ? Object.fromEntries(Object.entries(body.data.profile).filter(([k]) => !RESERVED_METADATA_KEYS.has(k)))
    : undefined;

  // Existence check is intentionally generic — same response shape on
  // taken vs not. We don't want this endpoint to leak whether an email
  // is registered with this vendor (creator-facing privacy + a minor
  // hardening against credential-stuffing reconnaissance).
  const existing = await db<PartnerRow>(TABLES.Partner).where({ email }).first();
  if (existing) {
    return res.json({ ok: true, status: 'already_registered' });
  }

  const id = ulid();
  const now = new Date();
  const activatedAt = settings.policy === 'auto_approve' ? now : null;
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

  // Push to Network if configured + autoEnroll. Fire-and-forget on the
  // request hot path: a Network outage must not fail the signup. The
  // pushPartnerUpsert helper handles outbox queueing internally.
  const network = await getNetworkMembership(db, tenantId);
  if (network?.enabled && network.autoEnroll) {
    const result = await pushPartnerUpsert(db, tenantId, {
      vendorPartnerId: partner.id,
      email: partner.email,
      name: partner.name,
      profile,
      joinedVendorAt: partner.createdAt.toISOString(),
      status: activatedAt ? 'active' : 'pending',
      metadata: { source: 'self_signup' },
    });
    if (result) {
      // Stamp the canonical Network identity onto the Partner so the
      // admin UI can show "this creator was already on the Network".
      await db<PartnerRow>(TABLES.Partner)
        .where({ id: partner.id })
        .update({
          metadata: db.raw(
            `jsonb_set(coalesce("metadata", '{}'::jsonb), '{network}', ?::jsonb, true)`,
            [
              JSON.stringify({
                creatorId: result.networkCreatorId,
                preExisting: result.alreadyExisted,
                affiliations: result.affiliations.length,
                syncedAt: new Date().toISOString(),
              }),
            ],
          ),
          updatedAt: new Date(),
        });
    }
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
    await notifyAdminsOfApplication(db, tenantId, partner, brandName, `${getPortalBaseUrl(linkTenantOf(req))}/admin/partners`);
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
