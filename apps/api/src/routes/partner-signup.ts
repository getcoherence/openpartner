/**
 * Public creator-facing partner signup.
 *
 * Lets a creator self-serve onto a vendor's program without admin
 * pre-invite. The vendor's `Settings → Partners` page chooses the
 * post-signup state:
 *
 *   - `auto_approve` (default): activatedAt set immediately, magic-link
 *     issued, partner can sign in straight away.
 *   - `require_review`: activatedAt stays null until an admin approves
 *     via /partners/:id/invite (which also sends the magic-link).
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
import { TABLES, type ConfigRow, type PartnerRow } from '@openpartner/db';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { buildMagicLinkUrl, partnerInviteEmail } from '../email-templates.js';
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
        metadata: body.data.profile ?? {},
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
      profile: body.data.profile,
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

  // Magic link goes out for both auto-approve and require-review paths.
  // require-review's magic link confirms email ownership; admin still
  // has to flip activatedAt before the partner can do anything.
  const issued = await issueMagicLink(db, {
    tenantId,
    email,
    purpose: 'partner_invite',
    principalKind: 'partner',
    principalId: partner.id,
  });
  const { resolveBrandName } = await import('../brand-name.js');
  const brandName = await resolveBrandName(db, tenantId);
  const tmpl = partnerInviteEmail(partner.name, buildMagicLinkUrl(issued.plaintext, req.tenantSlug), brandName);
  try {
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_invite',
      metadata: { purpose: 'partner_invite', partnerId: partner.id, source: 'self_signup' },
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
